# Uniswap Developer Feedback — Warden

Real developer feedback from building Warden (ETHGlobal Mumbai, Nov 5–7 2026) on the Uniswap
Trading API, LP API, v4 contracts, the v4 subgraph and `Uniswap/uniswap-ai` skills.

Humans fill in the first sections during the hackathon. The engineering log at the bottom is
appended to in every phase with concrete friction we hit, with the time and the workaround.

## Time to first quote

<!-- From "got an API key" to "first successful /quote response". Note the clock time. -->

## What worked

## Friction

## Docs gaps

## Feature requests

## Friction (engineering log)

<!-- Format: - **[PHASE NN] Area** — what happened → workaround / what would have helped. -->

- **[PHASE 01] Setup** — No Uniswap integration yet in this phase (monorepo, database, auth and
  trace foundation only). Entries start in PHASE 02 with the MCP server.
- **[Setup, 2026-11-06] Trading API on Base Sepolia** — `POST /v1/quote` for 0.001 ETH → USDC on
  84532 consistently returns HTTP 404 `UpstreamTimeoutError` ("may succeed on retry"). That held
  across 7 attempts and with `protocols` V2/V3/V4 and `routingPreference: BEST_PRICE`. The same
  request at the same time succeeds on Ethereum Sepolia, Unichain Sepolia and mainnet. A 404 plus
  a retryable-timeout message is misleading for a chain that can't be routed at all. A clear
  "no route / chain unavailable" error would have saved debugging time. → Switched to another
  testnet.
- **[Setup, 2026-11-06] Subgraph** — the official v4 subgraph (`DiYPVdyg…`, deployment `QmZsgJ…`)
  reports `hasIndexingErrors: true`, and every indexer rejects queries
  (`no attestation: indexing_error`), so even schema introspection fails. → Pulled
  `schema.graphql` from the deployment manifest on IPFS.
- **[Setup, 2026-11-06] Testnet prices** — 0.001 ETH quotes 26.35 USDC on Ethereum Sepolia and
  35.51 USDC on Unichain Sepolia, versus 2.25 USDC on mainnet (10–15× off). → USD values and
  limits must use mainnet reference prices, never testnet quotes.
- **[Setup, 2026-11-06] Unichain Sepolia liquidity** — quotes work, but 0.1 ETH → USDC has 5.7%
  price impact and 100 USDC → ETH has 6.4%. A V4-only quote returns `NoRouteFoundError`, even
  though `/lp/pool_info` reports V4 ETH/USDC pools. A pool that exists but can't be routed is
  confusing; liquidity depth in `pool_info` would help.
- **[Setup, 2026-11-06] Docs vs spec on LP host** — the LP guide says `/lp/*` lives on
  `https://liquidity.api.uniswap.org`, while the OpenAPI spec lists them under
  `https://trade-api.gateway.uniswap.org/v1`. Both hosts answered `/lp/pool_info` identically; the
  docs should name one canonical host.
- **[Setup, 2026-11-06] USDC addresses** — the supported-chains page lists routers but not the
  standard USDC per testnet. We had to look them up and verify them on-chain.
- **[Setup, 2026-11-06] Invalid key response** — a bad key returns 401 "Unauthenticated api key
  or session". It's clear, but the developer portal could say when a newly created key becomes
  active.
- **[PHASE 02, 2026-11-06] Universal Router version in the skill** — the swap-integration skill
  (v1.6.0) tells integrators to send `x-universal-router-version: 2.0` on every request, but the
  supported-chains page says support for 2.0 and 2.1.1 ended on 2026-10-21. → We pin `2.1.2`
  (configurable) and check the `/swap` target against the 2.1.2 address from the deployments page.
- **[PHASE 02] `/swap` body: "spread" vs `{ quote }`** — the skill insists "do NOT wrap the quote
  in `{quote: …}`, spread the response", while the OpenAPI `CreateSwapRequest` has a required
  `quote` property. Both describe the same wire shape (spreading the response yields `quote`), but
  they read as contradictory. → We send `{ quote, permitData?, signature? }` exactly as in the spec.
