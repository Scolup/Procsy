import type { Handler } from 'hono'
import type { AppConfig } from '../config'
import type { UpstreamFetch } from '../upstream'
import {
  CLIENT_IDENTITY_HEADERS,
  CORS_RESPONSE_HEADERS,
  INFRASTRUCTURE_REQUEST_HEADERS,
  PROCSY_REQUEST_HEADERS,
  UPSTREAM_ACCEPT_ENCODING,
  deleteHeaders,
  getSetCookies,
  stripHopByHop,
  wasBodyDecoded,
} from '../utils/headers'
import { stableSpoofedIP } from '../utils/ip'
import { logInfoFor } from '../utils/log'
import {
  type LookupAddress,
  type LookupFn,
  findInCauses,
  isBlockedTargetError,
  resolvePublicAddresses,
} from '../utils/ssrf'
import { buildTargetURL, getRequestProtocol } from '../utils/url'

export interface ProxyDeps {
  upstreamFetch: UpstreamFetch
  lookup: LookupFn
}

// fetch() refuses these methods (Bun accepts TRACE, so refuse uniformly).
const UNSUPPORTED_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK'])
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

class UpstreamTimeoutError extends Error {
  constructor(ms: number) {
    super(`upstream did not respond within ${ms} ms`)
    this.name = 'UpstreamTimeoutError'
  }
}

/** Reject when `signal` aborts, so DNS cannot outlive the request. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  // undici reports every failure as "fetch failed"; the code is in `cause`.
  const cause = (error.cause ?? undefined) as
    { code?: unknown; message?: unknown } | undefined
  const detail = cause?.code ?? cause?.message
  return detail ? `${error.message} (${String(detail)})` : error.message
}

export function createProxyHandler(
  config: AppConfig,
  deps: ProxyDeps,
): Handler {
  return async (c) => {
    const request = c.req.raw
    const requestURL = new URL(request.url)
    const info = logInfoFor(request)

    if (UNSUPPORTED_METHODS.has(request.method.toUpperCase())) {
      return c.text('Method Not Allowed', 405)
    }

    const protocol = getRequestProtocol(
      requestURL,
      request.headers,
      config.trustProxy,
    )
    if (config.forceHTTPS && protocol === 'http') {
      requestURL.protocol = 'https:'
      return c.redirect(requestURL.toString(), 301)
    }

    const headerBase = config.allowBaseURLHeader
      ? request.headers.get('x-procsy-base-url')?.trim()
      : undefined
    const baseURL = headerBase || config.defaultBaseURL
    if (!baseURL) return c.text('Error: Base URL not specified', 400)

    const target = buildTargetURL(
      requestURL,
      baseURL,
      config.forceHTTPS ? 'https' : protocol,
    )
    if (!target) {
      info.reason = 'invalid X-Procsy-Base-URL'
      return c.text('Error: invalid base URL', 400)
    }
    info.target = `${target.host}${target.pathname}`

    // Proxying to ourselves would recurse until sockets run out.
    if (target.host === requestURL.host) {
      info.reason = 'target is this proxy'
      return c.text('Loop Detected: target is this proxy', 508)
    }

    const headers = new Headers(request.headers)
    stripHopByHop(headers)
    deleteHeaders(headers, INFRASTRUCTURE_REQUEST_HEADERS)
    deleteHeaders(headers, PROCSY_REQUEST_HEADERS)
    headers.delete('expect') // The server already answered 100-continue.

    const userAgent = request.headers.get('x-procsy-user-agent')
    if (userAgent) headers.set('User-Agent', userAgent)

    const cookie = request.headers.get('x-procsy-cookie')
    if (cookie) headers.set('Cookie', cookie)

    if (config.spoofIP) {
      deleteHeaders(headers, CLIENT_IDENTITY_HEADERS)
      headers.set('X-Forwarded-For', stableSpoofedIP(headers.get('Cookie')))
    }

    for (const [name, value] of Object.entries(config.populateHeader)) {
      headers.set(name, value)
    }
    headers.set('Host', target.host)
    // fetch() decodes compressed bodies, so only offer codings it can decode.
    // Byte ranges refer to the encoded form, so those must not be encoded.
    headers.set(
      'Accept-Encoding',
      headers.has('range') ? 'identity' : UPSTREAM_ACCEPT_ENCODING,
    )
    stripHopByHop(headers) // Also covers anything POPULATE_HEADER added.

    const method = request.method.toUpperCase()
    const body = method === 'GET' || method === 'HEAD' ? null : request.body

    // One signal covers DNS, connecting and waiting for response headers, and
    // follows the client: if it disconnects, the upstream request is dropped.
    const controller = new AbortController()
    const abortFromClient = () => controller.abort(request.signal.reason)
    if (request.signal.aborted) abortFromClient()
    else
      request.signal.addEventListener('abort', abortFromClient, { once: true })

    const timer =
      config.upstreamTimeoutMs > 0
        ? setTimeout(
            () =>
              controller.abort(
                new UpstreamTimeoutError(config.upstreamTimeoutMs),
              ),
            config.upstreamTimeoutMs,
          )
        : undefined

    try {
      let addresses: LookupAddress[] = []
      info.stage = 'dns'
      if (!config.allowPrivateTargets) {
        addresses = await abortable(
          resolvePublicAddresses(target.hostname, deps.lookup),
          controller.signal,
        )
      }

      info.stage = 'upstream'
      const upstream = await deps.upstreamFetch(
        target,
        { method, headers, body, signal: controller.signal },
        addresses,
      )

      info.stage = 'streaming'
      const responseHeaders = new Headers(upstream.headers)
      stripHopByHop(responseHeaders)
      deleteHeaders(responseHeaders, CORS_RESPONSE_HEADERS)

      const cookies = getSetCookies(upstream.headers)
      if (cookies.length > 0) {
        responseHeaders.set('X-Procsy-Set-Cookie', JSON.stringify(cookies))
      }
      if (wasBodyDecoded(upstream.headers)) {
        responseHeaders.delete('content-encoding')
        responseHeaders.delete('content-length')
      }

      return new Response(
        NULL_BODY_STATUSES.has(upstream.status) ? null : upstream.body,
        {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        },
      )
    } catch (error) {
      if (findInCauses(error, isBlockedTargetError)) {
        info.reason = `blocked: ${findInCauses(error, isBlockedTargetError)?.message}`
        return c.text('Forbidden: target is a private address', 403)
      }
      if (error instanceof UpstreamTimeoutError) {
        info.reason = `timeout in ${info.stage} stage`
        return c.text(`Gateway Timeout: ${error.message}`, 504)
      }
      if (request.signal.aborted) {
        info.reason = 'client disconnected'
        // The client is gone; nobody will read this.
        return new Response(null, { status: 499 })
      }
      info.reason = `${describeError(error)} in ${info.stage} stage`
      return c.text(`Proxy Error: ${describeError(error)}`, 502)
    } finally {
      clearTimeout(timer)
    }
  }
}
