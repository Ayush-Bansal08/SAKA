/**
 * PHASE 08: detectors (fire / no-fire tables, boundaries, dedupe), the daily cap, the suggestion
 * lifecycle (AUTO, ASK, Yes → AUTO, Yes → STEP_UP, expired, price moved, No, Change), one path for
 * simulated and real events, the morning brief, and Telegram (link codes, button auth, escaping,
 * mute, 429 handling, never a chatbot).
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  Decimal,
  DEFAULT_AUTO_ACT,
  autoActSettings,
  type SuggestionsResponse,
  type SuggestionView,
  type UniswapMcp,
} from '@warden/shared';
import { getAddress } from 'viem';
import {
  Explainer,
  morningBriefTemplate,
  suggestionTemplate,
} from '../src/modules/ai0g/explainer.js';
import { quoteDecimalFields } from '../src/modules/agent/planner.js';
import { executePlan, type ExecutorDeps } from '../src/modules/execution/executor.js';
import { GUARD_CONCERNS, GUARD_QUESTIONS, renderGuardState } from '../src/modules/safety/guard.js';
import {
  detectBetterPool,
  detectBigMove,
  detectDip,
  detectHookChanged,
  detectIdleUsdc,
  detectMorningBrief,
  detectNewHook,
  detectOutOfRange,
  detectProfit,
} from '../src/modules/modeb/detectors/index.js';
import { hookStateDiff, hookStateHash } from '../src/modules/modeb/detectors/hook-changed.js';
import { hourKey, isoWeek, pairKey } from '../src/modules/modeb/detectors/util.js';
import { modeBDepsFrom } from '../src/modules/modeb/routes.js';
import { countsTowardCap, runModeBTick } from '../src/modules/modeb/runner.js';
import {
  approvalResolved,
  changeLink,
  planSettled,
  sweepExpiredSuggestions,
  type ModeBDeps,
} from '../src/modules/modeb/suggestions.js';
import type { DetectorContext, HookStateFacts } from '../src/modules/modeb/types.js';
import { decide, type PolicyInput } from '../src/modules/policy/engine.js';
import { BOT_COPY, createBot } from '../src/modules/telegram/bot.js';
import { signCallback, verifyCallback } from '../src/modules/telegram/callback.js';
import {
  deliver,
  withFloodControl,
  type DeliveryDeps,
  type TelegramApi,
} from '../src/modules/telegram/delivery.js';
import {
  escapeMd,
  isPublicUrl,
  linkLine,
  renderAlert,
  renderOutcome,
} from '../src/modules/telegram/format.js';
import { createLinkCode, redeemLinkCode } from '../src/modules/telegram/link.js';
import type { Notification, Notifications } from '../src/modules/telegram/notifications.js';
import { setPriceOverride, clearPriceOverride } from '../src/modules/triggers/service.js';
import { createTestApp, devSignIn, uniqueName } from './helpers.js';
import {
  createMarket,
  FakeChain,
  FakeWallets,
  giveWallet,
  POOL_ID,
  POSITION_MANAGER,
  RecordingJobs,
  scriptedMcp,
  USDC,
  ZG_ENV,
  zgRouter,
  type Market,
  type ZgScript,
} from './phase5-fakes.js';

afterEach(() => vi.unstubAllGlobals());

const ADMIN = { 'x-admin-token': 'test-admin-token-0123456789abcdef' };
const ZERO = '0x0000000000000000000000000000000000000000';
const HOOK = getAddress('0x00000000000000000000000000000000000a0c0c');
const NOW = new Date('2026-11-06T12:00:00Z');

// ---------------------------------------------------------------------------
// Detector tables (pure)
// ---------------------------------------------------------------------------

type Token = DetectorContext['portfolio']['tokens'][number];
type Lp = DetectorContext['portfolio']['lpPositions'][number];

const token = (over: Partial<Token> = {}): Token =>
  ({
    symbol: 'ETH',
    address: ZERO,
    decimals: 18,
    isNative: true,
    balanceRaw: '2000000000000000000',
    balance: '2',
    priceUsd: '2500',
    valueUsd: '5000',
    sharePct: '100',
    pnl: null,
    ...over,
  }) as Token;

const pnl = (pct: string) =>
  ({
    costBasisUsd: '100',
    valueUsd: '100',
    unrealizedUsd: '0',
    realizedUsd: '0',
    pnlUsd: '0',
    pct,
  }) as Token['pnl'];

const lp = (over: Partial<Lp> = {}): Lp =>
  ({
    id: 'pos1',
    tokenId: '7',
    poolId: POOL_ID,
    token0: { symbol: 'ETH', address: ZERO },
    token1: { symbol: 'USDC', address: USDC },
    amount0: '1',
    amount1: '100',
    fees0: null,
    fees1: null,
    tickLower: -10,
    tickUpper: 10,
    currentTick: 0,
    priceLower: '1',
    priceUpper: '2',
    priceCurrent: '1.5',
    inRange: true,
    valueUsd: '1000',
    costBasisUsd: '900',
    pnlUsd: '100',
    hook: null,
    openedAt: NOW.toISOString(),
    ...over,
  }) as Lp;

const ctx = (over: Partial<DetectorContext> = {}): DetectorContext => ({
  now: NOW,
  localDay: '2026-11-06',
  localHour: 17,
  localMinute: 30,
  profile: { dipBuyUsd: 20 },
  perActionUsd: new Decimal(25),
  portfolio: { tokens: [token()], lpPositions: [], totalUsd: '5000' },
  market: {
    ethPriceUsd: new Decimal(2500),
    ethHigh7dUsd: new Decimal(2600),
    ethChange1hPct: new Decimal(0),
  },
  usdc: { balance: new Decimal(100), lastOutflowAt: null, heldSince: null },
  outOfRangeChecks: {},
  pools: {},
  moveGasUsd: new Decimal(1),
  newHooks: [],
  hookExposures: [],
  seen: new Set(),
  ...over,
});

const ranked = (over: Record<string, unknown>) => ({
  rank: 1,
  poolId: `0x${'22'.repeat(32)}`,
  source: 'execution',
  usableOnExecutionChain: true,
  fee: 500,
  tickSpacing: 10,
  hookAddress: ZERO,
  hookBand: null,
  hookScore: null,
  referenceFeeAprPct: '10',
  adjustedAprPct: '10',
  referenceTvlUsd: '100',
  reasons: [],
  ...over,
});

const pools = (rows: unknown[], recommended: unknown = null) =>
  ({ [pairKey('ETH', 'USDC')]: { ranked: rows, recommended } }) as DetectorContext['pools'];

describe('DIP', () => {
  const at = (price: number, usdc = 100) =>
    ctx({
      market: {
        ethPriceUsd: new Decimal(price),
        ethHigh7dUsd: new Decimal(3000),
        ethChange1hPct: null,
      },
      usdc: { balance: new Decimal(usdc), lastOutflowAt: null, heldSince: null },
    });

  it.each([
    [2701, false],
    [2700, true], // exactly 0.90 × high
    [2699, true],
  ])('ETH at %d against a $3000 high: fires %s', (price, fires) => {
    expect(detectDip(at(price)) !== null).toBe(fires);
  });

  it('proposes buying the profile amount with USDC', () => {
    expect(detectDip(at(2500))).toMatchObject({
      dedupeKey: 'dip:2026-11-06',
      severity: 'NORMAL',
      intent: {
        type: 'swap_exact_in',
        tokenIn: { symbol: 'USDC' },
        tokenOut: { symbol: 'ETH' },
        amountIn: '20',
        amountUsd: '20',
      },
    });
  });

  it('is information only when USDC cannot cover it; a balance of exactly the amount can', () => {
    expect(detectDip(at(2500, 19.99))).toMatchObject({ severity: 'INFO', intent: null });
    expect(detectDip(at(2500, 20))?.intent).not.toBeNull();
  });

  it('needs both prices and fires once a day', () => {
    expect(
      detectDip(ctx({ market: { ethPriceUsd: null, ethHigh7dUsd: null, ethChange1hPct: null } })),
    ).toBeNull();
    expect(detectDip({ ...at(2500), seen: new Set(['dip:2026-11-06']) })).toBeNull();
  });
});

describe('PROFIT', () => {
  const holding = (pct: string) =>
    ctx({ portfolio: { tokens: [token({ pnl: pnl(pct) })], lpPositions: [], totalUsd: '5000' } });

  it.each([
    ['11.99', false],
    ['12', true],
    ['40', true],
  ])('%s%% P&L fires %s', (pct, fires) => {
    expect(detectProfit(holding(pct)) !== null).toBe(fires);
  });

  it('sells 25% of the position to USDC', () => {
    expect(detectProfit(holding('20'))).toMatchObject({
      dedupeKey: 'profit:ETH:2026-11-06',
      intent: { tokenIn: { symbol: 'ETH' }, tokenOut: { symbol: 'USDC' }, amountIn: '0.5' },
    });
  });

  it('never sells a stablecoin, and moves on to the next token once one is deduped', () => {
    const usdc = token({ symbol: 'USDC', decimals: 6, pnl: pnl('50') });
    expect(
      detectProfit(ctx({ portfolio: { tokens: [usdc], lpPositions: [], totalUsd: '1' } })),
    ).toBeNull();
    const eth = token({ pnl: pnl('20') });
    const uni = token({ symbol: 'UNI', pnl: pnl('30') });
    const seen = new Set(['profit:ETH:2026-11-06']);
    expect(
      detectProfit(ctx({ portfolio: { tokens: [eth, uni], lpPositions: [], totalUsd: '1' }, seen }))
        ?.dedupeKey,
    ).toBe('profit:UNI:2026-11-06');
  });
});

describe('IDLE_USDC', () => {
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
  const idle = (balance: string, outflowHours: number | null, heldHours: number | null = 48) =>
    ctx({
      usdc: {
        balance: new Decimal(balance),
        lastOutflowAt: outflowHours === null ? null : hoursAgo(outflowHours),
        heldSince: heldHours === null ? null : hoursAgo(heldHours),
      },
      pools: pools([ranked({})], ranked({})),
    });

  it.each([
    ['20', 30, false], // exactly $20 is not "over $20"
    ['20.01', 30, true],
    ['100', 23.9, false],
    ['100', 24, true],
  ])('$%s, last outflow %d h ago: fires %s', (balance, hours, fires) => {
    expect(detectIdleUsdc(idle(balance, hours)) !== null).toBe(fires);
  });

  it('with no outflow it counts from when the USDC arrived, and needs to know that', () => {
    expect(detectIdleUsdc(idle('100', null, 25))).not.toBeNull();
    expect(detectIdleUsdc(idle('100', null, 2))).toBeNull();
    expect(detectIdleUsdc(idle('100', null, null))).toBeNull();
  });

  it('deposits min(USDC, per-action limit) into the recommended pool', () => {
    expect(detectIdleUsdc(idle('100', 30))?.intent).toMatchObject({
      type: 'lp_open',
      amountUsd: '25.00',
      poolRef: { poolId: `0x${'22'.repeat(32)}` },
    });
    expect(detectIdleUsdc(idle('21', 30))?.intent).toMatchObject({ amountUsd: '21.00' });
  });

  it('skips Danger pools and unusable ones; with nothing left it only informs', () => {
    const c = idle('100', 30);
    const bad = pools([ranked({ hookBand: 'DANGER' }), ranked({ usableOnExecutionChain: false })]);
    expect(detectIdleUsdc({ ...c, pools: bad })).toMatchObject({ severity: 'INFO', intent: null });
  });
});

describe('BETTER_POOL', () => {
  const current = ranked({ poolId: POOL_ID, adjustedAprPct: '5' });
  const better = (apr: string, over: Record<string, unknown> = {}) =>
    ranked({ adjustedAprPct: apr, ...over });
  const c = (apr: string, gas = '1', value = '1000') =>
    ctx({
      portfolio: { tokens: [], lpPositions: [lp({ valueUsd: value })], totalUsd: value },
      pools: pools([current, better(apr)]),
      moveGasUsd: new Decimal(gas),
    });

  it.each([
    ['8', false], // a gap of exactly 3 points is not "> 3"
    ['8.01', true],
  ])('candidate at %s%% APR against 5%%: fires %s', (apr, fires) => {
    expect(detectBetterPool(c(apr, '0.1')) !== null).toBe(fires);
  });

  it('needs the move to pay back in under 7 days', () => {
    // 15-point gap on $1000 earns $0.411 a day, so $2.87 pays back in 6.98 days.
    expect(detectBetterPool(c('20', '2.87'))).not.toBeNull();
    expect(detectBetterPool(c('20', '2.88'))).toBeNull();
  });

  it('proposes moving to the new pool, once a week', () => {
    const event = detectBetterPool(c('20'));
    expect(event).toMatchObject({
      dedupeKey: `better:7:${isoWeek(NOW)}`,
      intent: {
        type: 'lp_rebalance',
        positionId: 'pos1',
        targetPool: { poolId: expect.any(String) },
      },
    });
    expect(detectBetterPool({ ...c('20'), seen: new Set([event!.dedupeKey]) })).toBeNull();
  });

  it('never moves into a Danger hook, and never fires without a gas estimate', () => {
    const danger = pools([current, better('50', { hookBand: 'DANGER' })]);
    expect(detectBetterPool({ ...c('20'), pools: danger })).toBeNull();
    expect(detectBetterPool({ ...c('20'), moveGasUsd: null })).toBeNull();
  });
});

describe('OUT_OF_RANGE', () => {
  const c = (inRange: boolean, checks: number) =>
    ctx({
      portfolio: { tokens: [], lpPositions: [lp({ inRange })], totalUsd: '1' },
      outOfRangeChecks: { '7': checks },
    });

  it.each([
    [false, 1, false],
    [false, 2, true],
    [true, 5, false],
  ])('inRange=%s after %d checks: fires %s', (inRange, checks, fires) => {
    expect(detectOutOfRange(c(inRange, checks)) !== null).toBe(fires);
  });

  it('proposes re-ranging in place with the profile preset', () => {
    const e = detectOutOfRange(c(false, 2));
    expect(e).toMatchObject({
      dedupeKey: 'oor:7:2026-11-06',
      intent: { type: 'lp_rebalance', positionId: 'pos1' },
    });
    expect(e?.intent).not.toHaveProperty('targetPool');
    expect(e?.intent).not.toHaveProperty('rangePreset');
  });
});

describe('NEW_HOOK', () => {
  const hook = (over: Partial<DetectorContext['newHooks'][number]> = {}) => ({
    hookAddress: HOOK,
    pair: 'ETH/USDC',
    band: 'SAFE' as const,
    score: 90,
    betterPct: new Decimal('0.3'),
    tryRequest: 'Swap $5 ETH to USDC',
    ...over,
  });

  it('fires at exactly 0.3% better, as information with something to try', () => {
    expect(detectNewHook(ctx({ newHooks: [hook()] }))).toMatchObject({
      dedupeKey: `newhook:${HOOK.toLowerCase()}`,
      severity: 'INFO',
      intent: null,
      prefill: 'Swap $5 ETH to USDC',
    });
  });

  it.each([
    ['not better enough', { betterPct: new Decimal('0.29') }],
    ['could not be quoted', { betterPct: null }],
    ['Caution band', { band: 'CAUTION' as const }],
  ])('stays quiet: %s', (_, over) => {
    expect(detectNewHook(ctx({ newHooks: [hook(over)] }))).toBeNull();
  });
});

describe('HOOK_CHANGED', () => {
  const state = (over: Partial<HookStateFacts> = {}): HookStateFacts => ({
    codeHash: '0xaa',
    implementation: null,
    owner: '0x1111111111111111111111111111111111111111',
    fees: { p: 3000 },
    ...over,
  });
  const c = (current: HookStateFacts, positionIds = ['pos1']) =>
    ctx({ hookExposures: [{ hookAddress: HOOK, positionIds, previous: state(), current }] });

  it.each([
    ['code', { codeHash: '0xbb' }, 'contract code'],
    ['implementation', { implementation: '0x2222222222222222222222222222222222222222' }, 'impl'],
    ['owner', { owner: '0x3333333333333333333333333333333333333333' }, 'owner'],
    ['LP fee', { fees: { p: 9000 } }, 'fee'],
  ])('a %s change is RED and proposes leaving 100%%', (_, change, word) => {
    const e = detectHookChanged(c(state(change)));
    expect(e).toMatchObject({
      severity: 'RED',
      intent: { type: 'lp_exit', positionId: 'pos1', percent: 100 },
    });
    expect(e?.summary).toContain(word);
  });

  it('address case and a new pool are not changes', () => {
    const owner = state().owner!.toUpperCase().replace('0X', '0x');
    expect(detectHookChanged(c(state({ owner })))).toBeNull();
    expect(detectHookChanged(c(state({ fees: { p: 3000, q: 500 } })))).toBeNull();
  });

  it('without a position it only warns', () => {
    expect(detectHookChanged(c(state({ codeHash: '0xbb' }), []))).toMatchObject({
      severity: 'RED',
      intent: null,
    });
  });

  it('dedupes on the new state: the same change never alerts twice, a new one does', () => {
    const changed = state({ codeHash: '0xbb' });
    const key = `hookchg:${HOOK.toLowerCase()}:${hookStateHash(changed)}`;
    expect(detectHookChanged(c(changed))?.dedupeKey).toBe(key);
    expect(detectHookChanged({ ...c(changed), seen: new Set([key]) })).toBeNull();
    expect(
      detectHookChanged({ ...c(state({ codeHash: '0xcc' })), seen: new Set([key]) }),
    ).not.toBeNull();
    expect(hookStateDiff(state(), state())).toEqual([]);
  });
});

describe('BIG_MOVE', () => {
  const c = (pct: string) =>
    ctx({ market: { ethPriceUsd: null, ethHigh7dUsd: null, ethChange1hPct: new Decimal(pct) } });

  it.each([
    ['4.99', false],
    ['5', true],
    ['-4.99', false],
    ['-5', true],
  ])('%s%% in an hour: fires %s', (pct, fires) => {
    expect(detectBigMove(c(pct)) !== null).toBe(fires);
  });

  it('a rise is RED information with the USD impact, once per hour', () => {
    const e = detectBigMove(c('10'));
    expect(e).toMatchObject({
      severity: 'RED',
      intent: null,
      dedupeKey: `bigmove:${hourKey(NOW)}`,
      facts: { impactUsd: '+$500.00', exposedUsd: '5000.00' },
    });
    expect(detectBigMove({ ...c('10'), seen: new Set([e!.dedupeKey]) })).toBeNull();
  });

  it('a drop buys the dip amount with USDC, once per hour', () => {
    const e = detectBigMove(c('-10'));
    expect(e).toMatchObject({
      severity: 'RED',
      dedupeKey: `bigmove:${hourKey(NOW)}:buy:2026-11-06`,
      facts: { impactUsd: '-$500.00' },
      intent: {
        type: 'swap_exact_in',
        tokenIn: { symbol: 'USDC' },
        tokenOut: { symbol: 'ETH' },
        amountIn: '20',
      },
    });
    expect(detectBigMove({ ...c('-10'), seen: new Set([e!.dedupeKey]) })).toBeNull();
  });

  it('a drop with too little USDC only warns', () => {
    const poor = { balance: new Decimal(5), lastOutflowAt: null, heldSince: null };
    expect(detectBigMove({ ...c('-10'), usdc: poor })).toMatchObject({ intent: null });
  });

  it('never buys twice in a day, whichever rule goes first', () => {
    const dip = {
      ethPriceUsd: new Decimal(2500),
      ethHigh7dUsd: new Decimal(3000),
      ethChange1hPct: new Decimal(-10),
    };
    // Both fire in one tick: DIP buys, BIG_MOVE stays an alert.
    expect(detectDip(ctx({ market: dip }))?.intent).not.toBeNull();
    expect(detectBigMove(ctx({ market: dip }))?.intent).toBeNull();
    // DIP already bought today.
    const after = new Set(['dip:2026-11-06']);
    expect(detectBigMove(ctx({ market: dip, seen: after }))?.intent).toBeNull();
    // BIG_MOVE already bought today: DIP stays quiet, later hours only alert.
    const bought = new Set(['bigmove:2026-11-06T09:buy:2026-11-06']);
    expect(detectDip(ctx({ market: dip, seen: bought }))).toBeNull();
    expect(detectBigMove(ctx({ market: dip, seen: bought }))?.intent).toBeNull();
  });

  it('counts LP value, and leaves stables out', () => {
    const portfolio = {
      tokens: [token({ symbol: 'USDC', valueUsd: '900' })],
      lpPositions: [lp({ valueUsd: '1000' })],
      totalUsd: '1900',
    };
    expect(detectBigMove({ ...c('10'), portfolio })?.facts.exposedUsd).toBe('1000.00');
  });
});

describe('MORNING_BRIEF', () => {
  it.each([
    [7, 59, false],
    [8, 0, true],
    [8, 14, true],
    [8, 15, false],
    [20, 0, false],
  ])('at %d:%d local: fires %s', (localHour, localMinute, fires) => {
    expect(detectMorningBrief(ctx({ localHour, localMinute })) !== null).toBe(fires);
  });

  it('fires once a day', () => {
    const c = ctx({ localHour: 8, localMinute: 5 });
    expect(detectMorningBrief(c)?.dedupeKey).toBe('brief:2026-11-06');
    expect(detectMorningBrief({ ...c, seen: new Set(['brief:2026-11-06']) })).toBeNull();
  });
});

describe('windows and caps', () => {
  it('ISO weeks cross the year correctly', () => {
    expect(isoWeek(new Date('2026-11-06T12:00:00Z'))).toBe('2026-W45');
    expect(isoWeek(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
  });

  it('RED alerts and the brief never count against the daily cap', () => {
    expect(countsTowardCap({ severity: 'NORMAL', detector: 'DIP' })).toBe(true);
    expect(countsTowardCap({ severity: 'INFO', detector: 'NEW_HOOK' })).toBe(true);
    expect(countsTowardCap({ severity: 'RED', detector: 'BIG_MOVE' })).toBe(false);
    expect(countsTowardCap({ severity: 'INFO', detector: 'MORNING_BRIEF' })).toBe(false);
  });

  it('auto-act defaults: on for DIP, PROFIT and IDLE_USDC only', () => {
    expect(autoActSettings(null)).toEqual(DEFAULT_AUTO_ACT);
    expect(autoActSettings({ DIP: 'no' })).toEqual(DEFAULT_AUTO_ACT); // corrupt → defaults
    expect(autoActSettings({ DIP: false, nonsense: true }).DIP).toBe(false);
    expect(autoActSettings({ DIP: false }).PROFIT).toBe(true);
    expect(DEFAULT_AUTO_ACT.OUT_OF_RANGE).toBe(false);
    expect(DEFAULT_AUTO_ACT.BETTER_POOL).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Policy additions
// ---------------------------------------------------------------------------

describe('policy (Mode B)', () => {
  const base = (over: Partial<PolicyInput> = {}): PolicyInput => ({
    origin: 'proactive',
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

  it('auto-act off keeps a clean action waiting for the human', () => {
    expect(decide(base()).outcome).toBe('AUTO');
    expect(decide(base({ proactiveAutoAllowed: true })).outcome).toBe('AUTO');
    expect(decide(base({ proactiveAutoAllowed: false })).outcome).toBe('ASK');
    expect(decide(base({ proactiveAutoAllowed: false, proactiveAccepted: true })).outcome).toBe(
      'AUTO',
    );
  });

  it('the auto-act gate never overrides a refusal', () => {
    const blocked = base({
      proactiveAutoAllowed: false,
      guard: { verdict: 'block', unavailable: false, reason: 'no' },
    });
    expect(decide(blocked).outcome).toBe('REFUSE');
  });

  it('a Danger hook refuses entering but never traps the human in the pool', () => {
    const hook = { band: 'DANGER' as const, score: 10 };
    expect(decide(base({ hook })).outcome).toBe('REFUSE');
    const leaving = base({ hook, leavingHookPool: true, tradeScore: 25 });
    expect(decide(leaving).outcome).toBe('ASK');
    expect(decide({ ...leaving, proactiveAccepted: true })).toMatchObject({
      outcome: 'STEP_UP',
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'DANGER_HOOK' })]),
    });
    expect(decide({ ...leaving, origin: 'user' }).outcome).toBe('STEP_UP');
  });

  it('leaving a hook pool is still refused when it would not work or the guard blocks', () => {
    const hook = { band: 'DANGER' as const, score: 10 };
    expect(
      decide(base({ hook, leavingHookPool: true, simulation: { ok: false, error: 'x' } })).outcome,
    ).toBe('REFUSE');
    expect(
      decide(
        base({
          hook,
          leavingHookPool: true,
          guard: { verdict: 'block', unavailable: false, reason: 'no' },
        }),
      ).outcome,
    ).toBe('REFUSE');
  });
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

describe('planner amounts', () => {
  it('tiny amounts in exponent form become plain decimals', () => {
    expect(JSON.parse(quoteDecimalFields('{"amountIn": "2.2e-05", "amount": "20"}'))).toEqual({
      amountIn: '0.000022',
      amount: '20',
    });
    expect(JSON.parse(quoteDecimalFields('{"amountIn":6.925e-05,"amountUsd":0.15}'))).toEqual({
      amountIn: '0.00006925',
      amountUsd: '0.15',
    });
  });
});

describe('guard and limits', () => {
  const input = {
    intent: {
      type: 'swap_exact_in',
      tokenIn: { symbol: 'USDC' },
      tokenOut: { symbol: 'ETH' },
      amountIn: '50',
      reason: 'Buy the dip.',
    },
    limits: {
      riskProfile: 'BALANCED',
      perActionUsd: '25.00',
      perDayUsd: '100.00',
      todaySpendUsd: '90.00',
      maxSlippagePct: 0.5,
    },
  } as const;

  it('the guard judges safety, not limits: over them a human decides', () => {
    const state = renderGuardState(input);
    expect(state).not.toContain('25.00');
    expect(state).not.toContain('100.00');
    expect(state).not.toContain('90.00');
    expect(state).toContain('never a reason to block');
    expect(state).toContain('max slippage 0.5%');
    expect(JSON.stringify(GUARD_QUESTIONS)).not.toMatch(/limit/i);
    expect(GUARD_CONCERNS).not.toContain('limit_breach');
  });
});

describe('suggestion text', () => {
  const answer = (text: string) => ({
    model: () => 'm',
    chat: async () => ({
      inferenceId: 'inf1',
      data: { choices: [{ message: { content: text } }] },
    }),
  });
  const event = { kind: 'BIG_MOVE', summary: 'ETH moved -6% in an hour.' };
  const intent = {
    type: 'swap_exact_in',
    tokenIn: { symbol: 'USDC' },
    tokenOut: { symbol: 'ETH' },
    amountIn: '1',
    reason: 'Buy the dip.',
  } as const;
  const explainer = (text: string) =>
    new Explainer(answer(text) as never, { userId: 'u', traceId: 't' });

  it('an information alert never asks a question: nobody can answer it', async () => {
    expect(
      await explainer('ETH fell. Want me to review options?').explainSuggestionDetailed(
        event,
        null,
      ),
    ).toEqual({ text: 'ETH moved -6% in an hour.', inferenceId: null });
  });

  it('a clean information alert keeps the 0G text and its proof', async () => {
    expect(
      await explainer('ETH fell 6%, about $0.04 on your holdings.').explainSuggestionDetailed(
        event,
        null,
      ),
    ).toEqual({ text: 'ETH fell 6%, about $0.04 on your holdings.', inferenceId: 'inf1' });
  });

  it('never tells the human to approve: it may run alone', async () => {
    const r = await explainer('Sell 25% into USDC. Approve to proceed.').explainSuggestionDetailed(
      event,
      intent,
    );
    expect(r.inferenceId).toBeNull();
    expect(r.text).not.toMatch(/approve/i);
  });

  it('a proposal may ask: it has Yes and No buttons', async () => {
    const text = 'ETH dipped. Buy $1?';
    expect((await explainer(text).explainSuggestionDetailed(event, intent)).text).toBe(text);
  });
});

describe('explainer templates', () => {
  it('suggestion: ≤ 30 words, with or without a plan', () => {
    const event = { kind: 'DIP', summary: `${'word '.repeat(40).trim()}.` };
    expect(suggestionTemplate(event, null).split(/\s+/).length).toBeLessThanOrEqual(30);
    expect(suggestionTemplate({ kind: 'X', summary: 'ETH fell.' }, null)).toBe('ETH fell.');
  });

  it('brief: at most six "- " lines from the data alone', () => {
    const text = morningBriefTemplate({
      totalUsd: '100.00',
      change24hPct: '+1.2',
      ethPriceUsd: '2500.00',
      risk: { label: 'MEDIUM', drivers: ['Mostly ETH'] },
      positions: [
        { label: 'ETH/USDC', inRange: false, valueUsd: '1' },
        { label: 'ETH/USDC', inRange: false, valueUsd: '1' },
      ],
      newHooks: ['ETH/USDC (90/100)'],
      suggestions: ['Buy the dip', 'Rebalance'],
      triggers: ['Sell half at $3000'],
    });
    const lines = text.split('\n');
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines.every((l) => l.startsWith('- '))).toBe(true);
    expect(text).toContain('$100.00 (+1.2% in 24 h)');
    expect(text).toContain('2 LP positions are out of range');
  });
});

// ---------------------------------------------------------------------------
// Suggestion lifecycle (Postgres + Redis, external services mocked)
// ---------------------------------------------------------------------------

class RecordingNotifications implements Notifications {
  sent: Notification[] = [];
  async enqueue(n: Notification) {
    this.sent.push(n);
  }
  async close() {}
  kinds = () => this.sent.map((n) => n.kind);
}

interface Injected {
  statusCode: number;
  body: string;
  json(): unknown;
}

interface Harness {
  app: FastifyInstance;
  market: Market;
  jobs: RecordingJobs;
  script: ZgScript;
  notes: RecordingNotifications;
  chain: FakeChain;
  wallets: FakeWallets;
  userId: string;
  token: string;
  deps: ModeBDeps;
  simulate(detector: string, overrides?: Record<string, unknown>): Promise<SuggestionView>;
  act(id: string, action: 'accept' | 'decline' | 'change', token?: string): Promise<Injected>;
  /** Every 0G call fails from now on. */
  zgDown(): void;
  list(): Promise<SuggestionsResponse>;
  exec(planId: string): ReturnType<typeof executePlan>;
  close(): Promise<void>;
}

