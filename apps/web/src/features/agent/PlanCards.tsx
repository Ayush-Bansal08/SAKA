/**
 * Chat cards for the PHASE 05 pipeline: preview (AUTO countdown + Cancel), approval (amber),
 * refusal (red), receipt (tx links + 0G Storage root hash), price moved (re-preview), failure.
 */
import type {
  ApprovalCard,
  Card,
  DecisionLogRef,
  FailureCard,
  PolicyReason,
  PreviewCard,
  PriceMovedCard,
  QuoteSummary,
  ReceiptCard,
  RefusalCard,
} from '@warden/shared';
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Database,
  Fingerprint,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import type * as React from 'react';
import { Button } from '@/components/ui/button';
import { AgentBadge, Badge, HashChip, HumanBadge } from '@/components/ui-kit';
import { useNow } from '@/hooks/useNow';
import { formatTokenAmount } from '@/lib/format';
import { cn } from '@/lib/utils';
import { usePlanAction } from './plan-hooks';

const usd = (v: string) =>
  `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Shell({
  tone,
  icon,
  title,
  badge,
  children,
  label,
}: {
  tone: 'agent' | 'caution' | 'danger' | 'safe' | 'neutral';
  icon: React.ReactNode;
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
  label: string;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        'mt-2.5 rounded-lg border bg-background/40 p-3 text-sm',
        tone === 'agent' && 'border-agent/30',
        tone === 'caution' && 'border-caution/40 bg-caution/[0.04]',
        tone === 'danger' && 'border-danger/40 bg-danger/[0.04]',
        tone === 'safe' && 'border-safe/35 bg-safe/[0.04]',
        tone === 'neutral' && 'border-border',
      )}
    >
      <header className="flex items-start gap-2">
        <span
          className={cn(
            'mt-0.5 [&_svg]:size-4',
            tone === 'agent' && 'text-agent',
            tone === 'caution' && 'text-caution',
            tone === 'danger' && 'text-danger',
            tone === 'safe' && 'text-safe',
            tone === 'neutral' && 'text-muted-foreground',
          )}
          aria-hidden
        >
          {icon}
        </span>
        <h3 className="min-w-0 flex-1 font-medium leading-snug [overflow-wrap:anywhere]">
          {title}
        </h3>
        {badge}
      </header>
      <div className="mt-2 space-y-2.5">{children}</div>
    </section>
  );
}

function QuoteRow({ quote }: { quote: QuoteSummary }) {
  return (
    <div className="rounded-md border border-border bg-surface-2/60 px-2.5 py-2">
      <p className="flex flex-wrap items-center gap-1.5 font-medium tabular-nums">
        <span>
          {formatTokenAmount(quote.amountIn.amount)} {quote.amountIn.symbol}
        </span>
        <ArrowRight className="size-3.5 text-muted-foreground" aria-label="to" />
        <span>
          {formatTokenAmount(quote.amountOut.amount)} {quote.amountOut.symbol}
        </span>
      </p>
      <dl className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <div>
          <dt className="inline">Price impact </dt>
          <dd className="inline tabular-nums">{quote.priceImpactPct.toFixed(2)}%</dd>
        </div>
        <div>
          <dt className="inline">Max slippage </dt>
          <dd className="inline tabular-nums">{quote.slippagePct}%</dd>
        </div>
        {quote.gasUsd && (
          <div>
            <dt className="inline">Gas </dt>
            <dd className="inline tabular-nums">≈ {usd(quote.gasUsd)}</dd>
          </div>
        )}
        {quote.route && <div className="[overflow-wrap:anywhere]">{quote.route}</div>}
      </dl>
    </div>
  );
}

function Reasons({
  reasons,
  tone,
}: {
  reasons: readonly PolicyReason[];
  tone: 'caution' | 'danger';
}) {
  if (!reasons.length) return null;
  return (
    <ul className="space-y-1">
      {reasons.map((r, i) => (
        <li key={`${r.code}-${i}`} className="flex gap-1.5 text-[13px]">
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
              <span className="ml-1 text-muted-foreground tabular-nums">
                ({r.value} vs {r.limit})
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const tone = score >= 70 ? 'safe' : score >= 40 ? 'caution' : 'danger';
  return <Badge tone={tone}>Safety {score}/100</Badge>;
}

function DecisionLogLine({ log }: { log: DecisionLogRef | undefined }) {
  if (!log) return null;
  if (log.status === 'UPLOADED' && log.rootHash)
    return (
      <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <Database className="size-3 text-zg" aria-hidden /> Logged to 0G Storage
        <HashChip
          tone="zg"
          label="root"
          value={log.rootHash}
          {...(log.explorerUrl ? { href: log.explorerUrl } : {})}
        />
      </p>
    );
  return (
    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <Database className="size-3" aria-hidden />
      {log.status === 'FAILED'
        ? '0G Storage upload failed — kept in the database.'
        : 'Writing the decision record to 0G Storage…'}
    </p>
  );
}

function TxList({ txs }: { txs: ReceiptCard['txs'] }) {
  return (
    <ul className="space-y-1">
      {txs.map((t) => (
        <li key={t.hash} className="flex flex-wrap items-center gap-1.5 text-[12px]">
          <Badge tone={t.status === 'CONFIRMED' ? 'safe' : 'danger'}>
            {t.kind.replace('_', ' ')}
          </Badge>
          <HashChip value={t.hash} href={t.explorerUrl} />
        </li>
      ))}
    </ul>
  );
}

const STATUS_LABEL: Record<
  string,
  { label: string; tone: 'neutral' | 'info' | 'safe' | 'danger' | 'caution' }
> = {
  QUEUED: { label: 'Queued', tone: 'info' },
  EXECUTING: { label: 'Executing', tone: 'info' },
  EXECUTED: { label: 'Done', tone: 'safe' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  FAILED: { label: 'Failed', tone: 'danger' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  AWAITING_APPROVAL: { label: 'Needs you', tone: 'caution' },
  PREPARED: { label: 'Suggestion', tone: 'neutral' },
};

function PreviewView({ card }: { card: PreviewCard }) {
  const now = useNow(250);
  const action = usePlanAction();
  const status = card.status ?? 'PREPARED';
  const autoAt = card.autoExecuteAt ? Date.parse(card.autoExecuteAt) : null;
  const secondsLeft = autoAt ? Math.max(0, Math.ceil((autoAt - now) / 1000)) : 0;
  const queued = status === 'QUEUED';
  const meta = STATUS_LABEL[status];
  return (
    <Shell
      tone="agent"
      icon={<ShieldCheck />}
      title={card.title}
      label="Action preview"
      badge={meta && <Badge tone={meta.tone}>{meta.label}</Badge>}
    >
      <p className="text-[13px] text-muted-foreground">{card.summary}</p>
      {card.quote && <QuoteRow quote={card.quote} />}
      <ol className="space-y-0.5 text-[12px] text-muted-foreground">
        {card.steps.map((s, i) => (
          <li key={`${s.kind}-${i}`}>
            {i + 1}. {s.label}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-1.5">
        <AgentBadge>Agent alone</AgentBadge>
        {card.tradeScore !== undefined && <ScoreBadge score={card.tradeScore} />}
        {card.hook && (
          <Badge tone={card.hook.band === 'SAFE' ? 'safe' : 'caution'}>
            Hook {card.hook.score}/100
          </Badge>
        )}
        <Badge tone="neutral">{usd(card.amountUsd)}</Badge>
      </div>
      {queued && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-agent/25 bg-agent/[0.06] px-2.5 py-2">
          <p className="flex items-center gap-1.5 text-[13px]" aria-live="polite">
            {secondsLeft > 0 ? (
              <>
                <Clock className="size-3.5 text-agent" aria-hidden /> Agent will do this in{' '}
                <span className="font-semibold tabular-nums">{secondsLeft}s</span>
              </>
            ) : (
              <>
                <Loader2 className="size-3.5 animate-spin text-agent" aria-hidden /> Starting…
              </>
            )}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={action.isPending}
            onClick={() => action.mutate({ kind: 'cancel', planId: card.actionPlanId })}
          >
            Cancel
          </Button>
        </div>
      )}
      {status === 'EXECUTING' && (
        <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden /> Signing and sending on testnet…
        </p>
      )}
    </Shell>
  );
}

function ApprovalView({ card }: { card: ApprovalCard }) {
  const now = useNow(1000);
  const action = usePlanAction();
  const left = Math.max(0, Math.floor((Date.parse(card.expiresAt) - now) / 1000));
  const pending = card.status === 'PENDING' && left > 0;
  const statusTone =
    card.status === 'APPROVED' || card.status === 'USED'
      ? 'safe'
      : card.status === 'PENDING'
        ? 'caution'
        : 'neutral';
  return (
    <Shell
      tone="caution"
      icon={<ShieldAlert />}
      title={card.title}
      label="Approval needed"
      badge={
        <Badge tone={statusTone}>
          {card.status === 'PENDING'
            ? left > 0
              ? 'Needs you'
              : 'Expired'
            : card.status.toLowerCase()}
        </Badge>
      }
    >
      <Reasons
        reasons={card.reasons ?? [{ code: 'OVER_PER_ACTION_LIMIT', message: card.reason }]}
        tone="caution"
      />
      {card.quote && <QuoteRow quote={card.quote} />}
      <div className="flex flex-wrap items-center gap-1.5">
        <HumanBadge>Needs a human</HumanBadge>
        {card.tradeScore !== undefined && <ScoreBadge score={card.tradeScore} />}
        <Badge tone="neutral">{usd(card.amountUsd)}</Badge>
        {pending && (
          <Badge tone="caution" icon={<Clock aria-hidden />}>
            <span className="tabular-nums">
              {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
            </span>
          </Badge>
        )}
      </div>
      {pending && (
        <div className="flex flex-wrap gap-2">
          {card.providerKind === 'dev' && (
            <Button
              size="sm"
              disabled={action.isPending}
              onClick={() => action.mutate({ kind: 'dev-approve', approvalId: card.approvalId })}
            >
              <Fingerprint aria-hidden /> Approve (DEV)
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={action.isPending}
            onClick={() => action.mutate({ kind: 'deny', approvalId: card.approvalId })}
          >
            Deny
          </Button>
        </div>
      )}
      {card.providerKind === 'dev' && pending && (
        <p className="text-[11px] text-caution">
          DEV approval — World ID step-up arrives in Phase 10.
        </p>
      )}
    </Shell>
  );
}

function RefusalView({ card }: { card: RefusalCard }) {
  return (
    <Shell
      tone="danger"
      icon={<ShieldX />}
      title={card.title}
      label="Refused"
      badge={card.tradeScore !== undefined ? <ScoreBadge score={card.tradeScore} /> : undefined}
    >
      <p className="text-[13px]">{card.summary}</p>
      <Reasons reasons={card.reasons} tone="danger" />
      {card.suggestion && (
        <p className="text-[12px] text-muted-foreground">Try instead: {card.suggestion}</p>
      )}
      <DecisionLogLine log={card.decisionLog} />
    </Shell>
  );
}

function ReceiptView({ card }: { card: ReceiptCard }) {
  return (
    <Shell
      tone="safe"
      icon={<CheckCircle2 />}
      title={card.title}
      label="Receipt"
      badge={
        card.approvedBy === 'HUMAN' ? (
          <HumanBadge>Approved by you</HumanBadge>
        ) : (
          <AgentBadge>By your agent</AgentBadge>
        )
      }
    >
      <p className="text-[13px] text-muted-foreground">
        {card.summary} Value {usd(card.amountUsd)}.
      </p>
      <TxList txs={card.txs} />
      <DecisionLogLine log={card.decisionLog} />
    </Shell>
  );
}

function PriceMovedView({ card }: { card: PriceMovedCard }) {
  const action = usePlanAction();
  return (
    <Shell tone="caution" icon={<TriangleAlert />} title={card.title} label="Price moved">
      <p className="text-[13px]">{card.summary}</p>
      <p className="text-[12px] text-muted-foreground tabular-nums">
        Preview {formatTokenAmount(card.previewAmount)} {card.symbol} → now{' '}
        {formatTokenAmount(card.currentAmount)} {card.symbol} ({card.worsePct.toFixed(2)}% worse)
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={action.isPending || card.repreviewed}
        onClick={() => action.mutate({ kind: 'repreview', planId: card.actionPlanId })}
      >
        <RefreshCw aria-hidden /> {card.repreviewed ? 'Re-previewed' : 'Get a fresh preview'}
      </Button>
    </Shell>
  );
}

function FailureView({ card }: { card: FailureCard }) {
  return (
    <Shell tone="danger" icon={<XCircle />} title={card.title} label="Execution failed">
      <p className="text-[13px]">{card.summary}</p>
      {card.txs && card.txs.length > 0 && <TxList txs={card.txs} />}
      <DecisionLogLine log={card.decisionLog} />
    </Shell>
  );
}

/** Renders the pipeline cards of one agent message (intent/info cards are shown as text). */
export function PlanCards({ cards }: { cards: Card[] }) {
  return (
    <>
      {cards.map((card, i) => {
        const key = `${card.type}-${'actionPlanId' in card ? card.actionPlanId : i}`;
        switch (card.type) {
          case 'preview':
            return <PreviewView key={key} card={card} />;
          case 'approval':
            return <ApprovalView key={key} card={card} />;
          case 'refusal':
            return <RefusalView key={key} card={card} />;
          case 'receipt':
            return <ReceiptView key={key} card={card} />;
          case 'price_moved':
            return <PriceMovedView key={key} card={card} />;
          case 'failure':
            return <FailureView key={key} card={card} />;
          default:
            return null;
        }
      })}
    </>
  );
}
