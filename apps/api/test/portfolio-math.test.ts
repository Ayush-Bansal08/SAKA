import { Decimal, EXECUTION_CONTRACTS } from '@warden/shared';
import { CHAINS } from 'uniswap-agent-mcp';
import { describe, expect, it } from 'vitest';
import { dayBoundsInZone } from '../src/lib/time.js';
import { dec, runFifo, tokenPnl, type Lot } from '../src/modules/portfolio/fifo.js';
import { computeRisk, riskLabel } from '../src/modules/portfolio/risk.js';

const ETH = 10n ** 18n;
const d = (v: Decimal.Value) => new Decimal(v);
const at = (i: number) => new Date(Date.UTC(2026, 10, 1, 0, i));

describe('FIFO P&L', () => {
  const lots: Lot[] = [
    { amountRaw: 1n * ETH, costUsd: d(2000), at: at(1) },
    { amountRaw: 1n * ETH, costUsd: d(3000), at: at(2) },
  ];

  it('consumes the oldest lot first on a sell', () => {
    const r = runFifo(lots, [{ amountRaw: 1n * ETH, proceedsUsd: d(2500), at: at(3) }]);
    expect(r.realizedUsd.toString()).toBe('500'); // sold the $2000 lot for $2500
    expect(r.remaining).toHaveLength(1);
    expect(r.remaining[0]!.costUsd.toString()).toBe('3000');
    expect(r.totalCostUsd.toString()).toBe('5000');
  });

  it('pro-rates a partially consumed lot', () => {
    const r = runFifo(lots, [{ amountRaw: (3n * ETH) / 2n, proceedsUsd: d(3750), at: at(3) }]);
    // 1.5 ETH sold: lot 1 ($2000) + half of lot 2 ($1500) = $3500 cost → +$250.
    expect(r.realizedUsd.toString()).toBe('250');
    expect(r.remaining[0]!.amountRaw).toBe(ETH / 2n);
    expect(r.remaining[0]!.costUsd.toString()).toBe('1500');
  });

  it('handles several partial sells in time order regardless of input order', () => {
    const r = runFifo(
      [lots[1]!, lots[0]!],
      [
        { amountRaw: ETH / 2n, proceedsUsd: d(1100), at: at(4) },
        { amountRaw: ETH / 4n, proceedsUsd: d(600), at: at(3) },
      ],
    );
    // 0.75 ETH from the $2000 lot → cost $1500, proceeds $1700.
    expect(r.realizedUsd.toString()).toBe('200');
    expect(r.remaining.map((l) => l.amountRaw)).toEqual([ETH / 4n, ETH]);
    expect(r.remaining.map((l) => l.costUsd.toString())).toEqual(['500', '3000']);
  });

  it('reports disposals no lot covered', () => {
    const r = runFifo(lots.slice(0, 1), [{ amountRaw: 2n * ETH, proceedsUsd: d(5000), at: at(3) }]);
    expect(r.uncoveredRaw).toBe(ETH);
    expect(r.realizedUsd.toString()).toBe('500'); // only the covered half of the proceeds counts
  });

  it('computes unrealized + realized P&L against the live balance', () => {
    const p = tokenPnl({
      lots,
      disposals: [],
      balanceRaw: 2n * ETH,
      decimals: 18,
      priceUsd: d(2750),
    })!;
    expect(p.valueUsd.toString()).toBe('5500');
    expect(p.costBasisUsd.toString()).toBe('5000');
    expect(p.pnlUsd.toString()).toBe('500');
    expect(p.pct!.toString()).toBe('10');
  });

  it('treats an unexplained shortfall (gas) as a FIFO outflow with zero proceeds', () => {
    const p = tokenPnl({
      lots: [{ amountRaw: ETH, costUsd: d(2000), at: at(1) }],
      disposals: [],
      balanceRaw: (ETH * 99n) / 100n, // 0.01 ETH spent on gas
      decimals: 18,
      priceUsd: d(2000),
    })!;
    expect(dec(p.realizedUsd)).toBe('-20');
    expect(dec(p.unrealizedUsd)).toBe('0');
    expect(dec(p.pnlUsd)).toBe('-20');
  });

  it('leaves untracked excess out of P&L instead of counting it as profit', () => {
    const p = tokenPnl({
      lots: [{ amountRaw: ETH, costUsd: d(2000), at: at(1) }],
      disposals: [],
      balanceRaw: 2n * ETH,
      decimals: 18,
      priceUsd: d(2000),
    })!;
    expect(dec(p.pnlUsd)).toBe('0');
    expect(p.untrackedRaw).toBe(ETH);
  });

  it('returns null without lots or without a price', () => {
    expect(
      tokenPnl({ lots: [], disposals: [], balanceRaw: ETH, decimals: 18, priceUsd: d(1) }),
    ).toBeNull();
    expect(
      tokenPnl({ lots, disposals: [], balanceRaw: ETH, decimals: 18, priceUsd: null }),
    ).toBeNull();
  });

  it('formats decimals without exponent or negative zero', () => {
    expect(dec(d('-0.0000001'))).toBe('0');
    expect(dec(d('1e-7'), 8)).toBe('0.0000001');
    expect(dec(d('123.4567891'))).toBe('123.456789');
  });
});

