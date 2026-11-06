/**
 * Live activity (PHASE 06 §3): events grouped by traceId into collapsible runs (request text,
 * status pill, duration), filter chips (All / 0G / Uniswap / Safety / Human / Chain), 0G rows with
 * model + trust pill + request ID + TEE, Uniswap MCP tool rows, tx and 0G Storage chips.
 * Old runs render collapsed and off-screen runs skip layout (`content-visibility`), so hundreds of
 * events stay smooth.
 */
import type { TraceEvent } from '@warden/shared';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BadgeCheck,
  ChevronDown,
  ChevronRight,
  Cpu,
  ExternalLink,
  Radio,
} from 'lucide-react';
import { memo, useId, useMemo, useState } from 'react';
import { Badge, EmptyState, HashChip, Panel, SkeletonRows } from '@/components/ui-kit';
import { agentKeys, fetchAgentMessages } from '@/features/agent/hooks';
import { usePlanDrawer } from '@/features/plan/hooks';
import { useNow } from '@/hooks/useNow';
import { formatFullTime, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { KIND_META } from './kind-meta';
import { useTraceStream, type StreamStatus } from './trace-context';
import {
  ACTIVITY_FILTERS,
  eventChips,
  eventMatches,
  formatDuration,
  groupRuns,
  type ActivityFilter,
  type Run,
  type RunStatus,
} from './trace-utils';

const STATUS_META: Record<StreamStatus, { label: string; dot: string; text: string }> = {
  connecting: { label: 'Connecting', dot: 'bg-caution', text: 'text-caution' },
  live: { label: 'Live', dot: 'bg-safe', text: 'text-safe' },
  reconnecting: { label: 'Reconnecting', dot: 'bg-caution', text: 'text-caution' },
  offline: { label: 'Offline', dot: 'bg-danger', text: 'text-danger' },
};

export function StreamStatusPill({
  status,
  compact = false,
}: {
  status: StreamStatus;
  compact?: boolean;
}) {
  const meta = STATUS_META[status];
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={`Activity stream ${meta.label.toLowerCase()}`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs font-medium',
        meta.text,
      )}
    >
      <span className="relative flex size-1.5">
        {status === 'live' && (
          <span
            className={cn(
              'absolute inline-flex size-full animate-ping rounded-full opacity-60',
              meta.dot,
            )}
          />
        )}
        <span className={cn('relative inline-flex size-1.5 rounded-full', meta.dot)} />
      </span>
      <span className={cn(compact && 'sr-only sm:not-sr-only')}>{meta.label}</span>
    </span>
  );
}

const RUN_STATUS: Record<
  RunStatus,
  { label: string; tone: 'info' | 'safe' | 'caution' | 'danger' | 'neutral' | 'agent' }
> = {
  running: { label: 'Running', tone: 'agent' },
  done: { label: 'Done', tone: 'safe' },
  needs_you: { label: 'Needs you', tone: 'caution' },
  refused: { label: 'Refused', tone: 'danger' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Nothing traded', tone: 'neutral' },
  info: { label: 'Info', tone: 'info' },
};

/** Request text per traceId from the chat cache (no extra request). */
function useRequestTexts(): Map<string, string> {
  const { data } = useQuery({
    queryKey: agentKeys.messages,
    enabled: false,
    // Same queryFn as the chat: TanStack uses the latest observer's options for refetches.
    queryFn: fetchAgentMessages,
  });
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const m of data?.messages ?? [])
      if (m.role === 'USER' && m.traceId) map.set(m.traceId, m.text);
    return map;
  }, [data]);
}

/** The right-hand cockpit column: every pipeline step, live, grouped by run. */
export function LiveActivity({
  className,
  embedded = false,
}: {
  className?: string;
  /** Inside a sheet that already has the title: no panel header. */
  embedded?: boolean;
}) {
  const { events, status } = useTraceStream();
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const now = useNow();
  const texts = useRequestTexts();
  const runs = useMemo(() => groupRuns(events), [events]);
  const loading = events.length === 0 && (status === 'connecting' || status === 'reconnecting');

  const visibleRuns = useMemo(
    () =>
      runs
        .map((r) => ({ run: r, shown: r.events.filter((e) => eventMatches(e, filter)) }))
        .filter((x) => x.shown.length > 0),
    [runs, filter],
  );

  return (
    <Panel
      id="live-activity"
      title={embedded ? undefined : 'Live activity'}
      subtitle={embedded ? undefined : 'Every step your agent takes'}
      icon={embedded ? undefined : <Activity />}
      actions={embedded ? undefined : <StreamStatusPill status={status} />}
      className={className}
      bodyClassName="flex min-h-0 flex-col p-0"
    >
      <div
        role="toolbar"
        aria-label="Filter activity"
        className="flex gap-1.5 overflow-x-auto border-b border-border px-3 py-2"
      >
        {ACTIVITY_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              'min-h-8 shrink-0 rounded-full border px-3 py-0.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              filter === f.id
                ? 'border-border-strong bg-surface-3 text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4">
            <SkeletonRows rows={4} label="Connecting to your agent" />
          </div>
        ) : visibleRuns.length === 0 ? (
          <EmptyState
            icon={<Radio />}
            title={
              status === 'offline'
                ? 'Activity feed offline'
                : filter === 'all'
                  ? 'Waiting for your agent'
                  : 'Nothing in this filter yet'
            }
            description={
              status === 'offline'
                ? 'We lost the connection to your agent. It will reconnect automatically.'
                : 'Plans, 0G checks, Uniswap calls, approvals and transactions stream in here as they happen.'
            }
          />
        ) : (
          <ol aria-label="Agent runs" aria-live="polite" className="divide-y divide-border">
            {visibleRuns.map(({ run, shown }, i) => (
              <RunItem
                key={run.traceId}
                run={run}
                events={shown}
                requestText={texts.get(run.traceId) ?? null}
                now={now}
                defaultOpen={i < 2 || run.status === 'running' || run.status === 'needs_you'}
              />
            ))}
          </ol>
        )}
      </div>
    </Panel>
  );
}

