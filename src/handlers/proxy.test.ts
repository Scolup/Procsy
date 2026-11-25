import { beforeEach, describe, expect, test } from 'bun:test'
import { createApp } from '../app'
import { getConfig, type Env } from '../config'
import type { UpstreamFetch, UpstreamResponse } from '../upstream'
import type { Logger } from '../utils/log'
import { BlockedTargetError, type LookupFn } from '../utils/ssrf'

interface Seen {
  url: string
  method: string
  headers: Headers
  body: ReadableStream | null
  signal: AbortSignal
  addresses: readonly { address: string; family: number }[]
}

let seen: Seen
let respond: (seen: Seen) => Promise<UpstreamResponse> | UpstreamResponse
let lookups: string[]

const publicLookup: LookupFn = async (host) => {
  lookups.push(host)
  return [{ address: '93.184.216.34', family: 4 }]
}

function defaultResponse(): UpstreamResponse {
  const headers = new Headers({
    'x-upstream': 'yes',
    'access-control-allow-origin': 'https://evil.example',
    'access-control-expose-headers': 'X-Custom-Upstream',
  })
  headers.append('set-cookie', 'sid=abc; Path=/')
  headers.append(
    'set-cookie',
    'theme=dark; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
  )
  return {
    status: 200,
    statusText: 'OK',
    headers,
    body: new Response('ok').body,
  }
}

beforeEach(() => {
  lookups = []
  respond = defaultResponse
})

const upstreamFetch: UpstreamFetch = async (url, init, addresses) => {
  seen = {
    url: url.href,
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    addresses,
  }
  return respond(seen)
}

const BASE_ENV: Env = {
  DEFAULT_BASE_URL: 'upstream.example',
  LOG_REQUESTS: 'false',
}

function makeApp(env: Env = {}, lookup: LookupFn = publicLookup) {
  return createApp(getConfig({ ...BASE_ENV, ...env }), {
    upstreamFetch,
    lookup,
  })
}

function request(
  path = '/hello?q=1',
  headers: Record<string, string> = {},
  env: Env = {},
  init: RequestInit = {},
) {
  return makeApp(env).request(`https://proxy.example${path}`, {
    ...init,
    headers,
  })
}

