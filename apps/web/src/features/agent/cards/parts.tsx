/** Building blocks shared by every chat card (PHASE 06 §2). */
import type {
  CardChecks,
  DecisionLogRef,
  HookBand,
  InferenceRef,
  PolicyReason,
  QuoteSummary,
  ReceiptCard,
  ScoreItem,
  ZgProvenance,
} from '@warden/shared';
import {
  ArrowRight,
  BadgeCheck,
  CheckCircle2,
  ChevronRight,
  Database,
  FlaskConical,
  Gauge,
  ShieldCheck,
  ShieldOff,
  XCircle,
} from 'lucide-react';
import type * as React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge, HashChip } from '@/components/ui-kit';
import { usePlanDrawer } from '@/features/plan/hooks';
import { formatTokenAmount } from '@/lib/format';
import { cn } from '@/lib/utils';
import { scoreTone, shortRoute, usd } from './card-utils';

export type CardTone = 'agent' | 'caution' | 'danger' | 'safe' | 'neutral' | 'info';

const TONE_BORDER: Record<CardTone, string> = {
  agent: 'border-agent/35 bg-agent/[0.035]',
  caution: 'border-caution/40 bg-caution/[0.045]',
  danger: 'border-danger/40 bg-danger/[0.045]',
  safe: 'border-safe/35 bg-safe/[0.045]',
  neutral: 'border-border bg-background/40',
  info: 'border-info/30 bg-info/[0.035]',
};
const TONE_TEXT: Record<CardTone, string> = {
  agent: 'text-agent',
  caution: 'text-caution',
  danger: 'text-danger',
  safe: 'text-safe',
  neutral: 'text-muted-foreground',
  info: 'text-info',
};

