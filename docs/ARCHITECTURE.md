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
   ├─ modules/mcp          UniswapMcpClient: streamable HTTP + bearer, shared-schema    [P02]
   │                       validation, tool_call/tool_result trace events
   ├─ modules/wallet       Privy adapter (the only Privy caller), agent wallet service  [P03]
   ├─ modules/users        + onboarding state machine, settings (changes → STEP_UP)     [P03]
   ├─ modules/portfolio    balances (MCP get_portfolio), prices (MCP get_quote mainnet), [P03]
   │                       FIFO P&L, deterministic risk meter, daily limit usage
   └─ … agent, ai0g, safety, policy, execution, decisionlog, triggers, modeb …        [P04+]
apps/api worker entry       BullMQ: system heartbeat [P01] · balance watcher, 15 s [P03]
packages/shared             Zod schemas + types shared by api / web / mcp                [P01]
packages/uniswap-agent-mcp  Uniswap MCP server: 16 tools, unsigned-only, :3002/mcp      [P02]
Postgres 16 + Redis 7       docker compose locally; Railway plugins in deploy
```

## Packages

| Package                      | Purpose                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`            | `policy.ts` (risk profiles, score + policy constants), `chains.ts`, `trace.ts`, `cards.ts`, `intent.ts`, `money.ts`, `api.ts` (HTTP contract) |
| `apps/api`                   | HTTP server (`src/server.ts`), worker (`src/worker.ts`), container entry (`src/main.ts`)                                                      |
| `apps/web`                   | React 19 + Vite 6 SPA: design system, shell, auth flow, live activity                                                                         |
| `packages/uniswap-agent-mcp` | Standalone MCP server (HTTP + stdio): 16 Uniswap tools, unsigned transactions only. See its README and PLUGIN.md                              |

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

## Uniswap agent MCP server (PHASE 02)

`packages/uniswap-agent-mcp` is a standalone, open-source MCP server (it does not depend on any
Warden package, so it can be copied into a fork of `Uniswap/uniswap-ai`).

```
apps/api ──callTool──▶ UniswapMcpClient ──POST /mcp (Bearer MCP_AUTH_TOKEN)──▶ uniswap-agent-mcp :3002
   ▲  validates output with @warden/shared UniswapMcp.*        │  tools/<name>.ts (Zod in/out)
   └─ TraceBus: "Uniswap · get_quote" (tool_call/tool_result)  ├─ Trading API  /check_approval /quote /swap
                                                               ├─ LP API       /lp/check_approval /create /decrease /claim_fees /pool_info
                                                               ├─ viem RPC     V4Quoter, StateView, PositionManager, PoolManager logs
                                                               ├─ v4 subgraph  (mainnet market data)
                                                               └─ Etherscan v2 (optional, verified source)
```

- **Unsigned only.** Build tools return `READY` (ordered `TxStep`s) or `NEEDS_SIGNATURE`
  (approval preSteps, EIP-712 typed data and an HMAC `resumeToken` valid for 120 s). The backend
  signs with its own wallet layer (later phases) after its safety and policy checks, then calls the
  same tool again with `resumeToken` + `signature`.
- **One schema file, mirrored.** `packages/uniswap-agent-mcp/src/schemas.ts` (zod only) is copied
  byte-for-byte to `packages/shared/src/uniswap-mcp.ts` (`UniswapMcp` namespace). A shared test
  fails on drift (`pnpm --filter uniswap-agent-mcp sync:shared`).
- **Addresses** come only from the vendored docs (`src/chains.ts`). A missing one (for example
  Sepolia WETH) fails with `NOT_CONFIGURED`.
- **USD values** come from mainnet reference quotes (1 token → USDC, cached 30 s).
- **Market data failover** (`src/market/`). Each capability has an ordered chain of independent
  sources:
  - pools / TVL / APR: official subgraph → pool registry + LP API reserves + GeckoTerminal volume
    → GeckoTerminal
  - price history: official subgraph → StateView at historical blocks → GeckoTerminal
  - hooks: official subgraph → pool registry → PoolManager logs

  The official subgraph is skipped while `hasIndexingErrors` is true, and failed sources cool
  down for 60 s. Outputs name the source used. `pnpm check:sources` diagnoses live.

- **API wiring:** `app.deps.mcp` is created when `MCP_AUTH_TOKEN` is set and connects lazily. It
  reconnects once on transport failure and maps tool errors to `McpToolCallError { code, retryable }`.
- **Processes:** `pnpm dev` runs the server on :3002 (`node --watch --import tsx`). In production it is its own
  image (`packages/uniswap-agent-mcp/Dockerfile`, `deploy/railway/mcp.json`).

