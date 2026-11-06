/**
 * The simulated market a run reasons about: real data with the scenario applied, every changed
 * value flagged. `overlayMcp` wraps read tools for the planner of one run only. The pipeline keeps
 * the real client, so a synthetic price can never reach a quote that executes.
 */
import {
  Decimal,
  type PortfolioResponse,
  type TraceEventInput,
  type UniswapMcp,
} from '@warden/shared';
import type { PlannerContext } from '../../agent/context.js';
import { READ_TOOLS } from '../../agent/planner.js';
import type { McpCallContext, UniswapMcpClient } from '../../mcp/client.js';
import type { Scenario } from './types.js';

export const SIMULATION_NOTE = 'Market data in this run is a simulated scenario.';
const QUOTE_NOTE =
  'Real quote, not part of the scenario. Use it for gas and price impact; the scenario price is in the simulation context.';
const HOOK_NOTE =
  'Synthetic hook for this scenario. The score is a risk indicator, not a security certification.';

type ReadClient = Pick<UniswapMcpClient, 'callTool'>;
type Window = '1h' | '24h' | '7d';

const WINDOW_MS: Record<Window, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 };
const isEth = (symbol: string) => /^W?ETH$/i.test(symbol);
const usd = (d: Decimal) => d.toDecimalPlaces(2).toFixed(2);

export interface MarketOverlay {
  scenario: Scenario;
  now: Date;
  realEthUsd: Decimal;
  /** The scenario's ETH price as a multiple of the real one. */
  factor: Decimal;
  ethUsd: Decimal;
  /** What the model reads in the trusted context. */
  snapshot: Record<string, unknown>;
}

function allocationFacts(scenario: Scenario, portfolio: PortfolioResponse, factor: Decimal) {
  if (!scenario.allocation) return null;
  let eth = new Decimal(0);
  let other = new Decimal(0);
  for (const t of portfolio.tokens) {
    const value = new Decimal(t.valueUsd ?? 0);
    if (isEth(t.symbol)) eth = eth.plus(value.times(factor));
    else other = other.plus(value);
  }
  const total = eth.plus(other);
  const pct = total.gt(0) ? eth.div(total).times(100) : new Decimal(0);
  // No mandate stores a target yet, so it is placed relative to the real allocation.
  const target =
    scenario.allocation === 'BELOW_TARGET'
      ? Decimal.min(pct.plus(15), 100)
      : Decimal.max(pct.minus(10), 0);
  return {
    ethValueUsd: usd(eth),
    ethAllocationPct: pct.toDecimalPlaces(1).toString(),
    targetEthAllocationPct: target.toDecimalPlaces(1).toString(),
    targetIsScenarioAssumption: true,
  };
}

function lpFacts(scenario: Scenario, portfolio: PortfolioResponse) {
  const lp = scenario.lp;
  if (!lp) return null;
  const real = portfolio.lpPositions[0];
  const value = new Decimal(real?.valueUsd ?? lp.assumedPositionUsd);
  return {
    position: real
      ? { id: real.id, valueUsd: usd(value), inRange: true, currentAprPct: lp.currentAprPct }
      : {
          id: null,
          valueUsd: usd(value),
          inRange: true,
          currentAprPct: lp.currentAprPct,
          scenarioAssumption: 'The account has no open position; this one is assumed.',
        },
    candidatePool: {
      poolId: lp.candidatePoolId,
      headlineFeeAprPct: lp.candidateAprPct,
      tvlUsd: lp.candidateTvlUsd,
      ageHours: lp.candidateAgeHours,
      volume: lp.candidateVolume,
      hookAddress: lp.hook.address,
      syntheticPool: true,
    },
    migrationCosts: {
      steps: 'withdraw, swap to the new ratio, deposit',
      gasUsd: lp.migrationGasUsd,
      slippageUsd: usd(value.times(lp.migrationSlippagePct).div(100)),
    },
    lpMandate:
      'Auto-act for pool moves follows the account setting; the policy engine enforces it.',
  };
}

