/**
 * Info answers (PHASE 06 §2 InfoCard): token safety verdict, pool comparison, hook explanation,
 * portfolio summary — rendered from the deterministic tool facts in `card.data` — and the
 * transient intent card ("Preparing…") shown while a plan has no pipeline card yet.
 */
import { type InfoCard, type InfoData, type IntentCard } from '@warden/shared';
import {
  Blocks,
  Brain,
  CircleAlert,
  Info,
  ListTodo,
  Loader2,
  PieChart,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  Trophy,
} from 'lucide-react';
import type * as React from 'react';
import { Button } from '@/components/ui/button';
import { AddressChip, Badge } from '@/components/ui-kit';
import { useCancelTrigger, useTriggers } from '@/features/hooks/hooks';
import { formatTokenAmount } from '@/lib/format';
import { cn } from '@/lib/utils';
import { infoData, usd } from './card-utils';
import { CardShell, type CardTone } from './parts';

const VERDICT = {
  OK: { tone: 'safe' as const, label: 'Looks safe', icon: <ShieldCheck /> },
  CAUTION: { tone: 'caution' as const, label: 'Caution', icon: <ShieldQuestion /> },
  BLOCK: { tone: 'danger' as const, label: 'Unsafe', icon: <ShieldX /> },
};
const BAND = {
  SAFE: { tone: 'safe' as const, label: 'Safe' },
  CAUTION: { tone: 'caution' as const, label: 'Caution' },
  DANGER: { tone: 'danger' as const, label: 'Danger' },
};

function MarketLabel({ source }: { source: InfoCard['marketDataSource'] }) {
  if (source !== 'reference') return null;
  return <span className="text-xs text-subtle-foreground">Market data · Ethereum mainnet</span>;
}

