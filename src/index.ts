import { existsSync } from 'node:fs'
import { createApp } from './app'
import { ConfigError, getConfig, getServerConfig, type Env } from './config'
import { isBun } from './runtime'
import type { RunningServer } from './runtime/types'
import { createUpstream } from './upstream'
import { isValidBaseURL } from './utils/url'

/** Bun loads .env on its own; Node needs to be asked (it never overrides). */
function loadDotEnv(): void {
  if (isBun || !existsSync('.env')) return
  const load = (process as { loadEnvFile?: (path?: string) => void })
    .loadEnvFile
  load?.call(process, '.env')
}

// Network errors that a single bad connection can raise outside any request
// handler. They must not take the whole server down.
const BENIGN_ERROR_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_STREAM_DESTROYED',
  'ABORT_ERR',
  'UND_ERR_ABORTED',
  'UND_ERR_SOCKET',
  'UND_ERR_BODY_TIMEOUT',
])

function isBenign(error: unknown): boolean {
  for (let e = error, depth = 0; e && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string' && BENIGN_ERROR_CODES.has(code)) return true
    if ((e as { name?: unknown }).name === 'AbortError') return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

function installSafetyNet(): void {
  const handle = (kind: string) => (error: unknown) => {
    if (isBenign(error)) {
      console.warn(`Ignored ${kind}:`, (error as Error)?.message ?? error)
      return
    }
    console.error(`Fatal ${kind}:`, error)
    process.exit(1)
  }
  process.on('uncaughtException', handle('uncaught exception'))
  process.on('unhandledRejection', handle('unhandled rejection'))
}

function installShutdown(server: RunningServer): void {
  let stopping = false
  const shutdown = (signal: string) => {
    if (stopping) process.exit(1) // Second signal: stop waiting.
    stopping = true
    console.log(`${signal} received, shutting down...`)
    server
      .stop()
      .catch((error) => console.error('Error while stopping:', error))
      .finally(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

async function main(): Promise<void> {
  loadDotEnv()
  const env = process.env as Env

  const config = getConfig(env)
  const serverConfig = getServerConfig(env)
  if (config.defaultBaseURL && !isValidBaseURL(config.defaultBaseURL)) {
    throw new ConfigError(
      `DEFAULT_BASE_URL must be host[:port][/path], got "${config.defaultBaseURL}"`,
    )
  }

  const app = createApp(config, {
    upstreamFetch: await createUpstream(config),
  })

  installSafetyNet()
  const { startServer } = isBun
    ? await import('./runtime/bun')
    : await import('./runtime/node')
  const server = await startServer(
    (request) => app.fetch(request),
    serverConfig,
  )

  installShutdown(server)
  console.log(
    `Procsy listening on ${server.address} (${isBun ? `Bun ${Bun.version}` : `Node ${process.version}`})`,
  )
  if (config.allowPrivateTargets) {
    console.warn(
      'WARNING: ALLOW_PRIVATE_TARGETS is on; anyone who can reach this server can reach your internal network through it.',
    )
  }
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    console.error(`Configuration error: ${error.message}`)
  } else if ((error as { code?: string })?.code === 'EADDRINUSE') {
    console.error(`Cannot start: ${(error as Error).message}`)
  } else {
    console.error('Failed to start:', error)
  }
  process.exit(1)
})
