/**
 * Price impact on thin testnets (services/priceImpact.ts + fetchBestClassicQuote).
 * Fixtures are the live Sepolia quote that exposed the issue (2026-11-06, 0.000894 ETH → USDC):
 * the router split 5% through ETH→UNI→USDC (a mispriced UNI/USDC pool) and reported
 * priceImpact 95.89%, although the whole quote gave the user the best output.
 */
import { describe, expect, it } from 'vitest';
import { computePriceImpact, hopMid, mainPool } from '../src/services/priceImpact.js';
import { ETH, harness, ok, SEPOLIA, SEPOLIA_USDC, SWAPPER, TRADE } from './helpers.js';

const UNI = '0x6727a0d9D9C0e3cD6a5d0C0C6dC0C0F0E0C0B0A0';
const AMOUNT_IN = '894000000000000';
const MAIN_POOL = '0x8439998c1a5d4ec8c7ec9b02eb25f5f41e3eb2d41eb2bef710778a38ec12eb9d';
const tok = (address: string, symbol: string, decimals: string) => ({
  chainId: SEPOLIA,
  address,
  symbol,
  decimals,
});
const v4 = (
  address: string,
  tokenIn: ReturnType<typeof tok>,
  tokenOut: ReturnType<typeof tok>,
  sqrtRatioX96: string,
  liquidity: string,
  extra: Record<string, string> = {},
) => ({
  type: 'v4-pool',
  address,
  tokenIn,
  tokenOut,
  sqrtRatioX96,
  liquidity,
  tickCurrent: '0',
  fee: '10000',
  tickSpacing: '200',
  hooks: '0x0000000000000000000000000000000000000000',
  ...extra,
});
const ETH_T = tok(ETH, 'ETH', '18');
const USDC_T = tok(SEPOLIA_USDC, 'USDC', '6');
const UNI_T = tok(UNI, 'UNI', '18');
/** The deep 1% ETH/USDC pool: mid ≈ 26 450 USDC per ETH. */
const mainHop = (amountOut: string) =>
  v4(MAIN_POOL, ETH_T, USDC_T, '12886631283034204796764875', '1693895259480282', {
    amountIn: '849300000000000',
    amountOut,
  });
/** The junk leg: ETH → UNI → USDC through a UNI/USDC pool with an absurd mid price. */
const junkLeg = [
  v4('0xffe2', ETH_T, UNI_T, '1651254549118299944052701745620397', '527706316356445314', {
    amountIn: '44700000000000',
  }),
  v4('0xb35d', UNI_T, USDC_T, '468742199741154594488165353511880397', '8659951545503', {
    amountOut: '1453078',
  }),
];

function quoteBody(amountOut: string, priceImpact: number, split: boolean, gasFeeQuote?: string) {
  return {
    requestId: `req-${amountOut}`,
    routing: 'CLASSIC',
    quote: {
      chainId: SEPOLIA,
      input: { amount: AMOUNT_IN, token: ETH },
      output: { amount: amountOut, token: SEPOLIA_USDC, recipient: SWAPPER },
      swapper: SWAPPER,
      route: split ? [junkLeg, [mainHop('22242361')]] : [[mainHop(amountOut)]],
      slippage: 0.5,
      tradeType: 'EXACT_INPUT',
      quoteId: `q-${amountOut}`,
      gasFee: '489108586810000',
      gasFeeUSD: '0.01',
      ...(gasFeeQuote ? { gasFeeQuote } : {}),
      priceImpact,
      txFailureReasons: [],
      routeString: split ? '[v4] 5% junk, 95% main' : '[v4] 100% main',
    },
    permitData: null,
    permitTransaction: null,
  };
}

/** /quote fake: the default (V2/V3/V4) request gets `all`, a single-protocol one gets `single`. */
function mockQuotes(
  h: ReturnType<typeof harness>,
  all: ReturnType<typeof quoteBody>,
  single: ReturnType<typeof quoteBody> | { status: number; body: unknown },
) {
  h.http.on('POST', `${TRADE}/quote`, (call) => {
    const protocols = (call.body as { protocols: string[] }).protocols;
    if (protocols.length === 1) return 'status' in single ? single : { body: single };
    return { body: all };
  });
}

const args = {
  chainId: SEPOLIA,
  tokenIn: 'ETH',
  tokenOut: 'USDC',
  amount: '0.000894',
  type: 'EXACT_INPUT',
  swapper: SWAPPER,
  slippagePct: 0.5,
};

describe('effective price impact', () => {
  it('mid price from sqrtPriceX96 follows the currency order', () => {
    const fwd = hopMid(mainHop('1'))!;
    const back = hopMid({ ...mainHop('1'), tokenIn: USDC_T, tokenOut: ETH_T })!;
    // ≈ 26 450 USDC per ETH in human units (6 vs 18 decimals).
    expect(fwd.mid * 1e12).toBeGreaterThan(26_000);
    expect(fwd.mid * 1e12).toBeLessThan(27_000);
    expect(fwd.mid * back.mid).toBeCloseTo(1, 10);
  });

  it('the deepest direct pool is the reference; multi-hop legs never are', () => {
    const q = quoteBody('23695439', 95.89, true).quote;
    expect(mainPool([q.route as never])).toMatchObject({ pool: MAIN_POOL, protocol: 'V4' });
  });

  it('falls back to the API figure when the route has no direct pool', () => {
    const r = computePriceImpact(
      { route: [junkLeg] as never, priceImpact: 3.3 },
      BigInt(AMOUNT_IN),
      23_000_000n,
    );
    expect(r).toMatchObject({ pct: 3.3, method: 'api', apiPct: 3.3 });
  });
});

