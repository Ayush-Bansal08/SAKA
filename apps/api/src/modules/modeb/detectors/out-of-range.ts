/** OUT_OF_RANGE: an LP position out of range for ≥ 2 consecutive checks → re-range in place. */
import { MODE_B } from '@warden/shared';
import type { Detector } from '../types.js';

export const detectOutOfRange: Detector = (ctx) => {
  for (const p of ctx.portfolio.lpPositions) {
    if (p.inRange) continue;
    const checks = ctx.outOfRangeChecks[p.tokenId] ?? 0;
    if (checks < MODE_B.outOfRangeChecks) continue;
    const dedupeKey = `oor:${p.tokenId}:${ctx.localDay}`;
    if (ctx.seen.has(dedupeKey)) continue;
    const pair = `${p.token0.symbol}/${p.token1.symbol}`;
    return {
      detector: 'OUT_OF_RANGE',
      dedupeKey,
      severity: 'NORMAL',
      title: `Your ${pair} position is out of range`,
      summary: `Your ${pair} position stopped earning fees: the price left its range.`,
      facts: { pair, tokenId: p.tokenId, checks, valueUsd: p.valueUsd },
      intent: {
        type: 'lp_rebalance',
        positionId: p.id,
        reason: `Re-range ${pair} around the current price so it earns fees again.`,
      },
      prefill: `Rebalance my ${pair} position (${p.id})`,
    };
  }
  return null;
};
