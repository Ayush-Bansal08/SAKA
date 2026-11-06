/** One inbox suggestion, and the pinned morning brief (PHASE 08 §3). */
import type { SuggestionView } from '@warden/shared';
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  Clock,
  ExternalLink,
  Fingerprint,
  Info,
  Lightbulb,
  Pencil,
  Sunrise,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, Panel, ZgVerifiedBadge } from '@/components/ui-kit';
import { scoreTone, usd } from '@/features/agent/cards/card-utils';
import { usePlanDrawer } from '@/features/plan/hooks';
import { useNow } from '@/hooks/useNow';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useSuggestionAction } from './hooks';
import { APPROVER_LABEL, briefLines, countdown, severityTone, statusPill } from './suggestion-meta';

const SEVERITY_ICON = { RED: AlertTriangle, NORMAL: Lightbulb, INFO: Info } as const;

const ICON_TONE = {
  danger: 'border-danger/30 bg-danger/10 text-danger',
  agent: 'border-agent/30 bg-agent/10 text-agent',
  info: 'border-info/30 bg-info/10 text-info',
} as const;

export function SuggestionRow({ s }: { s: SuggestionView }) {
  const action = useSuggestionAction();
  const drawer = usePlanDrawer();
  const now = useNow(1000);
  const tone = severityTone(s.severity);
  const Icon = SEVERITY_ICON[s.severity];
  const pill = statusPill(s);
  const plan = s.plan;
  const msLeft = s.expiresAt ? Date.parse(s.expiresAt) - now : null;
  const expired = msLeft !== null && msLeft <= 0;
  const human = plan?.approver === 'verified_human';
  const act = (kind: 'accept' | 'decline' | 'change') => action.mutate({ id: s.id, action: kind });

  return (
    <li
      aria-label={s.title}
      className={cn(
        'flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start',
        s.severity === 'RED' && 'border-l-2 border-l-danger bg-danger/[0.04]',
      )}
    >
      <span
        className={cn(
          'hidden size-9 shrink-0 items-center justify-center rounded-full border sm:flex',
          ICON_TONE[tone],
        )}
        aria-hidden
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="font-medium [overflow-wrap:anywhere]">{s.title}</p>
          {s.severity === 'RED' && <Badge tone="danger">Red alert</Badge>}
          {s.simulated && <Badge tone="warm">Simulated (demo)</Badge>}
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {s.message}
        </p>
        {s.note && (
          <p className="mt-1 text-sm text-foreground/85 [overflow-wrap:anywhere]">{s.note}</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          {plan && (
            <span className="text-base font-semibold tabular-nums">{usd(plan.amountUsd)}</span>
          )}
          <Badge tone={pill.tone}>{pill.label}</Badge>
          {plan?.tradeScore !== null && plan?.tradeScore !== undefined && (
            <Badge tone={scoreTone(plan.tradeScore)}>Trade {plan.tradeScore}/100</Badge>
          )}
          {plan?.hookScore !== null && plan?.hookScore !== undefined && (
            <Badge tone={scoreTone(plan.hookScore)}>Hook {plan.hookScore}/100</Badge>
          )}
          {plan && (
            <Badge
              tone={human ? 'human' : 'agent'}
              icon={human ? <Fingerprint aria-hidden /> : <Bot aria-hidden />}
            >
              {APPROVER_LABEL[plan.approver]}
            </Badge>
          )}
          {msLeft !== null && !expired && (
            <Badge tone={msLeft < 60_000 ? 'danger' : 'neutral'} icon={<Clock aria-hidden />}>
              <span className="tabular-nums">{countdown(msLeft)} left</span>
            </Badge>
          )}
          {s.zg && <ZgVerifiedBadge title={`0G request ${s.zg.requestId}`} />}
          <span className="text-subtle-foreground">{formatRelative(s.createdAt, now)}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        {s.actions.includes('yes') && (
          <Button size="sm" disabled={action.isPending || expired} onClick={() => act('accept')}>
            <Check aria-hidden /> Yes
          </Button>
        )}
        {s.actions.includes('change') && (
          <Button
            size="sm"
            variant="secondary"
            disabled={action.isPending || expired}
            onClick={() => act('change')}
          >
            <Pencil aria-hidden /> Change
          </Button>
        )}
        {s.actions.includes('no') && (
          <Button
            size="sm"
            variant="outline"
            disabled={action.isPending || expired}
            onClick={() => act('decline')}
          >
            <X aria-hidden /> No
          </Button>
        )}
        {plan?.tx?.explorerUrl && (
          <Button size="sm" variant="ghost" asChild>
            <a href={plan.tx.explorerUrl} target="_blank" rel="noreferrer">
              Transaction <ExternalLink aria-hidden />
            </a>
          </Button>
        )}
        {plan && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => drawer.open(plan.id)}
            aria-label={`Open plan details for ${s.title}`}
          >
            Details <ChevronRight aria-hidden />
          </Button>
        )}
      </div>
    </li>
  );
}

export function BriefCard({ brief }: { brief: SuggestionView }) {
  const now = useNow(60_000);
  return (
    <Panel
      title={brief.title || 'Morning brief'}
      subtitle={`Pinned · ${formatRelative(brief.createdAt, now)}`}
      icon={<Sunrise />}
      actions={
        <span className="flex items-center gap-1.5">
          {brief.simulated && <Badge tone="warm">Simulated (demo)</Badge>}
          {brief.zg && <ZgVerifiedBadge title={`0G request ${brief.zg.requestId}`} />}
        </span>
      }
    >
      <ul className="space-y-1.5 text-sm">
        {briefLines(brief.message).map((line, i) => (
          <li key={i} className="flex gap-2 [overflow-wrap:anywhere]">
            <span className="mt-[7px] size-1 shrink-0 rounded-full bg-agent" aria-hidden />
            {line}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
