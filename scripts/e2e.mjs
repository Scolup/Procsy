// End-to-end checks against the real server running under a real runtime.
//   node scripts/e2e.mjs node   (needs `npm run build` first)
//   node scripts/e2e.mjs bun
// Optional: E2E_PRIVATE_HOSTNAME=<name that resolves to a private address>
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { gzipSync } from 'node:zlib'

const runtime = process.argv[2] === 'bun' ? 'bun' : 'node'
const command =
  runtime === 'bun' ? ['bun', 'src/index.ts'] : ['node', 'dist/index.js']

const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push([name, true])
    console.log(`  ok   ${name}`)
  } catch (error) {
    results.push([name, false])
    console.log(`  FAIL ${name}\n       ${error?.stack ?? error}`)
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function eq(actual, expected, label = 'value') {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

// ---------------------------------------------------------------- upstream
const state = { closed: 0, hangs: 0 }
const BIG = randomBytes(20 * 1024 * 1024)
const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const url = new URL(req.url, 'http://x')
    switch (url.pathname) {
      case '/echo':
        res.setHeader('content-type', 'application/json')
        return res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            headers: req.headers,
            rawHeaders: req.rawHeaders,
            bodyLength: body.length,
            bodySha: sha(body),
          }),
        )
      case '/gzip': {
        const z = gzipSync('hello world '.repeat(200))
        res.writeHead(200, {
          'content-encoding': 'gzip',
          'content-length': z.length,
          'content-type': 'text/plain',
        })
        return res.end(z)
      }
      case '/cookies':
        res.setHeader('set-cookie', [
          'a=1; Path=/',
          'b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
        ])
        return res.end('c')
      case '/stream':
        res.write('first|')
        return setTimeout(() => res.end('second'), 500)
      case '/slow':
        res.write('x')
        res.on('close', () => state.closed++)
        return void setInterval(() => res.write('x'), 50).unref()
      case '/redirect':
        res.writeHead(302, { location: 'https://elsewhere.example/' })
        return res.end()
      case '/204':
        res.writeHead(204)
        return res.end()
      case '/304':
        res.writeHead(304)
        return res.end()
      case '/hang':
        state.hangs++
        return
      case '/range':
        res.writeHead(206, { 'content-range': 'bytes 0-3/10' })
        return res.end(JSON.stringify(req.headers['accept-encoding']))
      case '/big':
        return res.end(BIG)
      case '/head':
        res.writeHead(200, { 'content-length': '5' })
        return res.end(req.method === 'HEAD' ? undefined : 'hello')
      default:
        res.writeHead(404)
        return res.end('nope')
    }
  })
})
await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
const UP = `127.0.0.1:${upstream.address().port}`

