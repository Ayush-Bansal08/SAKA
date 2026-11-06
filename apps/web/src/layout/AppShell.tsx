import { AUTO_ACT_DETECTORS, chainMeta, Decimal, usd } from '@warden/shared';
import type { ProvidersResponse, UserView } from '@warden/shared';
import { Activity, PanelLeftClose, PanelLeftOpen, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { observePrefill } from '@/features/agent/prefill';
import { usePriceOverrides } from '@/features/hooks/hooks';
import { useSuggestions } from '@/features/inbox/hooks';
import { usePendingApprovals } from '@/features/plan/hooks';
import { PlanDrawer } from '@/features/plan/PlanDrawer';
import { usePortfolio, useSettings } from '@/features/portfolio/hooks';
import { LiveActivity, StreamStatusPill } from '@/features/trace/LiveActivity';
import { useTraceStream } from '@/features/trace/trace-context';
import { useStoredFlag } from '@/hooks/useStoredFlag';
import { cn } from '@/lib/utils';
import { DevBanner } from './DevBanner';
import { usesDevProviders } from './dev-mode';
import { LogoMark, Wordmark } from './Logo';
import { HOOKS_ITEM, NAV_ITEMS, sectionLabel, SETTINGS_ITEM, type NavItem } from './nav';
import { UserMenu } from './UserMenu';
import { useTraceToasts } from './useTraceToasts';

export function ChainBadge({ chainId }: { chainId: ProvidersResponse['executionChainId'] }) {
  const chain = chainMeta(chainId);
  return (
    <SimpleTooltip label="Your agent executes on this testnet only. Market data comes from Ethereum mainnet (read-only).">
      <span
        tabIndex={0}
        className="inline-flex items-center gap-1.5 rounded-full border border-caution/30 bg-caution/10 px-2.5 py-1 text-xs font-medium text-caution outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="size-1.5 rounded-full bg-caution" aria-hidden />
        <span className="max-w-[72px] truncate whitespace-nowrap sm:max-w-none">{chain.name}</span>
        <span className="hidden opacity-70 lg:inline">· testnet</span>
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
        className="inline-flex items-center gap-1.5 rounded-full border border-warm/40 bg-warm/15 px-2.5 py-1 text-xs font-medium text-warm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="size-1.5 rounded-full bg-warm" aria-hidden />
        <span className="hidden sm:inline">Price override active (demo)</span>
        <span className="sm:hidden">Override</span>
      </span>
    </SimpleTooltip>
  );
}

/** Today's agent spending vs the daily limit. */
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
        to="/autopilot/mandate"
        className="hidden items-center gap-2 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring md:inline-flex"
        aria-label={`Today's limit: ${usd(limits.usedTodayUsd)} of ${usd(limits.perDayUsd)} used`}
      >
        <span className="text-muted-foreground">Today</span>
        <span
          className="h-1.5 w-14 overflow-hidden rounded-full bg-surface-3"
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
  onOpenActivity: () => void;
}) {
  const { status } = useTraceStream();
  const { pathname } = useLocation();
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-3 bg-background/85 px-4 backdrop-blur sm:static sm:bg-transparent sm:pr-3 sm:pl-5 sm:backdrop-blur-none">
      <NavLink
        to="/"
        aria-label={`${providers.appName} home`}
        className="rounded-sm text-foreground sm:hidden"
      >
        <Wordmark className="h-8" />
      </NavLink>
      <p className="micro-label hidden text-subtle-foreground sm:block">
        [ {sectionLabel(pathname)} ]
      </p>
      <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
        <PriceOverrideChip />
        <LimitMiniBar />
        <StreamStatusPill status={status} compact />
        <ChainBadge chainId={providers.executionChainId} />
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
        'inline-flex min-w-5 items-center justify-center rounded-full bg-warm px-1.5 text-[10.5px] leading-5 font-semibold text-background tabular-nums',
        rail ? 'absolute top-0.5 right-0.5' : 'absolute top-0.5 right-0.5 lg:static lg:ml-auto',
      )}
      aria-label={`${count} waiting for you`}
    >
      {count > 9 ? '9+' : count}
    </span>
  );
}

/** Everything waiting for the human: approvals plus open suggestions. */
export function usePendingCount(): number {
  const approvals = usePendingApprovals().data?.approvals.length ?? 0;
  return approvals + (useSuggestions().data?.openCount ?? 0);
}

