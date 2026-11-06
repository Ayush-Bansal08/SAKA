/** Simulator data. Runs refresh on their own trace events, with a slow poll as the safety net. */
import {
  SimulatorRunViewSchema,
  SimulatorRunsResponseSchema,
  SimulatorScenariosResponseSchema,
  type SimulatorMode,
  type SimulatorRunView,
  type SimulatorScenarioId,
  type TraceEvent,
} from '@warden/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { useTraceStream } from '@/features/trace/trace-context';
import { api, ApiError } from '@/lib/api';

const keys = {
  scenarios: ['simulator', 'scenarios'] as const,
  runs: ['simulator', 'runs'] as const,
};

/** Still moving: the agent is reasoning, or its transaction has not settled yet. */
export function isActive(run: SimulatorRunView): boolean {
  const status = run.suggestion?.plan?.status;
  return run.status === 'RUNNING' || status === 'QUEUED' || status === 'EXECUTING';
}

export function useScenarios() {
  return useQuery({
    queryKey: keys.scenarios,
    queryFn: ({ signal }) =>
      api('/simulator/scenarios', { schema: SimulatorScenariosResponseSchema, signal }),
    staleTime: Infinity,
  });
}

export function useRuns() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: keys.runs,
    queryFn: ({ signal }) =>
      api('/simulator/runs', { schema: SimulatorRunsResponseSchema, signal }),
    refetchInterval: (q) => (q.state.data?.runs.some(isActive) ? 3_000 : false),
  });
  // The stream is newest first, so this is the latest step of any run on the list.
  const { events } = useTraceStream();
  const ids = new Set(query.data?.runs.map((r) => r.id));
  const latest = events.find((e) => ids.has(e.traceId))?.id;
  useEffect(() => {
    if (latest) void qc.invalidateQueries({ queryKey: keys.runs });
  }, [latest, qc]);
  return query;
}

/** One run oldest first: what the server stored plus whatever the stream has delivered since. */
export function runEvents(
  stored: readonly TraceEvent[],
  live: readonly TraceEvent[],
  runId: string | null,
): TraceEvent[] {
  const byId = new Map(stored.map((e) => [e.id, e]));
  for (const e of live) if (e.traceId === runId) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

export function useTriggerRun(onStarted: (id: string) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { scenarioId: SimulatorScenarioId; mode: SimulatorMode }) =>
      api('/simulator/runs', { method: 'POST', body: input, schema: SimulatorRunViewSchema }),
    onSuccess: (run) => onStarted(run.id),
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'The run did not start. Please retry.');
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.runs }),
  });
}