export function buildOverlay(
  scenario: Scenario,
  realEthUsd: Decimal,
  portfolio: PortfolioResponse,
  now: Date,
): MarketOverlay {
  const path = scenario.prices;
  const factor = new Decimal(path?.['1h'].at(-1) ?? 1);
  const ethUsd = realEthUsd.times(factor);
  const high7d = path ? Decimal.max(...path['7d']).times(realEthUsd) : null;
  const allocation = allocationFacts(scenario, portfolio, factor);
  const lp = lpFacts(scenario, portfolio);
  return {
    scenario,
    now,
    realEthUsd,
    factor,
    ethUsd,
    snapshot: {
      simulated: true,
      note: SIMULATION_NOTE,
      asOf: now.toISOString(),
      ethPriceUsd: usd(ethUsd),
      ...(high7d ? { ethHigh7dUsd: usd(high7d) } : {}),
      signals: scenario.signals,
      ...(allocation ? { allocation } : {}),
      ...(lp ? { lp } : {}),
    },
  };
}

/** The planner's portfolio and reference prices as the scenario sees them. */
export function overlayAccount(
  overlay: MarketOverlay,
  portfolio: NonNullable<PlannerContext['portfolio']>,
  prices: Record<string, string>,
): Pick<PlannerContext, 'portfolio' | 'referencePricesUsd'> {
  let total = new Decimal(portfolio.totalUsd);
  const tokens = portfolio.tokens.map((t) => {
    if (!isEth(t.symbol) || t.valueUsd === null) return t;
    const value = new Decimal(t.valueUsd);
    const scaled = value.times(overlay.factor);
    total = total.minus(value).plus(scaled);
    return { ...t, valueUsd: usd(scaled) };
  });
  return {
    portfolio: { ...portfolio, tokens, totalUsd: usd(total) },
    referencePricesUsd: Object.fromEntries(
      Object.entries(prices).map(([symbol, price]) => [
        symbol,
        isEth(symbol) ? usd(overlay.ethUsd) : price,
      ]),
    ),
  };
}

function priceHistory(overlay: MarketOverlay, symbol: string, window: Window, interval: string) {
  const points = overlay.scenario.prices![window].map((m) => overlay.realEthUsd.times(m));
  const step = WINDOW_MS[window] / (points.length - 1);
  const end = overlay.now.getTime();
  const open = points[0]!;
  const close = points.at(-1)!;
  return {
    symbol,
    window,
    interval,
    simulated: true,
    source: { kind: 'token', id: 'scenario', description: SIMULATION_NOTE, provider: 'simulator' },
    series: points.map((p, i) => ({
      ts: new Date(end - (points.length - 1 - i) * step).toISOString(),
      priceUsd: usd(p),
    })),
    open: usd(open),
    close: usd(close),
    high: usd(Decimal.max(...points)),
    low: usd(Decimal.min(...points)),
    changePct: close.minus(open).div(open).times(100).toDecimalPlaces(2).toString(),
    asOf: overlay.now.toISOString(),
    lagSeconds: 0,
    stale: false,
    hasIndexingErrors: false,
    warnings: [SIMULATION_NOTE],
  };
}

function overlayPortfolio(overlay: MarketOverlay, real: UniswapMcp.ToolOutput<'get_portfolio'>) {
  const scale = (v: string | null) =>
    v === null ? v : new Decimal(v).times(overlay.factor).toString();
  let total = new Decimal(0);
  const tokens = real.tokens.map((t) => {
    const next = isEth(t.symbol)
      ? { ...t, priceUsd: scale(t.priceUsd), valueUsd: scale(t.valueUsd) }
      : t;
    total = total.plus(next.valueUsd ?? 0);
    return next;
  });
  return {
    ...real,
    tokens,
    totalUsd: usd(total),
    simulated: true,
    simulationNote: SIMULATION_NOTE,
  };
}

function overlayPools(overlay: MarketOverlay, real: UniswapMcp.ToolOutput<'compare_pools'>) {
  const lp = overlay.scenario.lp!;
  return {
    ...real,
    simulated: true,
    simulationNote: SIMULATION_NOTE,
    ranked: [
      ...real.ranked,
      {
        rank: real.ranked.length + 1,
        poolId: lp.candidatePoolId,
        source: 'market',
        usableOnExecutionChain: false,
        fee: 3000,
        tickSpacing: 60,
        hookAddress: lp.hook.address,
        hookBand: lp.hook.band,
        hookScore: lp.hook.score,
        referenceFeeAprPct: lp.candidateAprPct,
        // Same rule as the real tool: a Caution hook halves the APR.
        adjustedAprPct: new Decimal(lp.candidateAprPct).times('0.5').toString(),
        referenceTvlUsd: lp.candidateTvlUsd,
        reasons: ['Synthetic pool of this scenario', ...lp.hook.findings],
        simulated: true,
      },
    ],
  };
}

