export interface AppConfig {
  readonly defaultBaseURL: string
  readonly allowBaseURLHeader: boolean
  readonly forceHTTPS: boolean
  readonly spoofIP: boolean
  readonly allowOrigin: string
  readonly populateHeader: Record<string, string>
}

export interface Bindings {
  DEFAULT_BASE_URL?: string
  FORCE_HTTPS?: string
  ALLOW_ORIGIN?: string
  SPOOF_IP?: string
  ALLOW_BASE_URL_HEADER?: string
  POPULATE_HEADER?: string
}

const HEADER_NAME = /^[a-zA-Z0-9-]+$/

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
        if (HEADER_NAME.test(name) && typeof headerValue === 'string') {
          result[name] = headerValue
        }
      }
    }
    return result
  } catch {
    return {}
  }
}

export function getConfig(env: Bindings): AppConfig {
  return {
    defaultBaseURL: env.DEFAULT_BASE_URL ?? 'example.com',
    forceHTTPS: env.FORCE_HTTPS === 'true',
    allowOrigin: env.ALLOW_ORIGIN ?? '*',
    spoofIP: env.SPOOF_IP !== 'false',
    allowBaseURLHeader: env.ALLOW_BASE_URL_HEADER !== 'false',
    populateHeader: parsePopulateHeader(env.POPULATE_HEADER),
  }
}