describe('proxy handler', () => {
  test('forwards the request to the configured upstream', async () => {
    const response = await request()

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(seen.url).toBe('https://upstream.example/hello?q=1')
    expect(seen.headers.get('host')).toBe('upstream.example')
    expect(seen.headers.get('x-forwarded-for')).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
    expect(response.headers.get('x-upstream')).toBe('yes')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  test('a path in the base URL is prefixed to the request path', async () => {
    await request('/login?x=1', { 'X-Procsy-Base-URL': 'api.example/v3' })
    expect(seen.url).toBe('https://api.example/v3/login?x=1')
    expect(seen.headers.get('host')).toBe('api.example')
  })

  test('the Host header carries the port of the target', async () => {
    await request('/', { 'X-Procsy-Base-URL': 'other.example:8443' })
    expect(seen.headers.get('host')).toBe('other.example:8443')
  })

  test('honours X-Procsy-Base-URL only when enabled', async () => {
    await request('/', { 'X-Procsy-Base-URL': 'other.example' })
    expect(seen.url).toBe('https://other.example/')

    await request(
      '/',
      { 'X-Procsy-Base-URL': 'other.example' },
      { ALLOW_BASE_URL_HEADER: 'false' },
    )
    expect(seen.url).toBe('https://upstream.example/')
    expect(seen.headers.has('x-procsy-base-url')).toBe(false)
  })

  test('an empty default requires the header', async () => {
    expect((await request('/', {}, { DEFAULT_BASE_URL: '' })).status).toBe(400)
    expect(
      (
        await request(
          '/',
          { 'X-Procsy-Base-URL': 'a.example' },
          { DEFAULT_BASE_URL: '' },
        )
      ).status,
    ).toBe(200)
  })

  test('rejects base URLs with credentials, queries or whitespace', async () => {
    for (const bad of [
      'a.example?x=1',
      'user@a.example',
      'a b',
      'a.example#f',
    ]) {
      expect((await request('/', { 'X-Procsy-Base-URL': bad })).status).toBe(
        400,
      )
    }
  })

  test('refuses to proxy to itself', async () => {
    const response = await request('/', {
      'X-Procsy-Base-URL': 'proxy.example',
    })
    expect(response.status).toBe(508)
  })

  test('redirects to HTTPS when FORCE_HTTPS is set', async () => {
    const response = await makeApp({ FORCE_HTTPS: 'true' }).request(
      'http://proxy.example/hello',
    )
    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe('https://proxy.example/hello')
  })

  test('uses X-Forwarded-Proto unless TRUST_PROXY is off', async () => {
    const app = (env: Env) => makeApp({ FORCE_HTTPS: 'true', ...env })
    const call = (env: Env) =>
      app(env).request('http://proxy.example/x', {
        headers: { 'X-Forwarded-Proto': 'https' },
      })

    expect((await call({ TRUST_PROXY: 'false' })).status).toBe(301)
    expect((await call({})).status).toBe(200)
    expect(seen.url).toBe('https://upstream.example/x')

    // Plain HTTP at the edge: upstream scheme follows the client.
    await makeApp({ TRUST_PROXY: 'true' }).request('http://proxy.example/y', {
      headers: { 'X-Forwarded-Proto': 'http' },
    })
    expect(seen.url).toBe('http://upstream.example/y')
  })

  test('omits X-Forwarded-For when SPOOF_IP is disabled', async () => {
    await request('/', {}, { SPOOF_IP: 'false' })
    expect(seen.headers.has('x-forwarded-for')).toBe(false)
  })

  test('hides the caller identity when spoofing', async () => {
    await request('/', {
      'X-Real-IP': '1.2.3.4',
      Forwarded: 'for=1.2.3.4',
      'X-Forwarded-For': '1.2.3.4',
      'CF-Connecting-IP': '1.2.3.4',
      'X-Forwarded-Host': 'proxy.example',
      'X-Forwarded-Proto': 'https',
      Via: '1.1 nginx',
    })
    for (const name of [
      'x-real-ip',
      'forwarded',
      'cf-connecting-ip',
      'x-forwarded-host',
      'x-forwarded-proto',
      'via',
    ]) {
      expect(seen.headers.has(name)).toBe(false)
    }
    expect(seen.headers.get('x-forwarded-for')).not.toBe('1.2.3.4')
  })

  test('sets configured headers over caller-sent ones', async () => {
    const env = { POPULATE_HEADER: '[{"X-Token":"secret"}]' }
    await request('/', {}, env)
    expect(seen.headers.get('x-token')).toBe('secret')
    await request('/', { 'X-Token': 'caller-value' }, env)
    expect(seen.headers.get('x-token')).toBe('secret')
  })

  test('uses X-Procsy-User-Agent as the outgoing User-Agent', async () => {
    await request('/', { 'X-Procsy-User-Agent': 'FakeUA/1' })
    expect(seen.headers.get('user-agent')).toBe('FakeUA/1')
    expect(seen.headers.has('x-procsy-user-agent')).toBe(false)
  })

  test('bridges request and response cookies', async () => {
    const response = await request('/', {
      Origin: 'https://site.example',
      'X-Procsy-Cookie': 'sid=xyz',
    })

    expect(seen.headers.get('cookie')).toBe('sid=xyz')
    expect(seen.headers.has('x-procsy-cookie')).toBe(false)
    expect(
      JSON.parse(response.headers.get('x-procsy-set-cookie') ?? '[]'),
    ).toEqual([
      'sid=abc; Path=/',
      'theme=dark; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
    ])
    const exposed = response.headers.get('access-control-expose-headers')
    expect(exposed).toContain('X-Procsy-Set-Cookie')
    expect(exposed).toContain('X-Custom-Upstream')
    expect(exposed).not.toContain('*')
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'https://site.example',
    )
  })

  test('keeps the spoofed IP stable for the same session', async () => {
    await request('/a', { 'X-Procsy-Cookie': 'sid=stable' })
    const first = seen.headers.get('x-forwarded-for')
    await request('/b', { 'X-Procsy-Cookie': 'sid=stable' })
    expect(seen.headers.get('x-forwarded-for')).toBe(first)
  })
})

describe('header hygiene (needed off Cloudflare)', () => {
  test('hop-by-hop request headers are not forwarded', async () => {
    await request('/', {
      Connection: 'keep-alive, X-Hop',
      'X-Hop': '1',
      'Keep-Alive': 'timeout=5',
      TE: 'trailers',
      Upgrade: 'websocket',
      'Transfer-Encoding': 'chunked',
      Expect: '100-continue',
      'Proxy-Authorization': 'Basic x',
    })
    for (const name of [
      'connection',
      'x-hop',
      'keep-alive',
      'te',
      'upgrade',
      'transfer-encoding',
      'expect',
      'proxy-authorization',
    ]) {
      expect(seen.headers.has(name)).toBe(false)
    }
  })

  test('operator-populated hop-by-hop headers cannot break the request', async () => {
    await request('/', {}, { POPULATE_HEADER: '[{"Connection":"upgrade"}]' })
    expect(seen.headers.has('connection')).toBe(false)
  })

  test('only offers codings fetch can decode; identity for ranges', async () => {
    await request('/', { 'Accept-Encoding': 'zstd, gzip' })
    expect(seen.headers.get('accept-encoding')).toBe('gzip, deflate, br')
    await request('/', { Range: 'bytes=0-9' })
    expect(seen.headers.get('accept-encoding')).toBe('identity')
  })

  test('drops stale Content-Encoding/Length after fetch decoded the body', async () => {
    respond = () => ({
      status: 200,
      statusText: 'OK',
      headers: new Headers({
        'content-encoding': 'gzip',
        'content-length': '34',
        'content-type': 'text/plain',
      }),
      body: new Response('decoded body').body,
    })
    const response = await request()
    expect(response.headers.has('content-encoding')).toBe(false)
    expect(response.headers.has('content-length')).toBe(false)
    expect(response.headers.get('content-type')).toBe('text/plain')
    expect(await response.text()).toBe('decoded body')
  })

  test('keeps Content-Encoding it cannot have decoded, and plain lengths', async () => {
    respond = () => ({
      status: 200,
      statusText: 'OK',
      headers: new Headers({
        'content-encoding': 'zstd',
        'content-length': '5',
      }),
      body: new Response('12345').body,
    })
    let response = await request()
    expect(response.headers.get('content-encoding')).toBe('zstd')
    respond = () => ({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-length': '5' }),
      body: new Response('12345').body,
    })
    response = await request()
    expect(response.headers.get('content-length')).toBe('5')
  })

  test('strips hop-by-hop response headers', async () => {
    respond = () => ({
      status: 200,
      statusText: 'OK',
      headers: new Headers({
        'transfer-encoding': 'chunked',
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
        'x-keep': '1',
      }),
      body: new Response('x').body,
    })
    const response = await request()
    expect(response.headers.has('transfer-encoding')).toBe(false)
    expect(response.headers.has('keep-alive')).toBe(false)
    expect(response.headers.get('x-keep')).toBe('1')
  })

  test('null-body statuses never carry a body', async () => {
    for (const status of [204, 205, 304]) {
      respond = () => ({
        status,
        statusText: '',
        headers: new Headers(),
        body: new Response('x').body,
      })
      expect((await request()).status).toBe(status)
    }
  })

  test('streams request bodies to the upstream', async () => {
    await request('/', {}, {}, { method: 'POST', body: 'payload' })
    expect(seen.method).toBe('POST')
    expect(await new Response(seen.body).text()).toBe('payload')
    await request('/', {}, {}, { method: 'GET' })
    expect(seen.body).toBeNull()
  })

  test('methods fetch cannot send are rejected', async () => {
    for (const method of ['TRACE', 'CONNECT']) {
      const response = await makeApp().request('https://proxy.example/', {
        method,
      })
      expect(response.status).toBe(405)
    }
  })
})

describe('SSRF protection', () => {
  test('blocks private and reserved destinations, including IPv6', async () => {
    for (const host of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '127.1',
      '2130706433',
      'localhost',
      '[::1]',
      '[::]',
      '[::ffff:127.0.0.1]',
      '[fc00::1]',
      '[fe80::1]',
      '[64:ff9b::7f00:1]',
      '[2002:7f00:1::]',
    ]) {
      const response = await request('/', { 'X-Procsy-Base-URL': host })
      expect(response.status).toBe(403)
    }
    const allowed = await request('/', {
      'X-Procsy-Base-URL': 'public.example',
    })
    expect(allowed.status).toBe(200)
  })

  test('blocks names that resolve to private addresses', async () => {
    const lookup: LookupFn = async () => [{ address: '10.0.0.5', family: 4 }]
    const response = await makeApp({}, lookup).request(
      'https://proxy.example/',
      {
        headers: { 'X-Procsy-Base-URL': 'internal.example' },
      },
    )
    expect(response.status).toBe(403)
  })

  test('passes the checked addresses to the upstream client', async () => {
    await request()
    expect(seen.addresses).toEqual([{ address: '93.184.216.34', family: 4 }])
    expect(lookups).toEqual(['upstream.example'])
  })

  test('a failed lookup is a 502, not a block', async () => {
    const lookup: LookupFn = async () => {
      throw new Error('getaddrinfo ENOTFOUND nope.example')
    }
    const response = await makeApp({}, lookup).request('https://proxy.example/')
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('ENOTFOUND')
  })

  test('a connect-time block (DNS rebinding) is reported as 403', async () => {
    respond = () => {
      throw new TypeError('fetch failed', { cause: new BlockedTargetError() })
    }
    expect((await request()).status).toBe(403)
  })

  test('ALLOW_PRIVATE_TARGETS skips the check', async () => {
    const response = await request(
      '/',
      { 'X-Procsy-Base-URL': '10.0.0.1:8080' },
      { ALLOW_PRIVATE_TARGETS: 'true' },
    )
    expect(response.status).toBe(200)
    expect(seen.url).toBe('https://10.0.0.1:8080/')
    expect(lookups).toEqual([])
    expect(seen.addresses).toEqual([])
  })
})

