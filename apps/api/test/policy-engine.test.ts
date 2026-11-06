import { describe, expect, it } from 'vitest';
import { Decimal } from '@warden/shared';
import { decide, type PolicyInput } from '../src/modules/policy/engine.js';
import { tradeScore, type TokenCheckFact } from '../src/modules/safety/tradeScore.js';
import { canonicalHash, canonicalJson } from '../src/lib/canonical.js';

const base = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  origin: 'user',
  buildError: null,
  simulation: { ok: true },
  refuseFacts: [],
  hook: null,
  guard: { verdict: 'approve', unavailable: false, reason: 'ok' },
  tradeScore: 95,
  priceImpactPct: 0.1,
  withdrawal: false,
  recipient: null,
  amountUsd: new Decimal(5),
  todaySpendUsd: new Decimal(0),
  limits: { perActionUsd: 25, perDayUsd: 100, minTradeScoreAuto: 70, hookPolicy: 'SAFE_ONLY' },
  ...over,
});

const codes = (i: PolicyInput) => {
  const d = decide(i);
  return [d.outcome, d.reasons.map((r) => r.code)];
};

describe('policy engine (PHASE_00 §9) — table', () => {
  const cases: [string, Partial<PolicyInput>, string, string[]][] = [
    ['all good → AUTO', {}, 'AUTO', []],
    // Rule 1: REFUSE
    ['build failed', { buildError: 'NO_ROUTE', simulation: null }, 'REFUSE', ['BUILD_FAILED']],
    [
      'simulation reverted',
      { simulation: { ok: false, error: 'STF' } },
      'REFUSE',
      ['SIMULATION_REVERTED'],
    ],
    [
      'simulation unavailable',
      { simulation: { ok: false, unavailable: true } },
      'REFUSE',
      ['SIMULATION_UNAVAILABLE'],
    ],
    ['simulation missing', { simulation: null }, 'REFUSE', ['SIMULATION_UNAVAILABLE']],
    [
      'unsupported token',
      { refuseFacts: [{ code: 'UNSUPPORTED_TOKEN', message: 'x' }] },
      'REFUSE',
      ['UNSUPPORTED_TOKEN'],
    ],
    ['danger hook', { hook: { band: 'DANGER', score: 30 } }, 'REFUSE', ['DANGER_HOOK']],
    [
      'guard blocked',
      { guard: { verdict: 'block', unavailable: false, reason: 'risky' } },
      'REFUSE',
      ['GUARD_BLOCKED'],
    ],
    [
      'guard unavailable',
      { guard: { verdict: 'block', unavailable: true, reason: 'down' } },
      'REFUSE',
      ['GUARD_UNAVAILABLE'],
    ],
    ['guard not run (no 0G) fails closed', { guard: null }, 'REFUSE', ['GUARD_UNAVAILABLE']],
    ['trade score 39 refuses', { tradeScore: 39 }, 'REFUSE', ['TRADE_SCORE_TOO_LOW']],
    [
      'trade score 40 does not refuse (boundary)',
      { tradeScore: 40 },
      'STEP_UP',
      ['TRADE_SCORE_BELOW_AUTO'],
    ],
    ['price impact 5.01% refuses', { priceImpactPct: 5.01 }, 'REFUSE', ['PRICE_IMPACT_TOO_HIGH']],
    ['price impact exactly 5% allowed', { priceImpactPct: 5 }, 'AUTO', []],
    [
      'refuse wins over step-up',
      { simulation: { ok: false }, withdrawal: true, amountUsd: new Decimal(500) },
      'REFUSE',
      ['SIMULATION_REVERTED'],
    ],
    // Rule 2: STEP_UP always
    [
      'withdrawal',
      {
        withdrawal: true,
        recipient: { address: '0x00000000000000000000000000000000000000aa', known: true },
      },
      'STEP_UP',
      ['WITHDRAWAL'],
    ],
    ['limit change', { limitChange: true }, 'STEP_UP', ['LIMIT_CHANGE']],
    ['risk profile change', { riskProfileChange: true }, 'STEP_UP', ['RISK_PROFILE_CHANGE']],
    [
      'new recipient',
      { recipient: { address: '0x00000000000000000000000000000000000000aa', known: false } },
      'STEP_UP',
      ['NEW_RECIPIENT'],
    ],
    [
      'known recipient, not a withdrawal → AUTO',
      { recipient: { address: '0x00000000000000000000000000000000000000aa', known: true } },
      'AUTO',
      [],
    ],
    [
      'rule 2 matches before limits',
      { withdrawal: true, amountUsd: new Decimal(500) },
      'STEP_UP',
      ['WITHDRAWAL'],
    ],
    // Rule 3: limits
    [
      'over per-action by one cent',
      { amountUsd: new Decimal('25.01') },
      'STEP_UP',
      ['OVER_PER_ACTION_LIMIT'],
    ],
    ['exactly at the per-action limit allowed', { amountUsd: new Decimal(25) }, 'AUTO', []],
    [
      'over daily',
      { amountUsd: new Decimal(10), todaySpendUsd: new Decimal('90.01') },
      'STEP_UP',
      ['OVER_DAILY_LIMIT'],
    ],
    [
      'exactly at daily allowed',
      { amountUsd: new Decimal(10), todaySpendUsd: new Decimal(90) },
      'AUTO',
      [],
    ],
    [
      'over both',
      { amountUsd: new Decimal(60), todaySpendUsd: new Decimal(50) },
      'STEP_UP',
      ['OVER_PER_ACTION_LIMIT', 'OVER_DAILY_LIMIT'],
    ],
    ['value unknown', { amountUsd: null }, 'STEP_UP', ['VALUE_UNKNOWN']],
    // Rule 4: quality
    [
      'caution hook on SAFE_ONLY',
      { hook: { band: 'CAUTION', score: 60 } },
      'STEP_UP',
      ['CAUTION_HOOK'],
    ],
    [
      'caution hook allowed by SAFE_AND_CAUTION',
      {
        hook: { band: 'CAUTION', score: 60 },
        limits: {
          perActionUsd: 50,
          perDayUsd: 200,
          minTradeScoreAuto: 60,
          hookPolicy: 'SAFE_AND_CAUTION',
        },
      },
      'AUTO',
      [],
    ],
    ['safe hook', { hook: { band: 'SAFE', score: 90 } }, 'AUTO', []],
    ['score 69 below auto 70', { tradeScore: 69 }, 'STEP_UP', ['TRADE_SCORE_BELOW_AUTO']],
    ['score exactly 70 is AUTO', { tradeScore: 70 }, 'AUTO', []],
    [
      'limits match before quality',
      { amountUsd: new Decimal(30), tradeScore: 50 },
      'STEP_UP',
      ['OVER_PER_ACTION_LIMIT'],
    ],
    // Rule 5: ASK
    [
      'proactive over threshold → ASK',
      { origin: 'proactive', amountUsd: new Decimal(60) },
      'ASK',
      ['PROACTIVE_NEEDS_ACCEPTANCE', 'OVER_PER_ACTION_LIMIT'],
    ],
    [
      'proactive accepted → STEP_UP',
      { origin: 'proactive', proactiveAccepted: true, amountUsd: new Decimal(60) },
      'STEP_UP',
      ['OVER_PER_ACTION_LIMIT'],
    ],
    ['proactive under threshold → AUTO', { origin: 'proactive' }, 'AUTO', []],
    [
      'proactive refusal stays REFUSE',
      { origin: 'proactive', guard: null },
      'REFUSE',
      ['GUARD_UNAVAILABLE'],
    ],
  ];
  it.each(cases)('%s', (_name, over, outcome, expected) => {
    expect(codes(base(over))).toEqual([outcome, expected]);
  });

  it('reasons carry the value and the limit', () => {
    const d = decide(base({ amountUsd: new Decimal(60) }));
    expect(d.reasons[0]).toEqual({
      code: 'OVER_PER_ACTION_LIMIT',
      message: 'Over your $25 per-action limit',
      value: 60,
      limit: 25,
    });
  });
});

