# Warden

**A consumer AI DeFi agent for verified humans.** Sign in, get your own agent wallet, and ask in
plain English: "Swap $20 ETH to USDC", "Put $100 into ETH/USDC", "Is this hook safe?". The agent
plans with verified AI models on **0G**, builds transactions through our own **Uniswap** MCP
server, checks them through a safety layer, and executes them, or asks you first. Big moves always
need a fresh **World ID** verification.

> Without 0G the agent can't think, can't double-check its own trades, and there's no tamper-proof
> record of why it moved your money.

Built for ETHGlobal Mumbai (Nov 5–7, 2026). Execution happens on **one testnet** only. Ethereum
mainnet is used read-only for market data.

## Status

| Phase | Scope                                                                    | State   |
| ----- | ------------------------------------------------------------------------ | ------- |
| 01    | Monorepo, full DB schema, API & web shells, DEV identity, SSE trace bus  | ✅ done |
| 02    | Uniswap agent MCP server (16 tools, unsigned-only) + API client          | ✅ done |
| 03    | Privy agent wallet, onboarding wizard, balance watcher, portfolio        | ✅ done |
| 04    | 0G planner, guard (Vela), explainer, request IDs                         | ✅ done |
| 05    | Prepare, safety scores, simulation, policy, approvals, execution, 0G log | ✅ done |
| 06+   | Cockpit polish, hooks/LP/triggers, Mode B + Telegram, World ID           | planned |

See [`PHASE_REPORT_01.md`](PHASE_REPORT_01.md), [`PHASE_REPORT_02.md`](PHASE_REPORT_02.md) and
[`PHASE_REPORT_03.md`](PHASE_REPORT_03.md), [`PHASE_REPORT_04.md`](PHASE_REPORT_04.md) and
[`PHASE_REPORT_05.md`](PHASE_REPORT_05.md) for what was built and how it was verified, and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how it fits together.

## Quick start (local)

Requirements: Node.js 22 (`.nvmrc`), pnpm 9 (`corepack enable`), Docker.

```bash
cp .env.example .env            # then set ENCRYPTION_KEY and ADMIN_TOKEN (see comments)
pnpm install
docker compose up -d            # Postgres 16 (warden + warden_test) and Redis 7
pnpm db:migrate                 # apply Prisma migrations
pnpm dev                        # web :5173 · api :3001 · worker · Uniswap MCP :3002
```

Open <http://localhost:5173>, enter a name (for example `alice`), and choose **Continue (dev
identity)**. Onboarding then creates your agent's Privy server wallet (needs `PRIVY_APP_ID` /
`PRIVY_APP_SECRET`), lets you pick a risk profile, and waits for a testnet ETH deposit. The
worker detects it within about 15 s (needs the MCP server, `MCP_AUTH_TOKEN`) and opens the
cockpit, where **Live activity** shows **"Funded: … ETH"**.

Generate secrets:

```bash
openssl rand -base64 32   # ENCRYPTION_KEY
openssl rand -hex 32      # ADMIN_TOKEN
```

## Scripts

| Command                | What it does                                                                 |
| ---------------------- | ---------------------------------------------------------------------------- |
| `pnpm dev`             | web + api + worker in parallel (Turborepo)                                   |
| `pnpm lint`            | ESLint (typescript-eslint, react-hooks)                                      |
| `pnpm typecheck`       | `tsc --noEmit` in every package                                              |
| `pnpm test`            | Vitest: shared, api (integration with Postgres/Redis), web                   |
| `pnpm build`           | Build shared, api and web                                                    |
| `pnpm db:migrate`      | `prisma migrate deploy` with the root `.env`                                 |
| `pnpm db:migrate:dev`  | Create a new migration after schema changes                                  |
| `pnpm db:studio`       | Prisma Studio                                                                |
| `pnpm db:seed`         | Connectivity check (creates no user data)                                    |
| `pnpm format`          | Prettier                                                                     |
| `pnpm smoke:mcp`       | LIVE: MCP quotes (testnet + mainnet), new hooks, hook score                  |
| `pnpm smoke:privy`     | LIVE: Privy agent wallet + policy, then a 0 ETH self-transfer (prints hash)  |
| `pnpm check:sources`   | LIVE: health of every market-data source + which one serves each capability  |
| `pnpm smoke:zg`        | LIVE: one call per 0G model (X-Request-ID, trust mode, tee_verified)         |
| `pnpm smoke:zgstorage` | LIVE: upload a decision log to 0G Storage, download it by root hash, compare |

API tests use the separate `warden_test` database and Redis DB 1. Override them with
`TEST_DATABASE_URL` / `TEST_REDIS_URL`.

## Repository layout

```
apps/api                    Fastify API + BullMQ worker + Telegram bot
apps/web                    React 19 + Vite 6 + Tailwind 4 web app (Vercel)
packages/shared             Zod schemas and types shared by api, web and mcp
packages/uniswap-agent-mcp  Uniswap agent MCP server (P02, standalone; see its README)
docs/                       Architecture, demo script, vendor docs
deploy/railway/             Railway service configs
FEEDBACK.md                 Uniswap developer feedback
```

