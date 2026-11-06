/**
 * In-place card transitions (PHASE 06 §2 "after execution the preview transitions in place into
 * a ReceiptCard — no new card spam"). The API posts the receipt / failure / price-moved card as a
 * new message in the plan's trace; the chat folds it back into the message that holds the plan's
 * preview or approval card and hides the follow-up message.
 */
import type { AgentMessageView, Card } from '@warden/shared';
import { parseCards } from './plan-hooks';

type OutcomeCard = Extract<Card, { type: 'receipt' | 'failure' | 'price_moved' }>;
const isOutcome = (c: Card): c is OutcomeCard =>
  c.type === 'receipt' || c.type === 'failure' || c.type === 'price_moved';
const planOf = (c: Card): string | undefined =>
  'actionPlanId' in c ? (c.actionPlanId ?? undefined) : undefined;

export interface FoldedMessage {
  message: AgentMessageView;
  /** Cards to render, outcome cards folded into place. */
  cards: Card[];
  /** True when every card moved into an earlier message (render nothing). */
  hidden: boolean;
}

/** `messages` oldest first. */
export function foldMessages(messages: readonly AgentMessageView[]): FoldedMessage[] {
  const parsed = messages.map((m) => ({ message: m, cards: parseCards(m.cards) }));
  // The message that first shows a plan (preview or approval card).
  const host = new Map<string, number>();
  // The latest outcome card per plan.
  const outcome = new Map<string, OutcomeCard>();
  parsed.forEach(({ cards }, i) => {
    for (const c of cards) {
      const plan = planOf(c);
      if (!plan) continue;
      if ((c.type === 'preview' || c.type === 'approval') && !host.has(plan)) host.set(plan, i);
      if (isOutcome(c)) outcome.set(plan, c);
    }
  });

  return parsed.map(({ message, cards }, i) => {
    const out: Card[] = [];
    let moved = 0;
    for (const c of cards) {
      const plan = planOf(c);
      if (plan && isOutcome(c) && host.has(plan) && host.get(plan)! < i) {
        moved += 1; // shown in the host message instead
        continue;
      }
      const done = plan ? outcome.get(plan) : undefined;
      if (c.type === 'preview' && done && host.get(plan!) === i) {
        out.push(done); // preview → receipt / failure / price moved, in place
      } else if (c.type === 'approval' && done && host.get(plan!) === i) {
        out.push(c, done); // the approval record stays, the outcome follows it
      } else if (!(isOutcome(c) && plan && host.get(plan) === i && done !== c)) {
        out.push(c);
      }
    }
    return {
      message,
      cards: out,
      hidden: message.role === 'AGENT' && moved > 0 && out.length === 0,
    };
  });
}
