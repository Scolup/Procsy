import type { Handler } from 'hono'
import type { Bindings } from '../config'
import { getConfig } from '../config'
import { stableSpoofedIP } from '../utils/ip'
import { getTargetURL } from '../utils/url'

function isPrivateHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1')
    return true

  const ipPattern = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/
  const match = hostname.match(ipPattern)
  if (match) {
    const parts = match.slice(1).map(Number)
    if (parts[0] === 10) return true
    if (parts[0] === 127) return true
    if (parts[0] === 0) return true
    if (parts[0] === 169 && parts[1] === 254) return true
    if (parts[0] === 192 && parts[1] === 168) return true
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true
  }

  return false
}

export const proxyHandler: Handler<{ Bindings: Bindings }> = async (c) => {
  const config = getConfig(c.env)
  const incomingRequest = c.req.raw
  const url = new URL(incomingRequest.url)

  if (config.forceHTTPS && url.protocol === 'http:') {
    url.protocol = 'https:'
    return c.redirect(url.toString(), 301)
  }

  const allowBaseURLHeader = config.allowBaseURLHeader !== false
  let baseURL: string

  if (allowBaseURLHeader) {
    const headerBaseURL = c.req.header('X-Procsy-Base-URL')
    if (headerBaseURL) {
      baseURL = headerBaseURL
    } else {
      baseURL = config.defaultBaseURL
    }
  } else {
    baseURL = config.defaultBaseURL
  }

  if (!baseURL) {
    return c.text('Error: Base URL not specified', 400)
  }

  const targetURL = getTargetURL(
    incomingRequest.url,
    baseURL,
    config.forceHTTPS,
  )

  // SSRF protection: block requests to private / reserved networks
  const targetHost = new URL(targetURL).hostname
  if (isPrivateHost(targetHost)) {
    return c.text('Forbidden: target is a private address', 403)
  }

  const newHeaders = new Headers(incomingRequest.headers)

  const headersToDelete = [
    'cf-connecting-ip',
    'cf-worker',
    'cf-ray',
    'cf-visitor',
    'cf-ipcountry',
    'cdn-loop',
    'x-procsy-base-url',
    'x-procsy-user-agent',
    'x-procsy-cookie',
  ]
  headersToDelete.forEach((h) => newHeaders.delete(h))

  // Transform X-Procsy-User-Agent into User-Agent
  const procsyUserAgent = incomingRequest.headers.get('X-Procsy-User-Agent')
  if (procsyUserAgent) {
    newHeaders.set('User-Agent', procsyUserAgent)
  }

  // Opt-in cookie bridging: browsers forbid the `Cookie` header, so
  // cookie-jar clients send their session in `X-Procsy-Cookie` instead.
  // Stateless: only the caller's own session transits, nothing is stored.
  const procsyCookie = incomingRequest.headers.get('X-Procsy-Cookie')
  if (procsyCookie) {
    newHeaders.set('Cookie', procsyCookie)
  }

  if (config.spoofIP !== false) {
    newHeaders.set(
      'X-Forwarded-For',
      stableSpoofedIP(
        newHeaders.get('Cookie') ?? incomingRequest.headers.get('X-Procsy-Cookie'),
      ),
    )
  }
  newHeaders.set('Host', baseURL)

  // Apply header population if configured
  if (config.populateHeader) {
    for (const [headerName, headerValue] of Object.entries(
      config.populateHeader,
    )) {
      if (incomingRequest.headers.has(headerName)) {
        newHeaders.set(headerName, headerValue)
      }
    }
  }

  const requestInit: RequestInit = {
    method: incomingRequest.method,
    headers: newHeaders,
    redirect: 'manual',
  }

  if (!['GET', 'HEAD'].includes(incomingRequest.method)) {
    requestInit.body = incomingRequest.body
  }

  try {
    const response = await fetch(targetURL, requestInit)

    const responseHeaders = new Headers(response.headers)

    // Mirror of the bridging above: upstream `Set-Cookie` values are
    // unreadable from browsers, so expose them as JSON in a plain header
    // (CORS already exposes all headers). Only set when present.
    const upstreamCookies = getSetCookies(response.headers)
    if (upstreamCookies.length > 0) {
      responseHeaders.set(
        'X-Procsy-Set-Cookie',
        JSON.stringify(upstreamCookies),
      )
      // EcoleDirecte envoie ses propres listes CORS figées qui peuvent
      // masquer ce header au JS : garantir ici même son exposition.
      const exposed = responseHeaders.get('Access-Control-Expose-Headers')
      if (!exposed) {
        responseHeaders.set(
          'Access-Control-Expose-Headers',
          'X-Procsy-Set-Cookie',
        )
      } else if (
        !/^\s*\*\s*$/.test(exposed) &&
        !/x-procsy-set-cookie/i.test(exposed)
      ) {
        responseHeaders.set(
          'Access-Control-Expose-Headers',
          `${exposed}, X-Procsy-Set-Cookie`,
        )
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  } catch (err: any) {
    return c.text(`Proxy Error: ${err.message}`, 502)
  }
}

/** All `Set-Cookie` values (never comma-joined: `Expires` contains commas). */
function getSetCookies(headers: Headers): string[] {
  const direct = (headers as unknown as { getSetCookie?: () => string[] })
    .getSetCookie
  if (typeof direct === 'function') {
    try {
      return direct.call(headers)
    } catch {
      return []
    }
  }
  const single = headers.get('set-cookie')
  return single ? [single] : []
}
