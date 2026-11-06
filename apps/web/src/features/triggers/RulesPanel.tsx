/** Rules (PHASE 07 §4): the human's take-profit / stop-loss / DCA / chained rules with Cancel. */
import type { TriggerView } from '@warden/shared';
import { ChevronDown, Clock, ListTodo, Target } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, ErrorState, SkeletonRows } from '@/components/ui-kit';
import { requestPrefill } from '@/features/agent/prefill';
import { useCancelTrigger, useTriggers } from '@/features/hooks/hooks';
import { useNow } from '@/hooks/useNow';
import { formatFullTime, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

const KIND_LABEL: Record<TriggerView['kind'], string> = {
  TAKE_PROFIT: 'Take profit',
  STOP_LOSS: 'Stop loss',
  DCA: 'DCA',
  CHAINED: 'Chained',
  PRICE_ALERT: 'Alert',
};
const STATUS_TONE = {
  ACTIVE: 'agent',
  FIRED: 'safe',
  FAILED: 'danger',
  CANCELLED: 'neutral',
} as const;

function untilLabel(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return 'due now';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return h ? `in ${h} h ${m} m` : `in ${m} m`;
}

export function RuleRow({ t }: { t: TriggerView }) {
  const cancel = useCancelTrigger();
  const now = useNow(30_000);
  return (
    <li className="rounded-md border border-border bg-surface-2/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="agent">{KIND_LABEL[t.kind]}</Badge>
            <Badge tone={STATUS_TONE[t.status]}>{t.status.toLowerCase()}</Badge>
            {t.chain && (
              <Badge>
                step {Math.min(t.chain.step + 1, t.chain.total)}/{t.chain.total}
              </Badge>
            )}
          </div>
          <p className="mt-1.5 text-[13px] leading-snug [overflow-wrap:anywhere]">{t.summary}</p>
        </div>
        {t.status === 'ACTIVE' && (
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(t.id)}
            aria-label={`Cancel rule: ${t.summary}`}
          >
            Cancel
          </Button>
        )}
      </div>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums">
        {t.targetPriceUsd && t.symbol && (
          <span className="inline-flex items-center gap-1">
            <Target className="size-3" aria-hidden /> {t.symbol}{' '}
            {t.direction === 'above' ? '≥' : '≤'} $
            {Number(t.targetPriceUsd).toLocaleString('en-US')}
          </span>
        )}
        {t.nextRunAt && t.status === 'ACTIVE' && (
          <span className="inline-flex items-center gap-1" title={formatFullTime(t.nextRunAt)}>
            <Clock className="size-3" aria-hidden /> next {untilLabel(t.nextRunAt, now)}
          </span>
        )}
        {t.lastFiredAt && <span>fired {formatRelative(t.lastFiredAt)}</span>}
      </p>
      {t.lastResult && (
        <p
          className={cn(
            'mt-1 text-[11px]',
            /^(Refused|Stopped|Could not)/.test(t.lastResult)
              ? 'text-danger'
              : 'text-subtle-foreground',
          )}
        >
          {t.lastResult}
        </p>
      )}
    </li>
  );
}

export function RulesPanel({
  collapsible = true,
  showClosed = false,
}: {
  collapsible?: boolean;
  showClosed?: boolean;
}) {
  const rules = useTriggers();
  const [open, setOpen] = useState(true);
  const all = rules.data?.triggers ?? [];
  const list = showClosed
    ? all
    : all.filter((t) => t.status === 'ACTIVE' || t.chain?.waitingPlanId);
  const active = all.filter((t) => t.status === 'ACTIVE').length;
  return (
    <section
      aria-labelledby="rules-title"
      className="surface-highlight rounded-lg border border-border bg-card"
    >
      <header className="flex min-h-14 items-center justify-between gap-2 px-5 py-2.5">
        <button
          type="button"
          onClick={() => collapsible && setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-2 rounded text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ListTodo className="size-4 text-muted-foreground" aria-hidden />
          <h3 id="rules-title" className="text-sm font-medium">
            Rules
          </h3>
          {active > 0 && <Badge tone="agent">{active} active</Badge>}
          {collapsible && (
            <ChevronDown
              className={cn(
                'size-4 text-subtle-foreground transition-transform',
                !open && '-rotate-90',
              )}
              aria-hidden
            />
          )}
        </button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => requestPrefill('Sell half if ETH goes up 2%')}
        >
          New rule
        </Button>
      </header>
      {open && (
        <div className="border-t border-border p-4">
          {rules.isPending ? (
            <SkeletonRows rows={2} />
          ) : rules.isError ? (
            <ErrorState
              title="Couldn't load your rules"
              description={rules.error.message}
              onRetry={() => void rules.refetch()}
              retrying={rules.isFetching}
            />
          ) : list.length === 0 ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              No {showClosed ? '' : 'active '}rules. Try “Stop loss at $2,800” or “Buy $10 of ETH
              every day” — every fire runs through the same safety checks.
            </p>
          ) : (
            <ul className="space-y-2">
              {list.map((t) => (
                <RuleRow key={t.id} t={t} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
