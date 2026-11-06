/**
 * BETTER_POOL: same pair, APR gap > 3 points and payback (move gas USD / extra daily fees) under
 * 7 days → move the position. APRs are the hook-adjusted ones, so a risky hook has to earn it.
 */
import { Decimal, MODE_B } from '@warden/shared';
import type { Detector } from '../types.js';
import { decimal, hookOrUndefined, isoWeek, pairKey, pct1, usd2 } from './util.js';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const detectBetterPool: Detector = (ctx) => {
  if (!ctx.moveGasUsd) return null;
  for (const p of ctx.portfolio.lpPositions) {
    const dedupeKey = `better:${p.tokenId}:${isoWeek(ctx.now)}`;
    if (ctx.seen.has(dedupeKey)) continue;
    const value = decimal(p.valueUsd);
    if (!value || value.lte(0)) continue;
    const comparison = ctx.pools[pairKey(p.token0.symbol, p.token1.symbol)];
    if (!comparison) continue;
    const currentApr = decimal(
      comparison.ranked.find((r) => same(r.poolId, p.poolId))?.adjustedAprPct,
    );
    if (!currentApr) continue;
    const candidates = comparison.ranked
      .filter(
        (r) => r.usableOnExecutionChain && r.hookBand !== 'DANGER' && !same(r.poolId, p.poolId),
      )
      .flatMap((r) => {
        const apr = decimal(r.adjustedAprPct);
        return apr ? [{ pool: r, apr }] : [];
      })
      .sort((a, b) => b.apr.cmp(a.apr));
    const best = candidates[0];
    if (!best) continue;
    const gapPts = best.apr.minus(currentApr);
    if (gapPts.lte(MODE_B.betterPoolAprGapPts)) continue;
    const extraDailyUsd = value.times(gapPts).div(100).div(365);
    if (extraDailyUsd.lte(0)) continue;
    const paybackDays = ctx.moveGasUsd.div(extraDailyUsd);
    if (paybackDays.gte(MODE_B.betterPoolPaybackDays)) continue;

    const hookAddress = hookOrUndefined(best.pool.hookAddress);
    const pair = `${p.token0.symbol}/${p.token1.symbol}`;
    const gap = pct1(gapPts);
    return {
      detector: 'BETTER_POOL',
      dedupeKey,
      severity: 'NORMAL',
      title: `A better ${pair} pool pays ${gap} points more`,
      summary: `Your ${pair} position earns ${pct1(currentApr)}% APR; another pool pays ${pct1(best.apr)}%.`,
      facts: {
        pair,
        currentAprPct: pct1(currentApr),
        candidateAprPct: pct1(best.apr),
        aprGapPts: gap,
        paybackDays: new Decimal(paybackDays).toDecimalPlaces(1).toString(),
        moveGasUsd: usd2(ctx.moveGasUsd),
      },
      intent: {
        type: 'lp_rebalance',
        positionId: p.id,
        targetPool: { poolId: best.pool.poolId, ...(hookAddress ? { hookAddress } : {}) },
        reason: `Move ${pair} to a pool paying ${gap} points more; pays back in under ${MODE_B.betterPoolPaybackDays} days.`,
      },
      prefill: `Move my ${pair} position (${p.id}) to the better pool`,
    };
  }
  return null;
};
