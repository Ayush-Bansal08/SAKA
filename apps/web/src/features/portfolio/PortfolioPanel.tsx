/**
 * Cockpit left column (PHASE 03 §5): total value, P&L, tokens, LP placeholder, risk meter and
 * today's limit usage. Polls GET /portfolio every 15 s and refreshes on relevant trace events.
 */
import {
  Decimal,
  usd,
  type PortfolioResponse,
  type PortfolioTokenView,
  type RiskMeter,
  type UserView,
} from '@warden/shared';
import { Droplets, Info, RotateCw, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { AddressChip, Badge, EmptyState, ErrorState, Panel, Stat } from '@/components/ui-kit';
import {
  deltaTone,
  formatRelative,
  formatSignedPct,
  formatSignedUsd,
  formatTokenAmount,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import { useNow } from '@/hooks/useNow';
import { usePortfolio } from './hooks';
import { LiquiditySection } from './Liquidity';
import { PROFILE_COPY } from './profile-copy';

export function PortfolioPanel({ user }: { user: UserView }) {
  const portfolio = usePortfolio();
  const data = portfolio.data;

  return (
    <Panel
      id="portfolio"
      title="Portfolio"
      subtitle={data?.address ? 'Your agent wallet' : undefined}
      icon={<Wallet />}
      actions={
        data ? (
          <RefreshButton
            asOf={data.asOf}
            fetching={portfolio.isFetching}
            onRefresh={() => void portfolio.refetch()}
          />
        ) : undefined
      }
      bodyClassName="flex flex-col gap-5 overflow-y-auto"
    >
      {portfolio.isPending ? (
        <PortfolioSkeleton />
      ) : !data ? (
        <ErrorState
          className="py-8"
          title="Couldn't load your portfolio"
          description={portfolio.error?.message}
          onRetry={() => void portfolio.refetch()}
          retrying={portfolio.isFetching}
        />
      ) : (
        <>
          {portfolio.isError && (
            <p role="status" className="-mb-2 flex items-center gap-1.5 text-xs text-caution">
              <Info className="size-3.5" aria-hidden />
              Showing the last known values — {portfolio.error.message}
            </p>
          )}
          <Totals data={data} />
          <Tokens data={data} />
          <LiquiditySection positions={data.lpPositions} />
          <RiskMeterView risk={data.risk} />
          <LimitsBar data={data} profileLabel={PROFILE_COPY[user.riskProfile].label} />
          <PriceSource data={data} />
        </>
      )}
    </Panel>
  );
}

function RefreshButton({
  asOf,
  fetching,
  onRefresh,
}: {
  asOf: string;
  fetching: boolean;
  onRefresh: () => void;
}) {
  const now = useNow(15_000);
  return (
    <SimpleTooltip label={`Updated ${formatRelative(asOf, now)} · refreshes every 15 s`}>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label="Refresh portfolio"
        onClick={onRefresh}
        disabled={fetching}
      >
        <RotateCw
          className={cn(fetching && 'animate-spin motion-reduce:animate-none')}
          aria-hidden
        />
      </Button>
    </SimpleTooltip>
  );
}

function PortfolioSkeleton() {
  return (
    <div role="status" aria-label="Loading portfolio" className="space-y-5">
      <div className="space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-3 w-28" />
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-8 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-2.5 w-24" />
          </div>
          <Skeleton className="h-3 w-14" />
        </div>
      ))}
      <Skeleton className="h-28 w-full rounded-lg" />
      <Skeleton className="h-14 w-full rounded-lg" />
    </div>
  );
}

// ---------------------------------------------------------------------------

function Totals({ data }: { data: PortfolioResponse }) {
  const hasPnl = data.pnl.perToken.length > 0;
  return (
    <div className="grid grid-cols-2 gap-4">
      <Stat
        className="col-span-2"
        size="lg"
        label="Total value"
        value={usd(data.totalUsd)}
        {...(hasPnl
          ? {
              delta: `${formatSignedUsd(data.pnl.totalUsd, usd)}${
                data.pnl.pct ? ` (${formatSignedPct(data.pnl.pct)})` : ''
              }`,
              deltaTone: deltaTone(data.pnl.totalUsd),
              hint: 'all-time P&L',
            }
          : { hint: data.address ? 'No deposits yet' : 'No wallet yet' })}
      />
    </div>
  );
}

