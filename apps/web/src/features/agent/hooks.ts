import {
  AgentMessageAcceptedSchema,
  AgentMessagesResponseSchema,
  type AgentMessagesResponse,
  type TraceEvent,
} from '@warden/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useOnTraceEvent } from '@/features/portfolio/hooks';
import { api, ApiError } from '@/lib/api';
import { hasLivePlan } from './plan-hooks';

export const agentKeys = { messages: ['agent', 'messages'] as const };

/** Poll while the newest message is the user's (the agent has not replied yet). */
export const AGENT_PENDING_POLL_MS = 2_000;
/** Poll while an AUTO/approved plan is executing (receipts can take ~15 s on testnet). */
export const AGENT_LIVE_PLAN_POLL_MS = 3_000;

export function isAwaitingReply(data: AgentMessagesResponse | undefined): boolean {
  return data?.messages[0]?.role === 'USER';
}

/** The planner's final trace events: a reply is now stored. */
export function endsPlanning(e: TraceEvent): boolean {
  return (
    (e.kind === 'plan' && (e.title === 'Proposed intent' || e.title === 'Agent reply')) ||
    (e.kind === 'error' && e.title === 'Planning unavailable')
  );
}

/** Pipeline events that change a card (approval, execution, receipt, 0G log, cancel, errors). */
export function changesPlanCards(e: TraceEvent): boolean {
  return (
    e.kind === 'approval' ||
    e.kind === 'receipt' ||
    e.kind === 'log' ||
    e.kind === 'error' ||
    e.kind === 'detector' ||
    (e.kind === 'tx' && e.title === 'Executing') ||
    (e.kind === 'policy' &&
      ['Cancelled by you', 'Declined by you', 'Accepted by you'].includes(e.title))
  );
}

/** The one query function for the chat history (every observer of the key must share it). */
export const fetchAgentMessages = ({ signal }: { signal?: AbortSignal }) =>
  api('/agent/messages', { schema: AgentMessagesResponseSchema, ...(signal ? { signal } : {}) });

export function useAgentMessages() {
  const qc = useQueryClient();
  useOnTraceEvent(endsPlanning, () => {
    void qc.invalidateQueries({ queryKey: agentKeys.messages });
  });
  useOnTraceEvent(changesPlanCards, () => {
    void qc.invalidateQueries({ queryKey: agentKeys.messages });
  });
  return useQuery({
    queryKey: agentKeys.messages,
    queryFn: fetchAgentMessages,
    // Fallback to the live stream: poll while waiting for a reply or while a plan is moving.
    refetchInterval: (q) =>
      isAwaitingReply(q.state.data)
        ? AGENT_PENDING_POLL_MS
        : hasLivePlan(q.state.data)
          ? AGENT_LIVE_PLAN_POLL_MS
          : false,
    retry: (count, err) =>
      !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
  });
}

export function useSendAgentMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) =>
      api('/agent/messages', {
        method: 'POST',
        body: { text },
        schema: AgentMessageAcceptedSchema,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentKeys.messages });
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'Could not send your message.');
    },
  });
}
