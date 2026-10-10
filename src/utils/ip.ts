const IP_PREFIXES = ['80.12', '82.224', '176.128', '90.1']

export function generateRandomIP(): string {
  const prefix = IP_PREFIXES[Math.floor(Math.random() * IP_PREFIXES.length)]
  const octet3 = Math.floor(Math.random() * 256)
  const octet4 = Math.floor(Math.random() * 256)
  return `${prefix}.${octet3}.${octet4}`
}

/**
 * IP stable par session : même jar à cookies → même IP spoofée sur toutes
 * les requêtes du flow (page → captcha → envoi). Sans session, repli
 * aléatoire. Les sessions cookie WebDev (AWP) peuvent être liées à l'IP :
 * une IP différente à chaque requête casse la validation.
 */
export function stableSpoofedIP(session: string | null): string {
  if (!session) return generateRandomIP()
  let hash = 0x811c9dc5
  for (let i = 0; i < session.length; i++) {
    hash ^= session.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  const prefix = IP_PREFIXES[Math.abs(hash) % IP_PREFIXES.length]
  const octet3 = Math.abs(hash >> 8) % 256
  const octet4 = Math.abs(hash >> 16) % 256
  return `${prefix}.${octet3}.${octet4}`
}
