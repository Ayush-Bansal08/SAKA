/**
 * Activity (PHASE 06 §4): every action plan — time, request, type, amount, outcome, who approved,
 * trade score, tx link, 0G log. Filters (outcome / type / date), "Refused" shows the agent saying
 * no, row → plan drawer, CSV export of the whole filtered history.
 */
import {
  PLAN_OUTCOMES,
  PlanListResponseSchema,
  type PlanListItem,
  type PlanOutcome,
} from '@warden/shared';
import { Bot, ChevronDown, Download, Fingerprint, History, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, ErrorState, HashChip, Panel, SkeletonRows } from '@/components/ui-kit';
import { scoreTone, usd } from '@/features/agent/cards/card-utils';
import { DecisionLogChip } from '@/features/agent/cards/parts';
import {
  OUTCOME_META,
  plansQueryString,
  plansToCsv,
  TYPE_LABEL,
  usePlanDrawer,
  usePlans,
  type PlanFilters,
} from '@/features/plan/hooks';
import { ModeBadge } from '@/features/simulator/ModeBadge';
import { api } from '@/lib/api';
import { formatFullTime, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PageContainer, PageHeader } from './PageHeader';

const EXPORT_MAX_ROWS = 2_000;
const SCORE_TEXT = { safe: 'text-safe', caution: 'text-caution', danger: 'text-danger' } as const;

