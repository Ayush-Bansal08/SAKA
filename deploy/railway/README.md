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
4. The api's `preDeployCommand` runs `prisma migrate deploy` before every release.

> Production refuses to boot with dev identity/approval providers. Until World ID lands in
> PHASE 10, there is no production mode to deploy (by design).