// ------------------------------------------------------------------- proxy
const children = new Set()
function startProxy(env = {}, { expectStart = true } = {}) {
  const [cmd, ...args] = command
  const child = spawn(cmd, args, {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      ALLOW_PRIVATE_TARGETS: 'true',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  let output = ''
  const exited = new Promise((r) => child.once('exit', (code) => r(code)))
  const ready = new Promise((resolve, reject) => {
    const onData = (d) => {
      output += d
      const m = /listening on http:\/\/[^:]+:(\d+)/.exec(output)
      if (m) resolve(Number(m[1]))
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', (d) => (output += d))
    exited.then((code) => reject(new Error(`exited ${code}: ${output}`)))
    setTimeout(() => reject(new Error(`start timeout: ${output}`)), 8000)
  })
  ready.catch(() => {}) // Reported only by callers that await it.
  return {
    child,
    exited,
    output: () => output,
    ready: expectStart ? ready : undefined,
    kill: () => child.kill('SIGKILL'),
  }
}
async function withProxy(env, fn) {
  const p = startProxy(env)
  const port = await p.ready
  try {
    await fn(port, p)
  } finally {
    p.kill()
  }
}

function raw(port, text, { timeout = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let data = ''
    socket.setEncoding('latin1')
    socket.on('connect', () => socket.write(text))
    socket.on('data', (d) => (data += d))
    socket.on('close', () => resolve(data))
    socket.on('error', reject)
    setTimeout(() => {
      socket.destroy()
      resolve(data)
    }, timeout)
  })
}
const statusOf = (rawResponse) =>
  Number(/^HTTP\/1\.1 (\d+)/.exec(rawResponse)?.[1])

const viaProxy = (port, path, init = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    redirect: 'manual',
    ...init,
    headers: { 'X-Procsy-Base-URL': UP, ...(init.headers ?? {}) },
  })

// -------------------------------------------------------------------- tests
console.log(`\n=== e2e on ${runtime} ===`)

await withProxy({}, async (port, proxy) => {
  await test('health endpoint', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/health`)
    eq(r.status, 200)
    eq((await r.json()).status, 'ok')
  })

  await test('forwards path+query; Host is the upstream; headers cleaned', async () => {
    const r = await viaProxy(port, '/echo?a=1&b=%20x', {
      headers: {
        'X-Procsy-User-Agent': 'FakeUA/1',
        'X-Procsy-Cookie': 'sid=xyz',
        'X-Real-IP': '9.9.9.9',
        'X-Forwarded-Proto': 'http',
        Origin: 'https://site.example',
      },
    })
    eq(r.status, 200)
    const j = await r.json()
    eq(j.url, '/echo?a=1&b=%20x', 'url')
    eq(j.headers.host, UP, 'host')
    eq(j.headers['user-agent'], 'FakeUA/1', 'ua')
    eq(j.headers.cookie, 'sid=xyz', 'cookie')
    assert(
      !Object.keys(j.headers).some((h) => h.startsWith('x-procsy')),
      'x-procsy leaked',
    )
    assert(!j.headers['x-real-ip'], 'x-real-ip leaked')
    assert(!j.headers['x-forwarded-proto'], 'x-forwarded-proto leaked')
    assert(
      /^(80\.12|82\.224|176\.128|90\.1)\.\d+\.\d+$/.test(
        j.headers['x-forwarded-for'],
      ),
      'xff ' + j.headers['x-forwarded-for'],
    )
    eq(r.headers.get('access-control-allow-origin'), 'https://site.example')
  })

  await test('spoofed IP is stable per cookie session', async () => {
    const ip = async (c) =>
      (
        await (
          await viaProxy(port, '/echo', { headers: { 'X-Procsy-Cookie': c } })
        ).json()
      ).headers['x-forwarded-for']
    eq(await ip('s=1'), await ip('s=1'))
  })

  await test('gzip upstream: client gets a valid, decoded body and no stale headers', async () => {
    // Node/Bun fetch clients would throw on a content-encoding/body mismatch.
    const r = await viaProxy(port, '/gzip', {
      headers: { 'Accept-Encoding': 'gzip' },
    })
    eq(r.status, 200)
    eq(await r.text(), 'hello world '.repeat(200))
    const rawRes = await raw(
      port,
      `GET /gzip HTTP/1.1\r\nHost: x\r\nX-Procsy-Base-URL: ${UP}\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n`,
    )
    assert(!/content-encoding/i.test(rawRes), 'content-encoding leaked')
    assert(!/content-length: 34\d?\r/i.test(rawRes), 'stale content-length')
  })

  await test('multiple Set-Cookie preserved and bridged as JSON', async () => {
    const r = await viaProxy(port, '/cookies')
    eq(
      JSON.stringify(r.headers.getSetCookie()),
      JSON.stringify([
        'a=1; Path=/',
        'b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
      ]),
    )
    eq(JSON.parse(r.headers.get('x-procsy-set-cookie')).length, 2)
    assert(
      r.headers
        .get('access-control-expose-headers')
        .includes('X-Procsy-Set-Cookie'),
    )
  })

  await test('responses are streamed, not buffered', async () => {
    const t0 = Date.now()
    const r = await viaProxy(port, '/stream')
    const reader = r.body.getReader()
    const first = await reader.read()
    const firstAt = Date.now() - t0
    eq(new TextDecoder().decode(first.value), 'first|')
    assert(firstAt < 350, `first chunk took ${firstAt}ms`)
    let rest = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      rest += new TextDecoder().decode(value)
    }
    eq(rest, 'second')
  })

  await test('redirects, 204, 304 and HEAD pass through untouched', async () => {
    const r = await viaProxy(port, '/redirect')
    eq(r.status, 302)
    eq(r.headers.get('location'), 'https://elsewhere.example/')
    eq((await viaProxy(port, '/204')).status, 204)
    eq((await viaProxy(port, '/304')).status, 304)
    const h = await viaProxy(port, '/head', { method: 'HEAD' })
    eq(h.status, 200)
    eq(h.headers.get('content-length'), '5')
    eq((await h.text()).length, 0)
    eq((await viaProxy(port, '/missing')).status, 404)
  })

  await test('POST body: small, and 20 MB integrity', async () => {
    const small = await (
      await viaProxy(port, '/echo', { method: 'POST', body: 'hello' })
    ).json()
    eq(small.bodyLength, 5)
    const r = await viaProxy(port, '/echo', { method: 'POST', body: BIG })
    const j = await r.json()
    eq(j.bodyLength, BIG.length, 'length')
    eq(j.bodySha, sha(BIG), 'sha')
  })

  await test('large download integrity (20 MB)', async () => {
    const buf = Buffer.from(await (await viaProxy(port, '/big')).arrayBuffer())
    eq(sha(buf), sha(BIG))
  })

  await test('chunked upload (no content-length)', async () => {
    const res = await raw(
      port,
      `POST /echo HTTP/1.1\r\nHost: x\r\nX-Procsy-Base-URL: ${UP}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n`,
    )
    eq(statusOf(res), 200)
    assert(res.includes('"bodyLength":11'), 'body length: ' + res.slice(-200))
  })

  await test('hop-by-hop request headers do not break the request', async () => {
    const res = await raw(
      port,
      `POST /echo HTTP/1.1\r\nHost: x\r\nX-Procsy-Base-URL: ${UP}\r\nConnection: keep-alive, X-Secret\r\nX-Secret: s\r\nKeep-Alive: timeout=5\r\nTE: trailers\r\nUpgrade: websocket\r\nExpect: 100-continue\r\nContent-Length: 2\r\n\r\nhi`,
    )
    assert(/HTTP\/1\.1 (100|200)/.test(res), 'got: ' + res.slice(0, 80))
    assert(res.includes('"bodyLength":2'), 'body lost: ' + res.slice(-160))
    assert(
      !/x-secret/i.test(res.split('\r\n\r\n').slice(-1)[0]),
      'Connection-named header forwarded',
    )
  })

  await test('Range request is sent with Accept-Encoding: identity', async () => {
    const r = await viaProxy(port, '/range', {
      headers: { Range: 'bytes=0-3' },
    })
    eq(r.status, 206)
    const enc = await r.json()
    assert(/identity/.test(enc) && !/gzip|deflate|br/.test(enc), 'got ' + enc)
    const n = await viaProxy(port, '/range')
    eq(await n.json(), 'gzip, deflate, br')
  })

  await test('unsupported methods get 405', async () => {
    for (const m of ['TRACE', 'CONNECT']) {
      const res = await raw(
        port,
        `${m} / HTTP/1.1\r\nHost: x\r\nX-Procsy-Base-URL: ${UP}\r\nConnection: close\r\n\r\n`,
      )
      const s = statusOf(res)
      // Node's HTTP server drops CONNECT sockets itself (no response at all).
      assert(
        s === 405 || s === 400 || (m === 'CONNECT' && res === ''),
        `${m} -> ${s}`,
      )
    }
  })

  await test('base URL with a path prefix is prepended to the path', async () => {
    const j = await (
      await viaProxy(port, '/echo?a=1', {
        headers: { 'X-Procsy-Base-URL': UP + '/v3' },
      })
    )
      .json()
      .catch(() => null)
    // The upstream only serves /echo, so a prefixed path is a 404 from upstream.
    eq(j, null, 'expected non-JSON 404 body')
    const r = await viaProxy(port, '/echo', {
      headers: { 'X-Procsy-Base-URL': UP + '/v3' },
    })
    eq(r.status, 404)
    assert((await r.text()) === 'nope')
  })

  await test('invalid base URLs are rejected with 400', async () => {
    for (const bad of [
      'http://a.com',
      'user@a.com',
      'a.com?x=1',
      'a b.com',
      'a.com#x',
    ]) {
      const r = await viaProxy(port, '/', {
        headers: { 'X-Procsy-Base-URL': bad },
      })
      eq(r.status, 400, bad)
    }
  })

  await test('self-targeting is refused (loop protection)', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/x`, {
      headers: { 'X-Procsy-Base-URL': `127.0.0.1:${port}` },
    })
    eq(r.status, 508)
  })

  await test('upstream down -> 502 with reason; unknown host -> 502', async () => {
    const dead = net.createServer().listen(0, '127.0.0.1')
    await sleep(50)
    const deadPort = dead.address().port
    dead.close()
    await sleep(50)
    const r = await viaProxy(port, '/', {
      headers: { 'X-Procsy-Base-URL': `127.0.0.1:${deadPort}` },
    })
    eq(r.status, 502)
    assert((await r.text()).includes('ECONNREFUSED'), 'reason missing')
    const u = await viaProxy(port, '/', {
      headers: { 'X-Procsy-Base-URL': 'does-not-exist.invalid' },
    })
    eq(u.status, 502)
  })

  await test('malformed requests do not crash the server', async () => {
    await raw(
      port,
      'GET http://evil.example/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
    )
    await raw(
      port,
      'GET / HTTP/1.1\r\nHost: bad host\r\nConnection: close\r\n\r\n',
    )
    await raw(port, 'GARBAGE\r\n\r\n')
    await raw(
      port,
      `GET /%ZZ HTTP/1.1\r\nHost: x\r\nX-Procsy-Base-URL: ${UP}\r\nConnection: close\r\n\r\n`,
    )
    eq((await fetch(`http://127.0.0.1:${port}/health`)).status, 200)
  })

  await test('client disconnect aborts the upstream request; server survives', async () => {
    const before = state.closed
    await new Promise((resolve, reject) => {
      const req = http.get(
        {
          port,
          host: '127.0.0.1',
          path: '/slow',
          headers: { 'X-Procsy-Base-URL': UP },
        },
        (res) => {
          res.once('data', () => {
            res.destroy()
            resolve()
          })
        },
      )
      req.on('error', () => {})
      setTimeout(() => reject(new Error('no data')), 3000)
    })
    for (let i = 0; i < 40 && state.closed === before; i++) await sleep(50)
    assert(state.closed > before, 'upstream connection was not closed')
    eq((await fetch(`http://127.0.0.1:${port}/health`)).status, 200)
  })

  await test('many concurrent requests', async () => {
    const rs = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        viaProxy(port, `/echo?i=${i}`).then((r) => r.json()),
      ),
    )
    rs.forEach((j, i) => eq(j.url, `/echo?i=${i}`))
  })
})

