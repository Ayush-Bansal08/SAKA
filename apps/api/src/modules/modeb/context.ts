/**
 * Everything a detector may look at, read once per user per tick (PHASE 08 §1). Market reads are
 * shared by all users of a tick; slow reads are cached in Redis so a growing user base does not
 * multiply upstream calls. Reads that fail leave their fact empty, and a detector with a missing
 * fact simply does not fire: never a guess.
 */
import type { AgentWallet, Hook, User } from '@prisma/client';
import {
  Decimal,
  MODE_B,
  riskProfileSettings,
  type PortfolioResponse,
  type SuggestionDetector,
  type UniswapMcp,
} from '@warden/shared';
import { getAddress } from 'viem';
import { dayBoundsInZone, localTimeIn } from '../../lib/time.js';
import { hookWhatIf } from '../hooks/what-if.js';
import { isHookAddress } from '../safety/hookGate.js';
import { readPriceOverride } from '../triggers/service.js';
import { pairKey } from './detectors/util.js';
import type { ModeBDeps } from './suggestions.js';
import type { DetectorContext, HookExposure, HookStateFacts, MarketFacts } from './types.js';

const SYSTEM_CTX = { traceId: 'mode-b', userId: 'system', quiet: true } as const;

export const modebKeys = {
  ethSamples: 'modeb:eth:samples',
  value: (userId: string) => `modeb:value:${userId}`,
  usdc: (userId: string) => `modeb:usdc:${userId}`,
  outOfRange: (userId: string) => `modeb:oor:${userId}`,
  pools: (pair: string) => `modeb:pools:${pair}`,
  hookState: (hook: string) => `modeb:hookstate:${hook.toLowerCase()}`,
  cursor: 'modeb:cursor',
};

const HOUR_MS = 3_600_000;
const POOLS_TTL_S = 600;
const HOOK_STATE_TTL_S = 55;
const STATE_TTL_S = 30 * 86_400;
/** Gas of an LP move (decrease + mint), for the BETTER_POOL payback rule. */
const MOVE_GAS_UNITS = 800_000n;
const FALLBACK_GAS_PRICE_WEI = 1_000_000_000n;
const MAX_EXPOSED_HOOKS = 10;
const MAX_NEW_HOOK_QUOTES = 3;
const TRY_AMOUNT_USD = '100';

/** Closest sample to `target` inside the window, from a `ts:value` sorted set. */
async function sampleNear(
  deps: Pick<ModeBDeps, 'redis'>,
  key: string,
  target: number,
  windowMs: number,
): Promise<Decimal | null> {
  const rows = await deps.redis.zrangebyscore(key, target - windowMs, target + windowMs);
  let best: { gap: number; value: string } | null = null;
  for (const row of rows) {
    const [ts, value] = row.split(':') as [string, string];
    const gap = Math.abs(Number(ts) - target);
    if (value && (!best || gap < best.gap)) best = { gap, value };
  }
  return best ? new Decimal(best.value) : null;
}

async function addSample(
  deps: Pick<ModeBDeps, 'redis'>,
  key: string,
  now: number,
  value: Decimal,
  keepMs: number,
): Promise<void> {
  await deps.redis
    .multi()
    .zadd(key, now, `${now}:${value.toString()}`)
    .zremrangebyscore(key, 0, now - keepMs)
    .expire(key, Math.ceil((keepMs * 2) / 1000))
    .exec();
}

/** ETH facts for one tick. Samples are live prices only: an override must not poison history. */
export async function loadMarket(deps: ModeBDeps, now: Date): Promise<MarketFacts> {
  const [live, override] = await Promise.all([
    deps.prices.usd('ETH').catch(() => null),
    readPriceOverride(deps.redis, 'ETH').catch(() => null),
  ]);
  const fresh = live && !live.stale ? live.priceUsd : null;
  const ethPriceUsd = override ?? fresh;
  const ethHigh7dUsd = await deps.prices.high7d('ETH').catch(() => null);

  const t = now.getTime();
  if (fresh) await addSample(deps, modebKeys.ethSamples, t, fresh, 2 * HOUR_MS);
  const hourAgo =
    (await sampleNear(deps, modebKeys.ethSamples, t - HOUR_MS, 10 * 60_000)) ??
    (await deps.prices.change1hPct('ETH').catch(() => null))?.openUsd ??
    null;
  const ethChange1hPct =
    ethPriceUsd && hourAgo?.gt(0) ? ethPriceUsd.minus(hourAgo).div(hourAgo).times(100) : null;
  return { ethPriceUsd, ethHigh7dUsd, ethChange1hPct };
}

