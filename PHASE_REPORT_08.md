# Phase 08 — Mode B, inbox, morning brief, Telegram

Status: **built, tested, and run live on Sepolia with real 0G and Uniswap calls.** One step could
not be run here: a real Telegram message reaching a real chat, because linking needs a human to
press Start. See "Not verified live".

## Acceptance criteria

| Criterion                                                                           | Result                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `simulate-event` → suggestion in Inbox and Telegram → Yes → executes with a receipt | **Inbox and execution done, live, using `PROFIT`.** Yes → tx `0x6267379ba6f173cf23a5794ee82d8ed8d3d67ee45de40d31817a5862d81a4c37`. A clean auto-run also executed: `0x8135cac4d4185e5d1278d499546eea47a3068be216b3da9840855b6601822278`. Telegram delivery is tested against a fake API only.                     |
| Same over the limit → Yes → approval required → approve in app → executes           | **Done, live.** "Over your $0.05 per-action limit" → dev approval → tx `0xfd8cdff71a411cb55cfbc315944138251c19ff535dbebfb9dcd5738d958df0ff`. This was the first `STEP_UP` plan ever executed on the live stack. The limit was lowered for the run and restored to $25. All three decision logs are on 0G Storage. |
| HOOK_CHANGED on a simulated snapshot diff → RED alert with exit proposal            | **RED alert done live; exit proposal in tests.** alice has no LP position, so the live alert was information only. With a position, the exit proposal, and a Danger-rated hook that steps up instead of refusing, are covered by integration tests.                                                               |
| Morning brief on demand and at 08:00 user TZ                                        | **On demand done, live** (real 0G text, six lines, request ID). The 08:00–08:15 window is covered by boundary tests; it has not fired on a real morning yet.                                                                                                                                                      |
| Telegram never responds as a chatbot; `/help` explains                              | **Done, in tests.** Free text gets one fixed line and reaches no model. The real bot started and polled with the real token (`@etheth123bot`).                                                                                                                                                                    |
| `PHASE_REPORT_08.md`                                                                | This file.                                                                                                                                                                                                                                                                                                        |

## What was built

- **Nine detectors**, each a pure function with fire / no-fire boundary tests, in
  `apps/api/src/modules/modeb/detectors`.
- **Worker tick** every 60 s: expiry sweep, per-user jitter, time budget with fair rotation, daily
  cap (RED alerts, the brief and demo events do not count).
- **Suggestion lifecycle**: 0G message, one pipeline, AUTO / ASK / refused; Yes re-quotes and asks
  the policy again; No and Change close the plan; 15-minute expiry; every closed plan is logged.
- **Morning brief** with a deterministic template fallback, and portfolio samples for the 24 h change.
- **Inbox**: pinned brief, severity, plan summary, who approves, status pills, "Simulated (demo)",
  Yes / Change / No, nav badge, RED toasts, and a suggestion card in the chat.
- **Telegram**: link codes (hashed, 10 min, one-time), `/start` `/stop` `/resume` `/help`, signed
  buttons, MarkdownV2 escaping, message edits with results, rate limit and `retry_after`, webhook
  for production, long polling locally. Rule fires, receipts and the first deposit notice included.
- **Settings**: Telegram connect / mute / disconnect, auto-act per detector, time zone selector
  (moves DCA runs too).
- **Demo**: `POST /admin/simulate-event`, `POST /admin/run-brief`.

## Price drops buy (added on request, changes the phase spec)

The phase file makes BIG_MOVE information only. On request, a drop of 5% or more now also buys the
dip amount, under the same limits and "Dip buys" switch as DIP, with one dip purchase a day between
them. After a run the inbox reports the fact: "Bought 0.0008113 ETH for $20.00… Why: ETH moved -6%",
and sales in profit say how much was locked in. Live: tx
`0x2286c23a388257602d0b295e4b4b1868e783c145d9c6cb04898e57909e0c43b9`.

## Bugs found and fixed

Found by live testing, which mocks could not catch:

1. **Over-limit actions could never reach a human.** The guard was shown spending limits and blocked
   them as a "limit breach", so policy's step-up never ran, in Mode A too. The dev database had zero
   `STEP_UP` plans. The guard no longer sees limits; a human decides those.
