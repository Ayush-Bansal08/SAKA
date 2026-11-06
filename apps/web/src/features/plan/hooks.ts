/**
 * Plan data for the drawer, the Activity page and the inbox. The drawer opens from the
 * `?plan=<id>` search param, so every card, table row and shared link can open it.
 */
import {
  DecisionLogViewSchema,
  PendingApprovalsResponseSchema,
  PlanListResponseSchema,
  PlanViewSchema,
  TraceEventsResponseSchema,
  type PlanListItem,
  type PlanOutcome,
  type TraceEvent,
} from '@warden/shared';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { useOnTraceEvent } from '@/features/portfolio/hooks';
import { api, ApiError } from '@/lib/api';

export const planKeys = {
  all: ['plans'] as const,
  list: (f: PlanFilters) => ['plans', 'list', f] as const,
  one: (id: string) => ['plans', 'one', id] as const,
  trace: (traceId: string) => ['plans', 'trace', traceId] as const,
  log: (id: string) => ['plans', 'log', id] as const,
  pending: ['approvals', 'pending'] as const,
};

const noRetry4xx = (count: number, err: Error) =>
  !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2;

/** Trace events that change a plan's state (refresh drawer, activity and inbox). */
export function changesPlans(e: TraceEvent): boolean {
  return (
    e.kind === 'policy' ||
    e.kind === 'approval' ||
    e.kind === 'receipt' ||
    e.kind === 'log' ||
    e.kind === 'error' ||
    (e.kind === 'tx' && e.title === 'Executing')
  );
}

export function usePlan(id: string | null) {
  const qc = useQueryClient();
  useOnTraceEvent(changesPlans, () => {
    if (id) void qc.invalidateQueries({ queryKey: planKeys.one(id) });
  });
  return useQuery({
    queryKey: planKeys.one(id ?? ''),
    enabled: Boolean(id),
    queryFn: ({ signal }) => api(`/plans/${id}`, { schema: PlanViewSchema, signal }),
    retry: noRetry4xx,
  });
}

export function useTraceEvents(traceId: string | null | undefined) {
  const qc = useQueryClient();
  useOnTraceEvent(
    (e) => e.traceId === traceId,
    () => {
      if (traceId) void qc.invalidateQueries({ queryKey: planKeys.trace(traceId) });
    },
  );
  return useQuery({
    queryKey: planKeys.trace(traceId ?? ''),
    enabled: Boolean(traceId),
    queryFn: ({ signal }) =>
      api(`/traces/${traceId}/events`, { schema: TraceEventsResponseSchema, signal }),
    retry: noRetry4xx,
  });
}

export function useDecisionLog(planId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: planKeys.log(planId ?? ''),
    enabled: Boolean(planId) && enabled,
    queryFn: ({ signal }) =>
      api(`/decision-logs/${planId}`, { schema: DecisionLogViewSchema, signal }),
    retry: false,
  });
}

export interface PlanFilters {
  outcome?: PlanOutcome | undefined;
  type?: string | undefined;
  /** Inclusive start day (YYYY-MM-DD, local). */
  from?: string | undefined;
}

export function plansQueryString(f: PlanFilters, cursor?: string): string {
  const q = new URLSearchParams({ limit: '50' });
  if (f.outcome) q.set('outcome', f.outcome);
  if (f.type) q.set('type', f.type);
  if (f.from) q.set('from', new Date(`${f.from}T00:00:00`).toISOString());
  if (cursor) q.set('cursor', cursor);
  return q.toString();
}

export function usePlans(filters: PlanFilters) {
  const qc = useQueryClient();
  useOnTraceEvent(changesPlans, () => {
    void qc.invalidateQueries({ queryKey: ['plans', 'list'] });
  });
  return useInfiniteQuery({
    queryKey: planKeys.list(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api(`/plans?${plansQueryString(filters, pageParam)}`, {
        schema: PlanListResponseSchema,
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: noRetry4xx,
  });
}

export function usePendingApprovals() {
  const qc = useQueryClient();
  useOnTraceEvent(
    (e) => e.kind === 'approval' || e.kind === 'policy',
    () => void qc.invalidateQueries({ queryKey: planKeys.pending }),
  );
  return useQuery({
    queryKey: planKeys.pending,
    queryFn: ({ signal }) =>
      api('/approvals/pending', { schema: PendingApprovalsResponseSchema, signal }),
    // Expiry is time-based: re-check every 20 s even without events.
    refetchInterval: 20_000,
    retry: noRetry4xx,
  });
}

/** Open / close the plan drawer (search param `plan`). */
export function usePlanDrawer() {
  const [params, setParams] = useSearchParams();
  const planId = params.get('plan');
  const open = useCallback(
    (id: string) =>
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          next.set('plan', id);
          return next;
        },
        { preventScrollReset: true },
      ),
    [setParams],
  );
  const close = useCallback(
    () =>
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          next.delete('plan');
          return next;
        },
        { preventScrollReset: true },
      ),
    [setParams],
  );
  return { planId, open, close };
}

// --- Activity page helpers (pure, unit-tested) -------------------------------------------------

export const OUTCOME_META: Record<
  PlanOutcome,
  { label: string; tone: 'safe' | 'danger' | 'caution' | 'neutral' | 'info' }
> = {
  EXECUTED: { label: 'Executed', tone: 'safe' },
  REFUSED: { label: 'Refused', tone: 'danger' },
  DENIED: { label: 'Denied', tone: 'neutral' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  FAILED: { label: 'Failed', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  PENDING: { label: 'In progress', tone: 'info' },
};

export const TYPE_LABEL: Record<string, string> = {
  swap_exact_in: 'Swap',
  swap_exact_out: 'Exact-out swap',
  swap_and_send: 'Swap & send',
  transfer: 'Transfer',
  lp_open: 'Add liquidity',
  lp_rebalance: 'Rebalance',
  lp_exit: 'Exit liquidity',
  create_trigger: 'Trigger',
  cancel_trigger: 'Cancel trigger',
};

const csvCell = (v: string | number | null) => {
  const s = v === null ? '' : String(v);
  // Quote everything; neutralise spreadsheet formulas (CSV injection).
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export function plansToCsv(rows: readonly PlanListItem[]): string {
  const header = [
    'time',
    'request',
    'type',
    'amount_usd',
    'outcome',
    'approved_by',
    'trade_score',
    'tx_hash',
    'tx_url',
    'zg_root_hash',
    'plan_id',
  ];
  const lines = rows.map((r) =>
    [
      r.createdAt,
      r.requestText ?? r.summary,
      TYPE_LABEL[r.type] ?? r.type,
      r.amountUsd,
      OUTCOME_META[r.outcome].label,
      r.approvedBy === 'HUMAN' ? 'Verified human' : r.approvedBy === 'AGENT' ? 'Agent' : '',
      r.tradeScore,
      r.tx?.hash ?? null,
      r.tx?.explorerUrl ?? null,
      r.decisionLog?.rootHash ?? null,
      r.id,
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\r\n');
}
