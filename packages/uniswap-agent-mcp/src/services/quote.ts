/**
 * Classic (AMM) quotes through the Trading API `/quote` (swap-integration skill, Step 2).
 * We restrict `protocols` to V2/V3/V4 so routing is always CLASSIC (never UniswapX), which
 * the spec only allows together with `routingPreference: BEST_PRICE`.
 */
import { getAddress, type Address } from 'viem';
import { amountOf } from '../amounts.js';
import { cacheKey, TTL } from '../cache.js';
import type { ClassicQuote, QuoteRequest, QuoteResponse, Schemas } from '../clients/tradingApi.js';
import type { ToolDeps } from '../context.js';
import { McpToolError } from '../errors.js';
import { isZeroHook } from '../hooks/permissions.js';
import type { GetQuoteOutput, TokenInfo } from '../schemas.js';
import {
  computePriceImpact,
  mainPool,
  REQUOTE_ABOVE_IMPACT_PCT,
  type PriceImpact,
  type RouteProtocol,
} from './priceImpact.js';

/** Quotes go stale fast (skill "Quote Freshness": typically 30 s). */
export const QUOTE_FRESHNESS_MS = 30_000;
/** Neutral swapper for reference-price quotes (no balance/approval needed for /quote). */
export const REFERENCE_SWAPPER: Address = '0x000000000000000000000000000000000000dEaD';

export interface ClassicQuoteParams {
  chainId: number;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountRaw: bigint;
  type: 'EXACT_INPUT' | 'EXACT_OUTPUT';
  swapper: Address;
  slippagePct?: number;
  recipient?: Address;
  /** Restrict routing to these protocols (default V2/V3/V4 — always CLASSIC). */
  protocols?: RouteProtocol[];
}

/** Slippage: percentage with at most two decimals (spec `slippageTolerance` pattern). */
export function normalizeSlippage(pct: number): number {
  return Math.round(pct * 100) / 100;
}

export function buildQuoteRequest(p: ClassicQuoteParams): QuoteRequest {
  if (p.amountRaw <= 0n) {
    throw new McpToolError('INVALID_INPUT', 'Amount must be greater than zero', {
      retryable: false,
    });
  }
  const request: QuoteRequest = {
    type: p.type,
    amount: p.amountRaw.toString(),
    tokenInChainId: p.chainId as Schemas['ChainId'],
    tokenOutChainId: p.chainId as Schemas['ChainId'],
    tokenIn: p.tokenIn.address,
    tokenOut: p.tokenOut.address,
    swapper: p.swapper,
    protocols: p.protocols?.length ? [...p.protocols] : ['V2', 'V3', 'V4'],
    routingPreference: 'BEST_PRICE',
  };
  if (p.slippagePct !== undefined) request.slippageTolerance = normalizeSlippage(p.slippagePct);
  if (p.recipient && getAddress(p.recipient) !== getAddress(p.swapper))
    request.recipient = p.recipient;
  return request;
}

export async function fetchClassicQuote(
  deps: ToolDeps,
  p: ClassicQuoteParams,
  options: { cache?: boolean } = {},
): Promise<{ response: QuoteResponse; quote: ClassicQuote }> {
  const body = buildQuoteRequest(p);
  const run = () => deps.trading.quote(body);
  const response = options.cache
    ? await deps.cache.wrap(cacheKey('quote', body), TTL.quote, run)
    : await run();
  if (response.routing !== 'CLASSIC') {
    throw new McpToolError(
      'UNSUPPORTED_ROUTING',
      `The Trading API returned routing ${response.routing}; only CLASSIC (AMM) routes are supported.`,
      { retryable: false, details: { routing: response.routing } },
    );
  }
  return { response, quote: response.quote as ClassicQuote };
}

/** Price impact of the kept quote, plus what the single-protocol re-quote did. */
export interface QuoteImpact extends PriceImpact {
  requote: { protocol: RouteProtocol; kept: 'original' | 'single_protocol' } | null;
}

/** Gas cost in the quoted currency's base units (0 when the API did not say). */
export function gasInQuoted(quote: Pick<ClassicQuote, 'gasFeeQuote'>): bigint {
  const g = (quote as { gasFeeQuote?: unknown }).gasFeeQuote;
  return typeof g === 'string' && /^\d+$/.test(g) ? BigInt(g) : 0n;
}

function totals(p: ClassicQuoteParams, quote: ClassicQuote): { inRaw: bigint; outRaw: bigint } {
  return {
    inRaw: BigInt(quote.input?.amount ?? (p.type === 'EXACT_INPUT' ? p.amountRaw : 0n)),
    outRaw: BigInt(quote.output?.amount ?? (p.type === 'EXACT_OUTPUT' ? p.amountRaw : 0n)),
  };
}

const usesPool = (quote: ClassicQuote, pools: ReadonlySet<string>) =>
  (quote.route as { address?: string }[][] | undefined)?.some((path) =>
    path.some((hop) => pools.has((hop.address ?? '').toLowerCase())),
  ) ?? false;

