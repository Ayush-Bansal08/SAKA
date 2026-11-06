# Railway deployment

One Railway project, one Docker image (`apps/api/Dockerfile`), several services. Each service
points its **Config-as-code path** at the matching file in this folder.

| Service    | Config file                  | Process                      | Added in |
| ---------- | ---------------------------- | ---------------------------- | -------- |
| `api`      | `deploy/railway/api.json`    | `node dist/server.js` (HTTP) | PHASE 01 |
| `worker`   | `deploy/railway/worker.json` | `node dist/worker.js`        | PHASE 01 |
| `mcp`      | `deploy/railway/mcp.json`    | Uniswap agent MCP server     | PHASE 02 |
| `bot`      | `deploy/railway/bot.json`    | Telegram bot                 | PHASE 08 |
| `Postgres` | Railway PostgreSQL plugin    | —                            | PHASE 01 |
| `Redis`    | Railway Redis plugin         | —                            | PHASE 01 |

The image also has a generic entry, `node dist/main.js`, that picks the process from
`PROCESS_TYPE` (`server` | `worker` | `bot`).

## Setup

1. Create a project from this GitHub repo and add the **PostgreSQL** and **Redis** plugins.
2. Add the `api` and `worker` services from the repo, with Root Directory `/` and the config paths above.
3. Set the variables on both services (use Railway references for the plugins):
   - `NODE_ENV=production`, `APP_NAME`, `WEB_URL` (the Vercel URL), `API_URL` (the api service's public URL)
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `REDIS_URL=${{Redis.REDIS_URL}}`
   - `ENCRYPTION_KEY` (`openssl rand -base64 32`), `ADMIN_TOKEN` (`openssl rand -hex 32`)
   - `EXECUTION_CHAIN_ID`, `AUTH_MODE=world`, `APPROVAL_MODE=world`, `ALLOW_DEV_PROVIDERS=false`
   - PHASE 03: `PRIVY_APP_ID`, `PRIVY_APP_SECRET` (+ `PRIVY_AUTHORIZATION_PRIVATE_KEY` only if the
     Privy dashboard requires signed requests), `MCP_URL` + `MCP_AUTH_TOKEN` on **both** api and
     worker (the worker's balance watcher reads balances through MCP), optionally
     `FAUCET_ETH_URL`, `FAUCET_USDC_URL`, `TOKEN_ALLOWLIST_JSON`
4. The api's `preDeployCommand` runs `prisma migrate deploy` before every release.
5. **`mcp` service** (its own image: `packages/uniswap-agent-mcp/Dockerfile`, config
   `deploy/railway/mcp.json`). Keep it private (Railway private networking) and point the api's
   `MCP_URL` at `http://mcp.railway.internal:${PORT}/mcp`. Variables:
   - `UNISWAP_API_KEY`, `EXECUTION_CHAIN_ID`, `EXECUTION_RPC_URL`, `MAINNET_RPC_URL`,
     `THEGRAPH_API_KEY`, `ETHERSCAN_API_KEY` (optional)
   - `MCP_AUTH_TOKEN` (same value on `api` and `mcp`), `MCP_RESUME_SECRET` (`openssl rand -hex 32`)
   - Railway sets `PORT`; the health check is `GET /health`.

6. **`bot` service** (`deploy/railway/bot.json`): set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` and
   `TELEGRAM_WEBHOOK_SECRET` on `api`, `worker` and `bot`. The service registers the webhook on
   `API_URL/telegram/webhook`, then exits. The worker sends all outgoing messages.

> Production refuses to boot with dev identity/approval providers. Until World ID lands in
> PHASE 10, there is no production mode to deploy (by design).

## Staging deploy (current hosted mode, until PHASE 10)

The steps above describe the production target. Until World ID lands, the hosted app runs as
staging. Use these values instead on `api`, `worker` and `bot`:

```env
NODE_ENV=development
LOG_FORMAT=json
TRUST_PROXY=true
AUTH_MODE=dev
APPROVAL_MODE=dev
ALLOW_DEV_PROVIDERS=true
MCP_URL=http://mcp.railway.internal:3002/mcp
```

On `mcp`, leave `NODE_ENV` unset and add `PORT=3002` and `MCP_HOST=::`.

- `LOG_FORMAT=json` is required: `pino-pretty` is a dev dependency and is not in the image.
- `TRUST_PROXY=true` gives each visitor their own rate-limit bucket behind Railway's proxy.
- In this mode the `bot` service stays running and long-polls Telegram, so
  `TELEGRAM_WEBHOOK_SECRET` is not needed. Do not run the same bot token locally at the same time.
- Dev sign-in has no password: anyone who enters a name gets that account. Testnet funds only.