2. **Every swap was at risk on Sepolia.** Both v3 ETH/USDC pools quote well, then revert with `TF`,
   and the router's other buy routes are junk multi-hops. New config `UNISWAP_BLOCKED_POOLS` turns on
   per-trade route selection: each protocol is quoted, blocked pools are dropped, the cleanest wins.
3. **Small swaps could not be planned.** The model writes `"2.2e-05"`, which failed validation.
   Exponents, quoted or not, are now normalised.
4. **Information alerts asked "Want me to proceed?"** with no buttons and no chat to answer in, and
   auto-run actions said "Approve to proceed". Prompt tightened, plus a hard output check.
5. **Guard refusals read "The check passed, but…"**, and notes ended in "..". Fixed.

Found by design review, tests and smokes:

6. **A Danger hook trapped the position.** Policy refused the very exit HOOK_CHANGED proposes. Exits
   now step up to the human. Simulation and guard refusals still stand.
7. **`lp_rebalance` could not target another pool**, which BETTER_POOL needs. Added `targetPool`; the
   hook gate judges the destination.
8. **localhost in a button makes Telegram reject the whole message.** Only public URLs become buttons.
9. **Inbox overflowed at 375 px**, and **UTC was missing from the time zone list**. Both fixed.
10. **Two of my own mistakes, caught before finishing**: a what-if refactor regressed a Phase 7 test,
    and a broken regex left the wording check dead. Both fixed, with tests.

## Verification

- `pnpm lint` ✔ · `pnpm typecheck` ✔ · `pnpm format:check` ✔ · `pnpm build` ✔
- `pnpm test` ✔ — **688 tests** (api 413, mcp 159, web 93, shared 23).
- `pnpm --filter @warden/web test:e2e` ✔ — 8 Playwright smokes, including inbox, deep link and 375 px.
- Live worker ticks: `failures: 0`. The two failed jobs in the queue predate the migration.

## Not verified live

- **A real Telegram message in a real chat.** Sending, buttons and MarkdownV2 are tested against a
  fake API. Telegram can still reject formatting a fake accepts, so run the checklist below once.
- **The real tick buying on its own**: the live buy used `simulate-event`. A real tick takes the same
  path (tested), but running it live would have spent `komal`'s funds.
- **BETTER_POOL, OUT_OF_RANGE and IDLE_USDC live**: alice has no LP position. Integration tests only.

## Before the demo

1. Restart `pnpm dev`, so `dev:bot` starts (the running session predates it).
2. Settings → Connect Telegram → press Start.
3. `POST /admin/simulate-event` with `detector: "PROFIT"`; check the alert arrives, then tap Yes.

## Demo notes

- **Testnet prices make buys look like losses.** Sepolia pools price ETH around $25,000 while the
  portfolio values it at the mainnet ~$2,200, so a $20 buy shows as about $2 of ETH and the total
  drops; selling shows the reverse. This is testnet pricing, not a bug, and judges may ask.
- **Buys need dip size.** Under about $20 the only V4 route is a junk multi-hop that is refused.
- **The guard is GLM-5.3 while Vela is down** (`ZG_GUARD_MODE=chat`). It varies: the same 1% trade
  was approved on one run and blocked on the next. Retry if a demo trade is refused.
- **alice has about $3 of USDC left**, too little for a dip buy. Use `komal` or top her up.

## Known limitations

- **Mode B is live on real testnet wallets.** With the defaults, DIP, PROFIT and IDLE_USDC run alone
  under limits for every funded user, including `komal`, as the phase specifies. Switch them off in
  Settings if unwanted.
- **Changing time zone moves the daily limit window**, so hopping zones could stretch one day's
  budget. It needs a signed-in human, not the agent. Consider a step-up in Phase 10.
- **Telegram approvals deep-link to the web app** until the World device flow in Phase 10.
- **`.env` changed**: added `UNISWAP_BLOCKED_POOLS`. Migration
  `20261106132502_phase8_mode_b` is additive and applied to the dev database.

## Commands

```powershell
docker compose up -d; pnpm --filter @warden/api db:migrate
pnpm lint; pnpm typecheck; pnpm test; pnpm build
pnpm --filter @warden/web test:e2e
pnpm dev
```