const RunItem = memo(function RunItem({
  run,
  events,
  requestText,
  now,
  defaultOpen,
}: {
  run: Run;
  events: TraceEvent[];
  requestText: string | null;
  now: number;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const meta = RUN_STATUS[run.status];
  const planId = useMemo(() => {
    for (const e of run.events) {
      const id = (e.data as { actionPlanId?: unknown } | undefined)?.actionPlanId;
      if (typeof id === 'string') return id;
    }
    return null;
  }, [run.events]);
  const drawer = usePlanDrawer();
  const duration = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  return (
    <li className="[contain-intrinsic-size:auto_96px] [content-visibility:auto]">
      <div className="flex items-start gap-2 px-3 py-2.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-start gap-2 rounded text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ChevronDown
            className={cn(
              'mt-0.5 size-4 shrink-0 text-subtle-foreground transition-transform',
              !open && '-rotate-90',
            )}
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {requestText ? `“${requestText}”` : run.title}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle-foreground">
              <Badge tone={meta.tone}>{meta.label}</Badge>
              <span className="tabular-nums">
                {events.length} step{events.length === 1 ? '' : 's'}
              </span>
              {duration > 0 && <span className="tabular-nums">{formatDuration(duration)}</span>}
              <time dateTime={run.endedAt} title={formatFullTime(run.endedAt)}>
                {formatRelative(run.endedAt, now)}
              </time>
            </span>
          </span>
        </button>
        {planId && (
          <button
            type="button"
            onClick={() => drawer.open(planId)}
            aria-label="Open plan details"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <ChevronRight className="size-4" />
          </button>
        )}
      </div>
      {open && (
        <ol id={bodyId} className="relative pr-3 pb-3 pl-4">
          {events.map((event, i) => (
            <EventRow key={event.id} event={event} now={now} last={i === events.length - 1} />
          ))}
        </ol>
      )}
    </li>
  );
});

export const EventRow = memo(function EventRow({
  event,
  now,
  last,
}: {
  event: TraceEvent;
  now: number;
  last: boolean;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const meta = KIND_META[event.kind];
  const Icon = meta.icon;
  const tool = (event.data as { tool?: unknown } | undefined)?.tool;
  const isTool = event.kind === 'tool_call' || event.kind === 'tool_result';
  const title =
    isTool && typeof tool === 'string'
      ? `Uniswap MCP · ${tool}${event.kind === 'tool_result' ? (/failed/.test(event.title) ? ' failed' : ' ✓') : ''}`
      : event.title;
  const chips = eventChips(event);
  const hasDetails = event.data !== undefined || Boolean(event.zg);

  return (
    <li className="relative flex gap-2.5 pb-3 last:pb-0 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1">
      {!last && <span aria-hidden className="absolute top-7 bottom-0 left-[11px] w-px bg-border" />}
      <span
        aria-hidden
        className={cn(
          'relative z-10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border',
          meta.tone,
        )}
      >
        <Icon className="size-3" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="min-w-0 text-sm leading-5 font-medium [overflow-wrap:anywhere]">
            {title}
          </p>
          <time
            dateTime={event.ts}
            title={formatFullTime(event.ts)}
            className="shrink-0 text-xs text-subtle-foreground tabular-nums tabular-nums"
          >
            {formatRelative(event.ts, now)}
          </time>
        </div>
        {event.detail && (
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
            {event.detail}
          </p>
        )}
        {event.zg && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge icon={<Cpu aria-hidden />}>{event.zg.model}</Badge>
            <Badge tone={event.zg.trustMode === 'private' ? 'zg' : 'info'}>
              {event.zg.trustMode}
            </Badge>
            <HashChip
              tone="zg"
              label="0G"
              value={event.zg.requestId}
              icon={<BadgeCheck className="size-3" aria-hidden />}
            />
            {event.zg.teeVerified && <Badge tone="safe">TEE ✓</Badge>}
          </div>
        )}
        {chips.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <HashChip
                key={c.value}
                label={c.label}
                value={c.value}
                tone={c.label === '0G Storage' ? 'zg' : 'neutral'}
                {...(c.href ? { href: c.href } : {})}
              />
            ))}
          </div>
        )}
        {hasDetails && (
          <div className="mt-1">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => setOpen((v) => !v)}
              className="micro-label inline-flex min-h-6 items-center gap-1 rounded-sm text-subtle-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {open ? 'Hide raw' : 'Raw'}
              {!open && <ExternalLink className="size-3 rotate-90" aria-hidden />}
            </button>
            {open && (
              <pre
                id={detailsId}
                className="mt-1.5 max-h-56 overflow-auto rounded-md border border-border bg-background/60 p-2 font-mono text-xs leading-relaxed text-foreground/80"
              >
                {JSON.stringify(
                  { ...(event.zg ? { zg: event.zg } : {}), data: event.data },
                  null,
                  2,
                )}
              </pre>
            )}
          </div>
        )}
      </div>
    </li>
  );
});
