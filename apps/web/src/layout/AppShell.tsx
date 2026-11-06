import { chainMeta, Decimal, usd } from '@warden/shared';
import type { ProvidersResponse, UserView } from '@warden/shared';
import { Activity, PanelLeftClose, PanelLeftOpen, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { observePrefill } from '@/features/agent/prefill';
import { usePriceOverrides } from '@/features/hooks/hooks';
import { PlanDrawer } from '@/features/plan/PlanDrawer';
import { usePortfolio } from '@/features/portfolio/hooks';
import { LiveActivity, StreamStatusPill } from '@/features/trace/LiveActivity';
import { useTraceStream } from '@/features/trace/trace-context';
import { useStoredFlag } from '@/hooks/useStoredFlag';
import { cn } from '@/lib/utils';
import { DevBanner } from './DevBanner';
import { usesDevProviders } from './dev-mode';
import { LogoMark, Wordmark } from './Logo';
import { AGENT_ITEM, NAV_ITEMS, SETTINGS_ITEM, WORKSPACE_ITEMS, type NavItem } from './nav';
import { useAutoActCount, usePendingCount } from './shell-hooks';
import { UserMenu } from './UserMenu';
import { useTraceToasts } from './useTraceToasts';

export function ChainBadge({ chainId }: { chainId: ProvidersResponse['executionChainId'] }) {
  const chain = chainMeta(chainId);
  return (
    <SimpleTooltip label="Your agent executes on this testnet only. Market data comes from Ethereum mainnet (read-only).">
      <span
        tabIndex={0}
        className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-surface-2 px-3.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="size-1.5 rounded-full bg-caution" aria-hidden />
        <span className="max-w-[84px] truncate whitespace-nowrap sm:max-w-none">{chain.name}</span>
        <span className="hidden text-caution sm:inline">testnet</span>
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
        className="inline-flex items-center gap-1.5 rounded-full border border-warm/40 bg-warm/15 px-3 py-1.5 text-xs font-medium text-warm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="size-1.5 rounded-full bg-warm" aria-hidden />
        <span className="hidden sm:inline">Price override active (demo)</span>
        <span className="sm:hidden">Override</span>
      </span>
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
  onOpenActivity: () => void;
}) {
  const { status } = useTraceStream();
  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center justify-between gap-3 bg-background/85 px-4 backdrop-blur sm:static sm:bg-transparent sm:pr-3 sm:pl-2 sm:backdrop-blur-none">
      <span className="flex min-w-0 items-center gap-3">
        <NavLink
          to="/"
          aria-label={`${providers.appName} home`}
          className="rounded-sm text-foreground sm:hidden"
        >
          <LogoMark className="size-8" />
        </NavLink>
        <ChainBadge chainId={providers.executionChainId} />
      </span>
      <div className="flex min-w-0 items-center gap-2">
        <PriceOverrideChip />
        <StreamStatusPill status={status} compact />
        <SimpleTooltip label="Live activity">
          <button
            type="button"
            onClick={onOpenActivity}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-surface-2 text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label="Open live activity"
          >
            <Activity className="size-4" aria-hidden />
          </button>
        </SimpleTooltip>
        <UserMenu user={user} />
      </div>
    </header>
  );
}

function NavBadge({ count, rail }: { count: number; rail: boolean }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        'inline-flex min-w-5 items-center justify-center rounded-full bg-warm px-1.5 text-xs leading-5 font-bold text-background tabular-nums',
        rail ? 'absolute top-0.5 right-0.5' : 'absolute top-0.5 right-0.5 lg:static lg:ml-auto',
      )}
      aria-label={`${count} waiting for you`}
    >
      {count > 9 ? '9+' : count}
    </span>
  );
}

function SideLink({
  item,
  rail,
  badge = 0,
  primary = false,
}: {
  item: NavItem;
  rail: boolean;
  badge?: number;
  primary?: boolean;
}) {
  return (
    <NavLink
      to={item.to}
      title={item.label}
      className={({ isActive }) =>
        cn(
          'group relative flex h-11 items-center gap-3 rounded-md px-3 text-[15px] font-medium transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring',
          rail ? 'justify-center' : 'justify-center lg:justify-start',
          primary && 'surface-highlight border border-border',
          isActive
            ? 'bg-surface-3 text-foreground'
            : cn(
                'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
                primary && 'bg-surface-2 text-foreground',
              ),
        )
      }
    >
      <item.icon className={cn('size-5 shrink-0', primary && 'text-agent')} aria-hidden />
      <span className={cn('sr-only', !rail && 'lg:not-sr-only')}>{item.label}</span>
      <NavBadge count={badge} rail={rail} />
    </NavLink>
  );
}

/** Today's spend against the limit, and how much the agent may do alone. */
function StatusCard() {
  const limits = usePortfolio().data?.limits;
  const autoAct = useAutoActCount();
  if (!limits && !autoAct) return null;
  const perDay = new Decimal(limits?.perDayUsd ?? 0);
  const pct =
    limits && perDay.gt(0)
      ? Decimal.min(100, new Decimal(limits.usedTodayUsd).div(perDay).times(100)).toNumber()
      : 0;
  const tone = pct >= 90 ? 'bg-danger' : pct >= 60 ? 'bg-caution' : 'bg-agent';
  return (
    <NavLink
      to="/autopilot/mandate"
      className="glass hidden rounded-md border border-border p-3.5 outline-none hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring lg:block"
      {...(limits
        ? {
            'aria-label': `Today's limit: ${usd(limits.usedTodayUsd)} of ${usd(limits.perDayUsd)} used`,
          }
        : {})}
    >
      {limits && (
        <>
          <span className="flex items-baseline justify-between gap-2 text-sm">
            <span className="text-muted-foreground">Spent today</span>
            <span className="font-semibold tabular">{usd(limits.usedTodayUsd)}</span>
          </span>
          <span
            className="mt-2 block h-1.5 overflow-hidden rounded-full bg-surface-3"
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
          <span className="mt-1.5 block text-xs text-subtle-foreground tabular">
            of {usd(limits.perDayUsd)} daily limit
          </span>
        </>
      )}
      {autoAct && (
        <span className="mt-2.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Zap className={cn('size-3.5', autoAct.on > 0 && 'text-agent')} aria-hidden />
          Auto-act {autoAct.on} of {autoAct.total} on
        </span>
      )}
    </NavLink>
  );
}

