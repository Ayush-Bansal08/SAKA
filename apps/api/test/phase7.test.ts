/**
 * PHASE 07: triggers (schedule maths, templates, evaluator: TP via price override, idempotency,
 * DCA reschedule, chained sequencing + stop on refusal, create/cancel from chat, admin override),
 * hook indexer (upsert, rescore after 1 h, explanation cached by score, change history, new-hook
 * detector events), hooks API, and LP positions in the portfolio.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Decimal, type UniswapMcp } from '@warden/shared';
import { getAddress } from 'viem';
import { nextLocalRun } from '../src/lib/time.js';
import { pipelineDepsFrom } from '../src/modules/agent/plan-routes.js';
import { indexHooks, snapshotChanges, type HookIndexDeps } from '../src/modules/hooks/indexer.js';
import {
  evaluateTriggers,
  templateToIntent,
  TriggerActionError,
  type TriggerDeps,
} from '../src/modules/triggers/evaluator.js';
import { setPriceOverride } from '../src/modules/triggers/service.js';
import { createTestApp, devSignIn, uniqueName } from './helpers.js';
import {
  createMarket,
  FakeChain,
  FakeWallets,
  fixedPrices,
  giveWallet,
  RecordingJobs,
  scriptedMcp,
  ZG_ENV,
  zgRouter,
  type Market,
  type ZgScript,
} from './phase5-fakes.js';

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// Schedules and templates (pure)
// ---------------------------------------------------------------------------

describe('nextLocalRun (DCA schedules in the user time zone)', () => {
  it('daily: later today, else tomorrow (Asia/Kolkata, +05:30)', () => {
    const before = new Date('2026-11-06T02:00:00Z'); // 07:30 IST
    expect(nextLocalRun(before, 'Asia/Kolkata', '09:00', 'day').toISOString()).toBe(
      '2026-11-06T03:30:00.000Z',
    );
    const after = new Date('2026-11-06T04:00:00Z'); // 09:30 IST
    expect(nextLocalRun(after, 'Asia/Kolkata', '09:00', 'day').toISOString()).toBe(
      '2026-11-07T03:30:00.000Z',
    );
  });

  it('crosses a DST change (America/New_York, 1 Nov 2026)', () => {
    const now = new Date('2026-10-31T14:00:00Z'); // 10:00 EDT, after today's 09:00
    expect(nextLocalRun(now, 'America/New_York', '09:00', 'day').toISOString()).toBe(
      '2026-11-01T14:00:00.000Z', // 09:00 EST
    );
  });

  it('weekly on a given day; invalid zones fall back to UTC', () => {
    const fri = new Date('2026-11-06T12:00:00Z');
    expect(nextLocalRun(fri, 'UTC', '08:30', 'week', 'mon').toISOString()).toBe(
      '2026-11-09T08:30:00.000Z',
    );
    expect(nextLocalRun(fri, 'Not/AZone', '13:00', 'day').toISOString()).toBe(
      '2026-11-06T13:00:00.000Z',
    );
  });
});

const action = (over: Partial<UniswapMcp.TriggerSpec['actions'][number]>) =>
  ({
    type: 'swap_exact_in',
    tokenIn: 'ETH',
    tokenOut: 'USDC',
    token: null,
    token0: null,
    token1: null,
    recipient: null,
    amount: { kind: 'percent', value: '50' },
    rangePreset: null,
    maxSlippagePct: null,
    ...over,
  }) as UniswapMcp.TriggerSpec['actions'][number];

describe('action templates → intents', () => {
  const ctx = {
    holdings: new Map([['ETH', new Decimal('0.8')]]),
    price: async (s: string) => (s === 'ETH' ? new Decimal(2500) : new Decimal(1)),
    previousUsd: null,
    summary: 'Sell half if ETH goes up 2%',
  };

  it('"50%" resolves against holdings, "$20" against the reference price', async () => {
    expect(await templateToIntent(action({}), ctx)).toMatchObject({
      type: 'swap_exact_in',
      amountIn: '0.4',
      amountUsd: '1000',
      reason: 'Your rule: Sell half if ETH goes up 2%',
    });
    expect(
      await templateToIntent(action({ amount: { kind: 'usd', value: '20' } }), ctx),
    ).toMatchObject({ amountIn: '0.008', amountUsd: '20' });
  });

  it('lp_open uses the previous step proceeds; missing holdings fail clearly', async () => {
    const lp = action({
      type: 'lp_open',
      tokenIn: null,
      tokenOut: null,
      token0: 'ETH',
      token1: 'USDC',
      amount: { kind: 'percent', value: '100' },
      rangePreset: 'medium',
    });
    expect(await templateToIntent(lp, { ...ctx, previousUsd: new Decimal('512.4') })).toMatchObject(
      { type: 'lp_open', amountUsd: '512.4', rangePreset: 'balanced' },
    );
    await expect(templateToIntent(lp, ctx)).rejects.toBeInstanceOf(TriggerActionError);
    await expect(
      templateToIntent(action({ tokenIn: 'USDC', tokenOut: 'ETH' }), ctx),
    ).rejects.toThrow('You hold no USDC to swap.');
  });
});

// ---------------------------------------------------------------------------
// Evaluator (Postgres + Redis, external services mocked)
// ---------------------------------------------------------------------------

interface Harness {
  app: FastifyInstance;
  market: Market;
  jobs: RecordingJobs;
  script: ZgScript;
  userId: string;
  token: string;
  deps: TriggerDeps;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const market = createMarket();
  const jobs = new RecordingJobs();
  const script: ZgScript = { proposals: [], guard: 'approve', decisions: 0 };
  vi.stubGlobal('fetch', vi.fn(zgRouter(script)));
  const app = await createTestApp(
    { ...ZG_ENV, AUTO_EXECUTE_DELAY_MS: '0' },
    { mcp: scriptedMcp(market), jobs, chain: new FakeChain(), wallets: new FakeWallets() },
  );
  const login = await devSignIn(app, uniqueName('phase7'));
  await giveWallet(app.deps.prisma, login.user.id);
  await app.deps.prisma.user.update({
    where: { id: login.user.id },
    data: { timezone: 'Asia/Kolkata' },
  });
  const d = app.deps;
  const deps: TriggerDeps = {
    prisma: d.prisma,
    redis: d.redis,
    prices: fixedPrices(market),
    balances: {
      read: async () =>
        ({
          tokens: [
            { symbol: 'ETH', balance: '1' },
            { symbol: 'USDC', balance: '100' },
          ],
          asOf: new Date().toISOString(),
        }) as never,
    },
    pipeline: pipelineDepsFrom(d),
    traceBus: d.traceBus,
    chainId: 11155111,
  };
  return {
    app,
    market,
    jobs,
    script,
    userId: login.user.id,
    token: login.token,
    deps,
    close: () => app.close(),
  };
}

const spec = (
  kind: UniswapMcp.TriggerSpec['kind'],
  condition: Partial<UniswapMcp.TriggerSpec['condition']>,
  actions: UniswapMcp.TriggerSpec['actions'],
): UniswapMcp.TriggerSpec => ({
  kind,
  condition: {
    type: 'price_above',
    symbol: 'ETH',
    targetPriceUsd: null,
    referencePriceUsd: null,
    changePct: null,
    every: null,
    atLocalTime: null,
    dayOfWeek: null,
    ...condition,
  },
  actions,
});

async function addTrigger(
  h: Harness,
  s: UniswapMcp.TriggerSpec,
  extra: Record<string, unknown> = {},
) {
  return h.app.deps.prisma.trigger.create({
    data: {
      userId: h.userId,
      kind: s.kind,
      spec: s as never,
      summary: `${s.kind} test rule`,
      status: 'ACTIVE',
      ...extra,
    },
  });
}

/** Evaluate only this harness's user (the shared test DB may hold other users' rules). */
async function evaluate(h: Harness) {
  const others = await h.app.deps.prisma.trigger.findMany({
    where: { status: 'ACTIVE', userId: { not: h.userId } },
    select: { id: true },
  });
  if (others.length)
    await h.app.deps.prisma.trigger.updateMany({
      where: { id: { in: others.map((o) => o.id) } },
      data: { status: 'CANCELLED' },
    });
  return evaluateTriggers(h.deps);
}

