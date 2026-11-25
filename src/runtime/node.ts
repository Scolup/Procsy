import type { AddressInfo } from 'node:net'
import { createAdaptorServer } from '@hono/node-server'
import type { Server } from 'node:http'
import type { StartServer } from './types'

const FORCE_CLOSE_AFTER_MS = 10_000

export function formatAddress(info: AddressInfo | string | null): string {
  if (!info || typeof info === 'string') return String(info)
  const host = info.family === 'IPv6' ? `[${info.address}]` : info.address
  return `http://${host}:${info.port}`
}

export const startServer: StartServer = async (handler, config) => {
  const server = createAdaptorServer({
    fetch: (request) => handler(request),
    // Keep the real Request/Response: they are handed to fetch() untouched.
    overrideGlobalObjects: false,
  }) as Server

  // Outlive reverse proxies' idle keep-alive timers (nginx, ALB: 60 s);
  // Node's 5 s default makes them reuse sockets we just closed -> sporadic 502.
  server.keepAliveTimeout = 65_000
  server.headersTimeout = 66_000

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  server.on('error', (error) => console.error('Server error:', error))

  return {
    address: formatAddress(server.address()),
    stop: () =>
      new Promise<void>((resolve) => {
        const force = setTimeout(
          () => server.closeAllConnections(),
          FORCE_CLOSE_AFTER_MS,
        )
        force.unref()
        server.close(() => {
          clearTimeout(force)
          resolve()
        })
        server.closeIdleConnections()
      }),
  }
}
