/**
 * Decisions: everything waiting for the human. Pending approvals come first with live expiry,
 * Approve (dev until Phase 10) / Reject and Details → plan drawer. Then the morning brief and the
 * Mode B suggestions, newest first, with Yes / Change / No (PHASE 08 §3).
 */
import type { PendingApproval } from '@warden/shared';
import { ChevronRight, Clock, Fingerprint, Inbox, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, ErrorState, Panel, SkeletonRows } from '@/components/ui-kit';
import { usd } from '@/features/agent/cards/card-utils';
import { usePlanAction } from '@/features/agent/plan-hooks';
import { useSuggestions } from '@/features/inbox/hooks';
import { BriefCard, SuggestionRow } from '@/features/inbox/SuggestionRow';
import { usePendingApprovals, usePlanDrawer } from '@/features/plan/hooks';
import { useNow } from '@/hooks/useNow';
import { cn } from '@/lib/utils';

const LIST_SIZE = 8;

function ApprovalRow({ a, devApprove }: { a: PendingApproval; devApprove: boolean }) {
  const now = useNow(1000);
  const action = usePlanAction();
  const drawer = usePlanDrawer();
  const left = Math.max(0, Math.floor((Date.parse(a.expiresAt) - now) / 1000));
  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
      <span
        className="hidden size-9 shrink-0 items-center justify-center rounded-full border border-warm/30 bg-warm/10 text-warm sm:flex"
        aria-hidden
      >
        <ShieldAlert className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium [overflow-wrap:anywhere]">
          {a.summary.charAt(0).toUpperCase() + a.summary.slice(1)}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground [overflow-wrap:anywhere]">{a.reason}</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-base font-medium tabular-nums">{usd(a.amountUsd)}</span>
          <Badge tone={left < 60 ? 'danger' : 'warm'} icon={<Clock aria-hidden />}>
            <span className="tabular-nums">
              {left > 0
                ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`
                : 'Expired'}
            </span>
          </Badge>
          {a.channel === 'TELEGRAM' && <Badge>From Telegram</Badge>}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {devApprove && left > 0 && (
          <Button
            size="sm"
            disabled={action.isPending}
            onClick={() => action.mutate({ kind: 'dev-approve', approvalId: a.id })}
          >
            <Fingerprint aria-hidden /> Approve (dev)
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={action.isPending || left === 0}
          onClick={() => action.mutate({ kind: 'deny', approvalId: a.id })}
        >
          Reject
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => drawer.open(a.actionPlanId)}
          aria-label="Open plan details"
        >
          Details <ChevronRight aria-hidden />
        </Button>
      </div>
    </li>
  );
}

function Approvals() {
  const pending = usePendingApprovals();
  const items = pending.data?.approvals ?? [];
  return (
    <Panel
      title="Needs your approval"
      subtitle="Over your limits, new recipients and withdrawals always ask you first"
      icon={<Fingerprint />}
      actions={items.length > 0 ? <Badge tone="warm">{items.length} waiting</Badge> : undefined}
      bodyClassName={cn('p-0', items.length === 0 && 'p-4')}
    >
      {pending.isPending ? (
        <SkeletonRows rows={2} />
      ) : pending.isError ? (
        <ErrorState
          title="Couldn't load your approvals"
          description={pending.error.message}
          onRetry={() => void pending.refetch()}
          retrying={pending.isFetching}
        />
      ) : items.length === 0 ? (
        <EmptyState
          className="py-6"
          icon={<Fingerprint />}
          title="Nothing waiting for you"
          description="When an action is over your limits or sends to a new address, your agent asks here first."
        />
      ) : (
        <ul className="divide-y divide-border">
          {items.map((a) => (
            <ApprovalRow key={a.id} a={a} devApprove={pending.data!.devApproveAvailable} />
          ))}
        </ul>
      )}
      {pending.data?.devApproveAvailable && items.length > 0 && (
        <p className="border-t border-border px-5 py-2 text-xs text-caution">
          Approve (dev) — World ID step-up replaces this in Phase 10.
        </p>
      )}
    </Panel>
  );
}

function Suggestions() {
  const suggestions = useSuggestions();
  const [showAll, setShowAll] = useState(false);
  const list = suggestions.data?.suggestions ?? [];
  const open = suggestions.data?.openCount ?? 0;
  // A suggestion the human can still answer is never tucked behind "Show more".
  const lastAnswerable = list.reduce((last, s, i) => (s.actions.length > 0 ? i : last), -1);
  const size = Math.max(LIST_SIZE, lastAnswerable + 1);
  const shown = showAll ? list : list.slice(0, size);
  return (
    <Panel
      title="Suggestions"
      subtitle="What your agent noticed, and what it proposes"
      icon={<Inbox />}
      actions={open > 0 ? <Badge tone="warm">{open} open</Badge> : undefined}
      bodyClassName={cn('p-0', list.length === 0 && 'p-4')}
    >
      {suggestions.isPending ? (
        <SkeletonRows rows={2} />
      ) : suggestions.isError ? (
        <ErrorState
          title="Couldn't load your suggestions"
          description={suggestions.error.message}
          onRetry={() => void suggestions.refetch()}
          retrying={suggestions.isFetching}
        />
      ) : list.length === 0 ? (
        <EmptyState
          className="py-6"
          icon={<Inbox />}
          title="No suggestions yet"
          description="When your agent spots a dip, idle USDC, an out-of-range position or a hook change, it proposes it here — and on Telegram if you connect it."
        />
      ) : (
        <>
          <ul className="divide-y divide-border">
            {shown.map((s) => (
              <SuggestionRow key={s.id} s={s} />
            ))}
          </ul>
          {shown.length < list.length && (
            <div className="flex justify-center border-t border-border p-3">
              <Button size="sm" variant="outline" onClick={() => setShowAll(true)}>
                Show {list.length - shown.length} more
              </Button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

export function DecisionsTab() {
  const waiting = (usePendingApprovals().data?.approvals.length ?? 0) > 0;
  const brief = useSuggestions().data?.brief;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      {waiting && <Approvals />}
      {brief && <BriefCard brief={brief} />}
      {!waiting && <Approvals />}
      <Suggestions />
    </div>
  );
}
