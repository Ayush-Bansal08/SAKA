# Phase 04 — 0G AI layer: planner, guard, explainer, request IDs

Status: **built and verified.** All five acceptance criteria are met. Two 0G-hosted models
(Vela 2.0 and 0GM-1.0) were returning `502` from 0G's providers during this session; the code
handles that as specified (guard fails closed, explainer falls back to templates), but their
successful live responses could not be observed. See "Known limitations".

## Acceptance criteria

| Criterion                                                                                                                                             | Result                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/smoke/zg.ts` makes one call per model and prints `X-Request-ID`, trust mode, `tee_verified`                                                  | **Done.** Planner succeeded (`glm-5.3`, private, request ID printed). Fallback, guard and explainer each printed their router `X-Request-ID` with `502 upstream_error` / `provider_error` — 0G provider outages, see below.                                                                                                              |
| "Swap $20 ETH to USDC" → valid `swap_exact_in`; live panel shows plan → tool_call(get_quote) → tool_result → proposed intent with 0G request ID chips | **Done, live.** Real API + dev sign-in: reply `Planned: swap $20 ETH → USDC — preparing…`, intent `amountIn 0.00898`, `amountUsd 20`. Trace: `Planning on 0G` → `0G planner` (chip) → `tool_call get_quote` → `tool_result` → `0G planner` (chip) → `Proposed intent` (chip), about 11 s. Also available from the cockpit's Agent panel. |
| `pnpm eval:planner` ≥ 90% with results in `docs/eval-planner.md`                                                                                      | **Done: 32/35 (91.4%)**, p50 6.1 s, p95 20.1 s; cases check key parameters, not only the kind.                                                                                                                                                                                                                                           |
| Guard fails closed when the decisions endpoint errors                                                                                                 | **Done.** Unit tests (HTTP 502, unknown answer shapes) plus the live 502s → `block`, `unavailable: true`, "Safety check unavailable — nothing was executed."                                                                                                                                                                             |
| `PHASE_REPORT_04.md` written                                                                                                                          | This file.                                                                                                                                                                                                                                                                                                                               |

## What was fixed or improved in this pass

The phase was already scaffolded, but it scored 7/31 live and had these defects:

1. **Planner timeouts.** GLM-5.3 "thinking" made tool rounds exceed `ZG_PLANNER_TIMEOUT_MS`. Now
   `reasoning_effort` is sent (`ZG_REASONING_EFFORT`, default `low`); live rounds take 2.5–4 s.
2. **Fallback always 403.** The key is private-only (`trust mode mismatch: key=private,
request=verified`). New `ZG_PLANNER_FALLBACK_TRUST_MODE` (default `verified` per PHASE_00);
   `.env` now sets `private`, the stricter tier.
3. **Every `propose` corrupted in transit.** The router's GLM tool parser types each argument from
   the function's top-level `properties`. The raw ActionIntent union (`anyOf`) has none, so
   values were literal-evaluated: `"20"` became `20` and recipient `0x…dEaD` became the integer
   `57005`. `propose` now takes one flat object with typed fields, derived from the union; Zod
   still validates the exact member. Bare decimals are quoted from the raw text (exact digits);
   addresses are never coerced.
4. **Repair round could not repair.** Union errors came back as `path: "", "Invalid input"`.
   Validation now uses the member named by `type`, so the model gets the exact field plus a
   quoting hint.
5. **Planner refused over-limit actions.** The prompt now says limits never stop planning; the
   policy engine (P05) asks the human instead.
6. **Explainer and guard got the planner timeout** (now `ZG_REQUEST_TIMEOUT_MS`). A retry
   abandoned for budget lost `fallbackOf` (now kept). Explainer events were kind `plan` even
   for guard reasons (now `guard`).
7. **Route race and status bug.** The lock was released after `DONE`, so an immediate follow-up
   got a 409. A late trace-emit failure could rewrite a stored reply as `FAILED`. Both fixed.
8. **Regression fixed.** The root `package.json` description had been mojibaked
   ("Warden â€”"); it is restored.

## Built (complete list)

- **0G client** (`apps/api/src/modules/ai0g/client.ts`):
  - Request headers: `X-0G-Provider-Trust-Mode` and `X-Client-Request-Id`. Body: `verify_tee`,
    plus `reasoning_effort`, `responseFormat` and `stream` when set.
  - Provenance: reads `X-Request-ID`, including the two-value `edge, request` form, and
    `x_0g_trace` from the body, or from the final stream chunk when streaming (confirmed live).
  - Records one `Inference` row and one trace event with the 0G chip per attempt.
  - Retries 429/503 twice within one deadline. Planner fallback is linked by `trace.fallbackOf`.
  - Refuses to send any configured credential to inference.
- **Planner** (`agent/planner.ts`, `agent/context.ts`, `agent/prompts/planner.v1.md`):
  - Tools: 10 MCP read tools + `plan_trigger` + `propose` / `answer`. Build tools are never
    exposed.
  - Account defaults (`chainId`, `swapper`) are filled in for tool calls.
  - Loop: ≤ 5 read rounds, then only the terminal tools are offered.
  - Rejects invented addresses, allows one repair round, and handles plain-text replies.
  - Uses the last 12 messages plus the pending intent for edits, and reference USD prices in
    the context.
- **Guard** (`safety/guard.ts`):
  - Typed `GuardInput`; deterministic state rendering (≤ 1800 chars, lists truncated).
  - Questions: verdict / risk / concerns. Blocks if verdict=block or pApprove < 0.8.
  - Reason from the explainer, or a template when approved with no concern.
  - Tolerant `parseDecision` (`// VERIFY:`), fails closed, `unavailable` flag for P05 policy.
