import { describe, expect, it } from 'vitest';
import { ActionIntentSchema, CardSchema, parseTraceEvent, TraceEventSchema } from '../src/index.js';

const DEAD = '0x000000000000000000000000000000000000dEaD';

describe('ActionIntent', () => {
  it('accepts a swap-and-send intent', () => {
    const intent = ActionIntentSchema.parse({
      type: 'swap_and_send',
      tokenIn: { symbol: 'ETH' },
      tokenOut: { symbol: 'USDC' },
      mode: 'exact_out',
      amount: '20',
      recipient: DEAD,
      reason: 'User asked to send 20 USDC paying with ETH',
    });
    expect(intent.type).toBe('swap_and_send');
  });

  it('rejects number amounts and missing reasons', () => {
    const base = {
      type: 'swap_exact_in',
      tokenIn: { symbol: 'ETH' },
      tokenOut: { symbol: 'USDC' },
    };
    expect(ActionIntentSchema.safeParse({ ...base, amountIn: 20, reason: 'x' }).success).toBe(
      false,
    );
    expect(ActionIntentSchema.safeParse({ ...base, amountIn: '20' }).success).toBe(false);
  });

  it('requires a token symbol or address', () => {
    const result = ActionIntentSchema.safeParse({
      type: 'transfer',
      token: {},
      amount: '1',
      recipient: DEAD,
      reason: 'withdraw',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a chained trigger', () => {
    const parsed = ActionIntentSchema.parse({
      type: 'create_trigger',
      reason: 'If ETH hits 3500 sell half then LP',
      rule: {
        kind: 'CHAINED',
        condition: { type: 'price_above', token: { symbol: 'ETH' }, priceUsd: '3500' },
        steps: [
          {
            type: 'sell_percent',
            token: { symbol: 'ETH' },
            percent: 50,
            receiveToken: { symbol: 'USDC' },
          },
          {
            type: 'lp_open_with_proceeds',
            token0: { symbol: 'ETH' },
            token1: { symbol: 'USDC' },
            rangePreset: 'balanced',
          },
        ],
      },
    });
    expect(parsed.type).toBe('create_trigger');
  });
});

describe('TraceEvent', () => {
  const base = {
    id: 'evt_1',
    traceId: 'trace_1',
    userId: 'user_1',
    ts: new Date().toISOString(),
    title: 'Agent online',
  };

  it('parses every kind and rejects unknown kinds', () => {
    expect(parseTraceEvent({ ...base, kind: 'system' }).kind).toBe('system');
    expect(TraceEventSchema.safeParse({ ...base, kind: 'nope' }).success).toBe(false);
  });

  it('validates 0G provenance', () => {
    const zg = { requestId: 'r', clientRequestId: 'c', model: 'glm-5.3', trustMode: 'private' };
    expect(TraceEventSchema.safeParse({ ...base, kind: 'plan', zg }).success).toBe(true);
    expect(
      TraceEventSchema.safeParse({ ...base, kind: 'plan', zg: { ...zg, trustMode: 'public' } })
        .success,
    ).toBe(false);
  });
});

describe('Cards', () => {
  it('discriminates on type', () => {
    const card = CardSchema.parse({
      type: 'refusal',
      title: 'I will not do that',
      summary: 'Price impact too high',
      reasons: [{ code: 'PRICE_IMPACT_TOO_HIGH', message: 'Price impact is 7.2% (max 5%)' }],
    });
    expect(card.type).toBe('refusal');
  });
});