- **[PHASE 02] Chain ID types** — the skill says `tokenInChainId`/`tokenOutChainId` "must be
  strings", but the spec types `ChainId` as a number enum, and numbers work (verified in setup).
  → We send numbers, as in the spec.
- **[PHASE 02] `x-agent-info` rules differ** — the skill says all three fields are required and
  `integration_name` must be `"swap-integration"`. The spec says only `decision_origin` is required
  and `integration_name` should name _your_ integration. → We follow the skill
  (`swap-integration` / `lp-integration` plus the skill version), with `decision_origin` set from
  config.
- **[PHASE 02] LP `priceBounds.quotedTokenAddress`** — the lp-integration skill says it is required
  (omitting it returns 400), but it is missing from the OpenAPI `PositionPriceBounds`, and the LP
  guide's `/lp/create` examples omit it. → We compute tick bounds ourselves (snapped to the pool's
  tickSpacing) and send `tickBounds`. The response still returns `adjustedMinPrice/MaxPrice`.
- **[PHASE 02] LP contract gaps** — `kycRequiredWarnings` (skill) is not in `LPApprovalResponse`.
  `PoolReferenceByProtocol` lists `required: ["poolAddress"]`, but the only property is
  `referenceIdentifier`. The guide's prose spells `token0address` while the examples use
  `token0Address`. → Our types follow the spec plus the skill's additions.
- **[PHASE 02] v4 batch permit is not EIP-712-ready** — `v4BatchPermitData` arrives proto-encoded:
  `domain.chainId` is an enum name and every type is wrapped in `{ fields: [...] }`. The spec types
  it as a plain `object`, and only the skill documents the shape. → We normalise it for signing,
  derive `primaryType`, and send the original object back to `/lp/create`. A signing-ready shape
  (or a documented schema) would remove a whole class of bugs.
- **[PHASE 02] `/lp/pool_info` listing semantics** — `poolParameters.fee`/`tickSpacing` are
  described as "must be provided for V3 or V4", yet `pageSize`/`currentPage` suggest that pools for
  a pair can be listed. It is unclear whether hook pools for a pair can be listed without knowing
  the fee. → We try without a fee, then fall back to the standard hookless tiers.
- **[PHASE 02] `@uniswap/v4-sdk@2.4.1` ESM build fails in Node** — `import '@uniswap/v4-sdk'`
  throws `ERR_UNSUPPORTED_DIR_IMPORT`, because `dist/esm/src/index.js` does
  `export * from './entities'`. → We load the CJS build with `createRequire` (typed with
  `import type`). The SDK also pulls `hardhat` into the install tree through peer dependencies,
  which is heavy for an app.
- **[PHASE 02] Missing facts in the vendored docs** — the deployments page has no PoolManager
  deployment block (needed to scan `Initialize` logs), and no WETH for Sepolia. The CCA skill lists
  the Unichain _mainnet_ USDC (`0x078D…`) for Unichain Sepolia 1301. → We discover the start block
  with an `eth_getCode` binary search. Sepolia WETH and 1301 USDC are left unset and fail loudly
  (`NOT_CONFIGURED`).
- **[PHASE 02] Two hook risk scales** — the Security Framework (nine dimensions, 0–33; tiers
  0–6 / 7–17 / 18–33) and the v4-security-foundations skill (five categories, 0–33; tiers 0–5 /
  6–12 / 13–20 / 21–33) define different scores and cutoffs. Neither gives per-permission points
  (the skill gives "Permissions 0–14" without weights). Both are self-assessments, not something a
  third party can compute on-chain. → `score_hook` uses an explicit 100-point penalty model, with
  each rule citing its framework/skill section, and reports the §4 feature triggers plus an
  observable lower bound of the skill's score. An official, machine-checkable "integrator view"
  of hook risk would help agents a lot.
- **[PHASE 02, 2026-11-06, live smoke] Subgraph still unavailable** — the official v4 subgraph
  (`DiYPVdyg…`) still fails on every indexer (`BadResponse(no attestation: indexing_error)`; one
  indexer reports "too far behind"). Every market-data tool built on the official subgraph is down
  for integrators. → The tools return a labelled, retryable `SUBGRAPH_UNAVAILABLE`; hooks are
  found from PoolManager `Initialize` logs over RPC instead. A status page or a fallback endpoint
  for the official subgraph would help.
