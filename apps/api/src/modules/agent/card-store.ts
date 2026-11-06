/**
 * Chat cards that follow a plan: the preview/approval card is patched in place as the plan moves
 * (QUEUED → EXECUTING → EXECUTED, PENDING → DENIED…), and follow-up results (receipt, refusal,
 * failure) are posted as new agent messages in the same trace.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Card } from '@warden/shared';

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

type AnyCard = Record<string, unknown> & { type?: string; actionPlanId?: string };

/** Applies `patch` to every card of `planId` in the messages of the plan's trace. */
export async function patchPlanCards(
  prisma: PrismaClient | Prisma.TransactionClient,
  planId: string,
  patch: (card: AnyCard) => AnyCard | null,
): Promise<number> {
  const plan = await prisma.actionPlan.findUnique({
    where: { id: planId },
    select: { userId: true, agentRequest: { select: { traceId: true } } },
  });
  if (!plan) return 0;
  const messages = await prisma.chatMessage.findMany({
    where: { userId: plan.userId, traceId: plan.agentRequest.traceId, role: 'AGENT' },
  });
  let changed = 0;
  for (const m of messages) {
    if (!Array.isArray(m.cards)) continue;
    let touched = false;
    const cards = (m.cards as AnyCard[]).map((c) => {
      if (!c || typeof c !== 'object' || c.actionPlanId !== planId) return c;
      const next = patch(c);
      if (!next) return c;
      touched = true;
      return next;
    });
    if (touched) {
      await prisma.chatMessage.update({ where: { id: m.id }, data: { cards: json(cards) } });
      changed += 1;
    }
  }
  return changed;
}

/** Sets `status` on the plan's preview card (and returns how many messages changed). */
export function setPreviewStatus(
  prisma: PrismaClient | Prisma.TransactionClient,
  planId: string,
  status: string,
): Promise<number> {
  return patchPlanCards(prisma, planId, (c) => (c.type === 'preview' ? { ...c, status } : null));
}

/** Posts a new agent message in the plan's trace. */
export async function postPlanMessage(
  prisma: PrismaClient | Prisma.TransactionClient,
  planId: string,
  text: string,
  cards: Card[],
): Promise<void> {
  const plan = await prisma.actionPlan.findUnique({
    where: { id: planId },
    select: { userId: true, agentRequestId: true, agentRequest: { select: { traceId: true } } },
  });
  if (!plan) return;
  await prisma.chatMessage.create({
    data: {
      userId: plan.userId,
      role: 'AGENT',
      text,
      cards: json(cards),
      traceId: plan.agentRequest.traceId,
      requestId: plan.agentRequestId,
    },
  });
}
