/** What sits under the prompt before the first message: three doors into the rest of the app. */
import { usd, type PlanListItem } from '@warden/shared';
import { ArrowUpRight, Clock } from 'lucide-react';
import type * as React from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge, Card, PillIcon } from '@/components/ui-kit';
import { useSuggestions } from '@/features/inbox/hooks';
import { statusPill } from '@/features/inbox/suggestion-meta';
import { OUTCOME_META, usePendingApprovals, usePlans } from '@/features/plan/hooks';
import { usePortfolio } from '@/features/portfolio/hooks';
import { ModeBadge } from '@/features/simulator/ModeBadge';
import { useAutoActCount, usePendingCount } from '@/layout/shell-hooks';
import { deltaTone, formatSignedPct, formatSignedUsd } from '@/lib/format';
import { cn } from '@/lib/utils';

function Door({ to, label, children }: { to: string; label: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="glass group flex min-h-[132px] flex-col rounded-lg border border-border p-4 transition-colors duration-150 hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="micro-label text-subtle-foreground">{label}</span>
        <ArrowUpRight
          className="size-4 text-subtle-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground"
          aria-hidden
        />
      </span>
      <span className="mt-2 flex min-w-0 flex-1 flex-col">{children}</span>
    </Link>
  );
}

function PortfolioDoor() {
  const portfolio = usePortfolio();
  const data = portfolio.data;
  const hasPnl = Boolean(data && data.pnl.perToken.length > 0);
  const tone = data ? deltaTone(data.pnl.totalUsd) : 'flat';
  return (
    <Door to="/portfolio" label="Portfolio value">
      {data ? (
        <>
          <span className="text-2xl font-semibold tracking-tight tabular">
            {usd(data.totalUsd)}
          </span>
          <span
            className={cn(
              'mt-auto text-sm tabular',
              hasPnl && tone === 'up' && 'text-safe',
              hasPnl && tone === 'down' && 'text-danger',
              (!hasPnl || tone === 'flat') && 'text-muted-foreground',
            )}
          >
            {hasPnl
              ? `${formatSignedUsd(data.pnl.totalUsd, usd)}${
                  data.pnl.pct ? ` (${formatSignedPct(data.pnl.pct)})` : ''
                } all-time`
              : data.address
                ? 'No deposits yet'
                : 'No wallet yet'}
          </span>
        </>
      ) : portfolio.isPending ? (
        <Skeleton className="h-8 w-32" />
      ) : (
        <span className="text-sm text-muted-foreground">{portfolio.error?.message}</span>
      )}
    </Door>
  );
}

function AutopilotDoor() {
  const suggestions = useSuggestions();
  const autoAct = useAutoActCount();
  const latest = suggestions.data?.suggestions[0];
  return (
    <Door to="/autopilot" label="Autopilot">
      {latest ? (
        <>
          <span className="line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]">
            {latest.title}
          </span>
          <span className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
            <Badge tone={statusPill(latest).tone}>{statusPill(latest).label}</Badge>
            {latest.simulated && <ModeBadge mode="SIMULATED" />}
          </span>
        </>
      ) : (
        <span className="text-sm text-muted-foreground">
          {autoAct ? `Auto-act ${autoAct.on} of ${autoAct.total} on. ` : ''}
          No decisions yet.
        </span>
      )}
    </Door>
  );
}

function LatestAction({ plan }: { plan: PlanListItem }) {
  const outcome = OUTCOME_META[plan.outcome];
  return (
    <>
      <span className="line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]">
        {plan.requestText ?? plan.summary}
      </span>
      <span className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
        <Badge tone={outcome.tone}>{outcome.label}</Badge>
        {plan.simulated && <ModeBadge mode="SIMULATED" />}
        <span className="text-sm font-medium tabular">{usd(plan.amountUsd)}</span>
      </span>
    </>
  );
}

function ActivityDoor() {
  const plans = usePlans({});
  const latest = plans.data?.pages[0]?.plans[0];
  return (
    <Door to="/activity" label="Latest action">
      {latest ? (
        <LatestAction plan={latest} />
      ) : (
        <span className="text-sm text-muted-foreground">
          Everything SAKA does, and refuses to do, lands here.
        </span>
      )}
    </Door>
  );
}

/** Expiring approvals must not hide behind a tab. */
export function WaitingBanner() {
  const pending = usePendingCount();
  const approvals = usePendingApprovals().data?.approvals.length ?? 0;
  if (pending <= 0) return null;
  return (
    <Card className="border-warm/30">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
        <p className="flex items-center gap-2.5 text-sm font-medium">
          <Clock className="size-4 text-warm" aria-hidden />
          {pending} waiting for you
          {approvals > 0 && (
            <span className="font-normal text-muted-foreground">
              · {approvals} approval{approvals === 1 ? '' : 's'} with a deadline
            </span>
          )}
        </p>
        <Button size="sm" variant="iconPill" asChild>
          <Link to="/autopilot">
            <PillIcon tone="warm" size="sm" /> Review
          </Link>
        </Button>
      </div>
    </Card>
  );
}

export function Overview() {
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-3 px-3 pb-6 sm:px-5">
      <WaitingBanner />
      <div className="grid gap-3 sm:grid-cols-3">
        <PortfolioDoor />
        <AutopilotDoor />
        <ActivityDoor />
      </div>
    </div>
  );
}
