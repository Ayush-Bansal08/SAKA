# PHASE 01 Report — Foundation

**Scope:** the monorepo, the full database schema, typed env, API and web shells, DEV identity
behind `IdentityProvider`, the SSE trace bus, the design system, CI and deploy configs. Nothing
from later phases was built (no wallets, Uniswap, 0G, MCP tools, chat, approvals logic, Telegram
or World).

## Acceptance criteria

- [x] **Clean clone runs:** `pnpm i && docker compose up -d && pnpm db:migrate && pnpm dev` starts
      the web app on :5173, the API on :3001 and the worker (heartbeat every 60 s).
- [x] **Sign in as "alice":** the cockpit shell renders, the DEV banner is visible, and the live
      panel shows "Agent online". Verified in a real browser (Edge, headless via playwright-core)
      at 1440×900 and 375×812, with no console errors and no horizontal scroll at 375 px.
- [x] **Same human, same user:** signing in twice as "alice" returns the same user (case and
      whitespace are normalised); "bob" creates a different user. Covered by tests and checked
      by hand against the dev server.
- [x] **Production guard:** `NODE_ENV=production AUTH_MODE=dev` makes the API refuse to start
      with a clear message, exit code 1. Tested through a real process spawn, the compiled
      `dist/` and the Docker image.
- [x] **Tests:** all green locally (62 tests). CI workflow added (`.github/workflows/ci.yml`) with
      Postgres and Redis services. It has not run on GitHub yet because nothing is pushed.
- [x] `PHASE_REPORT_01.md` written.

## What was built

### Monorepo

- pnpm workspaces (`apps/api`, `apps/web`, `packages/shared`, `packages/uniswap-agent-mcp` as a
  placeholder) and Turborepo tasks `build`, `dev`, `dev:worker`, `lint`, `typecheck`, `test`.
- Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `format`, `format:check`,
  `db:migrate`, `db:migrate:dev`, `db:studio`, `db:seed`.
- `docker-compose.yml`: Postgres 16 and Redis 7 with health checks and volumes. An init script
  creates the `warden_test` database.
- `.nvmrc` (22), `engines.node >=22`, MIT `LICENSE`, `.gitignore`, `.dockerignore`, Prettier,
  and ESLint flat config (typescript-eslint, react-hooks, react-refresh).
- All dependency versions are pinned exactly.

### `packages/shared`

- `policy.ts`: the PHASE_00 §9 tables as frozen constants (risk profiles, trade score penalties,
  hook bands, policy outcomes incl. `ASK`, reason codes, approval TTL, re-quote drift).
- `chains.ts`: the `ChainId` union (1, 11155111, 84532, 1301) with metadata and explorer helpers.
- `trace.ts`: a `TraceEvent` discriminated union on `kind` (14 kinds), plus `zg` provenance
  (requestId, clientRequestId, model, trustMode, teeVerified, provider).
- `cards.ts`: Preview, Approval, Refusal, Receipt, Info and Suggestion cards.
- `intent.ts`: the `ActionIntent` union (10 types), each with a required `reason`. Amounts are
  decimal strings. Includes trigger rule specs (TP/SL/DCA/CHAINED/PRICE_ALERT).
- `money.ts`: `toRaw` (bigint, refuses silent rounding), `fromRaw`, `usd` (decimal.js, half-up
  to cents for display only) and `sumUsd`.
- `api.ts`: the HTTP contract shared by api and web (providers, user view, sign-in, health,
  error body).

### Database

`apps/api/prisma/schema.prisma` holds the full model set for every phase, with enums, indexes on
foreign keys and `(userId, createdAt)`. The initial migration is
`prisma/migrations/20261105193911_init`. The seed only checks connectivity and creates no user
data.

### `apps/api`

- `config/env.ts`: Zod env schema (core, modes and admin groups). It fails fast and lists every
  problem, putting mode and safety problems first.
- Startup guard: production with dev auth, dev approvals or `ALLOW_DEV_PROVIDERS=true` refuses to
  boot. World modes are refused until PHASE 10, so no provider-less mode can run.
- `buildApp()` factory: CORS (exactly `WEB_URL`), rate limiting (300/min global, 20/min on
  sign-in, Redis-backed outside tests), request IDs (`x-request-id`), pino with one redaction list,
  the Zod type provider, and a central `AppError` handler that maps to
  `{ error: { code, message, details?, requestId } }`.
- Auth: the `IdentityProvider` interface plus `DevIdentityProvider`, which cannot be constructed
  in production. Sessions are opaque 32-byte bearer tokens stored as sha256, and `requireUser`
  rejects expired or revoked sessions. The `ApprovalProvider` interface is defined (PHASE_00 §7).
- Routes: `GET /health`, `GET /auth/providers` (identity, approvals, appName, executionChainId),
  `POST /auth/dev/sign-in` (registered only when dev providers are allowed), `POST /auth/sign-out`,
  `GET /me`, and `GET /stream` (SSE).
- Trace bus: persists to `TraceEventRow` and publishes to Redis `trace:<userId>`. SSE subscribes,
  then replays the last 50 events, then flushes the live buffer, de-duplicated by id. It sends a
  heartbeat every 15 s and emits "Agent online" when Redis presence shows the user was away.
  Streams end on shutdown.
- Worker: BullMQ `system` queue with a `heartbeat` job scheduler (60 s) that checks the DB and
  Redis. Graceful shutdown for both the server and the worker.
- `lib/crypto.ts`: AES-256-GCM with AAD for secrets at rest (ready for `IdentityAttempt` in P10).

### `apps/web`

