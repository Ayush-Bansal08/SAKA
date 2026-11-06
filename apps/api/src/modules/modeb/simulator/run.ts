/**
 * One simulator run: scenario event → the existing context reads → the existing 0G planner, reading
 * through the market overlay → the existing processEvent and pipeline with the REAL Uniswap client.
 * The scenario never supplies a decision. Runs live in Redis for the panel; the suggestion row,
 * plan and trace they point to are the durable record, tagged simulated.
 */
import { randomUUID } from 'node:crypto';
import {
  CHAINS,
  Decimal,
  DecisionDigestSchema,
  EXECUTION_CHAIN_IDS,
  riskProfileSettings,
  type ActionIntent,
  type DecisionDigest,
  type SimulatorDecision,
  type SimulatorMode,
  type SimulatorOutcome,
  type SimulatorRunView,
  type SimulatorScenarioId,
} from '@warden/shared';
import { AppError } from '../../../lib/errors.js';
import { ZgError } from '../../ai0g/client.js';
import { allowlistForPlanner, compactPortfolio, referencePrices } from '../../agent/context.js';
import type { PlannerContext } from '../../agent/context.js';
import { describeIntent } from '../../agent/describe.js';
import { plan, PlannerError, type PlanResult } from '../../agent/planner.js';
import { executionTokens } from '../../wallet/tokens.js';
import { STABLES } from '../detectors/util.js';
import { loadForUser } from '../runner.js';
import {
  closeSimulated,
  loadSuggestionView,
  processEvent,
  type ModeBDeps,
} from '../suggestions.js';
import type { DetectorEvent } from '../types.js';
import { buildOverlay, overlayAccount, overlayMcp, SIMULATION_NOTE } from './marketOverlay.js';
import { SCENARIOS } from './scenarios/index.js';
import type { AgentEvent, Scenario } from './types.js';

const RUN_TTL_S = 7 * 86_400;
const LOCK_TTL_S = 600;
/** A decision with its digest outgrows the chat deadline: measured over 12 s on GLM-5.3. */
const REASONING_TIMEOUT_MS = 60_000;
const MAX_RUNS = 20;

export const simulatorKeys = {
  run: (id: string) => `simulator:run:${id}`,
  runs: (userId: string) => `simulator:runs:${userId}`,
  lock: (userId: string) => `simulator:lock:${userId}`,
};

/** Guidance for the model and nothing more: the policy engine stays the enforcer. */
export const DECISION_PRINCIPLES = [
  'A price move is a trigger to analyse, never an automatic trade.',
  'Act on a downside move only when independent signals agree (volume, trend, liquidity, volatility), not on price alone.',
  'Buy after a decline only with evidence of stabilization or recovery.',
  'Any trade or LP migration must clear a threshold after gas, slippage, price impact and, for LP, impermanent-loss exposure.',
  'Size actions in capped tranches and state a cooldown before the next action on the same asset. Never deploy or exit everything in one step.',
  'De-risk only into approved stables; buy only approved tokens.',
  'LP rebalance, exit or migration needs an explicit LP mandate.',
  'A hook score is a risk indicator, not a security certification. Do not add deposits to a pool with a risky hook.',
  'Never claim to predict a specific price move or crash size.',
  'Check market-data timestamps: on stale data take no action and say why.',
  'Taking no action is always an acceptable, first-class outcome.',
];

/** These replace the prompt's rules for a human conversation, for this run only. */
const RUN_RULES = [
  'This is an autonomous run: no human is in this conversation and nobody can answer a question. Never set needsClarification.',
  'The market facts of the event in `simulation.event` are already in `simulation.market`. Decide from them when they are enough; call a read tool only for a specific fact they lack, in one round at most.',
  'To act, call `propose`. To take no action, call `answer`, with your reasoning as the text.',
  'Choose the size yourself. Unlike a human request, an autonomous action must fit the limits: stay at least 15% under limits.perActionUsd and limits.remainingTodayUsd, because it executes at the live testnet quote, not the scenario price.',
  'Only swaps between allowlisted tokens and LP actions on a listed position are possible here: no transfers, no triggers.',
  'Always pass `digest` with the terminal call: every signal you weighed in signalsChecked (supports ACT, HOLD or NEUTRAL), estimatedCosts, risks, alternativesConsidered, confidence from 0 to 1, and tranche when you act. Report only what you actually assessed.',
  'Keep the digest short: the 5 signals that weighed most, at most 3 risks and 2 alternatives, a few words each.',
];

const RUNNABLE: ReadonlySet<ActionIntent['type']> = new Set([
  'swap_exact_in',
  'swap_exact_out',
  'lp_open',
  'lp_rebalance',
  'lp_exit',
]);

