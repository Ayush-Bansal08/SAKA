/**
 * Approvals (PHASE 05 §4, PHASE_00 §9). An approval binds userId, actionPlanId, planHash,
 * amountUsd and expiresAt (APPROVAL_TTL_SECONDS, default 5 min). It moves exactly once:
 *   PENDING → APPROVED | DENIED | EXPIRED | REJECTED       (resolve, atomic single transition)
 *   APPROVED → USED                                      (execution, same tx that reserves it)
 * APPROVED stores the identity evidence and enqueues execution. A human whose identity does not
 * match the account owner is REJECTED ("wrong human") and nothing runs. Every change emits a
 * trace event and patches the approval card in the chat.
 */
import type { Approval, Prisma, PrismaClient } from '@prisma/client';
import type { PolicyReason, ProviderKind } from '@warden/shared';
import type { TraceBus } from '../trace/trace-bus.js';
import type { JobQueues } from '../execution/jobs.js';
import { patchPlanCards, postPlanMessage, setPreviewStatus } from '../agent/card-store.js';

export interface ApprovalEvidence {
  providerKind: ProviderKind;
  iss: string;
  sub: string;
  authTime: Date;
  acr?: string;
  amr?: string[];
}

export type ApprovalOutcome = 'APPROVED' | 'DENIED' | 'EXPIRED' | 'REJECTED';

export interface ResolveResult {
  /** False when the approval was not PENDING any more (or expired before approval). */
  changed: boolean;
  status: Approval['status'];
  approval: Approval;
}

export interface ApprovalsDeps {
  prisma: PrismaClient;
  trace: Pick<TraceBus, 'emit'>;
  jobs: JobQueues;
  ttlSeconds: number;
  now?: () => Date;
}

const OUTCOME_COPY: Record<ApprovalOutcome, { title: string; text: string }> = {
  APPROVED: { title: 'Approved by you', text: 'Approved — your agent is executing it now.' },
  DENIED: { title: 'Denied', text: 'Denied — nothing was traded.' },
  EXPIRED: {
    title: 'Approval expired',
    text: 'The approval expired — nothing was traded. Ask again to get a fresh quote.',
  },
  REJECTED: {
    title: 'Approval rejected',
    text: 'That approval came from a different human than the account owner — nothing was traded.',
  },
};

const PLAN_STATUS_AFTER: Record<ApprovalOutcome, 'APPROVED' | 'CANCELLED' | 'EXPIRED'> = {
  APPROVED: 'APPROVED',
  DENIED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  REJECTED: 'CANCELLED',
};

export function reasonText(reasons: readonly PolicyReason[]): string {
  return reasons.map((r) => r.message).join('; ') || 'This action needs your approval';
}