/** USDC outflow watch: a falling balance is an outflow, however it left the wallet. */
async function usdcFacts(
  deps: ModeBDeps,
  userId: string,
  token: PortfolioResponse['tokens'][number] | undefined,
  now: Date,
  track: boolean,
): Promise<DetectorContext['usdc']> {
  const key = modebKeys.usdc(userId);
  const state = await deps.redis.hgetall(key);
  const raw = BigInt(token?.balanceRaw ?? '0');
  const previous = state.raw !== undefined ? BigInt(state.raw) : null;
  let heldSince = state.heldSince ? new Date(state.heldSince) : null;
  let lastOutflowAt = state.outflowAt ? new Date(state.outflowAt) : null;
  if (track) {
    if (raw === 0n) heldSince = null;
    else if (!heldSince || previous === 0n) {
      // First sight: the oldest USDC lot is the best evidence of how long it has been here.
      const lot =
        previous === null && token
          ? await deps.prisma.tokenLot.findFirst({
              where: { userId, tokenAddress: { equals: token.address, mode: 'insensitive' } },
              orderBy: { createdAt: 'asc' },
              select: { createdAt: true },
            })
          : null;
      heldSince = lot?.createdAt ?? now;
    }
    if (previous !== null && raw < previous) lastOutflowAt = now;
    await deps.redis
      .multi()
      .del(key)
      .hset(key, {
        raw: raw.toString(),
        ...(heldSince ? { heldSince: heldSince.toISOString() } : {}),
        ...(lastOutflowAt ? { outflowAt: lastOutflowAt.toISOString() } : {}),
      })
      .expire(key, STATE_TTL_S)
      .exec();
  }
  return { balance: new Decimal(token?.balance ?? '0'), lastOutflowAt, heldSince };
}

/** Counts consecutive out-of-range checks; back in range (or gone) resets the count. */
async function outOfRangeFacts(
  deps: ModeBDeps,
  userId: string,
  positions: PortfolioResponse['lpPositions'],
  track: boolean,
): Promise<Record<string, number>> {
  const key = modebKeys.outOfRange(userId);
  const stored = await deps.redis.hgetall(key);
  const out: Record<string, number> = {};
  for (const p of positions) {
    const before = Number(stored[p.tokenId] ?? 0);
    out[p.tokenId] = p.inRange ? 0 : track ? before + 1 : before;
  }
  if (track) {
    const counts = Object.fromEntries(
      Object.entries(out)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => [k, String(n)]),
    );
    const multi = deps.redis.multi().del(key);
    if (Object.keys(counts).length) multi.hset(key, counts).expire(key, STATE_TTL_S);
    await multi.exec();
  }
  return out;
}

async function comparePools(
  deps: ModeBDeps,
  a: string,
  b: string,
): Promise<UniswapMcp.ToolOutput<'compare_pools'> | null> {
  const key = modebKeys.pools(pairKey(a, b));
  const cached = await deps.redis.get(key).catch(() => null);
  if (cached) return JSON.parse(cached) as UniswapMcp.ToolOutput<'compare_pools'>;
  const result = await deps.mcp
    .callTool(
      'compare_pools',
      { chainId: deps.env.EXECUTION_CHAIN_ID, tokenA: a, tokenB: b },
      SYSTEM_CTX,
    )
    .catch(() => null);
  if (result)
    await deps.redis.set(key, JSON.stringify(result), 'EX', POOLS_TTL_S).catch(() => undefined);
  return result;
}

async function moveGasUsd(deps: ModeBDeps, ethUsd: Decimal | null): Promise<Decimal | null> {
  if (!ethUsd) return null;
  const wei = (await deps.chain?.gasPrice?.().catch(() => null)) ?? FALLBACK_GAS_PRICE_WEI;
  return new Decimal((wei * MOVE_GAS_UNITS).toString()).div(new Decimal(10).pow(18)).times(ethUsd);
}

function snapshotFacts(s: {
  codeHash: string | null;
  implementation: string | null;
  owner: string | null;
  fees: unknown;
}): HookStateFacts {
  return {
    codeHash: s.codeHash,
    implementation: s.implementation,
    owner: s.owner,
    fees: (s.fees ?? {}) as Record<string, number>,
  };
}

async function liveHookState(
  deps: ModeBDeps,
  hookAddress: string,
  poolIds: string[],
): Promise<HookStateFacts | null> {
  const key = modebKeys.hookState(hookAddress);
  const cached = await deps.redis.get(key).catch(() => null);
  if (cached) return JSON.parse(cached) as HookStateFacts;
  const state = await deps.mcp
    .callTool(
      'get_hook_state',
      {
        chainId: deps.env.EXECUTION_CHAIN_ID,
        hookAddress: getAddress(hookAddress),
        ...(poolIds.length ? { poolIds: poolIds.slice(0, 20) as `0x${string}`[] } : {}),
      },
      SYSTEM_CTX,
    )
    .catch(() => null);
  if (!state) return null;
  const facts: HookStateFacts = {
    codeHash: state.codeHash,
    implementation: state.implementation,
    owner: state.owner,
    fees: Object.fromEntries(state.pools.map((p) => [p.poolId, p.lpFee])),
  };
  await deps.redis.set(key, JSON.stringify(facts), 'EX', HOOK_STATE_TTL_S).catch(() => undefined);
  return facts;
}

