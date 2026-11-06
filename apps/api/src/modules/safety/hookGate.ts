/**
 * Hook gate (PHASE 05 §2): when a v4 hook pool is in the route or is the LP target, score the
 * hook with the deterministic MCP `score_hook` tool, cached in the `Hook` table and refreshed
 * when older than 1 h. The LLM never scores hooks; it only explains them (P07).
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { hookBand, type HookBand, type UniswapMcp } from '@warden/shared';
import { getAddress } from 'viem';
import type { McpCallContext, UniswapMcpClient } from '../mcp/client.js';

export const HOOK_CACHE_MAX_AGE_MS = 60 * 60_000;
const ZERO = '0x0000000000000000000000000000000000000000';

export interface HookVerdict {
  address: `0x${string}`;
  score: number;
  band: HookBand;
  cached: boolean;
}

export function isHookAddress(address: string | null | undefined): address is string {
  return Boolean(address) && address!.toLowerCase() !== ZERO;
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

export async function gateHook(
  deps: { prisma: PrismaClient; mcp: UniswapMcpClient; now?: () => Date },
  ctx: McpCallContext,
  chainId: number,
  hookAddress: string,
): Promise<HookVerdict> {
  const address = getAddress(hookAddress);
  const now = deps.now?.() ?? new Date();
  const cached = await deps.prisma.hook.findUnique({
    where: { chainId_address: { chainId, address } },
  });
  if (cached && now.getTime() - cached.lastCheckedAt.getTime() < HOOK_CACHE_MAX_AGE_MS)
    return { address, score: cached.score, band: hookBand(cached.score), cached: true };

  const scored = await deps.mcp.callTool('score_hook', { chainId, hookAddress: address }, ctx);
  const data = hookRowData(scored, now);
  await deps.prisma.hook.upsert({
    where: { chainId_address: { chainId, address } },
    create: { chainId, address, ...data },
    update: data,
  });
  return { address, score: scored.score, band: scored.band, cached: false };
}

/** Hook row columns from a score_hook result (shared with the hook indexer). */
export function hookRowData(scored: UniswapMcp.ToolOutput<'score_hook'>, now: Date) {
  return {
    flags: json(scored.enabledPermissions),
    permissions: json(scored.permissions),
    isProxy: scored.facts.proxy.kind !== null,
    implementation: scored.facts.proxy.implementation,
    owner: scored.facts.owner,
    verifiedSource: scored.facts.verifiedSource,
    codeHash: scored.facts.codeHash ?? '',
    score: scored.score,
    band: scored.band,
    scoreBreakdown: json(scored.breakdown),
    lastSnapshot: json({
      facts: scored.facts,
      framework: scored.framework,
      scoredAt: scored.scoredAt,
    }),
    lastCheckedAt: now,
    contractName: scored.facts.contractName,
    ageDays: scored.facts.ageDays,
  };
}
