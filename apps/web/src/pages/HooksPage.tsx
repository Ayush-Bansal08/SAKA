/** Hooks explorer (PHASE 07 §2): "Uniswap v4 hooks, explained". */
import {
  chainMeta,
  type ExecutionChainId,
  type HookScope,
  type ProvidersResponse,
} from '@warden/shared';
import { Blocks, Loader2, Search } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui-kit';
import { useProviders } from '@/features/auth/hooks';
import { HookCard } from '@/features/hooks/HookCard';
import { useHooks, type HookFilters } from '@/features/hooks/hooks';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PageContainer, PageHeader } from './PageHeader';

const BANDS = [
  { id: undefined, label: 'All' },
  { id: 'SAFE', label: 'Safe' },
  { id: 'CAUTION', label: 'Caution' },
  { id: 'DANGER', label: 'Danger' },
] as const;

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'min-h-9 rounded-full border px-4 py-1 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        active
          ? 'border-agent/60 bg-agent/15 text-foreground'
          : 'border-border text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function CardSkeleton() {
  return (
    <div className="glass rounded-lg border border-border p-5" aria-hidden>
      <div className="flex gap-3">
        <Skeleton className="size-14 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </div>
      <Skeleton className="mt-4 h-3 w-full" />
      <Skeleton className="mt-2 h-3 w-4/5" />
      <Skeleton className="mt-4 h-6 w-2/3" />
    </div>
  );
}

export function HooksPage() {
  useOutletContext();
  const providers = useProviders();
  const execName = providers.data
    ? chainMeta(providers.data.executionChainId as ExecutionChainId).name
    : 'testnet';
  const [scope, setScope] = useState<HookScope>('market');
  const [band, setBand] = useState<HookFilters['band']>(undefined);
  const [fresh, setFresh] = useState(false);
  const [sort, setSort] = useState<HookFilters['sort']>('new');
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search);
  const filters = useMemo<HookFilters>(
    () => ({ scope, band, fresh, sort, q }),
    [scope, band, fresh, sort, q],
  );
  const hooks = useHooks(filters);
  const items = hooks.data?.pages.flatMap((p) => p.hooks) ?? [];
  const first = hooks.data?.pages[0];

  return (
    <PageContainer>
      <PageHeader
        title="Uniswap v4 hooks, explained"
        description="Every hook gets a 0–100 safety score from the Uniswap v4 Security Framework (deterministic) and a plain-English explanation written on 0G."
      />

      <div className="glass mb-4 flex flex-wrap items-center gap-2.5 rounded-lg border border-border p-2.5">
        <div role="tablist" aria-label="Hook source" className="flex flex-wrap gap-1">
          {(
            [
              ['market', 'Market', 'Ethereum mainnet · read-only'],
              ['execution', 'Tradeable', execName],
            ] as const
          ).map(([id, label, sub]) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={scope === id}
              onClick={() => setScope(id)}
              className={cn(
                'min-h-10 rounded-md px-3.5 text-left text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                scope === id
                  ? 'bg-surface-3 text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
              <span className="ml-1.5 hidden text-xs font-normal text-subtle-foreground md:inline">
                {sub}
              </span>
            </button>
          ))}
        </div>
        <div className="relative min-w-[200px] flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle-foreground"
            aria-hidden
          />
          <label htmlFor="hook-search" className="sr-only">
            Search hooks by address or token
          </label>
          <input
            id="hook-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by token or 0x address"
            className="h-11 w-full rounded-md border border-border bg-surface-2 pr-3 pl-9 text-sm placeholder:text-subtle-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:h-10"
          />
        </div>
        <label htmlFor="hook-sort" className="sr-only">
          Sort
        </label>
        <select
          id="hook-sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as HookFilters['sort'])}
          className="h-11 rounded-md border border-border bg-surface-2 px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:h-10"
        >
          <option value="new">Newest</option>
          <option value="tvl">Highest TVL</option>
          <option value="score">Safest</option>
        </select>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {BANDS.map((b) => (
          <Chip key={b.label} active={band === b.id} onClick={() => setBand(b.id)}>
            {b.label}
          </Chip>
        ))}
        <Chip active={fresh} onClick={() => setFresh((v) => !v)}>
          New this week
        </Chip>
        {first && (
          <p className="ml-auto text-sm text-subtle-foreground">
            {first.total} hook{first.total === 1 ? '' : 's'}
            {first.indexedAt
              ? ` · indexed ${formatRelative(first.indexedAt)}`
              : ' · first scan in progress'}
            {scope === 'market' ? ' · Market data · Ethereum mainnet' : ''}
          </p>
        )}
      </div>

      {hooks.isPending ? (
        <div className="grid gap-4 lg:grid-cols-2" aria-busy="true" aria-label="Loading hooks">
          {Array.from({ length: 6 }, (_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : hooks.isError ? (
        <ErrorState
          title="Couldn't load hooks"
          description={hooks.error.message}
          onRetry={() => void hooks.refetch()}
          retrying={hooks.isFetching}
        />
      ) : items.length === 0 ? (
        <div className="glass rounded-lg border border-border">
          <EmptyState
            icon={<Blocks />}
            title={
              band || fresh || q
                ? 'No hooks match these filters'
                : scope === 'execution'
                  ? `No hooks on ${execName} yet`
                  : first?.indexedAt
                    ? 'No new hooks in the last 30 days'
                    : 'Indexing hooks…'
            }
            description={
              band || fresh || q
                ? 'Try another band or clear the search.'
                : scope === 'execution'
                  ? 'Hook pools initialized on the execution chain appear here once they exist — and you can swap through them.'
                  : 'The indexer scans mainnet every 5 minutes. Hooks appear here with their score as soon as they are scored.'
            }
          />
        </div>
      ) : (
        <>
          <ul className="grid gap-4 lg:grid-cols-2">
            {items.map((h) => (
              <li key={`${h.chainId}-${h.address}`}>
                <HookCard hook={h} />
              </li>
            ))}
          </ul>
          {hooks.hasNextPage && (
            <div className="mt-5 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void hooks.fetchNextPage()}
                disabled={hooks.isFetchingNextPage}
              >
                {hooks.isFetchingNextPage && <Loader2 className="animate-spin" />} Load more
              </Button>
            </div>
          )}
        </>
      )}
    </PageContainer>
  );
}

export type { ProvidersResponse };