/**
 * Hooks the user is exposed to, each with the two states to compare: the last snapshot against the
 * chain, or, when the indexer already recorded a change in the last day, the last two snapshots.
 * Snapshots taken while get_hook_state failed carry no state, so they cannot be a baseline.
 */
async function hookExposures(deps: ModeBDeps, userId: string, now: Date): Promise<HookExposure[]> {
  const chainId = deps.env.EXECUTION_CHAIN_ID;
  const [positions, traded] = await Promise.all([
    deps.prisma.lpPosition.findMany({
      where: { userId, chainId, status: 'OPEN', hookAddress: { not: null } },
      select: { id: true, hookAddress: true, poolId: true },
    }),
    deps.prisma.actionPlan.findMany({
      where: {
        userId,
        status: 'EXECUTED',
        hookAddress: { not: null },
        createdAt: { gte: new Date(now.getTime() - 30 * 24 * HOUR_MS) },
      },
      select: { hookAddress: true },
      distinct: ['hookAddress'],
      take: MAX_EXPOSED_HOOKS,
    }),
  ]);
  const hooks = new Map<string, { address: string; positionIds: string[]; poolIds: string[] }>();
  const entry = (address: string) => {
    const key = address.toLowerCase();
    const found = hooks.get(key) ?? { address, positionIds: [], poolIds: [] };
    hooks.set(key, found);
    return found;
  };
  for (const p of positions) {
    if (!isHookAddress(p.hookAddress)) continue;
    const e = entry(p.hookAddress!);
    e.positionIds.push(p.id);
    e.poolIds.push(p.poolId);
  }
  for (const t of traded) if (isHookAddress(t.hookAddress)) entry(t.hookAddress!);

  const out: HookExposure[] = [];
  for (const h of [...hooks.values()].slice(0, MAX_EXPOSED_HOOKS)) {
    const row = await deps.prisma.hook.findUnique({
      where: { chainId_address: { chainId, address: getAddress(h.address) } },
      select: { id: true },
    });
    if (!row) continue;
    const [latest, older] = await deps.prisma.hookSnapshot.findMany({
      where: { hookId: row.id, permissionsBitmap: { not: null } },
      orderBy: { takenAt: 'desc' },
      take: 2,
    });
    if (!latest) continue;
    const base = { hookAddress: h.address, positionIds: h.positionIds };
    const live = await liveHookState(deps, h.address, h.poolIds);
    if (live) out.push({ ...base, previous: snapshotFacts(latest), current: live });
    if (older && now.getTime() - latest.takenAt.getTime() < 24 * HOUR_MS)
      out.push({ ...base, previous: snapshotFacts(older), current: snapshotFacts(latest) });
  }
  return out;
}

const symbolsOf = (p: Pick<PortfolioResponse, 'tokens' | 'lpPositions'>) => {
  const norm = (s: string) => (s.toUpperCase() === 'WETH' ? 'ETH' : s.toUpperCase());
  return new Set([
    ...p.tokens.filter((t) => t.balanceRaw !== '0').map((t) => norm(t.symbol)),
    ...p.lpPositions.flatMap((l) => [norm(l.token0.symbol), norm(l.token1.symbol)]),
  ]);
};

