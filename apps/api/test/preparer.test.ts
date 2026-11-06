import { describe, expect, it } from 'vitest';
import type { ActionIntent } from '@warden/shared';
import { prepare, type PreparedAction } from '../src/modules/agent/preparer.js';
import { gateHook } from '../src/modules/safety/hookGate.js';
import { simulateSteps } from '../src/modules/safety/simulate.js';
import { createTestApp, devSignIn, uniqueName } from './helpers.js';
import { randomAddress } from './fakes.js';
import {
  createMarket,
  FakeChain,
  fixedPrices,
  giveWallet,
  POOL_ID,
  scriptedMcp,
  USDC,
} from './phase5-fakes.js';

const ctx = { traceId: 'prep-trace', userId: 'u', quiet: true };

async function setup() {
  const app = await createTestApp();
  const market = createMarket();
  const mcp = scriptedMcp(market);
  const login = await devSignIn(app, uniqueName('prep'));
  const wallet = await giveWallet(app.deps.prisma, login.user.id);
  const deps = {
    prisma: app.deps.prisma,
    mcp,
    prices: fixedPrices(market),
    chainId: 11155111 as const,
    allowlist: [],
  };
  const account = {
    userId: login.user.id,
    wallet: wallet.address as `0x${string}`,
    maxSlippagePct: 0.5,
  };
  const run = async (intent: ActionIntent) => {
    market.calls.length = 0;
    const p = await prepare(deps, { ...ctx, userId: login.user.id }, account, intent);
    return { p, calls: market.calls.map((c) => c.name), args: market.calls.map((c) => c.args) };
  };
  return { app, market, mcp, run, account, userId: login.user.id };
}

const reason = 'test';