const usdc: TokenCheckFact = {
  symbol: 'USDC',
  address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  isNative: false,
  onAllowlist: true,
  onUniswapUnsupportedList: false,
  liquidityDepthUsd: '1000000',
  verdict: 'OK',
  riskFlags: [],
};
const score = (over: Partial<Parameters<typeof tradeScore>[0]> = {}) =>
  tradeScore({
    priceImpactPct: 0.1,
    amountUsd: new Decimal(5),
    portfolioUsd: new Decimal(100),
    tokens: [usdc],
    gasUsd: new Decimal('0.05'),
    hookScore: null,
    slippagePct: 0.5,
    maxSlippagePct: 0.5,
    ...over,
  });

describe('trade safety score (PHASE_00 §9)', () => {
  it('a clean small trade scores 100', () => {
    expect(score().score).toBe(100);
  });
  it.each([
    [0.29, 0],
    [0.3, 0],
    [0.31, 10],
    [0.8, 10],
    [0.81, 20],
    [2.3, 40],
    [5, 100],
  ])('price impact %s%% costs %s', (impact, penalty) => {
    expect(100 - score({ priceImpactPct: impact }).score).toBe(penalty);
  });
  it('refuses above 5% impact', () => {
    expect(score({ priceImpactPct: 5.2 }).refuse.map((r) => r.code)).toEqual([
      'PRICE_IMPACT_TOO_HIGH',
    ]);
  });
  it('size vs portfolio: >25% −10, >50% −25, exactly 25% free', () => {
    expect(score({ amountUsd: new Decimal(25) }).score).toBe(100);
    expect(score({ amountUsd: new Decimal(26) }).score).toBe(90);
    expect(score({ amountUsd: new Decimal(51), gasUsd: null }).score).toBe(75);
  });
  it('non-allowlisted token −40 and refuses with no liquidity', () => {
    const r = score({
      tokens: [
        {
          ...usdc,
          symbol: 'SCAM',
          onAllowlist: false,
          liquidityDepthUsd: null,
          verdict: 'CAUTION',
        },
      ],
    });
    expect(r.score).toBe(60);
    expect(r.refuse[0]).toMatchObject({ code: 'UNSUPPORTED_TOKEN' });
  });
  it('non-allowlisted token with $10k+ depth is not refused', () => {
    const r = score({ tokens: [{ ...usdc, onAllowlist: false, liquidityDepthUsd: '10000' }] });
    expect(r.refuse).toEqual([]);
    expect(r.score).toBe(60);
  });
  it('unsupported list refuses', () => {
    expect(score({ tokens: [{ ...usdc, onUniswapUnsupportedList: true }] }).refuse[0]?.code).toBe(
      'UNSUPPORTED_TOKEN',
    );
  });
  it('gas > 3% of value −15', () => {
    expect(score({ gasUsd: new Decimal('0.16') }).score).toBe(85);
    expect(score({ gasUsd: new Decimal('0.15') }).score).toBe(100);
  });
  it('hook pool −(100−score)/2 rounded up; slippage above max −10; floor 0', () => {
    expect(score({ hookScore: 79 }).score).toBe(89);
    expect(score({ slippagePct: 1 }).score).toBe(90);
    expect(
      score({
        priceImpactPct: 4.9,
        amountUsd: new Decimal(90),
        hookScore: 0,
        slippagePct: 2,
        gasUsd: new Decimal(50),
      }).score,
    ).toBe(0);
  });
  it('every penalty is a breakdown entry with evidence', () => {
    const r = score({ priceImpactPct: 1, hookScore: 70 });
    expect(r.breakdown.find((b) => b.rule === 'price_impact')).toMatchObject({ penalty: -20 });
    expect(r.breakdown.find((b) => b.rule === 'hook_pool')).toMatchObject({
      penalty: -15,
      evidence: 'Pool hook scores 70/100',
    });
  });
});

