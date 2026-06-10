import type { MiddlewareHandler } from 'hono'
import type { Bindings } from '../config'
import { getConfig } from '../config'

export const corsMiddleware = (): MiddlewareHandler<{
  Bindings: Bindings
}> => {
  return async (c, next) => {
    const config = getConfig(c.env)
    const origin = c.req.header('origin') || ''
    const allowedOrigins =
      config.allowOrigin && config.allowOrigin !== '*'
        ? config.allowOrigin.split(',').map((s) => s.trim())
        : ['*']

    if (config.allowOrigin && config.allowOrigin !== '*') {
      const isAllowed =
        origin &&
        allowedOrigins.some((allowed) => {
          try {
            const originHost = new URL(origin).host
            return originHost === allowed || originHost.endsWith(`.${allowed}`)
          } catch {
            return false
          }
        })

      if (!isAllowed) {
        return c.text('Forbidden', 403)
      }
    }

    if (c.req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin || '*',
          'Access-Control-Allow-Methods': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Max-Age': '86400',
        },
      })
    }

    await next()

    const response = c.res
    if (response) {
      const newResponseHeaders = new Headers(response.headers)
      newResponseHeaders.set('Access-Control-Allow-Origin', origin || '*')
      newResponseHeaders.set('Access-Control-Allow-Credentials', 'true')
      newResponseHeaders.set('Access-Control-Expose-Headers', '*')

      c.res = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newResponseHeaders,
      })
    }
  }
}
