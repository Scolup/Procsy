/** Connection-level headers (RFC 9110 §7.6.1); meaningless to forward. */
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

/**
 * Remove hop-by-hop headers, plus any header the `Connection` header names.
 * Node's fetch throws on several of these (keep-alive, transfer-encoding,
 * upgrade, ...), and a stale Transfer-Encoding corrupts the response framing.
 */
export function stripHopByHop(headers: Headers): void {
  const named = (headers.get('connection') ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
  for (const name of named) headers.delete(name)
  for (const name of HOP_BY_HOP) headers.delete(name)
}

/** Added by Cloudflare or by a reverse proxy in front of this server. */
export const INFRASTRUCTURE_REQUEST_HEADERS = [
  'cf-connecting-ip',
  'cf-connecting-ipv6',
  'cf-pseudo-ipv4',
  'cf-worker',
  'cf-ray',
  'cf-visitor',
  'cf-ipcountry',
  'cdn-loop',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-server',
]

/** Would reveal the caller's real address, which SPOOF_IP is hiding. */
export const CLIENT_IDENTITY_HEADERS = [
  'x-real-ip',
  'forwarded',
  'true-client-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'fastly-client-ip',
  'x-original-forwarded-for',
  'via',
]

/** Consumed by the proxy itself; never sent upstream. */
export const PROCSY_REQUEST_HEADERS = [
  'x-procsy-base-url',
  'x-procsy-user-agent',
  'x-procsy-cookie',
]

/** CORS headers are produced by our middleware, never taken from upstream. */
export const CORS_RESPONSE_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-max-age',
]

export function deleteHeaders(
  headers: Headers,
  names: readonly string[],
): void {
  for (const name of names) headers.delete(name)
}

// What both fetch implementations (undici, Bun) decode transparently.
const DECODED_ENCODINGS = new Set(['gzip', 'x-gzip', 'deflate', 'br'])

/** `Accept-Encoding` we send upstream: only codings that fetch will decode. */
export const UPSTREAM_ACCEPT_ENCODING = 'gzip, deflate, br'

/**
 * fetch() decompresses bodies but leaves `Content-Encoding` and
 * `Content-Length` describing the *compressed* bytes. Forwarding those would
 * make browsers fail with a content-decoding error, so callers must drop them.
 */
export function wasBodyDecoded(headers: Headers): boolean {
  const tokens = (headers.get('content-encoding') ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
  return tokens.length > 0 && tokens.every((t) => DECODED_ENCODINGS.has(t))
}

/** All `Set-Cookie` values, never comma-joined (`Expires` contains commas). */
export function getSetCookies(headers: Headers): string[] {
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
