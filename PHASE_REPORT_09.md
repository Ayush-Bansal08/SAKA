# Phase 09 — Deploy, docs, demo readiness

Status: **deployed and live as staging.** This phase was cut down to fit the last day of the
hackathon, so several hardening items were not built. See "Skipped".

- Web: <https://saka-rust.vercel.app>
- API: <https://saka-api-demo.eastasia.cloudapp.azure.com>

## Acceptance criteria

| Criterion                                                                | Result                                                                                                                                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Staging deployed (web, api, worker, bot, mcp); health green              | **Done.** Hosted on an Azure VM and Vercel, not Railway (see "Changes from the spec").                                                                           |
| Full demo script runs end to end on staging with DEV approvals           | **Live checks reported as passed by the developer** (`docs/DEPLOY.md` step 8). The final script in `docs/DEMO_SCRIPT.md` has not been timed as one 3-minute run. |
| README track sections for 0G and Uniswap complete, with working pointers | **Partly.** The sections exist from earlier phases. They were not audited here, and `docs/POINTERS.md` was not generated.                                        |
| `docs/DEPLOY.md`, `docs/DEMO_SCRIPT.md`                                  | **Done.**                                                                                                                                                        |
| `docs/RELIABILITY.md`, `docs/SECURITY.md`                                | **Not written.**                                                                                                                                                 |
| `PHASE_REPORT_09.md`                                                     | This file.                                                                                                                                                       |

## What was built

- **`deploy/azure/docker-compose.yml`**: the whole backend on one VM, with Postgres, Redis, a
  one-shot migration step and log rotation. Only Caddy publishes ports.
- **`deploy/azure/Caddyfile`**: HTTPS with an automatic Let's Encrypt certificate.
- **`TRUST_PROXY`**: new setting, so visitors get their own rate limit in staging. Without it, the
  API sees only the proxy's IP outside production.
- **`.env.example`** is now tracked. `.gitignore` was hiding it, so clean clones did not have it.
- **`.dockerignore`** now excludes `.env` files at any depth, and the `deploy` folder.
- **`docs/DEPLOY.md`** and **`docs/DEMO_SCRIPT.md`**.

## Changes from the spec

- **Azure instead of Railway.** The Railway account was on a Limited Trial, which restricts outbound
  network access. Railway also had an open incident with outside networks blocking its IPs. The
  Railway configs stay in `deploy/railway/`.
- **Region is East Asia.** Central India had no vCPU quota left on the student subscription.
- **Staging runs `NODE_ENV=development`.** Production refuses to boot with dev providers, and World
  ID does not exist yet. The bot therefore long-polls and needs no webhook.
- **`DEMO_MODE` panel not built.** The existing Market Event Simulator covers the demo.

## Verification

| Check                                                 | Result                                                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`, `pnpm lint`, web build, `pnpm test` | All pass                                                                                                   |
| Compose stack, run locally                            | HTTPS, CORS, migrations and one real 0G agent question passed, with bot, wallets and 0G Storage turned off |
| Fresh clone from GitHub                               | Compose file valid; no secrets tracked                                                                     |
| Staged commit                                         | Scanned for 30 secret values: none found                                                                   |
| Live API, checked from outside the VM                 | Health `ok`; real certificate; HTTP redirects to HTTPS; CORS and preflight allow the Vercel origin         |
| Live agent question                                   | Finished: 0G planner, Uniswap `compare_pools`, 0G explainer, reply                                         |
| Swaps, wallet, simulator, Telegram, 0G Storage        | Reported as passed by the developer; transaction hashes were not recorded in this report                   |

Stack memory at idle was about 400 MB.

## Skipped

- Circuit breakers, `GET /health/deps` and the "Degraded" chip
- Audit of every external call and the fail-closed and idempotency reviews
- Load sanity test (50 SSE clients, 20 req/s)
- Staging Playwright run and the axe accessibility pass
- `pnpm seed:demo`, `pnpm pointers`, `scripts/smoke/prod.ts`
- `docs/RELIABILITY.md`, `docs/SECURITY.md`, and the final `docs/ARCHITECTURE.md` update

## Known limitations

- **Dev sign-in has no password.** Anyone who enters a name gets that account, including `demo`.
  Testnet funds only.
- **The World track cannot be claimed yet.** World ID (PHASE 10) is not built, and the amber DEV
  banner shows on the live site.
- **`ZG_GUARD_MODE=chat` is still set**, a workaround from the 0G Vela outage. The guard and explainer
  run on `glm-5.3`, not Vela and 0GM. Restore them if 0G confirms they are back.
- **One VM, no backups.** If it is deleted, the hosted database and agent wallet records go with it.
- **GeckoTerminal answers 429 at times.** It is a rate-limited fallback source, and requests still
  finish.

## Commands

Run on the VM, from `~/SAKA/deploy/azure`:

```bash
docker compose ps -a
docker compose logs -f --tail=100 api worker bot
git pull && docker compose up -d --build
```
