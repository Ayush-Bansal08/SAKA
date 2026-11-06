/**
 * Demo market simulator: scenarios carry no decision, the overlay stays on the read side, and a
 * run goes through the real planner, processEvent and pipeline, whatever the model decides.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Decimal,
  DecisionDigestSchema,
  SIMULATOR_SCENARIO_IDS,
  type PortfolioResponse,
  type ProvidersResponse,
  type SimulatorRunView,
} from '@warden/shared';
import { plannerTools, toolSchema } from '../src/modules/agent/planner.js';
import { bufferedGas } from '../src/modules/execution/chain.js';
import type { UniswapMcpClient } from '../src/modules/mcp/client.js';
import { buildOverlay, overlayMcp } from '../src/modules/modeb/simulator/marketOverlay.js';
import {
  assertSimulatedWriteChain,
  buildSimulatedEvent,
  decisionOf,
  outcomeOf,
} from '../src/modules/modeb/simulator/run.js';
import { SCENARIOS } from '../src/modules/modeb/simulator/scenarios/index.js';
import { createTestApp, devSignIn, uniqueName } from './helpers.js';
import {
  createMarket,
  FakeChain,
  FakeWallets,
  giveWallet,
  RecordingJobs,
  scriptedMcp,
  ZG_ENV,
  zgRouter,
  type ZgScript,
} from './phase5-fakes.js';

const NOW = new Date('2026-11-06T12:00:00.000Z');
const portfolio = (eth: string, usdc: string) =>
  ({
    totalUsd: new Decimal(eth).plus(usdc).toString(),
    tokens: [
      { symbol: 'ETH', valueUsd: eth },
      { symbol: 'USDC', valueUsd: usdc },
    ],
    lpPositions: [],
  }) as unknown as PortfolioResponse;

describe('scenarios', () => {
  it('supply conditions only: no decision reaches the model', () => {
    for (const id of SIMULATOR_SCENARIO_IDS) {
      const scenario = SCENARIOS[id];
      const overlay = buildOverlay(scenario, new Decimal(3000), portfolio('50', '50'), NOW);
      const seen = JSON.stringify([
        scenario,
        overlay.snapshot,
        buildSimulatedEvent(scenario, 'run-1', NOW),
      ]);
      expect(seen).not.toMatch(/buy|sell|hold|expected|do_nothing/i);
    }
  });

  it('every price path ends on the same scenario price', () => {
    for (const id of SIMULATOR_SCENARIO_IDS) {
      const path = SCENARIOS[id].prices;
      if (path)
        expect(new Set([path['1h'].at(-1), path['24h'].at(-1), path['7d'].at(-1)]).size).toBe(1);
    }
  });

  it('A and B are both ETH drops with opposite evidence', () => {
    const a = buildOverlay(
      SCENARIOS.ETH_DIP_STABILIZING,
      new Decimal(3000),
      portfolio('50', '50'),
      NOW,
    );
    const b = buildOverlay(
      SCENARIOS.ETH_CRASH_GUARD,
      new Decimal(3000),
      portfolio('50', '50'),
      NOW,
    );
    expect(a.ethUsd.toString()).toBe('2700');
    expect(b.ethUsd.toString()).toBe('2760');
    const alloc = (o: typeof a) =>
      o.snapshot.allocation as { ethAllocationPct: string; targetEthAllocationPct: string };
    expect(Number(alloc(a).ethAllocationPct)).toBeLessThan(Number(alloc(a).targetEthAllocationPct));
    expect(Number(alloc(b).ethAllocationPct)).toBeGreaterThan(
      Number(alloc(b).targetEthAllocationPct),
    );
  });
});

describe('market overlay', () => {
  const emit = vi.fn(async () => undefined);
  const ctx = { traceId: 't', userId: 'u' };
  const wrap = (id: keyof typeof SCENARIOS, callTool: (...a: unknown[]) => Promise<unknown>) =>
    overlayMcp(
      buildOverlay(SCENARIOS[id], new Decimal(3000), portfolio('50', '50'), NOW),
      { callTool } as unknown as Pick<UniswapMcpClient, 'callTool'>,
      { emit },
    );

  it('serves the scenario history, flagged, without touching the real tool', async () => {
    const real = vi.fn();
    const out = (await wrap('ETH_DIP_STABILIZING', real).callTool(
      'get_price_history',
      { symbol: 'ETH', window: '7d', interval: 'day' },
      ctx,
    )) as unknown as { simulated: boolean; close: string; high: string };
    expect(real).not.toHaveBeenCalled();
    expect(out).toMatchObject({ simulated: true, close: '2700.00', high: '3000.00' });
    expect(emit).toHaveBeenCalled();
  });

  it('never changes a quote', async () => {
    const quote = { amountOut: { raw: '1', decimal: '1' }, priceImpactPct: 0.1 };
    const out = await wrap('ETH_CRASH_GUARD', async () => quote).callTool(
      'get_quote',
      {} as never,
      ctx,
    );
    expect(out).toMatchObject(quote);
  });

  it('refuses anything that is not a read tool', async () => {
    const real = vi.fn();
    await expect(
      wrap('ETH_DIP_STABILIZING', real).callTool('build_swap', {} as never, ctx),
    ).rejects.toThrow(/not a read tool/);
    expect(real).not.toHaveBeenCalled();
  });

  it('scores the synthetic hook as a risk indicator', async () => {
    const out = await wrap('LP_MIGRATION_NOT_WORTH_IT', vi.fn()).callTool(
      'score_hook',
      { hookAddress: SCENARIOS.LP_MIGRATION_NOT_WORTH_IT.lp!.hook.address } as never,
      ctx,
    );
    expect(JSON.stringify(out)).toContain('not a security certification');
  });
});

describe('decisions', () => {
  const zg = { requestId: 'r', clientRequestId: 'c', model: 'm', trustMode: 'private' } as const;
  const swap = (tokenIn: string, tokenOut: string) =>
    ({
      type: 'swap_exact_in',
      tokenIn: { symbol: tokenIn },
      tokenOut: { symbol: tokenOut },
      amountIn: '1',
      reason: 'r',
    }) as const;

  it('names the direction from the tokens', () => {
    expect(outcomeOf(swap('USDC', 'ETH'))).toBe('BUY');
    expect(outcomeOf(swap('ETH', 'USDC'))).toBe('SELL');
    expect(outcomeOf(swap('ETH', 'LINK'))).toBe('SWAP');
  });

  it('keeps what the model returned and invents nothing', () => {
    const d = decisionOf({
      kind: 'answer',
      text: 'Costs outweigh the gain.',
      zg,
      facts: [],
      digest: { risks: ['young pool'], confidence: 'high', signalsChecked: 'none' },
    });
    expect(d.outcome).toBe('NO_ACTION');
    expect(d.digest?.risks).toEqual(['young pool']);
    expect(d.digest?.confidence).toBeUndefined();
    expect(d.digest?.signalsChecked).toBeUndefined();
    expect(decisionOf({ kind: 'answer', text: 'x', zg, facts: [] }).digest).toBeNull();
  });

  it('reads an info intent as no action, as the live model sometimes sends it', () => {
    const intent = { type: 'info', topic: 'risk', reason: 'No LP migration: costs eat the yield.' };
    const d = decisionOf({ kind: 'intent', intent, zg } as never);
    expect(d).toMatchObject({ outcome: 'NO_ACTION', summary: null, rationale: intent.reason });
  });

  it('never labels an unknown action as a swap', () => {
    const transfer = { type: 'transfer', token: { symbol: 'USDC' }, amount: '1', reason: 'r' };
    expect(outcomeOf(transfer as never)).toBe('OTHER_ACTION');
  });

  it('does not pass a question off as a decision', () => {
    const d = decisionOf({
      kind: 'answer',
      text: 'How much?',
      needsClarification: true,
      zg,
      facts: [],
    });
    expect(d.outcome).toBe('NO_DECISION');
  });

  it('the digest schema is a usable tool schema and live tools stay without it', () => {
    const schema = toolSchema(DecisionDigestSchema) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toContain('signalsChecked');
    expect(JSON.stringify(plannerTools)).not.toContain('digest');
  });
});

describe('gas limit', () => {
  it('clears the Permit2 swap that reverted on the quoted limit', () => {
    expect(bufferedGas('277512')).toBeGreaterThan(293_085n);
    expect(bufferedGas('277512')).toBe(416_268n);
  });
});

describe('mainnet guard', () => {
  it('blocks mainnet and allows the testnets', () => {
    expect(() => assertSimulatedWriteChain(1)).toThrow(/Safety block/);
    expect(() => assertSimulatedWriteChain(11155111)).not.toThrow();
  });
});

// --- Through the real routes ------------------------------------------------------------------

interface Script extends ZgScript {
  answer: string | null;
}

async function harness(env: Record<string, string> = { ENABLE_DEMO_SIMULATOR: 'true' }) {
  const market = createMarket();
  market.handlers.get_price_history = (args) => ({
    symbol: 'ETH',
    window: args.window,
    interval: args.interval,
    source: { kind: 'pool', id: 'x', description: 'x', provider: 'test' },
    series: [],
    open: '3000',
    close: '3000',
    high: '3000',
    low: '3000',
    changePct: '0',
    asOf: null,
    lagSeconds: null,
    stale: false,
    hasIndexingErrors: null,
    warnings: [],
  });
  const jobs = new RecordingJobs();
  const script: Script = { proposals: [], guard: 'approve', decisions: 0, answer: null };
  const router = zgRouter(script);
  let down = false;
  let overloaded = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (...args: Parameters<typeof router>) => {
      if (down) throw new Error('0G down');
      if (overloaded)
        return new Response(JSON.stringify({ error: { message: 'model_overloaded' } }), {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'zg-busy',
            'retry-after': '30',
          },
        });
      const body = JSON.parse(String(args[1]?.body ?? '{}')) as { tools?: unknown[] };
      if (script.answer && body.tools?.length)
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'a',
                      type: 'function',
                      function: {
                        name: 'answer',
                        arguments: JSON.stringify({
                          text: script.answer,
                          digest: { risks: ['young pool'], confidence: 0.8 },
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            x_0g_trace: { request_id: 'zg-answer' },
          }),
          { headers: { 'content-type': 'application/json', 'x-request-id': 'zg-answer' } },
        );
      return router(...args);
    }),
  );
  const app = await createTestApp(
    { ...ZG_ENV, AUTO_EXECUTE_DELAY_MS: '0', ...env },
    {
      mcp: scriptedMcp(market),
      jobs,
      chain: new FakeChain(),
      wallets: new FakeWallets(),
    },
  );
  const login = await devSignIn(app, uniqueName('simulator'));
  await giveWallet(app.deps.prisma, login.user.id);
  const headers = { authorization: `Bearer ${login.token}` };
  const get = async (id: string, h = headers) =>
    app.inject({ method: 'GET', url: `/simulator/runs/${id}`, headers: h });
  return {
    app,
    jobs,
    script,
    headers,
    login,
    get,
    zgDown: () => {
      down = true;
    },
    zgOverloaded: () => {
      overloaded = true;
    },
    /** Starts a run and waits for it to end. */
    async run(scenarioId: string, mode: string): Promise<SimulatorRunView> {
      const res = await app.inject({
        method: 'POST',
        url: '/simulator/runs',
        headers,
        payload: { scenarioId, mode },
      });
      expect(res.statusCode).toBe(202);
      const id = (res.json() as SimulatorRunView).id;
      await vi.waitFor(
        async () => {
          const run = (await get(id)).json() as SimulatorRunView;
          expect(run.status).not.toBe('RUNNING');
        },
        { timeout: 10_000, interval: 50 },
      );
      return (await get(id)).json() as SimulatorRunView;
    },
    plans: () => app.deps.prisma.actionPlan.findMany({ where: { userId: login.user.id } }),
    trace: (traceId: string) =>
      app.deps.prisma.traceEventRow.findMany({ where: { traceId }, orderBy: { ts: 'asc' } }),
  };
}

