/** Hook card (PHASE 07 §2): score, pairs, explanation, permission chips, TVL/age, actions. */
import type { HookListItem } from '@warden/shared';
import { BadgeCheck, MessageSquareText, Repeat2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { Badge, HashChip } from '@/components/ui-kit';
import { requestPrefill } from '@/features/agent/prefill';
import { cn } from '@/lib/utils';
import {
  ageLabel,
  BAND_META,
  compactUsd,
  pairLabel,
  permissionCopy,
  riskTone,
} from './permission-copy';

const SCORE_RING = {
  safe: 'border-safe text-safe',
  caution: 'border-caution text-caution',
  danger: 'border-danger text-danger',
} as const;

export function ScoreRing({
  score,
  band,
  size = 'md',
}: {
  score: number;
  band: HookListItem['band'];
  size?: 'md' | 'lg';
}) {
  const meta = BAND_META[band];
  return (
    <div
      className={cn(
        'flex shrink-0 flex-col items-center justify-center rounded-full border-2 font-bold tabular-nums',
        SCORE_RING[meta.tone],
        size === 'lg' ? 'size-20 text-2xl' : 'size-14 text-lg',
      )}
      aria-label={`Safety score ${score} of 100, ${meta.label}`}
    >
      {score}
      <span className="text-[9px] font-semibold tracking-wide uppercase">{meta.label}</span>
    </div>
  );
}

export function PermissionChips({
  permissions,
  max = 6,
}: {
  permissions: HookListItem['permissions'];
  max?: number;
}) {
  if (!permissions.length)
    return <p className="text-xs text-muted-foreground">No callbacks enabled.</p>;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="What this hook can do">
      {permissions.slice(0, max).map((p) => {
        const copy = permissionCopy(p.flag);
        return (
          <li key={p.flag}>
            <SimpleTooltip label={`${copy.long} (${p.flag})`}>
              <span
                tabIndex={0}
                className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Badge tone={riskTone(p.risk)}>{copy.short}</Badge>
              </span>
            </SimpleTooltip>
          </li>
        );
      })}
      {permissions.length > max && (
        <li>
          <Badge>+{permissions.length - max} more</Badge>
        </li>
      )}
    </ul>
  );
}

export function HookCard({ hook }: { hook: HookListItem }) {
  const navigate = useNavigate();
  const detail = `/hooks/${hook.chainId}/${hook.address}`;
  const pairs = [...new Set(hook.pairs.map(pairLabel))];
  const firstPair = hook.pairs[0];
  const ask = () => {
    requestPrefill(`Explain hook ${hook.address}`);
    void navigate('/ask');
  };
  const trySwap = () => {
    const sell = firstPair?.token0Symbol ?? 'ETH';
    const buy = firstPair?.token1Symbol ?? 'USDC';
    requestPrefill(`Swap $5 ${sell} to ${buy} through the pool with hook ${hook.address}`);
    void navigate('/ask');
  };
  return (
    <article className="surface-highlight flex h-full flex-col rounded-lg border border-border bg-card p-5 transition-colors duration-150 hover:border-border-strong">
      <header className="flex items-start gap-3">
        <ScoreRing score={hook.score} band={hook.band} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium">
            <Link
              to={detail}
              className="rounded hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {hook.name ?? `${hook.address.slice(0, 6)}…${hook.address.slice(-4)}`}
            </Link>
          </h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {pairs.length ? pairs.slice(0, 3).join(' · ') : 'No pools yet'}
            {pairs.length > 3 ? ` +${pairs.length - 3}` : ''}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-subtle-foreground">
            <span>TVL {compactUsd(hook.tvlUsd)}</span>
            <span>· {ageLabel(hook.ageDays)}</span>
            <span>
              · {hook.poolCount} pool{hook.poolCount === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      </header>
      <p className="mt-3 line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">
        {hook.explanation?.text ?? 'Explanation pending — the score above is already final.'}
      </p>
      {hook.explanation?.requestId && (
        <div className="mt-1.5">
          <HashChip
            tone="zg"
            label={hook.explanation.model ?? '0G'}
            value={hook.explanation.requestId}
            icon={<BadgeCheck className="size-3" aria-hidden />}
          />
        </div>
      )}
      <div className="mt-3">
        <PermissionChips permissions={hook.permissions} max={4} />
      </div>
      <footer className="mt-auto flex flex-wrap gap-2 pt-4">
        <Button size="sm" variant="outline" onClick={ask}>
          <MessageSquareText aria-hidden /> Ask agent about this
        </Button>
        {hook.tradeable && firstPair && (
          <Button size="sm" variant="outline" onClick={trySwap}>
            <Repeat2 aria-hidden /> Try $5 through it
          </Button>
        )}
        <Button size="sm" variant="ghost" asChild className="ml-auto">
          <Link to={detail}>Details</Link>
        </Button>
      </footer>
    </article>
  );
}