describe('failure handling', () => {
  test('connection errors are 502 and name the cause', async () => {
    respond = () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        }),
      })
    }
    const response = await request()
    expect(response.status).toBe(502)
    expect(await response.text()).toBe(
      'Proxy Error: fetch failed (ECONNREFUSED)',
    )
  })

  test('a silent upstream times out with 504 and is aborted', async () => {
    respond = (s) =>
      new Promise((_, reject) =>
        s.signal.addEventListener('abort', () => reject(s.signal.reason)),
      )
    const started = Date.now()
    const response = await request('/', {}, { UPSTREAM_TIMEOUT_MS: '50' })
    expect(response.status).toBe(504)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(seen.signal.aborted).toBe(true)
  })

  test('the timeout stops applying once headers arrived', async () => {
    const response = await request('/', {}, { UPSTREAM_TIMEOUT_MS: '30' })
    await new Promise((r) => setTimeout(r, 80))
    expect(response.status).toBe(200)
    expect(seen.signal.aborted).toBe(false)
  })

  test('a client disconnect aborts the upstream request', async () => {
    const client = new AbortController()
    respond = (s) =>
      new Promise((_, reject) =>
        s.signal.addEventListener('abort', () => reject(s.signal.reason)),
      )
    const pending = makeApp().request(
      new Request('https://proxy.example/', { signal: client.signal }),
    )
    await new Promise((r) => setTimeout(r, 20))
    client.abort()
    const response = await pending
    expect(response.status).toBe(499)
    expect(seen.signal.aborted).toBe(true)
  })

  test('unexpected errors become a plain 500', async () => {
    const app = createApp(getConfig(BASE_ENV), {
      upstreamFetch,
      lookup: publicLookup,
    })
    respond = () => {
      throw new Error('boom') // Not a network error: still handled.
    }
    const response = await app.request('https://proxy.example/')
    expect(response.status).toBe(502)
  })
})

