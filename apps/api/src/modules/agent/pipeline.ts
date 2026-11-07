/**
 * The one pipeline (PHASE_00 §4, PHASE 05 §7), shared by Mode A and Mode B:
 *   prepare → hook gate → token checks → trade score → simulate → 0G guard → policy
 *   → persist ActionPlan (+ Approval) → chat card.
 * AUTO plans are queued after a visible countdown (Cancel works until the job starts);
 * STEP_UP plans wait for the ApprovalProvider; REFUSE plans are logged to 0G Storage too.
 * Every stage emits a trace event the live panel shows.
 */
import type { AgentWallet, Prisma, PrismaClient, User } from '@prisma/client';
import {
  Decimal,
  riskProfileSettings,
  type ActionIntent,
  type ApprovalCard,
  type Card,
  type CardChecks,
  type HookBand,
  type PolicyOutcome,
  type PolicyReason,
  type PreviewCard,
  type PreviewStep,
  type RefusalCard,
  type ZgProvenance,
} from '@warden/shared';
import { getAddress } from 'viem';
import type { Env } from '../../config/env.js';
import type { ZgClient } from '../ai0g/client.js';
import { Explainer } from '../ai0g/explainer.js';
import type { ApprovalProvider } from '../approvals/approval-provider.js';
import type { ApprovalsService } from '../approvals/service.js';
import type { ChainClient } from '../execution/chain.js';
import type { JobQueues } from '../execution/jobs.js';
import { McpToolCallError, type UniswapMcpClient } from '../mcp/client.js';
import { decide } from '../policy/engine.js';
import { limitsUsage } from '../portfolio/service.js';
import type { PriceService } from '../portfolio/market.js';
import { guard, type GuardResult } from '../safety/guard.js';
import { gateHook, isHookAddress } from '../safety/hookGate.js';
import { simulateSteps } from '../safety/simulate.js';
import { tradeScore, type TokenCheckFact } from '../safety/tradeScore.js';
import type { TraceBus } from '../trace/trace-bus.js';
import { cancelTrigger, createTrigger } from '../triggers/service.js';
import { requestFor } from './describe.js';
import { prepare, PrepareError, type PreparedAction, type StoredSteps } from './preparer.js';

export interface PipelineDeps {
  env: Env;
  prisma: PrismaClient;
  mcp: UniswapMcpClient;
  prices: Pick<PriceService, 'usd'>;
  traceBus: Pick<TraceBus, 'emit'>;
  zg: ZgClient | null;
  chain: ChainClient | null;
  approvals: ApprovalsService;
  approvalProvider: Pick<ApprovalProvider, 'requestApproval' | 'kind'>;
  jobs: JobQueues;
  now?: () => Date;
}

export interface PipelineInput {
  ctx: { userId: string; traceId: string; agentRequestId: string };
  user: User;
  wallet: AgentWallet;
  intent: ActionIntent;
  origin: 'user' | 'proactive';
  channel: 'WEB' | 'TELEGRAM';
  portfolioUsd: Decimal | null;
  /** Mode B: false keeps a clean action waiting for the human's yes (auto-act off). */
  autoAllowed?: boolean;
  /** Planner provenance, shown on the card. */
  zg?: ZgProvenance;
}

