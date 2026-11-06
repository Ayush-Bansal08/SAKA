import { describe, expect, it } from 'vitest';
import type { AgentMessagesResponse, TraceEvent } from '@warden/shared';
import { changesPlanCards } from './hooks';
import { hasLivePlan, parseCards } from './plan-hooks';

const msg = (cards: unknown[]): AgentMessagesResponse['messages'][number] => ({
  id: 'm',
  role: 'AGENT',
  text: 't',
  cards,
  traceId: 't',
  createdAt: new Date().toISOString(),
});
const preview = (status: string) => ({
  type: 'preview',
  actionPlanId: 'p',
  status,
  title: 'Swap',
  summary: 's',
  amountUsd: '5.00',
  steps: [],
  policyOutcome: 'AUTO',
  policyReasons: [],
});

describe('plan cards', () => {
  it('skips unknown card shapes', () => {
    expect(parseCards([{ type: 'nope' }, preview('QUEUED')]).map((c) => c.type)).toEqual([
      'preview',
    ]);
  });
  it('polls only while a plan is moving', () => {
    const data = (status: string) => ({ messages: [msg([preview(status)])], nextCursor: null });
    expect(hasLivePlan(data('QUEUED'))).toBe(true);
    expect(hasLivePlan(data('EXECUTING'))).toBe(true);
    expect(hasLivePlan(data('EXECUTED'))).toBe(false);
    expect(hasLivePlan(data('CANCELLED'))).toBe(false);
  });
  it('refreshes on approval, receipt and 0G log events', () => {
    const e = (kind: TraceEvent['kind'], title: string) => ({ kind, title }) as TraceEvent;
    expect(changesPlanCards(e('receipt', 'Done: swap'))).toBe(true);
    expect(changesPlanCards(e('log', 'Logged to 0G Storage'))).toBe(true);
    expect(changesPlanCards(e('approval', 'Denied'))).toBe(true);
    expect(changesPlanCards(e('tool_call', 'Uniswap · get_quote'))).toBe(false);
  });
});
