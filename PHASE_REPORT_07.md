# Phase 07 — Hooks explorer, LP positions, triggers

Status: **built and verified, live on Sepolia.** While 0G's decisions and 0GM models are down, the
guard and explainer run on GLM-5.3 (`ZG_GUARD_MODE=chat`, see below). Every live check in this
report went through the real 0G planner and guard, the real Uniswap APIs and the real testnet.

## Acceptance criteria

| Criterion                                                                                                                               | Result                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/hooks` shows real mainnet hooks with scores and 0G explanations; the tradeable tab shows execution-chain hooks or a clear empty state | **Done, live.** First indexer run: 67 mainnet hooks scored (Framework breakdown, permissions, history), explained by GLM-5.3 with 0G request IDs. The Sepolia tab shows the empty state "No hooks on Ethereum Sepolia yet".                                                                                                                   |
| "Put $10 into ETH/USDC" opens a position or refuses with a clear reason; it appears in Portfolio with a range bar                       | **Done (refused path live).** Live "Put $1 into ETH/USDC" now builds the position (1 approval + v4 batch permit, signed only at execution). The guard refused it with a clear reason; the position card, range bar and LP risk factors are covered by tests. See "Known limitations" on testnet LP sizing.                                    |
| Rebalance and Exit work from the position card                                                                                          | **Done.** The buttons pre-fill the chat with the position id; the planner context lists position ids; the preparer builds `build_rebalance` / `build_lp_exit` (Phase 05 tests + execution test).                                                                                                                                              |
| "Sell half if ETH goes up 2%" creates a trigger; the price override fires it; it executes through the pipeline with a receipt           | **Done, live.** Rule: "Sell 50% of your ETH for USDC when ETH ≥ $2,285.12 (+2%)". The override to $2,300 fired it in one window: score 100, simulation passed, GLM guard approved (p=0.97), AUTO, re-quote, tx `0xdadb98eb9d674d92c7b6f83df57eb5266f0c6bf478a1b523fd64a73cc0a170d1` confirmed in block 12076415. The rule shows "Executed ✓". |
| "Buy $10 of ETH every day" creates a DCA trigger with the next run shown                                                                | **Done, live.** "Swap $10.00 of USDC for ETH every day at 09:00", next run 2026-11-07 03:30 UTC (09:00 Asia/Kolkata), shown in the Rules panel.                                                                                                                                                                                               |
| A chained plan executes step by step; a refusal stops the chain                                                                         | **Done.** Live creation of the chained rule; sequencing and stop-on-refusal / on-rejection are covered by integration tests.                                                                                                                                                                                                                  |
| `PHASE_REPORT_07.md`                                                                                                                    | This file.                                                                                                                                                                                                                                                                                                                                    |

Also closed live: **Phase 05's last item.** "Swap $1 ETH to USDC" ran AUTO end to end: tx
`0x04493c4630e2433764b49997b2f55799c311e7c8b997aac424aa1cd62813066e` (block 12076399), decision
log on 0G Storage, root `0xdf890299dacd2d1dc0069d7961f56569aa1d54956420cec0a5fcfada83518c60`.

## What was built

- **Hook indexer + API + explorer UI**: Market and Tradeable tabs, band / new-this-week /
  search / sort, cards with a score ring, explanation and request ID, permission chips in plain
  words. Buttons: "Ask agent about this" and "Try $5 through it". Detail page: breakdown with
  framework sections, 14-flag grid, facts, pools, change history, what-if quote.
- **Triggers**: storage from chat (cancellable "Rule set" card), `GET /triggers`, cancel, a
  30-second evaluator (TP/SL/DCA/chained/alerts), and a Rules panel on the cockpit and in Settings.
  Also the admin price override with a header chip.
- **LP**: profile-based range preset, live positions in the portfolio (value, P&L, fees, hook
  band, range bar, risk factors), position ids for the planner, and the 0G pool-pick explanation
  on the comparison card.
- **Guard chat mode** (`ZG_GUARD_MODE=chat`): the same safety question via chat completions with
  a strict JSON verdict, for while Vela is down; fail-closed; default stays `decisions`.

## Bugs found by live testing (all fixed, each with a regression test)

1. **Approvals read like blocks.** The guard approved (p=0.85) but the explainer wrote "Blocked
   by the safety check…". Approvals with a concern now get a deterministic "Safety checks passed
   (worth watching: …)"; only blocks are explained by the model.
2. **Low-confidence blocks read like approvals.** The guard blocked at p=0.70 with no concern,
   and the explainer wrote "Everything checks out…". Now: "The 0G guard was not confident enough
   to approve (p=0.70, needs 0.80)".
3. **The demo price override leaked into trade amounts.** "$0.64" was computed at the override
   price while the real value was $0.62, so a DCA "$10 of ETH" would have bought the wrong
   amount. Now overrides only decide _when_ a rule fires; amounts always use live prices.
4. **LP open failed when the planner chose the pool**: "Could not price the liquidity amount".
   The tokens are now resolved from the registry by symbol / address.
5. **Rules stayed "Executing" forever.** The list now shows how the fired plan actually ended
   ("Executed ✓", "Nothing was traded", …).
6. **Duplicate answers**: the model's own summary card repeated the deterministic fact card;
   fact cards now supersede it.
7. **Hook penalties showed as "+25".** score_hook reports deducted points; they are now shown as
   −25.
8. **New-hook announcements could miss active users** (an arbitrary 200). Now the most recently
   active users come first.

## Verification

- `pnpm lint` ✔ · `pnpm typecheck` ✔ · `pnpm format:check` ✔ · `pnpm build` ✔
- `pnpm test` ✔ — **514 tests** (api 271, mcp 153, shared 23, web 67). New in this phase:
  - API: schedules across time zones and DST, templates, TP via override (exactly once), two
    concurrent evaluators, DCA reschedule, chain advance / stop on refusal / stop on rejection,
    rule from chat + owner-only cancel, admin auth, indexer, hooks API, LP in the portfolio, chat
    guard, and the regressions above.
  - Web: permission copy, range bar maths, prefill bus, hook card, position card, rule row, rule
    card.
- `pnpm --filter @warden/web test:e2e` ✔ — 5 Playwright smokes, including the hooks explorer;
  screenshots in `docs/screenshots/`.

## Known limitations

- **0G outage workaround is active in `.env`**: `ZG_GUARD_MODE=chat`, guard / explainer /
  planner fallback on `glm-5.3`. Restore `decisions` + `vela-2.0-9b` + `0gm-1.0-35b-a3b` once 0G
  recovers. The original values are in a comment above them in `.env`.
- **Testnet LP sizing**: Sepolia's ETH/USDC v4 pool prices ETH around $26k, so a balanced
  deposit with $0.50 of ETH needs about $6.60 of USDC. We report the real value at risk ($7.11),
  and limits apply to it.
- **"Try $5 through it"** pre-fills a swap request naming the hook; the Uniswap Trading API
  routes on its own, so the exact pool is not forced. The what-if widget shows the hook-pool
  quote exactly (`quote_pool`).
- **P&L on testnet** looks extreme (e.g. +773%) because testnet pools misprice USDC versus the
  mainnet reference. The maths is correct; the inputs are testnet.
- **Live DCA rule**: alice's "Buy $10 of ETH every day" will fire at 09:00 IST through the full
  pipeline. Cancel it in Rules if not wanted.

## Commands

```powershell
docker compose up -d; pnpm --filter @warden/api db:migrate
pnpm lint; pnpm typecheck; pnpm test; pnpm build
pnpm --filter @warden/web test:e2e
pnpm dev   # /hooks fills within ~5 min (first indexer run)
```

## Addendum: gas-aware decisions

- **Route choice is net of gas** (`services/quote.ts`): when the single-protocol re-quote is
  compared with the original, each is measured after `gasFeeQuote`, so a route that returns slightly
  more but burns more gas does not win.
- **Previews show what you keep**: "Est. gas" with its share of the value, and "You receive, after
  gas" (`netOutUsd`).
- **Hook what-if compares after gas**: hook callbacks cost extra gas, so `netDifferencePct` sits
  next to the before-gas difference. A hook pool that pays 1% more can lose after gas.
- Not changed: `compare_pools` ranks LP pools by APR and hook safety; gas plays no part there.
  Proactive actions are Phase 08.
