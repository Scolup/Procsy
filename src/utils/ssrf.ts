import { lookup as dnsLookupAsync } from 'node:dns/promises'
import { isIP } from 'node:net'

/** Raised (or found as an error `cause`) when a destination is not public. */
export class BlockedTargetError extends Error {
  readonly code = 'PROCSY_BLOCKED'

  constructor(message = 'target is a private address') {
    super(message)
    this.name = 'BlockedTargetError'
  }
}

/** Errors from `fetch()` wrap the real reason in `cause`; look through it. */
export function findInCauses<T extends Error>(
  error: unknown,
  match: (error: unknown) => error is T,
): T | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 6 && current; depth++) {
    if (match(current)) return current
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

export function isBlockedTargetError(
  error: unknown,
): error is BlockedTargetError {
  return (
    error instanceof BlockedTargetError ||
    (error instanceof Error &&
      (error as { code?: unknown }).code === 'PROCSY_BLOCKED')
  )
}

export interface LookupAddress {
  address: string
  family: number
}

/** Resolves a host name to every address it points at. */
export type LookupFn = (hostname: string) => Promise<LookupAddress[]>

/**
 * Memoise lookups for a short time and share in-flight ones. Node resolves
 * names on a 4-thread pool; without this, every request costs one or two
 * lookups and a slow resolver can starve the whole server. Failures are not
 * cached. Sharing one answer between the SSRF check and the connection also
 * means both see the same addresses.
 */
export function cachedLookup(
  lookup: LookupFn,
  ttlMs = 30_000,
  maxEntries = 1000,
  now: () => number = Date.now,
): LookupFn {
  const cache = new Map<string, { expires: number; value: LookupAddress[] }>()
  const inflight = new Map<string, Promise<LookupAddress[]>>()

  return (hostname) => {
    const key = hostname.toLowerCase()
    const hit = cache.get(key)
    if (hit && hit.expires > now()) return Promise.resolve(hit.value)

    let pending = inflight.get(key)
    if (!pending) {
      pending = lookup(hostname)
        .then((value) => {
          if (cache.size >= maxEntries) {
            const oldest = cache.keys().next().value
            if (oldest !== undefined) cache.delete(oldest)
          }
          cache.delete(key)
          cache.set(key, { expires: now() + ttlMs, value })
          return value
        })
        .finally(() => inflight.delete(key))
      inflight.set(key, pending)
    }
    return pending
  }
}

export const defaultLookup: LookupFn = cachedLookup((hostname) =>
  dnsLookupAsync(hostname, { all: true, verbatim: true }),
)

export function isPrivateIPv4(octets: readonly number[]): boolean {
  const [a, b, c] = octets as [number, number, number]
  if (a === 0 || a === 10 || a === 127) return true // this-net, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 169 && b === 254) return true // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true // IETF, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true // 6to4 relay anycast
  if (a === 192 && b === 168) return true
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  return a >= 224 // multicast, reserved, broadcast
}

/**
 * Expand a syntactically valid IPv6 address to eight 16-bit groups, or return
 * null for anything else (including zone ids). Strict on purpose: the input
 * may come from a DNS answer, not only from a URL parser.
 */
export function parseIPv6Groups(host: string): number[] | null {
  if (isIP(host) !== 6 || host.includes('%')) return null

  // Turn a dotted-quad tail (::ffff:1.2.3.4) into two hex groups.
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  let text = host
  if (dotted) {
    const [, head, a, b, c, d] = dotted as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ]
    const hi = (Number(a) << 8) | Number(b)
    const lo = (Number(c) << 8) | Number(d)
    text = `${head}${hi.toString(16)}:${lo.toString(16)}`
  }

  const halves = text.split('::')
  if (halves.length > 2) return null
  const parse = (part: string | undefined): number[] =>
    part ? part.split(':').map((group) => Number.parseInt(group, 16)) : []

  const left = parse(halves[0])
  const right = parse(halves[1])
  const missing = 8 - left.length - right.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null

  return [...left, ...Array<number>(missing).fill(0), ...right]
}

function embeddedIPv4(high: number, low: number): number[] {
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff]
}

