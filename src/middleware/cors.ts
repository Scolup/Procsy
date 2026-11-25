import type { MiddlewareHandler } from 'hono'
import type { AppConfig } from '../config'
import { CORS_RESPONSE_HEADERS } from '../utils/headers'
import { logInfoFor } from '../utils/log'

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

export const corsMiddleware = (config: AppConfig): MiddlewareHandler => {
  const allowedOrigins =
    config.allowOrigin === '*'
      ? null
      : config.allowOrigin
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)

  return async (c, next) => {
    const origin = c.req.header('origin') ?? ''

    if (allowedOrigins) {
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

      if (!isAllowed) {
        logInfoFor(c.req.raw).reason = origin
          ? `origin not allowed: ${origin}`
          : 'no Origin header (ALLOW_ORIGIN is restricted)'
        return c.text('Forbidden', 403)
      }
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

    // Keep explicit upstream expose-list entries, but make the allow-list
    // headers authoritative: upstream values can be stale or conflicting.
    const upstreamExposed = c.res.headers.get('access-control-expose-headers')
    for (const name of [
      ...CORS_RESPONSE_HEADERS,
      'access-control-expose-headers',
    ]) {
      c.res.headers.delete(name)
    }
    c.res.headers.set('Access-Control-Allow-Origin', origin || '*')
    c.res.headers.set('Access-Control-Allow-Credentials', 'true')
    c.res.headers.set(
      'Access-Control-Expose-Headers',
      mergeTokens(upstreamExposed, ['X-Procsy-Set-Cookie']),
    )
    c.res.headers.set(
      'Vary',
      mergeTokens(c.res.headers.get('vary'), ['Origin']),
    )
  }
}
