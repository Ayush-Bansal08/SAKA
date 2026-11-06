/**
 * The decision digest: what changed, what the agent did, why, the cost, the risk, what it weighed
 * and how it ended. Shows what the model returned and leaves out whatever it did not.
 */
import type { DecisionDigest, SimulatorOutcome, SimulatorRunView } from '@warden/shared';
import { ExternalLink, Scale, ShieldCheck } from 'lucide-react';
import type * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Badge,
  Disclosure,
  EmptyState,
  ErrorState,
  Panel,
  SkeletonRows,
  ZgVerifiedBadge,
  type BadgeTone,
} from '@/components/ui-kit';
import { usd } from '@/features/agent/cards/card-utils';
import { ModeBadge } from './ModeBadge';

const OUTCOME: Record<SimulatorOutcome, { label: string; tone: BadgeTone }> = {
  BUY: { label: 'Bought', tone: 'agent' },
  SELL: { label: 'Sold', tone: 'agent' },
  SWAP: { label: 'Swapped', tone: 'agent' },
  MIGRATE_LP: { label: 'Moved the position', tone: 'agent' },
  ADD_LIQUIDITY: { label: 'Added liquidity', tone: 'agent' },
  REMOVE_LIQUIDITY: { label: 'Removed liquidity', tone: 'agent' },
  OTHER_ACTION: { label: 'Other action', tone: 'caution' },
  NO_ACTION: { label: 'No action', tone: 'agent' },
  NO_DECISION: { label: 'No decision reached', tone: 'caution' },
};

/** The action as proposed: the verb stays conditional until a transaction says otherwise. */
const PROPOSED: Partial<Record<SimulatorOutcome, string>> = {
  BUY: 'Buy',
  SELL: 'Sell',
  SWAP: 'Swap',
  MIGRATE_LP: 'Move the position',
  ADD_LIQUIDITY: 'Add liquidity',
  REMOVE_LIQUIDITY: 'Remove liquidity',
  OTHER_ACTION: 'Other action',
};

const SUPPORTS: Record<'ACT' | 'HOLD' | 'NEUTRAL', { label: string; tone: BadgeTone }> = {
  ACT: { label: 'Supports acting', tone: 'agent' },
  HOLD: { label: 'Supports waiting', tone: 'neutral' },
  NEUTRAL: { label: 'Neutral', tone: 'neutral' },
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border pt-3 first:border-t-0 first:pt-0">
      <h3 className="micro-label text-subtle-foreground">{title}</h3>
      <div className="mt-1.5 text-sm [overflow-wrap:anywhere]">{children}</div>
    </section>
  );
}

function costs(digest: DecisionDigest | null): string[] {
  const c = digest?.estimatedCosts;
  return [
    ...(c?.gasUsd !== undefined ? [`Gas about ${usd(c.gasUsd)}`] : []),
    ...(c?.slippageBps !== undefined ? [`Slippage ${c.slippageBps} bps`] : []),
    ...(c?.priceImpactBps !== undefined ? [`Price impact ${c.priceImpactBps} bps`] : []),
  ];
}

function Outcome({ run }: { run: SimulatorRunView }) {
  const decision = run.decision!;
  const plan = run.suggestion?.plan;
  const executed = plan?.status === 'EXECUTED';
  const tranche = decision.digest?.tranche;
  const meta = OUTCOME[decision.outcome];
  const proposed = PROPOSED[decision.outcome];
  const label = executed || !proposed ? meta.label : `Proposed: ${proposed}`;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          tone={meta.tone}
          icon={decision.outcome === 'NO_ACTION' ? <ShieldCheck aria-hidden /> : undefined}
          className="px-2.5 py-1 text-xs"
        >
          {label}
        </Badge>
        {plan && (
          <span className="text-base font-semibold tabular-nums">{usd(plan.amountUsd)}</span>
        )}
        {decision.digest?.confidence !== undefined && (
          <span className="text-xs text-muted-foreground">
            Confidence {decision.digest.confidence.toFixed(2)}
          </span>
        )}
      </div>
      {decision.summary && <p className="mt-1.5">{decision.summary}</p>}
      {decision.outcome === 'NO_ACTION' && (
        <p className="mt-1.5 text-agent">Your agent looked into this and chose not to act.</p>
      )}
      {tranche && (
        <p className="mt-1 text-xs text-muted-foreground">
          Tranche {tranche.index} of up to {tranche.maxTranches}, next check in{' '}
          {tranche.cooldownMinutes} min
        </p>
      )}
    </>
  );
}

