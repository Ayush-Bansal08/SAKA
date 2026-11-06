# Phase 05 — Prepare, safety, simulation, policy, approvals, execution, 0G Storage log

Status: **built and verified in code; live end-to-end verified up to the 0G guard.**
Every Phase 05 section is implemented and covered by tests. The full pipeline was run live on
Ethereum Sepolia (planner → prepare → score → simulate → guard → policy → 0G Storage log). One
external outage blocks the live AUTO execution: 0G's Vela 2.0 decision model is down (every
`decisions` provider reports `is_healthy: false`), so the guard fails closed and refuses every
action, as specified. The agent wallet used live also holds only 0.001 ETH.

## Acceptance criteria

| Criterion                                                                      | Result                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live: "Swap $5 ETH to USDC" → preview → auto-executes → receipt → 0G root hash | **Blocked by the 0G Vela outage (external).** Live run of "Swap $2 ETH to USDC": prepared, price impact 0% (see below), trade score 75, simulation passed, guard unavailable → REFUSED, decision log **uploaded to 0G Storage** (root `0xb36a90a71bffb7c18d2fe6b57f502cf6e8dfcbe0e68ecf40b3c24262a74baa29`). The execution path is covered by the integration test with a mocked chain. |
| "$60" → approval → Deny → nothing traded; ask again → dev approve → executes   | **Done (integration test)** — `test/execution.test.ts`: DENIED, no Execution rows; then APPROVED → USED → executed.                                                                                                                                                                                                                                                                     |
| Off-allowlist token with no liquidity → REFUSED with reasons                   | **Done** (integration test + trade-score table tests).                                                                                                                                                                                                                                                                                                                                  |
| Guard fails → refused ("Safety check unavailable")                             | **Done, live and tested.** Live 502s from Vela → `GUARD_UNAVAILABLE`, nothing executed, refusal logged to 0G Storage.                                                                                                                                                                                                                                                                   |
| Re-quote > 1% worse → abort with re-preview offer                              | **Done** (integration test: `price_moved` card, `POST /plans/:id/repreview`).                                                                                                                                                                                                                                                                                                           |
| `PHASE_REPORT_05.md`                                                           | This file.                                                                                                                                                                                                                                                                                                                                                                              |

## What was checked in this pass

- Code review of every §1–§7 item against the phase file: preparer (all intents), trade score,
  hook gate (1 h cache), simulation (approval-dependent steps deferred and re-simulated before
  broadcast), policy engine, approvals (atomic single transition, wrong-human → REJECTED, 15 s
  expiry sweeper), execution (per-user Redis lock, reserve + USED in one transaction, re-quote,
  Permit2 signed only after approval, idempotency keys, never re-broadcast), post-processing
  (lots, LP tokenId, known recipients), decision log (canonical JSON, 5 retries), routes
  (`/plans/:id`, cancel, repreview, `/approvals/*`, `/decision-logs/:planId`) and web cards.
- `.env` audit: every required variable set; unset ones have working defaults. Chain ID and RPC
  agree (Sepolia). `BASE_SEPOLIA_RPC_URL`, `ETH_SEPOLIA_RPC_URL` and `UNICHAIN_SEPOLIA_RPC_URL`
  are not read by any code (harmless leftovers). The 0G key is private-routing only, so the
  `qwen3.7-plus` fallback from PHASE_00 is unreachable (403 verified / 503 private), and
  `0gm-1.0-35b-a3b` as fallback is the correct choice.
- Live smokes: `pnpm smoke:zgstorage` ✔ (upload, download by root hash, byte equality).
  `pnpm smoke:zg`: planner ✔; fallback, guard and explainer 502 (0G provider outages).

## Bug found and fixed: bogus price impact on split routes

Live, a $2 ETH → USDC quote on Sepolia reported `priceImpact: 95.89` and was refused, although it
gave the best output of any route (23.695 USDC vs 23.413 USDC V4-only at 1.01%). The router had
split 5% through ETH → UNI → USDC, where the testnet UNI/USDC pool's mid price is absurd, and the
API measures each leg against its own mid price.

Fix (`packages/uniswap-agent-mcp/src/services/priceImpact.ts`, `services/quote.ts`):

1. **Safety metric:** the effective execution price of the whole quote (total out / total in,
   fees included) against the mid price of the deepest direct pool (`sqrtRatioX96`, or V2
   reserves). The policy uses this number. The API's raw figure is kept as evidence
   (`apiPriceImpactPct`, shown in the trade-score breakdown).
2. **Better routing:** effective price > 1% worse than that mid → quote again with `protocols`
   restricted to the main pool's protocol, and keep whichever is better for the user. `/swap` is
   built from the kept quote.
3. **A real loss is still refused:** if even the best quote is > 5% worse than mid → REFUSE.

Tests: `packages/uniswap-agent-mcp/test/price-impact.test.ts` (8, built from the live quote) and
3 cases in `apps/api/test/policy-engine.test.ts`. Two MCP fixtures had a `sqrtRatioX96`
inconsistent with their own amounts; they now match. Logged in `FEEDBACK.md`.

## Verification

- `pnpm lint` ✔ · `pnpm typecheck` ✔ · Prettier ✔
- `pnpm test` ✔ — **433 tests** (api 241, mcp 153, shared 23, web 16).

## Known limitations

- **0G Vela 2.0 is down** (all `decisions` providers unhealthy, `502 provider_error`). Until it
  recovers, every action is refused with "Safety check unavailable". This is correct fail-closed
  behaviour. Its success response shape is still unconfirmed (`// VERIFY:` in `guard.ts`).
- **0GM-1.0 is down**, so refusal and guard explanations fall back to templates and the planner
  has no working fallback.
- **Fund the agent wallet** before the live demo: `0xBB02…E69E` (user "alice") has 0.001 ETH. A
  $5 swap needs ≈ 0.0023 ETH plus gas.
- Simulation of approval-dependent steps uses deferral (re-simulated right before broadcast)
  rather than `stateOverride`; both are allowed by the phase file.

## Commands

```powershell
docker compose up -d; pnpm db:migrate
pnpm lint; pnpm typecheck; pnpm test
pnpm smoke:zgstorage   # live 0G Storage round trip
pnpm smoke:zg          # live 0G models (guard currently 502)
pnpm dev               # then "Swap $5 ETH to USDC" in the Agent panel
```
