const IP_PREFIXES = ['80.12', '82.224', '176.128', '90.1']

export function generateRandomIP(): string {
  const prefix = IP_PREFIXES[Math.floor(Math.random() * IP_PREFIXES.length)]
  const octet3 = Math.floor(Math.random() * 256)
  const octet4 = Math.floor(Math.random() * 256)
  return `${prefix}.${octet3}.${octet4}`
}