/** New Safe hooks on the user's pairs, quoted against the usual route (bounded per tick). */
async function newHooks(
  deps: ModeBDeps,
  userId: string,
  portfolio: Pick<PortfolioResponse, 'tokens' | 'lpPositions'>,
  seen: ReadonlySet<string>,
  now: Date,
): Promise<DetectorContext['newHooks']> {
  const chainId = deps.env.EXECUTION_CHAIN_ID;
  const rows: Hook[] = await deps.prisma.hook.findMany({
    where: {
      chainId,
      band: 'SAFE',
      firstSeenAt: { gte: new Date(now.getTime() - MODE_B.newHookMaxAgeDays * 24 * HOUR_MS) },
    },
    orderBy: { firstSeenAt: 'desc' },
    take: 20,
  });
  const fresh = rows.filter((h) => !seen.has(`newhook:${h.address.toLowerCase()}`));
  if (!fresh.length) return [];
  const pools = await deps.prisma.hookPool.findMany({
    where: { chainId, hookAddress: { in: fresh.map((h) => h.address) } },
  });
  const held = symbolsOf(portfolio);
  const norm = (s: string | null) =>
    s?.toUpperCase() === 'WETH' ? 'ETH' : (s?.toUpperCase() ?? '');
  const out: DetectorContext['newHooks'] = [];
  for (const hook of fresh) {
    if (out.length >= MAX_NEW_HOOK_QUOTES) break;
    const pool = pools.find(
      (p) =>
        p.hookAddress.toLowerCase() === hook.address.toLowerCase() &&
        held.has(norm(p.token0Symbol)) &&
        held.has(norm(p.token1Symbol)),
    );
    if (!pool) continue;
    const [a, b] = [norm(pool.token0Symbol), norm(pool.token1Symbol)] as [string, string];
    const whatIf = await hookWhatIf(
      {
        prisma: deps.prisma,
        mcp: deps.mcp,
        prices: deps.prices,
        executionChainId: chainId,
      },
      { chainId, address: hook.address, pair: `${a}-${b}`, amountUsd: TRY_AMOUNT_USD, userId },
    ).catch(() => null);
    // After gas when known: a hook that pays more but burns it in callbacks is not better.
    const better = whatIf?.netDifferencePct ?? whatIf?.differencePct ?? null;
    out.push({
      hookAddress: hook.address,
      pair: `${a}/${b}`,
      band: hook.band,
      score: hook.score,
      betterPct: better === null ? null : new Decimal(better),
      tryRequest: `Swap $5 ${a} to ${b} through hook ${hook.address}`,
    });
  }
  return out;
}

export interface ContextOptions {
  /** A real tick records state (out-of-range counts, USDC watch); a simulation only reads. */
  track: boolean;
  /** Skip reads no other detector needs (simulate-event, on-demand brief). */
  only?: SuggestionDetector;
}

/** Dedupe keys already used. Lifetime keys (hooks) are never forgotten; the rest last a week. */
async function seenKeys(deps: ModeBDeps, userId: string, now: Date): Promise<Set<string>> {
  const rows = await deps.prisma.suggestion.findMany({
    where: {
      userId,
      OR: [
        { createdAt: { gte: new Date(now.getTime() - 8 * 24 * HOUR_MS) } },
        { detector: { in: ['HOOK_CHANGED', 'NEW_HOOK'] } },
      ],
    },
    select: { dedupeKey: true },
    orderBy: { createdAt: 'desc' },
    take: 2000,
  });
  return new Set(rows.map((r) => r.dedupeKey));
}

export async function buildContext(
  deps: ModeBDeps,
  owner: { user: User; wallet: AgentWallet },
  portfolio: PortfolioResponse,
  market: MarketFacts,
  opts: ContextOptions,
): Promise<DetectorContext> {
  const { user } = owner;
  const now = deps.now?.() ?? new Date();
  const wants = (d: SuggestionDetector) => !opts.only || opts.only === d;
  const profile = riskProfileSettings(user.riskProfile);
  const limits = await deps.prisma.limits.findUnique({ where: { userId: user.id } });
  const seen = await seenKeys(deps, user.id, now);
  const usdcToken = portfolio.tokens.find((t) => t.symbol.toUpperCase() === 'USDC');
  const usdc = await usdcFacts(deps, user.id, usdcToken, now, opts.track);
  const outOfRangeChecks = await outOfRangeFacts(deps, user.id, portfolio.lpPositions, opts.track);

  const pools: DetectorContext['pools'] = {};
  const pairs = new Set<string>();
  if (wants('BETTER_POOL'))
    for (const p of portfolio.lpPositions) pairs.add(pairKey(p.token0.symbol, p.token1.symbol));
  if (wants('IDLE_USDC') && usdc.balance.gt(MODE_B.idleUsdcMinUsd))
    pairs.add(pairKey('ETH', 'USDC'));
  for (const pair of pairs) {
    const [a, b] = pair.split('/') as [string, string];
    const result = await comparePools(deps, a, b);
    if (result) pools[pair] = result;
  }

  const { day } = dayBoundsInZone(now, user.timezone);
  const local = localTimeIn(now, user.timezone);
  const needsHooks = wants('NEW_HOOK') || wants('MORNING_BRIEF');
  return {
    now,
    localDay: day,
    localHour: local.hour,
    localMinute: local.minute,
    profile,
    perActionUsd: new Decimal(limits?.perActionUsd.toString() ?? profile.perActionUsd),
    portfolio,
    market,
    usdc,
    outOfRangeChecks,
    pools,
    moveGasUsd:
      wants('BETTER_POOL') && portfolio.lpPositions.length
        ? await moveGasUsd(deps, market.ethPriceUsd)
        : null,
    newHooks: needsHooks ? await newHooks(deps, user.id, portfolio, seen, now) : [],
    hookExposures: wants('HOOK_CHANGED') ? await hookExposures(deps, user.id, now) : [],
    seen,
  };
}
