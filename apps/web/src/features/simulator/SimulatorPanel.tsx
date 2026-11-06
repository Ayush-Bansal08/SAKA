/**
 * Market Event Simulator: the presenter chooses when a market event happens; the 0G model decides
 * what to do about it. The Demo / Paper choice lives here and touches nothing else in the app.
 */
import { SIMULATOR_MODES, type SimulatorMode, type SimulatorScenarioId } from '@warden/shared';
import { ArrowLeft, FlaskConical, History } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Badge, ErrorState, Panel, SkeletonRows } from '@/components/ui-kit';
import { useNow } from '@/hooks/useNow';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PageContainer, PageHeader } from '@/pages/PageHeader';
import { DecisionCard } from './DecisionCard';
import { useRuns, useScenarios, useTriggerRun } from './hooks';
import { ModeBadge } from './ModeBadge';
import { ReasoningTrace } from './ReasoningTrace';
import { ScenarioCard } from './ScenarioCard';

const MODE_HELP: Record<SimulatorMode, string> = {
  DEMO: 'Real transaction on the testnet, at testnet quotes',
  PAPER: 'Full pipeline up to transaction simulation; nothing is broadcast',
};

function ModeToggle({
  mode,
  onChange,
}: {
  mode: SimulatorMode;
  onChange: (m: SimulatorMode) => void;
}) {
  return (
    <div role="group" aria-label="Run mode" className="flex gap-1.5">
      {SIMULATOR_MODES.map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          title={MODE_HELP[m]}
          onClick={() => onChange(m)}
          className={cn(
            'rounded-full border px-2.5 py-1 text-xs font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            mode === m
              ? 'border-agent/50 bg-agent/10 text-agent'
              : 'border-border text-muted-foreground hover:text-foreground',
          )}
        >
          {m === 'DEMO' ? 'Demo' : 'Paper'}
        </button>
      ))}
    </div>
  );
}

export function SimulatorPanel() {
  const scenarios = useScenarios();
  const runs = useRuns();
  const now = useNow(30_000);
  const [mode, setMode] = useState<SimulatorMode>('DEMO');
  const [selected, setSelected] = useState<string | null>(null);
  const [lastScenario, setLastScenario] = useState<SimulatorScenarioId | null>(null);
  const trigger = useTriggerRun(setSelected);

  const list = runs.data?.runs ?? [];
  const run = list.find((r) => r.id === selected) ?? list[0] ?? null;
  const busy = trigger.isPending || list.some((r) => r.status === 'RUNNING');
  const start = (scenarioId: SimulatorScenarioId) => {
    setLastScenario(scenarioId);
    trigger.mutate({ scenarioId, mode });
  };

  return (
    <PageContainer>
      <PageHeader
        title="Market Event Simulator"
        description="You choose when the event happens. Your agent decides what to do about it."
        actions={
          <Button size="sm" variant="ghost" asChild>
            <Link to="/inbox">
              <ArrowLeft aria-hidden /> Inbox
            </Link>
          </Button>
        }
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <Panel
          title="Scenarios"
          subtitle="Market conditions only"
          icon={<FlaskConical />}
          actions={
            <>
              <ModeBadge mode="SIMULATED" />
              <ModeToggle mode={mode} onChange={setMode} />
            </>
          }
        >
          {scenarios.isPending ? (
            <SkeletonRows rows={2} label="Loading scenarios" />
          ) : scenarios.isError ? (
            <ErrorState
              title="Couldn't load the scenarios"
              description={scenarios.error.message}
              onRetry={() => void scenarios.refetch()}
              retrying={scenarios.isFetching}
            />
          ) : (
            <>
              <ul className="grid gap-3 md:grid-cols-3">
                {scenarios.data.scenarios.map((s) => (
                  <ScenarioCard
                    key={s.id}
                    scenario={s}
                    disabled={busy}
                    onTrigger={() => start(s.id)}
                  />
                ))}
              </ul>
              <p className="mt-3 text-[13px] font-medium">{MODE_HELP[mode]}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                The first two are both ETH drops. The trigger is alike; the evidence around it is
                not. Market data in these runs is simulated, and real transactions always use the
                testnet's own quotes.
              </p>
            </>
          )}
        </Panel>

        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-2">
          <ReasoningTrace runId={run?.id ?? null} />
          <DecisionCard
            run={run}
            retrying={trigger.isPending}
            onRetry={() => {
              const id = run?.scenarioId ?? lastScenario;
              if (id) start(id);
            }}
          />
        </div>

        {list.length > 0 && (
          <Panel
            title="Simulator runs"
            subtitle="Kept apart from your real history"
            icon={<History />}
            bodyClassName="p-0"
          >
            <ul className="divide-y divide-border">
              {list.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    aria-current={r.id === run?.id}
                    onClick={() => setSelected(r.id)}
                    className="flex w-full flex-wrap items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">{r.label}</span>
                    <ModeBadge mode="SIMULATED" />
                    {r.effectiveMode === 'PAPER' && <ModeBadge mode="PAPER" />}
                    {r.rejected && <Badge tone="caution">Rejected</Badge>}
                    {r.status === 'FAILED' && <Badge tone="danger">Failed</Badge>}
                    {r.status === 'RUNNING' && <Badge tone="agent">Running</Badge>}
                    <span className="text-xs text-subtle-foreground">
                      {formatRelative(r.createdAt, now)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </PageContainer>
  );
}
