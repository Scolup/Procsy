export interface AppConfig {
  readonly defaultBaseURL: string
  readonly allowBaseURLHeader: boolean
  readonly forceHTTPS: boolean
  readonly spoofIP: boolean
  readonly allowOrigin?: string
}

export interface Bindings {
  DEFAULT_BASE_URL?: string
  FORCE_HTTPS?: string
  ALLOW_ORIGIN?: string
  SPOOF_IP?: string
  ALLOW_BASE_URL_HEADER?: string
}

export function getConfig(env: Bindings): AppConfig {
  return {
    defaultBaseURL:
      env.DEFAULT_BASE_URL !== undefined ? env.DEFAULT_BASE_URL : 'example.com',
    forceHTTPS: env.FORCE_HTTPS === 'true',
    allowOrigin: env.ALLOW_ORIGIN !== undefined ? env.ALLOW_ORIGIN : '*',
    spoofIP: env.SPOOF_IP !== 'false',
    allowBaseURLHeader: env.ALLOW_BASE_URL_HEADER !== 'false',
  }
}