function history(args: Record<string, unknown>, open: string, high: string) {
  return {
    symbol: 'ETH',
    window: args.window,
    interval: args.interval,
    source: { kind: 'pool', id: 'x', description: 'x', provider: 'test' },
    series: [],
    open,
    close: open,
    high,
    low: open,
    changePct: '0',
    asOf: null,
    lagSeconds: null,
    stale: false,
    hasIndexingErrors: null,
    warnings: [],
  };
}

async function harness(env: Record<string, string> = {}): Promise<Harness> {
  const market = createMarket();
  market.handlers.get_price_history = (args) => history(args, '2500', '3000');
  const jobs = new RecordingJobs();
  const notes = new RecordingNotifications();
  const chain = new FakeChain();
  const wallets = new FakeWallets();
  const script: ZgScript = { proposals: [], guard: 'approve', decisions: 0 };
  // The 0G client keeps the fetch it was built with, so failures are switched behind it.
  const router = zgRouter(script);
  let down = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (...args: Parameters<typeof router>) => {
      if (down) throw new Error('0G down');
      return router(...args);
    }),
  );
  const app = await createTestApp(
    { ...ZG_ENV, AUTO_EXECUTE_DELAY_MS: '0', ...env },
    { mcp: scriptedMcp(market), jobs, chain, wallets, notifications: notes },
  );
  const login = await devSignIn(app, uniqueName('phase8'));
  await giveWallet(app.deps.prisma, login.user.id);
  const d = app.deps;
  const executor: ExecutorDeps = {
    env: d.env,
    prisma: d.prisma,
    redis: d.redis,
    mcp: d.mcp!,
    wallets,
    chain,
    traceBus: d.traceBus,
    jobs,
    approvals: d.approvals,
    approvalProvider: d.approvalProvider,
    onPlanSettled: (id, outcome) =>
      planSettled({ prisma: d.prisma, notifications: notes }, id, outcome),
  };
  const h: Harness = {
    app,
    market,
    jobs,
    script,
    notes,
    chain,
    wallets,
    userId: login.user.id,
    token: login.token,
    deps: modeBDepsFrom(d)!,
    async simulate(detector, overrides) {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/simulate-event',
        headers: ADMIN,
        payload: { userId: login.user.id, detector, ...(overrides ? { overrides } : {}) },
      });
      if (res.statusCode !== 200) throw new Error(`simulate ${res.statusCode}: ${res.body}`);
      return res.json() as SuggestionView;
    },
    act: (id, action, token = login.token) =>
      app.inject({
        method: 'POST',
        url: `/suggestions/${id}/${action}`,
        headers: { authorization: `Bearer ${token}` },
      }),
    async list() {
      const res = await app.inject({
        method: 'GET',
        url: '/suggestions',
        headers: { authorization: `Bearer ${login.token}` },
      });
      return res.json() as SuggestionsResponse;
    },
    exec: (planId) => executePlan(executor, planId),
    zgDown: () => {
      down = true;
    },
    close: () => app.close(),
  };
  return h;
}