/** Simulated events never write to mainnet, whatever the configuration says. */
export function assertSimulatedWriteChain(chainId: number): void {
  if (!(EXECUTION_CHAIN_IDS as readonly number[]).includes(chainId))
    throw new Error(`Safety block: a simulated event cannot write to chain ${chainId}.`);
}

export function buildSimulatedEvent(scenario: Scenario, runId: string, now: Date): AgentEvent {
  return {
    eventId: randomUUID(),
    eventType: scenario.eventType,
    timestamp: now.toISOString(),
    source: 'SIMULATED',
    subject: scenario.subject,
    payload: { change: scenario.eventLine },
    scenario: { id: scenario.id, label: scenario.label, runId },
  };
}

export function outcomeOf(intent: ActionIntent): SimulatorOutcome {
  switch (intent.type) {
    case 'swap_exact_in':
    case 'swap_exact_out': {
      const stable = (s: string | undefined) => STABLES.has(s?.toUpperCase() ?? '');
      if (stable(intent.tokenIn.symbol)) return 'BUY';
      return stable(intent.tokenOut.symbol) ? 'SELL' : 'SWAP';
    }
    case 'lp_rebalance':
      return 'MIGRATE_LP';
    case 'lp_open':
      return 'ADD_LIQUIDITY';
    case 'lp_exit':
      return 'REMOVE_LIQUIDITY';
    default:
      return 'OTHER_ACTION';
  }
}