function ApprovedBy({ who }: { who: PlanListItem['approvedBy'] }) {
  if (who === 'HUMAN')
    return (
      <Badge tone="human" icon={<Fingerprint aria-hidden />}>
        Human
      </Badge>
    );
  if (who === 'AGENT')
    return (
      <Badge tone="agent" icon={<Bot aria-hidden />}>
        Agent
      </Badge>
    );
  return <span className="text-subtle-foreground">—</span>;
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const id = `filter-${label.toLowerCase()}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="micro-label text-subtle-foreground">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 rounded-md border border-input bg-surface-2 px-3 text-sm md:h-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ActivityRow({
  r,
  open,
  onToggle,
  onOpen,
}: {
  r: PlanListItem;
  open: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <>
      <tr
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('a,button')) return;
          onOpen();
        }}
        className={cn(
          'cursor-pointer border-border/60 transition-colors hover:bg-surface-2/60',
          !open && 'border-b last:border-b-0',
        )}
      >
        <td className="px-5 py-2.5 font-mono text-[11px] whitespace-nowrap text-subtle-foreground">
          <time dateTime={r.createdAt} title={formatFullTime(r.createdAt)}>
            {formatRelative(r.createdAt)}
          </time>
        </td>
        <td className="max-w-[320px] px-2 py-2.5">
          <button
            type="button"
            onClick={onOpen}
            className="block max-w-full truncate rounded-sm text-left font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            title={r.requestText ?? r.summary}
          >
            {r.requestText ?? r.summary}
          </button>
        </td>
        <td className="px-2 py-2.5 text-right font-medium tabular-nums">{usd(r.amountUsd)}</td>
        <td className="px-2 py-2.5">
          <Badge tone={OUTCOME_META[r.outcome].tone}>{OUTCOME_META[r.outcome].label}</Badge>
        </td>
        <td className="px-2 py-2.5">
          <ApprovedBy who={r.approvedBy} />
        </td>
        <td className="px-5 py-2.5">
          <span className="flex items-center justify-between gap-2">
            <ModeBadge mode={r.simulated ? 'SIMULATED' : 'LIVE'} />
            <button
              type="button"
              aria-expanded={open}
              aria-label={`${open ? 'Hide' : 'Show'} proofs for ${r.requestText ?? r.summary}`}
              onClick={onToggle}
              className="inline-flex size-7 items-center justify-center rounded-full text-subtle-foreground hover:bg-surface-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <ChevronDown
                className={cn('size-4 transition-transform duration-150', !open && '-rotate-90')}
                aria-hidden
              />
            </button>
          </span>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border/60 last:border-b-0">
          <td colSpan={6} className="px-5 pt-0 pb-3">
            <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md bg-surface-2/50 px-3.5 py-2.5 text-xs">
              <div className="flex items-center gap-2">
                <dt className="micro-label text-subtle-foreground">Type</dt>
                <dd>{TYPE_LABEL[r.type] ?? r.type}</dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="micro-label text-subtle-foreground">Score</dt>
                <dd>
                  {r.tradeScore !== null ? (
                    <span
                      className={cn(
                        'font-medium tabular-nums',
                        SCORE_TEXT[scoreTone(r.tradeScore)],
                      )}
                    >
                      {r.tradeScore}
                    </span>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="micro-label text-subtle-foreground">Tx</dt>
                <dd>
                  {r.tx ? (
                    <HashChip value={r.tx.hash} href={r.tx.explorerUrl} head={6} tail={4} />
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="micro-label text-subtle-foreground">0G log</dt>
                <dd>{r.decisionLog ? <DecisionLogChip log={r.decisionLog} /> : '—'}</dd>
              </div>
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

export function ActivityPage() {
  const [filters, setFilters] = useState<PlanFilters>({});
  const [exporting, setExporting] = useState(false);
  const plans = usePlans(filters);
  const drawer = usePlanDrawer();
  const rows = useMemo(() => plans.data?.pages.flatMap((p) => p.plans) ?? [], [plans.data]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all: PlanListItem[] = [];
      let cursor: string | undefined;
      do {
        const page = await api(`/plans?${plansQueryString(filters, cursor)}`, {
          schema: PlanListResponseSchema,
        });
        all.push(...page.plans);
        cursor = page.nextCursor ?? undefined;
      } while (cursor && all.length < EXPORT_MAX_ROWS);
      const blob = new Blob([plansToCsv(all)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `saka-activity-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${all.length} action${all.length === 1 ? '' : 's'}.`);
    } catch {
      toast.error('Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  const filtered = Boolean(filters.outcome || filters.type || filters.from);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Activity"
        title="Everything it did,"
        accent="and refused to do"
        description="With on-chain and 0G proofs for every action."
      />
      <Panel
        title="All actions"
        icon={<History />}
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => void exportCsv()}
            disabled={exporting || rows.length === 0}
          >
            {exporting ? <Loader2 className="animate-spin" /> : <Download />} Export CSV
          </Button>
        }
        bodyClassName="p-0"
      >
        <div className="flex flex-wrap items-end gap-3 border-b border-border px-5 py-3.5">
          <Select
            label="Outcome"
            value={filters.outcome ?? ''}
            onChange={(v) =>
              setFilters((f) => ({ ...f, outcome: (v || undefined) as PlanOutcome | undefined }))
            }
            options={[
              { value: '', label: 'All outcomes' },
              ...PLAN_OUTCOMES.map((o) => ({ value: o, label: OUTCOME_META[o].label })),
            ]}
          />
          <Select
            label="Type"
            value={filters.type ?? ''}
            onChange={(v) => setFilters((f) => ({ ...f, type: v || undefined }))}
            options={[
              { value: '', label: 'All types' },
              ...Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label })),
            ]}
          />
          <div className="flex flex-col gap-1">
            <label htmlFor="filter-from" className="micro-label text-subtle-foreground">
              Since
            </label>
            <input
              id="filter-from"
              type="date"
              value={filters.from ?? ''}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value || undefined }))}
              className="h-11 rounded-md border border-input bg-surface-2 px-3 text-sm md:h-10 [color-scheme:dark] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            />
          </div>
          <div className="flex flex-wrap gap-1.5 pb-1">
            {(['REFUSED', 'EXECUTED'] as const).map((o) => (
              <button
                key={o}
                type="button"
                aria-pressed={filters.outcome === o}
                onClick={() =>
                  setFilters((f) => ({ ...f, outcome: f.outcome === o ? undefined : o }))
                }
                className={cn(
                  'min-h-9 rounded-full border px-3 py-1 text-xs font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  filters.outcome === o
                    ? o === 'REFUSED'
                      ? 'border-danger/50 bg-danger/10 text-danger'
                      : 'border-safe/50 bg-safe/10 text-safe'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {o === 'REFUSED' ? 'When it said no' : 'Executed only'}
              </button>
            ))}
            {filtered && (
              <Button size="sm" variant="ghost" onClick={() => setFilters({})}>
                Clear
              </Button>
            )}
          </div>
        </div>

        {plans.isPending ? (
          <div className="p-4">
            <SkeletonRows rows={6} label="Loading activity" />
          </div>
        ) : plans.isError ? (
          <ErrorState
            className="py-10"
            title="Couldn't load your activity"
            description={plans.error.message}
            onRetry={() => void plans.refetch()}
            retrying={plans.isFetching}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<History />}
            title={filtered ? 'Nothing matches these filters' : 'No actions yet'}
            description={
              filtered
                ? 'Try another outcome, type or date.'
                : 'Ask your agent to swap or check a token — every decision lands here with its proofs.'
            }
          />
        ) : (
          <>
            {/* Desktop / tablet table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Your agent's actions, newest first</caption>
                <thead className="border-b border-border">
                  <tr className="micro-label text-subtle-foreground">
                    <th scope="col" className="px-5 py-2.5 font-normal">
                      Time
                    </th>
                    <th scope="col" className="px-2 py-2.5 font-normal">
                      Request
                    </th>
                    <th scope="col" className="px-2 py-2.5 text-right font-normal">
                      Amount
                    </th>
                    <th scope="col" className="px-2 py-2.5 font-normal">
                      Outcome
                    </th>
                    <th scope="col" className="px-2 py-2.5 font-normal">
                      Approved by
                    </th>
                    <th scope="col" className="px-5 py-2.5 font-normal">
                      Source
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <ActivityRow
                      key={r.id}
                      r={r}
                      open={expanded.has(r.id)}
                      onToggle={() => toggle(r.id)}
                      onOpen={() => drawer.open(r.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile list */}
            <ul className="divide-y divide-border md:hidden">
              {rows.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => drawer.open(r.id)}
                    className="flex w-full flex-col gap-1.5 px-5 py-3 text-left hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">
                        {r.requestText ?? r.summary}
                      </span>
                      <span className="shrink-0 font-semibold tabular-nums">
                        {usd(r.amountUsd)}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <Badge tone={OUTCOME_META[r.outcome].tone}>
                        {OUTCOME_META[r.outcome].label}
                      </Badge>
                      <ModeBadge mode={r.simulated ? 'SIMULATED' : 'LIVE'} />
                      <ApprovedBy who={r.approvedBy} />
                      <span>{TYPE_LABEL[r.type] ?? r.type}</span>
                      <span>· {formatRelative(r.createdAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {plans.hasNextPage && (
              <div className="flex justify-center border-t border-border p-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void plans.fetchNextPage()}
                  disabled={plans.isFetchingNextPage}
                >
                  {plans.isFetchingNextPage && <Loader2 className="animate-spin" />} Load more
                </Button>
              </div>
            )}
          </>
        )}
      </Panel>
    </PageContainer>
  );
}