describe('get_quote: junk-split protection', () => {
  it('case 1 — a junk split that does not cost the user: effective ≈ 0%, API 95.89% kept as evidence', async () => {
    const h = harness();
    mockQuotes(h, quoteBody('23695439', 95.89, true), quoteBody('23412912', 1.01, false));
    const out = await ok(h, 'get_quote', args);

    // Effective price is 0.19% BETTER than the main pool's mid → reported as 0.
    expect(out.priceImpactPct).toBe(0);
    expect(out.priceImpactDetail).toEqual({
      method: 'effective_vs_main_pool',
      apiPct: 95.89,
      referencePool: MAIN_POOL,
      requote: null, // within 1% of mid: no re-quote needed
    });
    expect(out.amountOut.raw).toBe('23695439');
    expect(h.http.callsTo('/quote')).toHaveLength(1);
  });

  it('case 2 — > 1% worse than mid: re-quotes on the main pool protocol and keeps the better output', async () => {
    const h = harness();
    // Original: 1.48% worse than mid. V4-only: 1.01% worse, more USDC → kept.
    mockQuotes(h, quoteBody('23300000', 95.89, true), quoteBody('23412912', 1.01, false));
    const out = await ok(h, 'get_quote', args);

    const calls = h.http.callsTo('/quote');
    expect(calls).toHaveLength(2);
    expect((calls[0]!.body as { protocols: string[] }).protocols).toEqual(['V2', 'V3', 'V4']);
    expect((calls[1]!.body as { protocols: string[] }).protocols).toEqual(['V4']);
    expect(out.amountOut.raw).toBe('23412912');
    expect(out.quoteId).toBe('q-23412912');
    expect(out.priceImpactPct).toBeCloseTo(1.01, 2);
    expect(out.priceImpactDetail).toMatchObject({
      apiPct: 1.01,
      requote: { protocol: 'V4', kept: 'single_protocol' },
    });
  });

  it('case 2b — the re-quote is worse (or fails): the original quote is kept', async () => {
    const worse = harness();
    mockQuotes(worse, quoteBody('23300000', 95.89, true), quoteBody('23000000', 2.5, false));
    const a = await ok(worse, 'get_quote', args);
    expect(a.amountOut.raw).toBe('23300000');
    expect(a.priceImpactDetail.requote).toEqual({ protocol: 'V4', kept: 'original' });
    expect(a.priceImpactDetail.apiPct).toBe(95.89);

    const failing = harness();
    mockQuotes(failing, quoteBody('23300000', 95.89, true), {
      status: 404,
      body: { errorCode: 'NO_ROUTE', detail: 'No quotes available' },
    });
    const b = await ok(failing, 'get_quote', args);
    expect(b.amountOut.raw).toBe('23300000');
    expect(b.priceImpactDetail.requote).toEqual({ protocol: 'V4', kept: 'original' });
  });

  it('net of gas: a re-quote with a bit more output but more gas loses', async () => {
    const h = harness();
    // Original: 23.30 USDC, gas 0.05 USDC → net 23.25. Single-protocol: 23.32 USDC but gas 0.30
    // USDC → net 23.02. The original is better for the user.
    mockQuotes(
      h,
      quoteBody('23300000', 95.89, true, '50000'),
      quoteBody('23320000', 1.2, false, '300000'),
    );
    const out = await ok(h, 'get_quote', args);
    expect(out.amountOut.raw).toBe('23300000');
    expect(out.priceImpactDetail.requote).toEqual({ protocol: 'V4', kept: 'original' });
  });

  it('case 3 — a real loss stays visible: even the best quote > 5% worse than mid', async () => {
    const h = harness();
    // Original 15.4% worse, V4-only 11.2% worse: keep the better one, but it is still a loss.
    mockQuotes(h, quoteBody('20000000', 95.89, true), quoteBody('21000000', 11.2, false));
    const out = await ok(h, 'get_quote', args);
    expect(out.amountOut.raw).toBe('21000000');
    expect(out.priceImpactPct).toBeGreaterThan(5);
    expect(out.priceImpactPct).toBeCloseTo(11.21, 1);
  });
});

describe('build_swap: the kept quote is the one that gets built', () => {
  it('sends the single-protocol quote to /swap and reports both impact figures', async () => {
    const h = harness();
    mockQuotes(h, quoteBody('23300000', 95.89, true), quoteBody('23412912', 1.01, false));
    h.http.on('POST', `${TRADE}/swap`, {
      body: {
        requestId: 'swap-1',
        swap: {
          to: '0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3',
          from: SWAPPER,
          data: '0x3593564c00',
          value: AMOUNT_IN,
          chainId: SEPOLIA,
          gasLimit: '250000',
        },
      },
    });
    const out = await ok(h, 'build_swap', args);
    expect(out.status).toBe('READY');
    expect(out.summary).toMatchObject({
      amountOut: { raw: '23412912' },
      apiPriceImpactPct: 1.01,
      priceImpactMethod: 'effective_vs_main_pool',
    });
    const [swap] = h.http.callsTo('/swap');
    expect((swap!.body as { quote: { quoteId: string } }).quote.quoteId).toBe('q-23412912');
  });
});
