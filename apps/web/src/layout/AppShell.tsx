import { chainMeta, Decimal, usd, type ProvidersResponse, type UserView } from '@warden/shared';
import { Activity } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { usePriceOverrides } from '@/features/hooks/hooks';
import { useSuggestions } from '@/features/inbox/hooks';
import { usePendingApprovals } from '@/features/plan/hooks';
import { PlanDrawer } from '@/features/plan/PlanDrawer';
import { usePortfolio } from '@/features/portfolio/hooks';
import { LiveActivity, StreamStatusPill } from '@/features/trace/LiveActivity';
import { useTraceStream } from '@/features/trace/trace-context';
import { cn } from '@/lib/utils';
import { DevBanner } from './DevBanner';
import { usesDevProviders } from './dev-mode';
import { Logo } from './Logo';
import { NAV_ITEMS } from './nav';
import { UserMenu } from './UserMenu';
import { useTraceToasts } from './useTraceToasts';

export function ChainBadge({ chainId }: { chainId: ProvidersResponse['executionChainId'] }) {
  const chain = chainMeta(chainId);
  return (
    <SimpleTooltip label="Your agent executes on this testnet only. Market data comes from Ethereum mainnet (read-only).">
      <span
        tabIndex={0}
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="size-1.5 rounded-full bg-info" aria-hidden />
        <span className="max-w-[92px] truncate whitespace-nowrap text-foreground/90 sm:max-w-none">
          {chain.name}
        </span>
        <span className="hidden text-subtle-foreground lg:inline">· testnet</span>
      </span>
    </SimpleTooltip>
  );
}

/** Demo control (admin): visible whenever a reference-price override is active. */
function PriceOverrideChip() {
  const overrides = usePriceOverrides().data?.overrides ?? [];
  if (!overrides.length) return null;
  const label = overrides
    .map((o) => `${o.symbol} $${Number(o.priceUsd).toLocaleString('en-US')}`)
    .join(', ');
  return (
    <SimpleTooltip
      label={`Demo price override for rules and alerts only (${label}). Swaps always use live quotes.`}
    >
      <span
        tabIndex={0}
        className="inline-flex items-center gap-1.5 rounded-full border border-caution/40 bg-caution/10 px-2.5 py-1 text-xs font-medium text-caution outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="size-1.5 rounded-full bg-caution" aria-hidden />
        <span className="hidden sm:inline">Price override active (demo)</span>
        <span className="sm:hidden">Override</span>
      </span>
    </SimpleTooltip>
  );
}

/** Today's agent spending vs the daily limit (header mini-bar). */
function LimitMiniBar() {
  const portfolio = usePortfolio();
  const limits = portfolio.data?.limits;
  if (!limits) return null;
  const perDay = new Decimal(limits.perDayUsd);
  const pct = perDay.gt(0)
    ? Decimal.min(100, new Decimal(limits.usedTodayUsd).div(perDay).times(100)).toNumber()
    : 0;
  const tone = pct >= 90 ? 'bg-danger' : pct >= 60 ? 'bg-caution' : 'bg-agent';
  return (
    <SimpleTooltip
      label={`Your agent spent ${usd(limits.usedTodayUsd)} of its ${usd(limits.perDayUsd)} daily limit alone today. Up to ${usd(limits.perActionUsd)} per action.`}
    >
      <NavLink
        to="/settings"
        className="hidden items-center gap-2 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring sm:inline-flex"
        aria-label={`Today's limit: ${usd(limits.usedTodayUsd)} of ${usd(limits.perDayUsd)} used`}
      >
        <span className="text-muted-foreground">Today</span>
        <span
          className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-3"
          role="progressbar"
          aria-label="Daily limit used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
        >
          <span
            className={cn('block h-full rounded-full transition-[width] duration-500', tone)}
            style={{ width: `${Math.max(pct, pct > 0 ? 6 : 0)}%` }}
          />
        </span>
        <span className="font-medium tabular-nums">
          {usd(limits.usedTodayUsd)}
          <span className="text-subtle-foreground">/{usd(limits.perDayUsd)}</span>
        </span>
      </NavLink>
    </SimpleTooltip>
  );
}

