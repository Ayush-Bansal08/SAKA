import {
  ApprovalViewSchema,
  CardSchema,
  type AgentMessagesResponse,
  type Card,
} from '@warden/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { api, ApiError } from '@/lib/api';
import { approveWithPasskey, passkeyErrorMessage } from '@/lib/passkey';
import { agentKeys } from './hooks';

/** Valid cards of a message (unknown legacy shapes are skipped). */
export function parseCards(raw: unknown[] | null): Card[] {
  return (raw ?? []).flatMap((c) => {
    const parsed = CardSchema.safeParse(c);
    return parsed.success ? [parsed.data] : [];
  });
}

const LIVE_PLAN = new Set(['QUEUED', 'APPROVED', 'EXECUTING']);

/** A plan in the conversation is still moving (poll as a fallback to the live stream). */
export function hasLivePlan(data: AgentMessagesResponse | undefined): boolean {
  return (data?.messages ?? [])
    .slice(0, 10)
    .some((m) =>
      parseCards(m.cards).some(
        (c) =>
          (c.type === 'preview' && c.status !== undefined && LIVE_PLAN.has(c.status)) ||
          (c.type === 'approval' && c.status === 'APPROVED'),
      ),
    );
}

type PlanAction =
  | { kind: 'cancel'; planId: string }
  | { kind: 'repreview'; planId: string }
  | { kind: 'deny'; approvalId: string }
  | { kind: 'dev-approve'; approvalId: string }
  | { kind: 'passkey-approve'; approvalId: string };

type ServerAction = Exclude<PlanAction, { kind: 'passkey-approve' }>;

const path = (a: ServerAction) =>
  a.kind === 'cancel'
    ? `/plans/${a.planId}/cancel`
    : a.kind === 'repreview'
      ? `/plans/${a.planId}/repreview`
      : `/approvals/${a.approvalId}/${a.kind}`;

const SUCCESS: Record<PlanAction['kind'], string> = {
  cancel: 'Cancelled — nothing was traded.',
  repreview: 'Fresh preview ready.',
  deny: 'Denied — nothing was traded.',
  'dev-approve': 'Approved — your agent is executing it.',
  'passkey-approve': 'Approved — your agent is executing it.',
};

export function usePlanAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: PlanAction) =>
      action.kind === 'passkey-approve'
        ? approveWithPasskey(action.approvalId)
        : api(path(action), { method: 'POST', body: {}, schema: z.unknown() }),
    onSuccess: (_data, action) => {
      toast.success(SUCCESS[action.kind]);
    },
    onError: (err, action) => {
      if (action.kind === 'passkey-approve') toast.error(passkeyErrorMessage(err));
      else
        toast.error(
          err instanceof ApiError ? err.message : 'That did not go through. Please try again.',
        );
    },
    onSettled: (_d, _e, action) => {
      void qc.invalidateQueries({ queryKey: agentKeys.messages });
      if ('approvalId' in action)
        void qc.invalidateQueries({ queryKey: ['approval', action.approvalId] });
    },
  });
}

export function useApproval(id: string) {
  return useQuery({
    queryKey: ['approval', id],
    queryFn: ({ signal }) => api(`/approvals/${id}`, { schema: ApprovalViewSchema, signal }),
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });
}
