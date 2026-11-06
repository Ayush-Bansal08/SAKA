# PHASE 03 Report: Agent wallet (Privy), onboarding, limits, funding, portfolio

**Scope:** the Privy agent wallet adapter, the onboarding state machine and wizard, the balance
watcher (deposit detection), the portfolio service (balances, prices, FIFO P&L, risk meter,
limits) and the Settings page. Nothing from later phases was built: no chat, AI, swaps,
approvals, Telegram or World.

**Execution chain:** Ethereum Sepolia (`11155111`). USDC is
`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, the same as Phase 02. The prompt left the chain,
the USDC address and "the faucet that worked for you" as placeholders. I used the values the
repo had already decided. For the ETH faucet I defaulted to Google Cloud's Sepolia faucet,
because I don't know which one you used; set `FAUCET_ETH_URL` to change it.
`https://faucet.circle.com` is the USDC link.

## Acceptance criteria

- [x] **A fresh dev user completes onboarding and a real Privy server wallet address is
      shown.** This was checked live against the real Privy app in `.env`, with the real MCP
      server and the dev stack running:
  - **API:** dev sign-in, then `GET /onboarding` (`WALLET`), then `POST /onboarding/wallet`
    (2.4 s). It returned `0x5583f2CB61D2dFC0A148cC258C1b38aA63d7d18e` with Privy policy
    `e3rsihp4fq50pl9xtc3b07wq` attached. `POST /onboarding/profile` (BALANCED) then moved the
    user to `FUND` with limits $25 / $100 / 0.5%.
  - **Browser:** headless Edge drove the wizard for a second fresh user: verify, then the
    animated wallet creation (a real Privy wallet, `0x9C88…6348`), then profile cards, then
    the fund step. Screenshots were taken at 1280×900 and 375×812. There were 0 console
    errors and no horizontal scroll at 375 px.
- [~] **Sending testnet ETH flips onboarding to DONE within about 15 s, and the portfolio
  shows the balance with a USD value.** Covered by tests. Not yet observed with a real
  deposit, because no test wallet has funds.
  - `test/balance-watcher.test.ts` runs the real watcher code on Postgres and Redis, with
    `get_portfolio` and `get_quote` replaced by fakes. A 0.05 ETH deposit creates a
    `TokenLot` costing $125 (at $2,500), emits "Funded: 0.05 ETH (~$125.00)", and moves the
    step `FUND` → `DONE`.
  - On the live stack, the worker's watcher polled all 3 wallets every 15 s with 0 failures.
  - **To confirm it end to end:** send Sepolia ETH to a wallet on the fund screen and watch
    it flip.
