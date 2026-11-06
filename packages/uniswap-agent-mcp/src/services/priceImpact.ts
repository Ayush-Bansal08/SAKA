/**
 * Effective price impact of a CLASSIC quote.
 *
 * Why not just use the Trading API's `priceImpact`: on thin testnets the router may split a
 * small slice of a trade through a mispriced pool (e.g. 5% via ETH→UNI→USDC whose UNI/USDC mid
 * price is nonsense). The API then weighs that leg against its own absurd mid price and reports
 * ~96% impact, even when the whole quote gives the user the BEST output of any route. Live
 * example (Sepolia, 0.000894 ETH → USDC): split route 23.695 USDC at "95.89%"; V4-only route
 * 23.413 USDC at 1.01%.
 *
 * What we measure instead: the EFFECTIVE execution price of the whole quote
 * (total amountOut / total amountIn, fees included) against the mid price of the deepest direct
 * tokenIn→tokenOut pool in the route. A junk split that really costs the user value still shows
 * up here (the total output drops), so a > 5% loss is still refused; a split that only looks bad
 * by the API's per-leg arithmetic does not. The API's raw figure is kept alongside as evidence.
 *
 * Falls back to the API figure when the route has no direct single-hop pool with price data.
 *
 * Routing (services/quote.ts `fetchBestClassicQuote`): when the effective price is more than
 * REQUOTE_ABOVE_IMPACT_PCT worse than the main pool's mid, the quote is asked again restricted
 * to the main pool's protocol and the one better for the user is kept.
 */
import type { ClassicQuote } from '../clients/tradingApi.js';

export type PriceImpactMethod = 'effective_vs_main_pool' | 'api';

/** Effective price this much (percent) worse than the main pool's mid → try a single protocol. */
export const REQUOTE_ABOVE_IMPACT_PCT = 1;

export interface PriceImpact {
  /** Percent, ≥ 0, two decimals. null when neither method has data. */
  pct: number | null;
  method: PriceImpactMethod;
  /** The Trading API's own `priceImpact` (percent), unmodified. */
  apiPct: number | null;
  /** Main pool used as the reference (address / v4 pool id) when method = effective. */
  referencePool: string | null;
}

interface HopToken {
  address?: string;
}
interface Hop {
  type?: string;
  address?: string;
  tokenIn?: HopToken;
  tokenOut?: HopToken;
  sqrtRatioX96?: string;
  liquidity?: string;
  reserve0?: { token?: HopToken; quotient?: string };
  reserve1?: { token?: HopToken; quotient?: string };
}

const Q96 = 2 ** 96;
const lower = (a: string | undefined) => (a ?? '').toLowerCase();
const num = (v: string | undefined): number | null => {
  if (!v || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Mid price of one hop as raw tokenOut units per raw tokenIn unit, plus a depth measure. */
export function hopMid(hop: Hop): { mid: number; depth: number } | null {
  const tin = lower(hop.tokenIn?.address);
  const tout = lower(hop.tokenOut?.address);
  if (!tin || !tout || tin === tout) return null;

  if (hop.type === 'v2-pool') {
    const r0 = hop.reserve0;
    const r1 = hop.reserve1;
    const a0 = num(r0?.quotient);
    const a1 = num(r1?.quotient);
    if (a0 === null || a1 === null) return null;
    const t0 = lower(r0?.token?.address);
    const [rin, rout] = t0 === tin ? [a0, a1] : [a1, a0];
    return { mid: rout / rin, depth: Math.sqrt(a0 * a1) };
  }

  const sqrt = num(hop.sqrtRatioX96);
  const liquidity = num(hop.liquidity);
  if (sqrt === null || liquidity === null) return null;
  // sqrtPriceX96² / 2¹⁹² = raw token1 per raw token0; currency0 is the lower address
  // (native ETH, 0x0, is always currency0 in v4).
  const ratio = sqrt / Q96;
  const p1per0 = ratio * ratio;
  if (!Number.isFinite(p1per0) || p1per0 <= 0) return null;
  const zeroForOne = tin < tout;
  return { mid: zeroForOne ? p1per0 : 1 / p1per0, depth: liquidity };
}

export type RouteProtocol = 'V2' | 'V3' | 'V4';

/** The deepest direct tokenIn → tokenOut pool of a route, with its mid price. */
export interface MainPool {
  mid: number;
  depth: number;
  pool: string | null;
  protocol: RouteProtocol;
}

const protocolOf = (type: string | undefined): RouteProtocol =>
  type === 'v4-pool' ? 'V4' : type === 'v3-pool' ? 'V3' : 'V2';

/**
 * Deepest direct pool across one or more routes (single-hop paths only: every one of them
 * trades tokenIn → tokenOut). Depth is compared within the same pair, so L (v3/v4) and
 * √(r0·r1) (v2) are comparable.
 */
export function mainPool(routes: readonly (ClassicQuote['route'] | undefined)[]): MainPool | null {
  let best: MainPool | null = null;
  for (const route of routes)
    for (const path of route ?? []) {
      const hops = path as unknown as Hop[];
      if (hops.length !== 1) continue;
      const hop = hops[0]!;
      const m = hopMid(hop);
      if (m && (!best || m.depth > best.depth))
        best = { ...m, pool: hop.address ?? null, protocol: protocolOf(hop.type) };
    }
  return best;
}

/**
 * Effective impact of a quote (total out / total in, fees included) against `reference`
 * (default: the quote's own main pool). Falls back to the API figure without a reference.
 */
export function computePriceImpact(
  quote: Pick<ClassicQuote, 'route' | 'priceImpact'>,
  amountInRaw: bigint,
  amountOutRaw: bigint,
  reference: MainPool | null = mainPool([quote.route]),
): PriceImpact {
  const apiPct = typeof quote.priceImpact === 'number' ? quote.priceImpact : null;
  const fallback: PriceImpact = { pct: apiPct, method: 'api', apiPct, referencePool: null };
  if (amountInRaw <= 0n || amountOutRaw <= 0n || !reference) return fallback;

  const effective = Number(amountOutRaw) / Number(amountInRaw);
  const loss = (1 - effective / reference.mid) * 100;
  if (!Number.isFinite(loss)) return fallback;
  return {
    // Better than mid (negative) is reported as 0: there is no impact to penalise.
    pct: Math.max(0, Math.round(loss * 100) / 100),
    method: 'effective_vs_main_pool',
    apiPct,
    referencePool: reference.pool,
  };
}
