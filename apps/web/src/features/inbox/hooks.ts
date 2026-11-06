/** Mode B data for the inbox, the nav badge and the chat card (PHASE 08). */
import {
  SuggestionActionResponseSchema,
  SuggestionsResponseSchema,
  type SuggestionActionResponse,
  type TraceEvent,
} from '@warden/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { requestPrefill } from '@/features/agent/prefill';
import { agentKeys } from '@/features/agent/hooks';
import { changesPlans, planKeys } from '@/features/plan/hooks';
import { useOnTraceEvent } from '@/features/portfolio/hooks';
import { api, ApiError } from '@/lib/api';

export const suggestionKeys = { all: ['suggestions'] as const };

/** Anything that may move a suggestion: a detector firing, or its plan changing. */
export const changesSuggestions = (e: TraceEvent) => e.kind === 'detector' || changesPlans(e);

const noRetry4xx = (count: number, err: Error) =>
  !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2;

export function useSuggestions() {
  const qc = useQueryClient();
  useOnTraceEvent(changesSuggestions, () => {
    void qc.invalidateQueries({ queryKey: suggestionKeys.all });
  });
  return useQuery({
    queryKey: suggestionKeys.all,
    queryFn: ({ signal }) => api('/suggestions', { schema: SuggestionsResponseSchema, signal }),
    // Expiry is time-based: re-check even without events.
    refetchInterval: 30_000,
    retry: noRetry4xx,
  });
}

export type SuggestionAction = 'accept' | 'decline' | 'change';

/** Shows the outcome. The server's message is the source of truth, so it is shown as is. */
function announce(r: SuggestionActionResponse) {
  switch (r.result) {
    case 'EXECUTING':
    case 'DECLINED':
      return void toast.success(r.message);
    case 'NEEDS_APPROVAL':
      return void toast.warning('This needs your approval', { description: r.message });
    case 'PRICE_MOVED':
    case 'EXPIRED':
      return void toast.warning(r.message);
    case 'REFUSED':
      return void toast.error(r.message);
    case 'CHANGED':
      return;
  }
}

export function useSuggestionAction() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: SuggestionAction }) =>
      api(`/suggestions/${id}/${action}`, {
        method: 'POST',
        body: {},
        schema: SuggestionActionResponseSchema,
      }),
    onSuccess: (r) => {
      announce(r);
      if (r.result === 'CHANGED' && r.prefill) {
        requestPrefill(r.prefill);
        void navigate('/app');
      }
    },
    onError: (err) => {
      toast.error(
        err instanceof ApiError ? err.message : 'That did not go through. Please try again.',
      );
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: suggestionKeys.all });
      void qc.invalidateQueries({ queryKey: planKeys.pending });
      void qc.invalidateQueries({ queryKey: agentKeys.messages });
    },
  });
}
