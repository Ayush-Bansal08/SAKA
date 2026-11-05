import {
  MeResponseSchema,
  ProvidersResponseSchema,
  SignInResponseSchema,
  type ProvidersResponse,
  type UserView,
} from '@warden/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import { session } from '@/lib/session';

export const queryKeys = {
  providers: ['auth', 'providers'] as const,
  me: ['me'] as const,
};

/** Reactive session token. */
export function useSessionToken(): string | null {
  return useSyncExternalStore(
    (cb) => session.subscribe(cb),
    () => session.token(),
    () => null,
  );
}

export function useProviders() {
  return useQuery<ProvidersResponse>({
    queryKey: queryKeys.providers,
    queryFn: ({ signal }) =>
      api('/auth/providers', { schema: ProvidersResponseSchema, signal, anonymous: true }),
    staleTime: Infinity,
    retry: 1,
  });
}

export function useMe(enabled: boolean) {
  return useQuery<UserView>({
    queryKey: queryKeys.me,
    queryFn: async ({ signal }) => (await api('/me', { schema: MeResponseSchema, signal })).user,
    enabled,
    staleTime: 60_000,
    retry: (count, err) =>
      !(err instanceof Error && 'status' in err && err.status === 401) && count < 2,
  });
}

export function useDevSignIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (displayName: string) =>
      api('/auth/dev/sign-in', {
        method: 'POST',
        body: { displayName },
        schema: SignInResponseSchema,
        anonymous: true,
      }),
    onSuccess: (res) => {
      qc.setQueryData(queryKeys.me, res.user);
      session.set({ token: res.token, expiresAt: res.expiresAt });
    },
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      try {
        await api('/auth/sign-out', { method: 'POST' });
      } catch {
        // Sign out locally even if the API is unreachable; the token expires server-side.
      }
    },
    onSettled: () => {
      session.clear();
      qc.removeQueries({ queryKey: queryKeys.me });
    },
  });
}
