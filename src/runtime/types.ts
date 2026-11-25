import type { ServerConfig } from '../config'

export type FetchHandler = (request: Request) => Response | Promise<Response>

export interface RunningServer {
  /** Human readable listening address. */
  readonly address: string
  /** Stop accepting connections and let in-flight requests finish. */
  stop(): Promise<void>
}

export type StartServer = (
  handler: FetchHandler,
  config: ServerConfig,
) => Promise<RunningServer>
