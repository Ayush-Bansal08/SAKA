/** DIP: ETH ≤ 0.90 × its 7-day high → buy `dipBuyUsd` with USDC, or say so if there is none. */
import { Decimal, MODE_B } from '@warden/shared';
import type { Detector, DetectorContext } from '../types.js';
import { pct1, usd2 } from './util.js';

/** A dip purchase was already made today, by this rule or by BIG_MOVE. */
export const boughtDipToday = (ctx: DetectorContext) =>
  [...ctx.seen].some((k) => k === `dip:${ctx.localDay}` || k.endsWith(`:buy:${ctx.localDay}`));

export const detectDip: Detector = (ctx) => {
  const { ethPriceUsd: price, ethHigh7dUsd: high } = ctx.market;
  if (!price || !high || price.gt(high.times(MODE_B.dipRatio))) return null;
  const dedupeKey = `dip:${ctx.localDay}`;
  if (boughtDipToday(ctx)) return null;

  const amount = new Decimal(ctx.profile.dipBuyUsd);
  const dropPct = high.minus(price).div(high).times(100);
  const facts = {
    ethPriceUsd: usd2(price),
    high7dUsd: usd2(high),
    dropPct: pct1(dropPct),
    buyUsd: usd2(amount),
    usdcBalance: usd2(ctx.usdc.balance),
  };
  const drop = `ETH is $${usd2(price)}, ${pct1(dropPct)}% below its 7-day high of $${usd2(high)}`;
  if (ctx.usdc.balance.lt(amount))
    return {
      detector: 'DIP',
      dedupeKey,
      severity: 'INFO',
      title: `ETH dipped ${pct1(dropPct)}%`,
      summary: `${drop}. You hold too little USDC for your $${usd2(amount)} dip buy.`,
      facts,
      intent: null,
    };
  return {
    detector: 'DIP',
    dedupeKey,
    severity: 'NORMAL',
    title: `ETH dipped ${pct1(dropPct)}%: buy $${usd2(amount)}`,
    summary: `${drop}.`,
    facts,
    intent: {
      type: 'swap_exact_in',
      tokenIn: { symbol: 'USDC' },
      tokenOut: { symbol: 'ETH' },
      amountIn: amount.toString(),
      amountUsd: amount.toString(),
      reason: `Buy the dip: ETH is ${pct1(dropPct)}% below its 7-day high.`,
    },
  };
};