/** Turns auto-act off so a clean suggestion waits for the human. */
const askFirst = (h: Harness) =>
  h.app.deps.prisma.user.update({
    where: { id: h.userId },
    data: { autoAct: { DIP: false, PROFIT: false, IDLE_USDC: false } },
  });

const lpPositionOutput = (args: Record<string, unknown>, tokenId: string, hook: string) => ({
  chainId: args.chainId,
  owner: args.owner,
  positions: [
    {
      tokenId,
      owner: args.owner,
      ownerMatches: true,
      poolId: POOL_ID,
      poolKey: { currency0: ZERO, currency1: USDC, fee: 3000, tickSpacing: 60, hooks: hook },
      hookAddress: hook,
      token0: { address: ZERO, symbol: 'ETH', decimals: 18, isNative: true },
      token1: { address: USDC, symbol: 'USDC', decimals: 6, isNative: false },
      tickLower: -200000,
      tickUpper: -190000,
      currentTick: -195000,
      inRange: true,
      liquidity: '1000',
      poolLiquidity: '100000',
      amount0: { raw: '0', decimal: '0' },
      amount1: { raw: '20000000', decimal: '20' },
      uncollectedFees0: { raw: '0', decimal: '0' },
      uncollectedFees1: { raw: '0', decimal: '0' },
      priceLower: '2000',
      priceUpper: '3000',
      priceCurrent: '2500',
      valueUsd: '20',
    },
  ],
  notFound: [],
  totalValueUsd: '20',
  blockNumber: '1',
  asOf: new Date().toISOString(),
});