function isPrivateIPv6(groups: number[]): boolean {
  const [a, b, c, d, e, f, g, h] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]

  // ::/96 covers :: , ::1 and the deprecated IPv4-compatible form.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0) {
    return true
  }
  // ::ffff:a.b.c.d (mapped) and ::ffff:0:a.b.c.d (SIIT) carry an IPv4 address.
  if (a === 0 && b === 0 && c === 0 && d === 0) {
    if ((e === 0xffff && f === 0) || (e === 0 && f === 0xffff)) {
      return isPrivateIPv4(embeddedIPv4(g, h))
    }
  }
  if (a === 0x64 && b === 0xff9b) {
    // 64:ff9b::/96 NAT64 embeds an IPv4 address; 64:ff9b:1::/48 is local-use.
    if (c === 0 && d === 0 && e === 0 && f === 0) {
      return isPrivateIPv4(embeddedIPv4(g, h))
    }
    if (c === 1) return true
  }
  if (a === 0x100 && b === 0 && c === 0 && d === 0) return true // 100::/64
  if (a === 0x2001 && b < 0x200) return true // 2001::/23: Teredo, benchmarking, ...
  if (a === 0x2001 && b === 0x0db8) return true // documentation
  if (a === 0x2002) return isPrivateIPv4(embeddedIPv4(b, c)) // 6to4
  if (a === 0x3fff && b < 0x1000) return true // documentation (3fff::/20)
  if (a === 0x5f00) return true // SRv6 SIDs
  if ((a & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (deprecated)
  return (a & 0xff00) === 0xff00 // ff00::/8 multicast
}

/** True for loopback, private, link-local and other non-public destinations. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true

  if (host.includes(':')) {
    const groups = parseIPv6Groups(host)
    return groups === null || isPrivateIPv6(groups) // fail closed
  }
  if (isIP(host) === 4) return isPrivateIPv4(host.split('.').map(Number))
  return false // A DNS name: its addresses are checked after resolution.
}

/**
 * Reject non-public destinations, resolving names so that a host like
 * `internal.example` pointing at 10.0.0.5 is caught too. Returns the addresses
 * that were checked. If any address is private the whole name is rejected.
 */
export async function resolvePublicAddresses(
  hostname: string,
  lookup: LookupFn,
): Promise<LookupAddress[]> {
  const host = hostname.replace(/^\[|\]$/g, '')
  if (isPrivateHost(host)) {
    throw new BlockedTargetError(`${host} is a private address`)
  }

  const family = isIP(host)
  if (family !== 0) return [{ address: host, family }]

  const addresses = await lookup(host)
  if (addresses.length === 0) throw new Error(`no addresses found for ${host}`)
  const blocked = addresses.find(({ address }) => isPrivateHost(address))
  if (blocked) {
    throw new BlockedTargetError(
      `${host} resolves to private address ${blocked.address}`,
    )
  }
  return addresses
}

type LookupOptions = { all?: boolean; family?: number; hints?: number }
type LookupCallback = (
  error: Error | null,
  address: string | LookupAddress[],
  family?: number,
) => void

/**
 * A `lookup` for a socket's connect step. It validates the very addresses the
 * socket then connects to (and shares the cache with the SSRF pre-check), so
 * DNS rebinding cannot slip a private address in between check and connect.
 */
export function createGuardedLookup(lookup: LookupFn = defaultLookup) {
  return function guardedLookup(
    hostname: string,
    options: LookupOptions | number | LookupCallback,
    callback?: LookupCallback,
  ): void {
    let opts: LookupOptions = {}
    let done = callback
    if (typeof options === 'function') done = options
    else if (typeof options === 'number') opts = { family: options }
    else opts = options

    lookup(hostname).then(
      (all) => {
        const blocked = all.find(({ address }) => isPrivateHost(address))
        if (blocked) {
          return done?.(
            new BlockedTargetError(
              `${hostname} resolves to private address ${blocked.address}`,
            ),
            [],
          )
        }
        const addresses =
          opts.family === 4 || opts.family === 6
            ? all.filter(({ family }) => family === opts.family)
            : all
        const first = addresses[0]
        if (!first) {
          return done?.(new Error(`no addresses found for ${hostname}`), [])
        }
        if (opts.all) return done?.(null, addresses)
        done?.(null, first.address, first.family)
      },
      (error: Error) => done?.(error, []),
    )
  }
}

export const guardedLookup = createGuardedLookup()
