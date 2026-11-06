import {
  OnboardingResponseSchema,
  PortfolioResponseSchema,
  SettingsResponseSchema,
  type OnboardingResponse,
  type PortfolioResponse,
  type RiskProfile,
  type SettingsResponse,
  type TraceEvent,
} from '@warden/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { queryKeys as authKeys } from '@/features/auth/hooks';
import { useTraceStream } from '@/features/trace/trace-context';
import { api, ApiError } from '@/lib/api';

export const walletKeys = {
  onboarding: ['onboarding'] as const,
  portfolio: ['portfolio'] as const,
  settings: ['settings'] as const,
};

export const PORTFOLIO_POLL_MS = 15_000;

/** Trace events that change balances, the onboarding step or limit usage. */
export function affectsPortfolio(e: TraceEvent): boolean {
  return (
    e.kind === 'receipt' ||
    e.kind === 'tx' ||
    (e.kind === 'system' && e.title === 'Agent wallet created') ||
    (e.kind === 'policy' && e.title.startsWith('Risk profile'))
  );
}

/** Calls `onMatch` once for each new matching event that arrives on the live stream. */
export function useOnTraceEvent(predicate: (e: TraceEvent) => boolean, onMatch: () => void): void {
  const { events } = useTraceStream();
  const seen = useRef<string | null | undefined>(undefined);
  const predicateRef = useRef(predicate);
  const onMatchRef = useRef(onMatch);
  predicateRef.current = predicate;
  onMatchRef.current = onMatch;

  useEffect(() => {
    let latest: TraceEvent | undefined;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (predicateRef.current(events[i]!)) {
        latest = events[i];
        break;
      }
    }
    const id = latest?.id ?? null;
    // First render: remember what is already there (replayed history), react only to new ones.
    if (seen.current === undefined) {
      seen.current = id;
      return;
    }
    if (id !== null && id !== seen.current) {
      seen.current = id;
      onMatchRef.current();
    }
  }, [events]);
}

const noRetryOn4xx = (count: number, err: unknown) =>
  !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2;

export function useOnboarding(options: { pollWhileFundingMs?: number } = {}) {
  return useQuery<OnboardingResponse>({
    queryKey: walletKeys.onboarding,
    queryFn: ({ signal }) => api('/onboarding', { schema: OnboardingResponseSchema, signal }),
    // Poll only while waiting for the deposit (the trace stream usually beats the poll).
    refetchInterval: (q) =>
      q.state.data?.step === 'FUND' && options.pollWhileFundingMs
        ? options.pollWhileFundingMs
        : false,
    staleTime: 5_000,
    retry: noRetryOn4xx,
  });
}

function useOnboardingMutation<V>(path: string, toBody: (v: V) => unknown) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: V) =>
      api(path, { method: 'POST', body: toBody(v), schema: OnboardingResponseSchema }),
    onSuccess: (data) => {
      qc.setQueryData(walletKeys.onboarding, data);
      void qc.invalidateQueries({ queryKey: authKeys.me });
      void qc.invalidateQueries({ queryKey: walletKeys.settings });
      void qc.invalidateQueries({ queryKey: walletKeys.portfolio });
    },
  });
}

export function useCreateWallet() {
  return useOnboardingMutation<void>('/onboarding/wallet', () => ({}));
}

export function useChooseProfile() {
  return useOnboardingMutation<RiskProfile>('/onboarding/profile', (riskProfile) => ({
    riskProfile,
  }));
}

export function usePortfolio(enabled = true) {
  const query = useQuery<PortfolioResponse>({
    queryKey: walletKeys.portfolio,
    queryFn: ({ signal }) => api('/portfolio', { schema: PortfolioResponseSchema, signal }),
    enabled,
    refetchInterval: PORTFOLIO_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
    retry: noRetryOn4xx,
  });
  useOnTraceEvent(affectsPortfolio, () => void query.refetch());
  return query;
}

export function useSettings() {
  return useQuery<SettingsResponse>({
    queryKey: walletKeys.settings,
    queryFn: ({ signal }) => api('/settings', { schema: SettingsResponseSchema, signal }),
    staleTime: 30_000,
    retry: noRetryOn4xx,
  });
}
