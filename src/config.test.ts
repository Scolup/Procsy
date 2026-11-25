import { describe, expect, test } from 'bun:test'
import { ConfigError, getConfig, getServerConfig } from './config'

describe('getConfig', () => {
  test('uses documented defaults', () => {
    expect(getConfig({})).toEqual({
      defaultBaseURL: 'example.com',
      forceHTTPS: false,
      allowOrigin: '*',
      spoofIP: true,
      allowBaseURLHeader: true,
      populateHeader: {},
      trustProxy: true,
      upstreamTimeoutMs: 60_000,
      allowPrivateTargets: false,
      logRequests: true,
    })
  })

  test('reads environment overrides', () => {
    const config = getConfig({
      DEFAULT_BASE_URL: 'api.example',
      FORCE_HTTPS: 'true',
      ALLOW_ORIGIN: 'a.example, b.example',
      SPOOF_IP: 'false',
      ALLOW_BASE_URL_HEADER: 'false',
      TRUST_PROXY: 'false',
      LOG_REQUESTS: 'false',
      UPSTREAM_TIMEOUT_MS: '1500',
      ALLOW_PRIVATE_TARGETS: 'true',
    })

    expect(config.defaultBaseURL).toBe('api.example')
    expect(config.forceHTTPS).toBe(true)
    expect(config.allowOrigin).toBe('a.example, b.example')
    expect(config.spoofIP).toBe(false)
    expect(config.allowBaseURLHeader).toBe(false)
    expect(config.trustProxy).toBe(false)
    expect(config.logRequests).toBe(false)
    expect(config.upstreamTimeoutMs).toBe(1500)
    expect(config.allowPrivateTargets).toBe(true)
  })

  test('booleans are case-insensitive and blank means default', () => {
    expect(getConfig({ FORCE_HTTPS: ' TRUE ' }).forceHTTPS).toBe(true)
    expect(getConfig({ SPOOF_IP: 'False' }).spoofIP).toBe(false)
    expect(getConfig({ SPOOF_IP: '0' }).spoofIP).toBe(false)
    expect(getConfig({ SPOOF_IP: '' }).spoofIP).toBe(true)
    expect(getConfig({ ALLOW_ORIGIN: '  ' }).allowOrigin).toBe('*')
  })

  test('an empty DEFAULT_BASE_URL is kept (header becomes mandatory)', () => {
    expect(getConfig({ DEFAULT_BASE_URL: '' }).defaultBaseURL).toBe('')
  })

  test('rejects unusable values instead of guessing', () => {
    expect(() => getConfig({ FORCE_HTTPS: 'maybe' })).toThrow(ConfigError)
    expect(() => getConfig({ UPSTREAM_TIMEOUT_MS: '-1' })).toThrow(ConfigError)
    expect(() => getConfig({ UPSTREAM_TIMEOUT_MS: '1.5' })).toThrow(ConfigError)
    expect(() => getConfig({ UPSTREAM_TIMEOUT_MS: 'abc' })).toThrow(ConfigError)
  })

  test('parses POPULATE_HEADER entries', () => {
    const config = getConfig({
      POPULATE_HEADER: JSON.stringify([
        { 'X-Token': 'secret', 'X-Count': '1' },
        { 'X-Token': 'overridden' },
      ]),
    })

    expect(config.populateHeader).toEqual({
      'X-Token': 'overridden',
      'X-Count': '1',
    })
  })

  test('ignores malformed POPULATE_HEADER values', () => {
    for (const value of [
      'not json',
      '{}',
      '[{"X-Number":1}]',
      '[{"Bad Header":"x"}]',
      '[{"X-Bad":"line\\nbreak"}]',
    ]) {
      expect(getConfig({ POPULATE_HEADER: value }).populateHeader).toEqual({})
    }
  })
})

describe('getServerConfig', () => {
  test('defaults to loopback:3000', () => {
    expect(getServerConfig({})).toEqual({ host: '127.0.0.1', port: 3000 })
  })

  test('reads HOST and PORT, validating the port', () => {
    expect(getServerConfig({ HOST: '0.0.0.0', PORT: '8080' })).toEqual({
      host: '0.0.0.0',
      port: 8080,
    })
    expect(getServerConfig({ PORT: '0' }).port).toBe(0)
    for (const PORT of ['65536', '-1', 'http', '80.5']) {
      expect(() => getServerConfig({ PORT })).toThrow(ConfigError)
    }
  })
})