export interface PipelineResult {
  text: string;
  cards: Card[];
  planId: string | null;
  outcome: PolicyOutcome | null;
  /** Run once the chat reply is stored (queues the AUTO job / the refusal log). */
  afterReply: () => Promise<void>;
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const usd2 = (d: Decimal | null) => (d ?? new Decimal(0)).toDecimalPlaces(2).toFixed(2);
const noop = async () => undefined;

const STEP_KIND: Record<string, PreviewStep['kind']> = {
  APPROVAL: 'approval',
  SWAP: 'swap',
  TRANSFER: 'transfer',
  LP_CREATE: 'lp_create',
  LP_DECREASE: 'lp_decrease',
  LP_CLAIM: 'lp_claim',
};

export function previewSteps(stored: StoredSteps): PreviewStep[] {
  const steps: PreviewStep[] = stored.steps.map((s) => ({
    label: s.description,
    kind: STEP_KIND[s.kind] ?? 'swap',
  }));
  if (stored.signature)
    steps.push({
      label:
        stored.signature.kind === 'PERMIT2'
          ? 'Sign a Permit2 permit (at execution, after approval)'
          : 'Sign the v4 batch permit (at execution)',
      kind: 'permit_sign',
    });
  if (stored.pendingMain)
    steps.push({
      label: stored.pendingMain.description,
      kind: STEP_KIND[stored.pendingMain.kind] ?? 'swap',
    });
  if (stored.next)
    steps.push({ label: 'Open the new position with the withdrawn tokens', kind: 'lp_create' });
  return steps;
}

/**
 * A corrected request for the refusal card's suggestion chip: half the size when the trade was
 * too big for the pool or too risky, the same request when a check was unavailable (retry).
 */
export function suggestedRequest(
  intent: ActionIntent,
  reasons: readonly PolicyReason[],
): string | null {
  const codes = new Set(reasons.map((r) => r.code));
  if (codes.has('UNSUPPORTED_TOKEN') || codes.has('DANGER_HOOK') || codes.has('BUILD_FAILED'))
    return null;
  if (codes.has('PRICE_IMPACT_TOO_HIGH') || codes.has('TRADE_SCORE_TOO_LOW'))
    return requestFor(intent, { halve: true });
  if (codes.has('GUARD_UNAVAILABLE') || codes.has('SIMULATION_UNAVAILABLE'))
    return requestFor(intent);
  return null;
}

/** What to try instead, by the first refusal reason. */
export function refusalSuggestion(reasons: readonly PolicyReason[]): string {
  const code = reasons[0]?.code;
  switch (code) {
    case 'PRICE_IMPACT_TOO_HIGH':
    case 'TRADE_SCORE_TOO_LOW':
      return 'Try a smaller amount, or a pair with deeper liquidity.';
    case 'UNSUPPORTED_TOKEN':
      return 'Stick to allowlisted tokens such as ETH and USDC.';
    case 'DANGER_HOOK':
      return 'Use the standard (hookless) pool for this pair instead.';
    case 'GUARD_UNAVAILABLE':
      return 'The 0G safety model could not be reached. Try again in a minute.';
    case 'SIMULATION_REVERTED':
      return 'Check that your agent wallet holds enough of the token plus gas.';
    case 'SIMULATION_UNAVAILABLE':
      return 'The execution RPC is not configured; nothing can be checked or sent.';
    case 'BUILD_FAILED':
      return 'Check the tokens and the amount, then ask again.';
    default:
      return 'Adjust the request and ask again.';
  }
}

async function checkTokens(
  deps: PipelineDeps,
  input: PipelineInput,
  tokens: readonly string[],
): Promise<TokenCheckFact[]> {
  const chainId = deps.env.EXECUTION_CHAIN_ID;
  return Promise.all(
    [...new Set(tokens)].map(async (token): Promise<TokenCheckFact> => {
      try {
        const r = await deps.mcp.callTool('check_token', { chainId, token }, input.ctx);
        return {
          symbol: r.symbol,
          address: r.address,
          isNative: r.isNative,
          onAllowlist: r.onAllowlist,
          onUniswapUnsupportedList: r.onUniswapUnsupportedList,
          liquidityDepthUsd: r.liquidityDepthUsd,
          verdict: r.verdict,
          riskFlags: r.riskFlags,
        };
      } catch (err) {
        // An unresolvable token is treated as unsupported (fail closed).
        const code = err instanceof McpToolCallError ? err.code : 'INTERNAL';
        return {
          symbol: token.startsWith('0x') ? null : token,
          address: token.startsWith('0x') ? token : '0x0000000000000000000000000000000000000000',
          isNative: false,
          onAllowlist: false,
          onUniswapUnsupportedList: null,
          liquidityDepthUsd: null,
          verdict: 'BLOCK',
          riskFlags: [code],
        };
      }
    }),
  );
}

/**
 * Rules (PHASE 07 §4): `create_trigger` stores the canonical spec ACTIVE (no money moves, no
 * step-up); `cancel_trigger` closes it. Every later fire runs through this pipeline again.
 */
async function triggerReply(
  deps: PipelineDeps,
  input: PipelineInput,
  prepared: Extract<Awaited<ReturnType<typeof prepare>>, { kind: 'trigger' }>,
  emit: (
    e: Omit<Parameters<PipelineDeps['traceBus']['emit']>[0], 'traceId' | 'userId'>,
  ) => Promise<unknown>,
  now: Date,
): Promise<PipelineResult> {
  const zg = input.zg ? { zg: input.zg } : {};
  const reply = (text: string, card: Card): PipelineResult => ({
    text,
    cards: [card],
    planId: null,
    outcome: null,
    afterReply: noop,
  });
  if (prepared.intent.type === 'cancel_trigger') {
    const ok = await cancelTrigger(deps.prisma, input.user.id, prepared.intent.triggerId);
    const body = ok
      ? 'Rule cancelled. It will not fire.'
      : 'That rule was not found or is already closed.';
    await emit({ kind: 'plan', title: ok ? 'Rule cancelled' : 'Rule not found', detail: body });
    return reply(body, {
      type: 'info',
      title: ok ? 'Rule cancelled' : 'Rule not found',
      body,
      ...zg,
    });
  }
  if (prepared.error || !prepared.plan) {
    const body = `I understood the rule but could not set it up: ${prepared.error ?? 'unknown error'}`;
    await emit({ kind: 'error', title: 'Rule not set', detail: body });
    return reply(body, { type: 'info', title: 'Rule not set', body, ...zg });
  }
  const trigger = await createTrigger(deps.prisma, {
    userId: input.user.id,
    timezone: input.user.timezone,
    rule: prepared.intent.rule,
    plan: prepared.plan,
    now,
  });
  const c = prepared.plan.spec.condition;
  await emit({
    kind: 'plan',
    title: 'Rule set',
    detail: prepared.plan.humanSummary,
    data: { triggerId: trigger.id, spec: prepared.plan.spec },
  });
  const body =
    c.type === 'schedule'
      ? `Next run ${trigger.nextRunAt?.toISOString() ?? 'soon'}. Each run goes through every safety check; anything over your limits asks you first.`
      : 'I check the price every 30 seconds. When it hits, the action goes through every safety check; anything over your limits asks you first.';
  return reply(`Rule set: ${prepared.plan.humanSummary}.`, {
    type: 'info',
    title: `Rule set: ${prepared.plan.humanSummary}`.slice(0, 200),
    body,
    data: {
      kind: 'trigger',
      triggerId: trigger.id,
      triggerKind: trigger.kind,
      summary: prepared.plan.humanSummary,
      symbol: c.symbol,
      targetPriceUsd: c.targetPriceUsd,
      nextRunAt: trigger.nextRunAt?.toISOString() ?? null,
      warnings: prepared.plan.warnings,
    },
    ...zg,
  });
}

export async function runPipeline(
  deps: PipelineDeps,
  input: PipelineInput,
): Promise<PipelineResult> {
  const { ctx, user, wallet, intent } = input;
  const emit = (e: Omit<Parameters<PipelineDeps['traceBus']['emit']>[0], 'traceId' | 'userId'>) =>
    deps.traceBus.emit({ ...e, traceId: ctx.traceId, userId: ctx.userId } as Parameters<
      PipelineDeps['traceBus']['emit']
    >[0]);
  const now = deps.now?.() ?? new Date();
  const limitsRow = await deps.prisma.limits.findUnique({ where: { userId: user.id } });
  const profile = riskProfileSettings(user.riskProfile);
  const maxSlippagePct = limitsRow
    ? Number(limitsRow.maxSlippagePct.toString())
    : profile.maxSlippagePct;

  // 1. Prepare --------------------------------------------------------------------
  let prepared;
  try {
    prepared = await prepare(
      {
        prisma: deps.prisma,
        mcp: deps.mcp,
        prices: deps.prices,
        chainId: deps.env.EXECUTION_CHAIN_ID,
        allowlist: deps.env.TOKEN_ALLOWLIST_JSON,
      },
      ctx,
      {
        userId: user.id,
        wallet: getAddress(wallet.address),
        maxSlippagePct,
        riskProfile: user.riskProfile,
      },
      intent,
    );
  } catch (err) {
    if (!(err instanceof PrepareError) && !(err instanceof McpToolCallError)) throw err;
    const message = err.message.slice(0, 300);
    await emit({ kind: 'error', title: 'Could not prepare this action', detail: message });
    const card: RefusalCard = {
      type: 'refusal',
      title: 'Not possible right now',
      summary: message,
      reasons: [{ code: 'BUILD_FAILED', message }],
      suggestion: refusalSuggestion([{ code: 'BUILD_FAILED', message }]),
      ...(input.zg ? { zg: input.zg } : {}),
    };
    return {
      text: `I could not prepare this: ${message}`,
      cards: [card],
      planId: null,
      outcome: null,
      afterReply: noop,
    };
  }

  if (prepared.kind === 'trigger') return triggerReply(deps, input, prepared, emit, now);

  const p: PreparedAction = prepared;
  const stored = p.stored;
  await emit({
    kind: 'plan',
    title: `Prepared: ${p.summary}`,
    detail: p.buildError
      ? `Uniswap could not build it (${p.buildError.code}): ${p.buildError.message}`
      : `${stored.steps.length} unsigned tx${stored.signature ? ' + 1 permit to sign at execution' : ''}${p.amountUsd ? ` · value $${usd2(p.amountUsd)}` : ''}`,
    data: {
      planHash: p.planHash,
      status: stored.status,
      amountUsd: p.amountUsd?.toString() ?? null,
    },
  });

  // 2. Score: hook gate + token checks -------------------------------------------
  let hook: { address: string; score: number; band: HookBand } | null = null;
  if (isHookAddress(stored.hookAddress)) {
    try {
      hook = await gateHook(
        { prisma: deps.prisma, mcp: deps.mcp },
        ctx,
        deps.env.EXECUTION_CHAIN_ID,
        stored.hookAddress,
      );
    } catch {
      // Unscorable hook → treated as Danger (fail closed).
      hook = { address: stored.hookAddress, score: 0, band: 'DANGER' };
    }
    await emit({
      kind: 'score',
      title: `Hook ${hook.band.toLowerCase()} · ${hook.score}/100`,
      data: { hook },
    });
  }
  const tokens = await checkTokens(deps, input, stored.tokenChecks);
  const score = tradeScore({
    priceImpactPct: stored.priceImpactPct,
    apiPriceImpactPct: stored.apiPriceImpactPct ?? null,
    amountUsd: p.amountUsd,
    portfolioUsd: input.portfolioUsd,
    tokens,
    gasUsd: stored.gasUsd ? new Decimal(stored.gasUsd) : null,
    hookScore: hook?.score ?? null,
    slippagePct: stored.slippagePct,
    maxSlippagePct,
  });
  stored.safety = {
    breakdown: score.breakdown,
    tokens,
    portfolioUsd: input.portfolioUsd?.toString() ?? null,
  };
  await emit({
    kind: 'score',
    title: `Trade safety score ${score.score}/100`,
    detail:
      score.breakdown
        .filter((b) => b.penalty !== 0)
        .map((b) => `${b.evidence} (${b.penalty})`)
        .join(' · ') || 'No penalties',
    data: { score: score.score, breakdown: score.breakdown },
  });

  // 3. Simulate -------------------------------------------------------------------
  const simulation = p.buildError
    ? null
    : await simulateSteps(deps.chain, getAddress(wallet.address), stored.steps);
  if (simulation) {
    const deferred = simulation.steps.filter((s) => s.deferred).length + (stored.signature ? 1 : 0);
    await emit({
      kind: 'simulation',
      title: simulation.ok
        ? 'Simulation passed'
        : simulation.unavailable
          ? 'Simulation unavailable'
          : 'Simulation failed',
      detail: simulation.ok
        ? `${simulation.steps.length - simulation.steps.filter((s) => s.deferred).length} step(s) simulated on the latest block${deferred ? `; ${deferred} re-simulated at execution` : ''}`
        : (simulation.error ?? 'reverted'),
      data: simulation,
    });
  }

  // 4. Guard (0G Vela, fail closed) ------------------------------------------------
  const usage = await limitsUsage(deps.prisma, user, now);
  const recipient = stored.recipient ? getAddress(stored.recipient) : null;
  const recipientKnown = recipient
    ? Boolean(
        await deps.prisma.knownRecipient.findUnique({
          where: { userId_address: { userId: user.id, address: recipient } },
        }),
      )
    : null;
  let guardResult: GuardResult | null = null;
  if (deps.zg && !p.buildError && simulation?.ok) {
    const s = stored.summary;
    guardResult = await guard(deps.zg, ctx, {
      intent,
      prepared: {
        amountUsd: p.amountUsd?.toString() ?? null,
        tokenIn: s?.tokenIn?.symbol ?? s?.lp?.token0.symbol ?? null,
        tokenOut: s?.tokenOut?.symbol ?? s?.lp?.token1.symbol ?? null,
        amountIn: s?.amountIn?.decimal ?? s?.lp?.amount0?.decimal ?? null,
        amountOut: s?.amountOut?.decimal ?? s?.lp?.amount1?.decimal ?? null,
        priceImpactPct: stored.priceImpactPct,
        slippagePct: stored.slippagePct,
        gasUsd: stored.gasUsd,
        route: s?.route ?? null,
        recipient,
      },
      tradeScore: {
        score: score.score,
        breakdown: score.breakdown.map((b) => ({ factor: b.rule, penalty: b.penalty })),
      },
      hook: hook ? { score: hook.score, band: hook.band } : null,
      simulation: {
        ok: simulation.ok,
        error: simulation.error ?? null,
        steps: simulation.steps.length,
      },
      limits: {
        riskProfile: user.riskProfile,
        perActionUsd: usage.perActionUsd,
        perDayUsd: usage.perDayUsd,
        todaySpendUsd: usage.usedTodayUsd,
        maxSlippagePct,
      },
      portfolioSharePct:
        p.amountUsd && input.portfolioUsd?.gt(0)
          ? p.amountUsd.div(input.portfolioUsd).times(100).toDecimalPlaces(1).toNumber()
          : null,
      recipientKnown,
      tokensAllowlisted: tokens.every((t) => t.onAllowlist),
    });
    await emit({
      kind: 'guard',
      title: guardResult.unavailable
        ? 'Safety check unavailable'
        : guardResult.verdict === 'approve'
          ? `Guard approved (p=${guardResult.pApprove.toFixed(2)})`
          : `Guard blocked (p=${guardResult.pApprove.toFixed(2)})`,
      detail: guardResult.reason,
      ...(guardResult.zg ? { zg: guardResult.zg } : {}),
      data: {
        verdict: guardResult.verdict,
        pApprove: guardResult.pApprove,
        concerns: guardResult.concerns,
      },
    });
  } else if (!deps.zg) {
    await emit({
      kind: 'guard',
      title: 'Safety check unavailable',
      detail: 'ZG_API_KEY is not configured — failing closed.',
    });
  }

  const deferredSteps =
    (simulation?.steps.filter((x) => x.deferred).length ?? 0) + (stored.signature ? 1 : 0);
  const checks: CardChecks = {
    breakdown: score.breakdown,
    simulation: simulation
      ? {
          ok: simulation.ok,
          ...(simulation.unavailable ? { unavailable: true } : {}),
          simulated: simulation.steps.filter((x) => !x.deferred).length,
          deferred: deferredSteps,
          ...(simulation.error ? { error: simulation.error.slice(0, 300) } : {}),
        }
      : null,
    guard: guardResult
      ? {
          verdict: guardResult.verdict,
          pApprove: Math.min(1, Math.max(0, guardResult.pApprove)),
          reason: guardResult.reason,
          unavailable: guardResult.unavailable,
          ...(guardResult.zg ? { zg: guardResult.zg } : {}),
        }
      : !deps.zg
        ? {
            verdict: 'block',
            pApprove: 0,
            reason: 'The 0G guard is not configured on this server.',
            unavailable: true,
          }
        : null,
  };

  // 5. Policy -------------------------------------------------------------------------
  const isSend = intent.type === 'transfer' || intent.type === 'swap_and_send';
  const decision = decide({
    origin: input.origin,
    ...(input.autoAllowed !== undefined ? { proactiveAutoAllowed: input.autoAllowed } : {}),
    leavingHookPool: intent.type === 'lp_exit' && hook !== null,
    buildError: p.buildError?.message ?? null,
    simulation,
    refuseFacts: score.refuse,
    hook: hook ? { band: hook.band, score: hook.score } : null,
    // The guard only runs once the facts are complete; with no simulation it cannot run at all,
    // and that path is already a refusal on its own.
    guard: guardResult
      ? {
          verdict: guardResult.verdict,
          unavailable: guardResult.unavailable,
          reason: guardResult.reason,
        }
      : simulation?.ok && !p.buildError
        ? null
        : { verdict: 'approve', unavailable: false, reason: 'not reached' },
    tradeScore: p.buildError ? null : score.score,
    priceImpactPct: stored.priceImpactPct,
    withdrawal: isSend && recipient !== null,
    recipient: recipient ? { address: recipient, known: recipientKnown === true } : null,
    amountUsd: p.amountUsd,
    todaySpendUsd: new Decimal(usage.usedTodayUsd),
    limits: {
      perActionUsd: limitsRow?.perActionUsd.toString() ?? profile.perActionUsd,
      perDayUsd: limitsRow?.perDayUsd.toString() ?? profile.perDayUsd,
      minTradeScoreAuto: limitsRow?.minTradeScoreAuto ?? profile.minTradeScoreAuto,
      hookPolicy: limitsRow?.hookPolicy ?? profile.hooksWithoutApproval,
    },
  });

  // 6. Persist ------------------------------------------------------------------------
  const planStatus = {
    AUTO: 'QUEUED',
    STEP_UP: 'AWAITING_APPROVAL',
    REFUSE: 'REFUSED',
    ASK: 'PREPARED',
  } as const;
  const requestStatus = {
    AUTO: 'QUEUED',
    STEP_UP: 'AWAITING_APPROVAL',
    REFUSE: 'REFUSED',
    ASK: 'PREPARED',
  } as const;
  const autoAt = new Date(now.getTime() + deps.env.AUTO_EXECUTE_DELAY_MS);
  const { plan, approval } = await deps.prisma.$transaction(async (tx) => {
    const plan = await tx.actionPlan.create({
      data: {
        agentRequestId: ctx.agentRequestId,
        userId: user.id,
        intent: json(intent),
        planHash: p.planHash,
        steps: json(stored),
        quote: p.quote ? json(p.quote) : undefined,
        amountUsd: usd2(p.amountUsd),
        tradeScore: p.buildError ? null : score.score,
        hookScore: hook?.score ?? null,
        hookAddress: hook?.address ?? null,
        simulation: simulation ? json(simulation) : undefined,
        guardVerdict: guardResult ? json(guardResult) : undefined,
        policyOutcome: decision.outcome,
        policyReasons: json(decision.reasons),
        status: planStatus[decision.outcome],
      },
    });
    await tx.agentRequest.update({
      where: { id: ctx.agentRequestId },
      data: { status: requestStatus[decision.outcome] },
    });
    const approval =
      decision.outcome === 'STEP_UP'
        ? await deps.approvals.create(tx, {
            planId: plan.id,
            userId: user.id,
            planHash: p.planHash,
            amountUsd: usd2(p.amountUsd),
            reasons: decision.reasons,
            channel: input.channel,
            providerKind: deps.approvalProvider.kind,
          })
        : null;
    return { plan, approval };
  });

  await emit({
    kind: 'policy',
    title:
      decision.outcome === 'AUTO'
        ? 'Policy: AUTO — your agent may do this alone'
        : decision.outcome === 'STEP_UP'
          ? 'Policy: needs your approval'
          : decision.outcome === 'REFUSE'
            ? 'Policy: refused'
            : 'Policy: suggestion — needs your yes',
    detail:
      decision.reasons.map((r) => r.message).join(' · ') ||
      'Within your limits and safety thresholds',
    data: { ...decision, actionPlanId: plan.id },
  });

  // 7. Card -----------------------------------------------------------------------------
  const steps = previewSteps(stored);
  const base = {
    actionPlanId: plan.id,
    title: p.summary.charAt(0).toUpperCase() + p.summary.slice(1),
    amountUsd: usd2(p.amountUsd),
    ...(recipient ? { recipient } : {}),
    ...(p.quote ? { quote: p.quote } : {}),
  };
  if (decision.outcome === 'REFUSE') {
    const facts = {
      action: intent.type,
      amountUsd: p.amountUsd?.toString() ?? null,
      tradeScore: p.buildError ? null : score.score,
      priceImpactPct: stored.priceImpactPct,
    };
    const messages = decision.reasons.map((r) => r.message);
    const explanation = deps.zg
      ? await new Explainer(deps.zg, ctx).explainRefusal(messages, facts)
      : `I did not do this because ${messages.join('; ')}.`;
    const card: RefusalCard = {
      type: 'refusal',
      actionPlanId: plan.id,
      title: `Refused: ${p.summary}`,
      summary: explanation,
      reasons: decision.reasons,
      ...(p.buildError ? {} : { tradeScore: score.score }),
      suggestion: refusalSuggestion(decision.reasons),
      ...(() => {
        const r = suggestedRequest(intent, decision.reasons);
        return r ? { suggestedRequest: r } : {};
      })(),
      ...(p.quote ? { quote: p.quote } : {}),
      checks,
      decisionLog: { status: 'PENDING' },
      ...(input.zg ? { zg: input.zg } : {}),
    };
    return {
      text: `I did not do this: ${decision.reasons[0]!.message.replace(/[.!?]+$/, '')}.`,
      cards: [card],
      planId: plan.id,
      outcome: 'REFUSE',
      afterReply: () => deps.jobs.enqueueDecisionLog(plan.id),
    };
  }

  if (decision.outcome === 'STEP_UP' && approval) {
    const view = await deps.approvalProvider.requestApproval(
      approval.id,
      input.channel === 'TELEGRAM' ? 'telegram' : 'web',
    );
    await emit({
      kind: 'approval',
      title: 'Waiting for your approval',
      detail: `${approval.reason}. Expires ${approval.expiresAt.toISOString()}.`,
      data: {
        approvalId: approval.id,
        providerKind: view.providerKind,
        verificationUrl: view.verificationUrl ?? null,
      },
    });
    const card: ApprovalCard = {
      type: 'approval',
      approvalId: approval.id,
      ...base,
      summary: p.summary,
      reason: approval.reason,
      reasons: decision.reasons,
      ...(p.buildError ? {} : { tradeScore: score.score }),
      status: 'PENDING',
      channel: approval.channel,
      providerKind: approval.providerKind,
      expiresAt: approval.expiresAt.toISOString(),
      ...(hook
        ? { hook: { address: getAddress(hook.address), score: hook.score, band: hook.band } }
        : {}),
      checks,
      ...(input.zg ? { zg: input.zg } : {}),
    };
    return {
      text: `This needs your approval: ${approval.reason}.`,
      cards: [card],
      planId: plan.id,
      outcome: 'STEP_UP',
      afterReply: noop,
    };
  }

  const preview: PreviewCard = {
    type: 'preview',
    ...base,
    status: planStatus[decision.outcome],
    ...(decision.outcome === 'AUTO' ? { autoExecuteAt: autoAt.toISOString() } : {}),
    summary:
      decision.outcome === 'AUTO'
        ? `Within your limits and safety checks — your agent will do this in ${Math.round(deps.env.AUTO_EXECUTE_DELAY_MS / 1000)} s.`
        : 'Your agent suggests this. Nothing runs until you say yes.',
    steps,
    tradeScore: score.score,
    ...(hook
      ? { hook: { address: getAddress(hook.address), score: hook.score, band: hook.band } }
      : {}),
    policyOutcome: decision.outcome,
    policyReasons: decision.reasons,
    checks,
    ...(input.zg ? { zg: input.zg } : {}),
  };
  return {
    text:
      decision.outcome === 'AUTO'
        ? `Agent will do this: ${p.summary}.`
        : `Suggestion: ${p.summary}.`,
    cards: [preview],
    planId: plan.id,
    outcome: decision.outcome,
    afterReply:
      decision.outcome === 'AUTO'
        ? () => deps.jobs.enqueueExecution(plan.id, { delayMs: deps.env.AUTO_EXECUTE_DELAY_MS })
        : noop,
  };
}
