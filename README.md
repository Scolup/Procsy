<div align="center">

# Procsy

![Stars + License](https://shieldcn.dev/group/github/stars/Scolup/Procsy.svg+github/license/Scolup/Procsy.svg+github/release/Scolup/Procsy.svg+badge/status-stable-brightgreen.svg?variant=branded&mode=light)

![Cloudflare Workers](https://shieldcn.dev/badge/Cloudflare-Workers-F38020.svg?logo=cloudflareworkers&logoColor=fff&variant=branded&mode=light)
![Hono](https://shieldcn.dev/badge/Hono-E36002.svg?logo=hono&logoColor=fff&variant=branded&mode=light)

HTTP(S) proxy in TypeScript, running on Cloudflare Workers.

</div>

## Features

- **IP spoofing**: sets `X-Forwarded-For` to a random French ISP IPv4 address.
- **CORS**: reflects the caller's origin and exposes proxy response headers.
- **Configurable**: all options are Cloudflare Workers environment variables.
- **Destination override**: `X-Procsy-Base-URL` selects the upstream host.
- **User-Agent override**: `X-Procsy-User-Agent` replaces the browser's
  `User-Agent`, which browsers do not allow scripts to set directly.
- **SSRF protection**: rejects requests to private and reserved IP addresses.

## Configuration

| Variable                | Default       | Description                                        |
| ----------------------- | ------------- | -------------------------------------------------- |
| `DEFAULT_BASE_URL`      | `example.com` | Default upstream host.                             |
| `FORCE_HTTPS`           | `false`       | Redirect HTTP requests to HTTPS.                   |
| `ALLOW_ORIGIN`          | `*`           | Comma-separated allowed origins, or `*` for any.   |
| `SPOOF_IP`              | `true`        | Set a spoofed `X-Forwarded-For` header.            |
| `ALLOW_BASE_URL_HEADER` | `true`        | Honour `X-Procsy-Base-URL`.                        |
| `POPULATE_HEADER`       | `[]`          | JSON array of headers to set on upstream requests. |

Set these in `wrangler.jsonc` for local development, or in the Cloudflare
Dashboard → Worker → Variables for production.

## Development

This project uses Bun.

```bash
bun install
bun run dev
bun run test
bun run typecheck
```

> [!WARNING]
> Run `bun run format` before every commit.

## Deployment

```bash
bun run deploy
```