function TokenCheck({ d }: { d: Extract<InfoData, { kind: 'token_check' }> }) {
  const v = VERDICT[d.verdict];
  const facts: [string, string, boolean | null][] = [
    ['On the allowlist', d.onAllowlist ? 'Yes' : 'No', d.onAllowlist],
    [
      'Uniswap unsupported list',
      d.onUniswapUnsupportedList === null
        ? 'Unknown'
        : d.onUniswapUnsupportedList
          ? 'Listed'
          : 'Not listed',
      d.onUniswapUnsupportedList === null ? null : !d.onUniswapUnsupportedList,
    ],
    [
      'Liquidity depth',
      d.liquidityDepthUsd ? usd(d.liquidityDepthUsd) : 'Not measurable',
      d.liquidityDepthUsd ? Number(d.liquidityDepthUsd) >= 10_000 : false,
    ],
  ];
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={v.tone} className="px-2.5 py-1 text-xs">
          {v.label}
        </Badge>
        {!d.isNative && <AddressChip address={d.address} />}
        {d.isNative && <Badge>Native ETH</Badge>}
      </div>
      <dl className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
        {facts.map(([k, val, ok]) => (
          <div key={k} className="rounded-md border border-border/70 bg-background/40 px-2.5 py-2">
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd
              className={cn(
                'text-sm font-medium tabular-nums',
                ok === false ? 'text-danger' : ok ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {val}
            </dd>
          </div>
        ))}
      </dl>
      {d.riskFlags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Risk flags">
          {d.riskFlags.map((f) => (
            <li key={f}>
              <Badge tone="caution" icon={<CircleAlert aria-hidden />}>
                {f.replace(/_/g, ' ').toLowerCase()}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function PoolCompare({ d }: { d: Extract<InfoData, { kind: 'pool_compare' }> }) {
  return (
    <>
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-xs">
          <caption className="sr-only">Pools for {d.pair}, best first</caption>
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="px-1 py-1 font-medium">#</th>
              <th className="px-1 py-1 font-medium">Fee</th>
              <th className="px-1 py-1 font-medium">Hook</th>
              <th className="px-1 py-1 text-right font-medium">Fee APR</th>
              <th className="px-1 py-1 text-right font-medium">TVL</th>
              <th className="px-1 py-1 text-right font-medium">Testnet</th>
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r) => {
              const pick = r.poolId === d.recommendedPoolId;
              return (
                <tr
                  key={r.poolId}
                  className={cn('border-t border-border/60', pick && 'bg-safe/[0.06]')}
                >
                  <td className="px-1 py-1.5 tabular-nums">
                    {pick ? <Trophy className="size-3.5 text-safe" aria-label="Pick" /> : r.rank}
                  </td>
                  <td className="px-1 py-1.5 font-medium tabular-nums">{r.feePct}%</td>
                  <td className="px-1 py-1.5">
                    {r.hookAddress ? (
                      r.hookBand ? (
                        <Badge tone={BAND[r.hookBand].tone}>
                          {BAND[r.hookBand].label} {r.hookScore ?? ''}
                        </Badge>
                      ) : (
                        <Badge>Unscored</Badge>
                      )
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </td>
                  <td className="px-1 py-1.5 text-right tabular-nums">
                    {r.aprPct ? `${Number(r.aprPct).toFixed(1)}%` : '—'}
                  </td>
                  <td className="px-1 py-1.5 text-right tabular-nums">
                    {r.tvlUsd ? compactUsd(r.tvlUsd) : '—'}
                  </td>
                  <td className="px-1 py-1.5 text-right">
                    {r.usable ? (
                      <span className="text-safe">✓</span>
                    ) : (
                      <span className="text-subtle-foreground">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {d.reasons.length > 0 && (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {d.reasons.map((r) => (
            <li key={r}>• {r}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function HookScore({ d }: { d: Extract<InfoData, { kind: 'hook_score' }> }) {
  const b = BAND[d.band];
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div
          className={cn(
            'flex size-14 flex-col items-center justify-center rounded-full border-2 text-lg font-bold tabular-nums',
            b.tone === 'safe' && 'border-safe text-safe',
            b.tone === 'caution' && 'border-caution text-caution',
            b.tone === 'danger' && 'border-danger text-danger',
          )}
          aria-label={`Hook score ${d.score} of 100, ${b.label}`}
        >
          {d.score}
        </div>
        <div className="space-y-1 text-xs">
          <Badge tone={b.tone}>{b.label}</Badge>
          <p className="text-muted-foreground">
            {d.upgradeable ? 'Upgradeable' : 'Not upgradeable'} ·{' '}
            {d.verifiedSource === null
              ? 'source unknown'
              : d.verifiedSource
                ? 'verified source'
                : 'unverified source'}
            {d.ageDays !== null && ` · ${Math.round(d.ageDays)} days old`}
          </p>
          <AddressChip address={d.address} />
        </div>
      </div>
      {d.permissions.length > 0 && (
        <div>
          <p className="mb-1 text-xs text-muted-foreground">What it can do</p>
          <ul className="flex flex-wrap gap-1.5">
            {d.permissions.map((p) => (
              <li key={p.flag}>
                <Badge
                  tone={
                    p.risk === 'HIGH' || p.risk === 'CRITICAL'
                      ? 'danger'
                      : p.risk === 'MEDIUM'
                        ? 'caution'
                        : 'neutral'
                  }
                >
                  {p.flag}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
      {d.breakdown.length > 0 && (
        <ul className="space-y-1 text-xs">
          {d.breakdown.map((x) => (
            <li key={x.rule} className="flex gap-2">
              <span className="w-8 shrink-0 text-right font-semibold text-caution tabular-nums">
                {x.penalty}
              </span>
              <span className="text-muted-foreground">{x.evidence}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Portfolio({ d }: { d: Extract<InfoData, { kind: 'portfolio' }> }) {
  const used = Number(d.limits.usedTodayUsd);
  const perDay = Number(d.limits.perDayUsd) || 1;
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-3">
        <p className="text-2xl font-semibold tracking-tight tabular-nums">{usd(d.totalUsd)}</p>
        {d.pnlUsd && (
          <span
            className={cn(
              'text-sm font-medium tabular-nums',
              Number(d.pnlUsd) >= 0 ? 'text-safe' : 'text-danger',
            )}
          >
            {Number(d.pnlUsd) >= 0 ? '+' : '−'}
            {usd(Math.abs(Number(d.pnlUsd)))} P&L
          </span>
        )}
        {d.risk && (
          <Badge
            tone={
              d.risk.label === 'High' ? 'danger' : d.risk.label === 'Moderate' ? 'caution' : 'safe'
            }
          >
            Risk {d.risk.label} · {d.risk.score}
          </Badge>
        )}
      </div>
      <ul className="divide-y divide-border/60 rounded-md border border-border/70 bg-background/40 px-2.5">
        {d.tokens.map((t) => (
          <li key={t.symbol} className="flex items-center justify-between gap-2 py-1.5 text-xs">
            <span className="font-medium">{t.symbol}</span>
            <span className="tabular-nums text-muted-foreground">
              {formatTokenAmount(t.amount)}
              {t.usd && <span className="ml-2 text-foreground">{usd(t.usd)}</span>}
            </span>
          </li>
        ))}
        {d.tokens.length === 0 && (
          <li className="py-2 text-xs text-muted-foreground">
            No tokens yet — fund your agent wallet.
          </li>
        )}
      </ul>
      <p className="text-xs text-muted-foreground tabular-nums">
        Agent spending today {usd(d.limits.usedTodayUsd)} of {usd(d.limits.perDayUsd)} (
        {Math.round((used / perDay) * 100)}%) · up to {usd(d.limits.perActionUsd)} per action
      </p>
    </>
  );
}

function TriggerRule({ d }: { d: Extract<InfoData, { kind: 'trigger' }> }) {
  const cancel = useCancelTrigger();
  const rules = useTriggers();
  const live = rules.data?.triggers.find((t) => t.id === d.triggerId);
  const status = live?.status ?? 'ACTIVE';
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Badge
          tone={
            status === 'ACTIVE'
              ? 'agent'
              : status === 'FIRED'
                ? 'safe'
                : status === 'FAILED'
                  ? 'danger'
                  : 'neutral'
          }
        >
          {status === 'ACTIVE' ? 'Watching' : status.toLowerCase()}
        </Badge>
        {d.targetPriceUsd && d.symbol && (
          <span className="text-muted-foreground tabular-nums">
            {d.symbol} target ${Number(d.targetPriceUsd).toLocaleString('en-US')}
          </span>
        )}
        {d.nextRunAt && (
          <span className="text-muted-foreground">
            next run {new Date(d.nextRunAt).toLocaleString()}
          </span>
        )}
      </div>
      {live?.lastResult && <p className="text-xs text-muted-foreground">{live.lastResult}</p>}
      {d.warnings.length > 0 && (
        <ul className="space-y-0.5 text-xs text-caution">
          {d.warnings.map((w) => (
            <li key={w}>• {w}</li>
          ))}
        </ul>
      )}
      {status === 'ACTIVE' && (
        <Button
          size="sm"
          variant="outline"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate(d.triggerId)}
        >
          Cancel rule
        </Button>
      )}
    </>
  );
}

const KIND_SHELL: Record<InfoData['kind'], { icon: React.ReactNode; eyebrow: string }> = {
  trigger: { icon: <ListTodo />, eyebrow: 'Rule set' },
  token_check: { icon: <ShieldCheck />, eyebrow: 'Token safety check' },
  pool_compare: { icon: <Trophy />, eyebrow: 'Pool comparison' },
  hook_score: { icon: <Blocks />, eyebrow: 'Hook explained' },
  portfolio: { icon: <PieChart />, eyebrow: 'Portfolio' },
};

export function InfoCardView({ card }: { card: InfoCard }) {
  const data = infoData(card);
  if (!data) {
    const tone: CardTone = /fail|unavailable/i.test(card.title) ? 'danger' : 'neutral';
    return (
      <CardShell tone={tone} icon={<Info />} title={card.title} label={card.title}>
        <p className="text-sm text-muted-foreground">{card.body}</p>
        {card.bullets && (
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {card.bullets.map((b) => (
              <li key={b}>• {b}</li>
            ))}
          </ul>
        )}
      </CardShell>
    );
  }
  const shell = KIND_SHELL[data.kind];
  const tone: CardTone =
    data.kind === 'trigger'
      ? 'agent'
      : data.kind === 'token_check'
        ? VERDICT[data.verdict].tone
        : data.kind === 'hook_score'
          ? BAND[data.band].tone
          : 'info';
  return (
    <CardShell
      tone={tone}
      icon={shell.icon}
      eyebrow={shell.eyebrow}
      title={card.title}
      label={card.title}
      footer={
        card.marketDataSource === 'reference' ? <MarketLabel source="reference" /> : undefined
      }
    >
      <p className="text-sm text-muted-foreground">{card.body}</p>
      {data.kind === 'trigger' && <TriggerRule d={data} />}
      {data.kind === 'token_check' && <TokenCheck d={data} />}
      {data.kind === 'pool_compare' && <PoolCompare d={data} />}
      {data.kind === 'hook_score' && <HookScore d={data} />}
      {data.kind === 'portfolio' && <Portfolio d={data} />}
    </CardShell>
  );
}

/** Transient: the plan exists but no pipeline card came with it (yet). */
export function IntentCardView({ card, preparing }: { card: IntentCard; preparing: boolean }) {
  return (
    <CardShell
      tone="agent"
      icon={preparing ? <Loader2 className="animate-spin" /> : <Brain />}
      eyebrow={preparing ? 'Preparing…' : 'Plan · not executed'}
      title={card.intent.reason || card.intent.type.replace(/_/g, ' ')}
      label="Planned intent"
    >
      {preparing && (
        <div className="space-y-2" aria-hidden>
          <div className="h-3 w-2/3 animate-pulse rounded bg-surface-3" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-surface-3" />
        </div>
      )}
    </CardShell>
  );
}

function compactUsd(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