## Identity

Until PHASE 10, sign-in uses a clearly labelled **DEV identity provider** behind the
`IdentityProvider` interface: the same name always signs in as the same human, which models
"one human = one agent". An amber banner, "DEV identity — World ID arrives in Phase 10", is
always visible while it is active. The API **refuses to start** if dev providers are configured
with `NODE_ENV=production`.

## Sponsor integrations

- **0G**: verified/private inference with request IDs on every reply, plus a decision log on
  0G Storage (from PHASE 04 / 07).
- **Uniswap**: our own MCP server in `packages/uniswap-agent-mcp` (from PHASE 02), also published
  as a `uniswap-ai` plugin in our fork: <https://github.com/Ayush-Bansal08/uniswap-ai/tree/feat/uniswap-agent-mcp/packages/plugins/uniswap-agent-mcp>. Developer
  feedback is in [`FEEDBACK.md`](FEEDBACK.md).
- **Privy**: agent wallets are app-controlled server wallets with a per-wallet policy that only
  allows Uniswap contracts, Permit2 and allowlisted tokens. Every Privy call is in
  [`apps/api/src/modules/wallet/privy.ts`](apps/api/src/modules/wallet/privy.ts).
- **World**: World ID Agent Pass for sign-in and step-up approvals (PHASE 10).

## License

[MIT](LICENSE)

## Phase 04 AI layer (0G)

Everything the agent thinks runs on the 0G Router with provenance on every call:

| Role             | Model (env)                    | Trust mode                       | Endpoint                                |
| ---------------- | ------------------------------ | -------------------------------- | --------------------------------------- |
| Planner          | `ZG_MODEL_PLANNER` (GLM-5.3)   | `private`                        | `/v1/chat/completions` + MCP read tools |
| Planner fallback | `ZG_MODEL_PLANNER_FALLBACK`    | `ZG_PLANNER_FALLBACK_TRUST_MODE` | `/v1/chat/completions`                  |
| Guard            | `ZG_MODEL_GUARD` (Vela 2.0)    | `private`                        | `/v1/decisions` (fails closed)          |
| Explainer        | `ZG_MODEL_EXPLAINER` (0GM-1.0) | `private`                        | `/v1/chat/completions`                  |

Each call sends `X-0G-Provider-Trust-Mode`, our own `X-Client-Request-Id` and `verify_tee: true`,
and stores the router's `X-Request-ID` and `x_0g_trace` (provider, `tee_verified`, billing) in an
`Inference` row. The same request ID appears as a "0G" chip in the live activity panel and on
the agent's reply. Code: [`apps/api/src/modules/ai0g/client.ts`](apps/api/src/modules/ai0g/client.ts),
[`agent/planner.ts`](apps/api/src/modules/agent/planner.ts),
[`safety/guard.ts`](apps/api/src/modules/safety/guard.ts),
[`ai0g/explainer.ts`](apps/api/src/modules/ai0g/explainer.ts).

Try it: sign in, type **"Swap $20 ETH to USDC"** in the cockpit's Agent panel (or
`POST /agent/messages { "text": "…" }` with the session token; `GET /agent/messages` for history).
The live panel shows plan → `get_quote` → result → proposed intent; from Phase 05 the intent
continues through the safety pipeline below.

- `pnpm smoke:zg` — one live call per model, printing `X-Request-ID`, trust mode and `tee_verified`.
- `pnpm eval:planner` — 35 live planner cases → [`docs/eval-planner.md`](docs/eval-planner.md)
  (latest: 32/35, 91.4%).
- A key restricted to `private` routing must set `ZG_PLANNER_FALLBACK_TRUST_MODE=private`
  (the router answers `403 trust_mode_mismatch` to `verified` on such keys).

## Phase 05 safety, policy, execution, decision log

Every money-moving intent goes through one deterministic pipeline
([`agent/pipeline.ts`](apps/api/src/modules/agent/pipeline.ts)):

1. **Prepare** ([`agent/preparer.ts`](apps/api/src/modules/agent/preparer.ts)) — intent → our MCP
   build tools (`build_swap`, `build_transfer`, `compare_pools` → `build_lp_position`,
   `build_lp_exit`, `build_rebalance`, `plan_trigger`), USD value at risk from the mainnet
   reference price, profile slippage, `planHash` = sha256 of canonical JSON.
2. **Score** — deterministic trade score 0–100 with a `{rule, penalty, evidence}` breakdown
   ([`safety/tradeScore.ts`](apps/api/src/modules/safety/tradeScore.ts)), `check_token` for every
   token, `score_hook` for hook pools (cached 1 h, [`safety/hookGate.ts`](apps/api/src/modules/safety/hookGate.ts)).
3. **Simulate** — `eth_call` of every built step from the agent wallet
   ([`safety/simulate.ts`](apps/api/src/modules/safety/simulate.ts)); steps after an approval and
   Permit2-signed steps are simulated again right before broadcast.