await test('HTTPS upstream (TLS, SNI, verification) works', async () => {
  const cert = new URL('./fixtures/test-cert.pem', import.meta.url).pathname
  const key = new URL('./fixtures/test-key.pem', import.meta.url).pathname
  const secure = https.createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () =>
        res.end(
          JSON.stringify({
            method: req.method,
            host: req.headers.host,
            body: Buffer.concat(chunks).toString(),
          }),
        ),
      )
    },
  )
  await new Promise((r) => secure.listen(0, '127.0.0.1', r))
  const host = `127.0.0.1:${secure.address().port}`
  try {
    await withProxy(
      { TRUST_PROXY: 'true', NODE_EXTRA_CA_CERTS: cert },
      async (port) => {
        const call = (method, body) =>
          fetch(`http://127.0.0.1:${port}/x`, {
            method,
            body,
            headers: {
              'X-Procsy-Base-URL': host,
              'X-Forwarded-Proto': 'https',
            },
          }).then((r) => r.json())
        const get = await call('GET')
        eq(get.host, host)
        const post = await call('POST', 'a=1')
        eq(post.body, 'a=1')
      },
    )
    // An untrusted certificate must be refused, not silently accepted.
    await withProxy({ TRUST_PROXY: 'true' }, async (port) => {
      const r = await fetch(`http://127.0.0.1:${port}/x`, {
        headers: { 'X-Procsy-Base-URL': host, 'X-Forwarded-Proto': 'https' },
      })
      eq(r.status, 502)
    })
  } finally {
    secure.close()
  }
})

