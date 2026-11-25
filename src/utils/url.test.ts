import { describe, expect, test } from 'bun:test'
import { buildTargetURL, getRequestProtocol, isValidBaseURL } from './url'

const incoming = new URL('https://proxy.example/a/b%20c?q=1&r=2')

describe('buildTargetURL', () => {
  test('keeps path and query, applies host and port', () => {
    expect(buildTargetURL(incoming, 'api.example:8443', 'https')?.href).toBe(
      'https://api.example:8443/a/b%20c?q=1&r=2',
    )
    expect(buildTargetURL(incoming, '[2606:4700::1]:81', 'http')?.href).toBe(
      'http://[2606:4700::1]:81/a/b%20c?q=1&r=2',
    )
  })

  test('a path that looks like a host does not change the destination', () => {
    const url = buildTargetURL(
      new URL('https://p.example//evil.com/x'),
      'api.example',
      'https',
    )
    expect(url?.hostname).toBe('api.example')
    expect(url?.pathname).toBe('//evil.com/x')
  })

  test('supports a base path prefix', () => {
    const login = new URL('https://proxy.example/login?x=1')
    expect(buildTargetURL(login, 'api.example.com/v3', 'https')?.href).toBe(
      'https://api.example.com/v3/login?x=1',
    )
    expect(buildTargetURL(login, 'api.example.com/v3/', 'https')?.href).toBe(
      'https://api.example.com/v3/login?x=1',
    )
    expect(
      buildTargetURL(login, 'api.example.com:8443/a/b', 'http')?.href,
    ).toBe('http://api.example.com:8443/a/b/login?x=1')
    expect(
      buildTargetURL(
        new URL('https://p.example/'),
        'api.example.com/v3',
        'https',
      )?.href,
    ).toBe('https://api.example.com/v3/')
  })

  test('rejects values that could change the destination', () => {
    for (const bad of [
      'user@a.com',
      'user:pw@a.com',
      'a.com?x=1',
      'a.com#f',
      'a b.com',
      'a.com\\x',
      '',
      'http://a.com',
      ':80',
      'a.com:99999',
    ]) {
      expect(buildTargetURL(incoming, bad, 'https')).toBeNull()
    }
  })

  test('normalises numeric hosts so they cannot dodge the SSRF check', () => {
    expect(buildTargetURL(incoming, '2130706433', 'https')?.hostname).toBe(
      '127.0.0.1',
    )
    expect(buildTargetURL(incoming, '127.1', 'https')?.hostname).toBe(
      '127.0.0.1',
    )
  })
})

describe('isValidBaseURL', () => {
  test('accepts hosts and rejects the rest', () => {
    expect(isValidBaseURL('example.com')).toBe(true)
    expect(isValidBaseURL('example.com:8080')).toBe(true)
    expect(isValidBaseURL('example.com/v3')).toBe(true)
    expect(isValidBaseURL('example.com?x=1')).toBe(false)
  })
})

describe('getRequestProtocol', () => {
  const http = new URL('http://proxy.example/')
  const headers = (value?: string) =>
    new Headers(value ? { 'x-forwarded-proto': value } : {})

  test('uses the socket scheme unless the proxy is trusted', () => {
    expect(getRequestProtocol(http, headers('https'), false)).toBe('http')
    expect(
      getRequestProtocol(new URL('https://p.example/'), headers(), false),
    ).toBe('https')
  })

  test('trusts the first X-Forwarded-Proto value when enabled', () => {
    expect(getRequestProtocol(http, headers('https'), true)).toBe('https')
    expect(getRequestProtocol(http, headers(' HTTPS , http'), true)).toBe(
      'https',
    )
    expect(
      getRequestProtocol(new URL('https://p.example/'), headers('http'), true),
    ).toBe('http')
    expect(getRequestProtocol(http, headers('javascript'), true)).toBe('http')
    expect(getRequestProtocol(http, headers(), true)).toBe('http')
  })
})