function digestOf(value: unknown): DecisionDigest | null {
  const parsed = DecisionDigestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function decisionOf(result: PlanResult): SimulatorDecision {
  const base = { digest: digestOf(result.digest), zg: result.zg };
  // The model sometimes says "no action" through an `info` intent instead of `answer`.
  if (result.kind === 'intent' && result.intent.type === 'info')
    return { ...base, outcome: 'NO_ACTION', summary: null, rationale: result.intent.reason };
  if (result.kind === 'intent')
    return {
      ...base,
      outcome: outcomeOf(result.intent),
      summary: describeIntent(result.intent),
      rationale: result.intent.reason,
    };
  return {
    ...base,
    outcome: result.needsClarification ? 'NO_DECISION' : 'NO_ACTION',
    summary: null,
    rationale: result.text,
  };
}

export interface RunRecord extends Omit<SimulatorRunView, 'suggestion'> {
  userId: string;
  suggestionId: string | null;
}

const save = (deps: ModeBDeps, run: RunRecord) =>
  deps.redis.set(simulatorKeys.run(run.id), JSON.stringify(run), 'EX', RUN_TTL_S);

async function context(
  deps: ModeBDeps,
  run: RunRecord,
  scenario: Scenario,
  loaded: NonNullable<Awaited<ReturnType<typeof loadForUser>>>,
) {
  const { owner, portfolio, ctx } = loaded;
  const live = ctx.market.ethPriceUsd;
  if (!live) throw new Error('The live ETH price is unavailable, so no scenario can be derived.');
  const now = ctx.now;
  const overlay = buildOverlay(scenario, live, portfolio, now);
  const chainId = deps.env.EXECUTION_CHAIN_ID;
  const tokens = executionTokens(chainId, deps.env.TOKEN_ALLOWLIST_JSON);
  const prices = await referencePrices(tokens, (symbol) => deps.prices.usd(symbol));
  const context: PlannerContext = {
    chainId,
    chainName: CHAINS[chainId].name,
    wallet: owner.wallet.address,
    quoteSwapper: owner.wallet.address,
    riskProfile: owner.user.riskProfile,
    limits: {
      perActionUsd: portfolio.limits.perActionUsd,
      perDayUsd: portfolio.limits.perDayUsd,
      usedTodayUsd: portfolio.limits.usedTodayUsd,
      remainingTodayUsd: portfolio.limits.remainingTodayUsd,
      maxSlippagePct: riskProfileSettings(owner.user.riskProfile).maxSlippagePct,
    },
    ...overlayAccount(overlay, compactPortfolio(portfolio)!, prices),
    knownRecipients: [],
    activeTriggers: [],
    tokenAllowlist: allowlistForPlanner(tokens),
    simulation: {
      note: SIMULATION_NOTE,
      event: buildSimulatedEvent(scenario, run.id, now),
      market: overlay.snapshot,
      runRules: RUN_RULES,
      decisionPrinciples: DECISION_PRINCIPLES,
    },
  };
  return { context, overlay };
}

/** The decision as a detector event, so everything after it is the live path. */
function eventFor(
  scenario: Scenario,
  run: RunRecord,
  decision: SimulatorDecision,
  intent: ActionIntent | null,
): DetectorEvent {
  return {
    detector: scenario.detector,
    dedupeKey: `sim:${scenario.id}:${run.id.slice(0, 8)}`,
    severity: intent ? scenario.severity : 'INFO',
    title: decision.summary
      ? `${scenario.label}: ${decision.summary}`
      : `${scenario.label}: no action`,
    summary: intent ? `${scenario.eventLine}.` : `${scenario.eventLine}. ${decision.rationale}`,
    facts: { ...scenario.signals, simulated: true, scenario: scenario.id, runId: run.id },
    intent,
  };
}

/** Fills in how the run ended. A prepared plan never stays waiting for a yes. */
async function settle(
  deps: ModeBDeps,
  run: RunRecord,
  ctx: { userId: string; traceId: string },
  suggestionId: string,
  intent: ActionIntent,
): Promise<void> {
  const chainId = deps.env.EXECUTION_CHAIN_ID;
  const view = await loadSuggestionView(deps.prisma, chainId, suggestionId);
  const reasons = view.plan?.reasons ?? [];
  const blocking = reasons.filter((r) => r.code !== 'PROACTIVE_NEEDS_ACCEPTANCE');
  const text = blocking.map((r) => r.message.replace(/[.!?]+$/, '')).join('; ');

  if (view.status === 'OPEN') {
    if (run.mode === 'PAPER' && !blocking.length) {
      run.notice = 'Paper — not broadcast. It passed policy and the transaction simulation.';
    } else {
      run.rejected = true;
      run.notice = `Rejected: ${text || 'auto-act is off for this kind of action'}. Nothing was traded.`;
    }
    await closeSimulated(deps, suggestionId, run.notice);
    await deps.traceBus.emit({
      ...ctx,
      kind: 'policy',
      title: run.rejected ? 'Simulator: rejected, outside the mandate' : 'Paper: not broadcast',
      detail: run.notice,
      data: { suggestionId, actionPlanId: view.plan?.id ?? null },
    });
    return;
  }
  if (view.status === 'AUTO_EXECUTED') return;

  // The testnet could not build it: nothing can be broadcast, and the run says so.
  if (!view.plan || reasons.some((r) => r.code === 'BUILD_FAILED')) {
    run.effectiveMode = 'PAPER';
    run.notice = `The testnet could not run ${describeIntent(intent)}: this run fell back to Paper and nothing was broadcast. ${view.note ?? text}`;
    return;
  }
  run.rejected = true;
  run.notice = `Rejected: ${text}. Nothing was traded.`;
}

async function execute(deps: ModeBDeps, run: RunRecord, scenario: Scenario): Promise<void> {
  const ctx = { userId: run.userId, traceId: run.id };
  try {
    await deps.traceBus.emit({
      ...ctx,
      kind: 'detector',
      title: `Simulated event: ${scenario.label}`,
      detail: scenario.eventLine,
      data: { scenario: scenario.id, mode: run.mode, source: 'SIMULATED' },
    });
    if (!deps.zg) throw new ZgError('0G is not configured on this server.');
    const loaded = await loadForUser(deps, run.userId, scenario.detector);
    if (!loaded) throw new Error('This account has no agent wallet yet.');
    const { portfolio, owner } = loaded;
    const { context: plannerContext, overlay } = await context(deps, run, scenario, loaded);
    await deps.traceBus.emit({
      ...ctx,
      kind: 'system',
      title: 'Portfolio context loaded',
      detail: `Real balances, ${SIMULATION_NOTE.toLowerCase()}`,
      data: { simulated: true, market: overlay.snapshot },
    });

    const result = await plan(
      deps.zg,
      overlayMcp(overlay, deps.mcp, deps.traceBus),
      ctx,
      plannerContext,
      [{ role: 'user', content: 'A market event arrived. Investigate it and decide.' }],
      { digest: DecisionDigestSchema, timeoutMs: REASONING_TIMEOUT_MS },
    );
    const decision = decisionOf(result);
    run.decision = decision;
    await save(deps, run);
    await deps.traceBus.emit({
      ...ctx,
      kind: 'plan',
      title: `Decision: ${decision.summary ?? decision.outcome}`.slice(0, 200),
      detail: decision.rationale.slice(0, 3900),
      zg: result.zg,
      data: { outcome: decision.outcome, digest: decision.digest },
    });

    const proposed =
      result.kind === 'intent' && result.intent.type !== 'info' ? result.intent : null;
    const intent = proposed && RUNNABLE.has(proposed.type) ? proposed : null;
    if (proposed && !intent) {
      run.rejected = true;
      run.notice = `Rejected: a simulated run cannot perform ${proposed.type}. Nothing was traded.`;
      await deps.traceBus.emit({
        ...ctx,
        kind: 'policy',
        title: 'Simulator: rejected, outside the mandate',
        detail: run.notice,
      });
    }

    assertSimulatedWriteChain(deps.env.EXECUTION_CHAIN_ID);
    const processed = await processEvent(deps, owner, eventFor(scenario, run, decision, intent), {
      portfolioUsd: new Decimal(portfolio.totalUsd),
      simulated: true,
      silent: true,
      traceId: run.id,
      neverAuto: run.mode === 'PAPER',
      skipExplainer: true,
    });
    if (!processed) throw new Error('That event could not be recorded.');
    run.suggestionId = processed.suggestionId;
    if (intent) await settle(deps, run, ctx, processed.suggestionId, intent);
    run.status = 'DONE';
  } catch (err) {
    const known =
      err instanceof PlannerError || err instanceof ZgError
        ? `Reasoning failed: ${err.message}`
        : null;
    run.status = 'FAILED';
    run.error = (known ?? (err instanceof Error ? err.message : 'The run failed.')).slice(0, 500);
    deps.log?.warn({ runId: run.id, err: run.error }, 'simulator run failed');
    await deps.traceBus
      .emit({ ...ctx, kind: 'error', title: 'Simulator run failed', detail: run.error })
      .catch(() => undefined);
  } finally {
    // Runs in the background: a Redis failure here must not become an unhandled rejection.
    await save(deps, run)
      .then(() =>
        deps.redis.eval(
          "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
          1,
          simulatorKeys.lock(run.userId),
          run.id,
        ),
      )
      .catch((err: unknown) => {
        deps.log?.warn({ runId: run.id, err: String(err) }, 'simulator run not saved');
      });
  }
}

/** Claims the user's one run slot. `work` settles when the run has ended; it never rejects. */
export async function startRun(
  deps: ModeBDeps,
  userId: string,
  input: { scenarioId: SimulatorScenarioId; mode: SimulatorMode },
): Promise<{ run: RunRecord; work: Promise<void> }> {
  const scenario = SCENARIOS[input.scenarioId];
  const id = randomUUID();
  const lock = simulatorKeys.lock(userId);
  if (!(await deps.redis.set(lock, id, 'EX', LOCK_TTL_S, 'NX')))
    throw new AppError('CONFLICT', 409, 'A simulator run is already in progress. Please wait.');
  const run: RunRecord = {
    id,
    userId,
    scenarioId: scenario.id,
    label: scenario.label,
    mode: input.mode,
    effectiveMode: input.mode,
    status: 'RUNNING',
    event: scenario.eventLine,
    decision: null,
    rejected: false,
    notice: null,
    error: null,
    suggestionId: null,
    createdAt: new Date().toISOString(),
  };
  await save(deps, run);
  const list = simulatorKeys.runs(userId);
  await deps.redis
    .multi()
    .lpush(list, id)
    .ltrim(list, 0, MAX_RUNS - 1)
    .expire(list, RUN_TTL_S)
    .exec();
  return { run, work: execute(deps, run, scenario) };
}

async function viewOf(
  deps: Pick<ModeBDeps, 'prisma' | 'redis' | 'env'>,
  record: RunRecord,
): Promise<SimulatorRunView> {
  const { userId: _userId, suggestionId, ...run } = record;
  // The lock outlives a healthy run, so RUNNING without it means the process died mid-run.
  const lost =
    run.status === 'RUNNING' &&
    (await deps.redis.get(simulatorKeys.lock(record.userId))) !== run.id;
  return {
    ...run,
    ...(lost ? { status: 'FAILED', error: 'The run was interrupted before it finished.' } : {}),
    suggestion: suggestionId
      ? await loadSuggestionView(deps.prisma, deps.env.EXECUTION_CHAIN_ID, suggestionId).catch(
          () => null,
        )
      : null,
  };
}

export const runView = viewOf;

async function readRun(deps: Pick<ModeBDeps, 'redis'>, id: string): Promise<RunRecord | null> {
  const raw = await deps.redis.get(simulatorKeys.run(id));
  return raw ? (JSON.parse(raw) as RunRecord) : null;
}

export async function loadRun(
  deps: Pick<ModeBDeps, 'prisma' | 'redis' | 'env'>,
  userId: string,
  id: string,
): Promise<SimulatorRunView> {
  const run = await readRun(deps, id);
  if (!run || run.userId !== userId) throw AppError.notFound('Simulator run not found.');
  return viewOf(deps, run);
}

export async function listRuns(
  deps: Pick<ModeBDeps, 'prisma' | 'redis' | 'env'>,
  userId: string,
): Promise<SimulatorRunView[]> {
  const ids = await deps.redis.lrange(simulatorKeys.runs(userId), 0, MAX_RUNS - 1);
  const runs = await Promise.all(ids.map((id) => readRun(deps, id)));
  return Promise.all(runs.flatMap((r) => (r ? [viewOf(deps, r)] : [])));
}