const buy = (usd: string) => ({
  type: 'swap_exact_in',
  tokenIn: { symbol: 'USDC' },
  tokenOut: { symbol: 'ETH' },
  amountIn: usd,
  amountUsd: usd,
  reason: 'A small first tranche: the decline has stabilized.',
  digest: {
    signalsChecked: [{ signal: 'Selling volume', value: '1.0x', supports: 'ACT' }],
    confidence: 0.75,
    tranche: { index: 1, maxTranches: 3, cooldownMinutes: 30 },
  },
});

describe('simulator routes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('do not exist with the flag off', async () => {
    const h = await harness({});
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/simulator/runs',
        headers: h.headers,
        payload: { scenarioId: 'ETH_DIP_STABILIZING', mode: 'PAPER' },
      });
      expect(res.statusCode).toBe(404);
      const scenarios = await h.app.inject({
        method: 'GET',
        url: '/simulator/scenarios',
        headers: h.headers,
      });
      expect(scenarios.statusCode).toBe(404);
      const providers = await h.app.inject({ method: 'GET', url: '/auth/providers' });
      expect(providers.json()).not.toHaveProperty('demoSimulator');
    } finally {
      await h.app.close();
    }
  });

  it('announce themselves with the flag on', async () => {
    const h = await harness();
    try {
      const providers = await h.app.inject({ method: 'GET', url: '/auth/providers' });
      expect((providers.json() as ProvidersResponse).demoSimulator).toBe(true);
      const res = await h.app.inject({
        method: 'GET',
        url: '/simulator/scenarios',
        headers: h.headers,
      });
      expect((res.json() as { scenarios: unknown[] }).scenarios).toHaveLength(3);
    } finally {
      await h.app.close();
    }
  });

  it('demo: the model decides and the action runs through the one pipeline', async () => {
    const h = await harness();
    h.script.proposals = [buy('10')];
    try {
      const run = await h.run('ETH_DIP_STABILIZING', 'DEMO');
      expect(run.error).toBeNull();
      expect(run).toMatchObject({ status: 'DONE', effectiveMode: 'DEMO', rejected: false });
      expect(run.decision?.outcome).toBe('BUY');
      expect(run.decision?.digest?.tranche?.maxTranches).toBe(3);
      expect(run.suggestion).toMatchObject({ simulated: true, status: 'AUTO_EXECUTED' });
      expect(h.jobs.executions).toHaveLength(1);
      const kinds = (await h.trace(run.id)).map((e) => e.kind);
      for (const kind of ['detector', 'plan', 'simulation', 'guard', 'policy'])
        expect(kinds).toContain(kind);
    } finally {
      await h.app.close();
    }
  });

  it('paper: everything up to simulation, and nothing queued or left open', async () => {
    const h = await harness();
    h.script.proposals = [buy('10')];
    try {
      const run = await h.run('ETH_DIP_STABILIZING', 'PAPER');
      expect(run.notice).toMatch(/^Paper — not broadcast/);
      expect(run.suggestion).toMatchObject({ status: 'INFO', simulated: true });
      expect(run.suggestion?.actions).not.toContain('yes');
      expect(h.jobs.executions).toHaveLength(0);
      expect((await h.plans())[0]?.status).toBe('CANCELLED');
      const roles = await h.app.deps.prisma.inference.findMany({
        where: { agentRequest: { traceId: run.id } },
        select: { role: true },
      });
      expect(roles.map((r) => r.role)).toContain('GUARD');
      expect(roles.map((r) => r.role)).not.toContain('EXPLAINER');
    } finally {
      await h.app.close();
    }
  });

  it('out of the mandate: rejected with the policy reason, never auto-approved', async () => {
    const h = await harness();
    h.script.proposals = [buy('60')];
    try {
      const run = await h.run('ETH_DIP_STABILIZING', 'DEMO');
      expect(run.rejected).toBe(true);
      expect(run.notice).toMatch(/^Rejected: /);
      expect(run.notice).toMatch(/limit/i);
      expect(h.jobs.executions).toHaveLength(0);
      expect((await h.plans())[0]?.status).toBe('CANCELLED');
    } finally {
      await h.app.close();
    }
  });

  it('no action is a first-class outcome: no plan, no job', async () => {
    const h = await harness();
    h.script.answer = 'The break-even is far too long, and the hook can be upgraded.';
    try {
      const run = await h.run('LP_MIGRATION_NOT_WORTH_IT', 'DEMO');
      expect(run.status).toBe('DONE');
      expect(run.decision).toMatchObject({ outcome: 'NO_ACTION', rationale: h.script.answer });
      expect(run.decision?.digest?.risks).toEqual(['young pool']);
      expect(run.suggestion).toMatchObject({ status: 'INFO', simulated: true, plan: null });
      expect(await h.plans()).toHaveLength(0);
    } finally {
      await h.app.close();
    }
  });

  it('an info intent ends as no action, not as a rejection', async () => {
    const h = await harness();
    h.script.proposals = [{ type: 'info', topic: 'risk', reason: 'No migration: costs eat it.' }];
    try {
      const run = await h.run('LP_MIGRATION_NOT_WORTH_IT', 'DEMO');
      expect(run).toMatchObject({ status: 'DONE', rejected: false, notice: null });
      expect(run.decision?.outcome).toBe('NO_ACTION');
      expect(await h.plans()).toHaveLength(0);
    } finally {
      await h.app.close();
    }
  });

  it('never runs what a simulated run may not do', async () => {
    const h = await harness();
    h.script.proposals = [
      {
        type: 'create_trigger',
        rule: {
          kind: 'PRICE_ALERT',
          condition: { type: 'price_below', token: { symbol: 'ETH' }, priceUsd: '2000' },
        },
        reason: 'Watch the floor.',
      },
    ];
    try {
      const run = await h.run('ETH_CRASH_GUARD', 'DEMO');
      expect(run.status).toBe('DONE');
      expect(run.rejected).toBe(true);
      expect(run.notice).toMatch(/create_trigger/);
      expect(await h.plans()).toHaveLength(0);
      expect(h.jobs.executions).toHaveLength(0);
      const rules = await h.app.deps.prisma.trigger.count({ where: { userId: h.login.user.id } });
      expect(rules).toBe(0);
    } finally {
      await h.app.close();
    }
  });

  it('a failed 0G call is shown as failed, with no fallback decision', async () => {
    const h = await harness();
    h.zgDown();
    try {
      const run = await h.run('ETH_DIP_STABILIZING', 'DEMO');
      expect(run.status).toBe('FAILED');
      expect(run.error).toMatch(/^Reasoning failed/);
      expect(run.decision).toBeNull();
      expect(run.suggestion).toBeNull();
      expect(await h.plans()).toHaveLength(0);
    } finally {
      await h.app.close();
    }
  });

  it('fails fast and says why when 0G is overloaded, instead of waiting out Retry-After', async () => {
    const h = await harness();
    h.zgOverloaded();
    try {
      const started = Date.now();
      const run = await h.run('ETH_DIP_STABILIZING', 'PAPER');
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(run.status).toBe('FAILED');
      expect(run.error).toMatch(/overloaded/);
      expect(run.decision).toBeNull();
      expect(await h.plans()).toHaveLength(0);
    } finally {
      await h.app.close();
    }
  });

  it('allows one run at a time and keeps runs private', async () => {
    const h = await harness();
    h.script.answer = 'Nothing to do.';
    try {
      const first = await h.app.inject({
        method: 'POST',
        url: '/simulator/runs',
        headers: h.headers,
        payload: { scenarioId: 'LP_MIGRATION_NOT_WORTH_IT', mode: 'PAPER' },
      });
      const second = await h.app.inject({
        method: 'POST',
        url: '/simulator/runs',
        headers: h.headers,
        payload: { scenarioId: 'LP_MIGRATION_NOT_WORTH_IT', mode: 'PAPER' },
      });
      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(409);
      const other = await devSignIn(h.app, uniqueName('other'));
      const id = (first.json() as SimulatorRunView).id;
      expect((await h.get(id, { authorization: `Bearer ${other.token}` })).statusCode).toBe(404);
    } finally {
      await h.app.close();
    }
  });

  it('cannot use up a live dedupe key', async () => {
    const h = await harness();
    h.script.proposals = [buy('10')];
    try {
      const run = await h.run('ETH_DIP_STABILIZING', 'PAPER');
      const row = await h.app.deps.prisma.suggestion.findUniqueOrThrow({
        where: { id: run.suggestion!.id },
      });
      expect(row.simulated).toBe(true);
      expect(row.dedupeKey).toMatch(/^sim:/);
    } finally {
      await h.app.close();
    }
  });
});
