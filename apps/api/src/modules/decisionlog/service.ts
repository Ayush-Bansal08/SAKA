/**
 * Decision-log upload job (`decisionlog.upload`, PHASE 05 §6). Every plan that reached a final
 * state — executed, refused, denied, expired, failed, price moved — gets a canonical-JSON
 * record uploaded to 0G Storage (turbo testnet indexer). The root hash and tx hash are stored,
 * the chat card is patched with them, and a trace event "Logged to 0G Storage" links the
 * explorer. Retries: BullMQ, 5 attempts with exponential backoff; the last failure marks FAILED.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { DecisionLogRef, ExecutionChainId } from '@warden/shared';
import { canonicalJson } from '../../lib/canonical.js';
import { patchPlanCards } from '../agent/card-store.js';
import type { TraceBus } from '../trace/trace-bus.js';
import { buildDecisionLogPayload } from './payload.js';
import type { DecisionLogStorage } from './storage.js';

export interface DecisionLogDeps {
  prisma: PrismaClient;
  storage: DecisionLogStorage | null;
  traceBus: Pick<TraceBus, 'emit'>;
  env: { APP_NAME: string; EXECUTION_CHAIN_ID: ExecutionChainId; ZG_STORAGE_EXPLORER_URL: string };
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const FINAL = new Set(['EXECUTED', 'REFUSED', 'FAILED', 'CANCELLED', 'EXPIRED']);
const CARD_TYPES = new Set(['receipt', 'refusal', 'failure']);

export function decisionLogExplorerUrl(base: string, txHash: string | null): string | undefined {
  return txHash ? `${base}/tx/${txHash}` : undefined;
}

async function patchCards(
  deps: DecisionLogDeps,
  planId: string,
  ref: DecisionLogRef,
): Promise<void> {
  await patchPlanCards(deps.prisma, planId, (c) =>
    CARD_TYPES.has(String(c.type)) ? { ...c, decisionLog: ref } : null,
  );
}

export type UploadOutcome = 'uploaded' | 'already_uploaded' | 'not_final' | 'not_configured';

export async function uploadDecisionLog(
  deps: DecisionLogDeps,
  planId: string,
): Promise<UploadOutcome> {
  const plan = await deps.prisma.actionPlan.findUnique({
    where: { id: planId },
    select: { status: true, userId: true, agentRequest: { select: { traceId: true } } },
  });
  if (!plan || !FINAL.has(plan.status)) return 'not_final';
  const existing = await deps.prisma.decisionLog.findUnique({ where: { actionPlanId: planId } });
  if (existing?.status === 'UPLOADED') return 'already_uploaded';

  const { payload, payloadHash } = await buildDecisionLogPayload(deps.prisma, planId, {
    app: deps.env.APP_NAME,
    chainId: deps.env.EXECUTION_CHAIN_ID,
  });
  const row = await deps.prisma.decisionLog.upsert({
    where: { actionPlanId: planId },
    create: { actionPlanId: planId, payload: json(payload), payloadHash, status: 'PENDING' },
    update: { payload: json(payload), payloadHash, status: 'PENDING' },
  });
  const trace = { traceId: plan.agentRequest.traceId, userId: plan.userId };

  if (!deps.storage) {
    await deps.traceBus.emit({
      ...trace,
      kind: 'log',
      title: 'Decision log kept locally',
      detail: '0G Storage is not configured (ZG_STORAGE_PRIVATE_KEY); the record stays PENDING.',
      data: { payloadHash },
    });
    return 'not_configured';
  }

  await deps.prisma.decisionLog.update({
    where: { id: row.id },
    data: { attempts: { increment: 1 } },
  });
  const { rootHash, txHash } = await deps.storage.upload(
    new TextEncoder().encode(canonicalJson(payload)),
  );
  await deps.prisma.decisionLog.update({
    where: { id: row.id },
    data: { status: 'UPLOADED', zgRootHash: rootHash, zgTxHash: txHash },
  });
  const explorerUrl = decisionLogExplorerUrl(deps.env.ZG_STORAGE_EXPLORER_URL, txHash);
  await patchCards(deps, planId, {
    status: 'UPLOADED',
    rootHash,
    txHash,
    ...(explorerUrl ? { explorerUrl } : {}),
  });
  await deps.traceBus.emit({
    ...trace,
    kind: 'log',
    title: 'Logged to 0G Storage',
    detail: `Root hash ${rootHash}`,
    data: { rootHash, txHash, payloadHash, explorerUrl: explorerUrl ?? null },
  });
  return 'uploaded';
}

/** Called by the worker when the last retry failed. */
export async function markDecisionLogFailed(
  deps: DecisionLogDeps,
  planId: string,
  error: string,
): Promise<void> {
  const row = await deps.prisma.decisionLog.findUnique({ where: { actionPlanId: planId } });
  if (!row || row.status === 'UPLOADED') return;
  await deps.prisma.decisionLog.update({ where: { id: row.id }, data: { status: 'FAILED' } });
  await patchCards(deps, planId, { status: 'FAILED' });
  const plan = await deps.prisma.actionPlan.findUnique({
    where: { id: planId },
    select: { userId: true, agentRequest: { select: { traceId: true } } },
  });
  if (plan)
    await deps.traceBus.emit({
      traceId: plan.agentRequest.traceId,
      userId: plan.userId,
      kind: 'error',
      title: '0G Storage upload failed',
      detail: error.slice(0, 300),
    });
}
