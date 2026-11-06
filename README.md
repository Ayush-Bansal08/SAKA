# Warden

**A consumer AI DeFi agent for verified humans.** Sign in, get your own agent wallet, and ask in
plain English: "Swap $20 ETH to USDC", "Put $100 into ETH/USDC", "Is this hook safe?". The agent
plans with verified AI models on **0G**, builds transactions through our own **Uniswap** MCP
server, checks them through a safety layer, and executes them, or asks you first. Big moves always
need a fresh **World ID** verification.

> Without 0G the agent can't think, can't double-check its own trades, and there's no tamper-proof
> record of why it moved your money.

Built for ETHGlobal Mumbai (Nov 5–7, 2026). Execution happens on **one testnet** only. Ethereum
mainnet is used read-only for market data.

## Status

| Phase | Scope                                                                   | State   |
| ----- | ----------------------------------------------------------------------- | ------- |
| 01    | Monorepo, full DB schema, API & web shells, DEV identity, SSE trace bus | ✅ done |
| 02    | Uniswap agent MCP server (16 tools, unsigned-only) + API client         | ✅ done |
| 03    | Privy agent wallet, onboarding wizard, balance watcher, portfolio       | ✅ done |
| 04+   | 0G planner/guard, safety, execution, Mode B, World                      | planned |

See [`PHASE_REPORT_01.md`](PHASE_REPORT_01.md), [`PHASE_REPORT_02.md`](PHASE_REPORT_02.md) and
[`PHASE_REPORT_03.md`](PHASE_REPORT_03.md) for what was built and how it was verified, and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how it fits together.

## Quick start (local)

Requirements: Node.js 22 (`.nvmrc`), pnpm 9 (`corepack enable`), Docker.

```bash
cp .env.example .env            # then set ENCRYPTION_KEY and ADMIN_TOKEN (see comments)
pnpm install
docker compose up -d            # Postgres 16 (warden + warden_test) and Redis 7
pnpm db:migrate                 # apply Prisma migrations
pnpm dev                        # web :5173 · api :3001 · worker · Uniswap MCP :3002
```

Open <http://localhost:5173>, enter a name (for example `alice`), and choose **Continue (dev
identity)**. Onboarding then creates your agent's Privy server wallet (needs `PRIVY_APP_ID` /
`PRIVY_APP_SECRET`), lets you pick a risk profile, and waits for a testnet ETH deposit. The
worker detects it within about 15 s (needs the MCP server, `MCP_AUTH_TOKEN`) and opens the
cockpit, where **Live activity** shows **"Funded: … ETH"**.

Generate secrets:

```bash
openssl rand -base64 32   # ENCRYPTION_KEY
openssl rand -hex 32      # ADMIN_TOKEN
```

## Scripts

| Command               | What it does                                                                |
| --------------------- | --------------------------------------------------------------------------- |
| `pnpm dev`            | web + api + worker in parallel (Turborepo)                                  |
| `pnpm lint`           | ESLint (typescript-eslint, react-hooks)                                     |
| `pnpm typecheck`      | `tsc --noEmit` in every package                                             |
| `pnpm test`           | Vitest: shared, api (integration with Postgres/Redis), web                  |
| `pnpm build`          | Build shared, api and web                                                   |
| `pnpm db:migrate`     | `prisma migrate deploy` with the root `.env`                                |
| `pnpm db:migrate:dev` | Create a new migration after schema changes                                 |
| `pnpm db:studio`      | Prisma Studio                                                               |
| `pnpm db:seed`        | Connectivity check (creates no user data)                                   |
| `pnpm format`         | Prettier                                                                    |
| `pnpm smoke:mcp`      | LIVE: MCP quotes (testnet + mainnet), new hooks, hook score                 |
| `pnpm smoke:privy`    | LIVE: Privy agent wallet + policy, then a 0 ETH self-transfer (prints hash) |
| `pnpm check:sources`  | LIVE: health of every market-data source + which one serves each capability |

API tests use the separate `warden_test` database and Redis DB 1. Override them with
`TEST_DATABASE_URL` / `TEST_REDIS_URL`.

## Repository layout

```
apps/api                    Fastify API + BullMQ worker (+ Telegram bot in P08)
apps/web                    React 19 + Vite 6 + Tailwind 4 web app (Vercel)
packages/shared             Zod schemas and types shared by api, web and mcp
packages/uniswap-agent-mcp  Uniswap agent MCP server (P02, standalone; see its README)
docs/                       Architecture, demo script, vendor docs
deploy/railway/             Railway service configs
FEEDBACK.md                 Uniswap developer feedback
```

## Identity

Until PHASE 10, sign-in uses a clearly labelled **DEV identity provider** behind the
`IdentityProvider` interface: the same name always signs in as the same human, which models
"one human = one agent". An amber banner, "DEV identity — World ID arrives in Phase 10", is
always visible while it is active. The API **refuses to start** if dev providers are configured
with `NODE_ENV=production`.

## Sponsor integrations

- **0G**: verified/private inference with request IDs on every reply, plus a decision log on
  0G Storage (from PHASE 04 / 07).
- **Uniswap**: our own MCP server in `packages/uniswap-agent-mcp` (from PHASE 02), also published
  as a `uniswap-ai` plugin in our fork: <https://github.com/Ayush-Bansal08/uniswap-ai/tree/feat/uniswap-agent-mcp/packages/plugins/uniswap-agent-mcp>. Developer
  feedback is in [`FEEDBACK.md`](FEEDBACK.md).
- **Privy**: agent wallets are app-controlled server wallets with a per-wallet policy that only
  allows Uniswap contracts, Permit2 and allowlisted tokens. Every Privy call is in
  [`apps/api/src/modules/wallet/privy.ts`](apps/api/src/modules/wallet/privy.ts).
- **World**: World ID Agent Pass for sign-in and step-up approvals (PHASE 10).

## License

[MIT](LICENSE)
