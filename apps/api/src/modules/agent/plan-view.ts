/** ActionPlan row → PlanView / ApprovalView (GET /plans/:id, GET /approvals/:id). */
import type {
  ActionPlan,
  AgentRequest,
  Approval,
  DecisionLog,
  Execution,
  Inference,
} from '@prisma/client';
import {
  ActionIntentSchema,
  Decimal,
  explorerTxUrl,
  type ApprovalView,
  type DecisionLogRef,
  type ExecutionChainId,
  type InferenceRef,
  type PlanListItem,
  type PlanOutcome,
  type PlanView,
  type QuoteSummary,
  type SimulationView,
} from '@warden/shared';
import { describeIntent } from './describe.js';
import { previewSteps } from './pipeline.js';
import type { StoredSteps } from './preparer.js';
import { decisionLogExplorerUrl } from '../decisionlog/service.js';

export function approvalView(
  a: Approval,
  summary: string,
  devApproveAvailable: boolean,
): ApprovalView {
  return {
    id: a.id,
    actionPlanId: a.actionPlanId,
    status: a.status,
    reason: a.reason,
    amountUsd: new Decimal(a.amountUsd.toString()).toFixed(2),
    planHash: a.planHash,
    channel: a.channel,
    providerKind: a.providerKind,
    expiresAt: a.expiresAt.toISOString(),
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
    authTime: a.authTime?.toISOString() ?? null,
    summary,
    devApproveAvailable: devApproveAvailable && a.status === 'PENDING',
  };
}

/** The human's words (web/Telegram text) or a Mode B event label. */
export function requestTextOf(input: unknown): string | null {
  const i = (input ?? {}) as { text?: unknown; event?: { detector?: unknown } };
  if (typeof i.text === 'string' && i.text.trim()) return i.text.slice(0, 500);
  if (i.event && typeof i.event.detector === 'string') return `Proactive: ${i.event.detector}`;
  return null;
}

export function inferenceRefs(rows: Inference[]): InferenceRef[] {
  return rows
    .filter((i) => i.ok)
    .map((i) => ({
      role: i.role,
      model: i.model,
      trustMode: i.trustMode,
      requestId: i.zgRequestId,
      teeVerified: i.teeVerified,
    }));
}

function decisionLogRef(log: DecisionLog | null, explorerBase: string): DecisionLogRef | null {
  if (!log) return null;
  return {
    status: log.status,
    ...(log.zgRootHash ? { rootHash: log.zgRootHash } : {}),
    ...(log.zgTxHash ? { txHash: log.zgTxHash } : {}),
    ...(log.zgTxHash ? { explorerUrl: decisionLogExplorerUrl(explorerBase, log.zgTxHash)! } : {}),
  };
}

/** Activity outcome: what finally happened, in the words a human uses. */
export function planOutcome(
  plan: Pick<ActionPlan, 'status'> & { approval: Pick<Approval, 'status'> | null },
): PlanOutcome {
  switch (plan.status) {
    case 'EXECUTED':
      return 'EXECUTED';
    case 'REFUSED':
      return 'REFUSED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELLED':
      return plan.approval?.status === 'DENIED' || plan.approval?.status === 'REJECTED'
        ? 'DENIED'
        : plan.approval?.status === 'EXPIRED'
          ? 'EXPIRED'
          : 'CANCELLED';
    default:
      return 'PENDING';
  }
}

