import type { AgentMessagesResponse, TraceEvent } from '@warden/shared';
import { describe, expect, it } from 'vitest';
import { endsPlanning, isAwaitingReply } from './hooks';

const event = (kind: TraceEvent['kind'], title: string) =>
  ({ id: 'e', traceId: 't', userId: 'u', ts: new Date().toISOString(), kind, title }) as TraceEvent;
const message = (role: 'USER' | 'AGENT') => ({
  id: role,
  role,
  text: 'x',
  cards: null,
  traceId: null,
  createdAt: new Date().toISOString(),
});

describe('agent chat hooks', () => {
  it('waits for a reply only while the newest message is the user’s', () => {
    expect(isAwaitingReply(undefined)).toBe(false);
    expect(isAwaitingReply({ messages: [], nextCursor: null })).toBe(false);
    const pending: AgentMessagesResponse = { messages: [message('USER')], nextCursor: null };
    expect(isAwaitingReply(pending)).toBe(true);
    expect(
      isAwaitingReply({ messages: [message('AGENT'), message('USER')], nextCursor: null }),
    ).toBe(false);
  });

  it('refreshes on the planner’s final events only', () => {
    expect(endsPlanning(event('plan', 'Proposed intent'))).toBe(true);
    expect(endsPlanning(event('plan', 'Agent reply'))).toBe(true);
    expect(endsPlanning(event('error', 'Planning unavailable'))).toBe(true);
    expect(endsPlanning(event('plan', '0G planner'))).toBe(false);
    expect(endsPlanning(event('tool_call', 'Uniswap · get_quote'))).toBe(false);
  });
});