- Vite 6, React 19, TypeScript, Tailwind 4 and shadcn/ui (new-york, neutral base, dark default,
  `components.json`). Also TanStack Query 5, React Router 7, sonner and lucide.
- Design system: semantic tokens (`agent`, `human`, `safe`, `caution`, `danger`, `info`, `zg`),
  12 px radius, Inter and JetBrains Mono self-hosted, and focus rings and reduced-motion support.
- ui-kit components: Badge variants (Safe/Caution/Danger/0G Verified/Agent/Human), Stat,
  AddressChip, HashChip, Panel, EmptyState, ErrorState, SkeletonRows, Banner, CopyButton.
- Layout: a top bar (logo, chain badge such as "Ethereum Sepolia · testnet", user menu), a left nav,
  and bottom tabs on mobile. The cockpit has three columns (Portfolio | Agent | Live activity)
  that stack on mobile.
- Auth flow: reads `/auth/providers`, shows the dev sign-in card with the amber banner, stores
  the token in memory and in `localStorage` (`warden.session`) with cross-tab sync, attaches it
  as Bearer, and treats a 401 as signed out.
- Live activity panel (final quality): a single shared `fetch-event-source` connection with
  exponential backoff and jitter, and a status pill (Live / Connecting / Reconnecting / Offline).
  The timeline shows an icon per kind, relative time, detail, expandable JSON and a 0G request ID
  chip.
- Routes `/`, `/hooks`, `/inbox`, `/activity`, `/settings`, plus a 404, each with a polished empty
  state. Settings shows real account data and the three risk profiles.
- `vercel.json` with the SPA rewrite, security headers and immutable asset caching.

### Deploy configs (not deployed)

- `apps/api/Dockerfile`: a multi-stage image built with `pnpm deploy` that runs any process via
  `node dist/main.js` with `PROCESS_TYPE=server|worker|bot`. The image was built and
  smoke-tested locally.
- `deploy/railway/api.json` (pre-deploy `prisma migrate deploy`, health check `/health`) and
  `worker.json`, with a README covering the Postgres and Redis plugins and variables. The `mcp`
  and `bot` configs are added in PHASE 02 and PHASE 08, when those processes exist.

## How it was verified

| Check               | Result                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`         | 0 errors, 0 warnings                                                                                                |
| `pnpm typecheck`    | pass (shared, api, web)                                                                                             |
| `pnpm test`         | **62 passed**: shared 20, api 33 (Postgres + Redis integration), web 9                                              |
| `pnpm build`        | shared + api (`tsc`) + web (Vite) built                                                                             |
| `pnpm format:check` | clean                                                                                                               |
| Live dev stack      | `/health` ok. Sign-in as alice twice gives the same id; bob gets a new id. `/stream` delivered "Agent online"       |
| Browser             | sign-in and cockpit screenshots at desktop and mobile widths, DEV banner present, 0 console errors                  |
| Docker              | image builds. Server and worker entries refuse dev auth in production. `@warden/shared` dist and Prisma are present |

The API tests cover env validation and the production guard (unit tests plus a spawned
process), dev sign-in (one user per human, concurrency-safe, default limits, only the token hash
stored), `/me` auth (missing, unknown and expired tokens), sign-out revocation, CORS, 404 shape,
health, AES-GCM tamper and AAD checks, and SSE (auth required, "Agent online", live delivery
with 0G provenance and bigint-safe data, replay on reconnect without re-announcing, no
cross-user leaks).

## Exact commands

```bash
# one-time
cp .env.example .env     # set ENCRYPTION_KEY (openssl rand -base64 32) and ADMIN_TOKEN (openssl rand -hex 32)
pnpm install
docker compose up -d
pnpm db:migrate

# run
pnpm dev                 # web http://localhost:5173 · api http://localhost:3001 · worker

# checks
pnpm lint && pnpm typecheck && pnpm test
pnpm build

# container (optional)
docker build -f apps/api/Dockerfile -t warden-api .
```

## Known limitations and notes

- **World modes are refused until PHASE 10.** So there is no bootable production configuration
  yet. This is intentional: production forbids dev providers, and World is not implemented.
- **Execution chain is Ethereum Sepolia (`11155111`)**, which is now the default and is set in the
  local `.env`. Base Sepolia was dropped because the Uniswap Trading API returned
  `UpstreamTimeoutError` for every quote. On Ethereum Sepolia, exact-in and exact-out quotes,
  both directions, sizes up to 0.1 ETH, V4-only routing, `/check_approval`, `/swap` and
  `/lp/pool_info` (V3 and V4) were all verified. Selling USDC for ETH shows 1.5–2.7% price impact
  (thin v4 pools); that is under the 5% refuse limit but will lower the trade score.
  See `FEEDBACK.md`.
- The local `.env` defines `ENCRYPTION_KEY`, `ADMIN_TOKEN` and `MAINNET_RPC_URL` twice. dotenv
  uses the last value, which is valid for `ENCRYPTION_KEY`. Remove the duplicates to avoid
  surprises.
- `TraceEvent` kinds share one envelope today. Later phases can narrow `data` per kind without
  changing the wire format.
- Pre-existing database volumes: the `warden_test` database is created by the Postgres init script
  only on a fresh volume. With an older volume, run
  `docker compose exec postgres createdb -U postgres warden_test`.
- The phase files are not in the repo (`phases/` does not exist). This phase was implemented
  from the copies provided in the conversation.
- The web vendor chunk is about 498 kB minified (158 kB gzip). Route-level code splitting can come
  later when the pages carry real weight.
