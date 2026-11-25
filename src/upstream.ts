import { isIP } from 'node:net'
import { isBun } from './runtime'
import { findInCauses, guardedLookup, type LookupAddress } from './utils/ssrf'

export interface UpstreamInit {
  method: string
  headers: Headers
  body: ReadableStream<Uint8Array> | null
  signal: AbortSignal
}

export interface UpstreamResponse {
  status: number
  statusText: string
  headers: Headers
  body: ReadableStream<Uint8Array> | null
}

/**
 * Performs the outgoing request. `addresses` are the IPs that already passed
 * the SSRF check (empty when the check is disabled); implementations may use
 * them to connect to exactly what was checked. Redirects are never followed.
 */
export type UpstreamFetch = (
  url: URL,
  init: UpstreamInit,
  addresses: readonly LookupAddress[],
) => Promise<UpstreamResponse>

/** Only these can be repeated safely without the caller noticing. */
function isReplayable(init: UpstreamInit): boolean {
  return (init.method === 'GET' || init.method === 'HEAD') && !init.body
}

const STALE_CONNECTION_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ECONNABORTED',
  'UND_ERR_SOCKET',
])

function isStaleConnectionError(error: unknown): boolean {
  return (
    findInCauses(error, (e): e is Error => {
      const code = (e as { code?: unknown } | null)?.code
      return typeof code === 'string' && STALE_CONNECTION_CODES.has(code)
    }) !== undefined
  )
}

/**
 * Servers and load balancers close idle keep-alive connections without
 * warning; a request that lands on such a connection fails before any
 * response. For GET/HEAD that is invisible to retry, so do.
 */
export function withStaleConnectionRetry(
  fetchImpl: UpstreamFetch,
  retries = 2,
): UpstreamFetch {
  return async (url, init, addresses) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetchImpl(url, init, addresses)
      } catch (error) {
        if (
          attempt >= retries ||
          !isReplayable(init) ||
          init.signal.aborted ||
          !isStaleConnectionError(error)
        ) {
          throw error
        }
      }
    }
  }
}

function toRequestInit(init: UpstreamInit): Record<string, unknown> {
  const requestInit: Record<string, unknown> = {
    method: init.method,
    headers: init.headers,
    signal: init.signal,
    redirect: 'manual',
  }
  // Requests that cannot be replayed never reuse an idle connection, which
  // could be stale. (Bun option; ignored elsewhere.)
  if (!isReplayable(init)) requestInit.keepalive = false
  if (init.body) {
    requestInit.body = init.body
    requestInit.duplex = 'half' // Required to stream a request body.
  }
  return requestInit
}

/**
 * Bun gives no hook into name resolution, so for plain-HTTP targets we connect
 * to the address that was just checked (Bun honours the explicit Host header).
 * HTTPS targets are left alone: a rebinding attacker cannot present a valid
 * certificate for their own host name from an internal service.
 */
export function pinPlainHTTP(
  url: URL,
  addresses: readonly LookupAddress[],
): URL {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (url.protocol !== 'http:' || addresses.length === 0 || isIP(host)) {
    return url
  }
  // Prefer IPv4: it is reachable from far more hosts than IPv6 is.
  const chosen = addresses.find(({ family }) => family === 4) ?? addresses[0]!
  const pinned = new URL(url)
  pinned.hostname = chosen.family === 6 ? `[${chosen.address}]` : chosen.address
  return pinned
}

export function createBunUpstream(
  fetchImpl: (input: string, init?: never) => Promise<UpstreamResponse> = (
    input,
    init,
  ) => fetch(input, init) as unknown as Promise<UpstreamResponse>,
): UpstreamFetch {
  return (url, init, addresses) =>
    fetchImpl(pinPlainHTTP(url, addresses).href, toRequestInit(init) as never)
}

export async function createNodeUpstream(options: {
  guard: boolean
}): Promise<UpstreamFetch> {
  // Node's built-in fetch cannot take a custom resolver, but undici can.
  const { Agent, fetch: undiciFetch } = await import('undici')
  const settings = {
    // Timeouts are enforced by the handler (headers) and by the client
    // disconnecting (body); undici's 5 minute idle limits would cut off
    // long-lived streams such as server-sent events.
    headersTimeout: 0,
    bodyTimeout: 0,
    connect: options.guard ? { lookup: guardedLookup as never } : {},
  }
  const pooled = new Agent(settings)
  // pipelining: 0 means "no keep-alive": a fresh connection per request, so
  // a POST can never be sent down a connection the server already closed.
  const fresh = new Agent({ ...settings, pipelining: 0 })
  return (url, init) =>
    undiciFetch(url.href, {
      ...toRequestInit(init),
      dispatcher: isReplayable(init) ? pooled : fresh,
    } as never) as unknown as Promise<UpstreamResponse>
}

export function createUpstream(options: {
  allowPrivateTargets: boolean
}): Promise<UpstreamFetch> {
  return isBun
    ? Promise.resolve(withStaleConnectionRetry(createBunUpstream()))
    : createNodeUpstream({ guard: !options.allowPrivateTargets }).then(
        (upstream) => withStaleConnectionRetry(upstream),
      )
}
