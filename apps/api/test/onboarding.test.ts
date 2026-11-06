import { OnboardingResponseSchema, PortfolioResponseSchema } from '@warden/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeMarket, FakeWalletProvider, fakeMcpClient, sepoliaTokens } from './fakes.js';
import { createTestApp, devSignIn, uniqueName } from './helpers.js';

let app: FastifyInstance;
const wallets = new FakeWalletProvider();
const market = createFakeMarket();

beforeAll(async () => {
  app = await createTestApp({}, { wallets, mcp: fakeMcpClient(market) });
  await app.deps.prisma.priceCache.deleteMany({ where: { key: { startsWith: 'ref-' } } });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  wallets.policyId = 'policy_test';
  wallets.delayMs = 0;
  market.failPortfolio = false;
  market.highs = { ETH: '2600' };
});

async function signIn(prefix = 'onb') {
  const s = await devSignIn(app, uniqueName(prefix));
  const auth = { authorization: `Bearer ${s.token}` };
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: auth, ...(payload !== undefined ? { payload } : {}) });
  return { ...s, call };
}

describe('onboarding state machine', () => {
  it('starts at WALLET after dev sign-in with faucets for the execution chain', async () => {
    const { call } = await signIn();
    const res = await call('GET', '/onboarding');
    expect(res.statusCode).toBe(200);
    const body = OnboardingResponseSchema.parse(res.json());
    expect(body).toMatchObject({ step: 'WALLET', wallet: null, profile: null, limits: null });
    expect(body.funding.chainId).toBe(11155111);
    expect(body.funding.faucets.map((f) => f.asset)).toEqual(['ETH', 'USDC']);
    expect(body.funding.faucets[1]!.url).toBe('https://faucet.circle.com');
    expect(body.funding.firstDeposit).toBeNull();
  });

  it("can't set a profile before the wallet exists", async () => {
    const { call } = await signIn();
    const res = await call('POST', '/onboarding/profile', { riskProfile: 'CAREFUL' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ONBOARDING_OUT_OF_ORDER');
  });

  it("can't create a wallet before human verification", async () => {
    const { call, user } = await signIn();
    await app.deps.prisma.user.update({
      where: { id: user.id },
      data: { onboardingStep: 'VERIFY' },
    });
    const res = await call('POST', '/onboarding/wallet');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ONBOARDING_OUT_OF_ORDER');
  });

  it('creates the wallet once (WALLET → PROFILE) and emits a trace event', async () => {
    const { call, user } = await signIn();
    const res = await call('POST', '/onboarding/wallet');
    expect(res.statusCode).toBe(200);
    const body = OnboardingResponseSchema.parse(res.json());
    expect(body.step).toBe('PROFILE');
    expect(body.wallet).toMatchObject({ chainId: 11155111, policyId: 'policy_test' });
    expect(body.wallet!.address).toBe(wallets.created.get(user.id)!.address);

    // Retrying is harmless: same wallet, no second Privy call, no second event.
    const callsBefore = wallets.createCalls;
    const again = OnboardingResponseSchema.parse((await call('POST', '/onboarding/wallet')).json());
    expect(again.wallet!.address).toBe(body.wallet!.address);
    expect(again.step).toBe('PROFILE');
    expect(wallets.createCalls).toBe(callsBefore);

    const events = await app.deps.prisma.traceEventRow.findMany({
      where: { userId: user.id, title: 'Agent wallet created' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toContain(body.wallet!.address);
  });

  it('converges on one wallet under concurrent requests', async () => {
    const { call, user } = await signIn();
    wallets.delayMs = 50;
    const results = await Promise.all([1, 2, 3].map(() => call('POST', '/onboarding/wallet')));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    const addresses = new Set(results.map((r) => r.json().wallet.address));
    expect(addresses.size).toBe(1);
    expect(await app.deps.prisma.agentWallet.count({ where: { userId: user.id } })).toBe(1);
  });

  it('stores policyId=null when the Privy policy API is unavailable', async () => {
    wallets.policyId = null;
    const { call } = await signIn();
    const body = (await call('POST', '/onboarding/wallet')).json();
    expect(body.wallet.policyId).toBeNull();
    expect(body.step).toBe('PROFILE');
  });

  it('writes the profile limits from the PHASE_00 table (PROFILE → FUND)', async () => {
    const { call, user } = await signIn();
    await call('POST', '/onboarding/wallet');
    const res = await call('POST', '/onboarding/profile', { riskProfile: 'ADVENTUROUS' });
    expect(res.statusCode).toBe(200);
    const body = OnboardingResponseSchema.parse(res.json());
    expect(body.step).toBe('FUND');
    expect(body.profile).toBe('ADVENTUROUS');
    expect(body.limits).toEqual({
      riskProfile: 'ADVENTUROUS',
      perActionUsd: '50',
      perDayUsd: '200',
      maxSlippagePct: '1',
      minTradeScoreAuto: 60,
      hookPolicy: 'SAFE_AND_CAUTION',
    });
    const limits = await app.deps.prisma.limits.findUniqueOrThrow({ where: { userId: user.id } });
    expect(limits.perDayUsd.toString()).toBe('200');

    // Still onboarding (not funded): the human may pick again without step-up.
    const again = (await call('POST', '/onboarding/profile', { riskProfile: 'CAREFUL' })).json();
    expect(again.limits.perActionUsd).toBe('10');
    expect(again.step).toBe('FUND');
  });

  it('requires step-up for profile changes once onboarding is DONE', async () => {
    const { call, user } = await signIn();
    await call('POST', '/onboarding/wallet');
    await call('POST', '/onboarding/profile', { riskProfile: 'BALANCED' });
    await app.deps.prisma.user.update({ where: { id: user.id }, data: { onboardingStep: 'DONE' } });
    const res = await call('POST', '/onboarding/profile', { riskProfile: 'ADVENTUROUS' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'STEP_UP_REQUIRED',
      details: { reason: 'RISK_PROFILE_CHANGE' },
    });
  });

  it('answers 503 WALLET_PROVIDER_ERROR when Privy is not configured', async () => {
    const bare = await createTestApp({}, { wallets: null, mcp: null });
    try {
      const s = await devSignIn(bare, uniqueName('noprivy'));
      const res = await bare.inject({
        method: 'POST',
        url: '/onboarding/wallet',
        headers: { authorization: `Bearer ${s.token}` },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('WALLET_PROVIDER_ERROR');
    } finally {
      await bare.close();
    }
  });

  it('requires a session', async () => {
    for (const [method, url] of [
      ['GET', '/onboarding'],
      ['POST', '/onboarding/wallet'],
      ['GET', '/portfolio'],
      ['GET', '/settings'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe('settings', () => {
  it('shows profile, limits and wallet; every change needs step-up (409)', async () => {
    const { call } = await signIn('settings');
    await call('POST', '/onboarding/wallet');
    await call('POST', '/onboarding/profile', { riskProfile: 'CAREFUL' });
    const settings = (await call('GET', '/settings')).json();
    expect(settings.riskProfile).toBe('CAREFUL');
    expect(settings.limits.perDayUsd).toBe('40');
    expect(settings.wallet.address).toMatch(/^0x/);

    const cases = [
      ['PUT', '/settings/risk-profile', { riskProfile: 'ADVENTUROUS' }, 'RISK_PROFILE_CHANGE'],
      ['PUT', '/settings/limits', { perDayUsd: '500' }, 'LIMIT_CHANGE'],
      [
        'POST',
        '/wallet/withdraw',
        { to: '0x000000000000000000000000000000000000dEaD', token: 'ETH', amount: '0.01' },
        'WITHDRAWAL',
      ],
    ] as const;
    for (const [method, url, payload, reason] of cases) {
      const res = await call(method, url, payload);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { reason } });
    }
  });
});

describe('GET /portfolio', () => {
  it('returns an empty, well-formed portfolio before the wallet exists', async () => {
    const { call } = await signIn('pf');
    const body = PortfolioResponseSchema.parse((await call('GET', '/portfolio')).json());
    expect(body).toMatchObject({ address: null, totalUsd: '0', tokens: [], lpPositions: [] });
    expect(body.risk.label).toBe('Low');
    expect(body.limits).toMatchObject({
      perActionUsd: '25',
      perDayUsd: '100',
      usedTodayUsd: '0',
      remainingTodayUsd: '100',
    });
    expect(body.priceSource).toBe('Uniswap API · Ethereum mainnet reference');
  });

  it('values balances with mainnet reference prices and computes FIFO P&L', async () => {
    const { call, user } = await signIn('pf');
    const wallet = (await call('POST', '/onboarding/wallet')).json().wallet;
    market.balances.set(
      wallet.address.toLowerCase(),
      sepoliaTokens('50000000000000000', '10000000'),
    );
    await app.deps.prisma.tokenLot.createMany({
      data: [
        {
          userId: user.id,
          tokenAddress: '0x0000000000000000000000000000000000000000',
          amountRaw: '50000000000000000',
          costUsd: '100',
          source: 'DEPOSIT',
        },
        {
          userId: user.id,
          tokenAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
          amountRaw: '10000000',
          costUsd: '10',
          source: 'DEPOSIT',
        },
      ],
    });

    const res = await call('GET', '/portfolio');
    expect(res.statusCode).toBe(200);
    const body = PortfolioResponseSchema.parse(res.json());
    expect(body.address).toBe(wallet.address);
    expect(body.totalUsd).toBe('135'); // 0.05 × 2500 + 10
    expect(body.tokens.map((t) => [t.symbol, t.balance, t.valueUsd])).toEqual([
      ['ETH', '0.05', '125'],
      ['USDC', '10', '10'],
    ]);
    expect(body.pnl).toMatchObject({ totalUsd: '25', costBasisUsd: '110', pct: '22.73' });
    expect(body.tokens[0]!.pnl).toMatchObject({ pnlUsd: '25', pct: '25' });
    // ETH is 2500 vs a 2600 7-day high → 3.85% drawdown shows up in the risk drivers.
    expect(body.risk.drivers.join(' ')).toContain('ETH is 3.8% below its 7-day high');
    expect(body.risk.label).toBe('Moderate');

    // The quotes went to mainnet through MCP get_quote.
    const quote = market.calls.find((c) => c.name === 'get_quote');
    expect(quote?.args).toMatchObject({
      chainId: 1,
      tokenIn: 'ETH',
      tokenOut: 'USDC',
      amount: '1',
    });
  });

  it("doesn't put background reads in the user's live activity", async () => {
    const { call, user } = await signIn('pf');
    await call('POST', '/onboarding/wallet');
    await call('GET', '/portfolio');
    const toolEvents = await app.deps.prisma.traceEventRow.count({
      where: { userId: user.id, kind: { in: ['tool_call', 'tool_result'] } },
    });
    expect(toolEvents).toBe(0);
  });

  it('counts today’s AUTO executions against the daily limit', async () => {
    const { call, user } = await signIn('pf');
    await call('POST', '/onboarding/wallet');
    const req = await app.deps.prisma.agentRequest.create({
      data: { userId: user.id, channel: 'WEB', input: {}, traceId: 't' },
    });
    const plan = await app.deps.prisma.actionPlan.create({
      data: {
        agentRequestId: req.id,
        userId: user.id,
        intent: {},
        planHash: 'h',
        steps: [],
        amountUsd: '30',
        policyOutcome: 'AUTO',
        policyReasons: [],
      },
    });
    await app.deps.prisma.execution.createMany({
      data: [
        {
          actionPlanId: plan.id,
          userId: user.id,
          stepIndex: 0,
          idempotencyKey: `${plan.id}:0`,
          kind: 'SWAP',
          status: 'CONFIRMED',
          usdValue: '30',
          approvedBy: 'AGENT',
        },
        {
          actionPlanId: plan.id,
          userId: user.id,
          stepIndex: 1,
          idempotencyKey: `${plan.id}:1`,
          kind: 'SWAP',
          status: 'CONFIRMED',
          usdValue: '500',
          approvedBy: 'HUMAN',
        },
        {
          actionPlanId: plan.id,
          userId: user.id,
          stepIndex: 2,
          idempotencyKey: `${plan.id}:2`,
          kind: 'SWAP',
          status: 'FAILED',
          usdValue: '20',
          approvedBy: 'AGENT',
        },
      ],
    });
    const body = PortfolioResponseSchema.parse((await call('GET', '/portfolio')).json());
    expect(body.limits).toMatchObject({
      usedTodayUsd: '30',
      remainingTodayUsd: '70',
      timezone: 'Asia/Kolkata',
    });
  });

  it('answers 503 MARKET_DATA_UNAVAILABLE when balances cannot be read', async () => {
    const { call } = await signIn('pf');
    await call('POST', '/onboarding/wallet');
    market.failPortfolio = true;
    const res = await call('GET', '/portfolio');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('MARKET_DATA_UNAVAILABLE');
  });

  it('still answers when price history is down (drawdown left out, with a warning)', async () => {
    const { call } = await signIn('pf');
    const wallet = (await call('POST', '/onboarding/wallet')).json().wallet;
    market.balances.set(wallet.address.toLowerCase(), sepoliaTokens('10000000000000000'));
    market.highs = {};
    await app.deps.prisma.priceCache.deleteMany({ where: { key: { startsWith: 'ref-high7d' } } });
    const body = PortfolioResponseSchema.parse((await call('GET', '/portfolio')).json());
    expect(body.totalUsd).toBe('25');
    expect(body.risk.factors.find((f) => f.factor === 'drawdown')!.available).toBe(false);
    expect(body.warnings.join(' ')).toContain('7-day price history is unavailable');
  });
});