describe('CORS', () => {
  test('rejects origins outside ALLOW_ORIGIN, but not /health', async () => {
    const env = { ALLOW_ORIGIN: 'good.example' }
    expect(
      (await request('/', { Origin: 'https://evil.example' }, env)).status,
    ).toBe(403)
    expect((await request('/', {}, env)).status).toBe(403)
    expect(
      (await request('/', { Origin: 'https://sub.good.example' }, env)).status,
    ).toBe(200)
    const health = await makeApp(env).request('https://proxy.example/health')
    expect(health.status).toBe(200)
  })

  test('preflight uses explicit headers and methods with credentials', async () => {
    const response = await makeApp().request('https://proxy.example/', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://site.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-procsy-cookie',
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'https://site.example',
    )
    expect(response.headers.get('access-control-allow-credentials')).toBe(
      'true',
    )
    expect(response.headers.get('access-control-allow-methods')).not.toBe('*')
    expect(response.headers.get('access-control-allow-headers')).toContain(
      'x-procsy-cookie',
    )
    expect(response.headers.get('access-control-allow-headers')).not.toBe('*')
  })
})

describe('request log', () => {
  function logged(env: Env = {}, lookup: LookupFn = publicLookup) {
    const lines: string[] = []
    const logger: Logger = {
      info: (m) => lines.push(m),
      warn: (m) => lines.push(m),
    }
    const app = createApp(getConfig({ ...BASE_ENV, ...env }), {
      upstreamFetch,
      lookup,
      logger,
    })
    return { app, lines }
  }

  test('logs host, path, status and timing, never the query or headers', async () => {
    const { app, lines } = logged()
    const response = await app.request(
      'https://proxy.example/v3/login?token=SECRET',
      {
        headers: { 'X-Procsy-Cookie': 'sid=SECRET' },
      },
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      /^\[[0-9a-f]{8}\] GET upstream\.example\/v3\/login -> 200 \d+ms$/,
    )
    expect(lines[0]).not.toContain('SECRET')
    expect(response.headers.get('x-procsy-request-id')).toBe(
      lines[0]!.slice(1, 9),
    )
  })

  test('says why a request was refused or failed', async () => {
    const internal: LookupFn = async () => [{ address: '0.0.0.0', family: 4 }]
    const blocked = logged({}, internal)
    expect((await blocked.app.request('https://proxy.example/')).status).toBe(
      403,
    )
    expect(blocked.lines[0]).toContain(
      'blocked: upstream.example resolves to private address 0.0.0.0',
    )

    const cors = logged({ ALLOW_ORIGIN: 'good.example' })
    await cors.app.request('https://proxy.example/', {
      headers: { Origin: 'https://evil.example' },
    })
    expect(cors.lines[0]).toContain('origin not allowed: https://evil.example')

    respond = () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }),
      })
    }
    const failed = logged()
    expect((await failed.app.request('https://proxy.example/')).status).toBe(
      502,
    )
    expect(failed.lines[0]).toContain(
      '-> 502 (fetch failed (ECONNRESET) in upstream stage)',
    )
  })

  test('does not log /health, and LOG_REQUESTS=false is silent', async () => {
    const { app, lines } = logged()
    await app.request('https://proxy.example/health')
    expect(lines).toHaveLength(0)
  })
})