const rebalanceBuild = (args: Record<string, unknown>) => ({
  status: 'READY',
  steps: [
    {
      kind: 'LP_DECREASE',
      description: 'Withdraw liquidity',
      tx: {
        to: getAddress(POSITION_MANAGER),
        from: getAddress(String(args.owner)),
        data: '0xdd46508f',
        value: '0',
        chainId: 11155111,
      },
    },
  ],
  summary: {
    lp: {
      token0: { address: ZERO, symbol: 'ETH', decimals: 18, isNative: true },
      token1: { address: USDC, symbol: 'USDC', decimals: 6, isNative: false },
      amount0: { raw: '0', decimal: '0' },
      amount1: { raw: '20000000', decimal: '20' },
      percent: 100,
    },
  },
  next: {
    tool: 'build_lp_position',
    args: {
      chainId: 11155111,
      owner: args.owner,
      pool: { poolReference: POOL_ID, token0: ZERO, token1: USDC },
      independentToken: { token: USDC, amount: '20' },
      range: args.newRange,
      slippagePct: 0.5,
    },
    expected: {
      amount0: { raw: '0', decimal: '0' },
      amount1: { raw: '20000000', decimal: '20' },
    },
  },
});

async function givePosition(h: Harness, hook: string | null) {
  const tokenId = String(Math.floor(Math.random() * 1e9));
  const row = await h.app.deps.prisma.lpPosition.create({
    data: {
      userId: h.userId,
      chainId: 11155111,
      protocol: 'V4',
      tokenId,
      poolId: POOL_ID,
      token0: ZERO,
      token1: USDC,
      hookAddress: hook,
      tickLower: -200000,
      tickUpper: -190000,
      openedTxHash: `0x${randomBytes(32).toString('hex')}`,
      costBasisUsd: '20',
    },
  });
  h.market.handlers.get_lp_positions = (args) => lpPositionOutput(args, tokenId, hook ?? ZERO);
  h.market.handlers.build_rebalance = rebalanceBuild;
  return row;
}

async function giveHook(h: Harness, address: string, score: number, band: 'DANGER' | 'SAFE') {
  await h.app.deps.prisma.hook.create({
    data: {
      chainId: 11155111,
      address,
      flags: {},
      permissions: {},
      isProxy: false,
      codeHash: `0x${'ab'.repeat(32)}`,
      score,
      band,
      scoreBreakdown: [],
      lastSnapshot: {},
      lastCheckedAt: new Date(),
    },
  });
}

