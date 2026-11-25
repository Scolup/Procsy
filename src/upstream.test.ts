import { describe, expect, test } from 'bun:test'
import {
  createBunUpstream,
  pinPlainHTTP,
  withStaleConnectionRetry,
  type UpstreamFetch,
  type UpstreamInit,
} from './upstream'

const v4 = { address: '93.184.216.34', family: 4 }
const v6 = { address: '2606:2800:220:1::1', family: 6 }

describe('pinPlainHTTP (Bun: connect to the address that was checked)', () => {
  test('replaces the host of plain-HTTP targets, preferring IPv4', () => {
    const url = new URL('http://site.example:8080/p?q=1')
    expect(pinPlainHTTP(url, [v6, v4]).href).toBe(
      'http://93.184.216.34:8080/p?q=1',
    )
    expect(pinPlainHTTP(url, [v6]).href).toBe(
      'http://[2606:2800:220:1::1]:8080/p?q=1',
    )
  })

  test('leaves HTTPS, IP literals and unchecked targets alone', () => {
    const https = new URL('https://site.example/')
    expect(pinPlainHTTP(https, [v4])).toBe(https)
    const literal = new URL('http://93.184.216.34/')
    expect(pinPlainHTTP(literal, [v4])).toBe(literal)
    const v6literal = new URL('http://[2606:2800:220:1::1]/')
    expect(pinPlainHTTP(v6literal, [v4])).toBe(v6literal)
    const plain = new URL('http://site.example/')
    expect(pinPlainHTTP(plain, [])).toBe(plain)
  })
})

describe('createBunUpstream', () => {
  test('sends a manual-redirect, streaming request to the pinned URL', async () => {
    let seen: { input: string; init: Record<string, unknown> } | undefined
    const upstream = createBunUpstream((async (input: string, init: never) => {
      seen = { input, init }
      return new Response('x')
    }) as never)

    const body = new ReadableStream()
    const headers = new Headers({ Host: 'site.example' })
    const controller = new AbortController()
    await upstream(
      new URL('http://site.example/p'),
      { method: 'POST', headers, body, signal: controller.signal },
      [v4],
    )

    expect(seen?.input).toBe('http://93.184.216.34/p')
    expect(seen?.init.redirect).toBe('manual')
    expect(seen?.init.duplex).toBe('half')
    expect(seen?.init.body).toBe(body)
    expect(seen?.init.headers).toBe(headers)
    expect(seen?.init.signal).toBe(controller.signal)
  })

  test('omits body and duplex when there is no body', async () => {
    let init: Record<string, unknown> = {}
    const upstream = createBunUpstream((async (_: string, i: never) => {
      init = i
      return new Response('x')
    }) as never)
    await upstream(
      new URL('https://s.example/'),
      {
        method: 'GET',
        headers: new Headers(),
        body: null,
        signal: new AbortController().signal,
      },
      [],
    )
    expect('body' in init).toBe(false)
    expect('duplex' in init).toBe(false)
  })
})

describe('withStaleConnectionRetry', () => {
  const stale = () =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('other side closed'), {
        code: 'UND_ERR_SOCKET',
      }),
    })
  const init = (over: Partial<UpstreamInit> = {}): UpstreamInit => ({
    method: 'GET',
    headers: new Headers(),
    body: null,
    signal: new AbortController().signal,
    ...over,
  })
  const ok = {
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    body: null,
  }
  const failing = (times: number) => {
    let calls = 0
    const fn: UpstreamFetch = async () => {
      if (calls++ < times) throw stale()
      return ok
    }
    return { fn, calls: () => calls }
  }
  const run = (fn: UpstreamFetch, i = init()) =>
    withStaleConnectionRetry(fn)(new URL('http://a.example/'), i, [])

  test('retries a GET that hit a closed connection', async () => {
    const f = failing(2)
    expect((await run(f.fn)).status).toBe(200)
    expect(f.calls()).toBe(3)
  })

  test('gives up after the retry budget', async () => {
    const f = failing(10)
    await expect(run(f.fn)).rejects.toThrow('fetch failed')
    expect(f.calls()).toBe(3)
  })

  test('never replays a request with a body or an unsafe method', async () => {
    for (const i of [
      init({ method: 'POST' }),
      init({ method: 'GET', body: new ReadableStream() }),
    ]) {
      const f = failing(1)
      await expect(run(f.fn, i)).rejects.toThrow()
      expect(f.calls()).toBe(1)
    }
  })

  test('does not retry real failures or aborted requests', async () => {
    let calls = 0
    const refused: UpstreamFetch = async () => {
      calls++
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
      })
    }
    await expect(run(refused)).rejects.toThrow()
    expect(calls).toBe(1)

    const controller = new AbortController()
    controller.abort()
    const f = failing(1)
    await expect(
      run(f.fn, init({ signal: controller.signal })),
    ).rejects.toThrow()
    expect(f.calls()).toBe(1)
  })
})
