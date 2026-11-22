import type { MiddlewareHandler } from 'hono'
import type { Bindings } from '../config'
import { getConfig } from '../config'

const CORS_RESPONSE_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
]

const DEFAULT_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Procsy-Base-URL',
  'X-Procsy-User-Agent',
  'X-Procsy-Cookie',
]

const DEFAULT_ALLOWED_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]

/** Join explicit values only: `*` is not a wildcard for credentialed requests. */
export function mergeTokens(
  current: string | null | undefined,
  tokens: string[],
): string {
  const values = (current ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== '*')

  for (const token of tokens) {
    if (!values.some((value) => value.toLowerCase() === token.toLowerCase())) {
      values.push(token)
    }
  }

  return values.join(', ')
}

export const corsMiddleware = (): MiddlewareHandler<{
  Bindings: Bindings
}> => {
  return async (c, next) => {
    const config = getConfig(c.env)
    const origin = c.req.header('origin') ?? ''

    if (config.allowOrigin !== '*') {
      const allowedOrigins = config.allowOrigin
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
      const isAllowed =
        origin.length > 0 &&
        allowedOrigins.some((allowed) => {
          try {
            const originHost = new URL(origin).host
            return originHost === allowed || originHost.endsWith(`.${allowed}`)
          } catch {
            return false
          }
        })

      if (!isAllowed) return c.text('Forbidden', 403)
    }

    if (c.req.method === 'OPTIONS') {
      const requestedMethod = c.req.header('access-control-request-method')
      const requestedHeaders = c.req.header('access-control-request-headers')

      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin || '*',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Methods': mergeTokens(
            requestedMethod,
            DEFAULT_ALLOWED_METHODS,
          ),
          'Access-Control-Allow-Headers': mergeTokens(
            requestedHeaders,
            DEFAULT_ALLOWED_HEADERS,
          ),
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
        },
      })
    }

    await next()

    // Upstream CORS headers are untrusted: make this middleware authoritative.
    for (const name of CORS_RESPONSE_HEADERS) c.res.headers.delete(name)
    c.res.headers.set('Access-Control-Allow-Origin', origin || '*')
    c.res.headers.set('Access-Control-Allow-Credentials', 'true')
    c.res.headers.set(
      'Access-Control-Expose-Headers',
      mergeTokens(null, ['X-Procsy-Set-Cookie']),
    )
    c.res.headers.set(
      'Vary',
      mergeTokens(c.res.headers.get('vary'), ['Origin']),
    )
  }
}