describe('suggestions: creating', () => {
  it('auto-act on, under the limit, safe: runs alone and sends a receipt', async () => {
    const h = await harness();
    try {
      const s = await h.simulate('DIP');
      expect(s).toMatchObject({
        status: 'AUTO_EXECUTED',
        severity: 'NORMAL',
        simulated: true,
        actions: [],
        plan: { status: 'QUEUED', policyOutcome: 'AUTO', approver: 'agent', amountUsd: '20.00' },
      });
      expect(h.jobs.executions).toEqual([{ planId: s.plan!.id, delayMs: 0 }]);
      expect(h.notes.sent).toEqual([{ kind: 'suggestion', suggestionId: s.id }]);

      await h.exec(s.plan!.id);
      const after = await h.list();
      const row = after.suggestions.find((x) => x.id === s.id)!;
      expect(row).toMatchObject({ status: 'AUTO_EXECUTED', note: 'Done.' });
      expect(row.plan).toMatchObject({ status: 'EXECUTED' });
      expect(row.plan!.tx?.hash).toMatch(/^0x/);
      expect(h.notes.sent).toContainEqual({ kind: 'outcome', suggestionId: s.id });
    } finally {
      await h.close();
    }
  });

  it('auto-act off: waits for the human, with buttons, nothing queued', async () => {
    const h = await harness();
    try {
      await askFirst(h);
      const s = await h.simulate('DIP');
      expect(s).toMatchObject({
        status: 'OPEN',
        actions: ['yes', 'change', 'no'],
        prefill: 'Swap $20 USDC to ETH',
        plan: { status: 'PREPARED', policyOutcome: 'ASK', approver: 'you' },
      });
      expect(s.expiresAt).not.toBeNull();
      expect(h.jobs.executions).toHaveLength(0);
      expect((await h.list()).openCount).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('over the limit: never AUTO, and says a verified human must approve', async () => {
    const h = await harness();
    try {
      const s = await h.simulate('DIP', { amountUsd: '50' });
      expect(s).toMatchObject({
        status: 'OPEN',
        plan: { policyOutcome: 'ASK', approver: 'verified_human', amountUsd: '50.00' },
      });
      expect(h.jobs.executions).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('a guard block is shown with its reason, cannot be accepted and is logged', async () => {
    const h = await harness();
    try {
      h.script.guard = 'block';
      const s = await h.simulate('DIP');
      expect(s).toMatchObject({ status: 'INFO', plan: { status: 'REFUSED' } });
      expect(s.note).toContain('did not do this');
      expect(s.actions).toEqual(['change']);
      expect(h.jobs.logs).toContain(s.plan!.id);
      expect((await h.act(s.id, 'accept')).statusCode).toBe(409);
    } finally {
      await h.close();
    }
  });

  it('information events carry no plan and no buttons', async () => {
    const h = await harness();
    try {
      const s = await h.simulate('BIG_MOVE', { ethChange1hPct: '6' });
      expect(s).toMatchObject({ status: 'INFO', severity: 'RED', plan: null, actions: [] });
      expect(s.message.length).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  });

  it('the 0G message and its request id are stored; a dead 0G falls back to the facts', async () => {
    const h = await harness();
    try {
      const s = await h.simulate('BIG_MOVE', { ethChange1hPct: '6' });
      expect(s.zg?.requestId).toMatch(/^zg-/);
      h.zgDown();
      const fallback = await h.simulate('BIG_MOVE', { ethChange1hPct: '6' });
      expect(fallback.zg).toBeNull();
      expect(fallback.message).toContain('ETH moved');
    } finally {
      await h.close();
    }
  });

  it('posts the suggestion and the plan into the chat', async () => {
    const h = await harness();
    try {
      await askFirst(h);
      const s = await h.simulate('DIP');
      const msg = await h.app.deps.prisma.chatMessage.findFirstOrThrow({
        where: { userId: h.userId, role: 'AGENT' },
        orderBy: { createdAt: 'desc' },
      });
      expect(msg.cards).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'suggestion',
            suggestionId: s.id,
            status: 'OPEN',
            actions: ['yes', 'change', 'no'],
          }),
          expect.objectContaining({ type: 'preview', actionPlanId: s.plan!.id }),
        ]),
      );
    } finally {
      await h.close();
    }
  });
});

describe('suggestions: Yes', () => {
  it('AUTO-eligible at accept time: the same plan is queued once', async () => {
    const h = await harness();
    try {
      await askFirst(h);
      const s = await h.simulate('DIP');
      const res = await h.act(s.id, 'accept');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        result: 'EXECUTING',
        suggestion: { status: 'ACCEPTED', plan: { status: 'QUEUED', policyOutcome: 'AUTO' } },
      });
      expect(h.jobs.executions.map((e) => e.planId)).toEqual([s.plan!.id]);
      const again = await h.act(s.id, 'accept');
      expect(again.statusCode).toBe(409);
      expect(h.jobs.executions).toHaveLength(1);
      await h.exec(s.plan!.id);
      const plan = await h.app.deps.prisma.actionPlan.findUniqueOrThrow({
        where: { id: s.plan!.id },
      });
      expect(plan.status).toBe('EXECUTED');
    } finally {
      await h.close();
    }
  });

  it('two taps at once run it once', async () => {
    const h = await harness();
    try {
      await askFirst(h);
      const s = await h.simulate('DIP');
      const [a, b] = await Promise.all([h.act(s.id, 'accept'), h.act(s.id, 'accept')]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      expect(h.jobs.executions).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('over the limit: approval required, then executes; the approval binds the plan', async () => {
    const h = await harness();
    try {
      const s = await h.simulate('DIP', { amountUsd: '50' });
      const res = await h.act(s.id, 'accept');
      const body = res.json() as { result: string; approvalId: string };
      expect(body.result).toBe('NEEDS_APPROVAL');
      expect(h.jobs.executions).toHaveLength(0);
      const approval = await h.app.deps.prisma.approval.findUniqueOrThrow({
        where: { id: body.approvalId },
      });
      const plan = await h.app.deps.prisma.actionPlan.findUniqueOrThrow({
        where: { id: s.plan!.id },
      });
      expect(approval.planHash).toBe(plan.planHash);
      expect(plan).toMatchObject({ status: 'AWAITING_APPROVAL', policyOutcome: 'STEP_UP' });

      const approve = await h.app.inject({
        method: 'POST',
        url: `/approvals/${body.approvalId}/dev-approve`,
        headers: { authorization: `Bearer ${h.token}` },
      });
      expect(approve.statusCode).toBe(200);
      expect(h.jobs.executions.map((e) => e.planId)).toEqual([s.plan!.id]);
      expect(await h.exec(s.plan!.id)).toBe('executed');
      const row = (await h.list()).suggestions.find((x) => x.id === s.id)!;
      expect(row).toMatchObject({ status: 'ACCEPTED', note: 'Done.' });
    } finally {
      await h.close();
    }
  });

  it('denying that approval closes the suggestion and tells Telegram', async () => {
    const h = await harness();
    try {
      const s = await h.simulate('DIP', { amountUsd: '50' });
      const { approvalId } = (await h.act(s.id, 'accept')).json() as { approvalId: string };
      h.notes.sent = [];
      const deny = await h.app.inject({
        method: 'POST',
        url: `/approvals/${approvalId}/deny`,
        headers: { authorization: `Bearer ${h.token}` },
      });
      expect(deny.statusCode).toBe(200);
      const row = (await h.list()).suggestions.find((x) => x.id === s.id)!;
      expect(row).toMatchObject({ status: 'DECLINED', plan: { status: 'CANCELLED' } });
      expect(h.notes.sent).toEqual([{ kind: 'outcome', suggestionId: s.id }]);
    } finally {
      await h.close();
    }
  });

  it('expired: the plan closes and nothing runs', async () => {
    const h = await harness();
    try {
      await askFirst(h);
      const s = await h.simulate('DIP');
      await h.app.deps.prisma.suggestion.update({
        where: { id: s.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const res = await h.act(s.id, 'accept');
      expect(res.json()).toMatchObject({
        result: 'EXPIRED',
        suggestion: { status: 'EXPIRED', plan: { status: 'EXPIRED' } },
      });
      expect(h.jobs.executions).toHaveLength(0);
      expect(h.jobs.logs).toContain(s.plan!.id);
    } finally {
      await h.close();
    }
  });

  it('the sweep expires open suggestions after their 15 minutes, once', async () => {
    const h = await harness();
    try {
      await askFirst(h);
      const s = await h.simulate('DIP');
      expect(new Date(s.expiresAt!).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
      expect(new Date(s.expiresAt!).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);
      await h.app.deps.prisma.suggestion.update({
        where: { id: s.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(await sweepExpiredSuggestions(h.deps)).toBeGreaterThanOrEqual(1);
      expect((await h.list()).suggestions.find((x) => x.id === s.id)).toMatchObject({
        status: 'EXPIRED',
        actions: [],
      });
      expect(h.notes.sent).toContainEqual({ kind: 'outcome', suggestionId: s.id });
      expect((await h.list()).openCount).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('re-quote moved over 1%: nothing runs and it says so', async () => {
    const h = await harness();
    try {
      await askFirst(h);
      const s = await h.simulate('DIP');
      h.market.eth = new Decimal(2600); // $20 of USDC now buys 3.8% less ETH
      const res = await h.act(s.id, 'accept');
      expect(res.json()).toMatchObject({
        result: 'PRICE_MOVED',
        suggestion: { status: 'FAILED', plan: { status: 'CANCELLED' } },
      });
      expect(h.jobs.executions).toHaveLength(0);
      expect(h.jobs.logs).toContain(s.plan!.id);
    } finally {
      await h.close();
    }
  });

  it('a re-quote that cannot be read gives the human their choice back', async () => {
    const h = await harness();
    try {
      await askFirst(h);
      const s = await h.simulate('DIP');
      h.market.handlers.get_quote = () => ({ error: { code: 'UPSTREAM', message: 'down' } });
      const res = await h.act(s.id, 'accept');
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      const row = (await h.list()).suggestions.find((x) => x.id === s.id)!;
      expect(row).toMatchObject({ status: 'OPEN', actions: ['yes', 'change', 'no'] });
      expect(row.expiresAt).not.toBeNull();
      delete h.market.handlers.get_quote;
      expect((await h.act(s.id, 'accept')).statusCode).toBe(200);
    } finally {
      await h.close();
    }
  });

  it('limits used up since the preview: Yes asks for approval instead of running', async () => {
    const h = await harness();
    try {
      await askFirst(h);
      const s = await h.simulate('DIP');
      await h.app.deps.prisma.limits.update({
        where: { userId: h.userId },
        data: { perActionUsd: '5' },
      });
      expect((await h.act(s.id, 'accept')).json()).toMatchObject({ result: 'NEEDS_APPROVAL' });
      expect(h.jobs.executions).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('a hook that turned Danger after the preview refuses at Yes', async () => {
    const h = await harness();
    try {
      await askFirst(h);
      const hook = getAddress(`0x${randomBytes(20).toString('hex')}`);
      await giveHook(h, hook, 90, 'SAFE');
      const s = await h.simulate('DIP');
      await h.app.deps.prisma.actionPlan.update({
        where: { id: s.plan!.id },
        data: { hookAddress: hook, hookScore: 90 },
      });
      await h.app.deps.prisma.hook.update({
        where: { chainId_address: { chainId: 11155111, address: hook } },
        data: { score: 10, band: 'DANGER' },
      });
      expect((await h.act(s.id, 'accept')).json()).toMatchObject({
        result: 'REFUSED',
        suggestion: { status: 'FAILED', plan: { status: 'REFUSED' } },
      });
      expect(h.jobs.executions).toHaveLength(0);
      expect(h.jobs.logs).toContain(s.plan!.id);
    } finally {
      await h.close();
    }
  });

  it('another human cannot touch it', async () => {
    const h = await harness();
    try {
      await askFirst(h);
      const s = await h.simulate('DIP');
      const stranger = await devSignIn(h.app, uniqueName('stranger'));
      for (const action of ['accept', 'decline', 'change'] as const)
        expect((await h.act(s.id, action, stranger.token)).statusCode).toBe(404);
      expect((await h.list()).suggestions.find((x) => x.id === s.id)?.status).toBe('OPEN');
    } finally {
      await h.close();
    }
  });
});

describe('suggestions: No and Change', () => {
  it('No: closed, logged as proof the agent did not act, card updated', async () => {
    const h = await harness();
    try {
      await askFirst(h);
      const s = await h.simulate('DIP');
      expect((await h.act(s.id, 'decline')).json()).toMatchObject({
        result: 'DECLINED',
        suggestion: { status: 'DECLINED', plan: { status: 'CANCELLED' } },
      });
      expect(h.jobs.logs).toContain(s.plan!.id);
      expect((await h.act(s.id, 'accept')).statusCode).toBe(409);
      const msg = await h.app.deps.prisma.chatMessage.findFirstOrThrow({
        where: { userId: h.userId, role: 'AGENT' },
        orderBy: { createdAt: 'desc' },
      });
      expect(msg.cards).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'suggestion', status: 'DECLINED', actions: [] }),
          expect.objectContaining({ type: 'preview', status: 'CANCELLED' }),
        ]),
      );
    } finally {
      await h.close();
    }
  });

  it('Change: the prepared plan cannot run any more; Telegram gets the deep link', async () => {
    const h = await harness();
    try {
      await askFirst(h);
      const s = await h.simulate('DIP');
      expect((await h.act(s.id, 'change')).json()).toMatchObject({
        result: 'CHANGED',
        prefill: 'Swap $20 USDC to ETH',
        suggestion: { status: 'DECLINED', plan: { status: 'CANCELLED' } },
      });
      expect(h.notes.sent).toContainEqual({
        kind: 'outcome',
        suggestionId: s.id,
        link: {
          label: 'Open in the app',
          url: `http://localhost:5173/?prefill=Swap%20%2420%20USDC%20to%20ETH&suggestion=${s.id}`,
        },
      });
    } finally {
      await h.close();
    }
  });

  it('Change on an information event just hands over the request', async () => {
    const h = await harness();
    try {
      const s = await h.simulate('NEW_HOOK');
      expect(s).toMatchObject({ status: 'INFO', actions: ['change'] });
      expect((await h.act(s.id, 'change')).json()).toMatchObject({
        result: 'CHANGED',
        suggestion: { status: 'INFO' },
      });
      expect(s.prefill).toContain('through hook');
    } finally {
      await h.close();
    }
  });

  it('deep links survive any text', () => {
    const url = new URL(changeLink('https://app.test', 'id1', 'Swap $5 & go? #1'));
    expect(url.searchParams.get('prefill')).toBe('Swap $5 & go? #1');
    expect(url.searchParams.get('suggestion')).toBe('id1');
  });
});

describe('a price drop buys, and the inbox says so', () => {
  it('runs alone under the limit, then reports the purchase and why', async () => {
    const h = await harness();
    try {
      const s = await h.simulate('BIG_MOVE');
      expect(s).toMatchObject({
        severity: 'RED',
        status: 'AUTO_EXECUTED',
        note: 'Within your limits: your agent is doing this now.',
        plan: { policyOutcome: 'AUTO', amountUsd: '20.00' },
      });
      expect(await h.exec(s.plan!.id)).toBe('executed');
      const done = (await h.list()).suggestions.find((x) => x.id === s.id)!;
      expect(done.title).toMatch(/^Bought .* ETH for \$20\.00$/);
      expect(done.message).toMatch(/^Your agent bought .* ETH with 20 USDC\. Why: ETH moved -6%/);
      expect(done.plan?.tx?.hash).toMatch(/^0x/);
      const msg = await h.app.deps.prisma.chatMessage.findFirstOrThrow({
        where: { traceId: { not: null }, userId: h.userId, cards: { not: undefined } },
        orderBy: { createdAt: 'asc' },
      });
      expect(msg.cards).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'suggestion', title: done.title }),
        ]),
      );
    } finally {
      await h.close();
    }
  });

  it('obeys the "Dip buys" switch', async () => {
    const h = await harness();
    try {
      await askFirst(h);
      const s = await h.simulate('BIG_MOVE');
      expect(s).toMatchObject({ status: 'OPEN', plan: { policyOutcome: 'ASK' } });
      expect(h.jobs.executions).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('over the limit it waits for the human, however big the drop', async () => {
    const h = await harness();
    try {
      const s = await h.simulate('BIG_MOVE', { amountUsd: '50', ethChange1hPct: '-30' });
      expect(s).toMatchObject({ status: 'OPEN', plan: { approver: 'verified_human' } });
      expect(h.jobs.executions).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('a sale in profit reports the profit', async () => {
    const h = await harness();
    try {
      await h.app.deps.prisma.limits.update({
        where: { userId: h.userId },
        data: { perActionUsd: '1000', perDayUsd: '5000' },
      });
      const s = await h.simulate('PROFIT', { token: 'ETH', pnlPct: '25' });
      expect(await h.exec(s.plan!.id)).toBe('executed');
      const done = (await h.list()).suggestions.find((x) => x.id === s.id)!;
      expect(done.title).toMatch(/^Sold 0\.25 ETH for .* USDC$/);
      // $625 sold at +25%: $125 of it is profit.
      expect(done.message).toContain('locking in about $125.00 of profit');
    } finally {
      await h.close();
    }
  });

  it('a failed trade never claims it happened', async () => {
    const h = await harness();
    try {
      const s = await h.simulate('BIG_MOVE');
      await planSettled(h.deps, s.plan!.id, 'failed');
      const row = (await h.list()).suggestions.find((x) => x.id === s.id)!;
      expect(row.status).toBe('FAILED');
      expect(row.title).not.toMatch(/^Bought/);
    } finally {
      await h.close();
    }
  });
});

describe('after execution', () => {
  it('a cancelled countdown does not stay "auto-executed"', async () => {
    const h = await harness({ AUTO_EXECUTE_DELAY_MS: '3000' });
    try {
      const s = await h.simulate('DIP');
      expect(s.status).toBe('AUTO_EXECUTED');
      const res = await h.app.inject({
        method: 'POST',
        url: `/plans/${s.plan!.id}/cancel`,
        headers: { authorization: `Bearer ${h.token}` },
      });
      expect(res.statusCode).toBe(200);
      expect((await h.list()).suggestions.find((x) => x.id === s.id)).toMatchObject({
        status: 'FAILED',
        note: 'Cancelled. Nothing was traded.',
      });
    } finally {
      await h.close();
    }
  });

  it('a failed run is reported as failed', async () => {
    const h = await harness();
    try {
      const s = await h.simulate('DIP');
      await planSettled(h.deps, s.plan!.id, 'failed');
      expect((await h.list()).suggestions.find((x) => x.id === s.id)).toMatchObject({
        status: 'FAILED',
      });
    } finally {
      await h.close();
    }
  });

  it('a rule plan gets a receipt on Telegram; an unrelated plan gets nothing', async () => {
    const h = await harness();
    try {
      const prisma = h.app.deps.prisma;
      const s = await h.simulate('DIP');
      const plan = await prisma.actionPlan.findUniqueOrThrow({
        where: { id: s.plan!.id },
        select: { agentRequestId: true },
      });
      await prisma.suggestion.delete({ where: { id: s.id } });
      h.notes.sent = [];
      await planSettled(h.deps, s.plan!.id, 'executed');
      expect(h.notes.sent).toEqual([]);
      await prisma.agentRequest.update({
        where: { id: plan.agentRequestId },
        data: { channel: 'TRIGGER' },
      });
      await planSettled(h.deps, s.plan!.id, 'executed');
      expect(h.notes.sent).toEqual([{ kind: 'receipt', planId: s.plan!.id }]);
    } finally {
      await h.close();
    }
  });

  it('approval results reach a suggestion only when one exists', async () => {
    const h = await harness();
    try {
      await approvalResolved(h.deps, { actionPlanId: 'nope' }, 'DENIED');
      expect(h.notes.sent).toEqual([]);
    } finally {
      await h.close();
    }
  });
});

describe('HOOK_CHANGED end to end', () => {
  it('RED alert with an exit proposal; it never runs alone; Yes needs the human', async () => {
    const h = await harness();
    try {
      const position = await givePosition(h, null);
      const s = await h.simulate('HOOK_CHANGED', { positionId: position.id });
      expect(s).toMatchObject({
        severity: 'RED',
        status: 'OPEN',
        actions: ['yes', 'change', 'no'],
        plan: { policyOutcome: 'ASK' },
      });
      expect(s.plan!.summary).toContain('exit 100%');
      expect(s.title).toContain('changed');
      expect(h.jobs.executions).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('a Danger-rated hook does not trap the position: the exit is offered, then steps up', async () => {
    const h = await harness();
    try {
      const hook = getAddress(`0x${randomBytes(20).toString('hex')}`);
      await giveHook(h, hook, 10, 'DANGER');
      const position = await givePosition(h, hook);
      const s = await h.simulate('HOOK_CHANGED', { positionId: position.id, hookAddress: hook });
      expect(s).toMatchObject({ status: 'OPEN', plan: { policyOutcome: 'ASK' } });
      expect((await h.act(s.id, 'accept')).json()).toMatchObject({ result: 'NEEDS_APPROVAL' });
    } finally {
      await h.close();
    }
  });

  it('auto-act can never rebalance a hook pool, even with the toggle on', async () => {
    const h = await harness();
    try {
      const hook = getAddress(`0x${randomBytes(20).toString('hex')}`);
      await giveHook(h, hook, 90, 'SAFE');
      const position = await givePosition(h, hook);
      await h.app.deps.prisma.user.update({
        where: { id: h.userId },
        data: { autoAct: { OUT_OF_RANGE: true } },
      });
      const s = await h.simulate('OUT_OF_RANGE', { positionId: position.id });
      expect(s).toMatchObject({ status: 'OPEN', plan: { policyOutcome: 'ASK' } });
      expect(h.jobs.executions).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('a hookless position with the toggle on may rebalance alone', async () => {
    const h = await harness();
    try {
      const position = await givePosition(h, null);
      await h.app.deps.prisma.user.update({
        where: { id: h.userId },
        data: { autoAct: { OUT_OF_RANGE: true } },
      });
      const s = await h.simulate('OUT_OF_RANGE', { positionId: position.id });
      expect(s).toMatchObject({
        status: 'AUTO_EXECUTED',
        plan: { policyOutcome: 'AUTO', status: 'QUEUED' },
      });
      expect(h.jobs.executions).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
});

describe('simulate-event', () => {
  it('needs the admin token and a real wallet', async () => {
    const h = await harness();
    try {
      const noToken = await h.app.inject({
        method: 'POST',
        url: '/admin/simulate-event',
        payload: { userId: h.userId, detector: 'DIP' },
      });
      expect(noToken.statusCode).toBe(401);
      const unknown = await h.app.inject({
        method: 'POST',
        url: '/admin/simulate-event',
        headers: ADMIN,
        payload: { userId: 'nobody', detector: 'DIP' },
      });
      expect(unknown.statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });

  it('says why when the account cannot produce the event', async () => {
    const h = await harness();
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/admin/simulate-event',
        headers: ADMIN,
        payload: { userId: h.userId, detector: 'OUT_OF_RANGE' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toContain('did not fire');
    } finally {
      await h.close();
    }
  });

  it('takes the identical path as a real tick, apart from the tag; demos can repeat', async () => {
    const h = await harness();
    try {
      const prisma = h.app.deps.prisma;
      await prisma.user.updateMany({
        where: { id: { not: h.userId }, onboardingStep: 'DONE' },
        data: { onboardingStep: 'FUND' },
      });
      await setPriceOverride(
        h.app.deps.redis,
        { symbol: 'ETH', priceUsd: '2600', ttlSec: 60 },
        new Date(),
      );
      h.market.handlers.get_price_history = (args) => history(args, '2600', '3000');
      const real = await runModeBTick(h.deps, { budgetMs: 10_000, sleep: async () => undefined });
      await clearPriceOverride(h.app.deps.redis, 'ETH');
      expect(real.checked).toBe(1);
      const realRow = (await h.list()).suggestions.find((x) => x.detector === 'DIP')!;

      const sim = await h.simulate('DIP');
      const again = await h.simulate('DIP');
      expect(again.id).not.toBe(sim.id);

      const shape = (s: SuggestionView) => ({
        detector: s.detector,
        severity: s.severity,
        status: s.status,
        outcome: s.plan?.policyOutcome,
        approver: s.plan?.approver,
        amount: s.plan?.amountUsd,
      });
      expect(shape(sim)).toEqual(shape(realRow));
      expect(realRow.simulated).toBe(false);
      expect(sim.simulated).toBe(true);
    } finally {
      await h.close();
    }
  });
});

describe('Mode B tick', () => {
  const isolate = (h: Harness) =>
    h.app.deps.prisma.user.updateMany({
      where: { id: { not: h.userId }, onboardingStep: 'DONE' },
      data: { onboardingStep: 'FUND' },
    });
  const tick = (h: Harness, budgetMs = 10_000) =>
    runModeBTick(h.deps, { budgetMs, sleep: async () => undefined });
  const count = (h: Harness, detector: 'DIP' | 'BIG_MOVE') =>
    h.app.deps.prisma.suggestion.count({ where: { userId: h.userId, detector } });

  async function withDip<T>(h: Harness, run: () => Promise<T>): Promise<T> {
    await setPriceOverride(
      h.app.deps.redis,
      { symbol: 'ETH', priceUsd: '2600', ttlSec: 60 },
      new Date(),
    );
    h.market.handlers.get_price_history = (args) => history(args, '2600', '3000');
    try {
      return await run();
    } finally {
      await clearPriceOverride(h.app.deps.redis, 'ETH');
    }
  }

  it('fires once per window, however many ticks run', async () => {
    const h = await harness();
    try {
      await isolate(h);
      await withDip(h, async () => {
        await tick(h);
        await tick(h);
      });
      expect(await count(h, 'DIP')).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('skips users whose wallet is empty', async () => {
    const h = await harness();
    try {
      await isolate(h);
      h.market.handlers.get_portfolio = (args) => ({
        chainId: args.chainId,
        address: getAddress(String(args.address)),
        tokens: [],
        totalUsd: '0',
        unpriced: [],
        priceSource: 'test',
        blockNumber: '1',
        asOf: new Date().toISOString(),
      });
      await h.app.deps.redis.del(`portfolio:raw:${h.userId}`);
      const r = await withDip(h, () => tick(h));
      expect(r).toMatchObject({ checked: 0, skippedUnfunded: 1, suggestions: 0 });
    } finally {
      await h.close();
    }
  });

  it('stops at the daily cap, and RED alerts still get through', async () => {
    const h = await harness();
    try {
      await isolate(h);
      const prisma = h.app.deps.prisma;
      await prisma.suggestion.createMany({
        data: Array.from({ length: 5 }, (_, i) => ({
          userId: h.userId,
          detector: 'NEW_HOOK' as const,
          dedupeKey: `filler:${i}`,
          severity: 'INFO' as const,
          message: 'x',
          status: 'INFO' as const,
        })),
      });
      await h.app.deps.redis.del('modeb:eth:samples');
      const r = await withDip(h, async () => {
        h.market.handlers.get_price_history = (args) => history(args, '3000', '3000');
        return tick(h);
      });
      expect(r.capped).toBeGreaterThanOrEqual(1);
      expect(await count(h, 'DIP')).toBe(0);
      expect(await count(h, 'BIG_MOVE')).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('demo events never use up the cap', async () => {
    const h = await harness();
    try {
      await isolate(h);
      await askFirst(h);
      for (let i = 0; i < 6; i += 1) await h.simulate('DIP');
      const r = await withDip(h, () => tick(h));
      expect(r.capped).toBe(0);
      const real = await h.app.deps.prisma.suggestion.count({
        where: { userId: h.userId, detector: 'DIP', simulated: false },
      });
      expect(real).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('a spent budget defers the rest and the next tick starts with them', async () => {
    const h = await harness();
    try {
      const prisma = h.app.deps.prisma;
      await isolate(h);
      const other = await devSignIn(h.app, uniqueName('second'));
      await giveWallet(prisma, other.user.id);
      await h.app.deps.redis.del('modeb:cursor');
      let t = 0;
      const clock = () => {
        t += 1000;
        return t;
      };
      const first = await runModeBTick(h.deps, {
        budgetMs: 1500,
        sleep: async () => undefined,
        elapsedMs: clock,
      });
      expect(first).toMatchObject({ users: 2, deferred: 1 });
      const next = await runModeBTick(h.deps, { budgetMs: 10_000, sleep: async () => undefined });
      expect(next.deferred).toBe(0);
      expect(await h.app.deps.redis.get('modeb:cursor')).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('counts consecutive out-of-range checks and resets when back in range', async () => {
    const h = await harness();
    try {
      await isolate(h);
      await askFirst(h);
      const position = await givePosition(h, null);
      const base = h.market.handlers.get_lp_positions!;
      h.market.handlers.get_lp_positions = (args) => {
        const out = base(args) as ReturnType<typeof lpPositionOutput>;
        return { ...out, positions: out.positions.map((p) => ({ ...p, inRange: false })) };
      };
      await tick(h);
      const oor = () =>
        h.app.deps.prisma.suggestion.count({
          where: { userId: h.userId, detector: 'OUT_OF_RANGE' },
        });
      expect(await oor()).toBe(0);
      await tick(h);
      expect(await oor()).toBe(1);
      h.market.handlers.get_lp_positions = base;
      await tick(h);
      expect(await h.app.deps.redis.hget(`modeb:oor:${h.userId}`, position.tokenId)).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('a USDC outflow restarts the idle clock', async () => {
    const h = await harness();
    try {
      await isolate(h);
      await tick(h);
      const key = `modeb:usdc:${h.userId}`;
      expect(await h.app.deps.redis.hget(key, 'outflowAt')).toBeNull();
      expect(await h.app.deps.redis.hget(key, 'heldSince')).not.toBeNull();
      await h.app.deps.redis.hset(key, 'raw', '200000000'); // it used to be 200 USDC
      await tick(h);
      expect(await h.app.deps.redis.hget(key, 'outflowAt')).not.toBeNull();
    } finally {
      await h.close();
    }
  });

  it('closes expired suggestions first, even with no users to check', async () => {
    const h = await harness();
    try {
      await askFirst(h);
      const s = await h.simulate('DIP');
      await h.app.deps.prisma.suggestion.update({
        where: { id: s.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await tick(h)).expired).toBeGreaterThanOrEqual(1);
    } finally {
      await h.close();
    }
  });
});

describe('morning brief', () => {
  it('on demand: pinned, not in the list, not blocked by an earlier brief', async () => {
    const h = await harness();
    try {
      const run = () =>
        h.app.inject({
          method: 'POST',
          url: '/admin/run-brief',
          headers: ADMIN,
          payload: { userId: h.userId },
        });
      const first = await run();
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        detector: 'MORNING_BRIEF',
        status: 'INFO',
        simulated: false,
      });
      expect((await run()).statusCode).toBe(200);
      const list = await h.list();
      expect(list.brief?.detector).toBe('MORNING_BRIEF');
      expect(list.suggestions.some((s) => s.detector === 'MORNING_BRIEF')).toBe(false);
      expect(h.notes.kinds()).toContain('suggestion');
    } finally {
      await h.close();
    }
  });

  it('falls back to the template when 0G is down', async () => {
    const h = await harness();
    try {
      h.zgDown();
      const res = await h.app.inject({
        method: 'POST',
        url: '/admin/run-brief',
        headers: ADMIN,
        payload: { userId: h.userId },
      });
      const brief = res.json() as SuggestionView;
      expect(brief.message).toContain('- Portfolio: $');
      expect(brief.zg).toBeNull();
    } finally {
      await h.close();
    }
  });
});

describe('settings', () => {
  it('auto-act toggles merge; settings report Telegram and the zone', async () => {
    const h = await harness();
    try {
      const auth = { authorization: `Bearer ${h.token}` };
      const put = await h.app.inject({
        method: 'PUT',
        url: '/settings/auto-act',
        headers: auth,
        payload: { DIP: false },
      });
      expect(put.json()).toMatchObject({ autoAct: { DIP: false, PROFIT: true } });
      const bad = await h.app.inject({
        method: 'PUT',
        url: '/settings/auto-act',
        headers: auth,
        payload: { HOOK_CHANGED: true },
      });
      expect(bad.statusCode).toBe(400);
      const got = await h.app.inject({ method: 'GET', url: '/settings', headers: auth });
      expect(got.json()).toMatchObject({
        timezone: 'Asia/Kolkata',
        telegram: { available: false, linked: false, muted: false },
        autoAct: { DIP: false, IDLE_USDC: true },
      });
    } finally {
      await h.close();
    }
  });

  it('a new time zone is validated and moves DCA runs', async () => {
    const h = await harness();
    try {
      const auth = { authorization: `Bearer ${h.token}` };
      const prisma = h.app.deps.prisma;
      const rule = await prisma.trigger.create({
        data: {
          userId: h.userId,
          kind: 'DCA',
          status: 'ACTIVE',
          summary: 'x',
          nextRunAt: new Date(Date.now() + 3_600_000),
          spec: {
            kind: 'DCA',
            condition: {
              type: 'schedule',
              symbol: null,
              targetPriceUsd: null,
              referencePriceUsd: null,
              changePct: null,
              every: 'day',
              atLocalTime: '09:00',
              dayOfWeek: null,
            },
            actions: [],
          } as unknown as UniswapMcp.TriggerSpec as never,
        },
      });
      const bad = await h.app.inject({
        method: 'PUT',
        url: '/settings/timezone',
        headers: auth,
        payload: { timezone: 'Mars/Base' },
      });
      expect(bad.statusCode).toBe(400);
      const ok = await h.app.inject({
        method: 'PUT',
        url: '/settings/timezone',
        headers: auth,
        payload: { timezone: 'America/New_York' },
      });
      expect(ok.statusCode).toBe(200);
      const after = await prisma.trigger.findUniqueOrThrow({ where: { id: rule.id } });
      const local = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
      }).format(after.nextRunAt!);
      expect(local).toBe('09:00');
    } finally {
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

describe('telegram text', () => {
  it('escapes every MarkdownV2 special character', () => {
    expect(escapeMd('_*[]()~`>#+-=|{}.!\\')).toBe(
      '\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\',
    );
    expect(escapeMd('$20.50 (ETH)')).toBe('$20\\.50 \\(ETH\\)');
    expect(escapeMd('plain text')).toBe('plain text');
  });

  it('only public URLs become links: Telegram rejects localhost in a button', () => {
    expect(isPublicUrl('https://app.warden.xyz/approvals/1')).toBe(true);
    for (const url of [
      'http://localhost:5173/x',
      'http://127.0.0.1:5173/x',
      'http://192.168.1.2/x',
      'http://app.local/x',
      'javascript:alert(1)',
      'nonsense',
    ])
      expect(isPublicUrl(url)).toBe(false);
    expect(linkLine('Go', 'https://a.io/x)y')).toBe('[Go](https://a.io/x\\)y)');
    expect(linkLine('Go', 'http://localhost:5173/x')).toBe('Go: http://localhost:5173/x');
  });

  const view = (over: Partial<SuggestionView> = {}): SuggestionView => ({
    id: 's1',
    detector: 'DIP',
    severity: 'RED',
    status: 'OPEN',
    title: 'ETH dipped 11.5%: buy $20.00',
    message: 'Model text with (parens) and a dot.',
    note: null,
    simulated: true,
    plan: {
      id: 'p1',
      summary: 'swap',
      status: 'PREPARED',
      policyOutcome: 'ASK',
      amountUsd: '20.00',
      tradeScore: 92,
      hookScore: null,
      approver: 'verified_human',
      reasons: [],
      approvalId: null,
      tx: null,
    },
    prefill: null,
    actions: ['yes', 'no'],
    expiresAt: null,
    createdAt: new Date().toISOString(),
    zg: {
      requestId: 'req-1.2',
      clientRequestId: 'c',
      model: 'm',
      trustMode: 'private',
    },
    ...over,
  });

  it('an alert carries severity, the key numbers, who approves and the proof', () => {
    const text = renderAlert(view());
    expect(text).toContain('🔴');
    expect(text).toContain('Simulated event \\(demo\\)');
    expect(text).toContain('Model text with \\(parens\\) and a dot\\.');
    expect(text).toContain('Amount: *$20\\.00*');
    expect(text).toContain('Trade score: *92/100*');
    expect(text).toContain('You, with a fresh human check');
    expect(text).toContain('0G verified · req\\-1\\.2');
  });

  it('the edited message shows the result with a transaction link', () => {
    const done = view({
      status: 'ACCEPTED',
      plan: {
        ...view().plan!,
        status: 'EXECUTED',
        tx: { hash: '0xabc', explorerUrl: 'https://sepolia.etherscan.io/tx/0xabc' },
      },
    });
    const text = renderOutcome(done);
    expect(text).toContain('✅ Executed');
    expect(text).toContain('[View transaction](https://sepolia.etherscan.io/tx/0xabc)');
    expect(renderOutcome(view({ status: 'EXPIRED', note: 'Gone.' }))).toContain('⌛ Gone\\.');
  });
});

describe('telegram buttons', () => {
  const secret = 'x'.repeat(44);
  const id = 'cmhn1k2ab0000xyz123456789';

  it('fit in 64 bytes and survive a round trip', () => {
    for (const action of ['yes', 'change', 'no'] as const) {
      const token = signCallback(secret, action, id);
      expect(Buffer.byteLength(token)).toBeLessThanOrEqual(64);
      expect(verifyCallback(secret, token)).toEqual({ action, suggestionId: id });
    }
  });

  it('reject tampering, foreign keys and junk', () => {
    const token = signCallback(secret, 'no', id);
    expect(verifyCallback('y'.repeat(44), token)).toBeNull();
    expect(verifyCallback(secret, token.replace('n:', 'y:'))).toBeNull();
    expect(verifyCallback(secret, `${token}x`)).toBeNull();
    expect(verifyCallback(secret, 'y:only')).toBeNull();
    expect(verifyCallback(secret, '')).toBeNull();
  });
});

describe('telegram link codes', () => {
  it('work once, expire, and are stored hashed', async () => {
    const h = await harness();
    try {
      const prisma = h.app.deps.prisma;
      const now = new Date();
      const { code } = await createLinkCode(prisma, h.userId, now);
      const stored = await prisma.telegramLinkCode.findFirstOrThrow({
        where: { userId: h.userId },
      });
      expect(stored.codeHash).not.toContain(code);

      const chat = `chat-${randomBytes(4).toString('hex')}`;
      const late = new Date(now.getTime() + 11 * 60_000);
      expect(await redeemLinkCode(prisma, code, chat, late)).toEqual({
        ok: false,
        reason: 'invalid',
      });
      expect(await redeemLinkCode(prisma, 'wrong-code', chat, now)).toMatchObject({ ok: false });
      expect(await redeemLinkCode(prisma, code, chat, now)).toMatchObject({ ok: true });
      expect(await redeemLinkCode(prisma, code, chat, now)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    } finally {
      await h.close();
    }
  });

  it('a new code replaces the old one', async () => {
    const h = await harness();
    try {
      const prisma = h.app.deps.prisma;
      const first = await createLinkCode(prisma, h.userId, new Date());
      const second = await createLinkCode(prisma, h.userId, new Date());
      const chat = `chat-${randomBytes(4).toString('hex')}`;
      expect((await redeemLinkCode(prisma, first.code, chat, new Date())).ok).toBe(false);
      expect((await redeemLinkCode(prisma, second.code, chat, new Date())).ok).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('one chat ↔ one user, both ways', async () => {
    const h = await harness();
    try {
      const prisma = h.app.deps.prisma;
      const other = await devSignIn(h.app, uniqueName('other'));
      const chat = `chat-${randomBytes(4).toString('hex')}`;
      const mine = await createLinkCode(prisma, h.userId, new Date());
      expect((await redeemLinkCode(prisma, mine.code, chat, new Date())).ok).toBe(true);

      const theirs = await createLinkCode(prisma, other.user.id, new Date());
      expect(await redeemLinkCode(prisma, theirs.code, chat, new Date())).toEqual({
        ok: false,
        reason: 'chat_taken',
      });
      const again = await createLinkCode(prisma, h.userId, new Date());
      expect(await redeemLinkCode(prisma, again.code, `${chat}-2`, new Date())).toEqual({
        ok: false,
        reason: 'user_taken',
      });
    } finally {
      await h.close();
    }
  });

  it('the API gives a t.me link and refuses when already linked or not set up', async () => {
    const h = await harness({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_BOT_USERNAME: 'warden_bot' });
    try {
      const auth = { authorization: `Bearer ${h.token}` };
      const res = await h.app.inject({ method: 'POST', url: '/telegram/link-code', headers: auth });
      expect(res.json().url).toMatch(/^https:\/\/t\.me\/warden_bot\?start=[\w-]{20,64}$/);
      await h.app.deps.prisma.user.update({
        where: { id: h.userId },
        data: { telegramChatId: `chat-${randomBytes(4).toString('hex')}` },
      });
      const twice = await h.app.inject({
        method: 'POST',
        url: '/telegram/link-code',
        headers: auth,
      });
      expect(twice.statusCode).toBe(409);
      const mute = await h.app.inject({
        method: 'PUT',
        url: '/telegram/mute',
        headers: auth,
        payload: { muted: true },
      });
      expect(mute.json()).toEqual({ muted: true });
      const off = await h.app.inject({
        method: 'POST',
        url: '/telegram/disconnect',
        headers: auth,
      });
      expect(off.statusCode).toBe(200);
      const user = await h.app.deps.prisma.user.findUniqueOrThrow({ where: { id: h.userId } });
      expect(user).toMatchObject({ telegramChatId: null, telegramMuted: false });
    } finally {
      await h.close();
    }

    const bare = await harness();
    try {
      const res = await bare.app.inject({
        method: 'POST',
        url: '/telegram/link-code',
        headers: { authorization: `Bearer ${bare.token}` },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });

  it('the webhook rejects a wrong secret and is absent without one', async () => {
    const secret = 'webhook-secret-0123456789';
    const h = await harness({ TELEGRAM_BOT_TOKEN: '1:abc', TELEGRAM_WEBHOOK_SECRET: secret });
    try {
      const bad = await h.app.inject({
        method: 'POST',
        url: '/telegram/webhook',
        headers: { 'x-telegram-bot-api-secret-token': 'nope' },
        payload: { update_id: 1 },
      });
      expect(bad.statusCode).toBe(401);
    } finally {
      await h.close();
    }
    const bare = await harness();
    try {
      const res = await bare.app.inject({
        method: 'POST',
        url: '/telegram/webhook',
        payload: { update_id: 1 },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await bare.close();
    }
  });
});

interface BotHarness {
  replies: { method: string; payload: Record<string, unknown> }[];
  text(chatId: number, text: string): Promise<void>;
  press(chatId: number, data: string, type?: 'private' | 'group'): Promise<void>;
  lastText(): string;
  answered(): Record<string, unknown> | undefined;
}

function botHarness(h: Harness): BotHarness {
  const bot = createBot({
    token: '1:test',
    secret: h.app.deps.env.ENCRYPTION_KEY,
    webUrl: 'https://app.test',
    appName: 'Warden',
    prisma: h.app.deps.prisma,
    traceBus: h.app.deps.traceBus,
    modeB: h.deps,
    botInfo: {
      id: 1,
      is_bot: true,
      first_name: 'Warden',
      username: 'warden_bot',
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
    } as never,
  });
  const replies: BotHarness['replies'] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    replies.push({ method, payload: payload as unknown as Record<string, unknown> });
    return { ok: true, result: true } as never;
  });
  const chat = (id: number, type: 'private' | 'group') =>
    (type === 'private' ? { id, type, first_name: 'A' } : { id, type, title: 'Group' }) as never;
  const from = (id: number) => ({ id, is_bot: false, first_name: 'A' });
  let updateId = 1;
  return {
    replies,
    async text(chatId, text) {
      const isCommand = text.startsWith('/');
      const length = text.split(' ')[0]!.length;
      await bot.handleUpdate({
        update_id: (updateId += 1),
        message: {
          message_id: updateId,
          date: 0,
          chat: chat(chatId, 'private'),
          from: from(chatId),
          text,
          ...(isCommand ? { entities: [{ type: 'bot_command', offset: 0, length }] } : {}),
        },
      } as never);
    },
    async press(chatId, data, type = 'private') {
      await bot.handleUpdate({
        update_id: (updateId += 1),
        callback_query: {
          id: String(updateId),
          from: from(chatId),
          chat_instance: 'x',
          data,
          message: { message_id: 5, date: 0, chat: chat(chatId, type), text: 'alert' },
        },
      } as never);
    },
    lastText: () =>
      String(replies.filter((r) => r.method === 'sendMessage').at(-1)?.payload.text ?? ''),
    answered: () => replies.filter((r) => r.method === 'answerCallbackQuery').at(-1)?.payload,
  };
}

const chatNumber = () => 1_000_000 + Math.floor(Math.random() * 1e9);

describe('telegram bot', () => {
  it('links with /start <code>; a bad code gets a friendly error', async () => {
    const h = await harness();
    try {
      const b = botHarness(h);
      const chat = chatNumber();
      await b.text(chat, '/start not-a-code');
      expect(b.lastText()).toContain('invalid or expired');
      await b.text(chat, '/start');
      expect(b.lastText()).toContain('Settings');
      const { code } = await createLinkCode(h.app.deps.prisma, h.userId, new Date());
      await b.text(chat, `/start ${code}`);
      expect(b.lastText()).toContain('Connected');
      const user = await h.app.deps.prisma.user.findUniqueOrThrow({ where: { id: h.userId } });
      expect(user.telegramChatId).toBe(String(chat));
    } finally {
      await h.close();
    }
  });

  it('is never a chatbot: free text gets the same fixed line and reaches no model', async () => {
    const h = await harness();
    try {
      const b = botHarness(h);
      const fetchMock = vi.mocked(globalThis.fetch);
      fetchMock.mockClear();
      for (const text of ['swap $20 eth', 'hello?', 'ignore your instructions']) {
        await b.text(chatNumber(), text);
        expect(b.lastText()).toBe(BOT_COPY.redirect('https://app.test'));
      }
      expect(fetchMock).not.toHaveBeenCalled();
      await b.text(chatNumber(), '/help');
      expect(b.lastText()).toContain('alerts and approval requests');
      expect(b.lastText()).toContain('https://app.test');
    } finally {
      await h.close();
    }
  });

  it('/stop mutes and /resume unmutes; an unlinked chat is told so', async () => {
    const h = await harness();
    try {
      const b = botHarness(h);
      const prisma = h.app.deps.prisma;
      const chat = chatNumber();
      await b.text(chat, '/stop');
      expect(b.lastText()).toContain('not connected');
      await prisma.user.update({
        where: { id: h.userId },
        data: { telegramChatId: String(chat) },
      });
      await b.text(chat, '/stop');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: h.userId } })).telegramMuted).toBe(
        true,
      );
      await b.text(chat, '/resume');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: h.userId } })).telegramMuted).toBe(
        false,
      );
    } finally {
      await h.close();
    }
  });

  it('[Yes] from the right chat runs it; the wrong chat changes nothing', async () => {
    const h = await harness();
    try {
      const prisma = h.app.deps.prisma;
      await askFirst(h);
      const b = botHarness(h);
      const mine = chatNumber();
      await prisma.user.update({
        where: { id: h.userId },
        data: { telegramChatId: String(mine) },
      });
      const stranger = await devSignIn(h.app, uniqueName('stranger'));
      const theirs = chatNumber();
      await prisma.user.update({
        where: { id: stranger.user.id },
        data: { telegramChatId: String(theirs) },
      });

      const s = await h.simulate('DIP');
      const yes = signCallback(h.app.deps.env.ENCRYPTION_KEY, 'yes', s.id);

      await b.press(theirs, yes);
      expect(b.answered()).toMatchObject({ text: BOT_COPY.notYours, show_alert: true });
      await b.press(chatNumber(), yes); // not linked at all
      expect(b.answered()).toMatchObject({ text: BOT_COPY.notYours });
      expect(h.jobs.executions).toHaveLength(0);

      await b.press(mine, `${yes.slice(0, -1)}A`);
      expect(b.answered()).toMatchObject({ text: BOT_COPY.invalidButton });
      expect(h.jobs.executions).toHaveLength(0);

      await b.press(mine, yes);
      expect(b.answered()?.text).toContain('doing it now');
      expect(h.jobs.executions.map((e) => e.planId)).toEqual([s.plan!.id]);

      await b.press(mine, yes);
      expect(b.answered()).toMatchObject({ show_alert: true });
      expect(h.jobs.executions).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('[No] and [Change] go through the same service as the web', async () => {
    const h = await harness();
    try {
      const prisma = h.app.deps.prisma;
      await askFirst(h);
      const b = botHarness(h);
      const chat = chatNumber();
      await prisma.user.update({
        where: { id: h.userId },
        data: { telegramChatId: String(chat) },
      });
      const key = h.app.deps.env.ENCRYPTION_KEY;
      const one = await h.simulate('DIP');
      await b.press(chat, signCallback(key, 'no', one.id));
      const two = await h.simulate('DIP');
      await b.press(chat, signCallback(key, 'change', two.id));
      const list = await h.list();
      expect(list.suggestions.find((x) => x.id === one.id)?.status).toBe('DECLINED');
      expect(list.suggestions.find((x) => x.id === two.id)).toMatchObject({
        status: 'DECLINED',
        note: 'You are editing this in the chat.',
      });
    } finally {
      await h.close();
    }
  });

  it('refuses group chats: alerts are private', async () => {
    const h = await harness();
    try {
      const b = botHarness(h);
      const key = h.app.deps.env.ENCRYPTION_KEY;
      await askFirst(h);
      const s = await h.simulate('DIP');
      await b.press(chatNumber(), signCallback(key, 'yes', s.id), 'group');
      expect(h.jobs.executions).toHaveLength(0);
    } finally {
      await h.close();
    }
  });
});

describe('telegram delivery', () => {
  class FakeApi implements TelegramApi {
    sent: { chatId: string; text: string; other: unknown }[] = [];
    edits: { messageId: number; text: string; other: unknown }[] = [];
    failEdit: unknown = null;
    async sendMessage(chatId: string, text: string, other: unknown) {
      this.sent.push({ chatId, text, other });
      return { message_id: 100 + this.sent.length };
    }
    async editMessageText(_c: string, messageId: number, text: string, other: unknown) {
      if (this.failEdit) throw this.failEdit;
      this.edits.push({ messageId, text, other });
      return true;
    }
  }

  const deliveryDeps = (h: Harness, api: FakeApi, webUrl = 'https://app.test'): DeliveryDeps => ({
    prisma: h.app.deps.prisma,
    api,
    secret: h.app.deps.env.ENCRYPTION_KEY,
    webUrl,
    chainId: 11155111,
    sleep: async () => undefined,
  });

  const link = (h: Harness, muted = false) =>
    h.app.deps.prisma.user.update({
      where: { id: h.userId },
      data: { telegramChatId: `chat-${randomBytes(4).toString('hex')}`, telegramMuted: muted },
    });

  it('sends the alert with signed buttons and remembers the message', async () => {
    const h = await harness();
    try {
      await link(h);
      await askFirst(h);
      const s = await h.simulate('DIP');
      const api = new FakeApi();
      await deliver(deliveryDeps(h, api), { kind: 'suggestion', suggestionId: s.id });
      expect(api.sent).toHaveLength(1);
      const markup = (api.sent[0]!.other as { reply_markup: { inline_keyboard: unknown[][] } })
        .reply_markup.inline_keyboard[0] as { text: string; callback_data: string }[];
      expect(markup.map((b) => b.text)).toEqual(['✅ Yes', '✏️ Change', '✖️ No']);
      expect(verifyCallback(h.app.deps.env.ENCRYPTION_KEY, markup[0]!.callback_data)).toEqual({
        action: 'yes',
        suggestionId: s.id,
      });
      const row = await h.app.deps.prisma.suggestion.findUniqueOrThrow({ where: { id: s.id } });
      expect(row.telegramMessageId).toBe('101');

      // A retried job does not send twice.
      await deliver(deliveryDeps(h, api), { kind: 'suggestion', suggestionId: s.id });
      expect(api.sent).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('edits the message when the human acts, and removes the buttons', async () => {
    const h = await harness();
    try {
      await link(h);
      await askFirst(h);
      const s = await h.simulate('DIP');
      const api = new FakeApi();
      await deliver(deliveryDeps(h, api), { kind: 'suggestion', suggestionId: s.id });
      await h.act(s.id, 'decline');
      await deliver(deliveryDeps(h, api), { kind: 'outcome', suggestionId: s.id });
      expect(api.edits).toHaveLength(1);
      expect(api.edits[0]).toMatchObject({
        messageId: 101,
        other: { reply_markup: { inline_keyboard: [] } },
      });
      expect(api.edits[0]!.text).toContain('You said no');
      api.failEdit = { description: 'Bad Request: message is not modified' };
      await expect(
        deliver(deliveryDeps(h, api), { kind: 'outcome', suggestionId: s.id }),
      ).resolves.toBeUndefined();
    } finally {
      await h.close();
    }
  });

  it('STEP_UP: an "Approve in app" button, or plain text when the URL is localhost', async () => {
    const h = await harness();
    try {
      await link(h);
      const s = await h.simulate('DIP', { amountUsd: '50' });
      const api = new FakeApi();
      await deliver(deliveryDeps(h, api), { kind: 'suggestion', suggestionId: s.id });
      const { approvalId } = (await h.act(s.id, 'accept')).json() as { approvalId: string };
      await deliver(deliveryDeps(h, api), { kind: 'outcome', suggestionId: s.id });
      expect(api.edits[0]!.other).toMatchObject({
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Approve in app', url: `https://app.test/approvals/${approvalId}` }],
          ],
        },
      });
      await deliver(deliveryDeps(h, api, 'http://localhost:5173'), {
        kind: 'outcome',
        suggestionId: s.id,
      });
      const local = api.edits[1]!;
      expect(local.other).toMatchObject({ reply_markup: { inline_keyboard: [] } });
      expect(local.text).toContain(`localhost:5173/approvals/${approvalId}`.replace(/\./g, '\\.'));
    } finally {
      await h.close();
    }
  });

  it('mute stops new messages; unlinked users get nothing', async () => {
    const h = await harness();
    try {
      const api = new FakeApi();
      const s = await h.simulate('BIG_MOVE', { ethChange1hPct: '6' });
      await deliver(deliveryDeps(h, api), { kind: 'suggestion', suggestionId: s.id });
      await deliver(deliveryDeps(h, api), {
        kind: 'text',
        userId: h.userId,
        title: 't',
        body: 'b',
      });
      expect(api.sent).toHaveLength(0);
      await link(h, true);
      await deliver(deliveryDeps(h, api), { kind: 'suggestion', suggestionId: s.id });
      await deliver(deliveryDeps(h, api), {
        kind: 'text',
        userId: h.userId,
        title: 't',
        body: 'b',
      });
      expect(api.sent).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('receipts for rule plans carry the transaction', async () => {
    const h = await harness();
    try {
      await link(h);
      const s = await h.simulate('DIP');
      await h.exec(s.plan!.id);
      const api = new FakeApi();
      await deliver(deliveryDeps(h, api), { kind: 'receipt', planId: s.plan!.id });
      expect(api.sent[0]!.text).toContain('Rule executed');
      expect(api.sent[0]!.text).toContain('[View transaction](https://sepolia.etherscan.io/tx/');
    } finally {
      await h.close();
    }
  });

  it('429: waits retry_after and tries again; other errors and repeated 429s surface', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const flood = { error_code: 429, parameters: { retry_after: 3 } };
    let calls = 0;
    await expect(
      withFloodControl({ sleep }, async () => {
        calls += 1;
        if (calls === 1) throw flood;
        return 'ok';
      }),
    ).resolves.toBe('ok');
    expect(waits).toEqual([3000]);

    await expect(
      withFloodControl({ sleep }, async () => {
        throw flood;
      }),
    ).rejects.toBe(flood);
    expect(waits).toHaveLength(4);

    const other = { error_code: 400 };
    await expect(
      withFloodControl({ sleep }, async () => {
        throw other;
      }),
    ).rejects.toBe(other);
    expect(waits).toHaveLength(4);
  });
});