await test('survives an upstream that silently closes idle connections', async () => {
  const flaky = net.createServer((socket) => {
    let buf = ''
    let timer
    socket.on('error', () => {})
    socket.on('data', (d) => {
      buf += d
      const [head, rest = ''] = buf.split('\r\n\r\n')
      if (!buf.includes('\r\n\r\n')) return
      const need = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0)
      if (rest.length < need) return
      buf = ''
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')
      clearTimeout(timer)
      timer = setTimeout(() => socket.destroy(), 100)
    })
  })
  await new Promise((r) => flaky.listen(0, '127.0.0.1', r))
  const host = `127.0.0.1:${flaky.address().port}`
  try {
    await withProxy({}, async (port) => {
      const failures = []
      for (let i = 0; i < 120; i++) {
        await sleep(85 + Math.random() * 30) // straddles the 100 ms idle close
        const method = i % 2 ? 'POST' : 'GET'
        const r = await fetch(`http://127.0.0.1:${port}/x`, {
          method,
          body: method === 'POST' ? 'a=1' : undefined,
          headers: { 'X-Procsy-Base-URL': host },
        })
        if (r.status !== 200) failures.push(`${method} ${r.status}`)
      }
      eq(failures.length, 0, `failures: ${failures.join(', ')}`)
    })
  } finally {
    flaky.close()
  }
})