function SideLink({
  item,
  rail,
  badge = 0,
}: {
  item: NavItem;
  rail: boolean;
  badge?: number;
}) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      title={item.label}
      className={({ isActive }) =>
        cn(
          'group relative flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring',
          rail ? 'justify-center' : 'justify-center lg:justify-start',
          isActive
            ? 'bg-surface-2 text-foreground'
            : 'text-muted-foreground hover:bg-surface-2/60 hover:text-foreground',
        )
      }
    >
      <item.icon className="size-[18px] shrink-0 stroke-[1.75]" aria-hidden />
      <span className={cn('sr-only', !rail && 'lg:not-sr-only')}>{item.label}</span>
      <NavBadge count={badge} rail={rail} />
    </NavLink>
  );
}

/** How many of the five auto-act switches are on: the honest "Autopilot" status. */
export function useAutoActCount(): { on: number; total: number } | null {
  const settings = useSettings();
  if (!settings.data) return null;
  const on = AUTO_ACT_DETECTORS.filter((d) => settings.data.autoAct[d]).length;
  return { on, total: AUTO_ACT_DETECTORS.length };
}

function AutoActChip({ rail }: { rail: boolean }) {
  const count = useAutoActCount();
  if (!count) return null;
  return (
    <NavLink
      to="/autopilot/mandate"
      title={`Auto-act: ${count.on} of ${count.total} on`}
      className={cn(
        'flex items-center gap-2 rounded-md border border-border px-2.5 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring',
        rail ? 'justify-center' : 'justify-center lg:justify-start',
      )}
    >
      <Zap className={cn('size-3.5 shrink-0', count.on > 0 && 'text-agent')} aria-hidden />
      <span className={cn('micro-label text-muted-foreground', rail ? 'hidden' : 'hidden lg:inline')}>
        Auto-act {count.on}/{count.total}
      </span>
      <span
        className={cn('micro-label text-muted-foreground tabular', rail ? '' : 'lg:hidden')}
        aria-hidden
      >
        {count.on}/{count.total}
      </span>
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
        'hidden w-[72px] shrink-0 flex-col px-3 py-3 transition-[width] duration-200 ease-out sm:flex',
        !collapsed && 'lg:w-60',
      )}
    >
      <div
        className={cn(
          'mb-5 flex h-10 items-center justify-center',
          !collapsed && 'lg:justify-between lg:pl-2',
        )}
      >
        <NavLink to="/" aria-label={`${providers.appName} home`} className="rounded-sm">
          <LogoMark className={cn('size-9', !collapsed && 'lg:hidden')} />
          {!collapsed && <Wordmark className="hidden h-10 lg:block" />}
        </NavLink>
        {!collapsed && (
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className="hidden size-8 items-center justify-center rounded-full text-subtle-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none lg:inline-flex"
          >
            <PanelLeftClose className="size-4" aria-hidden />
          </button>
        )}
      </div>
      {collapsed && (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="Expand sidebar"
          title="Expand sidebar"
          className="mx-auto mb-3 hidden size-8 items-center justify-center rounded-full text-subtle-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none lg:inline-flex"
        >
          <PanelLeftOpen className="size-4" aria-hidden />
        </button>
      )}
      <ul className="space-y-1">
        {NAV_ITEMS.map((item) => (
          <li key={item.to}>
            <SideLink
              item={item}
              rail={collapsed}
              badge={item.to === '/autopilot' ? pending : 0}
            />
          </li>
        ))}
        <li className="pt-3">
          <SideLink item={HOOKS_ITEM} rail={collapsed} />
        </li>
      </ul>
      <div className="mt-auto space-y-2">
        <SideLink item={SETTINGS_ITEM} rail={collapsed} />
        <AutoActChip rail={collapsed} />
        <p
          className={cn(
            'micro-label px-2.5 pt-1 text-subtle-foreground',
            collapsed ? 'hidden' : 'hidden lg:block',
          )}
        >
          Testnet only
        </p>
      </div>
    </nav>
  );
}

function BottomTabs() {
  const pending = usePendingCount();
  return (
    <nav
      aria-label="Main"
      className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur sm:hidden"
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
              <item.icon className="size-5 stroke-[1.75]" aria-hidden />
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
 * Every "put this in the chat" lands on Ask, wherever it was pressed. Rebalance, Exit, New rule and
 * the rest used to sit beside the chat; without this they would change nothing the human can see.
 */
function usePrefillRouting() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(
    () =>
      observePrefill(() => {
        if (pathname !== '/ask') void navigate('/ask');
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
          {/* The product frame: dark, rounded, with light bleeding from behind it. */}
          <div className="relative min-h-0 flex-1 sm:mr-2 sm:mb-2">
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-[12%] -top-px hidden h-px bg-gradient-to-r from-transparent via-agent/60 to-transparent sm:block"
            />
            <main
              id="main"
              className="relative h-full min-w-0 pb-20 sm:overflow-y-auto sm:rounded-lg sm:border sm:border-border sm:bg-card/40 sm:pb-0 sm:shadow-[0_-24px_80px_-40px_var(--ai-deep)]"
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