describe('canonical JSON', () => {
  it('sorts keys recursively and hashes stably', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2n }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"y":"2","z":1}]},"b":1}',
    );
    expect(canonicalHash({ x: 1, y: 2 })).toBe(canonicalHash({ y: 2, x: 1 }));
  });
});

describe('dev approval provider is impossible in production', () => {
  it('throws for APPROVAL_MODE=dev when NODE_ENV=production', async () => {
    const { createApprovalProvider } =
      await import('../src/modules/approvals/dev-approval-provider.js');
    const env = {
      APPROVAL_MODE: 'dev',
      NODE_ENV: 'production',
      ALLOW_DEV_PROVIDERS: true,
      WEB_URL: 'http://x',
    } as never;
    expect(() => createApprovalProvider(env, {} as never, async () => null)).toThrow(
      /ALLOW_DEV_PROVIDERS/,
    );
    const devEnv = {
      APPROVAL_MODE: 'dev',
      NODE_ENV: 'development',
      ALLOW_DEV_PROVIDERS: true,
      WEB_URL: 'http://x',
    } as never;
    expect(createApprovalProvider(devEnv, {} as never, async () => null).kind).toBe('dev');
  });
});

describe('trade score readability', () => {
  it('caps the price-impact penalty at the whole score', () => {
    const r = tradeScore({
      priceImpactPct: 95.64,
      amountUsd: null,
      portfolioUsd: null,
      tokens: [],
      gasUsd: null,
      hookScore: null,
      slippagePct: null,
      maxSlippagePct: 0.5,
    });
    expect(r.breakdown[0]!.penalty).toBe(-100);
    expect(r.score).toBe(0);
    expect(r.refuse[0]!.code).toBe('PRICE_IMPACT_TOO_HIGH');
  });
});
