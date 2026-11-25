export interface AppConfig {
  readonly defaultBaseURL: string
  readonly allowBaseURLHeader: boolean
  readonly forceHTTPS: boolean
  readonly spoofIP: boolean
  readonly allowOrigin: string
  readonly populateHeader: Record<string, string>
  readonly trustProxy: boolean
  readonly upstreamTimeoutMs: number
  readonly allowPrivateTargets: boolean
  readonly logRequests: boolean
}

export interface ServerConfig {
  readonly host: string
  readonly port: number
}

/** A plain environment map, e.g. `process.env`. */
export type Env = Record<string, string | undefined>

/** Raised for an invalid setting; the entry point prints it and exits. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const HEADER_NAME = /^[a-zA-Z0-9-]+$/

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on'])
const FALSE_VALUES = new Set(['false', '0', 'no', 'off'])

/** Unset and blank both mean "use the default". */
function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

function parseBoolean(env: Env, name: string, fallback: boolean): boolean {
  const value = read(env, name)
  if (value === undefined) return fallback
  const normalized = value.toLowerCase()
  if (TRUE_VALUES.has(normalized)) return true
  if (FALSE_VALUES.has(normalized)) return false
  throw new ConfigError(`${name} must be "true" or "false" (got "${value}")`)
}

function parseInteger(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = read(env, name)
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || parsed < min || parsed > max) {
    throw new ConfigError(
      `${name} must be an integer between ${min} and ${max} (got "${value}")`,
    )
  }
  return parsed
}

function parsePopulateHeader(
  value: string | undefined,
): Record<string, string> {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return {}

    const result: Record<string, string> = {}
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        continue
      }
      for (const [name, headerValue] of Object.entries(item)) {
        if (!HEADER_NAME.test(name) || typeof headerValue !== 'string') continue
        try {
          // Rejects values (e.g. containing a newline) that would make every
          // proxied request fail later on.
          new Headers().set(name, headerValue)
        } catch {
          continue
        }
        result[name] = headerValue
      }
    }
    return result
  } catch {
    return {}
  }
}

export function getConfig(env: Env): AppConfig {
  return {
    // May legitimately be empty: then callers must send X-Procsy-Base-URL.
    defaultBaseURL: env.DEFAULT_BASE_URL?.trim() ?? 'example.com',
    forceHTTPS: parseBoolean(env, 'FORCE_HTTPS', false),
    allowOrigin: read(env, 'ALLOW_ORIGIN') ?? '*',
    spoofIP: parseBoolean(env, 'SPOOF_IP', true),
    allowBaseURLHeader: parseBoolean(env, 'ALLOW_BASE_URL_HEADER', true),
    populateHeader: parsePopulateHeader(env.POPULATE_HEADER),
    // Safe to default on: the scheme only affects the caller's own request.
    trustProxy: parseBoolean(env, 'TRUST_PROXY', true),
    upstreamTimeoutMs: parseInteger(
      env,
      'UPSTREAM_TIMEOUT_MS',
      60_000,
      0,
      2_147_483_647,
    ),
    allowPrivateTargets: parseBoolean(env, 'ALLOW_PRIVATE_TARGETS', false),
    logRequests: parseBoolean(env, 'LOG_REQUESTS', true),
  }
}

export function getServerConfig(env: Env): ServerConfig {
  return {
    host: read(env, 'HOST') ?? '127.0.0.1',
    port: parseInteger(env, 'PORT', 3000, 0, 65535),
  }
}