- **Explainer** (`ai0g/explainer.ts` + 6 prompt files):
  - Helpers: `explainRefusal`, `explainHook`, `explainSuggestion`, `morningBrief`,
    `explainPoolPick`, `guardReason`.
  - Each has typed inputs, its own token cap, an output check and a deterministic template
    fallback.
- **Agent API** (`agent/routes.ts`):
  - `POST /agent/messages`: 202, async, 10 messages/min per user, one plan at a time.
  - `GET /agent/messages?cursor`: typed `AgentMessageView` pages.
  - Provisional `IntentCard` reply, or a friendly "Planning failed" card.
- **Shared:** `AgentMessageRequest` / `Accepted` / `View` / `MessagesResponse` schemas.
- **Web:** the cockpit Agent panel is now a working chat (`apps/web/src/features/agent`):
  - Example prompts, a "Planning on 0G…" state, and polling plus trace-driven refresh.
  - 0G request-ID chip and trust mode on replies; loading, empty and error states.
- **Eval** (`apps/api/eval/`): 35 cases covering every Mode A row (ambiguous inputs and edits
  included), checked with numeric-aware parameter matching. The report also records model,
  trust mode, reasoning effort and latency percentiles.
- **Smoke** (`scripts/smoke/zg.ts`): one call per model, fallback disabled per line; prints
  status and error code on failure, never secrets.
- **Docs:** README and `docs/ARCHITECTURE.md` Phase 04 sections; `.env.example` lists the three
  new variables.

## Verification

- `pnpm lint` ✔ · `pnpm typecheck` ✔ · `pnpm build` ✔ (prompt files copied to `dist`) ·
  `pnpm format:check` ✔
- `pnpm test` ✔ — **342 tests** (api 162, mcp 144, shared 23, web 13).
- New tests cover: headers / `verify_tee` / `reasoning_effort`, multi-value request IDs,
  provenance mismatch, 429 retry and give-up, fallback on 502 and on timeout, the configured
  fallback trust tier, credential refusal, and stream assembly with the trace taken from the
  final chunk.
- Guard tests: approve with no explainer call, block below 0.8, block verdict, fail-closed on
  502 and on bad shapes, alternative answer shapes, state truncation.
- Explainer tests: format checks and fallbacks.
- Planner tests: replay of the recorded-shape swap fixture, repair, invented address, plain-text
  reply, 5-round cap, edits, and the recorded live `57005` failure.
- Route tests: card text and trace order, typed history, pending intent, failure card, 10/min
  limit.
- Live: `pnpm smoke:zg`, `pnpm eval:planner`, and the API end-to-end request above.

## Known limitations

- **Vela 2.0 (`/v1/decisions`) returned `502 provider_error` on every request** in this session,
  including minimal one-question bodies with and without the trust header. Its success response
  shape is therefore still unconfirmed (`// VERIFY:`). Until it recovers, the guard blocks every
  action, which is correct fail-closed behaviour.
- **0GM-1.0 (explainer and current fallback) returned `502 upstream_error`** ("fetch provider
  quote … EOF"). Explainer text uses templates meanwhile, and the planner has no working
  fallback while it is down: one eval case failed this way.
- Eval failures: (a) chained trigger — primary timeout with the fallback down; (b) "Make it $30
  and add a stop-loss" — the model asked which stop-loss price (a reasonable answer, scored as a
  fail); (c) wide LP — the model truncated the zero hook address twice. The same case passed on
  a rerun after one repair.
- `tee_verified` is absent from live `x_0g_trace`. The router documents absence as "no verdict
  for this route", not a failure; it is stored as `null` and the chip only shows "TEE verified"
  when it is `true`.
- Planning runs in the API process; a hard crash can leave a request unfinished and its Redis
  lock held until expiry (10 min).

## Commands

```powershell
docker compose up -d; pnpm db:migrate
pnpm install; pnpm lint; pnpm typecheck; pnpm test; pnpm build
pnpm smoke:zg        # live, needs ZG_* in .env
pnpm eval:planner    # live, needs ZG_*, MCP (pnpm dev) and Postgres; writes docs/eval-planner.md
pnpm dev             # then sign in and type "Swap $20 ETH to USDC" in the Agent panel
```

For a key limited to private routing, set `ZG_PLANNER_FALLBACK_TRUST_MODE=private` in `.env`
(already set in this workspace).