function Status({ run }: { run: SimulatorRunView }) {
  const plan = run.suggestion?.plan;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {run.rejected && <Badge tone="caution">Rejected</Badge>}
        {run.effectiveMode === 'PAPER' && <ModeBadge mode="PAPER" />}
        {plan && !run.rejected && <Badge tone="neutral">Plan {plan.status.toLowerCase()}</Badge>}
        {plan?.tradeScore !== null && plan?.tradeScore !== undefined && (
          <Badge tone="neutral">Trade {plan.tradeScore}/100</Badge>
        )}
        {run.decision?.zg && <ZgVerifiedBadge title={`0G request ${run.decision.zg.requestId}`} />}
      </div>
      {run.notice && <p>{run.notice}</p>}
      {run.suggestion?.note && run.suggestion.note !== run.notice && (
        <p className="text-muted-foreground">{run.suggestion.note}</p>
      )}
      {plan?.tx?.explorerUrl && (
        <Button size="sm" variant="ghost" className="-ml-2" asChild>
          <a href={plan.tx.explorerUrl} target="_blank" rel="noreferrer">
            Transaction <ExternalLink aria-hidden />
          </a>
        </Button>
      )}
    </div>
  );
}

export function DecisionCard({
  run,
  onRetry,
  retrying,
}: {
  run: SimulatorRunView | null;
  onRetry: () => void;
  retrying: boolean;
}) {
  const digest = run?.decision?.digest ?? null;
  const cost = costs(digest);
  const hookScore = run?.suggestion?.plan?.hookScore;
  const showsHookNote =
    run?.scenarioId === 'LP_MIGRATION_NOT_WORTH_IT' ||
    (hookScore !== null && hookScore !== undefined);
  return (
    <Panel
      title="Decision"
      subtitle={run?.label ?? 'What your agent concluded'}
      icon={<Scale />}
      actions={run ? <ModeBadge mode="SIMULATED" /> : undefined}
    >
      {!run ? (
        <EmptyState
          className="py-6"
          icon={<Scale />}
          title="No decision yet"
          description="The decision appears here, in your agent's own words."
        />
      ) : run.status === 'FAILED' ? (
        <ErrorState
          title={run.error?.startsWith('Reasoning failed') ? 'Reasoning failed' : 'The run failed'}
          description={run.error ?? undefined}
          onRetry={onRetry}
          retrying={retrying}
        />
      ) : !run.decision ? (
        <SkeletonRows rows={4} label="Your agent is investigating" />
      ) : (
        <div className="space-y-3">
          <Section title="What changed">{run.event}</Section>
          <Section title="What your agent did">
            <Outcome run={run} />
          </Section>
          <Section title="Why">
            <p>{run.decision.rationale}</p>
            {digest?.signalsChecked && digest.signalsChecked.length > 0 && (
              <Disclosure title="Signals checked" defaultOpen className="mt-2">
                <ul className="space-y-1.5" aria-label="Signals checked">
                  {digest.signalsChecked.map((s, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={SUPPORTS[s.supports].tone}>{SUPPORTS[s.supports].label}</Badge>
                      <span>{s.signal}:</span>
                      <span className="text-muted-foreground">{s.value}</span>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
          </Section>
          {cost.length > 0 && <Section title="Cost">{cost.join(' · ')}</Section>}
          {(digest?.risks?.length || showsHookNote) && (
            <Section title="Risk">
              {digest?.risks && (
                <ul className="list-inside list-disc space-y-0.5">
                  {digest.risks.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
              {showsHookNote && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Hook scores are a risk indicator, not a security certification.
                </p>
              )}
            </Section>
          )}
          {digest?.alternativesConsidered && digest.alternativesConsidered.length > 0 && (
            <section className="border-t border-border pt-3">
              <Disclosure title="Alternatives considered" technical>
                <ul className="space-y-1 text-sm">
                  {digest.alternativesConsidered.map((a, i) => (
                    <li key={i}>
                      {a.option}
                      <span className="text-muted-foreground"> — {a.whyRejected}</span>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            </section>
          )}
          <Section title="Status">
            {run.status === 'RUNNING' ? (
              <p className="text-muted-foreground">Going through the safety pipeline…</p>
            ) : (
              <Status run={run} />
            )}
          </Section>
        </div>
      )}
    </Panel>
  );
}
