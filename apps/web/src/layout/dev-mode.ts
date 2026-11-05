import type { ProvidersResponse } from '@warden/shared';

export const DEV_BANNER_TEXT = 'DEV identity — World ID arrives in Phase 10';

/** True whenever DEV identity or approval providers are active. */
export function usesDevProviders(
  p: Pick<ProvidersResponse, 'identity' | 'approvals'> | undefined,
): boolean {
  return p?.identity === 'dev' || p?.approvals === 'dev';
}
