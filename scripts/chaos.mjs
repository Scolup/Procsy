// Chaos test: a hostile upstream and impatient clients; the proxy must never
// hang, crash or leak sockets.   node scripts/chaos.mjs node|bun [requests]
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import http from 'node:http'
import { gzipSync } from 'node:zlib'

const runtime = process.argv[2] === 'bun' ? 'bun' : 'node'
const TOTAL = Number(process.argv[3] ?? 800)
const CONCURRENCY = 60
const command =
  runtime === 'bun' ? ['bun', 'src/index.ts'] : ['node', 'dist/index.js']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pick = (list) => list[Math.floor(Math.random() * list.length)]

const BEHAVIOURS = [
  'ok',
  'ok',
  'ok',
  'delay',
  'reset',
  'midbody',
  'midchunked',
  'hang',
  'bigslow',
  'badgzip',
  'redirect',
  'nocontent',
  'earlyclose',
  'cookies',
]

const upstream = http.createServer((req, res) => {
  const b = new URL(req.url, 'http://x').searchParams.get('b')
  const drain = () => req.on('data', () => {}).on('error', () => {})
  switch (b) {
    case 'reset':
      return req.socket.destroy()
    case 'midbody':
      res.writeHead(200, { 'content-length': 1000 })
      res.write('x'.repeat(100))
      return void setTimeout(() => req.socket.destroy(), 20)
    case 'midchunked':
      res.writeHead(200)
      res.write('x'.repeat(100))
      return void setTimeout(() => req.socket.destroy(), 20)
    case 'hang':
      return drain()
    case 'bigslow': {
      res.writeHead(200)
      let n = 0
      const t = setInterval(() => {
        res.write('y'.repeat(20000))
        if (++n > 60) {
          clearInterval(t)
          res.end()
        }
      }, 10)
      return void res.on('close', () => clearInterval(t))
    }
    case 'badgzip':
      res.writeHead(200, { 'content-encoding': 'gzip' })
      return res.end('this is not gzip')
    case 'redirect':
      res.writeHead(302, { location: 'https://x.example/' })
      return res.end()
    case 'nocontent':
      res.writeHead(204)
      return res.end()
    case 'earlyclose':
      res.writeHead(401, { 'content-length': 2, connection: 'close' })
      res.end('no')
      return void setTimeout(() => req.socket.destroy(), 5)
    case 'cookies':
      res.setHeader('set-cookie', ['a=1', 'b=2'])
      return res.end('c')
    case 'delay':
      return void setTimeout(() => res.end('late'), 50 + Math.random() * 350)
    default:
      drain()
      req.on('end', () => res.end('ok'))
  }
})
upstream.keepAliveTimeout = 300
await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
const UP = `127.0.0.1:${upstream.address().port}`

const [cmd, ...args] = command
const child = spawn(cmd, args, {
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: '0',
    ALLOW_PRIVATE_TARGETS: 'true',
    UPSTREAM_TIMEOUT_MS: '700',
    LOG_REQUESTS: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
let exited = null
child.on('exit', (code) => (exited = code))
child.stderr.on('data', (d) => (output += d))
const port = await new Promise((resolve, reject) => {
  child.stdout.on('data', (d) => {
    const m = /:(\d+) \(/.exec(d)
    if (m) resolve(+m[1])
  })
  setTimeout(() => reject(new Error('no start')), 8000)
})
// Sockets still open after the run, by side and TCP state. Idle keep-alive
// connections *from clients* are normal (the server keeps them 65 s), so only
// upstream-facing sockets and half-closed (CLOSE_WAIT) ones count as leaks.
const STATES = {
  '01': 'ESTAB',
  '08': 'CLOSE_WAIT',
  '06': 'TIME_WAIT',
  '0A': 'LISTEN',
}
function sockets() {
  const mine = new Set(
    readdirSync(`/proc/${child.pid}/fd`)
      .map((f) => {
        try {
          return readlinkSync(`/proc/${child.pid}/fd/${f}`)
        } catch {
          return ''
        }
      })
      .filter((l) => l.startsWith('socket:'))
      .map((l) => l.slice(8, -1)),
  )
  const found = { upstream: 0, closeWait: 0, clients: 0 }
  for (const file of ['tcp', 'tcp6']) {
    let lines = []
    try {
      lines = readFileSync(`/proc/net/${file}`, 'utf8').split('\n').slice(1)
    } catch {}
    for (const line of lines) {
      const c = line.trim().split(/\s+/)
      if (!c[9] || !mine.has(c[9])) continue
      const local = parseInt(c[1].split(':')[1], 16),
        remote = parseInt(c[2].split(':')[1], 16)
      const state = STATES[c[3]] ?? c[3]
      if (state === 'LISTEN') continue
      if (state === 'CLOSE_WAIT') found.closeWait++
      if (remote === upstream.address().port) found.upstream++
      else if (local === port) found.clients++
    }
  }
  return found
}

const stats = { hung: 0, aborted: 0, errors: {}, status: {} }
const big = Buffer.alloc(3 * 1024 * 1024, 1)
let next = 0

async function one() {
  const b = pick(BEHAVIOURS)
  const method = pick(['GET', 'GET', 'POST'])
  const body =
    method === 'POST' ? (b === 'earlyclose' ? big : 'a=1&b=2') : undefined
  const abortAfter = Math.random() < 0.2 ? Math.random() * 200 : null
  const ctl = new AbortController()
  let selfAborted = false
  if (abortAfter !== null)
    setTimeout(() => {
      selfAborted = true
      ctl.abort()
    }, abortAfter)
  const guard = setTimeout(() => ctl.abort(new Error('HUNG')), 6000)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/p?b=${b}`, {
      method,
      body,
      signal: ctl.signal,
      redirect: 'manual',
      headers: { 'X-Procsy-Base-URL': UP },
    })
    stats.status[r.status] = (stats.status[r.status] ?? 0) + 1
    await r.arrayBuffer()
  } catch (e) {
    if (selfAborted) stats.aborted++
    else if (String(e?.message).includes('HUNG') || e?.name === 'AbortError')
      stats.hung++
    else
      stats.errors[e?.cause?.code ?? e?.message] =
        (stats.errors[e?.cause?.code ?? e?.message] ?? 0) + 1
  } finally {
    clearTimeout(guard)
  }
}
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next++ < TOTAL) await one()
  }),
)

const alive = await fetch(`http://127.0.0.1:${port}/health`)
  .then((r) => r.status)
  .catch(() => 'dead')
await sleep(8000) // let idle upstream connections time out
const open = sockets()
console.log(`${runtime}: ${TOTAL} requests`, JSON.stringify(stats))
console.log(
  `${runtime}: alive=${alive} exited=${exited} open sockets after settle: ${JSON.stringify(open)}`,
)
if (output.trim())
  console.log('stderr:', output.trim().split('\n').slice(0, 8).join('\n'))
child.kill('SIGKILL')
upstream.close()
const ok =
  alive === 200 &&
  exited === null &&
  stats.hung === 0 &&
  open.upstream === 0 &&
  open.closeWait === 0
console.log(ok ? `${runtime}: CHAOS PASSED` : `${runtime}: CHAOS FAILED`)
process.exit(ok ? 0 : 1)