describe('preparer: intent → MCP build tools (deterministic)', () => {
  it('maps every intent to the right tool calls', async () => {
    const s = await setup();
    try {
      // swap_exact_in
      let r = await s.run({
        type: 'swap_exact_in',
        tokenIn: { symbol: 'ETH' },
        tokenOut: { symbol: 'USDC' },
        amountIn: '0.002',
        reason,
      });
      expect(r.calls).toEqual(['build_swap']);
      expect(r.args[0]).toMatchObject({
        type: 'EXACT_INPUT',
        amount: '0.002',
        slippagePct: 0.5,
        swapper: s.account.wallet,
      });
      const p1 = r.p as PreparedAction;
      expect(p1.amountUsd?.toString()).toBe('5');
      expect(p1.quote).toMatchObject({
        amountOut: { symbol: 'USDC', amount: '5', usd: '5.00' },
        slippagePct: 0.5,
      });

      // swap_exact_out uses the token amount out and computes ETH needed
      r = await s.run({
        type: 'swap_exact_out',
        tokenIn: { symbol: 'ETH' },
        tokenOut: { symbol: 'USDC' },
        amountOut: '100',
        maxSlippagePct: 0.3,
        reason,
      });
      expect(r.args[0]).toMatchObject({ type: 'EXACT_OUTPUT', amount: '100', slippagePct: 0.3 });
      expect((r.p as PreparedAction).amountUsd?.toString()).toBe('100');

      // swap_and_send carries the recipient; sending to self drops it
      const to = randomAddress();
      r = await s.run({
        type: 'swap_and_send',
        tokenIn: { symbol: 'ETH' },
        tokenOut: { symbol: 'USDC' },
        mode: 'exact_out',
        amount: '20',
        recipient: to,
        reason,
      });
      expect(r.args[0]).toMatchObject({ type: 'EXACT_OUTPUT', recipient: to });
      expect((r.p as PreparedAction).stored.recipient).toBe(to);
      r = await s.run({
        type: 'swap_and_send',
        tokenIn: { symbol: 'ETH' },
        tokenOut: { symbol: 'USDC' },
        mode: 'exact_in',
        amount: '0.01',
        recipient: s.account.wallet,
        reason,
      });
      expect(r.args[0]).not.toHaveProperty('recipient');

      // transfer
      r = await s.run({
        type: 'transfer',
        token: { symbol: 'USDC' },
        amount: '20',
        recipient: to,
        reason,
      });
      expect(r.calls).toEqual(['build_transfer']);
      expect(r.args[0]).toMatchObject({ token: 'USDC', amount: '20', to, from: s.account.wallet });
      expect((r.p as PreparedAction).amountUsd?.toString()).toBe('20');
      expect((r.p as PreparedAction).stored.tokenChecks).toEqual(['USDC']);

      // lp_open with an explicit pool skips compare_pools
      r = await s.run({
        type: 'lp_open',
        token0: { symbol: 'ETH' },
        token1: { symbol: 'USDC' },
        amount0: '0.01',
        poolRef: { poolId: POOL_ID },
        rangePreset: 'narrow',
        reason,
      });
      expect(r.calls).toEqual(['build_lp_position']);
      expect(r.args[0]).toMatchObject({
        pool: { poolReference: POOL_ID },
        independentToken: { amount: '0.01' },
        range: { preset: 'narrow' },
      });

      // Live regression: a planner-chosen pool with only a USD amount (no token amounts) must
      // still resolve and price the tokens (it used to fail with "Could not price…").
      r = await s.run({
        type: 'lp_open',
        token0: { symbol: 'USDC' },
        token1: { symbol: 'ETH' },
        amountUsd: '10',
        poolRef: { poolId: POOL_ID },
        reason,
      });
      expect(r.calls).toEqual(['build_lp_position']);
      expect(r.args[0]).toMatchObject({
        // currency order: native ETH (0x0) first; $5 of ETH at $2,500
        pool: { token0: '0x0000000000000000000000000000000000000000' },
        independentToken: { token: '0x0000000000000000000000000000000000000000', amount: '0.002' },
        // no range named → the BALANCED profile's medium preset
        range: { preset: 'medium' },
      });

      // create_trigger → plan_trigger (no tx); cancel_trigger → nothing
      r = await s.run({
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
        reason,
      });
      expect(r.calls).toEqual(['plan_trigger']);
      expect(r.args[0]).toMatchObject({
        kind: 'STOP_LOSS',
        condition: { type: 'price_below', symbol: 'ETH', priceUsd: '2800' },
        actions: [{ type: 'swap_exact_in', amountIn: '100%' }],
      });
      expect(r.p.kind).toBe('trigger');
      r = await s.run({ type: 'cancel_trigger', triggerId: 't1', reason });
      expect(r.calls).toEqual([]);

      // lp_exit / lp_rebalance use our stored position
      const tokenId = String(Math.floor(Math.random() * 1e12));
      const pos = await s.app.deps.prisma.lpPosition.create({
        data: {
          userId: s.userId,
          chainId: 11155111,
          protocol: 'V4',
          tokenId,
          poolId: POOL_ID,
          token0: '0x0000000000000000000000000000000000000000',
          token1: USDC,
          tickLower: -10,
          tickUpper: 10,
          openedTxHash: '0x1',
          costBasisUsd: '50',
        },
      });
      r = await s.run({ type: 'lp_exit', positionId: pos.id, percent: 50, reason });
      expect([...r.calls].sort()).toEqual(['build_lp_exit', 'get_lp_positions']);
      expect(r.args[r.calls.indexOf('build_lp_exit')]).toMatchObject({
        tokenId,
        percent: 50,
        protocol: 'V4',
        claimFees: true,
      });
      expect((r.p as PreparedAction).amountUsd?.toString()).toBe('25'); // half the cost basis (no live value)
      s.market.handlers.build_rebalance = () => ({
        error: { code: 'POOL_NOT_FOUND', message: 'gone' },
      });
      r = await s.run({ type: 'lp_rebalance', positionId: pos.id, rangePreset: 'wide', reason });
      expect(r.calls).toContain('build_rebalance');
      expect((r.p as PreparedAction).buildError).toEqual({
        code: 'POOL_NOT_FOUND',
        message: 'gone',
      });
      await expect(
        s.run({ type: 'lp_exit', positionId: 'nope', percent: 100, reason }),
      ).rejects.toThrow(/not found/);
    } finally {
      await s.app.close();
    }
  });

  it('planHash is stable for the same facts and changes with the amount or recipient', async () => {
    const s = await setup();
    try {
      const intent: ActionIntent = {
        type: 'swap_exact_in',
        tokenIn: { symbol: 'ETH' },
        tokenOut: { symbol: 'USDC' },
        amountIn: '0.002',
        reason,
      };
      const a = (await s.run(intent)).p as PreparedAction;
      const b = (await s.run(intent)).p as PreparedAction;
      expect(a.planHash).toMatch(/^[0-9a-f]{64}$/);
      expect(a.planHash).toBe(b.planHash);
      const c = (await s.run({ ...intent, amountIn: '0.003' })).p as PreparedAction;
      expect(c.planHash).not.toBe(a.planHash);
    } finally {
      await s.app.close();
    }
  });

  it('hook gate scores once and serves the cache for an hour', async () => {
    const s = await setup();
    try {
      const hook = randomAddress();
      let calls = 0;
      s.market.handlers.score_hook = (args) => {
        calls += 1;
        const flags = [
          'beforeInitialize',
          'afterInitialize',
          'beforeAddLiquidity',
          'afterAddLiquidity',
          'beforeRemoveLiquidity',
          'afterRemoveLiquidity',
          'beforeSwap',
          'afterSwap',
          'beforeDonate',
          'afterDonate',
          'beforeSwapReturnDelta',
          'afterSwapReturnDelta',
          'afterAddLiquidityReturnDelta',
          'afterRemoveLiquidityReturnDelta',
        ];
        return {
          chainId: args.chainId,
          hookAddress: args.hookAddress,
          score: 62,
          band: 'CAUTION',
          permissions: Object.fromEntries(flags.map((f) => [f, f === 'beforeSwap'])),
          enabledPermissions: [{ flag: 'beforeSwap', bit: 7, risk: 'HIGH' }],
          facts: {
            hasCode: true,
            codeSizeBytes: 100,
            codeHash: `0x${'aa'.repeat(32)}`,
            proxy: {
              kind: null,
              implementation: null,
              admin: null,
              beacon: null,
              upgradeable: false,
            },
            owner: null,
            adminSelectors: [],
            verifiedSource: null,
            contractName: null,
            firstSeenBlock: null,
            firstSeenAt: null,
            ageDays: null,
            ageSource: null,
            poolCount: 1,
            dynamicFeePoolCount: 0,
            tvlUsd: null,
          },
          breakdown: [
            {
              rule: 'beforeSwap',
              penalty: -38,
              evidence: 'can change swap behaviour',
              source: 'framework',
            },
          ],
          framework: {
            featureTriggers: [],
            riskScore: {
              permissions: 5,
              upgradeMechanism: 0,
              observableTotal: 5,
              maxTotal: 33,
              tierAtLeast: 'Medium',
              unobserved: [],
            },
          },
          scoredAt: new Date().toISOString(),
        };
      };
      const deps = { prisma: s.app.deps.prisma, mcp: s.mcp };
      const first = await gateHook(deps, ctx, 11155111, hook);
      const second = await gateHook(deps, ctx, 11155111, hook);
      expect(first).toMatchObject({ score: 62, band: 'CAUTION', cached: false });
      expect(second.cached).toBe(true);
      expect(calls).toBe(1);
      const later = await gateHook(
        { ...deps, now: () => new Date(Date.now() + 61 * 60_000) },
        ctx,
        11155111,
        hook,
      );
      expect(later.cached).toBe(false);
      expect(calls).toBe(2);
    } finally {
      await s.app.close();
    }
  });
});

describe('simulation', () => {
  const from = randomAddress();
  const step = (kind: string) => ({ kind, tx: { to: randomAddress(), data: '0x12', value: '0' } });
  it('defers steps that depend on an earlier approval; fails closed without RPC', async () => {
    const chain = new FakeChain();
    const sim = await simulateSteps(chain, from, [step('APPROVAL'), step('SWAP')]);
    expect(sim.ok).toBe(true);
    expect(sim.steps).toEqual([
      { index: 0, ok: true, gasEstimate: '150000' },
      { index: 1, ok: true, deferred: true },
    ]);
    expect(chain.calls).toHaveLength(1);
    expect(await simulateSteps(null, from, [step('SWAP')])).toMatchObject({
      ok: false,
      unavailable: true,
    });
  });
  it('stops at the first revert with its reason', async () => {
    const chain = new FakeChain();
    chain.revert = () => 'TRANSFER_FROM_FAILED';
    const sim = await simulateSteps(chain, from, [step('SWAP'), step('SWAP')]);
    expect(sim).toMatchObject({
      ok: false,
      steps: [{ index: 0, ok: false, revertReason: 'TRANSFER_FROM_FAILED' }],
    });
    expect(sim.error).toMatch(/step 1 \(swap\) reverted/);
  });
});