4. **Guard** — 0G Vela 2.0, **fails closed** ("Safety check unavailable").
5. **Policy** — pure `decide()` → AUTO / STEP_UP / REFUSE / ASK
   ([`policy/engine.ts`](apps/api/src/modules/policy/engine.ts)), reasons carry value + limit.
6. **Approve** — AUTO: preview card with a 3-second countdown and Cancel. STEP_UP: approval card
   bound to user + plan + `planHash` + amount, 5-minute expiry, single use. DEV approval only
   with dev providers (World ID step-up replaces it in Phase 10). REFUSE: red card with reasons.
7. **Execute** ([`execution/executor.ts`](apps/api/src/modules/execution/executor.ts)) — BullMQ,
   one plan at a time per user, approval marked USED in the same transaction, today's spend
   re-checked, **re-quote within 1%** or "Price moved", fresh calldata, Permit2 signed by Privy
   only now, Privy broadcast with idempotency key `${planId}:${step}`, receipt (timeout → check
   by hash, never re-broadcast), lots / LP positions / known recipients updated, receipt card.
8. **Decision log** ([`decisionlog/`](apps/api/src/modules/decisionlog)) — canonical JSON of the
   whole decision (0G request IDs, scores, simulation, guard, policy, approval, tx hashes; no
   personal data, no signatures) uploaded to **0G Storage** with `MemData`; root hash on the card
   and in `GET /decision-logs/:planId`. Refused, denied, expired and failed plans are logged too.

Routes: `GET /plans/:id`, `POST /plans/:id/cancel`, `POST /plans/:id/repreview`,
`GET /approvals/:id`, `POST /approvals/:id/deny`, `POST /approvals/:id/dev-approve` (dev only),
`GET /decision-logs/:planId`. Web: cards in the Agent panel and `/approvals/:id`.

## Phase 06 cockpit

The cockpit is the product: chat with your agent, watch it think on 0G, check itself and act.
Every card shows its proof — trade score with breakdown, simulation, the 0G guard verdict with
its request ID, tx links and the 0G Storage root hash — and **Details** opens the full story
of the action. `/activity` lists everything the agent did and refused (CSV export); `/inbox`
holds pending approvals. Screenshots: [`docs/screenshots/`](docs/screenshots/).

```powershell
pnpm --filter @warden/web test       # card component tests (Vitest + Testing Library)
pnpm --filter @warden/web test:e2e   # Playwright smoke against a stateful mock API
```

## Phase 07 hooks, liquidity, rules

- **`/hooks`: Uniswap v4 hooks, explained.** Real mainnet hooks (and testnet hooks you can trade
  through), each with a deterministic 0–100 score from the v4 Security Framework, permissions in
  plain words ("Can change your swap amount"), change history and a 0G-written explanation with
  its request ID.
- **Liquidity**: "Put $10 into ETH/USDC" picks the pool and a range that fits your risk profile;
  positions show a live range bar, value, fees and P&L, with Rebalance and Exit.
- **Rules**: take-profit, stop-loss, DCA and chained rules. Each fire goes through every safety
  check again; over-limit actions ask you first.

Demo control (admin only; it changes only _when_ rules fire, never trade amounts):

```powershell
curl -X POST http://localhost:3001/admin/price-override -H "x-admin-token: $env:ADMIN_TOKEN" `
  -H "content-type: application/json" -d '{"symbol":"ETH","priceUsd":"2300","ttlSec":180}'
```

## Phase 08 Mode B, inbox, Telegram

The agent now comes to you. Every 60 s the worker checks each funded wallet with nine detectors
(`apps/api/src/modules/modeb/detectors`): dip, profit, idle USDC, better pool, out of range, new
hook, hook changed, big move and the 08:00 morning brief. Anything that moves money runs through the
same pipeline as a chat request. Safe actions under your limits run alone with a receipt; the rest
wait in the inbox and on Telegram with Yes / Change / No, and "Yes" re-quotes before anything runs.

- **Telegram:** set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME`, then Settings → Connect
  Telegram. `pnpm dev` long-polls; production uses `API_URL/telegram/webhook` with
  `TELEGRAM_WEBHOOK_SECRET`. The bot only sends alerts: free text gets one fixed line.
- **Market Event Simulator:** set `ENABLE_DEMO_SIMULATOR=true` on the API and open Inbox → Demo.
  Three scenarios feed simulated market conditions to the 0G planner, which decides; the action
  then runs the normal pipeline on the testnet (Demo) or stops after simulation (Paper).
- **Demo:** `POST /admin/simulate-event` with `{ userId, detector, overrides? }` and
  `POST /admin/run-brief` with `{ userId }`, both with the `x-admin-token` header.
- **Sepolia:** set `UNISWAP_BLOCKED_POOLS` (see `.env.example`) so each trade takes the cleanest
  route.
- **Price drops buy:** `BIG_MOVE` down and `DIP` buy your dip amount, once a day between them, under
  your limits and the "Dip buys" switch. The inbox then reports what was bought or sold, and why.
