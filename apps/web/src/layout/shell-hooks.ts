import { AUTO_ACT_DETECTORS } from '@warden/shared';
import { useSuggestions } from '@/features/inbox/hooks';
import { usePendingApprovals } from '@/features/plan/hooks';
import { useSettings } from '@/features/portfolio/hooks';

/** Everything waiting for the human: approvals plus open suggestions. */
export function usePendingCount(): number {
  const approvals = usePendingApprovals().data?.approvals.length ?? 0;
  return approvals + (useSuggestions().data?.openCount ?? 0);
}

/** How many of the five auto-act switches are on: the honest "Autopilot" status. */
export function useAutoActCount(): { on: number; total: number } | null {
  const settings = useSettings();
  if (!settings.data) return null;
  const on = AUTO_ACT_DETECTORS.filter((d) => settings.data.autoAct[d]).length;
  return { on, total: AUTO_ACT_DETECTORS.length };
}
