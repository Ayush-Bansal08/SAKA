# PHASE 02 Report: Uniswap Agent MCP Server

**Scope:** `packages/uniswap-agent-mcp`, a standalone MCP server with 16 typed Uniswap tools. It
returns data and **unsigned** transactions only. This phase also includes the minimal API client,
the dev wiring, smoke scripts, docs and the uniswap-ai plugin mapping. Nothing from later phases
was built: no signing, broadcasting, policy, UI or 0G.

**Execution chain:** Ethereum Sepolia (`11155111`). Its USDC, `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`,
comes from the vendored uniswap-ai CCA skill. The phase prompt left the chain and USDC as
placeholders, so I used the values already decided in `.env` and `docs/ARCHITECTURE.md`.

## Acceptance criteria

- [x] **`pnpm --filter uniswap-agent-mcp test` passes, and `listTools` returns 16.** 134 tests
      pass. `test/protocol.test.ts` starts the real server over streamable HTTP on an ephemeral
      port and checks that `listTools()` returns exactly the 16 names in order, each with input and
      output JSON schemas. The same test checks that auth is required (401 without or with a wrong
      token), the per-token 429 limit, `/health`, and the in-memory (stdio-equivalent) transport.
- [x] **The smoke script returns a real quote on the execution chain and on mainnet** (run live
      on 2026-11-06 with the real keys, `pnpm tsx scripts/smoke/mcp.ts`):
  - Sepolia `get_quote`: **PASS**, 0.001 ETH → 39.50 USDC (34.38% price impact; see the warning
    below).
  - Mainnet `get_quote`: **PASS**, 0.001 ETH → 2.2366 USDC (0.13% impact, gas ≈ $0.015).
  - Market `list_new_hooks`: **FAIL, upstream.** The official v4 subgraph still returns
    `no attestation: indexing_error` from every indexer. The tool reports this correctly as
    `SUBGRAPH_UNAVAILABLE` (retryable). `score_hook` was therefore skipped in that script.
  - A real hook score, through the RPC path instead: `list_new_hooks` scope `execution` found 5
    hooks from Sepolia `Initialize` logs (30-day scan, 54 s). `score_hook` on the first,
    `0xFE8b…bFfF`, returned **30/100 DANGER**: all 14 permission bits including the return
    deltas, plus an EIP-1967 upgradeable proxy. Its source was verified through Etherscan v2, so
    there was no unverified penalty.
- [x] **Works in Claude Code via stdio.** I registered the server with the README's command
      (`claude mcp add uniswap-agent -e … -- node …/dist/index.js --transport stdio`, local scope,
      so the env values live in `~/.claude.json` and not in the repo). `claude mcp list` shows
      `✔ Connected`. A headless Claude Code session asked "list uniswap tools" listed **all 16
      tools** under `mcp__uniswap-agent__*`. Earlier, the MCP SDK `StdioClientTransport` against
      the built `dist/` also passed.
