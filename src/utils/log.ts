import type { MiddlewareHandler } from 'hono'

export interface Logger {
  info(message: string): void
  warn(message: string): void
}

const stamp = () => new Date().toISOString()

export const consoleLogger: Logger = {
  info: (message) => console.log(`${stamp()} ${message}`),
  warn: (message) => console.warn(`${stamp()} ${message}`),
}

export const silentLogger: Logger = { info() {}, warn() {} }

/** What the handler learned about a request, for the log line. */
export interface LogInfo {
  /** Destination host + path (never the query string, it may hold tokens). */
  target?: string
  /** dns -> upstream (waiting for headers) -> streaming. */
  stage?: string
  /** Why a request was refused or failed. */
  reason?: string
}

const infos = new WeakMap<Request, LogInfo>()

export function logInfoFor(request: Request): LogInfo {
  let info = infos.get(request)
  if (!info) {
    info = {}
    infos.set(request, info)
  }
  return info
}

function newRequestId(): string {
  return crypto.randomUUID().slice(0, 8)
}

/**
 * One line per request, once response headers are ready, plus a warning for
 * requests that are stuck (and in which stage). Headers, cookies and query
 * strings are never logged. The id is also sent as `X-Procsy-Request-Id`.
 */
export function requestLogger(
  logger: Logger,
  slowAfterMs = 10_000,
): MiddlewareHandler {
  return async (c, next) => {
    const id = newRequestId()
    const started = Date.now()
    const request = c.req.raw
    const info = logInfoFor(request)
    const where = () => info.target ?? new URL(request.url).pathname

    const slow = setTimeout(() => {
      logger.warn(
        `[${id}] ${request.method} ${where()} still waiting after ${slowAfterMs}ms (stage: ${info.stage ?? 'start'})`,
      )
    }, slowAfterMs)

    try {
      await next()
    } finally {
      clearTimeout(slow)
    }

    c.res.headers.set('X-Procsy-Request-Id', id)
    const reason = info.reason ? ` (${info.reason})` : ''
    logger.info(
      `[${id}] ${request.method} ${where()} -> ${c.res.status}${reason} ${Date.now() - started}ms`,
    )
  }
}
