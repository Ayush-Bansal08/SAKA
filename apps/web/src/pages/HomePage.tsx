/**
 * Home: "how am I doing, and what is SAKA up to?". The only view with the full hero treatment.
 * Every number comes from data the app already loads; nothing here is derived from prose.
 */
import { usd, type PlanListItem, type UserView } from '@warden/shared';
import { Clock, History, Radar, Sparkles } from 'lucide-react';
import type * as React from 'react';
import { Link, Navigate, useLocation, useOutletContext, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  PillIcon,
  SkeletonRows,
  StatCard,
} from '@/components/ui-kit';
import { useSuggestions } from '@/features/inbox/hooks';
import { statusPill } from '@/features/inbox/suggestion-meta';
import { OUTCOME_META, usePendingApprovals, usePlanDrawer, usePlans } from '@/features/plan/hooks';
import { usePortfolio } from '@/features/portfolio/hooks';
import { ModeBadge } from '@/features/simulator/ModeBadge';
import { useNow } from '@/hooks/useNow';
import { useAutoActCount, usePendingCount } from '@/layout/shell-hooks';
import { deltaTone, formatRelative, formatSignedPct, formatSignedUsd } from '@/lib/format';

function greeting(hour: number): string {
  if (hour < 5) return 'Good evening';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** The honest one-liner: what the agent is really set up to do right now. */
function useHeadline(): React.ReactNode {
  const portfolio = usePortfolio().data;
  const autoAct = useAutoActCount();
  if (portfolio && !portfolio.tokens.some((t) => t.balanceRaw !== '0'))
    return (
      <>
        SAKA is <span className="serif-accent text-gradient-ai">waiting for funds</span>
      </>
    );
  if (autoAct?.on === 0)
    return (
      <>
        SAKA will <span className="serif-accent text-gradient-ai">ask before it acts</span>
      </>
    );
  return (
    <>
      SAKA is <span className="serif-accent text-gradient-ai">watching your positions</span>
    </>
  );
}

function Stats() {
  const portfolio = usePortfolio();
  const data = portfolio.data;
  if (portfolio.isPending)
    return (
      <div role="status" aria-label="Loading your numbers" className="grid gap-4 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[116px] rounded-lg" />
        ))}
      </div>
    );
  if (!data)
    return (
      <Card>
        <ErrorState
          className="py-6"
          title="Couldn't load your portfolio"
          description={portfolio.error?.message}
          onRetry={() => void portfolio.refetch()}
          retrying={portfolio.isFetching}
        />
      </Card>
    );
  const hasPnl = data.pnl.perToken.length > 0;
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <StatCard
        size="lg"
        label="Portfolio value"
        value={usd(data.totalUsd)}
        hint={data.address ? 'Agent wallet · testnet' : 'No wallet yet'}
      />
      <StatCard
        size="lg"
        label="All-time P&L"
        value={hasPnl ? formatSignedUsd(data.pnl.totalUsd, usd) : '—'}
        {...(hasPnl && data.pnl.pct
          ? { delta: formatSignedPct(data.pnl.pct), deltaTone: deltaTone(data.pnl.totalUsd) }
          : {})}
        {...(hasPnl ? {} : { hint: 'No deposits yet' })}
      />
      <StatCard
        size="lg"
        label="Agent spend today"
        value={usd(data.limits.usedTodayUsd)}
        hint={`of ${usd(data.limits.perDayUsd)} daily limit`}
      />
    </div>
  );
}

