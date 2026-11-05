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
- **[Setup, 2026-11-06] Invalid key response** — a bad key returns 401 "Unauthenticated api key
  or session". It's clear, but the developer portal could say when a newly created key becomes
  active.