await test('logs one line per request with an id, never the query string', async () => {
  const p = startProxy({ LOG_REQUESTS: 'true' })
  const port = await p.ready
  try {
    const r = await viaProxy(port, '/echo?token=SECRET', {
      headers: { 'X-Procsy-Cookie': 'sid=SECRET' },
    })
    const id = r.headers.get('x-procsy-request-id')
    assert(/^[0-9a-f]{8}$/.test(id), 'request id header: ' + id)
    await viaProxy(port, '/', { headers: { 'X-Procsy-Base-URL': 'bad host' } })
    await sleep(100)
    const out = p.output()
    assert(
      out.includes(`[${id}] GET ${UP}/echo -> 200`),
      'missing log line:\n' + out,
    )
    assert(
      out.includes('invalid X-Procsy-Base-URL'),
      'missing failure reason:\n' + out,
    )
    assert(!out.includes('SECRET'), 'secret leaked into logs')
  } finally {
    p.kill()
  }
})

await test('upstream timeout -> 504 (UPSTREAM_TIMEOUT_MS)', async () => {
  await withProxy({ UPSTREAM_TIMEOUT_MS: '400' }, async (port) => {
    const t0 = Date.now()
    const r = await viaProxy(port, '/hang')
    eq(r.status, 504)
    assert(Date.now() - t0 < 2000, 'too slow')
    eq((await fetch(`http://127.0.0.1:${port}/health`)).status, 200)
  })
})

await test('private targets are blocked by default (literal, localhost, DNS)', async () => {
  await withProxy({ ALLOW_PRIVATE_TARGETS: 'false' }, async (port) => {
    const hosts = [
      UP,
      'localhost:1',
      '[::1]:1',
      '169.254.169.254',
      '10.0.0.1',
      '127.1',
      '2130706433',
    ]
    if (process.env.E2E_PRIVATE_HOSTNAME)
      hosts.push(process.env.E2E_PRIVATE_HOSTNAME)
    for (const h of hosts) {
      const r = await viaProxy(port, '/', {
        headers: { 'X-Procsy-Base-URL': h },
      })
      eq(r.status, 403, h)
    }
    // A public-looking name that does not resolve is a plain 502, not a block.
    eq(
      (
        await viaProxy(port, '/', {
          headers: { 'X-Procsy-Base-URL': 'does-not-exist.invalid' },
        })
      ).status,
      502,
    )
  })
})

