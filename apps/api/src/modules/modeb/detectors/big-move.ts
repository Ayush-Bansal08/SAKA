/**
 * BIG_MOVE: ETH moved ≥ ±5% in an hour → RED, with the impact on the portfolio in USD. A drop is
 * also a chance to buy: with enough USDC it buys the profile's dip amount, under the same limits
 * and the same "Dip buys" auto-act switch as DIP. One dip purchase a day, whichever rule makes it.
 */
import { Decimal, MODE_B, type ActionIntent } from '@warden/shared';
import type { Detector, DetectorContext } from '../types.js';
import { boughtDipToday, detectDip } from './dip.js';
import { decimal, hourKey, pct1, STABLES, usd2 } from './util.js';

function dropBuy(ctx: DetectorContext, dropPct: string): ActionIntent | null {
  const amount = new Decimal(ctx.profile.dipBuyUsd);
  if (ctx.usdc.balance.lt(amount) || boughtDipToday(ctx) || detectDip(ctx)?.intent) return null;
  return {
    type: 'swap_exact_in',
    tokenIn: { symbol: 'USDC' },
    tokenOut: { symbol: 'ETH' },
    amountIn: amount.toString(),
    amountUsd: amount.toString(),
    reason: `Buy the drop: ETH fell ${dropPct}% in the last hour.`,
  };
}

export const detectBigMove: Detector = (ctx) => {
  const change = ctx.market.ethChange1hPct;
  if (!change || change.abs().lt(MODE_B.bigMovePct)) return null;
  const hour = `bigmove:${hourKey(ctx.now)}`;
  if ([...ctx.seen].some((k) => k === hour || k.startsWith(`${hour}:`))) return null;

  // Everything that moves with the market: volatile tokens and LP positions.
  const tokensUsd = ctx.portfolio.tokens
    .filter((t) => !STABLES.has(t.symbol.toUpperCase()))
    .reduce((acc, t) => acc.plus(decimal(t.valueUsd) ?? 0), new Decimal(0));
  const exposedUsd = ctx.portfolio.lpPositions.reduce(
    (acc, p) => acc.plus(decimal(p.valueUsd) ?? 0),
    tokensUsd,
  );
  const impactUsd = exposedUsd.times(change).div(100);
  const up = change.gt(0);
  const move = `${up ? '+' : ''}${pct1(change)}%`;
  const impact = `${up ? '+' : '-'}$${usd2(impactUsd.abs())}`;
  const intent = up ? null : dropBuy(ctx, pct1(change.abs()));
  return {
    detector: 'BIG_MOVE',
    // The day in the key is what stops DIP buying again after this.
    dedupeKey: intent ? `${hour}:buy:${ctx.localDay}` : hour,
    severity: 'RED',
    title: intent
      ? `ETH ${move} in the last hour: buy $${usd2(new Decimal(ctx.profile.dipBuyUsd))}`
      : `ETH ${move} in the last hour`,
    summary: `ETH moved ${move} in an hour: about ${impact} on your $${usd2(exposedUsd)} of exposed holdings.`,
    facts: {
      changePct: pct1(change),
      impactUsd: impact,
      exposedUsd: usd2(exposedUsd),
      ethPriceUsd: ctx.market.ethPriceUsd ? usd2(ctx.market.ethPriceUsd) : null,
    },
    intent,
  };
};