/**
 * Execution-chain routing with a known-bad pool list. Testnet routers favour pools that quote well
 * and then revert, or junk multi-hops, and which side is healthy differs by direction, so no
 * single protocol is right. Each protocol is quoted on its own: blocked pools are dropped, a route
 * within REQUOTE_ABOVE_IMPACT_PCT of its mid beats one that is not, and among equals the better
 * price wins. A real loss is not hidden: with only bad routes left, the policy still sees it.
 */
async function fetchCleanestClassicQuote(
  deps: ToolDeps,
  p: ClassicQuoteParams,
  options: { cache?: boolean },
  blocked: ReadonlySet<string>,
): Promise<{ response: QuoteResponse; quote: ClassicQuote; impact: QuoteImpact }> {
  const attempts = await Promise.allSettled(
    (['V3', 'V4'] as const).map(async (protocol) => {
      const got = await fetchClassicQuote(deps, { ...p, protocols: [protocol] }, options);
      const t = totals(p, got.quote);
      const impact = computePriceImpact(got.quote, t.inRaw, t.outRaw, mainPool([got.quote.route]));
      return { ...got, protocol, impact, totals: t };
    }),
  );
  const usable = attempts.flatMap((a) =>
    a.status === 'fulfilled' && !usesPool(a.value.quote, blocked) ? [a.value] : [],
  );
  const clean = (c: (typeof usable)[number]) =>
    c.impact.pct !== null && c.impact.pct <= REQUOTE_ABOVE_IMPACT_PCT;
  const better = (a: (typeof usable)[number], b: (typeof usable)[number]) =>
    p.type === 'EXACT_INPUT' ? a.totals.outRaw > b.totals.outRaw : a.totals.inRaw < b.totals.inRaw;
  const best = usable.reduce<(typeof usable)[number] | null>((kept, c) => {
    if (!kept) return c;
    if (clean(c) !== clean(kept)) return clean(c) ? c : kept;
    return better(c, kept) ? c : kept;
  }, null);
  if (!best)
    throw new McpToolError('NO_ROUTE', 'No usable route for this swap on the execution chain.', {
      retryable: true,
    });
  return {
    response: best.response,
    quote: best.quote,
    impact: { ...best.impact, requote: { protocol: best.protocol, kept: 'single_protocol' } },
  };
}

/**
 * Quote with junk-split protection (see services/priceImpact.ts). When the effective price is
 * more than REQUOTE_ABOVE_IMPACT_PCT worse than the deepest direct pool's mid price, quote again
 * restricted to that pool's protocol and keep whichever is better for the user (exact input:
 * more output; exact output: less input). Both quotes are measured against the same reference
 * mid (deepest direct pool seen in either route). A failed re-quote keeps the original. A real
 * loss is not hidden: the kept quote's effective impact is what the policy sees (> 5% refuses).
 */
export async function fetchBestClassicQuote(
  deps: ToolDeps,
  p: ClassicQuoteParams,
  options: { cache?: boolean } = {},
): Promise<{ response: QuoteResponse; quote: ClassicQuote; impact: QuoteImpact }> {
  const blocked = deps.config.UNISWAP_BLOCKED_POOLS;
  if (blocked?.length && p.chainId === deps.executionChainId && !p.protocols?.length)
    return fetchCleanestClassicQuote(deps, p, options, new Set(blocked));
  const first = await fetchClassicQuote(deps, p, options);
  const firstTotals = totals(p, first.quote);
  const ref = mainPool([first.quote.route]);
  const firstImpact = computePriceImpact(first.quote, firstTotals.inRaw, firstTotals.outRaw, ref);
  if (
    !ref ||
    p.protocols?.length ||
    firstImpact.pct === null ||
    firstImpact.pct <= REQUOTE_ABOVE_IMPACT_PCT
  )
    return { ...first, impact: { ...firstImpact, requote: null } };

  let second: Awaited<ReturnType<typeof fetchClassicQuote>> | null = null;
  try {
    second = await fetchClassicQuote(deps, { ...p, protocols: [ref.protocol] }, options);
  } catch (err) {
    deps.log.warn('single-protocol re-quote failed; keeping the original quote', {
      err: err instanceof Error ? err.message : String(err),
      protocol: ref.protocol,
    });
  }
  if (!second)
    return {
      ...first,
      impact: { ...firstImpact, requote: { protocol: ref.protocol, kept: 'original' } },
    };

  const secondTotals = totals(p, second.quote);
  const reference = mainPool([first.quote.route, second.quote.route]) ?? ref;
  // Better for the user NET OF GAS: gasFeeQuote is the gas cost in the quoted currency (output
  // token for exact input, input token for exact output), so a route that returns slightly more
  // but burns more gas does not win.
  const better =
    p.type === 'EXACT_INPUT'
      ? secondTotals.outRaw - gasInQuoted(second.quote) >
        firstTotals.outRaw - gasInQuoted(first.quote)
      : secondTotals.inRaw > 0n &&
        secondTotals.inRaw + gasInQuoted(second.quote) <
          firstTotals.inRaw + gasInQuoted(first.quote);
  const kept = better ? second : first;
  const keptTotals = better ? secondTotals : firstTotals;
  const impact = computePriceImpact(kept.quote, keptTotals.inRaw, keptTotals.outRaw, reference);
  return {
    ...kept,
    impact: {
      ...impact,
      requote: { protocol: ref.protocol, kept: better ? 'single_protocol' : 'original' },
    },
  };
}