await test('FORCE_HTTPS + TRUST_PROXY honour X-Forwarded-Proto', async () => {
  await withProxy(
    { FORCE_HTTPS: 'true', TRUST_PROXY: 'true' },
    async (port) => {
      const a = await viaProxy(port, '/p?q=1', {
        headers: { Host: 'proxy.example' },
      }).catch(() => null)
      const plain = await raw(
        port,
        `GET /p?q=1 HTTP/1.1\r\nHost: proxy.example\r\nX-Forwarded-Proto: http\r\nConnection: close\r\n\r\n`,
      )
      eq(statusOf(plain), 301)
      assert(/location: https:\/\/proxy\.example\/p\?q=1/i.test(plain), plain)
      const behindTLS = await raw(
        port,
        `GET /p HTTP/1.1\r\nHost: proxy.example\r\nX-Forwarded-Proto: https\r\nX-Procsy-Base-URL: ${UP}\r\nConnection: close\r\n\r\n`,
      )
      assert(statusOf(behindTLS) !== 301, 'redirect loop behind TLS terminator')
      void a
    },
  )
  await withProxy(
    { FORCE_HTTPS: 'true', TRUST_PROXY: 'false' },
    async (port) => {
      const res = await raw(
        port,
        `GET /p HTTP/1.1\r\nHost: proxy.example\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n\r\n`,
      )
      eq(statusOf(res), 301)
    },
  )
})

await test('CORS: restricted origins, preflight, health unaffected', async () => {
  await withProxy({ ALLOW_ORIGIN: 'good.example' }, async (port) => {
    eq((await fetch(`http://127.0.0.1:${port}/health`)).status, 200)
    eq(
      (
        await viaProxy(port, '/echo', {
          headers: { Origin: 'https://evil.example' },
        })
      ).status,
      403,
    )
    eq(
      (
        await viaProxy(port, '/echo', {
          headers: { Origin: 'https://app.good.example' },
        })
      ).status,
      200,
    )
    const pre = await fetch(`http://127.0.0.1:${port}/x`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://good.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-procsy-cookie',
      },
    })
    eq(pre.status, 204)
    assert(
      pre.headers
        .get('access-control-allow-headers')
        .toLowerCase()
        .includes('x-procsy-cookie'),
    )
  })
})

await test('POPULATE_HEADER and SPOOF_IP=false', async () => {
  await withProxy(
    { POPULATE_HEADER: '[{"X-Token":"secret"}]', SPOOF_IP: 'false' },
    async (port) => {
      const j = await (
        await viaProxy(port, '/echo', { headers: { 'X-Token': 'caller' } })
      ).json()
      eq(j.headers['x-token'], 'secret')
      assert(!j.headers['x-forwarded-for'], 'xff set')
    },
  )
})

await test('SIGTERM shuts down gracefully (exit 0)', async () => {
  const p = startProxy()
  await p.ready
  p.child.kill('SIGTERM')
  const code = await Promise.race([p.exited, sleep(5000).then(() => 'timeout')])
  eq(code, 0, 'exit code')
})

await test('bad configuration exits 1 with a clear message', async () => {
  for (const env of [
    { FORCE_HTTPS: 'maybe' },
    { PORT: '99999' },
    { DEFAULT_BASE_URL: 'a.com?x=1' },
  ]) {
    const p = startProxy(env, { expectStart: false })
    const code = await Promise.race([
      p.exited,
      sleep(5000).then(() => 'timeout'),
    ])
    eq(code, 1, JSON.stringify(env))
    assert(/Configuration error/.test(p.output()), p.output())
  }
})

await test('port already in use exits 1', async () => {
  const hold = net.createServer().listen(0, '127.0.0.1')
  await sleep(50)
  const p = startProxy(
    { PORT: String(hold.address().port) },
    { expectStart: false },
  )
  eq(await Promise.race([p.exited, sleep(5000).then(() => 'timeout')]), 1)
  hold.close()
})

// ----------------------------------------------------------------- summary
for (const c of children) c.kill('SIGKILL')
upstream.close()
const failed = results.filter(([, ok]) => !ok)
console.log(
  `\n${runtime}: ${results.length - failed.length}/${results.length} passed`,
)
process.exit(failed.length ? 1 : 0)