const triggerRequests = (h: Harness) =>
  h.app.deps.prisma.agentRequest.findMany({
    where: { userId: h.userId, channel: 'TRIGGER' },
    include: { actionPlans: true },
    orderBy: { createdAt: 'asc' },
  });

describe('trigger evaluator', () => {
  it('take-profit fires once the (overridden) reference price crosses, exactly once', async () => {
    const h = await harness();
    try {
      const t = await addTrigger(
        h,
        spec('TAKE_PROFIT', { type: 'price_above', targetPriceUsd: '2550' }, [
          action({ amount: { kind: 'usd', value: '10' } }),
        ]),
      );
      expect((await evaluate(h)).fired).toBe(0); // 2500 < 2550
      await setPriceOverride(
        h.app.deps.redis,
        { symbol: 'ETH', priceUsd: '2600', ttlSec: 60 },
        new Date(),
      );
      try {
        const r = await evaluate(h);
        expect(r.fired).toBe(1);
        const after = await h.app.deps.prisma.trigger.findUniqueOrThrow({ where: { id: t.id } });
        expect(after).toMatchObject({ status: 'FIRED', fireCount: 1, lastResult: 'Executing' });
        const reqs = await triggerRequests(h);
        expect(reqs).toHaveLength(1);
        expect(reqs[0]!.actionPlans[0]).toMatchObject({ policyOutcome: 'AUTO' });
        // The override decides WHEN, never HOW MUCH: $10 is converted at the live 2500, not 2600.
        expect(reqs[0]!.actionPlans[0]!.intent).toMatchObject({
          amountIn: '0.004',
          amountUsd: '10',
        });
        expect(h.jobs.executions).toHaveLength(1);
        const msg = await h.app.deps.prisma.chatMessage.findFirstOrThrow({
          where: { requestId: reqs[0]!.id, role: 'AGENT' },
        });
        expect(msg.text).toContain('fired');
        expect((await evaluate(h)).fired).toBe(0);
        expect(await triggerRequests(h)).toHaveLength(1);
        // The rules list shows how the fired plan actually ended.
        await h.app.deps.prisma.actionPlan.update({
          where: { id: reqs[0]!.actionPlans[0]!.id },
          data: { status: 'EXECUTED' },
        });
        const list = await h.app.inject({
          method: 'GET',
          url: '/triggers',
          headers: { authorization: `Bearer ${h.token}` },
        });
        expect(list.json()).toMatchObject({ triggers: [{ id: t.id, lastResult: 'Executed ✓' }] });
      } finally {
        await h.app.deps.redis.del('price-override:ETH');
      }
    } finally {
      await h.close();
    }
  });

  it('two evaluators at once fire a due rule only once (idempotency)', async () => {
    const h = await harness();
    try {
      await addTrigger(
        h,
        spec('DCA', { type: 'schedule', symbol: null, every: 'day', atLocalTime: '09:00' }, [
          action({ amount: { kind: 'usd', value: '10' } }),
        ]),
        { nextRunAt: new Date(Date.now() - 60_000) },
      );
      await evaluate(h); // cancels other users' active rules first
      const [a, b] = await Promise.all([evaluateTriggers(h.deps), evaluateTriggers(h.deps)]);
      expect(a.fired + b.fired).toBe(0); // already fired by the first call
      expect(await triggerRequests(h)).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('DCA reschedules to the next local run and stays active', async () => {
    const h = await harness();
    try {
      const t = await addTrigger(
        h,
        spec('DCA', { type: 'schedule', symbol: null, every: 'day', atLocalTime: '09:00' }, [
          action({ tokenIn: 'USDC', tokenOut: 'ETH', amount: { kind: 'usd', value: '10' } }),
        ]),
        { nextRunAt: new Date(Date.now() - 1000) },
      );
      await evaluate(h);
      const after = await h.app.deps.prisma.trigger.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.status).toBe('ACTIVE');
      expect(after.fireCount).toBe(1);
      expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
      // 09:00 in Kolkata is 03:30 UTC.
      expect(after.nextRunAt!.toISOString()).toMatch(/T03:30:00\.000Z$/);
    } finally {
      await h.close();
    }
  });

  it('chained: step 2 waits for step 1 to execute, then runs with its proceeds', async () => {
    const h = await harness();
    try {
      const t = await addTrigger(
        h,
        spec('CHAINED', { type: 'price_above', targetPriceUsd: '2000' }, [
          action({ amount: { kind: 'usd', value: '10' } }),
          action({
            type: 'lp_open',
            tokenIn: null,
            tokenOut: null,
            token0: 'ETH',
            token1: 'USDC',
            amount: { kind: 'percent', value: '100' },
            rangePreset: 'medium',
          }),
        ]),
      );
      await evaluate(h);
      let row = await h.app.deps.prisma.trigger.findUniqueOrThrow({ where: { id: t.id } });
      const state = row.state as { step: number; waitingPlanId: string };
      expect(row.status).toBe('ACTIVE');
      expect(state.step).toBe(0);
      expect(state.waitingPlanId).toBeTruthy();

      await evaluate(h); // step 1 not executed yet → nothing new
      expect(await triggerRequests(h)).toHaveLength(1);

      await h.app.deps.prisma.actionPlan.update({
        where: { id: state.waitingPlanId },
        data: { status: 'EXECUTED' },
      });
      expect((await evaluate(h)).advanced).toBe(1);
      const reqs = await triggerRequests(h);
      expect(reqs).toHaveLength(2);
      expect(reqs[1]!.actionPlans[0]!.intent).toMatchObject({ type: 'lp_open', amountUsd: '10' });
      row = await h.app.deps.prisma.trigger.findUniqueOrThrow({ where: { id: t.id } });
      expect((row.state as { step: number }).step).toBe(1);

      await h.app.deps.prisma.actionPlan.update({
        where: { id: (row.state as { waitingPlanId: string }).waitingPlanId },
        data: { status: 'EXECUTED' },
      });
      await evaluate(h);
      row = await h.app.deps.prisma.trigger.findUniqueOrThrow({ where: { id: t.id } });
      expect(row).toMatchObject({ status: 'FIRED', lastResult: 'All 2 steps done' });
    } finally {
      await h.close();
    }
  });

  it('chained: a refused step stops the chain and tells the human', async () => {
    const h = await harness();
    try {
      h.script.guard = 'block';
      const t = await addTrigger(
        h,
        spec('CHAINED', { type: 'price_above', targetPriceUsd: '2000' }, [
          action({ amount: { kind: 'usd', value: '10' } }),
          action({ tokenIn: 'USDC', tokenOut: 'ETH', amount: { kind: 'usd', value: '5' } }),
        ]),
      );
      const r = await evaluate(h);
      expect(r.stopped).toBe(1);
      const row = await h.app.deps.prisma.trigger.findUniqueOrThrow({ where: { id: t.id } });
      expect(row.status).toBe('FAILED');
      expect(row.lastResult).toMatch(/^Stopped at step 1 of 2/);
      expect(await triggerRequests(h)).toHaveLength(1); // step 2 never ran
      expect(
        await h.app.deps.prisma.chatMessage.count({
          where: { userId: h.userId, text: { contains: 'Nothing else in the chain will run' } },
        }),
      ).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('a rejected approval mid-chain stops it', async () => {
    const h = await harness();
    try {
      const t = await addTrigger(
        h,
        spec('CHAINED', { type: 'price_above', targetPriceUsd: '2000' }, [
          action({ amount: { kind: 'usd', value: '60' } }), // over the $25 limit → approval
          action({ tokenIn: 'USDC', tokenOut: 'ETH', amount: { kind: 'usd', value: '5' } }),
        ]),
      );
      await evaluate(h);
      const state = (await h.app.deps.prisma.trigger.findUniqueOrThrow({ where: { id: t.id } }))
        .state as { waitingPlanId: string };
      const approval = await h.app.deps.prisma.approval.findFirstOrThrow({
        where: { actionPlanId: state.waitingPlanId },
      });
      const deny = await h.app.inject({
        method: 'POST',
        url: `/approvals/${approval.id}/deny`,
        headers: { authorization: `Bearer ${h.token}` },
      });
      expect(deny.statusCode).toBe(200);
      await evaluate(h);
      const row = await h.app.deps.prisma.trigger.findUniqueOrThrow({ where: { id: t.id } });
      expect(row.status).toBe('FAILED');
      expect(row.lastResult).toContain('was rejected by you');
    } finally {
      await h.close();
    }
  });
});

describe('rules from chat, cancel, admin price override', () => {
  it('"Stop loss at $2,800" stores an ACTIVE rule with a cancellable card', async () => {
    const h = await harness();
    try {
      h.script.proposals = [
        {
          type: 'create_trigger',
          rule: {
            kind: 'STOP_LOSS',
            condition: { type: 'price_below', token: { symbol: 'ETH' }, priceUsd: '2800' },
            step: {
              type: 'sell_percent',
              token: { symbol: 'ETH' },
              percent: 100,
              receiveToken: { symbol: 'USDC' },
            },
          },
          reason: 'User asked for a stop loss',
        },
      ];
      const res = await h.app.inject({
        method: 'POST',
        url: '/agent/messages',
        headers: { authorization: `Bearer ${h.token}` },
        payload: { text: 'Stop loss at $2,800' },
      });
      const { agentRequestId } = res.json() as { agentRequestId: string };
      await vi.waitFor(
        async () => {
          const m = await h.app.deps.prisma.chatMessage.findFirst({
            where: { requestId: agentRequestId, role: 'AGENT' },
          });
          expect(m).not.toBeNull();
        },
        { timeout: 15_000 },
      );
      const msg = await h.app.deps.prisma.chatMessage.findFirstOrThrow({
        where: { requestId: agentRequestId, role: 'AGENT' },
      });
      const card = (
        msg.cards as { type: string; data?: { kind: string; triggerId: string } }[]
      ).find((c) => c.data?.kind === 'trigger')!;
      const rule = await h.app.deps.prisma.trigger.findUniqueOrThrow({
        where: { id: card.data!.triggerId },
      });
      expect(rule).toMatchObject({ status: 'ACTIVE', kind: 'STOP_LOSS', userId: h.userId });
      expect(rule.summary).toContain('2,800');

      const list = await h.app.inject({
        method: 'GET',
        url: '/triggers',
        headers: { authorization: `Bearer ${h.token}` },
      });
      expect(list.json()).toMatchObject({
        triggers: [{ id: rule.id, status: 'ACTIVE', targetPriceUsd: '2800', direction: 'below' }],
      });

      const other = await devSignIn(h.app, uniqueName('stranger'));
      const steal = await h.app.inject({
        method: 'POST',
        url: `/triggers/${rule.id}/cancel`,
        headers: { authorization: `Bearer ${other.token}` },
      });
      expect(steal.statusCode).toBe(404);
      const cancel = await h.app.inject({
        method: 'POST',
        url: `/triggers/${rule.id}/cancel`,
        headers: { authorization: `Bearer ${h.token}` },
      });
      expect(cancel.json()).toMatchObject({ status: 'CANCELLED' });
      const again = await h.app.inject({
        method: 'POST',
        url: `/triggers/${rule.id}/cancel`,
        headers: { authorization: `Bearer ${h.token}` },
      });
      expect(again.statusCode).toBe(409);
    } finally {
      await h.close();
    }
  });

  it('the price override needs the admin token and shows up for the header chip', async () => {
    const h = await harness();
    try {
      const body = { symbol: 'eth', priceUsd: '3100', ttlSec: 30 };
      const denied = await h.app.inject({
        method: 'POST',
        url: '/admin/price-override',
        headers: { 'x-admin-token': 'wrong' },
        payload: body,
      });
      expect(denied.statusCode).toBe(401);
      const ok = await h.app.inject({
        method: 'POST',
        url: '/admin/price-override',
        headers: { 'x-admin-token': h.app.deps.env.ADMIN_TOKEN },
        payload: body,
      });
      expect(ok.json()).toMatchObject({ symbol: 'ETH', priceUsd: '3100' });
      const chip = await h.app.inject({
        method: 'GET',
        url: '/price-overrides',
        headers: { authorization: `Bearer ${h.token}` },
      });
      expect(chip.json()).toMatchObject({ overrides: [{ symbol: 'ETH', priceUsd: '3100' }] });
      await h.app.inject({
        method: 'DELETE',
        url: '/admin/price-override/ETH',
        headers: { 'x-admin-token': h.app.deps.env.ADMIN_TOKEN },
      });
      const gone = await h.app.inject({
        method: 'GET',
        url: '/price-overrides',
        headers: { authorization: `Bearer ${h.token}` },
      });
      expect(gone.json()).toEqual({ overrides: [] });
    } finally {
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Hook indexer + hooks API
// ---------------------------------------------------------------------------

const addr = () => getAddress(`0x${randomBytes(20).toString('hex')}`);

function hookFakes(hooks: string[], chainId = 1) {
  const scores = new Map(hooks.map((h) => [h, 85]));
  const owners = new Map(hooks.map((h) => [h, getAddress(`0x${'11'.repeat(20)}`)]));
  const calls: string[] = [];
  const pool = (h: string) => ({
    poolId: `0x${h.slice(2).padEnd(64, '0')}`,
    token0: '0x0000000000000000000000000000000000000000',
    token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    token0Symbol: 'ETH',
    token1Symbol: 'USDC',
    fee: 3000,
    tickSpacing: 60,
    isDynamicFee: false,
    tvlUsd: '125000',
    createdAt: new Date().toISOString(),
    createdAtBlock: '100',
  });
  const mcp = {
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push(name);
      const h = getAddress(String(args.hookAddress ?? hooks[0]));
      if (name === 'list_new_hooks')
        return {
          scope: args.scope,
          chainId,
          sinceDays: 30,
          hooks: hooks.map((x) => ({
            hookAddress: x,
            chainId,
            pools: [pool(x)],
            firstSeen: new Date().toISOString(),
            totalTvlUsd: '125000',
          })),
          scannedFromBlock: null,
          scannedToBlock: null,
          asOf: null,
          truncated: false,
          source: 'test',
          warnings: [],
        };
      if (name === 'score_hook') {
        const score = scores.get(h)!;
        return {
          chainId,
          hookAddress: h,
          score,
          band: score >= 80 ? 'SAFE' : score >= 50 ? 'CAUTION' : 'DANGER',
          permissions: {},
          enabledPermissions: [{ flag: 'beforeSwap', bit: 7, risk: 'MEDIUM' }],
          facts: {
            hasCode: true,
            codeSizeBytes: 100,
            codeHash: `0x${'ab'.repeat(32)}`,
            proxy: {
              kind: null,
              implementation: null,
              admin: null,
              beacon: null,
              upgradeable: false,
            },
            owner: owners.get(h)!,
            adminSelectors: [],
            verifiedSource: true,
            contractName: 'TestHook',
            firstSeenBlock: '100',
            firstSeenAt: null,
            ageDays: 12,
            ageSource: 'test',
            poolCount: 1,
            dynamicFeePoolCount: 0,
            tvlUsd: '125000',
          },
          breakdown:
            score < 85
              ? [
                  {
                    rule: 'owner',
                    penalty: -20,
                    evidence: 'Owner can change fees',
                    source: 'framework §3',
                  },
                ]
              : [],
          framework: {
            featureTriggers: [],
            riskScore: {
              permissions: 3,
              upgradeMechanism: 0,
              observableTotal: 3,
              maxTotal: 33,
              tierAtLeast: 'Low',
              unobserved: [],
            },
          },
          scoredAt: new Date().toISOString(),
        };
      }
      if (name === 'get_hook_state')
        return {
          chainId,
          hookAddress: h,
          hasCode: true,
          codeHash: `0x${'ab'.repeat(32)}`,
          implementation: null,
          implementationCodeHash: null,
          owner: owners.get(h)!,
          permissionsBitmap: 128,
          pools: [],
          poolDiscovery: 'input',
          blockNumber: '1',
          takenAt: new Date().toISOString(),
        };
      throw new Error(`unexpected ${name}`);
    },
  };
  return { mcp, scores, owners, calls };
}

function memRedis() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => {
      m.set(k, v);
      return 'OK' as const;
    },
  };
}

describe('hook indexer', () => {
  it('indexes, caches by age and score, records changes and announces new hooks', async () => {
    const app = await createTestApp();
    try {
      const login = await devSignIn(app, uniqueName('hooks'));
      await app.deps.prisma.user.update({
        where: { id: login.user.id },
        data: { onboardingStep: 'DONE' },
      });
      const [a, b] = [addr(), addr()];
      const fake = hookFakes([a, b]);
      let explains = 0;
      let clock = new Date();
      const emitted: { userId: string; title: string }[] = [];
      const deps: HookIndexDeps = {
        prisma: app.deps.prisma,
        redis: memRedis() as never,
        mcp: fake.mcp as never,
        explain: async (s) => {
          explains += 1;
          return { text: `Hook ${s.hookAddress} explained (${s.score})`, inferenceId: null };
        },
        traceBus: {
          emit: async (e) => {
            emitted.push(e as never);
            return e as never;
          },
        },
        executionChainId: 11155111,
        now: () => clock,
      };

      const first = await indexHooks(deps, 'market');
      expect(first).toMatchObject({ seen: 2, newHooks: 2, scored: 2, explained: 2, snapshots: 2 });
      expect(emitted).toHaveLength(0); // first import announces nothing
      const rowA = await app.deps.prisma.hook.findUniqueOrThrow({
        where: { chainId_address: { chainId: 1, address: a } },
        include: { snapshots: true },
      });
      expect(rowA).toMatchObject({
        score: 85,
        band: 'SAFE',
        poolCount: 1,
        contractName: 'TestHook',
      });
      expect(rowA.tvlUsd?.toString()).toBe('125000');
      expect(rowA.snapshots).toHaveLength(1);
      // Template fallback (no inference id) is shown but retried later.
      expect(rowA.explanation).toContain('explained');
      expect(rowA.explanationScore).toBeNull();

      const second = await indexHooks(deps, 'market');
      expect(second.scored).toBe(0); // fresh (< 1 h)

      // An hour later: A's owner changed and its score dropped; B is unchanged.
      clock = new Date(clock.getTime() + 61 * 60_000);
      fake.scores.set(a, 60);
      fake.owners.set(a, getAddress(`0x${'22'.repeat(20)}`));
      const third = await indexHooks(deps, 'market');
      expect(third.scored).toBe(2);
      const snaps = await app.deps.prisma.hookSnapshot.findMany({
        where: { hook: { address: a } },
        orderBy: { takenAt: 'asc' },
      });
      expect(snaps).toHaveLength(2);
      expect(snaps[1]!.changes).toEqual(
        expect.arrayContaining([
          'Score 85 → 60',
          'Band SAFE → CAUTION',
          expect.stringMatching(/^Owner changed/),
        ]),
      );
      expect(await app.deps.prisma.hookSnapshot.count({ where: { hook: { address: b } } })).toBe(1); // nothing changed for B

      // A brand-new hook after the first import is announced to onboarded users.
      const c = addr();
      const later = hookFakes([c]);
      const fourth = await indexHooks({ ...deps, mcp: later.mcp as never }, 'market');
      expect(fourth.newHooks).toBe(1);
      expect(
        emitted.some((e) => e.userId === login.user.id && e.title.startsWith('New hook')),
      ).toBe(true);
      expect(explains).toBeGreaterThanOrEqual(5);

      // Hooks API: list (search by address), detail with history, what-if on mainnet = market only.
      const auth = { authorization: `Bearer ${login.token}` };
      const list = await app.inject({
        method: 'GET',
        url: `/hooks?scope=market&q=${a.slice(0, 12)}`,
        headers: auth,
      });
      expect(list.json()).toMatchObject({
        scope: 'market',
        hooks: [
          {
            address: a,
            score: 60,
            band: 'CAUTION',
            tradeable: false,
            pairs: [{ token0Symbol: 'ETH' }],
          },
        ],
      });
      const caution = await app.inject({
        method: 'GET',
        url: `/hooks?scope=market&band=DANGER&q=${a.slice(0, 12)}`,
        headers: auth,
      });
      expect((caution.json() as { hooks: unknown[] }).hooks).toEqual([]);
      const detail = await app.inject({ method: 'GET', url: `/hooks/1/${a}`, headers: auth });
      const d = detail.json() as {
        snapshots: { changes: string[] }[];
        permissionGrid: { flag: string; enabled: boolean }[];
        breakdown: { source: string }[];
      };
      expect(d.snapshots[0]!.changes).toContain('Score 85 → 60');
      expect(d.permissionGrid).toHaveLength(14);
      expect(d.permissionGrid.find((p) => p.flag === 'beforeSwap')!.enabled).toBe(true);
      expect(d.breakdown[0]!.source).toBe('framework §3');
      expect(d.breakdown.every((b) => (b as unknown as { penalty: number }).penalty <= 0)).toBe(
        true,
      );
      const whatIf = await app.inject({
        method: 'GET',
        url: `/hooks/1/${a}/what-if`,
        headers: auth,
      });
      expect(whatIf.json()).toMatchObject({
        available: false,
        reason: expect.stringMatching(/^Market data only/),
      });
      const missing = await app.inject({ method: 'GET', url: `/hooks/1/${addr()}`, headers: auth });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('snapshotChanges lists fee and code changes', () => {
    const base = {
      score: 90,
      band: 'SAFE' as const,
      codeHash: '0xaa',
      implementation: null,
      owner: null,
      permissionsBitmap: 1,
      fees: { '0xpool1234567890': 3000 },
    };
    expect(snapshotChanges(null, base)).toEqual([]);
    expect(
      snapshotChanges(base, { ...base, codeHash: '0xbb', fees: { '0xpool1234567890': 10000 } }),
    ).toEqual(['Contract code changed', 'Pool 0xpool1234… fee 0.3% → 1%']);
  });
});

describe('gas-aware decisions', () => {
  it('what-if: a hook pool that pays more can still lose after gas', async () => {
    const h = await harness();
    try {
      const hook = addr();
      const usdc = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
      const zero = '0x0000000000000000000000000000000000000000';
      await h.app.deps.prisma.hook.create({
        data: {
          chainId: 11155111,
          address: hook,
          flags: [],
          permissions: {},
          isProxy: false,
          codeHash: '',
          score: 90,
          band: 'SAFE',
          scoreBreakdown: [],
          lastSnapshot: {},
          lastCheckedAt: new Date(),
        },
      });
      await h.app.deps.prisma.hookPool.create({
        data: {
          chainId: 11155111,
          poolId: `0x${randomBytes(32).toString('hex')}`,
          hookAddress: hook,
          token0: zero,
          token1: usdc,
          token0Symbol: 'ETH',
          token1Symbol: 'USDC',
          fee: 3000,
          tickSpacing: 60,
        },
      });
      // Default route: 100 USDC, gas $0.05. Hook pool: 101 USDC, but 20× the gas units.
      h.market.handlers.quote_pool = (args) => ({
        chainId: args.chainId,
        poolId: `0x${'11'.repeat(32)}`,
        poolKey: args.poolKey,
        type: 'EXACT_INPUT',
        zeroForOne: true,
        tokenIn: { address: zero, symbol: 'ETH', decimals: 18, isNative: true },
        tokenOut: { address: usdc, symbol: 'USDC', decimals: 6, isNative: false },
        amountIn: { raw: '40000000000000000', decimal: '0.04' },
        amountOut: { raw: '101000000', decimal: '101' },
        gasEstimate: '3000000',
        quoter: zero,
        blockNumber: '1',
      });
      const res = await h.app.inject({
        method: 'GET',
        url: `/hooks/11155111/${hook}/what-if?pair=ETH-USDC&amountUsd=100`,
        headers: { authorization: `Bearer ${h.token}` },
      });
      const w = res.json() as {
        available: boolean;
        differencePct: number;
        netDifferencePct: number;
        viaHook: { gasUsd: string };
        defaultRoute: { gasUsd: string };
      };
      expect(w.available).toBe(true);
      expect(w.differencePct).toBeCloseTo(1, 2); // looks better before gas…
      expect(w.netDifferencePct).toBeLessThan(0); // …and is worse after it
      expect(Number(w.viaHook.gasUsd)).toBeGreaterThan(Number(w.defaultRoute.gasUsd));
    } finally {
      await h.close();
    }
  });
});

describe('LP positions in the portfolio', () => {
  it('shows live LP value, range and P&L, and feeds the LP risk factors', async () => {
    const h = await harness();
    const tokenId = String(BigInt(`0x${randomBytes(6).toString('hex')}`));
    try {
      const hook = addr();
      await h.app.deps.prisma.hook.create({
        data: {
          chainId: 11155111,
          address: hook,
          flags: [],
          permissions: {},
          isProxy: false,
          codeHash: '',
          score: 60,
          band: 'CAUTION',
          scoreBreakdown: [],
          lastSnapshot: {},
          lastCheckedAt: new Date(),
        },
      });
      await h.app.deps.prisma.lpPosition.create({
        data: {
          userId: h.userId,
          chainId: 11155111,
          protocol: 'V4',
          tokenId,
          poolId: `0x${'11'.repeat(32)}`,
          token0: '0x0000000000000000000000000000000000000000',
          token1: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
          hookAddress: hook,
          tickLower: -200000,
          tickUpper: -190000,
          openedTxHash: `0x${'aa'.repeat(32)}`,
          costBasisUsd: '100',
        },
      });
      h.market.handlers.get_lp_positions = (args) => ({
        chainId: args.chainId,
        owner: args.owner,
        positions: [
          {
            tokenId,
            owner: args.owner,
            ownerMatches: true,
            poolId: `0x${'11'.repeat(32)}`,
            poolKey: {
              currency0: '0x0000000000000000000000000000000000000000',
              currency1: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
              fee: 3000,
              tickSpacing: 60,
              hooks: hook,
            },
            hookAddress: hook,
            token0: {
              address: '0x0000000000000000000000000000000000000000',
              symbol: 'ETH',
              decimals: 18,
              isNative: true,
            },
            token1: {
              address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
              symbol: 'USDC',
              decimals: 6,
              isNative: false,
            },
            tickLower: -200000,
            tickUpper: -190000,
            currentTick: -180000,
            inRange: false,
            liquidity: '1000',
            poolLiquidity: '100000',
            amount0: { raw: '0', decimal: '0' },
            amount1: { raw: '110000000', decimal: '110' },
            uncollectedFees0: { raw: '0', decimal: '0' },
            uncollectedFees1: { raw: '1500000', decimal: '1.5' },
            priceLower: '2061.15',
            priceUpper: '5600.87',
            priceCurrent: '15222.0',
            valueUsd: '110',
          },
        ],
        notFound: [],
        totalValueUsd: '110',
        blockNumber: '1',
        asOf: new Date().toISOString(),
      });
      const res = await h.app.inject({
        method: 'GET',
        url: '/portfolio',
        headers: { authorization: `Bearer ${h.token}` },
      });
      expect(res.statusCode).toBe(200);
      const p = res.json() as {
        lpPositions: {
          valueUsd: string;
          pnlUsd: string;
          inRange: boolean;
          hook: { band: string };
          fees1: string;
        }[];
        risk: { factors: { factor: string; risk: number }[] };
      };
      expect(p.lpPositions[0]).toMatchObject({
        valueUsd: '110',
        pnlUsd: '10',
        inRange: false,
        fees1: '1.5',
        hook: { band: 'CAUTION', score: 60 },
      });
      const factor = (f: string) => p.risk.factors.find((x) => x.factor === f)!.risk;
      expect(factor('lpOutOfRange')).toBeGreaterThan(0);
      expect(factor('hookExposure')).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  });
});