describe('risk meter', () => {
  const eth = (value: Decimal.Value, drawdownPct: Decimal.Value | null = 0) => ({
    symbol: 'ETH',
    valueUsd: d(value),
    isStable: false,
    drawdownPct: drawdownPct === null ? null : d(drawdownPct),
  });
  const usdc = (value: Decimal.Value) => ({
    symbol: 'USDC',
    valueUsd: d(value),
    isStable: true,
    drawdownPct: d(0),
  });

  it('is Low with a clear driver for an empty wallet', () => {
    const r = computeRisk({ holdings: [] });
    expect(r).toMatchObject({
      score: 0,
      label: 'Low',
      drivers: ['No funds in the agent wallet yet'],
    });
  });

  it('scores an all-ETH wallet at its 7-day high as Moderate (50)', () => {
    const r = computeRisk({ holdings: [eth(100)] });
    expect(r.score).toBe(50); // concentration 30 + no stablecoins 20
    expect(r.label).toBe('Moderate');
    expect(r.drivers).toEqual(['100% of your portfolio is in ETH', 'No stablecoin buffer']);
  });

  it('adds drawdown vs the 7-day high', () => {
    const r = computeRisk({ holdings: [eth(100, 7.5)] });
    expect(r.score).toBe(60); // + 7.5/15 × 20
    expect(r.drivers).toContain('ETH is 7.5% below its 7-day high');
  });

  it('is Low for a balanced ETH/USDC wallet', () => {
    const r = computeRisk({ holdings: [eth(50, 3), usdc(50)] });
    expect(r.score).toBe(7);
    expect(r.label).toBe('Low');
  });

  it('is High with out-of-range liquidity and a Danger hook', () => {
    const r = computeRisk({
      holdings: [eth(20, 15)],
      lpOutOfRangeUsd: d(80),
      dangerHookUsd: d(80),
    });
    expect(r.label).toBe('High');
    expect(r.drivers).toHaveLength(3);
    expect(r.drivers[0]).toMatch(/out-of-range liquidity|hook pools/);
  });

  it('re-normalises weights when price history is unavailable', () => {
    const r = computeRisk({ holdings: [eth(100, null)] });
    const drawdown = r.factors.find((f) => f.factor === 'drawdown')!;
    expect(drawdown.available).toBe(false);
    expect(r.score).toBe(63); // 50 / 0.8
  });

  it('is deterministic', () => {
    const input = { holdings: [eth('123.45', '2.5'), usdc('10')] };
    expect(computeRisk(input)).toEqual(computeRisk(input));
  });

  it('labels by threshold', () => {
    expect([0, 33, 34, 66, 67, 100].map(riskLabel)).toEqual([
      'Low',
      'Low',
      'Moderate',
      'Moderate',
      'High',
      'High',
    ]);
  });
});

describe('dayBoundsInZone', () => {
  it('computes the local calendar day in Asia/Kolkata (+05:30)', () => {
    const r = dayBoundsInZone(new Date('2026-11-06T20:00:00Z'), 'Asia/Kolkata');
    expect(r.day).toBe('2026-11-07');
    expect(r.start.toISOString()).toBe('2026-11-06T18:30:00.000Z');
    expect(r.end.toISOString()).toBe('2026-11-07T18:30:00.000Z');
  });

  it('handles a DST change (America/New_York, 2026-11-01)', () => {
    const r = dayBoundsInZone(new Date('2026-11-01T12:00:00Z'), 'America/New_York');
    expect(r.start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-11-02T05:00:00.000Z'); // 25-hour day
  });

  it('falls back to UTC for an invalid zone', () => {
    const r = dayBoundsInZone(new Date('2026-11-06T20:00:00Z'), 'Not/AZone');
    expect(r).toMatchObject({ day: '2026-11-06', timeZone: 'UTC' });
    expect(r.start.toISOString()).toBe('2026-11-06T00:00:00.000Z');
  });
});

describe('EXECUTION_CONTRACTS mirror', () => {
  it('matches the MCP server chains.ts (vendor-doc addresses) exactly', () => {
    for (const [id, c] of Object.entries(EXECUTION_CONTRACTS)) {
      const mcp = CHAINS[Number(id)]!;
      const lower = (a: string | null) => a?.toLowerCase() ?? null;
      expect(lower(c.permit2)).toBe(lower(mcp.permit2));
      expect(lower(c.positionManager)).toBe(lower(mcp.positionManager));
      expect(lower(c.universalRouter['2.1.2'])).toBe(lower(mcp.universalRouter['2.1.2']));
      expect(lower(c.universalRouter['2.2.0'])).toBe(lower(mcp.universalRouter['2.2.0']));
      expect(lower(c.usdc)).toBe(lower(mcp.usdc));
      expect(lower(c.weth)).toBe(lower(mcp.weth));
    }
  });
});
