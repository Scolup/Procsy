import type { Handler } from 'hono'
import type { Bindings } from '../config'
import { getConfig } from '../config'
import { generateRandomIP } from '../utils/ip'
import { getTargetURL } from '../utils/url'

const REQUEST_HEADERS_TO_STRIP = [
  'cf-connecting-ip',
  'cf-worker',
  'cf-ray',
  'cf-visitor',
  'cf-ipcountry',
  'cdn-loop',
  'x-procsy-base-url',
  'x-procsy-user-agent',
]

const RESPONSE_HEADERS_TO_STRIP = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
]

export function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && (b === 0 || b === 168)) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  return a >= 224
}

/** Expand an IPv6 address to eight 16-bit groups. Unknown forms return null. */
export function parseIPv6Groups(host: string): number[] | null {
  if (host.includes('%')) return null
  const halves = host.split('::')
  if (halves.length > 2) return null

  const parse = (part: string): number[] =>
    part ? part.split(':').map((group) => Number.parseInt(group, 16)) : []

  const left = parse(halves[0] ?? '')
  const right = halves.length === 2 ? parse(halves[1] ?? '') : []
  const groups = [...left, ...right]
  if (
    groups.some(
      (group) => !Number.isFinite(group) || group < 0 || group > 0xffff,
    )
  ) {
    return null
  }

  const missing = 8 - groups.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null

  return [...left, ...Array<number>(missing).fill(0), ...right]
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true

  if (host.includes(':')) {
    const groups = parseIPv6Groups(host)
    if (!groups) return true // Fail closed on an address we cannot parse.
    const [a, b, c, d, e, f, g, h] = groups

    if (groups.every((group) => group === 0)) return true // ::
    if (groups.slice(0, 7).every((group) => group === 0) && h === 1) return true // ::1
    if ((a & 0xfe00) === 0xfc00) return true // fc00::/7
    if ((a & 0xffc0) === 0xfe80) return true // fe80::/10
    if (a === 0x2001 && b === 0x0db8) return true // 2001:db8::/32
    if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f <= 0xffff) {
      // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d).
      if (f === 0 || f === 0xffff) {
        return isPrivateIPv4([
          (g >> 8) & 0xff,
          g & 0xff,
          (h >> 8) & 0xff,
          h & 0xff,
        ])
      }
    }
    return false
  }

  const octets = host.split('.').map(Number)
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false // A DNS name; resolution happens in fetch() below.
  }
  return isPrivateIPv4(octets)
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

export const proxyHandler: Handler<{ Bindings: Bindings }> = async (c) => {
  const config = getConfig(c.env)
  const incomingRequest = c.req.raw
  const incomingURL = new URL(incomingRequest.url)

  if (config.forceHTTPS && incomingURL.protocol === 'http:') {
    incomingURL.protocol = 'https:'
    return c.redirect(incomingURL.toString(), 301)
  }

  const baseURL = config.allowBaseURLHeader
    ? c.req.header('X-Procsy-Base-URL') || config.defaultBaseURL
    : config.defaultBaseURL
  if (!baseURL) return c.text('Error: Base URL not specified', 400)

  let targetURL: string
  let targetHost: string
  try {
    targetURL = getTargetURL(incomingRequest.url, baseURL, config.forceHTTPS)
    targetHost = new URL(targetURL).hostname
  } catch {
    return c.text('Error: invalid base URL', 400)
  }

  if (isPrivateHost(targetHost)) {
    return c.text('Forbidden: target is a private address', 403)
  }

  const headers = new Headers(incomingRequest.headers)
  for (const name of REQUEST_HEADERS_TO_STRIP) headers.delete(name)

  const userAgent = incomingRequest.headers.get('X-Procsy-User-Agent')
  if (userAgent) headers.set('User-Agent', userAgent)

  if (config.spoofIP) headers.set('X-Forwarded-For', generateRandomIP())

  for (const [name, value] of Object.entries(config.populateHeader)) {
    headers.set(name, value)
  }
  headers.set('Host', baseURL)

  const requestInit: RequestInit = {
    method: incomingRequest.method,
    headers,
    redirect: 'manual',
  }
  if (!['GET', 'HEAD'].includes(incomingRequest.method)) {
    requestInit.body = incomingRequest.body
    ;(requestInit as { duplex?: string }).duplex = 'half'
  }

  try {
    const response = await fetch(targetURL, requestInit)
    const responseHeaders = new Headers(response.headers)
    for (const name of RESPONSE_HEADERS_TO_STRIP) responseHeaders.delete(name)

    const cookies = getSetCookies(response.headers)
    if (cookies.length > 0) {
      responseHeaders.set('X-Procsy-Set-Cookie', JSON.stringify(cookies))
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return c.text(`Proxy Error: ${message}`, 502)
  }
}
