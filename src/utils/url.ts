export type Protocol = 'http' | 'https'

/**
 * The scheme the client used to reach us. Behind a TLS-terminating reverse
 * proxy the socket is plain HTTP, so with `trustProxy` we believe the
 * `X-Forwarded-Proto` header instead.
 */
export function getRequestProtocol(
  requestURL: URL,
  headers: Headers,
  trustProxy: boolean,
): Protocol {
  if (trustProxy) {
    const forwarded = headers
      .get('x-forwarded-proto')
      ?.split(',')[0]
      ?.trim()
      .toLowerCase()
    if (forwarded === 'http' || forwarded === 'https') return forwarded
  }
  return requestURL.protocol === 'https:' ? 'https' : 'http'
}

/**
 * Build the upstream URL from `host[:port][/path-prefix]` and the incoming
 * path: `api.example.com/v3` + `/login` -> `https://api.example.com/v3/login`.
 * Returns null if `baseURL` contains anything that could change the
 * destination (credentials, query, fragment, whitespace, backslashes).
 */
export function buildTargetURL(
  requestURL: URL,
  baseURL: string,
  protocol: Protocol,
): URL | null {
  // The part before the first "/" must be a plain host[:port]; this also
  // rejects a scheme ("http://x" would otherwise parse as host "http").
  const authority = baseURL.split('/', 1)[0] ?? ''
  if (!/^(\[[0-9a-f:.]+\]|[^\s:/[\]]+)(:\d+)?$/i.test(authority)) return null

  let target: URL
  try {
    target = new URL(`${protocol}://${baseURL}`)
  } catch {
    return null
  }
  if (
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    /[\s\\?#@]/.test(baseURL)
  ) {
    return null
  }

  const basePath = target.pathname.replace(/\/+$/, '')
  target.pathname = basePath + requestURL.pathname
  target.search = requestURL.search
  return target
}

/** Used at startup to reject an unusable DEFAULT_BASE_URL early. */
export function isValidBaseURL(baseURL: string): boolean {
  return buildTargetURL(new URL('http://localhost/'), baseURL, 'https') !== null
}