type RouteHop = NonNullable<ClassicQuote['route']>[number][number];

function parseRoute(quote: ClassicQuote): GetQuoteOutput['route'] {
  const pools: GetQuoteOutput['route']['pools'] = [];
  for (const path of quote.route ?? []) {
    for (const hop of path as RouteHop[]) {
      const h = hop as {
        type?: string;
        address?: string;
        fee?: string | number;
        tickSpacing?: string | number;
        hooks?: string;
        tokenIn?: { address?: string };
        tokenOut?: { address?: string };
      };
      const protocol = h.type === 'v4-pool' ? 'V4' : h.type === 'v3-pool' ? 'V3' : 'V2';
      const tokenIn = h.tokenIn?.address;
      const tokenOut = h.tokenOut?.address;
      if (!tokenIn || !tokenOut || !h.address) continue;
      pools.push({
        protocol,
        poolRef: h.address,
        tokenIn: getAddress(tokenIn),
        tokenOut: getAddress(tokenOut),
        fee: h.fee !== undefined && h.fee !== null ? Number(h.fee) : null,
        tickSpacing:
          h.tickSpacing !== undefined && h.tickSpacing !== null ? Number(h.tickSpacing) : null,
        hooks: protocol === 'V4' && h.hooks ? getAddress(h.hooks) : null,
      });
    }
  }
  const hooks = [
    ...new Set(pools.map((pl) => pl.hooks).filter((x): x is Address => !!x && !isZeroHook(x))),
  ];
  return { summary: quote.routeString ?? null, pools, hooks };
}

/** Normalise a CLASSIC quote into the tool's output shape. */
export function normalizeQuote(
  deps: ToolDeps,
  p: ClassicQuoteParams,
  response: QuoteResponse,
  quote: ClassicQuote,
  impact?: QuoteImpact,
): GetQuoteOutput {
  const amountInRaw = BigInt(quote.input?.amount ?? (p.type === 'EXACT_INPUT' ? p.amountRaw : 0n));
  const amountOutRaw = BigInt(
    quote.output?.amount ?? (p.type === 'EXACT_OUTPUT' ? p.amountRaw : 0n),
  );
  const slippage = quote.slippage ?? p.slippagePct ?? null;
  const bps = slippage !== null ? BigInt(Math.round(slippage * 100)) : null;

  let minAmountOut: GetQuoteOutput['minAmountOut'] = null;
  let maxAmountIn: GetQuoteOutput['maxAmountIn'] = null;
  if (p.type === 'EXACT_INPUT') {
    const explicit = quote.output?.minimumAmount;
    const computed = bps !== null ? (amountOutRaw * (10_000n - bps)) / 10_000n : null;
    const value = explicit ? BigInt(explicit) : computed;
    if (value !== null) minAmountOut = amountOf(value, p.tokenOut.decimals);
  } else {
    const explicit = quote.input?.maximumAmount;
    const computed = bps !== null ? (amountInRaw * (10_000n + bps) + 9_999n) / 10_000n : null;
    const value = explicit ? BigInt(explicit) : computed;
    if (value !== null) maxAmountIn = amountOf(value, p.tokenIn.decimals);
  }

  const pi: QuoteImpact = impact ?? {
    ...computePriceImpact(quote, amountInRaw, amountOutRaw),
    requote: null,
  };
  const now = deps.now();
  return {
    chainId: p.chainId,
    routing: 'CLASSIC',
    quoteId: quote.quoteId ?? null,
    requestId: response.requestId ?? null,
    type: p.type,
    tokenIn: p.tokenIn,
    tokenOut: p.tokenOut,
    amountIn: amountOf(amountInRaw, p.tokenIn.decimals),
    amountOut: amountOf(amountOutRaw, p.tokenOut.decimals),
    minAmountOut,
    maxAmountIn,
    slippagePct: slippage,
    priceImpactPct: pi.pct,
    priceImpactDetail: {
      method: pi.method,
      apiPct: pi.apiPct,
      referencePool: pi.referencePool,
      requote: pi.requote,
    },
    gasFee: {
      wei: quote.gasFee && /^\d+$/.test(quote.gasFee) ? quote.gasFee : null,
      usd: quote.gasFeeUSD ?? null,
    },
    gasUseEstimate: quote.gasUseEstimate ?? null,
    route: parseRoute(quote),
    txFailureReasons: (quote.txFailureReasons ?? []).map(String),
    blockNumber: quote.blockNumber ?? null,
    quotedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + QUOTE_FRESHNESS_MS).toISOString(),
  };
}
