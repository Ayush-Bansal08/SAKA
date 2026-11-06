/**
 * Hook indexer (PHASE 07 §1). Every 5 minutes, per scope:
 *   market     mainnet hooks of the last 30 days (MCP list_new_hooks, limit 100)
 *   execution  hooks on the execution chain since the configured start block
 * Each hook and its pools are upserted. New or stale (> 1 h) hooks are rescored with the
 * deterministic `score_hook` and snapshotted with `get_hook_state`; a snapshot row is written the
 * first time and whenever something observable changed (score, code, implementation, owner,
 * permissions, pool fees). New hooks and score changes get a 0G explanation (0GM-1.0, private),
 * cached by score. New hooks emit a `detector` trace event; Mode B's NEW_HOOK and HOOK_CHANGED
 * detectors read the rows and snapshots written here.
 * Work per run is bounded so one slow upstream never stalls the worker.
 */
import type { Hook, Prisma, PrismaClient } from '@prisma/client';
import { Decimal, type UniswapMcp } from '@warden/shared';
import type { Redis } from 'ioredis';
import { getAddress } from 'viem';
import type { Logger } from '../../lib/logger.js';
import type { McpCallContext, UniswapMcpClient } from '../mcp/client.js';
import { hookRowData } from '../safety/hookGate.js';
import type { TraceBus } from '../trace/trace-bus.js';

export const HOOK_RESCORE_AFTER_MS = 60 * 60_000;
export const MAX_SCORES_PER_RUN = 40;
export const MAX_EXPLANATIONS_PER_RUN = 8;
/** Users notified of new hooks per run (live-activity events). */
const MAX_NOTIFIED_USERS = 200;
const SYSTEM_CTX: McpCallContext = { traceId: 'hook-indexer', userId: 'system', quiet: true };

export type HookExplain = (
  score: UniswapMcp.ToolOutput<'score_hook'>,
) => Promise<{ text: string; inferenceId: string | null }>;

export interface HookIndexDeps {
  prisma: PrismaClient;
  redis: Pick<Redis, 'get' | 'set'>;
  mcp: Pick<UniswapMcpClient, 'callTool'>;
  /** null without ZG_API_KEY: explanations stay empty until it is configured. */
  explain: HookExplain | null;
  traceBus: Pick<TraceBus, 'emit'>;
  executionChainId: number;
  log?: Pick<Logger, 'warn' | 'info'>;
  now?: () => Date;
}

export interface HookIndexResult {
  scope: 'market' | 'execution';
  seen: number;
  newHooks: number;
  scored: number;
  explained: number;
  snapshots: number;
  failures: number;
}

export const indexedAtKey = (scope: string) => `hooks:indexedAt:${scope}`;
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

interface Snapshot {
  score: number;
  band: Hook['band'];
  codeHash: string | null;
  implementation: string | null;
  owner: string | null;
  permissionsBitmap: number | null;
  fees: Record<string, number>;
}

/** Human-readable differences between two snapshots (what a user would care about). */
export function snapshotChanges(prev: Snapshot | null, next: Snapshot): string[] {
  if (!prev) return [];
  const out: string[] = [];
  const low = (v: string | null) => v?.toLowerCase() ?? null;
  if (prev.score !== next.score) out.push(`Score ${prev.score} → ${next.score}`);
  if (prev.band !== next.band) out.push(`Band ${prev.band} → ${next.band}`);
  if (low(prev.codeHash) !== low(next.codeHash)) out.push('Contract code changed');
  if (low(prev.implementation) !== low(next.implementation))
    out.push(`Implementation changed to ${next.implementation ?? 'none'}`);
  if (low(prev.owner) !== low(next.owner)) out.push(`Owner changed to ${next.owner ?? 'none'}`);
  if (prev.permissionsBitmap !== next.permissionsBitmap) out.push('Permissions changed');
  for (const [pool, fee] of Object.entries(next.fees)) {
    const before = prev.fees[pool];
    if (before !== undefined && before !== fee)
      out.push(`Pool ${pool.slice(0, 10)}… fee ${before / 10_000}% → ${fee / 10_000}%`);
  }
  return out;
}

function sumTvl(pools: UniswapMcp.ToolOutput<'list_new_hooks'>['hooks'][number]['pools']) {
  const known = pools.filter((p) => p.tvlUsd !== null);
  if (!known.length) return null;
  return known.reduce((a, p) => a.plus(new Decimal(p.tvlUsd!)), new Decimal(0));
}