- [x] **Portfolio, risk meter and limits bar render with correct numbers; empty, loading and
      error states are polished.**
  - **Live:** `GET /portfolio` returned ETH priced at $2,230.67 from a real mainnet
    `get_quote`, a Low risk meter ("No funds in the agent wallet yet"), and limits
    $0 of $100.
  - **Tests:** exact numbers are asserted (total $135, P&L +$25 / +22.73%, a 3.8% drawdown
    driver, today's AUTO spend counting only agent-approved executions in Asia/Kolkata).
    The 503 path and the "price history down" path are also tested.
  - **Cockpit and Settings:** screenshots at 1440×900 and 375×812, with 0 console errors.
- [x] **`scripts/smoke/privy.ts` sends a 0 ETH self-transfer from the agent wallet and
      prints the hash.** Run live by the human on 2026-11-06, after funding the smoke wallet
      with 0.001 Sepolia ETH.
  - Smoke wallet `0x943a710B62EcfFE38074D543fd7cEc58e009Ad35` (Privy id
    `ibf1clqngc4t1ds522675jnd`), with Privy policy `prv7ty6x2ggdkanqirjxifux` attached. The
    policy allowed the zero-value self-transaction rule.
  - Tx
    [`0xaab556cb…b5d4b5f3`](https://sepolia.etherscan.io/tx/0xaab556cbd92bd849b26479be781d87e16d2d244e4aaff73f15c862f1b5d4b5f3)
    was sent in 2.5 s and confirmed in block 12074311.
  - Checked independently over RPC: `from` = `to` = the smoke wallet, value 0, empty
    calldata, type 2, status success.
  - Earlier runs: the first stopped with exit code 2 ("wallet needs funding") while the
    balance was 0, and a second run reused the same wallet and policy.
- [x] `PHASE_REPORT_03.md` written.

Repo-wide checks, run on the final tree:

| Check               | Result                                                         |
| ------------------- | -------------------------------------------------------------- |
| `pnpm lint`         | 4/4 packages, 0 errors, 0 warnings                             |
| `pnpm typecheck`    | 4/4 packages                                                   |
| `pnpm test`         | **294 passed**: api 116 (+73), mcp 144, shared 23, web 11 (+2) |
| `pnpm build`        | 4/4 packages                                                   |
| `pnpm format:check` | clean                                                          |

## What was built

### Privy adapter: `apps/api/src/modules/wallet/privy.ts`

- **Package and API surface:** `@privy-io/node@0.36.0`, the newest release that is at least
  two weeks old. Method names were checked in its `.d.mts` files:
  `wallets().create/get/list/update`, `wallets().ethereum().sendTransaction/signTypedData`,
  `policies().create/get`.
- **The only Privy caller:** this is the only file that imports the SDK, and the smoke
  script goes through it too. It exposes only `createAgentWallet`, `attachPolicy`,
  `sendTransaction`, `signTypedData` and `getAddress`.
- **Idempotent wallet creation:** Privy `external_id = warden_<userId>` is looked up first,
  creation uses an idempotency key, and `AgentWallet.userId` is unique in the database.
  Concurrent creates converge. The live UI run found a real race here (see Decisions), and
  it is now handled and tested.
- **Policy:**
  - It ALLOWs `eth_sendTransaction` only to Universal Router 2.1.2, Permit2, the v4
    PositionManager and allowlisted tokens, on chain 11155111.
  - It ALLOWs a zero-value self-transaction.
  - It ALLOWs `eth_signTypedData_v4` only for the Permit2 and PositionManager domains.
  - Privy denies everything else.
  - If the policy API fails, the adapter logs a warning and stores `policyId = null`.
- **Transactions:**
  - `sendTransaction` uses `caip2: eip155:<chainId>`, hex quantities and the caller's
    idempotency key.
  - It refuses any chain other than the execution chain.
  - It checks the returned hash format.
- **Typed data:** `signTypedData` adds an explicit `EIP712Domain` type (per the LP API doc
  note) and converts bigints to JSON-safe strings.
- **Errors:** connection errors, 429 and 5xx become `WALLET_PROVIDER_ERROR` 503 (retryable).
  Other 4xx and SDK errors become 502 and carry Privy's own reason. Request bodies and
  signatures are never logged, and the redaction list now covers the Privy secrets and typed
  data.
- **Authorization key:** `PRIVY_AUTHORIZATION_PRIVATE_KEY` is used only when it is set, and
  the live runs didn't set it.

### Onboarding API: `modules/users`, `modules/wallet`

- `GET /onboarding`, `POST /onboarding/wallet` (rate-limited to 10/min per session) and
  `POST /onboarding/profile`.
- Steps run `VERIFY → WALLET → PROFILE → FUND → DONE`. Every transition is compare-and-set,
  so retries and races can't skip or repeat a step.
- **Guards:**
  - No wallet before human verification.
  - No profile before a wallet exists.
  - The profile can be re-picked while still in FUND.
  - After DONE, a profile change is `409 STEP_UP_REQUIRED`.
- Profile limits come from the PHASE_00 §9 table (`riskProfileSettings`).
- **Trace events:** "Agent wallet created" (address, chain, policy) and
  "Risk profile: Balanced".
- **Settings endpoints:** `GET /settings` works. `PUT /settings/risk-profile`,
  `PUT /settings/limits` and `POST /wallet/withdraw` answer `409 STEP_UP_REQUIRED` with
  reason codes `RISK_PROFILE_CHANGE`, `LIMIT_CHANGE` and `WITHDRAWAL`.

### Balance watcher: `apps/api/src/jobs/balance-watcher.ts`, worker `wallet` queue

- **Schedule and data:** a BullMQ job scheduler runs every 15 s (`BALANCE_POLL_MS`).
  Balances come from MCP `get_portfolio`, which is the single source of truth.
- **Deposit detection:** the watcher compares against the Redis snapshot. An increase is
  recorded as a `TokenLot` with `source=DEPOSIT` and cost = amount × the mainnet reference
  price, plus a `receipt` trace event. The first native deposit while at FUND moves the user
  to DONE. A USDC-only deposit is recorded but doesn't finish onboarding, because gas needs
  ETH.
- **Own-execution exclusion:** if any `Execution` row was created in the last 2 minutes, the
  increase is treated as explained.
- **Back-off:** users with no API activity for 24 h are polled every 5 min. The
  `activity:<userId>` key is set by `requireUser`, throttled to once a minute.
- **Safety:**
  - A per-user Redis lock prevents double counting.
  - Lots are written before the snapshot, so a crash between the two re-detects the deposit
    instead of losing it.
  - A lost snapshot for a wallet with history re-baselines with no phantom deposit.
  - One user's failure doesn't stop the pass for the others.

### Portfolio: `modules/portfolio`

- **`GET /portfolio`** returns exactly the shape in the phase file, plus `chainId`,
  `unpriced` and `warnings`. It also sets `priceSource: 'Uniswap API · Ethereum mainnet
reference'`.
- **Balances:** MCP `get_portfolio`, through a 10 s Redis cache shared with the worker.
- **Prices:** MCP `get_quote` on mainnet, 1 token → USDC. Prices are cached 30 s in
  `PriceCache`; a stale value up to 10 min old is used, with a warning, if the quote fails.
- **FIFO P&L** (`fifo.ts`):
  - Partial lots are pro-rated.
  - Realized P&L counts only covered units.
  - An unexplained shortfall (gas) is consumed FIFO at zero proceeds.
  - A deposit not yet recorded is left out of P&L rather than counted as profit.
- **Risk meter** (`risk.ts`, deterministic):
  - Weights: concentration 0.30, stablecoin buffer 0.20, LP out of range 0.15, hook
    exposure 0.15, drawdown vs 7-day high 0.20.
  - The 7-day high comes from MCP `get_price_history`, with a 3 s budget. When it is
    unavailable, the weights re-normalise over the other factors.
  - Labels: Low below 34, Moderate below 67, High from 67. It returns up to 3 drivers plus a
    per-factor breakdown.
- **Limits:** today's AUTO spend (`approvedBy = AGENT`, signed, broadcast or confirmed)
  counts against the daily limit, computed in the user's time zone. This is DST-safe and
  needs no tz library.
- **Quiet reads:** background MCP reads use a new `quiet` call option, so they never flood
  the user's live activity. This is a small, backwards-compatible change to the Phase 02
  client.

### Web

- **Onboarding wizard** (full screen, 4-step progress, rendered by `AuthGate` until DONE):
  - Step 1, verified human: DEV badge and "World ID verification arrives in Phase 10".
  - Step 2, agent wallet: an animated "Creating your agent wallet…", then an address card
    with copy and explorer links, the policy status, and "This wallet belongs to your
    agent…".
  - Step 3, risk profile: three cards with their numbers, keyboard-navigable as a radio
    group.
  - Step 4, fund: address, QR code (`qrcode.react`, EIP-681 `ethereum:<addr>@<chainId>`),
    faucet links and a live "Waiting for your deposit…" pulse. It polls every 4 s and also
    listens to the trace stream. When funded it flips to "Received 0.05 ETH — your agent is
    ready" and auto-continues.
- **Cockpit Portfolio column:**
  - Total value and all-time P&L.
  - A token list (balance, price, value, P&L).
  - An LP placeholder.
  - A radial risk meter with drivers, and a factor breakdown in a tooltip.
  - The limits bar ("$X of $Y used today"), the price source, and loading, error, stale and
    empty states.
  - It polls every 15 s and refreshes on `receipt` and `tx` events.
- **Settings page:** account, agent wallet card (address, explorer link, policy badge),
  profile cards and a limits table. The Withdraw, Change profile and Change limits buttons
  are visible but disabled, with the tooltip "Needs World ID (coming in Phase 10)".

### Shared, docs, config

- **`@warden/shared`:** `EXECUTION_CONTRACTS` mirrors the MCP server's vendor-doc
  `chains.ts`, with a drift test. It also adds the faucet defaults and the PHASE 03 HTTP
  contract (`portfolio.ts`).
- **New env vars (all optional, all in `.env.example`):** `PRIVY_*`, `FAUCET_ETH_URL`,
  `FAUCET_USDC_URL`, `BALANCE_POLL_MS` and `BALANCE_POLL_INACTIVE_MS`. The API now also reads
  `EXECUTION_RPC_URL`, `TOKEN_ALLOWLIST_JSON` and `UNISWAP_UNIVERSAL_ROUTER_VERSION`.
- **Docs:** README, ARCHITECTURE and the Railway README are updated. The worker now also
  needs `MCP_URL` and `MCP_AUTH_TOKEN`.

## Decisions worth knowing

- **One Privy policy per wallet, not one shared policy.** The phase file shows a single
  cached policy. But the 0 ETH self-transfer the acceptance criteria require can only be
  allowed by naming the wallet's own address, and Privy has no "self" condition. Each policy
  is named from a hash of its rules, so it is still created only once and found again.
  Allowing zero-value transfers to any address would have been looser.
- **Withdrawals will need a policy update in P05.** Native ETH sent to an arbitrary address
  is blocked by this policy, as the phase file specifies. The P05 withdrawal flow will have
  to add a rule for approved recipients.
- **A real race found live.** React StrictMode runs effects twice in dev, so two wallet
  creates reached Privy at once. Privy answered `400 "Previous request with matching
idempotency key is still in progress"`, which surfaced as a 502. Two open tabs would hit
  the same thing in production. The fix:
  - The adapter now waits for the winning request and re-reads it.
  - The client fires the create once per mount.
  - Two tests cover it.
- **The risk meter's Danger floor.** In a pure weighted average, 80% of value out of range
  behind a Danger hook scored only 54 (Moderate). Since the policy engine refuses Danger
  hooks outright, any Danger exposure now floors the meter at High. The rule is documented
  in `risk.ts`.
- **Contract addresses are mirrored, not imported.** The API's production image does not
  ship the MCP package, so the addresses are copied into `@warden/shared` and a test fails if
  they drift. This is the same pattern Phase 02 used for schemas.

## Known limitations

- **Funding → DONE has not been seen live yet.** No onboarding wallet has received a deposit
  (see the partial criterion above). Wallet creation, policy attachment, server-side signing
  and broadcast (the smoke transaction), portfolio reads and pricing were all verified live.
- **Explained increases are never recorded as deposits.** An increase that lands within
  2 minutes of one of our own executions is treated as explained. A real deposit in that
  window will not get a `TokenLot`; the phase file specifies this. From P05, executions
  should record their expected balance changes.
- **P&L has no disposals yet.** Swaps add disposals in P05. Until then, outflows (gas only)
  are consumed FIFO at zero proceeds.
- **Drawdown uses daily points.** The 7-day high comes from `get_price_history` at a daily
  interval, so intraday highs are missed. It is cached 10 min. While the official subgraph
  is down, the StateView fallback serves it.
- **Inactivity is measured from API calls.** A user who keeps only the SSE stream open
  counts as active only while it reconnects, because `requireUser` runs on connect.
- Old test databases keep accumulating rows from the integration tests. This is harmless,
  but `runBalanceWatch` in the tests scans every wallet.
- The phase files are still not in the repo. This phase was built from
  `Downloads/warden-phases (1)/PHASE_00_CONTEXT.md` and the PHASE 03 copy in the
  conversation.
- **Leftover dev data.** The live runs created 3 Privy wallets in your Privy app and 3 dev
  users in the local database. One of those users, `phase3-e2e-26692`, was set to DONE by
  hand to screenshot the cockpit.

## Exact commands

```bash
# install / checks
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm build

# run (web :5173 · api :3001 · worker with balance watcher · MCP :3002)
docker compose up -d && pnpm db:migrate && pnpm dev
# then: http://localhost:5173 → dev sign-in → onboarding → fund the shown address on Sepolia

# LIVE Privy smoke (needs PRIVY_APP_ID, PRIVY_APP_SECRET, EXECUTION_RPC_URL in .env)
pnpm smoke:privy                 # dedicated smoke wallet; exits 2 with the address if unfunded
pnpm smoke:privy --user alice    # the agent wallet of dev user "alice"
pnpm smoke:privy --no-wait       # print the hash without waiting for the receipt

# focused tests
pnpm --filter @warden/api exec vitest run test/privy.test.ts test/onboarding.test.ts \
  test/balance-watcher.test.ts test/portfolio-math.test.ts
```
