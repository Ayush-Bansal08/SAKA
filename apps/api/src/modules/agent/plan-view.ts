/** ActionPlan row → PlanView / ApprovalView (GET /plans/:id, GET /approvals/:id). */
import type { ActionPlan, Approval, DecisionLog, Execution } from '@prisma/client';
import {
  ActionIntentSchema,
  Decimal,
  explorerTxUrl,
  type ApprovalView,
  type ExecutionChainId,
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

export function planView(
  plan: ActionPlan & {
    approval: Approval | null;
    executions: Execution[];
    decisionLog: DecisionLog | null;
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
    decisionLog: plan.decisionLog
      ? {
          status: plan.decisionLog.status,
          ...(plan.decisionLog.zgRootHash ? { rootHash: plan.decisionLog.zgRootHash } : {}),
          ...(plan.decisionLog.zgTxHash ? { txHash: plan.decisionLog.zgTxHash } : {}),
          ...(plan.decisionLog.zgTxHash
            ? { explorerUrl: decisionLogExplorerUrl(opts.explorerBase, plan.decisionLog.zgTxHash)! }
            : {}),
        }
      : null,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}
