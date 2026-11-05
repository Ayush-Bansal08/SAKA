import { chainMeta, type ProvidersResponse, type UserView } from '@warden/shared';
import { NavLink, Outlet } from 'react-router';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { DevBanner } from './DevBanner';
import { usesDevProviders } from './dev-mode';
import { Logo } from './Logo';
import { NAV_ITEMS } from './nav';
import { UserMenu } from './UserMenu';

export function ChainBadge({ chainId }: { chainId: ProvidersResponse['executionChainId'] }) {
  const chain = chainMeta(chainId);
  return (
    <SimpleTooltip label="Your agent executes on this testnet only. Market data comes from Ethereum mainnet (read-only).">
      <span
        tabIndex={0}
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="size-1.5 rounded-full bg-info" aria-hidden />
        <span className="text-foreground/90">{chain.name}</span>
        <span className="hidden text-subtle-foreground sm:inline">· testnet</span>
      </span>
    </SimpleTooltip>
  );
}

function TopBar({ providers, user }: { providers: ProvidersResponse; user: UserView }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background/85 px-4 backdrop-blur md:static md:px-5">
      <NavLink to="/" aria-label={`${providers.appName} home`} className="rounded-md">
        <Logo appName={providers.appName} />
      </NavLink>
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <ChainBadge chainId={providers.executionChainId} />
        <UserMenu user={user} />
      </div>
    </header>
  );
}

function SideNav() {
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
                  'flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors',
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
  return (
    <div className="flex min-h-dvh flex-col md:h-dvh md:overflow-hidden">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      {usesDevProviders(providers) && <DevBanner />}
      <TopBar providers={providers} user={user} />
      <div className="flex flex-1 md:min-h-0">
        <SideNav />
        <main id="main" className="min-w-0 flex-1 pb-20 md:overflow-y-auto md:pb-0">
          {/* Pages read the signed-in user via useOutletContext(). */}
          <Outlet context={{ user }} />
        </main>
      </div>
      <BottomTabs />
    </div>
  );
}