function TopBar({
  providers,
  user,
  onOpenActivity,
}: {
  providers: ProvidersResponse;
  user: UserView;
  onOpenActivity: (() => void) | null;
}) {
  const { status } = useTraceStream();
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background/85 px-4 backdrop-blur md:static md:px-5">
      <NavLink to="/" aria-label={`${providers.appName} home`} className="rounded-md">
        <Logo appName={providers.appName} />
      </NavLink>
      <div className="flex min-w-0 items-center gap-2 sm:gap-2.5">
        <PriceOverrideChip />
        <LimitMiniBar />
        <StreamStatusPill status={status} compact />
        <ChainBadge chainId={providers.executionChainId} />
        {onOpenActivity && (
          <button
            type="button"
            onClick={onOpenActivity}
            className="hidden size-8 items-center justify-center rounded-md border border-border bg-surface-2 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:inline-flex xl:hidden"
            aria-label="Open live activity"
          >
            <Activity className="size-4" />
          </button>
        )}
        <UserMenu user={user} />
      </div>
    </header>
  );
}

function NavBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-caution px-1.5 text-[10.5px] font-semibold text-background tabular-nums"
      aria-label={`${count} waiting for you`}
    >
      {count > 9 ? '9+' : count}
    </span>
  );
}

/** Everything waiting for the human: approvals plus open suggestions. */
function usePendingCount(): number {
  const approvals = usePendingApprovals().data?.approvals.length ?? 0;
  return approvals + (useSuggestions().data?.openCount ?? 0);
}

function SideNav() {
  const pending = usePendingCount();
  return (
    <nav
      aria-label="Main"
      className="hidden w-56 shrink-0 flex-col border-r border-border bg-background px-3 py-4 md:flex"
    >
      <ul className="space-y-1">
        {NAV_ITEMS.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-surface-2 text-foreground'
                    : 'text-muted-foreground hover:bg-surface-2/60 hover:text-foreground',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon
                    className={cn(
                      'size-4',
                      isActive
                        ? 'text-agent'
                        : 'text-subtle-foreground group-hover:text-muted-foreground',
                    )}
                    aria-hidden
                  />
                  {item.label}
                  {item.to === '/inbox' && <NavBadge count={pending} />}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="mt-auto rounded-lg border border-border bg-card p-3 text-xs leading-relaxed text-muted-foreground">
        <p className="font-medium text-foreground/90">Testnet only</p>
        <p className="mt-1">Decisions are made by verified 0G models and logged to 0G Storage.</p>
      </div>
    </nav>
  );
}

function BottomTabs() {
  const pending = usePendingCount();
  return (
    <nav
      aria-label="Main"
      className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur md:hidden"
    >
      <ul className="grid grid-cols-5">
        {NAV_ITEMS.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'relative flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors',
                  isActive
                    ? 'text-foreground'
                    : 'text-subtle-foreground hover:text-muted-foreground',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon className={cn('size-5', isActive && 'text-agent')} aria-hidden />
                  {item.label}
                  {item.to === '/inbox' && pending > 0 && (
                    <span
                      className="absolute top-2 right-[calc(50%-18px)] size-2 rounded-full bg-caution"
                      aria-label={`${pending} waiting for you`}
                    />
                  )}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function AppShell({ providers, user }: { providers: ProvidersResponse; user: UserView }) {
  const { pathname } = useLocation();
  const [activityOpen, setActivityOpen] = useState(false);
  useTraceToasts();
  return (
    <div className="flex min-h-dvh flex-col md:h-dvh md:overflow-hidden">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      {usesDevProviders(providers) && <DevBanner />}
      <TopBar
        providers={providers}
        user={user}
        onOpenActivity={pathname === '/' ? () => setActivityOpen(true) : null}
      />
      <div className="flex flex-1 md:min-h-0">
        <SideNav />
        <main id="main" className="min-w-0 flex-1 pb-20 md:overflow-y-auto md:pb-0">
          {/* Pages read the signed-in user via useOutletContext(). */}
          <Outlet context={{ user }} />
        </main>
      </div>
      <BottomTabs />
      <PlanDrawer />
      {/* Tablet: live activity slides over from the header button. */}
      <Sheet open={activityOpen} onOpenChange={setActivityOpen}>
        {activityOpen && (
          <SheetContent
            title="Live activity"
            description="Every step your agent takes"
            className="max-w-[440px]"
          >
            <LiveActivity embedded className="h-full rounded-none border-0" />
          </SheetContent>
        )}
      </Sheet>
    </div>
  );
}
