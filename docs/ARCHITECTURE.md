# Warden — Architecture

> The source of truth for scope and rules is `PHASE_00_CONTEXT.md`. This document describes what
> is **built so far** and how the pieces fit. Each phase updates it.

## System overview

```
Browser (React, Vercel)                     Telegram (P08)
   │  REST + SSE (Bearer session token)
   ▼
apps/api  (Fastify 5, Node 22)
   ├─ config/env           Zod-validated env, production guard for dev providers      [P01]
   ├─ modules/auth         IdentityProvider (Dev now → World in P10), sessions          [P01]
   ├─ modules/users        one human = one agent (unique iss+sub), /me                  [P01]
   ├─ modules/trace        TraceBus: Postgres persistence + Redis pub/sub → SSE /stream [P01]
   ├─ modules/approvals    ApprovalProvider interface (workflow in a later phase)        [P01]
   ├─ modules/health       /health (db + redis)                                          [P01]
   └─ … agent, ai0g, mcp, safety, policy, execution, decisionlog, triggers, modeb …   [P02+]
apps/api worker entry       BullMQ: system heartbeat (Mode B detectors from P07)        [P01]
packages/shared             Zod schemas + types shared by api / web / mcp                [P01]
packages/uniswap-agent-mcp  Uniswap MCP server                                           [P02]
Postgres 16 + Redis 7       docker compose locally; Railway plugins in deploy
```

## Packages

| Package                      | Purpose                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`            | `policy.ts` (risk profiles, score + policy constants), `chains.ts`, `trace.ts`, `cards.ts`, `intent.ts`, `money.ts`, `api.ts` (HTTP contract) |
| `apps/api`                   | HTTP server (`src/server.ts`), worker (`src/worker.ts`), container entry (`src/main.ts`)                                                      |
| `apps/web`                   | React 19 + Vite 6 SPA: design system, shell, auth flow, live activity                                                                         |
| `packages/uniswap-agent-mcp` | Placeholder until PHASE 02                                                                                                                    |

Workspace sources are consumed directly in development and tests: `@warden/shared` exports a
custom `@warden/source` condition (TypeScript `customConditions`, `tsx --conditions`) and Vite
aliases it to `src/`. Production builds compile `shared` to `dist/` first (Turborepo `^build`).

## Identity and sessions

- `IdentityProvider` (`apps/api/src/modules/auth/identity-provider.ts`) has `startSignIn` and
  `completeSignIn`, and returns a verified `{ iss, sub, authTime, acr?, amr? }`.
- `DevIdentityProvider`: `sub = sha256("warden-dev:" + normalised name)`, so the same name is always
  the same human. Its constructor throws unless `ALLOW_DEV_PROVIDERS=true` and
  `NODE_ENV !== 'production'`. Its route, `POST /auth/dev/sign-in`, is only registered when dev
  providers are allowed.
- **Startup guard:** `loadEnv()` refuses `AUTH_MODE=dev`, `APPROVAL_MODE=dev` or
  `ALLOW_DEV_PROVIDERS=true` when `NODE_ENV=production`, and lists every problem. `world` modes
  are refused until PHASE 10 implements them.
- **Users:** `(identityIss, identitySub)` is unique. This is what enforces "one human = one agent".
  First sign-in creates the user with default BALANCED `Limits`, and concurrent first sign-ins are
  race-safe (P2002 retry).
- **Sessions:** an opaque 32-byte base64url token goes to the browser and only its sha256 is stored.
  Auth is `Authorization: Bearer`, with no cookies, which works cross-origin from Vercel to the API.
  Expired or revoked sessions return 401.

## Trace bus and SSE

1. `traceBus.emit(input)` validates against `TraceEventSchema`, makes `data` JSON-safe (bigint
   becomes a string), persists a `TraceEventRow`, and publishes on Redis `trace:<userId>`.
2. `GET /stream` (Bearer auth) **subscribes first**, then replays the last 50 events, then flushes
   any events buffered during the replay, de-duplicated by event id. Nothing emitted mid-replay is
   lost or doubled.
3. A heartbeat comment goes out every 15 s. On `preClose`, all streams are ended so shutdown never
   hangs.
4. Presence is tracked with a Redis key `presence:agent:<userId>` (TTL 10 min, refreshed by the
   heartbeat). When a user connects with no live presence, the API emits the system event
   **"Agent online"**.
5. The web holds **one** connection per tab (`TraceStreamProvider` at shell level), using
   `@microsoft/fetch-event-source` with exponential backoff and jitter (1 s → 30 s). A 401 on the
   stream signs the user out.

## Web app

- Design tokens live in `apps/web/src/index.css`, as CSS variables exposed to Tailwind 4 via
  `@theme`. The surfaces are dark slate. Semantic colours: `agent`, `human`, `safe`, `caution`,
  `danger`, `info`, `zg`. Fonts are Inter and JetBrains Mono (self-hosted).
- shadcn-style primitives are in `src/components/ui/`, and product components (Badge variants,
  Stat, AddressChip, HashChip, Panel, EmptyState, ErrorState, SkeletonRows, Banner) are in
  `src/components/ui-kit/`.
- Shell: a top bar (logo, execution-chain badge, user menu), a left nav (bottom tabs below `md`),
  and the main area. The cockpit uses a 3-column grid (Portfolio | Agent | Live activity) that
  stacks on mobile.
- `AuthGate` decides between splash, API error, sign-in and shell. The amber DEV banner is shown
  whenever dev identity or approvals are active.

## Errors, logging, security

- `AppError(code, httpStatus, userMessage, details)` maps to `{ error: { code, message, details?, requestId } }`.
  Zod validation, rate-limit, 404 and Fastify client errors are mapped too. 5xx responses never
  leak internals.
- Every response carries `x-request-id`. If the client sends a well-formed one, it is reused.
- pino has a single redaction list in `apps/api/src/lib/logger.ts`.
- CORS is restricted to exactly `WEB_URL`. The global rate limit is 300/min and sign-in is
  20/min per IP (Redis-backed outside tests).
- Secrets at rest (PKCE verifiers and device codes from P10) use AES-256-GCM with
  context-bound AAD (`apps/api/src/lib/crypto.ts`).

## Data model

`apps/api/prisma/schema.prisma` already defines the full schema for every phase:
`User`, `Session`, `IdentityAttempt`, `AgentWallet`, `Limits`, `KnownRecipient`, `ChatMessage`,
`AgentRequest`, `Inference`, `ActionPlan`, `Approval`, `Execution`, `DecisionLog`, `LpPosition`,
`TokenLot`, `Trigger`, `Suggestion`, `Hook`, `HookPool`, `PriceCache`, `TraceEventRow`.
USD amounts are `Decimal`. Raw uint256 token amounts are decimal strings.

## Deploy

- Web: Vercel (`apps/web/vercel.json`, SPA rewrite, `VITE_API_URL`).
- Backend: one Docker image (`apps/api/Dockerfile`) for all processes, with Railway services in
  `deploy/railway/` (see its README).
