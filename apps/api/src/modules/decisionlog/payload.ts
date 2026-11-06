/**
 * Decision-log payload (PHASE 05 §6) — canonical JSON, keys sorted, so the same plan always
 * hashes the same. No raw personal data (the user is sha256(identityIss + identitySub)), no
 * signatures, no calldata: only what the agent saw, decided and did, with every 0G request ID.
 */
import type { PrismaClient } from '@prisma/client';
import { canonicalHash, sha256Hex } from '../../lib/canonical.js';

export const DECISION_LOG_VERSION = 1;

export interface DecisionLogPayload {
  version: 1;
  app: string;
  chainId: number;
  user: string;
  agentWallet: string | null;
  request: { channel: string; text?: string; event?: unknown };
  inferences: {
    role: string;
    model: string;
    trustMode: string;
    zgRequestId: string | null;
    teeVerified: boolean | null;
  }[];
  intent: unknown;
  planHash: string;
  quote: unknown;
  scores: { trade: number | null; hook: number | null };
  simulation: unknown;
  guard: unknown;
  policy: { outcome: string; reasons: unknown };
  approval: { status: string; providerKind: string; authTime: string | null } | null;
  executions: { kind: string; txHash: string | null; status: string }[];
  timestamps: { requestedAt: string; plannedAt: string; finalizedAt: string; status: string };
}

export async function buildDecisionLogPayload(
  prisma: PrismaClient,
  planId: string,
  opts: { app: string; chainId: number },
): Promise<{ payload: DecisionLogPayload; payloadHash: string }> {
  const plan = await prisma.actionPlan.findUniqueOrThrow({
    where: { id: planId },
    include: {
      user: { include: { wallet: true } },
      agentRequest: { include: { inferences: { orderBy: { createdAt: 'asc' } } } },
      approval: true,
      executions: { orderBy: { stepIndex: 'asc' } },
    },
  });
  const input = (plan.agentRequest.input ?? {}) as { text?: unknown; event?: unknown };
  const guard = plan.guardVerdict as {
    verdict?: string;
    pApprove?: number;
    unavailable?: boolean;
    reason?: string;
    zg?: { requestId?: string };
  } | null;
  const payload: DecisionLogPayload = {
    version: DECISION_LOG_VERSION,
    app: opts.app,
    chainId: opts.chainId,
    user: sha256Hex(`${plan.user.identityIss}${plan.user.identitySub}`),
    agentWallet: plan.user.wallet?.address ?? null,
    request: {
      channel: plan.agentRequest.channel,
      ...(typeof input.text === 'string' ? { text: input.text } : {}),
      ...(input.event !== undefined ? { event: input.event } : {}),
    },
    inferences: plan.agentRequest.inferences.map((i) => ({
      role: i.role,
      model: i.model,
      trustMode: i.trustMode,
      zgRequestId: i.zgRequestId,
      teeVerified: i.teeVerified,
    })),
    intent: plan.intent,
    planHash: plan.planHash,
    quote: plan.quote ?? null,
    scores: { trade: plan.tradeScore, hook: plan.hookScore },
    simulation: plan.simulation ?? null,
    guard: guard
      ? {
          verdict: guard.verdict ?? null,
          pApprove: guard.pApprove ?? null,
          unavailable: guard.unavailable ?? null,
          reason: guard.reason ?? null,
          zgRequestId: guard.zg?.requestId ?? null,
        }
      : null,
    policy: { outcome: plan.policyOutcome, reasons: plan.policyReasons },
    approval: plan.approval
      ? {
          status: plan.approval.status,
          providerKind: plan.approval.providerKind,
          authTime: plan.approval.authTime?.toISOString() ?? null,
        }
      : null,
    executions: plan.executions.map((e) => ({ kind: e.kind, txHash: e.txHash, status: e.status })),
    timestamps: {
      requestedAt: plan.agentRequest.createdAt.toISOString(),
      plannedAt: plan.createdAt.toISOString(),
      finalizedAt: plan.updatedAt.toISOString(),
      status: plan.status,
    },
  };
  return { payload, payloadHash: canonicalHash(payload) };
}