const scoreHook = (overlay: MarketOverlay) => {
  const { hook } = overlay.scenario.lp!;
  return {
    hookAddress: hook.address,
    score: hook.score,
    band: hook.band,
    findings: hook.findings,
    simulated: true,
    simulationNote: HOOK_NOTE,
  };
};

const hookState = (overlay: MarketOverlay) => {
  const { hook } = overlay.scenario.lp!;
  return {
    hookAddress: hook.address,
    hasCode: true,
    owner: hook.owner,
    implementation: hook.implementation,
    findings: hook.findings,
    simulated: true,
    simulationNote: HOOK_NOTE,
  };
};

const newHooks = (overlay: MarketOverlay) => {
  const { hook, candidatePoolId, candidateTvlUsd, candidateAgeHours } = overlay.scenario.lp!;
  return {
    hooks: [
      {
        hookAddress: hook.address,
        poolId: candidatePoolId,
        totalTvlUsd: candidateTvlUsd,
        firstSeen: new Date(overlay.now.getTime() - candidateAgeHours * 3_600_000).toISOString(),
      },
    ],
    simulated: true,
    simulationNote: HOOK_NOTE,
  };
};

/** Read tools for the planner of one run. Anything but a read tool is refused outright. */
export function overlayMcp(
  overlay: MarketOverlay,
  real: ReadClient,
  trace: { emit(e: TraceEventInput): Promise<unknown> },
): ReadClient {
  const { scenario } = overlay;
  const hookAddress = scenario.lp?.hook.address;
  const isSyntheticHook = (args: { hookAddress: string }) =>
    args.hookAddress.toLowerCase() === hookAddress;
  const logged = async <T>(name: string, ctx: McpCallContext, args: unknown, output: T) => {
    await trace.emit({
      traceId: ctx.traceId,
      userId: ctx.userId,
      kind: 'system',
      title: `Scenario overlay on ${name}`,
      detail: SIMULATION_NOTE,
      data: { overlay: name, args },
    });
    return output;
  };

  const read = async (
    name: UniswapMcp.ToolName,
    args: never,
    ctx: McpCallContext,
  ): Promise<unknown> => {
    if (!(READ_TOOLS as readonly string[]).includes(name))
      throw new Error(`${name} is not a read tool: simulated runs cannot reach it.`);
    const a = args as Record<string, unknown>;
    if (name === 'get_price_history' && scenario.prices && isEth(String(a.symbol)))
      return logged(
        name,
        ctx,
        a,
        priceHistory(overlay, String(a.symbol), a.window as Window, String(a.interval)),
      );
    if (hookAddress && name === 'score_hook' && isSyntheticHook(a as { hookAddress: string }))
      return logged(name, ctx, a, scoreHook(overlay));
    if (hookAddress && name === 'get_hook_state' && isSyntheticHook(a as { hookAddress: string }))
      return logged(name, ctx, a, hookState(overlay));
    if (hookAddress && name === 'list_new_hooks') return logged(name, ctx, a, newHooks(overlay));

    const output = await real.callTool(name, args, ctx);
    if (name === 'get_portfolio' && scenario.prices)
      return logged(
        name,
        ctx,
        a,
        overlayPortfolio(overlay, output as UniswapMcp.ToolOutput<'get_portfolio'>),
      );
    if (name === 'compare_pools' && scenario.lp)
      return logged(
        name,
        ctx,
        a,
        overlayPools(overlay, output as UniswapMcp.ToolOutput<'compare_pools'>),
      );
    if (name === 'get_quote' || name === 'quote_pool')
      return { ...(output as object), simulationNote: QUOTE_NOTE };
    return output;
  };
  return { callTool: read as unknown as ReadClient['callTool'] };
}