const TOKEN_TONE: Record<string, string> = {
  ETH: 'bg-info/15 text-info',
  WETH: 'bg-info/15 text-info',
  USDC: 'bg-safe/15 text-safe',
};

function Tokens({ data }: { data: PortfolioResponse }) {
  const funded = data.tokens.some((t) => t.balanceRaw !== '0');
  if (!funded) {
    return (
      <EmptyState
        className="rounded-lg border border-dashed border-border-strong px-4 py-6"
        icon={<Droplets />}
        title="Waiting for funds"
        description="Send testnet ETH to your agent wallet. Deposits show up here within about 15 seconds."
      >
        {data.address && (
          <AddressChip address={data.address} chainId={data.chainId} className="mt-4" />
        )}
      </EmptyState>
    );
  }
  return (
    <section aria-labelledby="tokens-title">
      <h3 id="tokens-title" className="text-xs font-medium text-muted-foreground">
        Tokens
      </h3>
      <ul className="mt-2 divide-y divide-border">
        {data.tokens.map((t) => (
          <TokenRow key={t.address} token={t} />
        ))}
      </ul>
    </section>
  );
}

function TokenRow({ token: t }: { token: PortfolioTokenView }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
          TOKEN_TONE[t.symbol] ?? 'bg-surface-3 text-muted-foreground',
        )}
        aria-hidden
      >
        {t.symbol.slice(0, 4)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{t.symbol}</div>
        <div className="truncate text-xs text-muted-foreground tabular" title={t.balance}>
          {formatTokenAmount(t.balance)}
          {t.priceUsd && <span className="text-subtle-foreground"> · {usd(t.priceUsd)}</span>}
        </div>
      </div>
      <div className="text-right">
        <div className="text-sm font-medium tabular">{t.valueUsd ? usd(t.valueUsd) : '—'}</div>
        {t.pnl ? (
          <div
            className={cn(
              'text-xs tabular',
              deltaTone(t.pnl.pnlUsd) === 'up' && 'text-safe',
              deltaTone(t.pnl.pnlUsd) === 'down' && 'text-danger',
              deltaTone(t.pnl.pnlUsd) === 'flat' && 'text-subtle-foreground',
            )}
          >
            {t.pnl.pct ? formatSignedPct(t.pnl.pct) : formatSignedUsd(t.pnl.pnlUsd, usd)}
          </div>
        ) : (
          t.sharePct && (
            <div className="text-xs text-subtle-foreground tabular">
              {Number(t.sharePct).toFixed(0)}%
            </div>
          )
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Risk meter
// ---------------------------------------------------------------------------

const RISK_TONE = {
  Low: { text: 'text-safe', stroke: 'var(--safe)', badge: 'safe' },
  Moderate: { text: 'text-caution', stroke: 'var(--caution)', badge: 'caution' },
  High: { text: 'text-danger', stroke: 'var(--danger)', badge: 'danger' },
} as const;

const FACTOR_LABEL: Record<RiskMeter['factors'][number]['factor'], string> = {
  concentration: 'Concentration',
  stablecoin: 'Stablecoin buffer',
  lpOutOfRange: 'LP out of range',
  hookExposure: 'Hook exposure',
  drawdown: 'Drawdown vs 7-day high',
};

function RiskMeterView({ risk }: { risk: RiskMeter }) {
  const tone = RISK_TONE[risk.label];
  // 240° arc gauge.
  const r = 34;
  const circumference = 2 * Math.PI * r;
  const arc = (circumference * 240) / 360;
  const filled = (arc * risk.score) / 100;

  const breakdown = (
    <div className="space-y-1">
      <div className="font-medium">How the score is built</div>
      {risk.factors.map((f) => (
        <div key={f.factor} className="flex justify-between gap-4">
          <span className="text-muted-foreground">{FACTOR_LABEL[f.factor]}</span>
          <span className="tabular">{f.available ? `${f.points.toFixed(0)} pts` : 'n/a'}</span>
        </div>
      ))}
    </div>
  );

  return (
    <section
      aria-labelledby="risk-title"
      className="rounded-lg border border-border bg-surface-2/40 p-3.5"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id="risk-title" className="text-xs font-medium text-muted-foreground">
          Risk meter
        </h3>
        <SimpleTooltip label={breakdown}>
          <button
            type="button"
            className="inline-flex size-6 items-center justify-center rounded text-subtle-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label="How the risk score is built"
          >
            <Info className="size-3.5" aria-hidden />
          </button>
        </SimpleTooltip>
      </div>
      <div className="mt-2 flex items-center gap-4">
        <div
          className="relative size-[84px] shrink-0"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={risk.score}
          aria-valuetext={`${risk.score} of 100, ${risk.label} risk`}
          aria-label="Portfolio risk"
        >
          <svg viewBox="0 0 84 84" className="size-full -rotate-[210deg]" aria-hidden>
            <circle
              cx="42"
              cy="42"
              r={r}
              fill="none"
              stroke="var(--surface-3)"
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray={`${arc} ${circumference}`}
            />
            <circle
              cx="42"
              cy="42"
              r={r}
              fill="none"
              stroke={tone.stroke}
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray={`${filled} ${circumference}`}
              className="transition-[stroke-dasharray] duration-700 motion-reduce:transition-none"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={cn('text-xl font-semibold tabular', tone.text)}>{risk.score}</span>
            <span className="text-[10px] text-subtle-foreground">/ 100</span>
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <Badge tone={tone.badge}>{risk.label} risk</Badge>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {risk.drivers.map((d) => (
              <li key={d} className="flex gap-1.5">
                <span
                  aria-hidden
                  className="mt-1.5 size-1 shrink-0 rounded-full bg-subtle-foreground"
                />
                <span>{d}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

function LimitsBar({ data, profileLabel }: { data: PortfolioResponse; profileLabel: string }) {
  const { usedTodayUsd, perDayUsd, perActionUsd, remainingTodayUsd } = data.limits;
  const perDay = new Decimal(perDayUsd);
  const pct = perDay.gt(0)
    ? Decimal.min(100, new Decimal(usedTodayUsd).div(perDay).times(100)).toNumber()
    : 0;
  const tone = pct >= 90 ? 'bg-danger' : pct >= 60 ? 'bg-caution' : 'bg-agent';
  return (
    <section
      aria-labelledby="limits-title"
      className="rounded-lg border border-border bg-surface-2/40 p-3.5"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id="limits-title" className="text-xs font-medium text-muted-foreground">
          Agent spending today
        </h3>
        <Badge tone="agent">{profileLabel}</Badge>
      </div>
      <p className="mt-2 text-sm">
        <span className="font-semibold tabular">{usd(usedTodayUsd)}</span>
        <span className="text-muted-foreground"> of {usd(perDayUsd)} used today</span>
      </p>
      <div
        className="mt-2 h-2 overflow-hidden rounded-full bg-surface-3"
        role="progressbar"
        aria-label="Daily limit used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none',
            tone,
          )}
          style={{ width: `${Math.max(pct, pct > 0 ? 3 : 0)}%` }}
        />
      </div>
      <div className="mt-2 flex justify-between gap-2 text-xs text-subtle-foreground">
        <span>Up to {usd(perActionUsd)} per action</span>
        <span className="tabular">{usd(remainingTodayUsd)} left</span>
      </div>
    </section>
  );
}

function PriceSource({ data }: { data: PortfolioResponse }) {
  return (
    <div className="mt-auto space-y-1 text-[11px] text-subtle-foreground">
      <p>USD values: {data.priceSource}</p>
      {data.unpriced.length > 0 && <p>Not priced: {data.unpriced.join(', ')}</p>}
      {data.warnings.map((w) => (
        <p key={w}>{w}</p>
      ))}
    </div>
  );
}
