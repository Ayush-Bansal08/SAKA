/** Simulator data. Runs refresh on their own trace events, with a slow poll as the safety net. */
import {
  SimulatorRunViewSchema,
  SimulatorRunsResponseSchema,
  SimulatorScenariosResponseSchema,
  type SimulatorMode,
  type SimulatorRunView,
  type SimulatorScenarioId,
} from '@warden/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useOnTraceEvent } from '@/features/portfolio/hooks';
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
  const ids = new Set(query.data?.runs.map((r) => r.id));
  useOnTraceEvent(
    (e) => ids.has(e.traceId),
    () => void qc.invalidateQueries({ queryKey: keys.runs }),
  );
  return query;
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