/** Expiring approvals must not hide behind a tab. */
function WaitingBanner() {
  const pending = usePendingCount();
  const approvals = usePendingApprovals().data?.approvals.length ?? 0;
  if (pending <= 0) return null;
  return (
    <Card glow="warm" className="border-warm/30">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
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

function AgentCard() {
  const suggestions = useSuggestions();
  const autoAct = useAutoActCount();
  const now = useNow(30_000);
  const latest = suggestions.data?.suggestions[0];
  return (
    <Card glow="ai" className="flex flex-col p-5">
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-2">
          <p className="micro-label text-subtle-foreground">Autopilot</p>
          {autoAct && (
            <Badge tone="agent" icon={<Sparkles aria-hidden />}>
              Auto-act {autoAct.on} of {autoAct.total}
            </Badge>
          )}
        </div>
        {suggestions.isPending ? (
          <SkeletonRows rows={1} className="mt-4" label="Loading the latest decision" />
        ) : suggestions.isError ? (
          <p className="mt-4 text-sm text-muted-foreground">{suggestions.error.message}</p>
        ) : latest ? (
          <div className="mt-4">
            <p className="text-h3 font-medium [overflow-wrap:anywhere]">{latest.title}</p>
            <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge tone={statusPill(latest).tone}>{statusPill(latest).label}</Badge>
              {latest.simulated && <ModeBadge mode="SIMULATED" />}
              <span className="font-mono tabular">{formatRelative(latest.createdAt, now)}</span>
            </p>
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            No decisions yet. SAKA speaks up when it spots something worth your attention.
          </p>
        )}
        <Link
          to="/autopilot"
          className="mt-auto inline-flex min-h-11 items-end pt-4 text-sm font-medium text-agent underline-offset-4 hover:underline"
        >
          View decisions »
        </Link>
      </div>
    </Card>
  );
}

function RecentRow({ plan, now }: { plan: PlanListItem; now: number }) {
  const drawer = usePlanDrawer();
  const outcome = OUTCOME_META[plan.outcome];
  return (
    <li>
      <button
        type="button"
        onClick={() => drawer.open(plan.id)}
        className="flex min-h-11 w-full items-center gap-3 rounded-sm py-2 text-left transition-colors hover:bg-surface-2/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="min-w-0 flex-1 truncate text-sm">{plan.requestText ?? plan.summary}</span>
        {plan.simulated && <ModeBadge mode="SIMULATED" />}
        <span className="text-sm font-medium tabular">{usd(plan.amountUsd)}</span>
        <Badge tone={outcome.tone}>{outcome.label}</Badge>
        <span className="hidden w-16 text-right font-mono text-[11px] text-subtle-foreground sm:block">
          {formatRelative(plan.createdAt, now)}
        </span>
      </button>
    </li>
  );
}

function RecentActivity() {
  const plans = usePlans({});
  const now = useNow(30_000);
  const rows = plans.data?.pages[0]?.plans.slice(0, 3) ?? [];
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-2">
        <p className="micro-label text-subtle-foreground">Recent activity</p>
        <Link
          to="/activity"
          className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          View all »
        </Link>
      </div>
      {plans.isPending ? (
        <SkeletonRows rows={3} className="mt-4" label="Loading recent activity" />
      ) : plans.isError ? (
        <p className="mt-4 text-sm text-muted-foreground">{plans.error.message}</p>
      ) : rows.length === 0 ? (
        <EmptyState
          className="py-5"
          icon={<History />}
          title="Nothing yet"
          description="Everything SAKA does, and refuses to do, lands here."
        />
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {rows.map((p) => (
            <RecentRow key={p.id} plan={p} now={now} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function HomeView({ user }: { user: UserView }) {
  const headline = useHeadline();
  const name = user.displayName ? `, ${user.displayName}` : '';
  return (
    <div className="relative min-h-full overflow-hidden">
      <div aria-hidden className="horizon" />
      <div aria-hidden className="dot-field" />
      <div className="relative mx-auto flex w-full max-w-[1120px] flex-col gap-5 px-4 pt-24 pb-10 md:px-8 md:pt-28">
        <header className="pb-4 text-center">
          <h1 className="text-display font-medium">
            {greeting(new Date().getHours())}
            {name}
          </h1>
          <p className="text-h2 md:text-h1 mt-2 text-muted-foreground">{headline}</p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button size="lg" asChild>
              <Link to="/ask">
                <Sparkles aria-hidden /> Ask SAKA
              </Link>
            </Button>
            <Button size="lg" variant="secondary" asChild>
              <Link to="/autopilot">
                <Radar aria-hidden /> Open Autopilot
              </Link>
            </Button>
          </div>
        </header>
        <WaitingBanner />
        <Stats />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <AgentCard />
          <RecentActivity />
        </div>
      </div>
    </div>
  );
}

export function HomePage() {
  const { user } = useOutletContext<{ user: UserView }>();
  const [params] = useSearchParams();
  const { search } = useLocation();
  // Telegram's "Change" links are built by the API as /?prefill=…, so this path must keep working.
  if (params.get('prefill')) return <Navigate to={{ pathname: '/ask', search }} replace />;
  return <HomeView user={user} />;
}