## Agent wallet, onboarding and portfolio (PHASE 03)

**Privy adapter** (`apps/api/src/modules/wallet/privy.ts`) — the only file that imports
`@privy-io/node` (v0.36.0; method names checked against its TypeScript types). It exposes
`createAgentWallet`, `attachPolicy`, `sendTransaction`, `signTypedData` and `getAddress`, and maps
every failure to `AppError('WALLET_PROVIDER_ERROR')` (503 when retryable, 502 otherwise). SDK calls
sit behind a small `PrivyBackend` seam so tests use an in-memory fake.

- **Wallets** are app-controlled server wallets (no owner). Creation is idempotent at both ends:
  Privy `external_id = warden_<userId>` (looked up first, plus an idempotency key), and
  `AgentWallet.userId` is unique in Postgres. Concurrent creates (two tabs) converge: a Privy 409
  or "idempotency key still in progress" waits and re-reads the winner.
- **Policy** — one per wallet, named by a hash of its rules (so it is found again, never
  duplicated). It ALLOWs only: `eth_sendTransaction` to Universal Router, Permit2, v4
  PositionManager and allowlisted tokens on `EXECUTION_CHAIN_ID`; a zero-value self-transaction
  (liveness probe / stuck-nonce cancel); `eth_signTypedData_v4` for the Permit2 / PositionManager
  domains. Anything else is denied by Privy. If the policy API is unavailable, the adapter logs a
  warning and stores `policyId = null`; the backend policy engine remains the primary guard.
- **Addresses** come from `EXECUTION_CONTRACTS` in `@warden/shared`, a mirror of the MCP
  server's vendor-doc `chains.ts`; `apps/api/test/portfolio-math.test.ts` fails on any drift.
- `PRIVY_AUTHORIZATION_PRIVATE_KEY` is passed as `authorization_context` only when set.

**Onboarding state machine** on `User.onboardingStep`, all transitions compare-and-set:

```
VERIFY ─sign-in─▶ WALLET ─POST /onboarding/wallet─▶ PROFILE ─POST /onboarding/profile─▶ FUND
FUND ─balance watcher: first native deposit─▶ DONE
```

The profile may be re-picked during PROFILE/FUND; after DONE every change is `409
STEP_UP_REQUIRED` (as are `PUT /settings/risk-profile`, `PUT /settings/limits`,
`POST /wallet/withdraw`) until approvals (P05) and World ID (P10) exist.

**Balance watcher** (worker, BullMQ `wallet` queue, every `BALANCE_POLL_MS`): per wallet, reads
balances with MCP `get_portfolio`, compares with the Redis snapshot `balances:snapshot:<userId>`,
and records increases as `TokenLot(source=DEPOSIT, cost = amount × mainnet reference price)`
plus a `receipt` trace event. Increases within 2 min of one of our own `Execution` rows are
treated as explained. Per-user Redis lock; lots are written before the snapshot (a crash
re-detects rather than loses). Users with no API activity for 24 h (`activity:<userId>` key set
by `requireUser`) are polled every `BALANCE_POLL_INACTIVE_MS`.

**Portfolio** (`GET /portfolio`): balances (MCP `get_portfolio`, 10 s shared Redis cache) ×
reference prices (MCP `get_quote` on mainnet, 1 token → USDC, cached 30 s in `PriceCache`),
FIFO P&L over `TokenLot` (an unexplained balance shortfall such as gas is consumed FIFO at zero
proceeds; untracked excess is left out of P&L), the risk meter, and today's AUTO spend in the
user's time zone. The risk meter (`modules/portfolio/risk.ts`) is deterministic: concentration
0.30, stablecoin buffer 0.20, LP out of range 0.15, hook exposure 0.15, drawdown vs 7-day high
0.20 (MCP `get_price_history`, best-effort within 3 s; weights re-normalise without it); any
Danger-hook exposure floors the score at High. Background MCP reads pass `quiet: true` so they
never appear in the user's live activity.

**Web**: `AuthGate` shows a full-screen `OnboardingWizard` until the step is DONE (verified
human → animated wallet creation → profile cards → fund with QR, copy and faucets, polling every
4 s plus the live trace stream). The cockpit's Portfolio column and the Settings page read
`/portfolio` (every 15 s and on `receipt`/`tx` events) and `/settings`.

## Execution chain (decided 2026-11-06)

**Ethereum Sepolia, chain ID `11155111`** (`EXECUTION_CHAIN_ID`, the default).