- **[PHASE 02, 2026-11-06, live smoke] Sepolia liquidity drift** — `/quote` for 0.001 ETH → USDC
  on Sepolia now routes through a 0.9% pool with 34% price impact (0.02–0.2% earlier the same day).
  Testnet routing quality changes from hour to hour, which makes testnet demos fragile. →
  Mainnet is used for reference prices; liquidity on the execution chain needs topping up before
  the demo.
- **[PHASE 02, 2026-11-06] Root cause of the v4 subgraph outage** — the indexers' `/status`
  endpoints all report the same deterministic, non-fatal mapping error in deployment
  `QmZsgJLiLQKpb8hxTmQ5LWyrFVvfWzVaL4WK8dfFBn7EeK` (subgraph `DiYPVdyg…`): `handleSwap` →
  `handleSwapHelper`, `src/mappings/swap.ts` line 39, "unexpected null", at block 26315771 (tx
  `0x25cb1ab8…2495`, 2026-10-31 22:36 UTC). That transaction is a contract creation which
  initialises two fee-0 ETH pools for brand-new tokens and swaps in them in the same transaction
  (pools `0x30899c9e…aaed`, `0x9c1d89af…efee`). `handleSwap` then appears to load a Pool/Token
  entity that does not exist. The subgraph keeps syncing, but it is flagged unhealthy, indexers
  refuse to attest, and every gateway query fails, including with `subgraphError: allow`. The
  current `main` of Uniswap/v4-subgraph has null-checks in `swap.ts`, so a patched mapping seems
  to exist but has not been deployed. → One hostile or odd transaction took down the official
  data source for every integrator for 5+ days. A null-safe `handleSwap` plus a redeploy fixes it;
  monitoring `hasIndexingErrors` would catch it.
- **[PHASE 05, 2026-11-06, live] `/swap` returns quantities as 0x-hex** — the `TransactionRequest`
  from `/swap` carries `value` (and gas fields) as hex strings such as `0x01954af8a2c000`, while
  the LP API returns decimal strings. Our validator expected decimal wei and rejected every native
  ETH swap the first time it ran end to end. → We now accept both and normalise to decimal
  (`packages/uniswap-agent-mcp/src/tx.ts`, `weiString`). Documenting the format in the OpenAPI
  `TransactionRequest` schema (or using one format across both APIs) would save integrators a bug.
- **[PHASE 05, 2026-11-06, live] `priceImpact` is misleading on split routes** — a $2 ETH → USDC
  quote on Sepolia (0.000894 ETH) reported `priceImpact: 95.89`, so our 5% hard limit refused it.
  Yet the same request gave the user the BEST output of any routing: 23.695 USDC with V2/V3/V4,
  against 23.413 USDC at 1.01% with `protocols: ["V4"]` and 23.370 USDC at 1.00% with V3 only. The
  route split 5% through ETH → UNI → USDC, where the testnet UNI/USDC pool's mid price is absurd
  (at mid that leg "should" return ~555 USDC; it returns 1.45). The API weighs each leg against
  its own mid price, so one junk leg makes the whole trade read as a 96% loss. At 0.0022 ETH the
  same pair reported 1.02%, so which number you get depends on how the router happens to split.
  Our earlier note blamed missing pool liquidity; that was wrong. → Fix
  (`packages/uniswap-agent-mcp/src/services/priceImpact.ts`, `services/quote.ts`
  `fetchBestClassicQuote`):
  1. Safety metric = the effective execution price of the whole quote (total out / total in, fees
     included) against the mid price of the deepest direct pool in the route (from
     `sqrtRatioX96`, or V2 reserves). On the quote above that is −0.19% (better than mid).
  2. When it is more than 1% worse than that mid, we quote again with `protocols` restricted to the
     main pool's protocol and keep whichever quote gives the user more.
  3. A real loss is still refused (> 5% effective). The API's raw `priceImpact` stays in the
     trade-score breakdown as evidence.

  What would have helped: a per-route or "versus best direct pool" impact in the `/quote`
  response, a note in the docs that `priceImpact` is computed per leg against each pool's own mid
  price, or a way to exclude pools whose price disagrees with the route's main pool.
