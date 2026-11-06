/**
 * Morning brief (PHASE 08 §2): portfolio and 24 h change, risk and its drivers, positions out of
 * range, new Safe hooks on the user's pairs, the top open suggestions and the active rules. 0GM
 * writes at most six lines; the template in the explainer covers any failure.
 */
import { Decimal, type PortfolioResponse } from '@warden/shared';
import type { MorningBriefData } from '../ai0g/explainer.js';
import { modebKeys } from './context.js';
import type { ModeBDeps } from './suggestions.js';
import type { DetectorContext } from './types.js';

const DAY_MS = 24 * 3_600_000;
const SAMPLE_EVERY_MS = 10 * 60_000;

/** Portfolio value history for the 24 h change (a sample every ten minutes, kept two days). */
export async function recordPortfolioValue(
  deps: Pick<ModeBDeps, 'redis'>,
  userId: string,
  totalUsd: string,
  now: Date,
): Promise<void> {
  const key = modebKeys.value(userId);
  const t = now.getTime();
  const last = await deps.redis.zrevrangebyscore(key, '+inf', t - SAMPLE_EVERY_MS, 'LIMIT', 0, 1);
  if (last.length) return;
  await deps.redis
    .multi()
    .zadd(key, t, `${t}:${totalUsd}`)
    .zremrangebyscore(key, 0, t - 2 * DAY_MS)
    .expire(key, Math.ceil((3 * DAY_MS) / 1000))
    .exec();
}

async function change24hPct(
  deps: Pick<ModeBDeps, 'redis'>,
  userId: string,
  totalUsd: string,
  now: Date,
): Promise<string | null> {
  const target = now.getTime() - DAY_MS;
  const rows = await deps.redis.zrangebyscore(
    modebKeys.value(userId),
    target - 2 * 3_600_000,
    target + 2 * 3_600_000,
  );
  const closest = rows
    .map((r) => r.split(':') as [string, string])
    .sort((a, b) => Math.abs(Number(a[0]) - target) - Math.abs(Number(b[0]) - target))[0];
  if (!closest) return null;
  const then = new Decimal(closest[1]);
  if (then.lte(0)) return null;
  const pct = new Decimal(totalUsd).minus(then).div(then).times(100).toDecimalPlaces(1);
  return `${pct.gt(0) ? '+' : ''}${pct.toString()}`;
}

export async function briefData(
  deps: ModeBDeps,
  userId: string,
  portfolio: PortfolioResponse,
  ctx: DetectorContext,
): Promise<MorningBriefData> {
  const now = ctx.now;
  const [open, rules, change] = await Promise.all([
    deps.prisma.suggestion.findMany({
      where: { userId, status: 'OPEN', actionPlanId: { not: null }, expiresAt: { gt: now } },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: 2,
      select: { title: true },
    }),
    deps.prisma.trigger.findMany({
      where: { userId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { summary: true },
    }),
    change24hPct(deps, userId, portfolio.totalUsd, now),
  ]);
  return {
    totalUsd: new Decimal(portfolio.totalUsd).toDecimalPlaces(2).toFixed(2),
    change24hPct: change,
    holdings: portfolio.tokens.slice(0, 5).map((t) => ({ symbol: t.symbol, valueUsd: t.valueUsd })),
    positions: portfolio.lpPositions.map((p) => ({
      label: `${p.token0.symbol}/${p.token1.symbol}`,
      inRange: p.inRange,
      valueUsd: p.valueUsd,
    })),
    risk: { label: portfolio.risk.label, drivers: portfolio.risk.drivers },
    newHooks: ctx.newHooks
      .filter((h) => h.band === 'SAFE')
      .map((h) => `${h.pair} (${h.score}/100)`),
    suggestions: open.map((s) => s.title),
    triggers: rules.map((r) => r.summary),
    ethPriceUsd: ctx.market.ethPriceUsd?.toDecimalPlaces(2).toFixed(2) ?? null,
  };
}