| Token / contract                | Address                                      |
| ------------------------------- | -------------------------------------------- |
| Native ETH (Uniswap API)        | `0x0000000000000000000000000000000000000000` |
| USDC (Circle, 6 decimals)       | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| WETH (for v3 pools)             | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` |
| Universal Router (from `/swap`) | `0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3` |

Results of `pnpm smoke:uniswap` on each candidate chain. A check passes only if it succeeds with
price impact ≤ 5%, the policy's refuse limit.

| Chain                       | Checks passed | Notes                                                                                              |
| --------------------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| Ethereum Sepolia (11155111) | **12/12**     | ETH→USDC 0.02–0.2% impact up to 0.1 ETH; USDC→ETH 1.6–2.3% (thin v4 pools); V3 + V4 LP pools exist |
| Unichain Sepolia (1301)     | 9/12          | 0.1 ETH→USDC 5.7% and 100 USDC→ETH 6.4% impact (would be refused); no V4-only route                |
| Base Sepolia (84532)        | 4/11          | every `/quote` returns `UpstreamTimeoutError`; only approvals and pool info work                   |

Testnet prices are 10–15× off mainnet (0.001 ETH ≈ 26 USDC on Sepolia vs 2.25 on mainnet), so USD
values always come from mainnet reference prices.

## Deploy

- Web: Vercel (`apps/web/vercel.json`, SPA rewrite, `VITE_API_URL`).
- Backend: one Docker image (`apps/api/Dockerfile`) for all processes, with Railway services in
  `deploy/railway/` (see its README).

## Phase 04 AI layer

Pipeline steps 1–2 (input → plan) plus the guard (step 6) and explainer used by later phases.
Nothing in this phase builds, signs or executes a transaction.

**0G client** — `modules/ai0g/client.ts`. One adapter for every inference: the `openai` SDK
pointed at `ZG_BASE_URL`, headers `X-0G-Provider-Trust-Mode` and `X-Client-Request-Id`, body
`verify_tee: true` (+ `reasoning_effort` from `ZG_REASONING_EFFORT`). It reads `X-Request-ID`
(the router may send `edge-id, request-id`; the body `x_0g_trace.request_id` must be one of
them) and `x_0g_trace` — from the body, or when streaming from the final `choices: []` chunk
before `[DONE]`. Each HTTP attempt is one `Inference` row (model, trust mode, request IDs,
provider, `teeVerified`, latency, tokens, cost, ok/error) and one trace event with the 0G chip.
429/503 retry twice honouring `Retry-After` inside one deadline (`ZG_PLANNER_TIMEOUT_MS` for the
planner, `ZG_REQUEST_TIMEOUT_MS` for guard/explainer). A failed or timed-out private planner
call falls back to `ZG_MODEL_PLANNER_FALLBACK` at `ZG_PLANNER_FALLBACK_TRUST_MODE` (`verified`
by default; keys limited to `private` set `private`), recorded as a separate row with
`trace.fallbackOf`. A prompt containing any configured key, secret, token or private-key
material is refused before it is sent.

**Planner** — `modules/agent/planner.ts`, prompt `prompts/planner.v1.md` (loaded at boot),
context from `modules/agent/context.ts` (risk profile, limits and today's remaining limit,
compact portfolio, mainnet reference prices, known recipients, active triggers, allowlist,
pending intent). Tools = the ten MCP read tools + `plan_trigger` + local `propose`/`answer`;
build tools are never offered or dispatched. Loop: ≤ 5 read rounds (then only the terminal
functions are offered); each MCP call goes through `mcp.callTool` (tool_call/tool_result
events) with account defaults filled in (`chainId`, `swapper`). `propose` is Zod-validated and
every address in it must appear in the context, the user's words or a tool result (no
invented addresses); one repair round with the error, then a friendly failure.

**Agent entry** — `modules/agent/routes.ts`. `POST /agent/messages` (10/min/user, one plan at a
time per user) stores the USER message + `AgentRequest`, returns 202 and plans async; the reply
is an AGENT message with an info card or a provisional `IntentCard` (`Planned: … — preparing…`,
turned into Preview/Refusal/Approval in P05). `GET /agent/messages?cursor` pages history
(`AgentMessagesResponseSchema`). The cockpit centre column is the chat (`apps/web/src/features/agent`).

**Guard** — `modules/safety/guard.ts`. Vela via `POST /v1/decisions`: a deterministic text state
(≤ 1800 chars, lists truncated) and three questions — `verdict` (choice approve/block), `risk`
(score 0–1), `concerns` (choice over the fixed labels). Block if verdict=block or pApprove < 0.8;
the reason comes from the explainer (a template when approved with no concern). **Fails
closed**: any error, timeout or unrecognised answer shape → block with `unavailable: true` and
"Safety check unavailable — nothing was executed." The vendored OpenAPI types the response as an
open object, so `parseDecision` accepts the plausible shapes only (`// VERIFY:`).

