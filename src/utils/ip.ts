const IP_PREFIXES = ['80.12', '82.224', '176.128', '90.1'] as const

export function generateRandomIP(): string {
  const prefix = IP_PREFIXES[Math.floor(Math.random() * IP_PREFIXES.length)]
  const octet3 = Math.floor(Math.random() * 256)
  const octet4 = Math.floor(Math.random() * 256)
  return `${prefix}.${octet3}.${octet4}`
}

/** FNV-1a, unsigned: the same session always maps to the same address. */
function hashSession(session: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < session.length; index++) {
    hash ^= session.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function stableSpoofedIP(session: string | null | undefined): string {
  if (!session) return generateRandomIP()
  const hash = hashSession(session)
  const prefix = IP_PREFIXES[hash % IP_PREFIXES.length]
  return `${prefix}.${(hash >>> 8) & 0xff}.${(hash >>> 16) & 0xff}`
}
