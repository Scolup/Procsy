import type { StartServer } from './types'

export const startServer: StartServer = async (handler, config) => {
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: (request) => handler(request),
    // Bun closes connections idle for 10 s by default, which would cut off any
    // upstream that takes longer to answer. 255 s is the maximum.
    idleTimeout: 255,
    // Default is 128 MiB; this is a streaming proxy, so do not cap uploads.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    // Never leak stack traces to clients.
    development: false,
    error(error) {
      console.error('Server error:', error)
      return new Response('Internal Server Error', { status: 500 })
    },
  })

  const host = server.hostname?.includes(':')
    ? `[${server.hostname}]`
    : server.hostname
  return {
    address: `http://${host}:${server.port}`,
    stop: () => server.stop(),
  }
}