- [x] **Copied into the uniswap-ai fork and pushed.** Fork:
      <https://github.com/Ayush-Bansal08/uniswap-ai>, branch `feat/uniswap-agent-mcp`, commit
      `cbf152d`, plugin at
      [`packages/plugins/uniswap-agent-mcp`](https://github.com/Ayush-Bansal08/uniswap-ai/tree/feat/uniswap-agent-mcp/packages/plugins/uniswap-agent-mcp).
      What I added there:
  - the plugin itself, with tsconfig inlined, `gen:api` reading a bundled `spec/`, and the
    Warden-only Dockerfile and `sync:shared` removed;
  - a `.claude-plugin/marketplace.json` entry;
  - `docs/plugins/uniswap-agent-mcp.md` and a row in `docs/plugins/index.md`;
  - an updated `bun.lock`.

    Checks in the fork:

  - the fork's `validate-plugin.cjs` and `validate-docs.cjs` pass;
  - markdownlint reports 0 errors;
  - Prettier 2.8.8 was run with the fork's config;
  - `bun install --frozen-lockfile` succeeds;
  - in place, 134/134 tests pass, and typecheck and build pass.

    Not run: Vale (not installed) and a fork CI run (no PR was opened).
- [x] **No signing code in the package (enforced by a test).** `test/no-signing.test.ts` scans
      `src/` and `scripts/` with comments stripped for `privateKey`, `signTransaction`,
      `sendTransaction`, `signTypedData` and 7 related identifiers. It also checks that the
      generated file is types-only and that no wallet or signer dependencies are declared.
- [x] **FEEDBACK.md "Friction (engineering log)" updated.** It has 11 new PHASE 02 entries; see
      below.
- [x] **`PHASE_REPORT_02.md` written** (this file).

Repo-wide checks (all run from the root on the final tree):

| Check                | Result                                                                   |
| -------------------- | ------------------------------------------------------------------------ |
| `pnpm lint`          | 4/4 packages pass, 0 warnings                                            |
| `pnpm typecheck`     | 4/4 packages pass                                                        |
| `pnpm test`          | **209 passed**: uniswap-agent-mcp 134, api 43, shared 23, web 9          |
| `pnpm build`         | 4/4 packages build (MCP `tsc` → `dist/`)                                 |
| `pnpm format:check`  | clean                                                                    |
| `pnpm dev`           | web :5173, api :3001 (db + redis up), worker, **MCP :3002** `/health` OK |
| uniswap-ai validator | `scripts/validate-plugin.cjs` on this package: **Validation PASSED**     |

I also started the HTTP server with your real `.env` (it made no upstream calls). Results:
`/health` returns 200, a call without auth returns 401, the README's `curl … tools/list` returns
16 tools, and `tools/call plan_trigger` returns `structuredContent` and a summary.

## What was built

### `packages/uniswap-agent-mcp` (unscoped name `uniswap-agent-mcp`, bin `uniswap-agent-mcp`)

- **Transports.** Streamable HTTP is stateless (`POST /mcp`, JSON responses, a fresh McpServer
  per request with shared caches and clients). It needs `Authorization: Bearer` (compared in
  constant time) and has a per-token fixed-window rate limit (default 600/min). `GET /health` is
  public. stdio logs to stderr only. The CLI is `--transport http|stdio --port --host --env-file`.
- **16 tools**, one file each in `src/tools/`. Each has a Zod input and output schema in
  `src/schemas.ts` and returns `structuredContent` plus a one-line text summary. Errors are MCP
  tool errors with the text `{"error":{code,message,retryable}}`.
- **Clients:**
  - Trading API, typed through `openapi-fetch` with types generated by `openapi-typescript`
    from the vendored spec (`pnpm gen:api`, committed).
  - LP API, using the same generated contract plus the fields that only the skill documents.
  - v4 subgraph, with typed queries that always read `_meta` for lag.
  - viem `ChainReader` for multicall, V4Quoter via `simulateContract`, StateView,
    PositionManager, and `Initialize` logs.
  - Etherscan v2, optional.
  - Uniswap's unsupported-token list.
- **Resilience and caching.**
  - Every HTTP client has a 10 s timeout per attempt and up to 3 retries with exponential
    backoff and jitter on 429, 5xx and network errors.
  - LRU cache with TTLs taken from the phase file: quotes 15 s, reference prices 30 s, pool
    stats and hooks 5 min, metadata and the unsupported-token list 24 h.
  - Identical concurrent reads are de-duplicated into one request.
- **`chains.ts`.** Every address is copied from the vendored docs, each with its source tag.
  Missing values are `null` and fail with a loud `NOT_CONFIGURED`. Sepolia WETH is not in any
  vendored doc. The PoolManager start block is not in the docs either, so it is found by
  binary-searching `eth_getCode`.
- **Build flow.** It follows the `swap-integration` and `lp-integration` skills:
  - `READY` returns ordered `TxStep`s. `NEEDS_SIGNATURE` returns approval preSteps, viem-ready
    EIP-712 typed data, and a resumeToken.
  - The resumeToken is HMAC-SHA256 over base64url JSON, tied to the tool and to a hash of the
    arguments, valid for 120 s, and contains no secrets.
  - Each tx is checked: non-empty hex data, checksummed `to`/`from`, `from` equal to the
    owner/swapper, the chain ID, and `to` ∈ {Universal Router 2.1.2, PositionManager, token,
    Permit2}. Calldata is never modified.
- **Hook scoring.**
  - `hooks/permissions.ts` reads flags from the 14 `Hooks.sol` bits and attaches the skill's
    risk matrix.
  - `hooks/score.ts` runs the PHASE 02 minimum penalty set plus a HIGH-callback rule. Each rule
    cites its Security Framework or skill section and carries evidence.
  - The output also includes the framework's §4 feature triggers with their minimum actions,
    and an on-chain-observable lower bound of the skill's 0–33 score.
- **v4 math.** It uses `@uniswap/v4-sdk`: `Pool.getPoolId` (tested equal to
  `keccak256(abi.encode(PoolKey))`) and `Position` amounts and mint amounts. Uncollected fees come
  from StateView fee growth. Range presets are ±5/15/40%, snapped outward to the tick spacing and
  sent as `tickBounds`.
- **Docs:**
  - `README.md` (judge-facing): the unsigned-only rationale, a tool table with sources, a
    "Built from official Uniswap sources" section, the scoring table, the Claude Code stdio
    snippet, the HTTP curl example, and file pointers.
  - `PLUGIN.md`: how the package maps into a uniswap-ai fork.
  - Plugin manifests mirrored from `uniswap-cca`: `.claude-plugin/plugin.json`, `.mcp.json`,
    `project.json`, `CLAUDE.md`.
- `Dockerfile` and `deploy/railway/mcp.json`. The Railway README now has the `mcp` service steps.

### Shared and API

- `packages/shared/src/uniswap-mcp.ts` is a byte-for-byte mirror of the MCP `schemas.ts`,
  exported as `UniswapMcp`. A drift test fails on any difference; fix it with
  `pnpm --filter uniswap-agent-mcp sync:shared`.
- `apps/api/src/modules/mcp/client.ts` holds `UniswapMcpClient`, one per process, owned by
  `app.deps.mcp` and created when `MCP_AUTH_TOKEN` is set. It:
  - connects lazily over streamable HTTP with the bearer token, and reconnects once if the
    transport fails;
  - provides `callTool(name, args, { traceId, userId })`;
  - checks inputs against the shared schema before any network call;
  - checks outputs against the shared output schemas and the BuildResult consistency rules;
  - emits `tool_call` and `tool_result` trace events (`"Uniswap · get_quote"`, detail = the
    server summary), redacting signatures and resume tokens;
  - throws `McpToolCallError { code, retryable }` on failure.
- New env vars: `MCP_URL` (defaults to `http://localhost:3002/mcp`) and `MCP_AUTH_TOKEN`
  (optional; without it the API runs with Uniswap tools disabled). The log redaction list now
  covers `*.resumeToken` and `env.MCP_AUTH_TOKEN`.
- `apps/api/test/mcp-client.test.ts` runs the real MCP server in-process over HTTP. It covers a
  validated output with traces, tool-error mapping, input rejection, unauthorized → retryable,
  reconnect, an invalid-output rejection, redaction, and the `buildApp` wiring.
- `pnpm dev`: turbo picks up the MCP package's `dev` script (port 3002). `pnpm smoke:mcp` runs
  `scripts/smoke/mcp.ts`.

## Decisions worth knowing

- **Universal Router `2.1.2`, not the skill's `2.0`.** The supported-chains doc says 2.0 support
  ended on 2026-10-21. The version can be configured.
- **`/swap` body is `{ quote, permitData?, signature? }`.** This matches the OpenAPI spec and is
  equivalent to the skill's "spread". Permit fields are sent both together or not at all, and a
  `null` permit is never sent.
- **The LP range is sent as `tickBounds`.** The `priceBounds.quotedTokenAddress` field is
  required according to the skill but missing from the spec, so I avoided it.
- **v4 batch permit is normalised for signing**: numeric `chainId`, unwrapped `{fields}`, and a
  derived `primaryType`. The original permit object is what goes back to `/lp/create` (under
  `batchPermitData`).
- **`x-agent-info`** follows the skill (`swap-integration`/`lp-integration` + skill version).
  `decision_origin` defaults to `autonomous`, which suits Warden's AUTO policy. The plugin's
  `.mcp.json` sets `human_mediated` for Claude Code.
- **`@uniswap/v4-sdk` is loaded through `createRequire`**, because its ESM build fails in Node.
  `@uniswap/sdk-core` and `@uniswap/v3-sdk` are pinned to releases at least two weeks old with
  root `pnpm.overrides` (transitive resolution had pulled in a release from the previous day).
- **`plan_trigger`** is pure, except that it fetches one mainnet reference price for
  `price_change_pct` when the caller does not pass `referencePricesUsd`.
- **The dev script uses `node --watch --import tsx`, not `tsx watch`.** Under Turborepo on this
  Windows machine, `tsx watch` for this package sat idle before running any module code. The same
  command worked outside turbo. `node --watch` works under turbo and under root `pnpm dev`.

## FEEDBACK.md entries added (PHASE 02)

The skill still sends Universal Router 2.0 after its sunset. The skill and spec read differently
on the `/swap` body and on chain ID types. The `x-agent-info` rules differ between them.
`quotedTokenAddress` is missing from the spec. There are other LP contract gaps:
`kycRequiredWarnings`, the `PoolReferenceByProtocol` `required` mismatch, and `token0address`.
The proto-encoded v4 permit is undocumented in the spec. `/lp/pool_info` listing semantics are
unclear. The v4-sdk ESM build is broken and pulls in hardhat. Facts are missing from the vendored
docs (PoolManager start block, Sepolia WETH, a wrong 1301 USDC in the CCA skill). And there are
two incompatible 0–33 hook-risk scales.

## Known limitations

- **The official v4 subgraph is down upstream** (live check, 2026-11-06: `indexing_error` on
  every indexer). Until The Graph recovers, `get_price_history`, market `list_new_hooks` and the
  market half of `compare_pools` return `SUBGRAPH_UNAVAILABLE` (labelled, retryable). Quotes,
  hooks found from RPC logs, `score_hook`, positions and the build tools do not depend on it.
- **Sepolia ETH/USDC liquidity has thinned.** A 0.001 ETH quote now shows **34% price impact**,
  routed through a 0.9% pool. Phase 01 measured 0.02–0.2% on the same pair. The safety policy
  refuses anything above 5% impact, so swaps on Sepolia will be refused until liquidity returns.
  The options are to add liquidity to the testnet pool, or to revisit the execution chain before
  the demo.
- The 30-day `Initialize` scan on Sepolia takes about 55 s on the first call (then it is cached
  for 5 min).
- **zod across hosts.** Hosts that resolve a different zod major for the MCP SDK (the
  uniswap-ai fork gives the SDK zod 4) made TypeScript fail with TS2589 at `registerTool`. Fixed
  in `src/server.ts` by registering through a narrow signature. Runtime behaviour is unchanged,
  and outputs are still validated by our own schemas.
- Only CLASSIC routing is supported; UniswapX quotes are refused. LP positions can only be opened
  in existing v4 pools.
- On the execution chain, hook age and pool discovery come from the last 30 days of `Initialize`
  logs, unless `ETHERSCAN_API_KEY` is set. Finding the start block needs an archive-capable RPC.
  Your Alchemy URL should qualify, but that is unverified.
- Sepolia WETH is unset because it is not in the vendored docs. It only matters for v3 pools; add
  it through `TOKEN_ALLOWLIST_JSON` after checking it on-chain. Unichain Sepolia and Base Sepolia
  USDC are also unset.
- `check_token` estimates liquidity depth from the price impact of a $1k quote, assuming a
  constant-product pool.
- The `.env` still has the duplicate keys noted in Phase 01. They are harmless here.
- The MCP Docker image was built locally (see below). The API image was not rebuilt; its only
  change is a dev-only workspace dependency that `pnpm deploy --prod` excludes.
- The phase files are still not in the repo (`phases/` does not exist), and `PHASE_00_CONTEXT.md`
  was not available. This phase was built from the PHASE 02 copy in the conversation, the
  Phase 01 report and `docs/ARCHITECTURE.md`.

## Exact commands

```bash
# install / checks
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm build
pnpm --filter uniswap-agent-mcp test         # 134 tests, no network

# run
docker compose up -d && pnpm dev             # web :5173 · api :3001 · worker · MCP :3002/mcp
curl -s http://localhost:3002/health

# LIVE smoke (uses the root .env: UNISWAP_API_KEY, RPC URLs, THEGRAPH_API_KEY, MCP_RESUME_SECRET)
pnpm smoke:mcp                               # in-process: quotes on 11155111 + mainnet, market hooks, score_hook
pnpm smoke:mcp --http                        # same, against the running server at MCP_URL
pnpm --filter uniswap-agent-mcp smoke        # extended: + portfolio, check_token, compare_pools,
                                             #   price history, execution hooks, plan_trigger, unsigned build_swap
SMOKE_SWAPPER=0xYourAddress pnpm smoke:mcp   # quote for your own address

# Claude Code (stdio)
pnpm --filter uniswap-agent-mcp build
claude mcp add uniswap-agent -e UNISWAP_API_KEY=… -e EXECUTION_RPC_URL=… -e MAINNET_RPC_URL=… \
  -e THEGRAPH_API_KEY=… -e MCP_RESUME_SECRET=… -e UNISWAP_DECISION_ORIGIN=human_mediated \
  -- node "$(pwd)/packages/uniswap-agent-mcp/dist/index.js" --transport stdio

# maintenance
pnpm --filter uniswap-agent-mcp gen:api      # regenerate Trading API types from docs/vendor
pnpm --filter uniswap-agent-mcp sync:shared  # re-mirror schemas into packages/shared

# container
docker build -f packages/uniswap-agent-mcp/Dockerfile -t uniswap-agent-mcp .
```

## Addendum: market data that survives subgraph outages (2026-11-06)

**Root cause of the outage**, read from the 5 indexers' `/status` endpoints: deployment
`QmZsgJLiLQKpb8hxTmQ5LWyrFVvfWzVaL4WK8dfFBn7EeK` hit a deterministic, non-fatal mapping error,
`handleSwap` → `swap.ts:39` "unexpected null", at block 26315771 (tx `0x25cb1ab8…2495`,
2026-10-31). That transaction created two fee-0 ETH pools for new tokens and swapped in them
within the same transaction. The subgraph keeps syncing but is flagged unhealthy, so indexers
refuse to attest and every gateway query fails, including with `subgraphError: allow`. Only
Uniswap can fix it, with a null-safe mapping and a redeploy.

**What was built** (`src/market/`, 3 new clients, and 5 tools rewired):

| Capability                                                                  | Failover chain                                                                                                        |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Pools / TVL / APR (`compare_pools` market half)                             | official subgraph → **v4 pool registry subgraph + Uniswap LP API reserves** + GeckoTerminal 7d volume → GeckoTerminal |
| Price history (`get_price_history`)                                         | official subgraph → **v4 StateView at historical blocks** (archive RPC) → GeckoTerminal OHLCV                         |
| Hooks (`list_new_hooks` market, `score_hook` / `get_hook_state` on mainnet) | official subgraph → v4 pool registry → PoolManager `Initialize` logs (RPC)                                            |

- **Up-front health check.** The official subgraph is skipped while `_meta.hasIndexingErrors` is
  true; the check is cached for 5 min.
- **Cooldowns.** A failed source is skipped for 60 s (`MARKET_SOURCE_COOLDOWN_MS`), then retried.
- **Total failure.** When every source fails, the error is `MARKET_DATA_UNAVAILABLE` (retryable),
  with every source and its reason listed in `details.skipped`.
- **Labelled outputs.** Every output names the source it used (`source`, `source.provider`,
  `warnings`).
- **Diagnostics.** `pnpm check:sources` probes every source live and prints which one serves each
  capability.

**Verified:**

- **Tests:** 10 new offline tests (`test/market-failover.test.ts`) cover every fallback path,
  TVL and APR maths, the circuit breaker, and the all-down error. The MCP package has 144 tests,
  all passing.
- **`pnpm check:sources`, live:**
  - the official subgraph is DOWN (`hasIndexingErrors=true`);
  - the registry, LP API, archive RPC and GeckoTerminal are OK;
  - every capability has a healthy source.
- **Live end-to-end tools, with the official subgraph down:**
  - `get_price_history` ETH 24h: 25 points via StateView, $2,424.91 → $2,235.97, matching an
    independent on-chain check;
  - `compare_pools`: 20 mainnet pools with TVL, 7d volume and APR via the registry, the LP API
    and GeckoTerminal;
  - `list_new_hooks` market, `score_hook` (60/100 CAUTION, age from the registry) and
    `get_hook_state` (`poolDiscovery: registry`).

**Limits:**

- The pool registry is a community-listed deployment; I don't know who maintains it.
- GeckoTerminal is third-party and rate-limited (about 30 requests/min), and it is used last.
- On-chain price history returns the spot price at each period start (no intra-period high or
  low), and is capped at 200 points.
- The log fallback scans at most 30 days.
- `compare_pools` ranks by APR, so a tiny pool with an inflated APR can outrank deep pools. The
  live run recommended a fee-10000 pool with a 43% reference APR. This is the ranking rule the
  phase specified; a TVL floor for APR would be a sensible follow-up.