export class ApprovalsService {
  constructor(private readonly deps: ApprovalsDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** Creates a PENDING approval for a plan (call inside the plan's transaction). */
  create(
    tx: Prisma.TransactionClient,
    input: {
      planId: string;
      userId: string;
      planHash: string;
      amountUsd: string;
      reasons: readonly PolicyReason[];
      channel: 'WEB' | 'TELEGRAM';
      providerKind: ProviderKind;
    },
  ): Promise<Approval> {
    return tx.approval.create({
      data: {
        actionPlanId: input.planId,
        userId: input.userId,
        planHash: input.planHash,
        amountUsd: input.amountUsd,
        reason: reasonText(input.reasons),
        status: 'PENDING',
        channel: input.channel,
        expiresAt: new Date(this.now().getTime() + this.deps.ttlSeconds * 1000),
        providerKind: input.providerKind,
      },
    });
  }

  /**
   * The one way out of PENDING. APPROVED must carry evidence for the account owner; anything
   * else becomes REJECTED. An approval past expiresAt can only become EXPIRED.
   */
  async resolve(
    approvalId: string,
    outcome: ApprovalOutcome,
    evidence?: ApprovalEvidence,
  ): Promise<ResolveResult> {
    const now = this.now();
    const existing = await this.deps.prisma.approval.findUnique({
      where: { id: approvalId },
      include: { user: true },
    });
    if (!existing) throw new Error(`Approval ${approvalId} not found`);

    let final: ApprovalOutcome = outcome;
    if (outcome === 'APPROVED') {
      const owner = existing.user;
      const sameHuman =
        evidence !== undefined &&
        evidence.providerKind === owner.identityKind &&
        evidence.sub === owner.identitySub &&
        (evidence.providerKind === 'dev' || evidence.iss === owner.identityIss);
      if (!sameHuman) final = 'REJECTED';
      else if (existing.expiresAt.getTime() <= now.getTime()) final = 'EXPIRED';
    }

    const data: Prisma.ApprovalUpdateManyMutationInput = {
      status: final,
      resolvedAt: now,
      ...(final === 'APPROVED' && evidence
        ? {
            approvedByIss: evidence.iss,
            approvedBySub: evidence.sub,
            authTime: evidence.authTime,
            acr: evidence.acr ?? null,
            amr: evidence.amr ?? [],
            providerKind: evidence.providerKind,
          }
        : {}),
    };
    const changed = await this.deps.prisma.$transaction(async (tx) => {
      const res = await tx.approval.updateMany({
        where: { id: approvalId, status: 'PENDING' },
        data,
      });
      if (res.count !== 1) return false;
      await tx.actionPlan.updateMany({
        where: { id: existing.actionPlanId, status: 'AWAITING_APPROVAL' },
        data: { status: PLAN_STATUS_AFTER[final] },
      });
      await tx.agentRequest.updateMany({
        where: { actionPlans: { some: { id: existing.actionPlanId } } },
        data: { status: final === 'APPROVED' ? 'QUEUED' : 'CANCELLED' },
      });
      await patchPlanCards(tx, existing.actionPlanId, (c) =>
        c.type === 'approval' ? { ...c, status: final } : null,
      );
      return true;
    });
    const approval = await this.deps.prisma.approval.findUniqueOrThrow({
      where: { id: approvalId },
    });
    if (!changed) return { changed: false, status: approval.status, approval };

    const traceId = await this.traceIdOf(existing.actionPlanId);
    const copy = OUTCOME_COPY[final];
    await this.deps.trace.emit({
      kind: 'approval',
      traceId,
      userId: existing.userId,
      title: copy.title,
      detail: copy.text,
      data: {
        approvalId,
        actionPlanId: existing.actionPlanId,
        status: final,
        providerKind: evidence?.providerKind ?? existing.providerKind,
      },
    });
    if (final === 'APPROVED') {
      await this.deps.jobs.enqueueExecution(existing.actionPlanId);
    } else {
      await setPreviewStatus(this.deps.prisma, existing.actionPlanId, PLAN_STATUS_AFTER[final]);
      await postPlanMessage(this.deps.prisma, existing.actionPlanId, copy.text, [
        { type: 'info', title: copy.title, body: copy.text },
      ]);
      // Proof the agent did not act, and why.
      await this.deps.jobs.enqueueDecisionLog(existing.actionPlanId);
    }
    return { changed: true, status: final, approval };
  }

  /** Expiry sweeper (every 15 s): PENDING approvals past expiresAt → EXPIRED. */
  async sweepExpired(): Promise<number> {
    const due = await this.deps.prisma.approval.findMany({
      where: { status: 'PENDING', expiresAt: { lte: this.now() } },
      select: { id: true },
      take: 200,
    });
    let expired = 0;
    for (const { id } of due) {
      const res = await this.resolve(id, 'EXPIRED');
      if (res.changed) expired += 1;
    }
    return expired;
  }

  private async traceIdOf(planId: string): Promise<string> {
    const plan = await this.deps.prisma.actionPlan.findUniqueOrThrow({
      where: { id: planId },
      select: { agentRequest: { select: { traceId: true } } },
    });
    return plan.agentRequest.traceId;
  }
}
