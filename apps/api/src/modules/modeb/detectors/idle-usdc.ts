/**
 * IDLE_USDC: more than $20 of USDC with no outflow for 24 h → provide liquidity in the best usable
 * pool, for min(USDC, perActionUsd). Without a usable pool it only tells the human.
 */
import { Decimal, MODE_B } from '@warden/shared';
import type { Detector } from '../types.js';
import { hookOrUndefined, pairKey, usd2 } from './util.js';

export const detectIdleUsdc: Detector = (ctx) => {
  const { balance, lastOutflowAt, heldSince } = ctx.usdc;
  if (balance.lte(MODE_B.idleUsdcMinUsd)) return null;
  const idleFrom = lastOutflowAt ?? heldSince;
  if (!idleFrom) return null;
  const idleMs = ctx.now.getTime() - idleFrom.getTime();
  if (idleMs < MODE_B.idleUsdcHours * 3_600_000) return null;
  const dedupeKey = `idle:${ctx.localDay}`;
  if (ctx.seen.has(dedupeKey)) return null;

  const hours = Math.floor(idleMs / 3_600_000);
  const summary = `$${usd2(balance)} of USDC has been idle for ${hours} hours.`;
  const comparison = ctx.pools[pairKey('ETH', 'USDC')];
  const usable = (comparison?.ranked ?? []).filter(
    (p) => p.usableOnExecutionChain && p.hookBand !== 'DANGER',
  );
  const pick =
    usable.find((p) => p.poolId === comparison?.recommended?.poolId) ?? usable[0] ?? null;
  const amount = Decimal.min(balance, ctx.perActionUsd);
  const facts = {
    usdcBalance: usd2(balance),
    idleHours: hours,
    depositUsd: usd2(amount),
    poolAprPct: pick?.adjustedAprPct ?? null,
  };
  if (!pick)
    return {
      detector: 'IDLE_USDC',
      dedupeKey,
      severity: 'INFO',
      title: `$${usd2(balance)} of USDC is idle`,
      summary: `${summary} No usable pool on this chain right now.`,
      facts,
      intent: null,
    };
  const hookAddress = hookOrUndefined(pick.hookAddress);
  return {
    detector: 'IDLE_USDC',
    dedupeKey,
    severity: 'NORMAL',
    title: `Put $${usd2(amount)} of idle USDC to work`,
    summary,
    facts,
    intent: {
      type: 'lp_open',
      token0: { symbol: 'ETH' },
      token1: { symbol: 'USDC' },
      amountUsd: usd2(amount),
      poolRef: { poolId: pick.poolId, ...(hookAddress ? { hookAddress } : {}) },
      reason: `Earn fees on idle USDC in the best usable ETH/USDC pool.`,
    },
  };
};
