/** Hook card (PHASE 07 §2): score, pairs, explanation, permission chips, TVL/age, actions. */
import type { HookListItem } from '@warden/shared';
import { ArrowRight, BadgeCheck, MessageSquareText, Repeat2 } from 'lucide-react';
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
  splitExplanation,
} from './permission-copy';

const SCORE_COLOR = {
  safe: 'var(--success)',
  caution: 'var(--warning)',
  danger: 'var(--danger)',
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
  const color = SCORE_COLOR[meta.tone];
  return (
    <div
      role="img"
      className={cn('relative shrink-0', size === 'lg' ? 'size-20' : 'size-14')}
      aria-label={`Safety score ${score} of 100, ${meta.label}`}
    >
      <svg viewBox="0 0 56 56" className="size-full -rotate-90" aria-hidden>
        <circle cx="28" cy="28" r="24" fill="none" stroke="var(--bg-3)" strokeWidth="5" />
        <circle
          cx="28"
          cy="28"
          r="24"
          fill="none"
          stroke={color}
          strokeWidth="5"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${score} 100`}
        />
      </svg>
      <span
        className={cn(
          'absolute inset-0 flex items-center justify-center font-bold tabular-nums',
          size === 'lg' ? 'text-2xl' : 'text-lg',
        )}
        style={{ color }}
      >
        {score}
      </span>
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
    void navigate('/app');
  };
  const trySwap = () => {
    const sell = firstPair?.token0Symbol ?? 'ETH';
    const buy = firstPair?.token1Symbol ?? 'USDC';
    requestPrefill(`Swap $5 ${sell} to ${buy} through the pool with hook ${hook.address}`);
    void navigate('/app');
  };
  const copy = hook.explanation ? splitExplanation(hook.explanation.text) : null;
  return (
    <article className="glass flex h-full flex-col rounded-lg border border-border p-5 transition-colors duration-150 hover:border-border-strong">
      <header className="flex items-center gap-4">
        <ScoreRing score={hook.score} band={hook.band} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-h3 min-w-0 truncate font-semibold">
              <Link
                to={detail}
                className="rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {hook.name ?? `${hook.address.slice(0, 6)}…${hook.address.slice(-4)}`}
              </Link>
            </h3>
            <Badge tone={BAND_META[hook.band].tone}>{BAND_META[hook.band].label}</Badge>
          </div>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            {pairs.length ? pairs.slice(0, 3).join(' · ') : 'No pools yet'}
            {pairs.length > 3 ? ` +${pairs.length - 3}` : ''}
          </p>
        </div>
      </header>

      <dl className="mt-4 grid grid-cols-3 gap-3 rounded-md bg-surface-2 px-3.5 py-2.5 text-sm">
        <div>
          <dt className="text-xs text-subtle-foreground">TVL</dt>
          <dd className="font-medium tabular">{compactUsd(hook.tvlUsd)}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle-foreground">Age</dt>
          <dd className="font-medium tabular">{ageLabel(hook.ageDays)}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle-foreground">Pools</dt>
          <dd className="font-medium tabular">{hook.poolCount}</dd>
        </div>
      </dl>

      <p className="mt-4 line-clamp-3 text-[15px] leading-6">
        {copy?.what ?? 'Explanation pending — the score above is already final.'}
      </p>
      {copy?.why && (
        <p className="mt-1.5 line-clamp-2 text-sm leading-[22px] text-muted-foreground first-letter:uppercase">
          {copy.why}
        </p>
      )}

      <div className="mt-4">
        <PermissionChips permissions={hook.permissions} max={4} />
      </div>
      {hook.explanation?.requestId && (
        <div className="mt-3">
          <HashChip
            tone="zg"
            label={hook.explanation.model ?? '0G'}
            value={hook.explanation.requestId}
            icon={<BadgeCheck className="size-3" aria-hidden />}
          />
        </div>
      )}

      <footer className="mt-auto flex flex-wrap items-center gap-2 pt-5">
        <Button size="sm" variant="secondary" asChild>
          <Link to={detail}>
            Details <ArrowRight aria-hidden />
          </Link>
        </Button>
        <Button size="sm" variant="ghost" onClick={ask}>
          <MessageSquareText aria-hidden /> Ask agent about this
        </Button>
        {hook.tradeable && firstPair && (
          <Button size="sm" variant="ghost" onClick={trySwap}>
            <Repeat2 aria-hidden /> Try $5 through it
          </Button>
        )}
      </footer>
    </article>
  );
}
