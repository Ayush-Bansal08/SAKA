/**
 * Cards of the one pipeline (PHASE 06 §2): Preview (agent violet, countdown + Cancel), Approval
 * (amber), Refusal (red, suggestion chip), Receipt (green, tx + 0G proof), Price moved, Failure.
 */
import type {
  ApprovalCard,
  FailureCard,
  PreviewCard,
  PriceMovedCard,
  ReceiptCard,
  RefusalCard,
} from '@warden/shared';
import {
  Bot,
  CheckCircle2,
  Clock,
  Fingerprint,
  Globe,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui-kit';
import { useNow } from '@/hooks/useNow';
import { formatFullTime, formatTokenAmount } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useComposer } from '../composer-context';
import { usePlanAction } from '../plan-hooks';
import {
  AmountLine,
  CardShell,
  ChecksList,
  DecisionLogChip,
  HookBadge,
  QuoteRows,
  Reasons,
  TradeScoreBadge,
  TxList,
  ZgChip,
  ZgProofBadge,
} from './parts';
import { usd } from './card-utils';

const PREVIEW_STATUS: Record<
  string,
  { label: string; tone: 'neutral' | 'info' | 'safe' | 'danger' | 'caution' | 'agent' }
> = {
  QUEUED: { label: 'Agent will do this', tone: 'agent' },
  APPROVED: { label: 'Approved', tone: 'safe' },
  EXECUTING: { label: 'Executing', tone: 'info' },
  EXECUTED: { label: 'Done', tone: 'safe' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  FAILED: { label: 'Failed', tone: 'danger' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  AWAITING_APPROVAL: { label: 'Needs you', tone: 'caution' },
  PREPARED: { label: 'Suggestion', tone: 'neutral' },
};

function WhoApproves({ human }: { human: boolean }) {
  return human ? (
    <Badge tone="human" icon={<Fingerprint aria-hidden />}>
      Needs you
    </Badge>
  ) : (
    <Badge tone="agent" icon={<Bot aria-hidden />}>
      Agent alone
    </Badge>
  );
}

export function PreviewCardView({ card }: { card: PreviewCard }) {
  const now = useNow(250);
  const action = usePlanAction();
  const status = card.status ?? 'PREPARED';
  const autoAt = card.autoExecuteAt ? Date.parse(card.autoExecuteAt) : null;
  const total = 3;
  const msLeft = autoAt ? Math.max(0, autoAt - now) : 0;
  const secondsLeft = Math.ceil(msLeft / 1000);
  const queued = status === 'QUEUED';
  const meta = PREVIEW_STATUS[status];
  return (
    <CardShell
      tone="agent"
      icon={<ShieldCheck />}
      eyebrow="Preview"
      title={card.title}
      label="Action preview"
      planId={card.actionPlanId}
      badge={meta && <Badge tone={meta.tone}>{meta.label}</Badge>}
      footer={
        <>
          <WhoApproves human={false} />
          {card.tradeScore !== undefined && (
            <TradeScoreBadge score={card.tradeScore} breakdown={card.checks?.breakdown} />
          )}
          {card.hook && <HookBadge score={card.hook.score} band={card.hook.band} />}
        </>
      }
    >
      {card.quote && <AmountLine quote={card.quote} />}
      {card.quote && <QuoteRows quote={card.quote} amountUsd={card.amountUsd} />}
      {!card.quote && <p className="text-lg font-semibold tabular-nums">{usd(card.amountUsd)}</p>}
      {card.checks && <ChecksList checks={card.checks} />}
      {queued && (
        <div className="overflow-hidden rounded-md border border-agent/30 bg-agent/[0.08]">
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <p className="flex items-center gap-2 text-[13px]" aria-live="polite">
              {secondsLeft > 0 ? (
                <>
                  <Clock className="size-3.5 text-agent" aria-hidden />
                  <span>
                    Agent will do this in{' '}
                    <span className="font-semibold tabular-nums">{secondsLeft}s</span>
                  </span>
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
              disabled={action.isPending || secondsLeft === 0}
              onClick={() => action.mutate({ kind: 'cancel', planId: card.actionPlanId })}
            >
              Cancel
            </Button>
          </div>
          {autoAt && (
            <div className="h-1 bg-agent/15" aria-hidden>
              <div
                className="h-full bg-agent transition-[width] duration-200 ease-linear motion-reduce:transition-none"
                style={{ width: `${Math.min(100, (msLeft / (total * 1000)) * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}
      {(status === 'EXECUTING' || status === 'APPROVED') && (
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground" aria-live="polite">
          <Loader2 className="size-3.5 animate-spin" aria-hidden /> Signing and sending on testnet…
        </p>
      )}
      {status === 'PREPARED' && <p className="text-[13px] text-muted-foreground">{card.summary}</p>}
      {status === 'CANCELLED' && (
        <p className="text-[13px] text-muted-foreground">Cancelled — nothing was traded.</p>
      )}
    </CardShell>
  );
}

const APPROVAL_STATE = {
  PENDING: { label: 'Needs you', tone: 'caution' as const },
  APPROVED: { label: 'Approved by you ✓', tone: 'safe' as const },
  USED: { label: 'Approved by you ✓', tone: 'safe' as const },
  DENIED: { label: 'Rejected', tone: 'neutral' as const },
  EXPIRED: { label: 'Expired', tone: 'neutral' as const },
  REJECTED: { label: 'Wrong human', tone: 'danger' as const },
};

export function ApprovalCardView({ card }: { card: ApprovalCard }) {
  const now = useNow(1000);
  const action = usePlanAction();
  const left = Math.max(0, Math.floor((Date.parse(card.expiresAt) - now) / 1000));
  const expiredByTime = card.status === 'PENDING' && left === 0;
  const status = expiredByTime ? 'EXPIRED' : card.status;
  const pending = status === 'PENDING';
  const state = APPROVAL_STATE[status];
  const reasons = card.reasons ?? [
    { code: 'OVER_PER_ACTION_LIMIT' as const, message: card.reason },
  ];
  const closed = status === 'DENIED' || status === 'EXPIRED' || status === 'REJECTED';
  return (
    <CardShell
      tone={closed ? 'neutral' : status === 'PENDING' ? 'caution' : 'safe'}
      icon={closed ? <XCircle /> : status === 'PENDING' ? <ShieldAlert /> : <CheckCircle2 />}
      eyebrow={pending ? `Needs you — ${reasons[0]!.message.toLowerCase()}` : 'Approval'}
      title={card.summary ? capitalize(card.summary) : card.title}
      label="Approval needed"
      planId={card.actionPlanId}
      badge={<Badge tone={state.tone}>{state.label}</Badge>}
      footer={
        <>
          <WhoApproves human />
          {card.tradeScore !== undefined && (
            <TradeScoreBadge score={card.tradeScore} breakdown={card.checks?.breakdown} />
          )}
          {card.hook && <HookBadge score={card.hook.score} band={card.hook.band} />}
        </>
      }
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="text-2xl font-semibold tracking-tight tabular-nums">{usd(card.amountUsd)}</p>
        {pending && (
          <p
            className={cn(
              'flex items-center gap-1.5 text-xs tabular-nums',
              left < 60 ? 'text-danger' : 'text-warm',
            )}
            aria-live="polite"
          >
            <Clock className="size-3.5" aria-hidden />
            Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
          </p>
        )}
      </div>
      {card.quote && <AmountLine quote={card.quote} className="text-base" />}
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Why it needs you</p>
        <Reasons reasons={reasons} tone="caution" />
      </div>
      {card.checks && <ChecksList checks={card.checks} />}
      {pending && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-2">
            {card.providerKind === 'dev' ? (
              <Button
                disabled={action.isPending}
                onClick={() => action.mutate({ kind: 'dev-approve', approvalId: card.approvalId })}
              >
                <Fingerprint aria-hidden /> Approve (dev)
              </Button>
            ) : (
              <Button disabled>
                <Globe aria-hidden /> Approve with World ID
              </Button>
            )}
            <Button
              variant="outline"
              disabled={action.isPending}
              onClick={() => action.mutate({ kind: 'deny', approvalId: card.approvalId })}
            >
              Reject
            </Button>
          </div>
          {card.providerKind === 'dev' && (
            <p className="text-[11px] text-caution">
              Approve (dev) — World ID step-up replaces this in Phase 10.
            </p>
          )}
        </div>
      )}
      {(status === 'APPROVED' || status === 'USED') && (
        <p className="flex items-center gap-1.5 text-[13px] text-safe">
          <CheckCircle2 className="size-3.5" aria-hidden /> Approved by you — your agent{' '}
          {status === 'USED' ? 'is executing it.' : 'will run it now.'}
        </p>
      )}
      {closed && (
        <p className="text-[13px] font-medium">
          {status === 'REJECTED'
            ? 'A different human tried to approve. Nothing was traded.'
            : status === 'EXPIRED'
              ? 'The approval expired. Nothing was traded.'
              : 'You rejected it. Nothing was traded.'}
        </p>
      )}
    </CardShell>
  );
}

export function RefusalCardView({ card }: { card: RefusalCard }) {
  const composer = useComposer();
  return (
    <CardShell
      tone="danger"
      icon={<ShieldX />}
      eyebrow="Refused — nothing was traded"
      title={card.title.replace(/^Refused:\s*/, '').replace(/^./, (c) => c.toUpperCase())}
      label="Refused"
      planId={card.actionPlanId}
      footer={
        <>
          {card.tradeScore !== undefined && (
            <TradeScoreBadge score={card.tradeScore} breakdown={card.checks?.breakdown} />
          )}
          <DecisionLogChip log={card.decisionLog} />
        </>
      }
    >
      <Reasons reasons={card.reasons} tone="danger" />
      <p className="text-[13px] leading-relaxed text-muted-foreground">{card.summary}</p>
      {card.checks && <ChecksList checks={card.checks} />}
      {(card.suggestedRequest || card.suggestion) && (
        <div className="flex flex-wrap items-center gap-2">
          {card.suggestedRequest && composer ? (
            <button
              type="button"
              onClick={() => composer.prefill(card.suggestedRequest!)}
              className="inline-flex items-center gap-1.5 rounded-full border border-agent/40 bg-agent/10 px-3 py-1.5 text-xs font-medium text-agent transition-colors hover:bg-agent/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-label={`Try instead: ${card.suggestedRequest}`}
            >
              <Sparkles className="size-3.5" aria-hidden /> {card.suggestedRequest}
            </button>
          ) : null}
          {card.suggestion && (
            <span className="text-xs text-muted-foreground">{card.suggestion}</span>
          )}
        </div>
      )}
    </CardShell>
  );
}

export function ReceiptCardView({ card }: { card: ReceiptCard }) {
  return (
    <CardShell
      tone="safe"
      icon={<CheckCircle2 />}
      eyebrow="Done"
      title={card.title.replace(/^Done:\s*/, '').replace(/^./, (c) => c.toUpperCase())}
      label="Receipt"
      planId={card.actionPlanId}
      badge={
        card.approvedBy === 'HUMAN' ? (
          <Badge tone="human" icon={<Globe aria-hidden />}>
            Verified human
          </Badge>
        ) : (
          <Badge tone="agent" icon={<Bot aria-hidden />}>
            Agent
          </Badge>
        )
      }
      footer={
        <>
          {card.inferences && <ZgProofBadge inferences={card.inferences} />}
          <DecisionLogChip log={card.decisionLog} />
        </>
      }
    >
      {card.quote ? (
        <AmountLine quote={card.quote} />
      ) : (
        <p className="text-lg font-semibold tabular-nums">{usd(card.amountUsd)}</p>
      )}
      <p className="text-xs text-muted-foreground">
        Approved by {card.approvedBy === 'HUMAN' ? 'you (verified human)' : 'your agent'} ·{' '}
        {usd(card.amountUsd)}
        {card.completedAt && (
          <>
            {' · '}
            <time dateTime={card.completedAt}>{formatFullTime(card.completedAt)}</time>
          </>
        )}
      </p>
      <TxList txs={card.txs} />
    </CardShell>
  );
}

export function PriceMovedCardView({ card }: { card: PriceMovedCard }) {
  const action = usePlanAction();
  return (
    <CardShell
      tone="caution"
      icon={<TriangleAlert />}
      eyebrow="Nothing was traded"
      title={card.title}
      label="Price moved"
      planId={card.actionPlanId}
    >
      <p className="text-[13px]">{card.summary}</p>
      <p className="text-xs text-muted-foreground tabular-nums">
        Preview {formatTokenAmount(card.previewAmount)} {card.symbol} → now{' '}
        {formatTokenAmount(card.currentAmount)} {card.symbol}{' '}
        <span className="font-semibold text-caution">({card.worsePct.toFixed(2)}% worse)</span>
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={action.isPending || card.repreviewed}
        onClick={() => action.mutate({ kind: 'repreview', planId: card.actionPlanId })}
      >
        <RefreshCw aria-hidden /> {card.repreviewed ? 'Fresh preview sent' : 'Get a fresh preview'}
      </Button>
    </CardShell>
  );
}

export function FailureCardView({ card }: { card: FailureCard }) {
  return (
    <CardShell
      tone="danger"
      icon={<XCircle />}
      eyebrow="Execution failed"
      title={card.title}
      label="Execution failed"
      planId={card.actionPlanId}
      footer={<DecisionLogChip log={card.decisionLog} />}
    >
      <p className="text-[13px]">{card.summary}</p>
      {card.txs && <TxList txs={card.txs} />}
    </CardShell>
  );
}

export { ZgChip };

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
