/** Portfolio "Liquidity" section (PHASE 07 §3): LP position cards with a range bar. */
import type { LpPositionView } from '@warden/shared';
import { Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui-kit';
import { requestPrefill } from '@/features/agent/prefill';
import { BAND_META } from '@/features/hooks/permission-copy';
import { formatTokenAmount } from '@/lib/format';
import { cn } from '@/lib/utils';
import { formatPrice, rangeGeometry } from './range';

const usd = (v: string) =>
  `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function RangeBar({ p }: { p: LpPositionView }) {
  const g = rangeGeometry(Number(p.priceLower), Number(p.priceUpper), Number(p.priceCurrent));
  if (!g) return null;
  const pair = `${p.token1.symbol} per ${p.token0.symbol}`;
  return (
    <div>
      <div
        className="relative h-2 rounded-full bg-surface-3"
        role="img"
        aria-label={`Range ${formatPrice(p.priceLower)} to ${formatPrice(p.priceUpper)} ${pair}; price now ${formatPrice(p.priceCurrent)}, ${g.inRange ? 'in range' : `out of range (${g.side})`}`}
      >
        <div
          className={cn(
            'absolute inset-y-0 rounded-full',
            g.inRange ? 'bg-safe/45' : 'bg-caution/35',
          )}
          style={{ left: `${g.left}%`, width: `${g.width}%` }}
        />
        <div
          className={cn(
            'absolute -top-1 h-4 w-0.5 -translate-x-1/2 rounded-full',
            g.inRange ? 'bg-safe' : 'bg-caution',
          )}
          style={{ left: `${g.marker}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-subtle-foreground tabular-nums">
        <span>{formatPrice(p.priceLower)}</span>
        <span className={g.inRange ? 'text-safe' : 'text-caution'}>
          now {formatPrice(p.priceCurrent)}
        </span>
        <span>{formatPrice(p.priceUpper)}</span>
      </div>
    </div>
  );
}

function PositionCard({ p }: { p: LpPositionView }) {
  const pair = `${p.token0.symbol}/${p.token1.symbol}`;
  const fees = [
    p.fees0 && Number(p.fees0) > 0 ? `${formatTokenAmount(p.fees0)} ${p.token0.symbol}` : null,
    p.fees1 && Number(p.fees1) > 0 ? `${formatTokenAmount(p.fees1)} ${p.token1.symbol}` : null,
  ].filter(Boolean);
  const pnl = p.pnlUsd !== null ? Number(p.pnlUsd) : null;
  return (
    <li className="rounded-lg border border-border bg-surface-2/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{pair}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge tone={p.inRange ? 'safe' : 'caution'}>
              {p.inRange ? 'In range' : 'Out of range'}
            </Badge>
            {p.hook && (
              <Badge tone={p.hook.band ? BAND_META[p.hook.band].tone : 'neutral'}>
                Hook {p.hook.score ?? '?'}
                {p.hook.band ? ` · ${BAND_META[p.hook.band].label}` : ''}
              </Badge>
            )}
          </div>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold tabular-nums">{p.valueUsd ? usd(p.valueUsd) : '—'}</p>
          {pnl !== null && (
            <p className={cn('text-[11px] tabular-nums', pnl >= 0 ? 'text-safe' : 'text-danger')}>
              {pnl >= 0 ? '+' : '−'}
              {usd(String(Math.abs(pnl)))}
            </p>
          )}
        </div>
      </div>
      <div className="mt-3">
        <RangeBar p={p} />
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground tabular-nums">
        {formatTokenAmount(p.amount0)} {p.token0.symbol} + {formatTokenAmount(p.amount1)}{' '}
        {p.token1.symbol}
        {fees.length ? ` · fees ${fees.join(' + ')}` : ''}
      </p>
      <div className="mt-2.5 flex gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 flex-1 text-xs"
          onClick={() =>
            requestPrefill(`Rebalance my ${pair} position ${p.id} around the current price`)
          }
        >
          Rebalance
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 flex-1 text-xs"
          onClick={() => requestPrefill(`Exit my ${pair} position ${p.id}`)}
        >
          Exit
        </Button>
      </div>
    </li>
  );
}

export function LiquiditySection({ positions }: { positions: LpPositionView[] }) {
  if (!positions.length)
    return (
      <section
        aria-labelledby="lp-title"
        className="flex items-center gap-3 rounded-lg border border-border bg-surface-2/40 px-3.5 py-3"
      >
        <Layers className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 id="lp-title" className="text-xs font-medium">
            Liquidity
          </h3>
          <p className="text-xs text-muted-foreground">No positions yet</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={() => requestPrefill('Put $10 into ETH/USDC')}
        >
          Add
        </Button>
      </section>
    );
  return (
    <section aria-labelledby="lp-title">
      <h3 id="lp-title" className="mb-2 text-xs font-medium text-muted-foreground">
        Liquidity · {positions.length} position{positions.length === 1 ? '' : 's'}
      </h3>
      <ul className="space-y-2">
        {positions.map((p) => (
          <PositionCard key={p.id} p={p} />
        ))}
      </ul>
    </section>
  );
}