export function planListItem(
  plan: ActionPlan & {
    approval: Approval | null;
    executions: Execution[];
    decisionLog: DecisionLog | null;
    agentRequest: Pick<AgentRequest, 'input' | 'traceId'>;
  },
  opts: { chainId: ExecutionChainId; explorerBase: string },
): PlanListItem {
  const parsed = ActionIntentSchema.safeParse(plan.intent);
  const outcome = planOutcome(plan);
  const sent =
    plan.executions.find((e) => e.txHash && e.kind !== 'APPROVAL') ??
    plan.executions.find((e) => e.txHash);
  return {
    id: plan.id,
    createdAt: plan.createdAt.toISOString(),
    traceId: plan.agentRequest.traceId,
    requestText: requestTextOf(plan.agentRequest.input),
    type: parsed.success ? parsed.data.type : 'unknown',
    summary: parsed.success ? describeIntent(parsed.data) : 'Agent action',
    amountUsd: new Decimal(plan.amountUsd.toString()).toFixed(2),
    status: plan.status,
    outcome,
    ...((plan.agentRequest.input as { event?: { simulated?: unknown } } | null)?.event
      ?.simulated === true
      ? { simulated: true }
      : {}),
    policyOutcome: plan.policyOutcome,
    approvedBy:
      outcome === 'EXECUTED' || plan.executions.length
        ? plan.policyOutcome === 'STEP_UP'
          ? 'HUMAN'
          : 'AGENT'
        : null,
    tradeScore: plan.tradeScore,
    tx: sent?.txHash
      ? { hash: sent.txHash, explorerUrl: explorerTxUrl(opts.chainId, sent.txHash) }
      : null,
    decisionLog: decisionLogRef(plan.decisionLog, opts.explorerBase),
  };
}

const SELECTOR = /^0x[0-9a-fA-F]{8}/;

export function planView(
  plan: ActionPlan & {
    approval: Approval | null;
    executions: Execution[];
    decisionLog: DecisionLog | null;
    agentRequest: AgentRequest & { inferences: Inference[] };
  },
  opts: { chainId: ExecutionChainId; explorerBase: string; devApproveAvailable: boolean },
): PlanView {
  const intent = ActionIntentSchema.parse(plan.intent);
  const stored = plan.steps as unknown as StoredSteps;
  const guard = plan.guardVerdict as PlanView['guard'] | null;
  const summary = describeIntent(intent);
  return {
    id: plan.id,
    status: plan.status,
    summary,
    intent,
    planHash: plan.planHash,
    amountUsd: new Decimal(plan.amountUsd.toString()).toFixed(2),
    steps: stored?.version === 1 ? previewSteps(stored) : [],
    quote: (plan.quote as QuoteSummary | null) ?? null,
    tradeScore: plan.tradeScore,
    tradeScoreBreakdown: stored?.safety?.breakdown ?? [],
    hook:
      plan.hookAddress && plan.hookScore !== null
        ? {
            address: plan.hookAddress,
            score: plan.hookScore,
            band: plan.hookScore >= 80 ? 'SAFE' : plan.hookScore >= 50 ? 'CAUTION' : 'DANGER',
          }
        : null,
    simulation: (plan.simulation as SimulationView | null) ?? null,
    guard: guard
      ? {
          verdict: guard.verdict,
          pApprove: guard.pApprove,
          reason: guard.reason,
          unavailable: guard.unavailable,
          ...(guard.zg ? { zg: guard.zg } : {}),
        }
      : null,
    policyOutcome: plan.policyOutcome,
    policyReasons: plan.policyReasons as PlanView['policyReasons'],
    approval: plan.approval ? approvalView(plan.approval, summary, opts.devApproveAvailable) : null,
    executions: plan.executions.map((e) => ({
      id: e.id,
      stepIndex: e.stepIndex,
      kind: e.kind,
      status: e.status,
      txHash: e.txHash,
      explorerUrl: e.txHash ? explorerTxUrl(opts.chainId, e.txHash) : null,
      usdValue: new Decimal(e.usdValue.toString()).toFixed(2),
      approvedBy: e.approvedBy,
      error: e.error,
      createdAt: e.createdAt.toISOString(),
    })),
    decisionLog: decisionLogRef(plan.decisionLog, opts.explorerBase),
    traceId: plan.agentRequest.traceId,
    requestText: requestTextOf(plan.agentRequest.input),
    calls: (stored?.version === 1 ? stored.steps : []).map((st) => ({
      kind: st.kind,
      description: st.description,
      to: st.tx.to,
      selector: SELECTOR.exec(st.tx.data ?? '')?.[0]?.toLowerCase() ?? null,
      valueWei: st.tx.value,
    })),
    inferences: inferenceRefs(plan.agentRequest.inferences),
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}
