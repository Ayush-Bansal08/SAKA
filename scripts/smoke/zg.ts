/* eslint-disable no-console -- Manual smoke CLI prints one line per model. */
/**
 * Live 0G smoke (PHASE 04): one call per model — planner, planner fallback, guard decisions,
 * explainer — printing X-Request-ID, trust mode and tee_verified. Needs ZG_* in .env and a
 * reachable DATABASE_URL (Inference rows are persisted like in the app). `pnpm smoke:zg`.
 */
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../../apps/api/src/config/env.js';
import { createPrisma } from '../../apps/api/src/lib/infra.js';
import { ZgClient, ZgError, type ZgResult } from '../../apps/api/src/modules/ai0g/client.js';
import { GUARD_QUESTIONS, renderGuardState } from '../../apps/api/src/modules/safety/guard.js';

process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
const env = loadEnv();
const prisma = createPrisma(env.DATABASE_URL);
const client = new ZgClient(env, prisma, { emit: async () => undefined });
const ctx = { userId: 'smoke', traceId: randomUUID() };
const hello = [{ role: 'user' as const, content: 'Reply with OK.' }];

const calls: [string, () => Promise<ZgResult>][] = [
  [
    'planner',
    () =>
      client.chat({
        ...ctx,
        role: 'PLANNER',
        model: client.model('PLANNER'),
        trustMode: 'private',
        allowFallback: false,
        messages: hello,
        maxTokens: 50,
      }),
  ],
  [
    'planner_fallback',
    () =>
      client.chat({
        ...ctx,
        role: 'PLANNER',
        model: client.model('PLANNER_FALLBACK'),
        trustMode: client.fallbackTrustMode,
        allowFallback: false,
        messages: hello,
        maxTokens: 50,
      }),
  ],
  [
    'guard',
    () =>
      client.decide({
        ...ctx,
        state: renderGuardState({
          intent: {
            type: 'swap_exact_in',
            tokenIn: { symbol: 'ETH' },
            tokenOut: { symbol: 'USDC' },
            amountIn: '0.0066',
            amountUsd: '20',
            reason: 'Swap $20 of ETH to USDC.',
          },
          prepared: { amountUsd: '20', tokenIn: 'ETH', tokenOut: 'USDC', priceImpactPct: 0.1 },
          tradeScore: { score: 92 },
          hook: null,
          simulation: { ok: true, steps: 1 },
        }),
        questions: GUARD_QUESTIONS,
      }),
  ],
  [
    'explainer',
    () =>
      client.chat({
        ...ctx,
        role: 'EXPLAINER',
        model: client.model('EXPLAINER'),
        trustMode: 'private',
        messages: hello,
        maxTokens: 50,
      }),
  ],
];

try {
  for (const [role, run] of calls) {
    try {
      const result = await run();
      console.log(
        JSON.stringify({
          role,
          model: result.zg.model,
          'X-Request-ID': result.zg.requestId,
          clientRequestId: result.zg.clientRequestId,
          trustMode: result.zg.trustMode,
          tee_verified: result.zg.teeVerified ?? null,
          provider: result.zg.provider ?? null,
          ...(role === 'guard' ? { answers: result.data.answers } : {}),
        }),
      );
    } catch (err) {
      const row =
        err instanceof ZgError && err.inferenceId
          ? await prisma.inference.findUnique({ where: { id: err.inferenceId } })
          : null;
      console.error(
        JSON.stringify({
          role,
          failed: true,
          error: row?.error ?? (err instanceof Error ? err.message : 'unknown'),
          'X-Request-ID': row?.zgRequestId ?? null,
          trustMode: row?.trustMode ?? null,
        }),
      );
      process.exitCode = 1;
    }
  }
} finally {
  await prisma.$disconnect();
}
