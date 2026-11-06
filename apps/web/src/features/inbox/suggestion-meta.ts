/** Labels and tones for suggestions, shared by the inbox and the chat card. */
import type {
  AutoActDetector,
  SuggestionApprover,
  SuggestionStatus,
  SuggestionView,
} from '@warden/shared';
import type { BadgeTone } from '@/components/ui-kit';

export const STATUS_META: Record<SuggestionStatus, { label: string; tone: BadgeTone }> = {
  OPEN: { label: 'Waiting for you', tone: 'caution' },
  ACCEPTED: { label: 'Accepted', tone: 'agent' },
  DECLINED: { label: 'Declined', tone: 'neutral' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  AUTO_EXECUTED: { label: 'Ran on its own', tone: 'agent' },
  INFO: { label: 'For your information', tone: 'info' },
  FAILED: { label: 'Nothing was traded', tone: 'danger' },
};

/** The plan's result wins once there is one: "Accepted" alone says nothing about the money. */
export function statusPill(s: Pick<SuggestionView, 'status' | 'plan'>): {
  label: string;
  tone: BadgeTone;
} {
  if (s.plan?.status === 'EXECUTED') return { label: 'Executed', tone: 'safe' };
  if (s.plan?.status === 'AWAITING_APPROVAL') return { label: 'Needs approval', tone: 'caution' };
  if (s.plan?.status === 'REFUSED') return { label: 'Refused', tone: 'danger' };
  if (s.plan && ['QUEUED', 'APPROVED', 'EXECUTING'].includes(s.plan.status))
    return { label: 'Executing', tone: 'info' };
  return STATUS_META[s.status];
}

export const APPROVER_LABEL: Record<SuggestionApprover, string> = {
  agent: 'Agent alone',
  you: 'You, one tap',
  verified_human: 'Fresh human check',
};

export const severityTone = (severity: SuggestionView['severity']) =>
  severity === 'RED' ? 'danger' : severity === 'NORMAL' ? 'agent' : 'info';

export function countdown(msLeft: number): string {
  const s = Math.max(0, Math.floor(msLeft / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The lines of a brief ("- " bullets from the model or the template). */
export const briefLines = (message: string) =>
  message
    .split('\n')
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);

export const AUTO_ACT_COPY: Record<AutoActDetector, { label: string; hint: string }> = {
  DIP: { label: 'Dip buys', hint: 'Buy when ETH falls 10% below its 7-day high' },
  PROFIT: { label: 'Take profit', hint: 'Sell 25% of a position up 12% or more' },
  IDLE_USDC: { label: 'Idle USDC', hint: 'Put USDC idle for a day into the best pool' },
  OUT_OF_RANGE: { label: 'Out-of-range LP', hint: 'Re-range a hookless position' },
  BETTER_POOL: { label: 'Better pool', hint: 'Move a hookless position to a better pool' },
};

const FALLBACK_ZONES = ['UTC', 'Asia/Kolkata', 'Europe/London', 'America/New_York'];

/** Every zone the browser knows, plus UTC and the current one. */
export function timeZones(current: string): string[] {
  const all =
    typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : FALLBACK_ZONES;
  // Browsers leave UTC out of the list, so it is added by hand.
  return [...new Set([current, 'UTC', ...all])];
}
