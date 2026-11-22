export function getTargetURL(
  incomingRequestUrl: string,
  baseURL: string,
  forceHTTPS: boolean,
): string {
  const url = new URL(incomingRequestUrl)
  const protocol = forceHTTPS || url.protocol === 'https:' ? 'https' : 'http'
  return `${protocol}://${baseURL}${url.pathname}${url.search}`
}
