/** PHASE 06 pure helpers: corrected requests and fact cards (no database). */
import { describe, expect, it } from 'vitest';
import type { PolicyReason, PortfolioResponse } from '@warden/shared';
import { requestFor } from '../src/modules/agent/describe.js';
import { factCards } from '../src/modules/agent/fact-cards.js';
import { suggestedRequest } from '../src/modules/agent/pipeline.js';

const swap = {
  type: 'swap_exact_in' as const,
  tokenIn: { symbol: 'ETH' },
  tokenOut: { symbol: 'USDC' },
  amountIn: '0.003',
  amountUsd: '25',
  reason: 'x',
};

describe('corrected requests', () => {
  it('halves exactly, without floats', () => {
    expect(requestFor(swap, { halve: true })).toBe('Swap $12.5 ETH to USDC');
    const { amountUsd: _drop, ...noUsd } = swap;
    expect(requestFor(noUsd, { halve: true })).toBe('Swap 0.0015 ETH to USDC');
    expect(requestFor({ ...swap, amountUsd: '0.03' }, { halve: true })).toBe(
      'Swap $0.015 ETH to USDC',
    );
  });

  it('by refusal reason: halve when too big, retry when unavailable, nothing otherwise', () => {
    const r = (code: PolicyReason['code']): PolicyReason[] => [{ code, message: code }];
    expect(suggestedRequest(swap, r('PRICE_IMPACT_TOO_HIGH'))).toBe('Swap $12.5 ETH to USDC');
    expect(suggestedRequest(swap, r('GUARD_UNAVAILABLE'))).toBe('Swap $25 ETH to USDC');
    expect(suggestedRequest(swap, r('UNSUPPORTED_TOKEN'))).toBeNull();
    expect(suggestedRequest(swap, r('SIMULATION_REVERTED'))).toBeNull();
  });
});

const tokenCheck = {
  chainId: 11155111,
  address: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  isNative: false,
  onAllowlist: true,
  onUniswapUnsupportedList: false,
  hasQuote: true,
  liquidityDepthUsd: '250000',
  liquidityProbe: null,
  isContract: true,
  riskFlags: [],
  verdict: 'OK',
};

const portfolio = {
  totalUsd: '42.10',
  tokens: [{ symbol: 'ETH', balance: '0.01', valueUsd: '42.10' }],
  pnl: { totalUsd: '1.20' },
  risk: { score: 30, label: 'Low' },
  limits: { perActionUsd: '25', perDayUsd: '100', usedTodayUsd: '5' },
} as unknown as PortfolioResponse;

describe('fact cards', () => {
  it('turns a check_token result into a typed token card (checksummed, verdict kept)', () => {
    const [card] = factCards([{ tool: 'check_token', output: tokenCheck }], {
      userText: 'Is USDC safe?',
      portfolio: null,
    });
    expect(card).toMatchObject({
      type: 'info',
      title: 'Token check · USDC',
      data: {
        kind: 'token_check',
        verdict: 'OK',
        address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      },
    });
  });

  it('skips malformed or error outputs and adds the portfolio only when asked', () => {
    expect(
      factCards([{ tool: 'check_token', output: { error: 'NO_ROUTE' } }], {
        userText: 'hi',
        portfolio,
      }),
    ).toEqual([]);
    const cards = factCards([], { userText: 'Show my portfolio', portfolio });
    expect(cards[0]).toMatchObject({
      title: 'Your portfolio',
      data: { kind: 'portfolio', totalUsd: '42.10', limits: { usedTodayUsd: '5' } },
    });
    expect(factCards([], { userText: '/risk', portfolio })).toHaveLength(1);
  });
});
