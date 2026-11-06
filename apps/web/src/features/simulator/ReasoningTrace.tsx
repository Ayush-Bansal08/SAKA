/** The real trace of one run: the same events and rows the live activity feed shows. */
import { Workflow } from 'lucide-react';
import { EmptyState, ErrorState, Panel, SkeletonRows } from '@/components/ui-kit';
import { useTraceEvents } from '@/features/plan/hooks';
import { EventRow } from '@/features/trace/LiveActivity';
import { useNow } from '@/hooks/useNow';
import { ModeBadge } from './ModeBadge';

export function ReasoningTrace({ runId }: { runId: string | null }) {
  const trace = useTraceEvents(runId);
  const now = useNow(10_000);
  const events = trace.data?.events ?? [];
  return (
    <Panel
      title="Live trace"
      subtitle="Each step appears when the code really runs it"
      icon={<Workflow />}
      actions={<ModeBadge mode="SIMULATED" />}
    >
      {!runId ? (
        <EmptyState
          className="py-6"
          icon={<Workflow />}
          title="No run yet"
          description="Trigger a scenario to watch your agent investigate it."
        />
      ) : trace.isPending ? (
        <SkeletonRows rows={4} label="Loading the trace" />
      ) : trace.isError ? (
        <ErrorState
          title="Couldn't load the trace"
          description={trace.error.message}
          onRetry={() => void trace.refetch()}
          retrying={trace.isFetching}
        />
      ) : (
        <ol aria-label="Run trace">
          {events.map((event, i) => (
            <EventRow key={event.id} event={event} now={now} last={i === events.length - 1} />
          ))}
        </ol>
      )}
    </Panel>
  );
}