**Explainer** — `modules/ai0g/explainer.ts`: `explainRefusal`, `explainHook`, `explainSuggestion`,
`morningBrief`, `explainPoolPick`, `guardReason`, each with its own prompt file, token cap and
output check, and a deterministic template fallback (it never blocks the UX). The build copies
prompt files next to the emitted JavaScript (`scripts/copy-ai-prompts.mjs`).

Known operational limit: planning runs in the API process; an abrupt process death can leave
an unfinished request (and its Redis lock until expiry, 10 min).

## Phase 05 safety, policy, approvals, execution, decision log

Pipeline steps 3–9. Code under `apps/api/src/modules/{agent,safety,policy,approvals,execution,decisionlog}`.

```
intent ─► preparer ─► hook gate + check_token ─► trade score ─► simulate ─► 0G guard ─► policy
            │ (MCP build tools, planHash)                                  (fail closed)   │
            ▼                                                                               ▼
     ActionPlan.steps = { call, steps, signature?, summary, safety }      AUTO   → QUEUED, 3 s countdown
                                                                            STEP_UP→ Approval PENDING (5 min)
                                                                            REFUSE → refusal card + 0G log
                                                                            ASK    → suggestion (Mode B)
execute job (worker, lock:exec:<userId>):
  reserve (approval USED + plan EXECUTING in one tx | AUTO spend re-check)
  → get_quote (≤ 1% worse, else "Price moved") → rebuild same call → [preSteps → Privy signTypedData
  → build again with resumeToken+signature] → per tx: eth_call → Privy send (idempotencyKey
  planId:step) → receipt (timeout → by hash) → post-process → EXECUTED → receipt card → decisionlog.upload
```

**Preparer** (`agent/preparer.ts`) — deterministic intent → tool mapping; the exact build-tool
arguments are stored so execution rebuilds fresh calldata (Universal Router deadlines, 120 s
resume tokens) from the approved facts. `planHash` = sha256(canonical JSON of intent, chain,
tool, token addresses, raw amounts, recipient, pool, LP position). The rebuilt result must match
the approved tokens, recipient and exact-side amount, and stay within 1% on the quoted side.

**Safety** — `safety/tradeScore.ts` (PHASE_00 §9 formula, breakdown + REFUSE facts),
`safety/hookGate.ts` (`score_hook`, `Hook` table cache 1 h; unscorable → Danger),
`safety/simulate.ts` (viem `eth_call` via `execution/chain.ts`; steps after an approval are
`deferred`; no RPC → unavailable → refused), `safety/guard.ts` (Phase 04).

**Policy** (`policy/engine.ts`) — a pure function; first match wins (REFUSE → always-STEP_UP →
limits → quality → ASK → AUTO). A send to any address other than the agent wallet is a
withdrawal. Unpriceable value → `VALUE_UNKNOWN` step-up.

**Approvals** (`approvals/`) — `ApprovalsService.resolve` is the only exit from PENDING (atomic
`updateMany where status=PENDING`); APPROVED requires evidence for the account owner (else
REJECTED) and an unexpired approval (else EXPIRED); it enqueues execution. Expiry sweeper every
15 s on the system queue. `DevApprovalProvider` exists only when dev providers are allowed; the
deny route is provider-independent. Cards are patched in place (`agent/card-store.ts`).

**Execution** (`execution/executor.ts`, `jobs.ts`, `chain.ts`) — BullMQ queue `execute`, job id
`exec-<planId>`, concurrency 4 across users with a Redis lock per user (busy → retry in 2 s).
Execution rows are written before broadcast; a retried job settles `BROADCAST` rows by hash and
never sends a step twice. PERMIT_SIGN rows record that the agent wallet signed (never the
signature). Post-processing: FIFO `TokenLot` consumption + a new SWAP lot (actual ERC-20 amount
from logs), `LpPosition` from the PositionManager mint log, exits close positions, approved first
sends add a `KnownRecipient`. Retries exhausted → plan FAILED with a card.

**Decision log** (`decisionlog/`) — canonical JSON (keys sorted; user = sha256(iss+sub); no
signatures, calldata or personal data) → `DecisionLog` row (payloadHash) → 0G Storage `MemData`
upload via the turbo indexer (root checked against the local merkle root) → `zgRootHash`,
`zgTxHash`, trace "Logged to 0G Storage", card patched. Queue `decisionlog`, 5 attempts,
exponential backoff; without `ZG_STORAGE_PRIVATE_KEY` records stay PENDING.