export async function indexHooks(
  deps: HookIndexDeps,
  scope: 'market' | 'execution',
): Promise<HookIndexResult> {
  const now = deps.now?.() ?? new Date();
  const result: HookIndexResult = {
    scope,
    seen: 0,
    newHooks: 0,
    scored: 0,
    explained: 0,
    snapshots: 0,
    failures: 0,
  };
  const listed = await deps.mcp.callTool(
    'list_new_hooks',
    scope === 'market' ? { scope, sinceDays: 30, limit: 100 } : { scope, limit: 100 },
    SYSTEM_CTX,
  );
  const firstRun = !(await deps.redis.get(indexedAtKey(scope)));
  const fresh: { address: string; chainId: number; pair: string }[] = [];

  for (const h of listed.hooks) {
    result.seen += 1;
    const chainId = h.chainId;
    const address = getAddress(h.hookAddress);
    try {
      // Pools (cheap, always refreshed).
      for (const p of h.pools) {
        const data = {
          hookAddress: address,
          token0: getAddress(p.token0),
          token1: getAddress(p.token1),
          token0Symbol: p.token0Symbol,
          token1Symbol: p.token1Symbol,
          fee: p.fee,
          tickSpacing: p.tickSpacing,
          tvlUsd: p.tvlUsd,
          createdAtBlock: p.createdAtBlock ? BigInt(p.createdAtBlock) : null,
        };
        await deps.prisma.hookPool.upsert({
          where: { chainId_poolId: { chainId, poolId: p.poolId } },
          create: { chainId, poolId: p.poolId, ...data },
          update: data,
        });
      }
      const tvl = sumTvl(h.pools);
      const existing = await deps.prisma.hook.findUnique({
        where: { chainId_address: { chainId, address } },
      });
      const stale =
        !existing || now.getTime() - existing.lastCheckedAt.getTime() >= HOOK_RESCORE_AFTER_MS;
      if (!stale || result.scored >= MAX_SCORES_PER_RUN) {
        if (existing)
          await deps.prisma.hook.update({
            where: { id: existing.id },
            data: { tvlUsd: tvl?.toFixed(2) ?? existing.tvlUsd, poolCount: h.pools.length },
          });
        continue;
      }

      const scored = await deps.mcp.callTool(
        'score_hook',
        { chainId, hookAddress: address },
        SYSTEM_CTX,
      );
      const state = await deps.mcp
        .callTool(
          'get_hook_state',
          { chainId, hookAddress: address, poolIds: h.pools.slice(0, 20).map((p) => p.poolId) },
          SYSTEM_CTX,
        )
        .catch(() => null);
      result.scored += 1;
      const row = {
        ...hookRowData(scored, now),
        tvlUsd: tvl?.toFixed(2) ?? null,
        poolCount: h.pools.length,
        lastSnapshot: json({
          facts: scored.facts,
          framework: scored.framework,
          scoredAt: scored.scoredAt,
          state,
        }),
      };
      const hook = await deps.prisma.hook.upsert({
        where: { chainId_address: { chainId, address } },
        create: {
          chainId,
          address,
          ...row,
          ...(h.firstSeen ? { firstSeenAt: new Date(h.firstSeen) } : {}),
        },
        update: row,
      });
      if (!existing) {
        result.newHooks += 1;
        const p = h.pools[0];
        fresh.push({
          address,
          chainId,
          pair: p ? `${p.token0Symbol ?? '?'}/${p.token1Symbol ?? '?'}` : 'no pools yet',
        });
      }

      // Snapshot history: first sight and every observable change.
      const snap: Snapshot = {
        score: scored.score,
        band: scored.band,
        codeHash: state?.codeHash ?? scored.facts.codeHash,
        implementation: state?.implementation ?? scored.facts.proxy.implementation,
        owner: state?.owner ?? scored.facts.owner,
        permissionsBitmap: state?.permissionsBitmap ?? null,
        fees: Object.fromEntries((state?.pools ?? []).map((p) => [p.poolId, p.lpFee])),
      };
      const last = await deps.prisma.hookSnapshot.findFirst({
        where: { hookId: hook.id },
        orderBy: { takenAt: 'desc' },
      });
      const prev: Snapshot | null = last
        ? {
            score: last.score,
            band: last.band,
            codeHash: last.codeHash,
            implementation: last.implementation,
            owner: last.owner,
            permissionsBitmap: last.permissionsBitmap,
            fees: (last.fees ?? {}) as Record<string, number>,
          }
        : null;
      const changes = snapshotChanges(prev, snap);
      if (!last || changes.length) {
        await deps.prisma.hookSnapshot.create({
          data: {
            hookId: hook.id,
            takenAt: now,
            ...snap,
            fees: json(snap.fees),
            changes: json(changes),
          },
        });
        result.snapshots += 1;
      }

      // Explanation: new hook or score changed since the stored one (cached by score).
      if (
        deps.explain &&
        result.explained < MAX_EXPLANATIONS_PER_RUN &&
        (hook.explanationScore === null || hook.explanationScore !== scored.score)
      ) {
        const { text, inferenceId } = await deps.explain(scored);
        result.explained += 1;
        await deps.prisma.hook.update({
          where: { id: hook.id },
          data: {
            explanation: text,
            explanationInferenceId: inferenceId,
            // A template fallback is shown but retried on a later run.
            explanationScore: inferenceId ? scored.score : null,
          },
        });
      }
    } catch (err) {
      result.failures += 1;
      deps.log?.warn(
        {
          scope,
          hook: address,
          err: err instanceof Error ? err.message.slice(0, 200) : String(err),
        },
        'hook index failed for one hook',
      );
    }
  }

  // New-hook detector events (skipped on the very first import: everything is "new" then).
  if (!firstRun && fresh.length) {
    const users = await deps.prisma.user.findMany({
      where: { onboardingStep: 'DONE' },
      select: { id: true },
      // Most recently active humans first.
      orderBy: [{ lastAuthAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: MAX_NOTIFIED_USERS,
    });
    for (const f of fresh.slice(0, 10))
      for (const u of users)
        await deps.traceBus.emit({
          kind: 'detector',
          traceId: `hook-${f.chainId}-${f.address.toLowerCase()}`,
          userId: u.id,
          title: `New hook: ${f.address.slice(0, 6)}…${f.address.slice(-4)} (${f.pair})`,
          detail: `${scope === 'market' ? 'Ethereum mainnet' : 'Execution chain'} · scored and explained in the hooks explorer`,
          data: { chainId: f.chainId, hookAddress: f.address, scope },
        });
  }
  await deps.redis.set(indexedAtKey(scope), now.toISOString());
  deps.log?.info(result, 'hook index run');
  return result;
}
