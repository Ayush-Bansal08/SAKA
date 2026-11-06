/** Hooks explorer, rules and demo price-override data (PHASE 07). */
import {
  HookDetailSchema,
  HookListResponseSchema,
  HookWhatIfSchema,
  PriceOverridesResponseSchema,
  TriggersResponseSchema,
  TriggerViewSchema,
  type HookScope,
} from '@warden/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useOnTraceEvent } from '@/features/portfolio/hooks';
import { api, ApiError } from '@/lib/api';

const noRetry4xx = (count: number, err: Error) =>
  !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2;

export interface HookFilters {
  scope: HookScope;
  band?: 'SAFE' | 'CAUTION' | 'DANGER' | undefined;
  fresh?: boolean;
  q?: string;
  sort: 'new' | 'tvl' | 'score';
}

export function hooksQueryString(f: HookFilters, cursor?: number): string {
  const q = new URLSearchParams({ scope: f.scope, sort: f.sort, limit: '24' });
  if (f.band) q.set('band', f.band);
  if (f.fresh) q.set('fresh', 'true');
  if (f.q?.trim()) q.set('q', f.q.trim());
  if (cursor) q.set('cursor', String(cursor));
  return q.toString();
}

export function useHooks(filters: HookFilters) {
  return useInfiniteQuery({
    queryKey: ['hooks', 'list', filters],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api(`/hooks?${hooksQueryString(filters, pageParam)}`, {
        schema: HookListResponseSchema,
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 60_000,
    retry: noRetry4xx,
  });
}

export function useHook(chainId: number, address: string) {
  return useQuery({
    queryKey: ['hooks', 'one', chainId, address.toLowerCase()],
    queryFn: ({ signal }) =>
      api(`/hooks/${chainId}/${address}`, { schema: HookDetailSchema, signal }),
    retry: noRetry4xx,
  });
}

export function useWhatIf(
  chainId: number,
  address: string,
  pair: string,
  amountUsd: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['hooks', 'what-if', chainId, address.toLowerCase(), pair, amountUsd],
    enabled,
    queryFn: ({ signal }) =>
      api(`/hooks/${chainId}/${address}/what-if?pair=${pair}&amountUsd=${amountUsd}`, {
        schema: HookWhatIfSchema,
        signal,
      }),
    staleTime: 30_000,
    retry: false,
  });
}

export const triggerKeys = { all: ['triggers'] as const };

export function useTriggers() {
  const qc = useQueryClient();
  useOnTraceEvent(
    (e) =>
      e.kind === 'detector' ||
      (e.kind === 'plan' && (e.title === 'Rule set' || e.title === 'Rule cancelled')) ||
      e.title.startsWith('Rule'),
    () => void qc.invalidateQueries({ queryKey: triggerKeys.all }),
  );
  return useQuery({
    queryKey: triggerKeys.all,
    queryFn: ({ signal }) => api('/triggers', { schema: TriggersResponseSchema, signal }),
    refetchInterval: 30_000,
    retry: noRetry4xx,
  });
}

export function useCancelTrigger() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api(`/triggers/${id}/cancel`, { method: 'POST', body: {}, schema: TriggerViewSchema }),
    onSuccess: () => toast.success('Rule cancelled — it will not fire.'),
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not cancel the rule.'),
    onSettled: () => void qc.invalidateQueries({ queryKey: triggerKeys.all }),
  });
}

export function usePriceOverrides() {
  return useQuery({
    queryKey: ['price-overrides'],
    queryFn: ({ signal }) =>
      api('/price-overrides', { schema: PriceOverridesResponseSchema, signal }),
    refetchInterval: 30_000,
    retry: false,
  });
}
