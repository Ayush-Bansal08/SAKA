import type { TraceEvent } from '@warden/shared';
import { Activity, BadgeCheck, ChevronDown, Cpu, Radio } from 'lucide-react';
import { memo, useId, useState } from 'react';
import { Badge, EmptyState, HashChip, Panel, SkeletonRows } from '@/components/ui-kit';
import { useNow } from '@/hooks/useNow';
import { formatFullTime, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { KIND_META } from './kind-meta';
import { useTraceStream, type StreamStatus } from './trace-context';

const STATUS_META: Record<StreamStatus, { label: string; dot: string; text: string }> = {
  connecting: { label: 'Connecting', dot: 'bg-caution', text: 'text-caution' },
  live: { label: 'Live', dot: 'bg-safe', text: 'text-safe' },
  reconnecting: { label: 'Reconnecting', dot: 'bg-caution', text: 'text-caution' },
  offline: { label: 'Offline', dot: 'bg-danger', text: 'text-danger' },
};

export function StreamStatusPill({ status }: { status: StreamStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium',
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
      {meta.label}
    </span>
  );
}

/** The right-hand cockpit column: every pipeline step, live. */
export function LiveActivity({ className }: { className?: string }) {
  const { events, status } = useTraceStream();
  const now = useNow();
  const loading = events.length === 0 && (status === 'connecting' || status === 'reconnecting');

  return (
    <Panel
      id="live-activity"
      title="Live activity"
      subtitle="Every step your agent takes"
      icon={<Activity />}
      actions={<StreamStatusPill status={status} />}
      className={className}
      bodyClassName="overflow-y-auto p-0"
    >
      {loading ? (
        <div className="p-4">
          <SkeletonRows rows={4} label="Connecting to your agent" />
        </div>
      ) : events.length === 0 ? (
        <EmptyState
          icon={<Radio />}
          title={status === 'offline' ? 'Activity feed offline' : 'Waiting for your agent'}
          description={
            status === 'offline'
              ? 'We lost the connection to your agent. It will reconnect automatically.'
              : 'Plans, safety checks, approvals and transactions will stream in here as they happen.'
          }
        />
      ) : (
        <ol aria-label="Agent activity timeline" className="relative px-4 py-3">
          {events.map((event, i) => (
            <TimelineItem key={event.id} event={event} now={now} last={i === events.length - 1} />
          ))}
        </ol>
      )}
    </Panel>
  );
}

const TimelineItem = memo(function TimelineItem({
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
  const hasDetails = event.data !== undefined || Boolean(event.zg);

  return (
    <li className="relative flex gap-3 pb-4 last:pb-1 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1">
      {!last && <span aria-hidden className="absolute top-8 bottom-0 left-[13px] w-px bg-border" />}
      <span
        aria-hidden
        className={cn(
          'relative z-10 mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border',
          meta.tone,
        )}
      >
        <Icon className="size-3.5" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="min-w-0 text-sm leading-5 font-medium text-foreground">{event.title}</p>
          <time
            dateTime={event.ts}
            title={formatFullTime(event.ts)}
            className="shrink-0 text-[11px] text-subtle-foreground tabular"
          >
            {formatRelative(event.ts, now)}
          </time>
        </div>
        <p className="mt-0.5 text-[11px] font-medium tracking-wide text-subtle-foreground uppercase">
          {meta.label}
        </p>
        {event.detail && (
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
            {event.detail}
          </p>
        )}

        {event.zg && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <HashChip
              tone="zg"
              label="0G"
              value={event.zg.requestId}
              icon={<BadgeCheck className="size-3" aria-hidden />}
            />
            <Badge icon={<Cpu aria-hidden />}>{event.zg.model}</Badge>
            <Badge tone={event.zg.trustMode === 'private' ? 'zg' : 'info'}>
              {event.zg.trustMode}
            </Badge>
            {event.zg.teeVerified && <Badge tone="safe">TEE verified</Badge>}
          </div>
        )}

        {hasDetails && (
          <div className="mt-2">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDown
                className={cn('size-3.5 transition-transform', open && 'rotate-180')}
                aria-hidden
              />
              {open ? 'Hide details' : 'Details'}
            </button>
            {open && (
              <pre
                id={detailsId}
                className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-background/60 p-2.5 font-mono text-[11px] leading-relaxed text-foreground/80"
              >
                {JSON.stringify(
                  {
                    traceId: event.traceId,
                    ...(event.zg ? { zg: event.zg } : {}),
                    data: event.data,
                  },
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