function SideNav({ providers }: { providers: ProvidersResponse }) {
  const pending = usePendingCount();
  const [collapsed, setCollapsed] = useStoredFlag('saka.sidebarCollapsed');
  return (
    <nav
      aria-label="Main"
      className={cn(
        'hidden w-[76px] shrink-0 flex-col px-3 py-3 transition-[width] duration-200 ease-out sm:flex',
        !collapsed && 'lg:w-64',
      )}
    >
      <div
        className={cn(
          'mb-4 flex h-10 items-center justify-center',
          !collapsed && 'lg:justify-between lg:pl-1.5',
        )}
      >
        <NavLink to="/" aria-label={`${providers.appName} home`} className="rounded-sm">
          <LogoMark className={cn('size-9', !collapsed && 'lg:hidden')} />
          {!collapsed && <Wordmark className="hidden h-8 lg:block" />}
        </NavLink>
        {!collapsed && (
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className="hidden size-9 items-center justify-center rounded-full text-subtle-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none lg:inline-flex"
          >
            <PanelLeftClose className="size-[18px]" aria-hidden />
          </button>
        )}
      </div>
      {collapsed && (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="Expand sidebar"
          title="Expand sidebar"
          className="mx-auto mb-3 hidden size-9 items-center justify-center rounded-full text-subtle-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none lg:inline-flex"
        >
          <PanelLeftOpen className="size-[18px]" aria-hidden />
        </button>
      )}
      <SideLink item={AGENT_ITEM} rail={collapsed} primary />
      <p
        className={cn(
          'nav-heading mt-6 mb-2 px-3 text-subtle-foreground',
          collapsed ? 'hidden' : 'hidden lg:block',
        )}
      >
        Workspace
      </p>
      <ul className={cn('space-y-1', collapsed ? 'mt-4' : 'mt-4 lg:mt-0')}>
        {WORKSPACE_ITEMS.map((item) => (
          <li key={item.to}>
            <SideLink item={item} rail={collapsed} badge={item.to === '/autopilot' ? pending : 0} />
          </li>
        ))}
      </ul>
      <div className="mt-auto space-y-2 pt-4">
        {!collapsed && <StatusCard />}
        <SideLink item={SETTINGS_ITEM} rail={collapsed} />
      </div>
    </nav>
  );
}

function BottomTabs() {
  const pending = usePendingCount();
  return (
    <nav
      aria-label="Main"
      className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/90 backdrop-blur-xl sm:hidden"
    >
      <ul className="grid grid-cols-5">
        {NAV_ITEMS.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              className={({ isActive }) =>
                cn(
                  'relative flex h-16 flex-col items-center justify-center gap-1 text-xs font-medium transition-colors',
                  isActive ? 'text-agent' : 'text-subtle-foreground hover:text-muted-foreground',
                )
              }
            >
              <item.icon className="size-5" aria-hidden />
              {item.label}
              {item.to === '/autopilot' && pending > 0 && (
                <span
                  className="absolute top-2 right-[calc(50%-18px)] size-2 rounded-full bg-warm"
                  aria-label={`${pending} waiting for you`}
                />
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Every "put this in the chat" lands on the agent, wherever it was pressed. Rebalance, Exit, New
 * rule and the rest live on other views; without this they would change nothing the human can see.
 */
function usePrefillRouting() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(
    () =>
      observePrefill(() => {
        if (pathname !== '/app') void navigate('/app');
      }),
    [navigate, pathname],
  );
}

export function AppShell({ providers, user }: { providers: ProvidersResponse; user: UserView }) {
  const { pathname } = useLocation();
  const [activityOpen, setActivityOpen] = useState(false);
  useTraceToasts();
  usePrefillRouting();
  return (
    <div className="flex min-h-dvh flex-col sm:h-dvh sm:overflow-hidden">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      {usesDevProviders(providers) && <DevBanner />}
      <div className="flex flex-1 sm:min-h-0">
        <SideNav providers={providers} />
        <div className="flex min-w-0 flex-1 flex-col sm:min-h-0">
          <TopBar providers={providers} user={user} onOpenActivity={() => setActivityOpen(true)} />
          <div className="relative min-h-0 flex-1 sm:mr-3 sm:mb-3">
            <main
              id="main"
              className="relative h-full min-w-0 pb-20 sm:overflow-y-auto sm:rounded-xl sm:border sm:border-border sm:bg-white/[0.025] sm:pb-0"
            >
              {/* Pages read the signed-in user via useOutletContext(). */}
              <div key={`/${pathname.split('/')[1]}`} className="view-enter min-h-full sm:h-full">
                <Outlet context={{ user }} />
              </div>
            </main>
          </div>
        </div>
      </div>
      <BottomTabs />
      <PlanDrawer />
      <Sheet open={activityOpen} onOpenChange={setActivityOpen}>
        {activityOpen && (
          <SheetContent
            title="Live activity"
            description="Every step your agent takes"
            className="sm:max-w-[440px]"
          >
            <LiveActivity embedded className="h-full rounded-none border-0" />
          </SheetContent>
        )}
      </Sheet>
    </div>
  );
}