/** The frame of every card: accent tone, icon, title, status badge, optional Details button. */
export function CardShell({
  tone,
  icon,
  title,
  eyebrow,
  badge,
  planId,
  label,
  children,
  footer,
}: {
  tone: CardTone;
  icon: React.ReactNode;
  title: React.ReactNode;
  eyebrow?: string;
  badge?: React.ReactNode;
  planId?: string | undefined;
  label: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const drawer = usePlanDrawer();
  return (
    <section
      aria-label={label}
      className={cn(
        'mt-2.5 overflow-hidden rounded-lg border text-sm motion-safe:animate-in motion-safe:fade-in-0',
        TONE_BORDER[tone],
      )}
    >
      <header className="flex items-start gap-2.5 px-3.5 pt-3">
        <span className={cn('mt-0.5 shrink-0 [&_svg]:size-4', TONE_TEXT[tone])} aria-hidden>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          {eyebrow && (
            <p
              className={cn(
                'text-[10.5px] font-semibold tracking-[0.08em] uppercase',
                TONE_TEXT[tone],
              )}
            >
              {eyebrow}
            </p>
          )}
          <h3 className="font-semibold leading-snug [overflow-wrap:anywhere]">{title}</h3>
        </div>
        {badge}
      </header>
      <div className="space-y-3 px-3.5 pt-2.5 pb-3">{children}</div>
      {(footer || planId) && (
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 bg-background/30 px-3.5 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">{footer}</div>
          {planId && (
            <button
              type="button"
              onClick={() => drawer.open(planId)}
              className="ml-auto inline-flex items-center gap-0.5 rounded text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Details <ChevronRight className="size-3.5" aria-hidden />
            </button>
          )}
        </footer>
      )}
    </section>
  );
}

/** Big "0.0065 ETH → 20.01 USDC" line. */
export function AmountLine({ quote, className }: { quote: QuoteSummary; className?: string }) {
  return (
    <p
      className={cn(
        'flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-lg font-semibold tracking-tight tabular-nums',
        className,
      )}
    >
      <span>
        {formatTokenAmount(quote.amountIn.amount)}{' '}
        <span className="text-sm font-medium text-muted-foreground">{quote.amountIn.symbol}</span>
      </span>
      <ArrowRight className="size-4 self-center text-subtle-foreground" aria-label="to" />
      <span>
        {formatTokenAmount(quote.amountOut.amount)}{' '}
        <span className="text-sm font-medium text-muted-foreground">{quote.amountOut.symbol}</span>
      </span>
    </p>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-xs font-medium tabular-nums [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  );
}

/** Price impact, gas, route, slippage. */
export function QuoteRows({ quote, amountUsd }: { quote: QuoteSummary; amountUsd?: string }) {
  const impactTone =
    quote.priceImpactPct > 5
      ? 'text-danger'
      : quote.priceImpactPct > 1
        ? 'text-caution'
        : 'text-foreground';
  return (
    <dl className="divide-y divide-border/60 rounded-md border border-border/70 bg-background/40 px-2.5">
      {amountUsd && <Row label="Value">{usd(amountUsd)}</Row>}
      <Row label="Price impact">
        <span className={impactTone}>{quote.priceImpactPct.toFixed(2)}%</span>
      </Row>
      {quote.gasUsd && (
        <Row label="Est. gas">
          ≈ {usd(quote.gasUsd)}
          {amountUsd && Number(amountUsd) > 0 && (
            <span className="ml-1 font-normal text-muted-foreground">
              ({((Number(quote.gasUsd) / Number(amountUsd)) * 100).toFixed(1)}% of value)
            </span>
          )}
        </Row>
      )}
      {quote.netOutUsd && <Row label="You receive, after gas">≈ {usd(quote.netOutUsd)}</Row>}
      <Row label="Max slippage">{quote.slippagePct}%</Row>
      {quote.route && (
        <Row label="Route">
          <span className="font-normal text-muted-foreground">{shortRoute(quote.route)}</span>
        </Row>
      )}
    </dl>
  );
}

/** Trade score badge; click for the breakdown (every penalty with its evidence). */
export function TradeScoreBadge({
  score,
  breakdown,
}: {
  score: number;
  breakdown?: readonly ScoreItem[] | undefined;
}) {
  const tone = scoreTone(score);
  const badge = (
    <Badge tone={tone} icon={<Gauge aria-hidden />}>
      Trade score {score}
    </Badge>
  );
  if (!breakdown) return badge;
  const penalties = breakdown.filter((b) => b.penalty !== 0);
  return (
    <Popover>
      <PopoverTrigger
        className="rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        aria-label={`Trade score ${score} of 100 — show breakdown`}
      >
        {badge}
      </PopoverTrigger>
      <PopoverContent>
        <p className="text-sm font-semibold">Trade safety score {score}/100</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          100 minus penalties. Deterministic — no AI involved.
        </p>
        <ul className="mt-2.5 space-y-1.5">
          {breakdown.map((b) => (
            <li key={b.rule} className="flex gap-2 text-xs">
              <span
                className={cn(
                  'w-9 shrink-0 text-right font-semibold tabular-nums',
                  b.penalty < 0 ? 'text-caution' : 'text-safe',
                )}
              >
                {b.penalty < 0 ? b.penalty : '✓'}
              </span>
              <span className="text-muted-foreground [overflow-wrap:anywhere]">{b.evidence}</span>
            </li>
          ))}
          {breakdown.length === 0 && (
            <li className="text-xs text-muted-foreground">No factors applied.</li>
          )}
        </ul>
        {penalties.length === 0 && breakdown.length > 0 && (
          <p className="mt-2 text-xs text-safe">No penalties.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function HookBadge({ score, band }: { score: number; band: HookBand }) {
  const tone = band === 'SAFE' ? 'safe' : band === 'CAUTION' ? 'caution' : 'danger';
  return (
    <Badge tone={tone}>
      Hook {score}/100 · {band === 'SAFE' ? 'Safe' : band === 'CAUTION' ? 'Caution' : 'Danger'}
    </Badge>
  );
}

function CheckLine({
  ok,
  icon,
  label,
  detail,
  zg,
}: {
  ok: boolean | null;
  icon: React.ReactNode;
  label: string;
  detail?: React.ReactNode;
  zg?: ZgProvenance | undefined;
}) {
  return (
    <li className="flex gap-2">
      <span
        className={cn(
          'mt-0.5 shrink-0 [&_svg]:size-3.5',
          ok === null ? 'text-subtle-foreground' : ok ? 'text-safe' : 'text-danger',
        )}
        aria-hidden
      >
        {ok === null ? icon : ok ? <CheckCircle2 /> : <XCircle />}
      </span>
      <div className="min-w-0 flex-1 text-xs">
        <p>
          <span className="font-medium">{label}</span>
          {detail && <span className="text-muted-foreground"> · {detail}</span>}
        </p>
        {zg && (
          <HashChip
            className="mt-1"
            tone="zg"
            label={zg.model}
            value={zg.requestId}
            icon={<BadgeCheck className="size-3" aria-hidden />}
          />
        )}
      </div>
    </li>
  );
}

/** Simulation ✓/✗ and the 0G guard verdict (with its request ID). */
export function ChecksList({ checks }: { checks: CardChecks }) {
  const sim = checks.simulation;
  const guard = checks.guard;
  return (
    <ul className="space-y-1.5" aria-label="Safety checks">
      <CheckLine
        ok={sim ? sim.ok : null}
        icon={<FlaskConical />}
        label={
          sim
            ? sim.unavailable
              ? 'Simulation unavailable'
              : sim.ok
                ? 'Simulation passed'
                : 'Simulation failed'
            : 'Simulation not run'
        }
        detail={
          sim
            ? sim.ok
              ? `${sim.simulated} step${sim.simulated === 1 ? '' : 's'} on the latest block${sim.deferred ? `, ${sim.deferred} re-checked before sending` : ''}`
              : sim.error
            : undefined
        }
      />
      <CheckLine
        ok={guard ? guard.verdict === 'approve' && !guard.unavailable : null}
        icon={guard?.unavailable ? <ShieldOff /> : <ShieldCheck />}
        label={
          guard
            ? guard.unavailable
              ? '0G guard unavailable'
              : guard.verdict === 'approve'
                ? `0G guard approved · p=${guard.pApprove.toFixed(2)}`
                : `0G guard blocked · p=${guard.pApprove.toFixed(2)}`
            : '0G guard not reached'
        }
        detail={guard?.reason}
        zg={guard?.zg}
      />
    </ul>
  );
}

export function Reasons({
  reasons,
  tone,
}: {
  reasons: readonly PolicyReason[];
  tone: 'caution' | 'danger';
}) {
  if (!reasons.length) return null;
  return (
    <ul className="space-y-1.5">
      {reasons.map((r, i) => (
        <li key={`${r.code}-${i}`} className="flex gap-2 text-[13px] leading-snug">
          <span
            className={cn(
              'mt-1.5 size-1.5 shrink-0 rounded-full',
              tone === 'danger' ? 'bg-danger' : 'bg-caution',
            )}
            aria-hidden
          />
          <span className="[overflow-wrap:anywhere]">
            {r.message}
            {r.value !== undefined && r.limit !== undefined && (
              <span
                className={cn(
                  'ml-1.5 inline-flex rounded px-1 text-[11px] font-semibold tabular-nums',
                  tone === 'danger' ? 'bg-danger/10 text-danger' : 'bg-caution/10 text-caution',
                )}
              >
                {fmtNum(r.value)} / max {fmtNum(r.limit)}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

const fmtNum = (n: number) =>
  Math.abs(n) >= 1000
    ? n.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : String(Math.round(n * 100) / 100);

/** 0G Storage root-hash chip (or the pending / failed state). */
export function DecisionLogChip({ log }: { log: DecisionLogRef | undefined | null }) {
  if (!log) return null;
  if (log.status === 'UPLOADED' && log.rootHash)
    return (
      <HashChip
        tone="zg"
        label="0G Storage"
        value={log.rootHash}
        icon={<Database className="size-3" aria-hidden />}
        {...(log.explorerUrl ? { href: log.explorerUrl } : {})}
      />
    );
  return (
    <Badge tone="neutral" icon={<Database aria-hidden />}>
      {log.status === 'FAILED' ? '0G log failed — kept locally' : 'Logging to 0G Storage…'}
    </Badge>
  );
}

const ROLE_LABEL: Record<string, string> = {
  PLANNER: 'Planner',
  PLANNER_FALLBACK: 'Planner (fallback)',
  GUARD: 'Guard',
  EXPLAINER: 'Explainer',
};

/** "0G verified" badge; the popover lists every inference behind the action. */
export function ZgProofBadge({ inferences }: { inferences: readonly InferenceRef[] }) {
  if (!inferences.length) return null;
  return (
    <Popover>
      <PopoverTrigger
        className="rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        aria-label={`0G verified — ${inferences.length} inferences`}
      >
        <Badge tone="zg" icon={<BadgeCheck aria-hidden />}>
          0G verified · {inferences.length}
        </Badge>
      </PopoverTrigger>
      <PopoverContent className="w-96">
        <p className="text-sm font-semibold">Decided on 0G</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Every model call behind this action, with its 0G request ID.
        </p>
        <ul className="mt-2.5 space-y-2">
          {inferences.map((i, n) => (
            <li key={`${i.requestId ?? n}`} className="rounded-md border border-border p-2 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{ROLE_LABEL[i.role] ?? i.role}</span>
                <span className="text-muted-foreground">{i.model}</span>
                <Badge tone={i.trustMode === 'private' ? 'zg' : 'info'}>{i.trustMode}</Badge>
                {i.teeVerified && <Badge tone="safe">TEE ✓</Badge>}
              </div>
              {i.requestId && (
                <HashChip className="mt-1.5" tone="zg" label="request" value={i.requestId} />
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export function TxList({ txs }: { txs: ReceiptCard['txs'] }) {
  if (!txs.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {txs.map((t) => (
        <li key={t.hash}>
          <HashChip
            label={t.kind.replace('_', ' ')}
            value={t.hash}
            href={t.explorerUrl}
            className={t.status === 'CONFIRMED' ? undefined : 'border-danger/40'}
          />
        </li>
      ))}
    </ul>
  );
}

/** A planner provenance chip (model + request ID) under an agent reply. */
export function ZgChip({ zg }: { zg: ZgProvenance }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <HashChip
        tone="zg"
        label="0G"
        value={zg.requestId}
        icon={<BadgeCheck className="size-3" aria-hidden />}
      />
      <Badge tone={zg.trustMode === 'private' ? 'zg' : 'info'}>{zg.trustMode}</Badge>
      {zg.teeVerified && <Badge tone="safe">TEE ✓</Badge>}
    </span>
  );
}
