/** Portfolio "Liquidity" section (PHASE 07 §3): LP position cards with a range bar. */
import type { LpPositionView } from '@warden/shared';
import { ChevronDown, Layers } from 'lucide-react';
import { useId, useState } from 'react';
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
      <div className="mt-1 flex justify-between text-xs text-subtle-foreground tabular-nums">
        <span>{formatPrice(p.priceLower)}</span>
        <span className={g.inRange ? 'text-safe' : 'text-caution'}>
          now {formatPrice(p.priceCurrent)}
        </span>
        <span>{formatPrice(p.priceUpper)}</span>
      </div>
    </div>
  );
}

function PositionCard({ p, startOpen }: { p: LpPositionView; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const bodyId = useId();
  const pair = `${p.token0.symbol}/${p.token1.symbol}`;
  const fees = [
    p.fees0 && Number(p.fees0) > 0 ? `${formatTokenAmount(p.fees0)} ${p.token0.symbol}` : null,
    p.fees1 && Number(p.fees1) > 0 ? `${formatTokenAmount(p.fees1)} ${p.token1.symbol}` : null,
  ].filter(Boolean);
  const pnl = p.pnlUsd !== null ? Number(p.pnlUsd) : null;
  return (
    <li className="rounded-md border border-border bg-surface-2/40">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={`${open ? 'Hide' : 'Show'} ${pair} position details`}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-2 rounded-md p-3.5 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium">{pair}</span>
          <span className="mt-1 flex flex-wrap gap-1">
            <Badge tone={p.inRange ? 'safe' : 'caution'}>
              {p.inRange ? 'In range' : 'Out of range'}
            </Badge>
            {p.hook && (
              <Badge tone={p.hook.band ? BAND_META[p.hook.band].tone : 'neutral'}>
                Hook {p.hook.score ?? '?'}
                {p.hook.band ? ` · ${BAND_META[p.hook.band].label}` : ''}
              </Badge>
            )}
          </span>
        </span>
        <span className="flex items-start gap-2">
          <span className="text-right">
            <span className="block text-sm font-medium tabular-nums">
              {p.valueUsd ? usd(p.valueUsd) : '—'}
            </span>
            {pnl !== null && (
              <span
                className={cn(
                  'block text-xs tabular-nums',
                  pnl >= 0 ? 'text-safe' : 'text-danger',
                )}
              >
                {pnl >= 0 ? '+' : '−'}
                {usd(String(Math.abs(pnl)))}
              </span>
            )}
          </span>
          <ChevronDown
            className={cn(
              'mt-0.5 size-4 shrink-0 text-subtle-foreground transition-transform duration-150',
              !open && '-rotate-90',
            )}
            aria-hidden
          />
        </span>
      </button>
      {open && (
        <div id={bodyId} className="px-3.5 pb-3.5">
          <RangeBar p={p} />
          <p className="mt-2 text-xs text-muted-foreground tabular-nums">
            {formatTokenAmount(p.amount0)} {p.token0.symbol} + {formatTokenAmount(p.amount1)}{' '}
            {p.token1.symbol}
            {fees.length ? ` · fees ${fees.join(' + ')}` : ''}
          </p>
          <div className="mt-2.5 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={() =>
                requestPrefill(`Rebalance my ${pair} position ${p.id} around the current price`)
              }
            >
              Rebalance
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={() => requestPrefill(`Exit my ${pair} position ${p.id}`)}
            >
              Exit
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function LiquiditySection({ positions }: { positions: LpPositionView[] }) {
  if (!positions.length)
    return (
      <section
        aria-labelledby="lp-title"
        className="flex items-center gap-3 rounded-md border border-border bg-surface-2/40 px-3.5 py-3"
      >
        <Layers className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 id="lp-title" className="text-xs font-medium">
            Liquidity
          </h3>
          <p className="text-xs text-muted-foreground">No positions yet</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => requestPrefill('Put $10 into ETH/USDC')}>
          Add
        </Button>
      </section>
    );
  return (
    <section aria-labelledby="lp-title">
      <h3 id="lp-title" className="micro-label mb-3 text-subtle-foreground">
        Liquidity · {positions.length} position{positions.length === 1 ? '' : 's'}
      </h3>
      <ul className="space-y-2">
        {positions.map((p) => (
          // Short lists stay open; in a long one, only positions needing attention do.
          <PositionCard key={p.id} p={p} startOpen={positions.length <= 3 || !p.inRange} />
        ))}
      </ul>
    </section>
  );
}
