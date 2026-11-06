/**
 * PHASE 02 smoke for the Uniswap agent MCP server (live; uses real keys from the root .env):
 *   1. get_quote ETH → USDC on the execution chain
 *   2. get_quote ETH → USDC on Ethereum mainnet
 *   3. list_new_hooks (market scope)
 *   4. score_hook on the first hook returned
 *
 *   pnpm smoke:mcp            # in-process server (no need to start anything)
 *   pnpm smoke:mcp --http     # against the running server at MCP_URL (pnpm dev)
 *
 * Read-only: nothing is signed or broadcast. Exits 1 if any check fails.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../../packages/uniswap-agent-mcp/src/config.js';
import { createDeps } from '../../packages/uniswap-agent-mcp/src/context.js';
import { createLogger } from '../../packages/uniswap-agent-mcp/src/logger.js';
import {
  connectHttp,
  connectInProcess,
  coreSteps,
  exitCode,
  runSmoke,
} from '../../packages/uniswap-agent-mcp/scripts/smoke-lib.js';

const { values } = parseArgs({ options: { http: { type: 'boolean', default: false } } });
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
// Node 22 built-in; real environment variables win over the file.
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig({ LOG_LEVEL: 'warn', ...process.env });
const client = values.http
  ? await connectHttp(
      process.env.MCP_URL ?? 'http://localhost:3002/mcp',
      config.MCP_AUTH_TOKEN ?? '',
    )
  : await connectInProcess(createDeps(config, { log: createLogger('warn') }));

const steps = coreSteps(config.EXECUTION_CHAIN_ID, process.env.SMOKE_SWAPPER);
process.stdout.write(
  `MCP smoke — execution chain ${config.EXECUTION_CHAIN_ID} (${values.http ? 'HTTP' : 'in-process'})\n\n`,
);
const results = await runSmoke(client, steps, (line) => process.stdout.write(`${line}\n`));
await client.close();
process.exit(exitCode(steps, results));
