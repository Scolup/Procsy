<div align="center">

# Procsy

![Stars + License](https://shieldcn.dev/group/github/stars/Scolup/Procsy.svg+github/license/Scolup/Procsy.svg+github/release/Scolup/Procsy.svg+badge/status-stable-brightgreen.svg?variant=branded&mode=light)

![Node.js](https://shieldcn.dev/badge/Node.js-5FA04E.svg?logo=nodedotjs&logoColor=fff&variant=branded&mode=light)
![Bun](https://shieldcn.dev/badge/Bun-000000.svg?logo=bun&logoColor=fff&variant=branded&mode=light)
![Hono](https://shieldcn.dev/badge/Hono-E36002.svg?logo=hono&logoColor=fff&variant=branded&mode=light)

HTTP(S) proxy in TypeScript, running natively on Node.js and Bun.

</div>

## Features

- **IP spoofing**: sets `X-Forwarded-For` to a French ISP IPv4 address. With a
  cookie session the same address is reused for every request in that session;
  without one, a random address is generated per request. Headers that would
  reveal the real caller (`X-Real-IP`, `Forwarded`, `Via`, ...) are removed.
- **CORS**: reflects the caller's origin and exposes proxy response headers.
- **Configurable**: all options are environment variables (or a `.env` file).
- **Destination override**: `X-Procsy-Base-URL` selects the upstream host.
- **User-Agent override**: `X-Procsy-User-Agent` replaces the browser's
  `User-Agent`, which browsers do not allow scripts to set directly.
- **Cookie bridging**: send session data in `X-Procsy-Cookie`; upstream
  `Set-Cookie` values are returned as a JSON array in `X-Procsy-Set-Cookie`.
- **SSRF protection**: rejects private, loopback, link-local and reserved
  IPv4/IPv6 destinations, **including host names that resolve to them**.
- **Streaming**: request and response bodies are streamed, never buffered. If
  the client disconnects, the upstream request is cancelled.

## SSRF protection

Unlike on a managed platform, this server sits on your own network, so every
destination is checked before connecting:

- literal addresses and `localhost` are checked directly;
- host names are resolved and **all** returned addresses must be public;
- on **Node** the check is repeated inside the socket's `lookup`, so DNS
  rebinding between check and connect is impossible;
- on **Bun** (no resolver hook) plain-`http://` targets are connected to the
  address that was checked; `https://` targets are protected by certificate
  validation, since an internal service cannot present a valid certificate for
  an attacker's host name. Set `FORCE_HTTPS=true` if you want that guarantee
  for every request.

`ALLOW_PRIVATE_TARGETS=true` turns all of this off. Only use it on a network
you fully control.

## Request and response headers

| Header                | Direction | Description                                 |
| --------------------- | --------- | ------------------------------------------- |
| `X-Procsy-Base-URL`   | request   | Override the upstream host (`host[:port]`). |
| `X-Procsy-User-Agent` | request   | Set the outgoing `User-Agent`.              |
| `X-Procsy-Cookie`     | request   | Set the outgoing `Cookie`.                  |
| `X-Procsy-Set-Cookie` | response  | JSON array of upstream `Set-Cookie` values. |

These headers are stripped before forwarding, and `X-Procsy-Set-Cookie` is
always included in `Access-Control-Expose-Headers`, alongside any explicit
headers the upstream asked to expose. Credentialed CORS responses use explicit
method/header lists rather than `*`, which browsers treat as a literal name
when credentials are present.

`X-Procsy-Base-URL` is `host[:port][/path-prefix]`, e.g. `api.example.com/v3`
(a request to `/login` then goes to `https://api.example.com/v3/login`). Values
containing credentials, a query, a fragment or whitespace are rejected with
`400`.

## Configuration

| Variable                | Default       | Description                                                        |
| ----------------------- | ------------- | ------------------------------------------------------------------ |
| `DEFAULT_BASE_URL`      | `example.com` | Default upstream host. May be empty to require the header.         |
| `FORCE_HTTPS`           | `false`       | Redirect HTTP requests to HTTPS and always use HTTPS upstream.     |
| `ALLOW_ORIGIN`          | `*`           | Comma-separated allowed origins, or `*` for any.                   |
| `SPOOF_IP`              | `true`        | Set a spoofed `X-Forwarded-For` header.                            |
| `ALLOW_BASE_URL_HEADER` | `true`        | Honour `X-Procsy-Base-URL`.                                        |
| `POPULATE_HEADER`       | `[]`          | JSON array of headers to set on upstream requests.                 |
| `TRUST_PROXY`           | `true`        | Trust `X-Forwarded-Proto` (needed behind a TLS-terminating proxy). |
| `LOG_REQUESTS`          | `true`        | Log one line per request (see Troubleshooting).                    |
| `UPSTREAM_TIMEOUT_MS`   | `60000`       | Max wait for upstream response headers (`504`); `0` disables.      |
| `ALLOW_PRIVATE_TARGETS` | `false`       | Disable the SSRF protection. Dangerous.                            |
| `HOST`                  | `127.0.0.1`   | Interface to listen on. Use `0.0.0.0` for all (e.g. in Docker).    |
| `PORT`                  | `3000`        | Port to listen on.                                                 |

Booleans accept `true/false`, `1/0`, `yes/no`, `on/off` (any case); a blank
value means "use the default". An invalid value stops the server at startup
with a clear message instead of silently changing behaviour. Real environment
variables override values from `.env`.

## Running

Requires Node.js >= 20.18.1 **or** Bun. Tested on Node 20.18, 22, 24 and
Bun 1.4.

```bash
bun install            # or: npm install

# Bun, straight from source
bun run start:bun

# Node, from a build
bun run build          # or: npm run build
bun run start          # or: npm start
```

Development: `bun run dev` (Bun) or `bun run dev:node` (Node, via `tsx`).

The server shuts down gracefully on `SIGINT`/`SIGTERM`.

### Behind a reverse proxy

nginx/Caddy/Traefik/Cloudflare Tunnel terminate TLS, so this server only sees
plain HTTP; `TRUST_PROXY` (on by default) makes it honour `X-Forwarded-Proto`.
Without it, `FORCE_HTTPS` would redirect forever and upstream requests would use
`http`. Keep `HOST=127.0.0.1` unless the proxy is on another machine, and point
the tunnel/proxy at `http://127.0.0.1:PORT` (not `localhost`, which can resolve
to `::1`, where nothing listens). Never expose an open proxy to the internet
without access control.

### Troubleshooting

Every request is logged once its response headers are ready, e.g.

```
2026-11-26T19:20:03.512Z [4f2a9c1e] POST api.ecoledirecte.com/v3/login -> 200 312ms
2026-11-26T19:20:09.130Z [0b77d3aa] GET api.example.com/x -> 502 (fetch failed (ECONNRESET) in upstream stage) 40ms
2026-11-26T19:20:15.001Z [9c1e5d02] GET slow.example.com/y still waiting after 10000ms (stage: dns)
```

The same id is returned to the caller as `X-Procsy-Request-Id`, so a failing
request can be matched to its log line. The reason in parentheses says who
refused or failed: `blocked: host resolves to private address ...` (SSRF
guard; a DNS filter such as Pi-hole answering `0.0.0.0` looks like this),
`origin not allowed` (CORS), `invalid X-Procsy-Base-URL`, `timeout in ... stage`,
or the network error. A request that is _stuck_ is reported after 10 s with the
stage it is stuck in (`dns`, `upstream`). Set `LOG_REQUESTS=false` to silence it.

Upstream servers and load balancers silently close idle connections. GET/HEAD
requests are retried when that happens; requests that carry a body (POST...)
always use a fresh connection, because they cannot be replayed safely.

### Notes and limits

- Compressed upstream responses are decoded and sent uncompressed (`fetch`
  cannot pass compressed bytes through); compress at the reverse proxy.
  `Range` requests are sent upstream with `Accept-Encoding: identity`.
- WebSocket/`Upgrade` and `CONNECT` are not supported; `TRACE` returns `405`.
- Requests whose target is the proxy itself are refused (`508`).
- Redirects are returned to the caller as-is, never followed.

## Development

This project uses Bun for tooling.

```bash
bun install
bun run test        # unit tests (bun:test)
bun run typecheck
bun run build && bun run e2e node   # end-to-end on Node
bun run e2e bun                     # end-to-end on Bun
bun run chaos node                  # hostile-upstream stress test (also: bun)
```

The e2e script starts the real server under the chosen runtime against a real
upstream and checks streaming, large bodies, gzip, cookies, hop-by-hop headers,
timeouts, client aborts, HTTPS upstreams, stale connections, SSRF, graceful
shutdown, and more. The chaos script fires hundreds of concurrent requests at an
upstream that resets, hangs, truncates and corrupts responses, and fails if
anything hangs, the server dies, or sockets leak.

> [!WARNING]
> Run `bun run format` before every commit.
