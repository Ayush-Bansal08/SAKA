import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  activityKey,
  balanceKeys,
  checkUser,
  runBalanceWatch,
  type BalanceWatcherDeps,
} from '../src/jobs/balance-watcher.js';
import { BalanceReader, PriceService } from '../src/modules/portfolio/market.js';
import { onboardingView } from '../src/modules/users/onboarding.js';
import { onboardingDeps } from '../src/modules/users/onboarding-routes.js';
import {
  createFakeMarket,
  FakeWalletProvider,
  fakeMcpClient,
  sepoliaTokens,
  silentLog,
} from './fakes.js';
import { createTestApp, devSignIn, uniqueName } from './helpers.js';

let app: FastifyInstance;
let deps: BalanceWatcherDeps;
const market = createFakeMarket();
const wallets = new FakeWalletProvider();
let clock = Date.now();

beforeAll(async () => {
  const mcp = fakeMcpClient(market);
  app = await createTestApp({}, { wallets, mcp });
  await app.deps.prisma.priceCache.deleteMany({ where: { key: { startsWith: 'ref-' } } });
  deps = {
    prisma: app.deps.prisma,
    redis: app.deps.redis,
    balances: new BalanceReader(mcp, app.deps.redis),
    prices: new PriceService(app.deps.prisma, mcp, silentLog),
    trace: app.deps.traceBus,
    chainId: 11155111,
    allowlist: [],
    inactivePollMs: 300_000,
    log: silentLog,
    now: () => clock,
  };
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  clock = Date.now();
});

const ETH_005 = '50000000000000000';

/** A signed-in, active user at the FUND step with a fresh agent wallet. */
async function fundingUser() {
  const s = await devSignIn(app, uniqueName('watch'));
  const headers = { authorization: `Bearer ${s.token}` };
  const wallet = (await app.inject({ method: 'POST', url: '/onboarding/wallet', headers })).json()
    .wallet;
  await app.inject({
    method: 'POST',
    url: '/onboarding/profile',
    headers,
    payload: { riskProfile: 'BALANCED' },
  });
  await app.deps.redis.set(activityKey(s.user.id), '1', 'EX', 60);
  return { userId: s.user.id, address: wallet.address as string };
}

const step = async (userId: string) =>
  (await app.deps.prisma.user.findUniqueOrThrow({ where: { id: userId } })).onboardingStep;
const lots = (userId: string) =>
  app.deps.prisma.tokenLot.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });

describe('balance watcher', () => {
  it('detects the first native deposit: TokenLot at reference price, trace, FUND → DONE', async () => {
    const { userId, address } = await fundingUser();
    market.balances.set(address.toLowerCase(), sepoliaTokens('0'));
    expect((await checkUser(deps, userId, address)).status).toBe('unchanged');
    expect(await step(userId)).toBe('FUND');

    market.balances.set(address.toLowerCase(), sepoliaTokens(ETH_005));
    const result = await checkUser(deps, userId, address);
    expect(result).toMatchObject({ status: 'deposit', funded: true });

    const [lot] = await lots(userId);
    expect(lot).toMatchObject({ amountRaw: ETH_005, source: 'DEPOSIT' });
    expect(lot!.tokenAddress).toBe('0x0000000000000000000000000000000000000000');
    expect(lot!.costUsd.toString()).toBe('125'); // 0.05 × $2500 mainnet reference
    expect(await step(userId)).toBe('DONE');

    const event = await app.deps.prisma.traceEventRow.findFirst({
      where: { userId, kind: 'receipt' },
    });
    expect(event?.title).toBe('Funded: 0.05 ETH (~$125.00)');

    // The onboarding view now reports the deposit.
    const view = await onboardingView(onboardingDeps(app), userId);
    expect(view.step).toBe('DONE');
    expect(view.funding.firstDeposit).toMatchObject({
      symbol: 'ETH',
      amount: '0.05',
      valueUsd: '125',
    });
  });

  it('treats an already-funded brand-new wallet as a deposit on the first observation', async () => {
    const { userId, address } = await fundingUser();
    market.balances.set(address.toLowerCase(), sepoliaTokens(ETH_005));
    const result = await checkUser(deps, userId, address);
    expect(result).toMatchObject({ status: 'deposit', funded: true });
  });

  it('never counts the same deposit twice', async () => {
    const { userId, address } = await fundingUser();
    market.balances.set(address.toLowerCase(), sepoliaTokens(ETH_005));
    await checkUser(deps, userId, address);
    expect((await checkUser(deps, userId, address)).status).toBe('unchanged');
    expect(await lots(userId)).toHaveLength(1);
  });

  it('records a second, separate deposit as a new lot without re-announcing funding', async () => {
    const { userId, address } = await fundingUser();
    market.balances.set(address.toLowerCase(), sepoliaTokens(ETH_005));
    await checkUser(deps, userId, address);
    market.balances.set(address.toLowerCase(), sepoliaTokens(ETH_005, '20000000'));
    const result = await checkUser(deps, userId, address);
    expect(result).toMatchObject({ status: 'deposit', funded: false });
    expect(result.deposits.map((d) => [d.symbol, d.amount])).toEqual([['USDC', '20']]);
    const all = await lots(userId);
    expect(all.map((l) => l.costUsd.toString())).toEqual(['125', '20']);
    const titles = (
      await app.deps.prisma.traceEventRow.findMany({
        where: { userId, kind: 'receipt' },
        orderBy: { ts: 'asc' },
      })
    ).map((e) => e.title);
    expect(titles).toEqual(['Funded: 0.05 ETH (~$125.00)', 'Deposit received: 20 USDC (~$20.00)']);
  });

  it('a USDC-only deposit does not finish onboarding (the agent still needs ETH for gas)', async () => {
    const { userId, address } = await fundingUser();
    market.balances.set(address.toLowerCase(), sepoliaTokens('0', '5000000'));
    const result = await checkUser(deps, userId, address);
    expect(result).toMatchObject({ status: 'deposit', funded: false });
    expect(await step(userId)).toBe('FUND');
  });

  it('ignores increases explained by our own execution in the last 2 minutes', async () => {
    const { userId, address } = await fundingUser();
    market.balances.set(address.toLowerCase(), sepoliaTokens(ETH_005));
    await checkUser(deps, userId, address);

    const req = await app.deps.prisma.agentRequest.create({
      data: { userId, channel: 'WEB', input: {}, traceId: 't' },
    });
    const plan = await app.deps.prisma.actionPlan.create({
      data: {
        agentRequestId: req.id,
        userId,
        intent: {},
        planHash: 'h',
        steps: [],
        amountUsd: '10',
        policyOutcome: 'AUTO',
        policyReasons: [],
      },
    });
    await app.deps.prisma.execution.create({
      data: {
        actionPlanId: plan.id,
        userId,
        stepIndex: 0,
        idempotencyKey: `${plan.id}:0`,
        kind: 'SWAP',
        status: 'CONFIRMED',
        usdValue: '10',
        approvedBy: 'AGENT',
      },
    });
    // The swap turned some ETH into USDC.
    market.balances.set(address.toLowerCase(), sepoliaTokens('46000000000000000', '10000000'));
    expect((await checkUser(deps, userId, address)).status).toBe('explained');
    expect(await lots(userId)).toHaveLength(1);

    // And once the snapshot moved on, the same balance is not a deposit later either.
    clock += 5 * 60_000;
    expect((await checkUser(deps, userId, address)).status).toBe('unchanged');
  });

  it('re-baselines (no phantom deposit) when the snapshot is lost for a wallet with history', async () => {
    const { userId, address } = await fundingUser();
    market.balances.set(address.toLowerCase(), sepoliaTokens(ETH_005));
    await checkUser(deps, userId, address);
    await app.deps.redis.del(balanceKeys.snapshot(userId));
    expect((await checkUser(deps, userId, address)).status).toBe('baseline');
    expect(await lots(userId)).toHaveLength(1);
  });

  it('backs off for users inactive for more than 24 h (every 5 min)', async () => {
    const { userId, address } = await fundingUser();
    await app.deps.redis.del(activityKey(userId));
    market.balances.set(address.toLowerCase(), sepoliaTokens('0'));
    expect((await checkUser(deps, userId, address)).status).toBe('unchanged');
    clock += 15_000;
    expect((await checkUser(deps, userId, address)).status).toBe('skipped-inactive');
    clock += 300_000;
    expect((await checkUser(deps, userId, address)).status).toBe('unchanged');
  });

  it('skips a user another worker is already checking', async () => {
    const { userId, address } = await fundingUser();
    await app.deps.redis.set(balanceKeys.lock(userId), '1', 'EX', 30);
    expect((await checkUser(deps, userId, address)).status).toBe('locked');
    await app.deps.redis.del(balanceKeys.lock(userId));
  });

  it('runs a whole pass and isolates per-user failures', async () => {
    const { userId, address } = await fundingUser();
    market.balances.set(address.toLowerCase(), sepoliaTokens(ETH_005));
    const tick = await runBalanceWatch(deps);
    expect(tick.results.find((r) => r.userId === userId)?.status).toBe('deposit');

    market.failPortfolio = true;
    try {
      const failing = await runBalanceWatch(deps);
      expect(failing.results.find((r) => r.userId === userId)?.status).toBe('error');
    } finally {
      market.failPortfolio = false;
    }
  });
});
