/** PROFIT: any token position at ≥ +12% P&L → sell 25% of it to USDC. */
import { Decimal, MODE_B } from '@warden/shared';
import type { Detector } from '../types.js';
import { decimal, pct1, STABLES, usd2 } from './util.js';

export const detectProfit: Detector = (ctx) => {
  for (const t of ctx.portfolio.tokens) {
    const symbol = t.symbol.toUpperCase();
    if (STABLES.has(symbol)) continue;
    const pnlPct = decimal(t.pnl?.pct);
    if (!pnlPct || pnlPct.lt(MODE_B.profitPct)) continue;
    const dedupeKey = `profit:${symbol}:${ctx.localDay}`;
    if (ctx.seen.has(dedupeKey)) continue;
    const amountIn = new Decimal(t.balance)
      .times(MODE_B.profitSellPct)
      .div(100)
      .toDecimalPlaces(Math.min(t.decimals, 8), Decimal.ROUND_DOWN);
    if (amountIn.lte(0)) continue;
    const price = decimal(t.priceUsd);
    const usd = price ? amountIn.times(price) : null;
    return {
      detector: 'PROFIT',
      dedupeKey,
      severity: 'NORMAL',
      title: `${symbol} is up ${pct1(pnlPct)}%: sell ${MODE_B.profitSellPct}%`,
      summary: `Your ${symbol} position is up ${pct1(pnlPct)}%.`,
      facts: {
        symbol,
        pnlPct: pct1(pnlPct),
        sellPct: MODE_B.profitSellPct,
        sellAmount: amountIn.toString(),
        sellUsd: usd ? usd2(usd) : null,
      },
      intent: {
        type: 'swap_exact_in',
        tokenIn: { symbol },
        tokenOut: { symbol: 'USDC' },
        amountIn: amountIn.toString(),
        ...(usd ? { amountUsd: usd2(usd) } : {}),
        reason: `Take profit: sell ${MODE_B.profitSellPct}% of ${symbol}, up ${pct1(pnlPct)}%.`,
      },
    };
  }
  return null;
};
