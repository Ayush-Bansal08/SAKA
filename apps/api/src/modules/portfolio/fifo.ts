/**
 * FIFO cost basis and P&L (PHASE 03 §4). Pure functions over bigint raw units and decimal.js
 * USD — no JS-number money anywhere.
 *
 * - Lots are consumed oldest first. A partially consumed lot keeps a pro-rata share of its cost.
 * - Realized P&L = disposal proceeds − cost of the units they consumed.
 * - The on-chain balance is the truth: if it is below what the tracked lots still hold (gas,
 *   or an outflow we did not record), the difference is consumed FIFO with zero proceeds.
 *   If it is above (a deposit not yet recorded), the excess has no cost basis and is left out
 *   of P&L instead of being counted as profit.
 */
import { Decimal } from '@warden/shared';

export interface Lot {
  amountRaw: bigint;
  costUsd: Decimal;
  at: Date;
}

export interface Disposal {
  amountRaw: bigint;
  proceedsUsd: Decimal;
  at: Date;
}

export interface FifoResult {
  /** What is still held, oldest first (partial lots pro-rated). */
  remaining: Lot[];
  realizedUsd: Decimal;
  /** Cost of every unit ever acquired (denominator of the P&L %). */
  totalCostUsd: Decimal;
  /** Units disposed that no lot covered (data gap; ignored for cost). */
  uncoveredRaw: bigint;
}

function sortByTime<T extends { at: Date }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.at.getTime() - b.at.getTime());
}

export function runFifo(lots: readonly Lot[], disposals: readonly Disposal[]): FifoResult {
  const queue: Lot[] = sortByTime(lots)
    .filter((l) => l.amountRaw > 0n)
    .map((l) => ({ ...l }));
  const totalCostUsd = queue.reduce((acc, l) => acc.plus(l.costUsd), new Decimal(0));
  let realizedUsd = new Decimal(0);
  let uncoveredRaw = 0n;

  for (const d of sortByTime(disposals)) {
    let left = d.amountRaw;
    let consumedCost = new Decimal(0);
    while (left > 0n && queue.length > 0) {
      const lot = queue[0]!;
      if (lot.amountRaw <= left) {
        consumedCost = consumedCost.plus(lot.costUsd);
        left -= lot.amountRaw;
        queue.shift();
      } else {
        const partCost = lot.costUsd.times(left.toString()).div(lot.amountRaw.toString());
        consumedCost = consumedCost.plus(partCost);
        lot.costUsd = lot.costUsd.minus(partCost);
        lot.amountRaw -= left;
        left = 0n;
      }
    }
    uncoveredRaw += left;
    // Proceeds attributable to the covered part only.
    const covered = d.amountRaw - left;
    const proceeds =
      d.amountRaw === 0n
        ? new Decimal(0)
        : d.proceedsUsd.times(covered.toString()).div(d.amountRaw.toString());
    realizedUsd = realizedUsd.plus(proceeds.minus(consumedCost));
  }

  return { remaining: queue, realizedUsd, totalCostUsd, uncoveredRaw };
}

export interface TokenPnlInput {
  lots: readonly Lot[];
  disposals: readonly Disposal[];
  balanceRaw: bigint;
  decimals: number;
  /** USD per whole token (null = unpriced). */
  priceUsd: Decimal | null;
  now?: Date;
}

export interface TokenPnlResult {
  costBasisUsd: Decimal;
  valueUsd: Decimal;
  unrealizedUsd: Decimal;
  realizedUsd: Decimal;
  pnlUsd: Decimal;
  /** Percent of total cost (null when nothing was ever acquired at a cost). */
  pct: Decimal | null;
  /** Units held beyond the tracked lots (no cost basis). */
  untrackedRaw: bigint;
}

export function tokenPnl(input: TokenPnlInput): TokenPnlResult | null {
  if (input.lots.length === 0 || input.priceUsd === null) return null;
  const first = runFifo(input.lots, input.disposals);
  const tracked = first.remaining.reduce((acc, l) => acc + l.amountRaw, 0n);

  // Reconcile with the chain: an unexplained shortfall is consumed FIFO at zero proceeds.
  const result =
    input.balanceRaw < tracked
      ? runFifo(input.lots, [
          ...input.disposals,
          {
            amountRaw: tracked - input.balanceRaw,
            proceedsUsd: new Decimal(0),
            at: input.now ?? new Date(),
          },
        ])
      : first;

  const heldRaw = result.remaining.reduce((acc, l) => acc + l.amountRaw, 0n);
  const costBasisUsd = result.remaining.reduce((acc, l) => acc.plus(l.costUsd), new Decimal(0));
  const valueUsd = new Decimal(heldRaw.toString())
    .div(new Decimal(10).pow(input.decimals))
    .times(input.priceUsd);
  const unrealizedUsd = valueUsd.minus(costBasisUsd);
  const pnlUsd = unrealizedUsd.plus(result.realizedUsd);
  const pct = result.totalCostUsd.isZero() ? null : pnlUsd.div(result.totalCostUsd).times(100);
  return {
    costBasisUsd,
    valueUsd,
    unrealizedUsd,
    realizedUsd: result.realizedUsd,
    pnlUsd,
    pct,
    untrackedRaw: input.balanceRaw > heldRaw ? input.balanceRaw - heldRaw : 0n,
  };
}

/** Decimal → API decimal string (6 dp, never "-0"). */
export function dec(value: Decimal, dp = 6): string {
  const rounded = value.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP);
  return rounded.isZero() ? '0' : rounded.toFixed();
}
