export interface AppConfig {
  readonly defaultBaseURL: string
  readonly allowBaseURLHeader: boolean
  readonly forceHTTPS: boolean
  readonly spoofIP: boolean
  readonly allowOrigin?: string
  readonly populateHeader?: Record<string, string>
}

export interface Bindings {
  DEFAULT_BASE_URL?: string
  FORCE_HTTPS?: string
  ALLOW_ORIGIN?: string
  SPOOF_IP?: string
  ALLOW_BASE_URL_HEADER?: string
  POPULATE_HEADER?: string
}

export function getConfig(env: Bindings): AppConfig {
  let populateHeader: Record<string, string> | undefined
  if (env.POPULATE_HEADER !== undefined) {
    try {
      const parsed = JSON.parse(env.POPULATE_HEADER)
      if (Array.isArray(parsed)) {
        populateHeader = {}
        for (const item of parsed) {
          if (
            typeof item === 'object' &&
            item !== null &&
            !Array.isArray(item)
          ) {
            for (const [key, value] of Object.entries(item)) {
              if (typeof key === 'string' && typeof value === 'string') {
                populateHeader[key] = value
              }
            }
          }
        }
      }
    } catch {
      // If parsing fails, ignore the header population
    }
  }

  return {
    defaultBaseURL:
      env.DEFAULT_BASE_URL !== undefined ? env.DEFAULT_BASE_URL : 'example.com',
    forceHTTPS: env.FORCE_HTTPS === 'true',
    allowOrigin: env.ALLOW_ORIGIN !== undefined ? env.ALLOW_ORIGIN : '*',
    spoofIP: env.SPOOF_IP !== 'false',
    allowBaseURLHeader: env.ALLOW_BASE_URL_HEADER !== 'false',
    populateHeader,
  }
}
