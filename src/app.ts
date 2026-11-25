import { Hono } from 'hono'
import type { AppConfig } from './config'
import { createProxyHandler } from './handlers/proxy'
import { corsMiddleware } from './middleware/cors'
import type { UpstreamFetch } from './upstream'
import {
  consoleLogger,
  requestLogger,
  silentLogger,
  type Logger,
} from './utils/log'
import { defaultLookup, type LookupFn } from './utils/ssrf'

export interface AppDeps {
  upstreamFetch: UpstreamFetch
  lookup?: LookupFn
  /** Defaults to the console, or to nothing when LOG_REQUESTS is off. */
  logger?: Logger
}

/** The runtime-independent application: it only deals in Request/Response. */
export function createApp(config: AppConfig, deps: AppDeps): Hono {
  const app = new Hono()

  // Registered first so monitoring works whatever ALLOW_ORIGIN says.
  app.get('/health', (c) => c.json({ status: 'ok' }))

  const logger =
    deps.logger ?? (config.logRequests ? consoleLogger : silentLogger)
  app.use('*', requestLogger(logger))
  app.use('*', corsMiddleware(config))
  app.all(
    '*',
    createProxyHandler(config, {
      upstreamFetch: deps.upstreamFetch,
      lookup: deps.lookup ?? defaultLookup,
    }),
  )

  app.onError((error, c) => {
    console.error('Unhandled error:', error)
    return c.text('Internal Server Error', 500)
  })

  return app
}
