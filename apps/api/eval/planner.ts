/* eslint-disable no-console -- Manual evaluation CLI prints its result table. */
/**
 * Live planner evaluation (PHASE 04 §6): runs every case in planner.cases.json against the real
 * 0G planner + MCP read tools, checks the intent kind and key parameters, and writes
 * docs/eval-planner.md. Manual (needs ZG_API_KEY, MCP and Postgres): `pnpm eval:planner`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CHAINS } from '@warden/shared';
import { loadEnv } from '../src/config/env.js';
import { createPrisma } from '../src/lib/infra.js';
import { createLogger } from '../src/lib/logger.js';
import { ZgClient } from '../src/modules/ai0g/client.js';
import { createUniswapMcpClient } from '../src/modules/mcp/client.js';
import { PriceService, REFERENCE_SWAPPER } from '../src/modules/portfolio/market.js';
import { plan, type PlanResult } from '../src/modules/agent/planner.js';
import {
  allowlistForPlanner,
  referencePrices,
  type PlannerContext,
} from '../src/modules/agent/context.js';
import { describeIntent } from '../src/modules/agent/describe.js';
import { executionTokens } from '../src/modules/wallet/tokens.js';

interface Case {
  row: string;
  text: string;
  expected: Record<string, unknown>;
  context?: Partial<PlannerContext>;
}

process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
const env = loadEnv();
const prisma = createPrisma(env.DATABASE_URL);
const log = createLogger(env, 'eval');
const trace = { emit: async () => undefined };
const client = new ZgClient(env, prisma, trace);
const mcp = createUniswapMcpClient(env, { trace, log });
if (!mcp) throw new Error('MCP_AUTH_TOKEN is required');
const prices = new PriceService(prisma, mcp, log);
const cases = JSON.parse(
  readFileSync(new URL('./planner.cases.json', import.meta.url), 'utf8'),
) as Case[];

const numeric = /^-?\d+(\.\d+)?$/;
/** Subset match; numeric strings compare by value ("2800" = "2800.00"), symbols case-insensitively. */
function matches(actual: unknown, expected: unknown, key = ''): boolean {
  if (expected !== null && typeof expected === 'object')
    return (
      actual !== null &&
      typeof actual === 'object' &&
      Object.entries(expected).every(([k, v]) =>
        matches((actual as Record<string, unknown>)[k], v, k),
      )
    );
  if (typeof expected === 'string' && typeof actual === 'string') {
    if (numeric.test(expected) && numeric.test(actual)) return Number(expected) === Number(actual);
    if (key === 'symbol' || key === 'recipient')
      return expected.toLowerCase() === actual.toLowerCase();
  }
  return actual === expected;
}
const summary = (r: PlanResult) =>
  r.kind === 'intent'
    ? `${r.intent.type}: ${describeIntent(r.intent)}`
    : `answer${r.needsClarification ? ' (clarify)' : ''}: ${r.text.replace(/\s+/g, ' ').slice(0, 80)}`;
const cell = (s: string) => s.replaceAll('|', '/').replaceAll('\n', ' ');

const tokens = executionTokens(env.EXECUTION_CHAIN_ID, env.TOKEN_ALLOWLIST_JSON);
const referencePricesUsd = await referencePrices(tokens, (symbol) => prices.usd(symbol));
const baseContext: PlannerContext = {
  chainId: env.EXECUTION_CHAIN_ID,
  chainName: CHAINS[env.EXECUTION_CHAIN_ID].name,
  wallet: REFERENCE_SWAPPER,
  quoteSwapper: REFERENCE_SWAPPER,
  riskProfile: 'BALANCED',
  limits: {
    perActionUsd: '25',
    perDayUsd: '100',
    usedTodayUsd: '0',
    remainingTodayUsd: '100',
    maxSlippagePct: 0.5,
  },
  portfolio: {
    totalUsd: '190',
    tokens: [
      { symbol: 'ETH', balance: '0.05', valueUsd: null },
      { symbol: 'USDC', balance: '40', valueUsd: '40' },
    ],
    riskLabel: 'Moderate',
  },
  referencePricesUsd,
  knownRecipients: [],
  activeTriggers: [],
  tokenAllowlist: allowlistForPlanner(tokens),
};
console.log('reference prices', referencePricesUsd);

const rows: { row: string; text: string; pass: boolean; ms: number; result: string }[] = [];
try {
  for (const item of cases) {
    const start = Date.now();
    try {
      const result = await plan(
        client,
        mcp,
        { userId: 'eval', traceId: randomUUID() },
        { ...baseContext, ...item.context },
        [{ role: 'user', content: item.text }],
      );
      rows.push({
        row: item.row,
        text: item.text,
        pass: matches(result, item.expected),
        ms: Date.now() - start,
        result: summary(result),
      });
    } catch (err) {
      rows.push({
        row: item.row,
        text: item.text,
        pass: false,
        ms: Date.now() - start,
        result: `error: ${err instanceof Error ? err.message : 'unknown'}`,
      });
    }
    const last = rows.at(-1)!;
    console.log(
      `${last.pass ? 'PASS' : 'FAIL'} ${String(last.ms).padStart(6)} ms  ${last.text}  →  ${last.result}`,
    );
  }
} finally {
  await mcp.close();
  await prisma.$disconnect();
}

const passed = rows.filter((r) => r.pass).length;
const sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
const pct = (p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
const rate = (100 * passed) / rows.length;
const report = `# Planner evaluation

Live run: ${new Date().toISOString()} · planner \`${env.ZG_MODEL_PLANNER}\` (private) · fallback \`${env.ZG_MODEL_PLANNER_FALLBACK}\` (${env.ZG_PLANNER_FALLBACK_TRUST_MODE}) · reasoning_effort \`${env.ZG_REASONING_EFFORT}\` · timeout ${env.ZG_PLANNER_TIMEOUT_MS} ms

**${passed}/${rows.length} passed (${rate.toFixed(1)}%)** — target ≥ 90%: **${rate >= 90 ? 'met' : 'not met'}**. Latency p50 ${pct(50)} ms · p95 ${pct(95)} ms.

Each case checks the result kind and its key parameters (types, tokens, amounts, recipient, trigger rule) — see \`apps/api/eval/planner.cases.json\`. Reference prices: ${
  Object.entries(referencePricesUsd)
    .map(([s, p]) => `${s} $${p}`)
    .join(', ') || 'unavailable'
}.

| Row | Request | Result | Latency ms | Output |
| --- | --- | --- | ---: | --- |
${rows.map((r) => `| ${r.row} | ${cell(r.text)} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.ms} | ${cell(r.result)} |`).join('\n')}
`;
writeFileSync(new URL('../../../docs/eval-planner.md', import.meta.url), report);
console.log(
  `\n${passed}/${rows.length} passed (${rate.toFixed(1)}%) · p50 ${pct(50)} ms · p95 ${pct(95)} ms`,
);
if (rate < 90) process.exitCode = 1;
