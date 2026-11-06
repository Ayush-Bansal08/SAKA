/**
 * Suggestion lifecycle (PHASE 08 §1). A detector event becomes a Suggestion row, gets a 0G message
 * and, when it proposes an action, runs the one pipeline:
 *   AUTO        (under limits, safe, auto-act on)  → executes; AUTO_EXECUTED; receipt follows
 *   ASK                                            → OPEN with the prepared plan; [Yes][Change][No]
 *   REFUSE / could not prepare                     → INFO with the reason; nothing can run
 * "Yes" re-quotes (a move over 1% closes the plan) and asks the policy again with the human's
 * acceptance: AUTO queues the same plan, STEP_UP opens an approval, REFUSE closes it.
 * "No" and "Change" close the plan. Plans expire after 15 minutes. Every transition is an atomic
 * compare-and-set on the row, so web and Telegram can race safely, and every closed plan is
 * logged to 0G Storage like any other decision.
 */
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type {
  ActionPlan,
  AgentWallet,
  Approval,
  Execution,
  Inference,
  PrismaClient,
  Suggestion,
  User,
} from '@prisma/client';
import {
  ActionIntentSchema,
  autoActSettings,
  Decimal,
  explorerTxUrl,
  hookBand,
  MODE_B,
  riskProfileSettings,
  type ExecutionChainId,
  type HookBand,
  type PlanStatus,
  type PolicyReason,
  type SuggestionActionResponse,
  type SuggestionApprover,
  type SuggestionCard,
  type SuggestionResult,
  type SuggestionsResponse,
  type SuggestionStatus,
  type SuggestionView,
  type ZgProvenance,
  type AutoActDetector,
  AUTO_ACT_DETECTORS,
} from '@warden/shared';
import { getAddress } from 'viem';
import type { Redis } from 'ioredis';
import { AppError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { patchPlanCards, postPlanMessage, setPreviewStatus } from '../agent/card-store.js';
import { describeIntent, requestFor } from '../agent/describe.js';
import { runPipeline, refusalSuggestion, type PipelineDeps } from '../agent/pipeline.js';
import type { StoredSteps } from '../agent/preparer.js';
import {
  Explainer,
  morningBriefTemplate,
  suggestionTemplate,
  type MorningBriefData,
} from '../ai0g/explainer.js';
import type { ApprovalOutcome } from '../approvals/service.js';
import { requoteBeforeAccept, type ExecuteOutcome } from '../execution/executor.js';
import { decide } from '../policy/engine.js';
import { limitsUsage } from '../portfolio/service.js';
import type { BalanceReader, PriceService } from '../portfolio/market.js';
import { isHookAddress } from '../safety/hookGate.js';
import type { Notifications } from '../telegram/notifications.js';
import type { DetectorEvent } from './types.js';

export interface ModeBDeps extends PipelineDeps {
  redis: Redis;
  prices: PriceService;
  balances: BalanceReader;
  notifications: Notifications;
  log?: Pick<Logger, 'warn' | 'info'>;
}

type NotifyDeps = Pick<ModeBDeps, 'prisma' | 'notifications'>;

export type SuggestionRow = Suggestion & {
  actionPlan: (ActionPlan & { approval: Approval | null; executions: Execution[] }) | null;
};

const INCLUDE = {
  actionPlan: { include: { approval: true, executions: { orderBy: { stepIndex: 'asc' } } } },
} as const;

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const usd2 = (d: Decimal.Value) => new Decimal(d).toDecimalPlaces(2).toFixed(2);
const nowOf = (deps: Pick<PipelineDeps, 'now'>) => deps.now?.() ?? new Date();

const NOTES = {
  editing: 'You are editing this in the chat.',
  declined: 'You said no. Nothing was traded.',
  expired: 'This suggestion expired. Nothing was traded.',
  executed: 'Done.',
  failed: 'It failed. Nothing further was sent.',
  priceMoved: 'The price moved more than 1%. Nothing was traded.',
  cancelled: 'Cancelled. Nothing was traded.',
  needsApproval: 'Waiting for your approval.',
  approvalDenied: 'You denied the approval. Nothing was traded.',
  approvalExpired: 'The approval expired. Nothing was traded.',
  approvalRejected: 'That approval came from a different human. Nothing was traded.',
  approved: 'Approved. Your agent is executing it.',
} as const;

// --- Views ------------------------------------------------------------------------------------

function approverOf(plan: Pick<ActionPlan, 'policyOutcome' | 'policyReasons'>): SuggestionApprover {
  if (plan.policyOutcome === 'AUTO') return 'agent';
  if (plan.policyOutcome === 'STEP_UP') return 'verified_human';
  const reasons = (plan.policyReasons ?? []) as PolicyReason[];
  return reasons.some((r) => r.code !== 'PROACTIVE_NEEDS_ACCEPTANCE') ? 'verified_human' : 'you';
}

function actionsOf(row: Suggestion): SuggestionView['actions'] {
  if (row.status === 'OPEN' && row.actionPlanId)
    return row.prefill ? ['yes', 'change', 'no'] : ['yes', 'no'];
  return row.status === 'INFO' && row.prefill ? ['change'] : [];
}

function provenance(i: Inference | undefined): ZgProvenance | null {
  if (!i?.zgRequestId) return null;
  return {
    requestId: i.zgRequestId,
    clientRequestId: i.clientRequestId,
    model: i.model,
    trustMode: i.trustMode as ZgProvenance['trustMode'],
    ...(i.teeVerified !== null ? { teeVerified: i.teeVerified } : {}),
    ...(i.providerIdentity ? { provider: i.providerIdentity } : {}),
  };
}

function viewOf(row: SuggestionRow, chainId: number, inference?: Inference): SuggestionView {
  const plan = row.actionPlan;
  const parsed = plan ? ActionIntentSchema.safeParse(plan.intent) : null;
  const hash = plan?.executions.filter((e) => e.txHash).at(-1)?.txHash ?? null;
  return {
    id: row.id,
    detector: row.detector,
    severity: row.severity,
    status: row.status,
    title: row.title,
    message: row.message,
    note: row.note,
    simulated: row.simulated,
    plan: plan
      ? {
          id: plan.id,
          summary: parsed?.success ? describeIntent(parsed.data) : 'Agent action',
          status: plan.status as PlanStatus,
          policyOutcome: plan.policyOutcome,
          amountUsd: usd2(plan.amountUsd.toString()),
          tradeScore: plan.tradeScore,
          hookScore: plan.hookScore,
          approver: approverOf(plan),
          reasons: (plan.policyReasons ?? []) as PolicyReason[],
          approvalId: plan.approval?.status === 'PENDING' ? plan.approval.id : null,
          tx: hash
            ? { hash, explorerUrl: explorerTxUrl(chainId as ExecutionChainId, hash) ?? null }
            : null,
        }
      : null,
    prefill: row.prefill,
    actions: actionsOf(row),
    expiresAt: row.status === 'OPEN' ? (row.expiresAt?.toISOString() ?? null) : null,
    createdAt: row.createdAt.toISOString(),
    zg: provenance(inference),
  };
}

export async function suggestionViews(
  prisma: PrismaClient,
  chainId: number,
  rows: SuggestionRow[],
): Promise<SuggestionView[]> {
  const ids = rows.map((r) => r.inferenceId).filter((id): id is string => Boolean(id));
  const inferences = ids.length
    ? await prisma.inference.findMany({ where: { id: { in: ids } } })
    : [];
  const byId = new Map(inferences.map((i) => [i.id, i]));
  return rows.map((r) => viewOf(r, chainId, r.inferenceId ? byId.get(r.inferenceId) : undefined));
}

export async function loadSuggestionView(
  prisma: PrismaClient,
  chainId: number,
  id: string,
): Promise<SuggestionView> {
  const row = await prisma.suggestion.findUniqueOrThrow({ where: { id }, include: INCLUDE });
  return (await suggestionViews(prisma, chainId, [row]))[0]!;
}

/** Inbox: the latest brief pinned, then the suggestions, newest first. */
export async function listSuggestions(
  prisma: PrismaClient,
  chainId: number,
  userId: string,
  now: Date,
): Promise<SuggestionsResponse> {
  const [brief, rows, openCount] = await Promise.all([
    prisma.suggestion.findFirst({
      where: {
        userId,
        detector: 'MORNING_BRIEF',
        createdAt: { gte: new Date(now.getTime() - 24 * 3_600_000) },
      },
      orderBy: { createdAt: 'desc' },
      include: INCLUDE,
    }),
    prisma.suggestion.findMany({
      where: { userId, detector: { not: 'MORNING_BRIEF' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
      include: INCLUDE,
    }),
    prisma.suggestion.count({
      where: { userId, status: 'OPEN', actionPlanId: { not: null }, expiresAt: { gt: now } },
    }),
  ]);
  const views = await suggestionViews(prisma, chainId, brief ? [brief, ...rows] : rows);
  return {
    brief: brief ? views[0]! : null,
    suggestions: brief ? views.slice(1) : views,
    openCount,
  };
}

// --- Creating ---------------------------------------------------------------------------------

export interface ProcessOptions {
  portfolioUsd: Decimal | null;
  /** Injected by the demo endpoint: tagged, and never blocked by dedupe. */
  simulated?: boolean;
  /** A morning brief run on demand gets its own row. */
  fresh?: boolean;
  brief?: MorningBriefData;
  /** Simulator: the run's own trace, so reasoning and execution read as one timeline. */
  traceId?: string;
  /** Simulator paper mode: nothing may run alone, so no plan can reach the execution queue. */
  neverAuto?: boolean;
  /** Simulator: no "new suggestion" push; the presenter is watching the run. */
  silent?: boolean;
  /** Simulator: the planner already wrote the reasoning, so the template is enough here. */
  skipExplainer?: boolean;
}

export interface ProcessResult {
  suggestionId: string;
  status: SuggestionStatus;
  planId: string | null;
}

const isUnique = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** Hook pools are never rebalanced or exited alone (PHASE 08 §1). */
async function autoAllowedFor(
  deps: Pick<PipelineDeps, 'prisma'>,
  user: User,
  event: DetectorEvent,
): Promise<boolean> {
  // A big drop buys under the same switch as a dip.
  const switchName = event.detector === 'BIG_MOVE' ? 'DIP' : event.detector;
  if (!(AUTO_ACT_DETECTORS as readonly string[]).includes(switchName)) return false;
  if (!autoActSettings(user.autoAct)[switchName as AutoActDetector]) return false;
  const intent = event.intent;
  if (intent?.type !== 'lp_rebalance' && intent?.type !== 'lp_exit') return true;
  const position = await deps.prisma.lpPosition.findFirst({
    where: { id: intent.positionId, userId: user.id },
    select: { hookAddress: true },
  });
  const target = intent.type === 'lp_rebalance' ? intent.targetPool?.hookAddress : undefined;
  return !isHookAddress(position?.hookAddress ?? null) && !isHookAddress(target ?? null);
}

function suggestionCard(row: Suggestion, amountUsd: string | null, zg: ZgProvenance | null) {
  const card: SuggestionCard = {
    type: 'suggestion',
    suggestionId: row.id,
    detector: row.detector,
    severity: row.severity,
    title: row.title,
    message: row.message,
    actions: actionsOf(row),
    status: row.status,
    simulated: row.simulated,
    ...(row.actionPlanId ? { actionPlanId: row.actionPlanId } : {}),
    ...(amountUsd ? { amountUsd } : {}),
    ...(row.prefill ? { prefill: row.prefill } : {}),
    ...(zg ? { zg } : {}),
  };
  return card;
}

export async function processEvent(
  deps: ModeBDeps,
  owner: { user: User; wallet: AgentWallet },
  event: DetectorEvent,
  opts: ProcessOptions,
): Promise<ProcessResult | null> {
  const { user, wallet } = owner;
  const now = nowOf(deps);
  const traceId = opts.traceId ?? randomUUID();
  const unique = opts.simulated || opts.fresh;
  const prefill = event.prefill ?? (event.intent ? requestFor(event.intent) : null);

  // The unique (userId, dedupeKey) row is the claim: one per window, even across processes.
  let row: Suggestion;
  try {
    row = await deps.prisma.suggestion.create({
      data: {
        userId: user.id,
        detector: event.detector,
        dedupeKey: unique ? `${event.dedupeKey}:${traceId.slice(0, 8)}` : event.dedupeKey,
        severity: event.severity,
        title: event.title.slice(0, 200),
        message: event.summary,
        status: event.intent ? 'OPEN' : 'INFO',
        event: json({ facts: event.facts, summary: event.summary }),
        prefill,
        traceId,
        simulated: opts.simulated === true,
        expiresAt: event.intent ? new Date(now.getTime() + MODE_B.suggestionTtlMs) : null,
      },
    });
  } catch (err) {
    if (isUnique(err)) return null;
    throw err;
  }

  const request = await deps.prisma.agentRequest.create({
    data: {
      userId: user.id,
      channel: 'DETECTOR',
      input: json({
        text: `Proactive: ${event.title}`.slice(0, 500),
        event: {
          detector: event.detector,
          dedupeKey: row.dedupeKey,
          facts: event.facts,
          simulated: row.simulated,
          suggestionId: row.id,
        },
      }),
      traceId,
      status: 'PLANNING',
    },
  });
  const ctx = { userId: user.id, traceId, agentRequestId: request.id };
  await deps.traceBus.emit({
    ...ctx,
    kind: 'detector',
    title: `${row.simulated ? 'Simulated: ' : ''}${event.title}`.slice(0, 200),
    detail: event.summary,
    data: { suggestionId: row.id, detector: event.detector, severity: event.severity },
  });

  // 0GM writes the words; a failure falls back to the same facts as a template.
  const explainer = deps.zg && !opts.skipExplainer ? new Explainer(deps.zg, ctx) : null;
  const eventSummary = { kind: event.detector, summary: event.summary, facts: event.facts };
  const explained =
    event.detector === 'MORNING_BRIEF' && opts.brief
      ? explainer
        ? await explainer.morningBriefDetailed(opts.brief)
        : null
      : explainer
        ? await explainer.explainSuggestionDetailed(eventSummary, event.intent)
        : null;
  const message =
    explained?.text ??
    (event.detector === 'MORNING_BRIEF' && opts.brief
      ? morningBriefTemplate(opts.brief)
      : suggestionTemplate(eventSummary, event.intent));

  // The one pipeline, for anything that moves money.
  let status: SuggestionStatus = row.status;
  let note: string | null = null;
  let planId: string | null = null;
  let cards: Awaited<ReturnType<typeof runPipeline>>['cards'] = [];
  let afterReply: () => Promise<void> = async () => undefined;
  if (event.intent) {
    try {
      const result = await runPipeline(deps, {
        ctx,
        user,
        wallet,
        intent: event.intent,
        origin: 'proactive',
        channel: 'WEB',
        portfolioUsd: opts.portfolioUsd,
        autoAllowed: opts.neverAuto ? false : await autoAllowedFor(deps, user, event),
      });
      planId = result.planId;
      cards = result.cards;
      afterReply = result.afterReply;
      if (result.outcome === 'AUTO') {
        status = 'AUTO_EXECUTED';
        note = 'Within your limits: your agent is doing this now.';
      } else if (result.outcome === 'ASK') status = 'OPEN';
      else {
        status = 'INFO';
        note = result.text;
      }
    } catch (err) {
      deps.log?.warn(
        { suggestionId: row.id, err: err instanceof Error ? err.message.slice(0, 200) : err },
        'suggestion pipeline failed',
      );
      status = 'INFO';
      note = 'I could not prepare this right now. Nothing was traded.';
      await deps.traceBus.emit({ ...ctx, kind: 'error', title: 'Suggestion failed', detail: note });
    }
  }
  if (!planId) {
    await deps.prisma.agentRequest.update({
      where: { id: request.id },
      data: { status: event.intent ? 'FAILED' : 'DONE' },
    });
  }

  const updated = await deps.prisma.suggestion.update({
    where: { id: row.id },
    data: {
      // The model writes before the policy decides: an action already running is not a proposal.
      message: status === 'AUTO_EXECUTED' ? event.summary : message,
      status,
      note,
      actionPlanId: planId,
      inferenceId: explained?.inferenceId ?? null,
      ...(status === 'OPEN' ? {} : { expiresAt: null }),
    },
  });
  const plan = planId
    ? await deps.prisma.actionPlan.findUnique({
        where: { id: planId },
        select: { amountUsd: true },
      })
    : null;
  const inference = explained?.inferenceId
    ? await deps.prisma.inference.findUnique({ where: { id: explained.inferenceId } })
    : null;
  await deps.prisma.chatMessage.create({
    data: {
      userId: user.id,
      role: 'AGENT',
      text: `${event.title}. ${note ?? ''}`.trim().slice(0, 1000),
      cards: json([
        suggestionCard(
          updated,
          plan ? usd2(plan.amountUsd.toString()) : null,
          provenance(inference ?? undefined),
        ),
        ...cards,
      ]),
      traceId,
      requestId: request.id,
    },
  });
  await afterReply();
  if (!opts.silent) await deps.notifications.enqueue({ kind: 'suggestion', suggestionId: row.id });
  return { suggestionId: row.id, status, planId };
}

// --- Closing ----------------------------------------------------------------------------------

async function syncCard(prisma: PrismaClient, row: Suggestion) {
  if (!row.actionPlanId) return;
  await patchPlanCards(prisma, row.actionPlanId, (c) =>
    c.type === 'suggestion'
      ? {
          ...c,
          status: row.status,
          actions: actionsOf(row),
          title: row.title,
          message: row.message,
        }
      : null,
  );
}

/** Compare-and-set out of OPEN. False = someone else (web, Telegram, the sweeper) got there first. */
async function claim(
  prisma: PrismaClient,
  id: string,
  status: SuggestionStatus,
  note: string | null,
): Promise<boolean> {
  const res = await prisma.suggestion.updateMany({
    where: { id, status: 'OPEN' },
    data: { status, note, expiresAt: null },
  });
  return res.count === 1;
}

/** A plan that will never run: close it and log why (the proof the agent did not act). */
async function closePlan(
  deps: Pick<ModeBDeps, 'prisma' | 'jobs'>,
  planId: string,
  status: 'CANCELLED' | 'EXPIRED',
): Promise<void> {
  const res = await deps.prisma.actionPlan.updateMany({
    where: { id: planId, status: 'PREPARED' },
    data: { status },
  });
  if (res.count !== 1) return;
  await deps.prisma.agentRequest.updateMany({
    where: { actionPlans: { some: { id: planId } } },
    data: { status: 'CANCELLED' },
  });
  await setPreviewStatus(deps.prisma, planId, status);
  await deps.jobs.enqueueDecisionLog(planId);
}

async function loadOwned(prisma: PrismaClient, id: string, userId: string): Promise<SuggestionRow> {
  const row = await prisma.suggestion.findFirst({ where: { id, userId }, include: INCLUDE });
  if (!row) throw AppError.notFound('Suggestion not found.');
  return row;
}

const closedError = (status: SuggestionStatus) =>
  new AppError('CONFLICT', 409, `This suggestion is already ${status.toLowerCase()}.`);

async function respond(
  deps: Pick<ModeBDeps, 'prisma' | 'env'>,
  id: string,
  result: SuggestionResult,
  message: string,
  extra: { approvalId?: string; prefill?: string | null } = {},
): Promise<SuggestionActionResponse> {
  return {
    result,
    message,
    approvalId: extra.approvalId ?? null,
    prefill: extra.prefill ?? null,
    suggestion: await loadSuggestionView(deps.prisma, deps.env.EXECUTION_CHAIN_ID, id),
  };
}

async function expire(deps: ModeBDeps, row: Suggestion): Promise<boolean> {
  if (!(await claim(deps.prisma, row.id, 'EXPIRED', NOTES.expired))) return false;
  if (row.actionPlanId) await closePlan(deps, row.actionPlanId, 'EXPIRED');
  await syncCard(deps.prisma, { ...row, status: 'EXPIRED' });
  await deps.traceBus.emit({
    traceId: row.traceId ?? randomUUID(),
    userId: row.userId,
    kind: 'detector',
    title: 'Suggestion expired',
    detail: `${row.title}. ${NOTES.expired}`,
    data: { suggestionId: row.id },
  });
  await deps.notifications.enqueue({ kind: 'outcome', suggestionId: row.id });
  return true;
}

/** OPEN suggestions past their 15 minutes → EXPIRED. Runs at the start of every tick. */
export async function sweepExpiredSuggestions(deps: ModeBDeps): Promise<number> {
  const due = await deps.prisma.suggestion.findMany({
    where: { status: 'OPEN', expiresAt: { lte: nowOf(deps) } },
    take: 200,
  });
  let expired = 0;
  for (const row of due) if (await expire(deps, row)) expired += 1;
  return expired;
}

/**
 * Simulator: a prepared plan that must not wait for a yes (paper run, or outside the mandate). It
 * closes as information, so the inbox offers nothing that could still run it.
 */
export async function closeSimulated(deps: ModeBDeps, id: string, note: string): Promise<void> {
  const row = await deps.prisma.suggestion.findUniqueOrThrow({ where: { id } });
  if (!(await claim(deps.prisma, id, 'INFO', note))) return;
  if (row.actionPlanId) await closePlan(deps, row.actionPlanId, 'CANCELLED');
  await syncCard(deps.prisma, { ...row, status: 'INFO', note });
}

export async function declineSuggestion(
  deps: ModeBDeps,
  id: string,
  userId: string,
): Promise<SuggestionActionResponse> {
  const row = await loadOwned(deps.prisma, id, userId);
  if (!(await claim(deps.prisma, row.id, 'DECLINED', NOTES.declined)))
    throw closedError(row.status === 'OPEN' ? 'DECLINED' : row.status);
  if (row.actionPlanId) await closePlan(deps, row.actionPlanId, 'CANCELLED');
  await syncCard(deps.prisma, { ...row, status: 'DECLINED' });
  await deps.traceBus.emit({
    traceId: row.traceId ?? randomUUID(),
    userId,
    kind: 'policy',
    title: 'Declined by you',
    detail: `${row.title}. Nothing was traded.`,
    data: { suggestionId: row.id, actionPlanId: row.actionPlanId },
  });
  await deps.notifications.enqueue({ kind: 'outcome', suggestionId: row.id });
  return respond(deps, id, 'DECLINED', NOTES.declined);
}

/** The deep link "Change" continues at: the chat, pre-filled (PHASE 08 §1). */
export function changeLink(webUrl: string, id: string, prefill: string): string {
  return `${webUrl}/?prefill=${encodeURIComponent(prefill)}&suggestion=${encodeURIComponent(id)}`;
}

export async function changeSuggestion(
  deps: ModeBDeps,
  id: string,
  userId: string,
): Promise<SuggestionActionResponse> {
  const row = await loadOwned(deps.prisma, id, userId);
  if (!row.prefill) throw new AppError('CONFLICT', 409, 'There is nothing to edit here.');
  if (row.status === 'OPEN') {
    if (!(await claim(deps.prisma, row.id, 'DECLINED', NOTES.editing)))
      throw closedError('DECLINED');
    // The human writes a new request: the prepared plan must not stay runnable.
    if (row.actionPlanId) await closePlan(deps, row.actionPlanId, 'CANCELLED');
    await syncCard(deps.prisma, { ...row, status: 'DECLINED' });
  } else if (row.status !== 'INFO') {
    throw closedError(row.status);
  }
  await deps.notifications.enqueue({
    kind: 'outcome',
    suggestionId: row.id,
    link: { label: 'Open in the app', url: changeLink(deps.env.WEB_URL, row.id, row.prefill) },
  });
  return respond(deps, id, 'CHANGED', NOTES.editing, { prefill: row.prefill });
}

// --- Accepting --------------------------------------------------------------------------------

/**
 * The policy again, on the facts persisted with the plan, the current limits and hook band, and
 * the human's yes. A hook that went bad since the preview refuses here.
 */
async function decideAtAccept(
  deps: ModeBDeps,
  user: User,
  plan: ActionPlan,
): Promise<ReturnType<typeof decide>> {
  const now = nowOf(deps);
  const stored = plan.steps as unknown as StoredSteps;
  const intent = ActionIntentSchema.parse(plan.intent);
  const [limitsRow, usage, hookRow] = await Promise.all([
    deps.prisma.limits.findUnique({ where: { userId: user.id } }),
    limitsUsage(deps.prisma, user, now),
    plan.hookAddress
      ? deps.prisma.hook.findUnique({
          where: {
            chainId_address: {
              chainId: deps.env.EXECUTION_CHAIN_ID,
              address: getAddress(plan.hookAddress),
            },
          },
          select: { band: true, score: true },
        })
      : null,
  ]);
  const profile = riskProfileSettings(user.riskProfile);
  const guard = plan.guardVerdict as {
    verdict: 'approve' | 'block';
    unavailable: boolean;
    reason: string;
  } | null;
  const hook: { band: HookBand; score: number } | null = plan.hookAddress
    ? (hookRow ?? {
        band: hookBand(plan.hookScore ?? 0),
        score: plan.hookScore ?? 0,
      })
    : null;
  return decide({
    origin: 'proactive',
    proactiveAccepted: true,
    leavingHookPool: intent.type === 'lp_exit' && hook !== null,
    simulation: plan.simulation as { ok: boolean; unavailable?: boolean; error?: string } | null,
    refuseFacts: [],
    hook,
    guard: guard
      ? { verdict: guard.verdict, unavailable: guard.unavailable, reason: guard.reason }
      : null,
    tradeScore: plan.tradeScore,
    priceImpactPct: stored.priceImpactPct,
    withdrawal: false,
    recipient: null,
    amountUsd: new Decimal(plan.amountUsd.toString()),
    todaySpendUsd: new Decimal(usage.usedTodayUsd),
    limits: {
      perActionUsd: limitsRow?.perActionUsd.toString() ?? profile.perActionUsd,
      perDayUsd: limitsRow?.perDayUsd.toString() ?? profile.perDayUsd,
      minTradeScoreAuto: limitsRow?.minTradeScoreAuto ?? profile.minTradeScoreAuto,
      hookPolicy: limitsRow?.hookPolicy ?? profile.hooksWithoutApproval,
    },
  });
}

async function runAccepted(
  deps: ModeBDeps,
  row: SuggestionRow,
  planId: string,
): Promise<SuggestionActionResponse> {
  const emit = (e: { kind: 'policy' | 'approval'; title: string; detail: string; data: unknown }) =>
    deps.traceBus.emit({ ...e, traceId: row.traceId ?? randomUUID(), userId: row.userId });
  await emit({
    kind: 'policy',
    title: 'Accepted by you',
    detail: row.title,
    data: { suggestionId: row.id, actionPlanId: planId },
  });

  const requote = await requoteBeforeAccept(deps, planId);
  if (requote.moved) {
    await deps.prisma.suggestion.update({
      where: { id: row.id },
      data: { status: 'FAILED', note: NOTES.priceMoved },
    });
    await syncCard(deps.prisma, { ...row, status: 'FAILED' });
    await deps.notifications.enqueue({ kind: 'outcome', suggestionId: row.id });
    return respond(deps, row.id, 'PRICE_MOVED', NOTES.priceMoved);
  }

  const user = await deps.prisma.user.findUniqueOrThrow({ where: { id: row.userId } });
  const plan = await deps.prisma.actionPlan.findUniqueOrThrow({ where: { id: planId } });
  const decision = await decideAtAccept(deps, user, plan);

  if (decision.outcome === 'REFUSE') {
    const message = (
      decision.reasons[0]?.message ?? 'It no longer passes the safety checks'
    ).replace(/[.!?]+$/, '');
    await deps.prisma.$transaction([
      deps.prisma.actionPlan.update({
        where: { id: planId },
        data: {
          status: 'REFUSED',
          policyOutcome: 'REFUSE',
          policyReasons: json(decision.reasons),
        },
      }),
      deps.prisma.agentRequest.update({
        where: { id: plan.agentRequestId },
        data: { status: 'REFUSED' },
      }),
      deps.prisma.suggestion.update({
        where: { id: row.id },
        data: { status: 'FAILED', note: `Refused: ${message}.` },
      }),
    ]);
    await setPreviewStatus(deps.prisma, planId, 'REFUSED');
    await syncCard(deps.prisma, { ...row, status: 'FAILED' });
    await postPlanMessage(deps.prisma, planId, `I did not do this: ${message}.`, [
      {
        type: 'refusal',
        actionPlanId: planId,
        title: `Refused: ${row.title}`.slice(0, 200),
        summary: `It no longer passes the safety checks: ${message}.`,
        reasons: decision.reasons,
        suggestion: refusalSuggestion(decision.reasons),
        decisionLog: { status: 'PENDING' },
      },
    ]);
    await emit({
      kind: 'policy',
      title: 'Policy: refused',
      detail: message,
      data: { ...decision, actionPlanId: planId },
    });
    await deps.jobs.enqueueDecisionLog(planId);
    await deps.notifications.enqueue({ kind: 'outcome', suggestionId: row.id });
    return respond(deps, row.id, 'REFUSED', `Refused: ${message}.`);
  }

  if (decision.outcome === 'STEP_UP') {
    const approval = await deps.prisma.$transaction(async (tx) => {
      await tx.actionPlan.update({
        where: { id: planId },
        data: {
          status: 'AWAITING_APPROVAL',
          policyOutcome: 'STEP_UP',
          policyReasons: json(decision.reasons),
        },
      });
      await tx.agentRequest.update({
        where: { id: plan.agentRequestId },
        data: { status: 'AWAITING_APPROVAL' },
      });
      await tx.suggestion.update({
        where: { id: row.id },
        data: { note: NOTES.needsApproval },
      });
      return deps.approvals.create(tx, {
        planId,
        userId: row.userId,
        planHash: plan.planHash,
        amountUsd: usd2(plan.amountUsd.toString()),
        reasons: decision.reasons,
        channel: 'WEB',
        providerKind: deps.approvalProvider.kind,
      });
    });
    await deps.approvalProvider.requestApproval(approval.id, 'web');
    await setPreviewStatus(deps.prisma, planId, 'AWAITING_APPROVAL');
    await syncCard(deps.prisma, { ...row, status: 'ACCEPTED' });
    const summary = describeIntent(ActionIntentSchema.parse(plan.intent));
    await postPlanMessage(deps.prisma, planId, `This needs your approval: ${approval.reason}.`, [
      {
        type: 'approval',
        approvalId: approval.id,
        actionPlanId: planId,
        title: summary.charAt(0).toUpperCase() + summary.slice(1),
        summary,
        reason: approval.reason,
        reasons: decision.reasons,
        amountUsd: usd2(plan.amountUsd.toString()),
        ...(plan.tradeScore !== null ? { tradeScore: plan.tradeScore } : {}),
        status: 'PENDING',
        channel: approval.channel,
        providerKind: approval.providerKind,
        expiresAt: approval.expiresAt.toISOString(),
      },
    ]);
    await emit({
      kind: 'approval',
      title: 'Waiting for your approval',
      detail: `${approval.reason}. Expires ${approval.expiresAt.toISOString()}.`,
      data: { approvalId: approval.id, actionPlanId: planId },
    });
    await deps.notifications.enqueue({ kind: 'outcome', suggestionId: row.id });
    return respond(deps, row.id, 'NEEDS_APPROVAL', `Needs your approval: ${approval.reason}.`, {
      approvalId: approval.id,
    });
  }

  // AUTO: the same plan, now cleared to run. Execution re-quotes and re-checks limits again.
  await deps.prisma.$transaction([
    deps.prisma.actionPlan.update({
      where: { id: planId },
      data: { status: 'QUEUED', policyOutcome: 'AUTO', policyReasons: json([]) },
    }),
    deps.prisma.agentRequest.update({
      where: { id: plan.agentRequestId },
      data: { status: 'QUEUED' },
    }),
  ]);
  await setPreviewStatus(deps.prisma, planId, 'QUEUED');
  await syncCard(deps.prisma, { ...row, status: 'ACCEPTED' });
  await emit({
    kind: 'policy',
    title: 'Policy: AUTO — your agent may do this alone',
    detail: 'You said yes, and it is within your limits and safety thresholds.',
    data: { ...decision, actionPlanId: planId },
  });
  await deps.jobs.enqueueExecution(planId);
  await deps.notifications.enqueue({ kind: 'outcome', suggestionId: row.id });
  return respond(deps, row.id, 'EXECUTING', 'Your agent is doing it now.');
}

export async function acceptSuggestion(
  deps: ModeBDeps,
  id: string,
  userId: string,
): Promise<SuggestionActionResponse> {
  const row = await loadOwned(deps.prisma, id, userId);
  if (row.status !== 'OPEN') throw closedError(row.status);
  if (!row.actionPlanId || row.actionPlan?.status !== 'PREPARED')
    throw new AppError('CONFLICT', 409, 'This suggestion has nothing to run yet.');
  if (row.expiresAt && row.expiresAt.getTime() <= nowOf(deps).getTime()) {
    await expire(deps, row);
    return respond(deps, id, 'EXPIRED', NOTES.expired);
  }
  if (!(await claim(deps.prisma, row.id, 'ACCEPTED', null))) throw closedError('ACCEPTED');
  try {
    return await runAccepted(deps, row, row.actionPlanId);
  } catch (err) {
    // A read failed before anything ran: give the human their choice back.
    const plan = await deps.prisma.actionPlan.findUnique({
      where: { id: row.actionPlanId },
      select: { status: true },
    });
    if (plan?.status === 'PREPARED')
      await deps.prisma.suggestion.updateMany({
        where: { id: row.id, status: 'ACCEPTED' },
        data: { status: 'OPEN', expiresAt: row.expiresAt },
      });
    throw err;
  }
}

// --- After execution / approval ---------------------------------------------------------------

const trim = (v: string) => new Decimal(v).toDecimalPlaces(8).toString();

/**
 * What the agent actually did, from the plan it executed: the inbox reports a fact, not the
 * proposal. Sales of a position in profit also say what the profit was.
 */
export function executedReport(
  plan: Pick<ActionPlan, 'steps' | 'amountUsd'>,
  row: Pick<Suggestion, 'event' | 'title' | 'message'>,
): { title: string; message: string } {
  const s = (plan.steps as unknown as StoredSteps).summary;
  const event = (row.event ?? {}) as {
    summary?: string;
    facts?: { pnlPct?: string; symbol?: string };
  };
  const why = event.summary ?? row.message;
  if (!s?.tokenIn || !s.tokenOut || !s.amountIn || !s.amountOut)
    return { title: `Done: ${row.title}`.slice(0, 200), message: why };
  const spent = `${trim(s.amountIn.decimal)} ${s.tokenIn.symbol}`;
  const got = `${trim(s.amountOut.decimal)} ${s.tokenOut.symbol}`;
  const usd = usd2(plan.amountUsd.toString());
  const stable = /^(USDC|USDT|DAI)$/i.test(s.tokenIn.symbol);
  if (stable)
    return {
      title: `Bought ${got} for $${usd}`,
      message: `Your agent bought ${got} with ${spent}. Why: ${why}`,
    };
  const pct = event.facts?.pnlPct ? new Decimal(event.facts.pnlPct) : null;
  const profit = pct?.gt(0) ? new Decimal(usd).times(pct).div(pct.plus(100)) : null;
  return {
    title: `Sold ${spent} for ${got}`,
    message: `Your agent sold ${spent} for ${got}${profit ? `, locking in about $${usd2(profit)} of profit` : ''}. Why: ${why}`,
  };
}

const SETTLED_NOTE: Partial<Record<ExecuteOutcome, string>> = {
  executed: NOTES.executed,
  failed: NOTES.failed,
  price_moved: NOTES.priceMoved,
  cancelled: NOTES.cancelled,
  stepped_up: NOTES.needsApproval,
};

/** A plan run ended: settle its suggestion (or send the rule's receipt) and tell Telegram. */
export async function planSettled(
  deps: NotifyDeps,
  planId: string,
  outcome: ExecuteOutcome,
): Promise<void> {
  const note = SETTLED_NOTE[outcome];
  if (!note) return;
  const row = await deps.prisma.suggestion.findFirst({
    where: { actionPlanId: planId },
    include: { actionPlan: { select: { steps: true, amountUsd: true } } },
  });
  if (row) {
    const ran = outcome === 'executed';
    const report = ran && row.actionPlan ? executedReport(row.actionPlan, row) : null;
    await deps.prisma.suggestion.update({
      where: { id: row.id },
      data: {
        note,
        ...(report ?? {}),
        ...(ran ? {} : { status: outcome === 'stepped_up' ? 'ACCEPTED' : 'FAILED' }),
      },
    });
    const status = ran ? row.status : outcome === 'stepped_up' ? 'ACCEPTED' : 'FAILED';
    await syncCard(deps.prisma as PrismaClient, { ...row, ...(report ?? {}), status });
    await deps.notifications.enqueue({ kind: 'outcome', suggestionId: row.id });
    return;
  }
  const plan = await deps.prisma.actionPlan.findUnique({
    where: { id: planId },
    select: { agentRequest: { select: { channel: true } } },
  });
  if (plan?.agentRequest.channel === 'TRIGGER' && outcome !== 'stepped_up')
    await deps.notifications.enqueue({ kind: 'receipt', planId });
}

const APPROVAL_END: Record<ApprovalOutcome, { status: SuggestionStatus | null; note: string }> = {
  APPROVED: { status: null, note: NOTES.approved },
  DENIED: { status: 'DECLINED', note: NOTES.approvalDenied },
  EXPIRED: { status: 'EXPIRED', note: NOTES.approvalExpired },
  REJECTED: { status: 'DECLINED', note: NOTES.approvalRejected },
};

/** An approval left PENDING: reflect it on the suggestion it came from. */
export async function approvalResolved(
  deps: NotifyDeps,
  approval: Pick<Approval, 'actionPlanId'>,
  outcome: ApprovalOutcome,
): Promise<void> {
  const row = await deps.prisma.suggestion.findFirst({
    where: { actionPlanId: approval.actionPlanId },
  });
  if (!row) return;
  const end = APPROVAL_END[outcome];
  await deps.prisma.suggestion.update({
    where: { id: row.id },
    data: { note: end.note, ...(end.status ? { status: end.status } : {}) },
  });
  if (end.status) await syncCard(deps.prisma as PrismaClient, { ...row, status: end.status });
  await deps.notifications.enqueue({ kind: 'outcome', suggestionId: row.id });
}
