/** The portfolio at a glance, beside the chat: value, holdings and today's spend. */
import { Decimal, usd } from '@warden/shared';
import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, Stat } from '@/components/ui-kit';
import { deltaTone, formatSignedPct, formatSignedUsd, formatTokenAmount } from '@/lib/format';
import { usePortfolio } from './hooks';

export function PortfolioRail() {
  const portfolio = usePortfolio();
  const data = portfolio.data;
  if (!data)
    return (
      <Card className="p-5">
        {portfolio.isPending ? (
          <div role="status" aria-label="Loading portfolio" className="space-y-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-9 w-36" />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{portfolio.error?.message}</p>
        )}
      </Card>
    );
  const hasPnl = data.pnl.perToken.length > 0;
  const perDay = new Decimal(data.limits.perDayUsd);
  const pct = perDay.gt(0)
    ? Decimal.min(100, new Decimal(data.limits.usedTodayUsd).div(perDay).times(100)).toNumber()
    : 0;
  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
      <Card className="p-5">
        <Stat
          size="lg"
          label="Portfolio value"
          value={usd(data.totalUsd)}
          {...(hasPnl
            ? {
                delta: `${formatSignedUsd(data.pnl.totalUsd, usd)}${
                  data.pnl.pct ? ` (${formatSignedPct(data.pnl.pct)})` : ''
                }`,
                deltaTone: deltaTone(data.pnl.totalUsd),
                hint: 'all-time',
              }
            : { hint: data.address ? 'No deposits yet' : 'No wallet yet' })}
        />
        <ul className="mt-4 divide-y divide-border">
          {data.tokens
            .filter((t) => t.balanceRaw !== '0')
            .map((t) => (
              <li key={t.address} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="font-medium">{t.symbol}</span>
                <span className="min-w-0 truncate text-muted-foreground tabular">
                  {formatTokenAmount(t.balance)}
                </span>
                <span className="font-medium tabular">{t.valueUsd ? usd(t.valueUsd) : '—'}</span>
              </li>
            ))}
        </ul>
        <Link
          to="/portfolio"
          className="mt-3 inline-flex min-h-9 items-center gap-1.5 text-sm font-medium text-agent underline-offset-4 hover:underline"
        >
          Open portfolio <ArrowRight className="size-4" aria-hidden />
        </Link>
      </Card>
      <Card className="p-5">
        <p className="micro-label text-subtle-foreground">Agent spend today</p>
        <p className="mt-1.5 text-sm">
          <span className="font-semibold tabular">{usd(data.limits.usedTodayUsd)}</span>
          <span className="text-muted-foreground"> of {usd(data.limits.perDayUsd)}</span>
        </p>
        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
          <div
            className="h-full rounded-full bg-agent"
            style={{ width: `${Math.max(pct, pct > 0 ? 3 : 0)}%` }}
          />
        </div>
      </Card>
    </div>
  );
}
