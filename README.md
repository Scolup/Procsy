<div align="center">

# Procsy

![Stars + License](https://shieldcn.dev/group/github/stars/Scolup/Procsy+github/license/Scolup/Procsy+github/release/Scolup/Procsy+badge/status-stable-brightgreen.svg?variant=branded&mode=light)

![Cloudflare Workers](https://shieldcn.dev/badge/Cloudflare-Workers-F38020.svg?logo=cloudflareworkers&logoColor=fff&variant=branded&mode=light)
![Hono](https://shieldcn.dev/badge/Hono-E36002.svg?logo=hono&logoColor=fff&variant=branded&mode=light)

HTTP(S) proxy in TypeScript, with Cloudflare Workers.

## Features

</div>

- **IP Spoofing**: Hides the IP by generating a random IPv4 at every request with French internet providers prefixes (optional).

> [!NOTE]
> The IP is passed through the `X-Forwarded-For` header, some services may not respect this header.

- **CORS**: Allows sending requests anywhere by modifying CORS headers.
- **Configurable**: Easily configurable via Cloudflare Workers environment variables.
- **Versatile**: Pass the `X-Procsy-Base-URL` header to control the destination URL (optional).
- **SSRF Protection**: Blocks requests to private / reserved IP ranges.

<div align="center">

## Configuration

</div>

Procsy reads its configuration from **Cloudflare Workers environment variables** (`vars` in `wrangler.jsonc`).

| Variable | Default | Description |
|---|---|---|
| `DEFAULT_BASE_URL` | `example.com` | The default base URL to proxy requests to. |
| `FORCE_HTTPS` | `false` | Whether to force HTTPS. |
| `ALLOW_ORIGIN` | `*` | Comma-separated list of allowed origins (e.g. `google.com, neal.fun`). |
| `SPOOF_IP` | `true` | Whether to spoof the IP via `X-Forwarded-For`. |
| `ALLOW_BASE_URL_HEADER` | `true` | Whether to allow the `X-Procsy-Base-URL` header to control the destination URL. |

For local development, edit `wrangler.jsonc` under the `"vars"` key.
For production, set these values in the **Cloudflare Dashboard** → your Worker → **Variables**, or use `wrangler secret put`.

<div align="center">

## Development

</div>

> [!NOTE]
> We use Bun. [Install it](https://bun.sh/docs/installation) before developing.

```bash
bun install
bun run dev
```

> [!WARNING]
> BEFORE EVERY COMMIT, YOU **MUST** RUN `bun run format`.

<div align="center">

## Deployment

</div>

```bash
bun run deploy
```
