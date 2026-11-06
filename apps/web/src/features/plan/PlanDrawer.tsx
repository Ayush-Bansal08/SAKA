/**
 * Plan drawer (PHASE 06 §2 "Details"): the whole story of one action, so anyone can explain what
 * happened from the UI alone — request, timeline (every trace event of the run), safety checks,
 * policy reasons, approval record, unsigned calls (target + selector), executions, 0G inferences,
 * the 0G Storage decision log (root hash + payload) and the raw intent.
 */
import type { PlanView } from '@warden/shared';
import {
  Bot,
  CircleDashed,
  Database,
  FileJson,
  Fingerprint,
  Gauge,
  ListChecks,
  ScrollText,
  Send,
  Workflow,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import {
  AddressChip,
  Badge,
  Disclosure,
  ErrorState,
  HashChip,
  SkeletonRows,
} from '@/components/ui-kit';
import {
  AmountLine,
  ChecksList,
  DecisionLogChip,
  HookBadge,
  QuoteRows,
  Reasons,
  TradeScoreBadge,
  ZgProofBadge,
} from '@/features/agent/cards/parts';
import { usd } from '@/features/agent/cards/card-utils';
import { EventRow } from '@/features/trace/LiveActivity';
import { formatDuration } from '@/features/trace/trace-utils';
import { useNow } from '@/hooks/useNow';
import { formatFullTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  OUTCOME_META,
  TYPE_LABEL,
  useDecisionLog,
  usePlan,
  usePlanDrawer,
  useTraceEvents,
} from './hooks';

function Section({
  icon,
  title,
  children,
  aside,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="border-b border-border px-5 py-4 last:border-b-0">
      <header className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="micro-label flex items-center gap-2 text-subtle-foreground [&_svg]:size-3.5">
          {icon}
          {title}
        </h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-md border border-border bg-background/60 p-3 font-mono text-xs leading-relaxed text-foreground/80">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function outcomeOf(plan: PlanView) {
  if (plan.status === 'CANCELLED')
    return plan.approval?.status === 'DENIED' || plan.approval?.status === 'REJECTED'
      ? OUTCOME_META.DENIED
      : plan.approval?.status === 'EXPIRED'
        ? OUTCOME_META.EXPIRED
        : OUTCOME_META.CANCELLED;
  const map: Partial<Record<PlanView['status'], keyof typeof OUTCOME_META>> = {
    EXECUTED: 'EXECUTED',
    REFUSED: 'REFUSED',
    FAILED: 'FAILED',
    EXPIRED: 'EXPIRED',
  };
  return OUTCOME_META[map[plan.status] ?? 'PENDING'];
}

function Timeline({ traceId }: { traceId: string }) {
  const trace = useTraceEvents(traceId);
  const now = useNow();
  if (trace.isPending) return <SkeletonRows rows={4} />;
  if (trace.isError) return <p className="text-xs text-danger">{trace.error.message}</p>;
  const events = trace.data.events;
  if (!events.length) return <p className="text-xs text-muted-foreground">No events recorded.</p>;
  const ms = Date.parse(events[events.length - 1]!.ts) - Date.parse(events[0]!.ts);
  return (
    <>
      <p className="mb-2.5 text-xs text-muted-foreground tabular-nums">
        {events.length} steps · {formatDuration(ms)}
      </p>
      <ol className="relative">
        {events.map((e, i) => (
          <EventRow key={e.id} event={e} now={now} last={i === events.length - 1} />
        ))}
      </ol>
    </>
  );
}

function DecisionLogSection({ plan }: { plan: PlanView }) {
  const [show, setShow] = useState(false);
  const log = useDecisionLog(plan.id, show);
  return (
    <Section
      icon={<Database />}
      title="0G Storage decision log"
      aside={<DecisionLogChip log={plan.decisionLog} />}
    >
      <p className="text-xs text-muted-foreground">
        A tamper-proof record of what the agent saw, decided and did — canonical JSON, no personal
        data, no signatures.
      </p>
      {plan.decisionLog ? (
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="mt-2 text-xs font-medium text-agent hover:underline"
          aria-expanded={show}
        >
          {show ? 'Hide payload' : 'Show logged payload'}
        </button>
      ) : (
        <p className="mt-2 text-xs text-subtle-foreground">
          Written when the plan reaches its end.
        </p>
      )}
      {show &&
        (log.isPending ? (
          <SkeletonRows rows={3} />
        ) : log.isError ? (
          <p className="mt-2 text-xs text-danger">{log.error.message}</p>
        ) : (
          <div className="mt-2 space-y-2">
            <HashChip label="payload sha256" value={log.data.payloadHash} />
            <Json value={log.data.payload} />
          </div>
        ))}
    </Section>
  );
}

function PlanBody({ plan }: { plan: PlanView }) {
  const outcome = outcomeOf(plan);
  return (
    <>
      <div className="space-y-3 border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={outcome.tone}>{outcome.label}</Badge>
          <Badge>{TYPE_LABEL[plan.intent.type] ?? plan.intent.type}</Badge>
          {plan.policyOutcome !== 'REFUSE' && (
            <Badge
              tone={
                plan.policyOutcome === 'AUTO'
                  ? 'agent'
                  : plan.policyOutcome === 'STEP_UP'
                    ? 'human'
                    : 'neutral'
              }
            >
              {plan.policyOutcome === 'AUTO'
                ? 'Agent alone'
                : plan.policyOutcome === 'STEP_UP'
                  ? 'Needed a human'
                  : 'Suggestion'}
            </Badge>
          )}
          {plan.tradeScore !== null && (
            <TradeScoreBadge score={plan.tradeScore} breakdown={plan.tradeScoreBreakdown} />
          )}
          {plan.hook && <HookBadge score={plan.hook.score} band={plan.hook.band} />}
          <ZgProofBadge inferences={plan.inferences} />
        </div>
        {plan.quote ? <AmountLine quote={plan.quote} /> : null}
        {plan.quote ? (
          <QuoteRows quote={plan.quote} amountUsd={plan.amountUsd} />
        ) : (
          <p className="text-lg font-semibold tabular-nums">{usd(plan.amountUsd)}</p>
        )}
      </div>

      <Section icon={<Workflow />} title="Timeline">
        <Timeline traceId={plan.traceId} />
      </Section>

      <Section icon={<ListChecks />} title="Safety checks">
        <ChecksList
          checks={{
            breakdown: plan.tradeScoreBreakdown,
            simulation: plan.simulation
              ? {
                  ok: plan.simulation.ok,
                  ...(plan.simulation.unavailable ? { unavailable: true } : {}),
                  simulated: plan.simulation.steps.filter((s) => !s.deferred).length,
                  deferred: plan.simulation.steps.filter((s) => s.deferred).length,
                  ...(plan.simulation.error ? { error: plan.simulation.error } : {}),
                }
              : null,
            guard: plan.guard
              ? { ...plan.guard, pApprove: Math.min(1, Math.max(0, plan.guard.pApprove)) }
              : null,
          }}
        />
        {plan.tradeScoreBreakdown.length > 0 && (
          <ul className="mt-3 space-y-1 border-t border-border pt-3 text-xs">
            {plan.tradeScoreBreakdown.map((b) => (
              <li key={b.rule} className="flex gap-2">
                <Gauge className="mt-0.5 size-3 shrink-0 text-subtle-foreground" aria-hidden />
                <span
                  className={cn(
                    'w-8 shrink-0 font-semibold tabular-nums',
                    b.penalty < 0 ? 'text-caution' : 'text-safe',
                  )}
                >
                  {b.penalty < 0 ? b.penalty : '0'}
                </span>
                <span className="text-muted-foreground">{b.evidence}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section icon={<Bot />} title="Policy decision">
        {plan.policyReasons.length ? (
          <Reasons
            reasons={plan.policyReasons}
            tone={plan.policyOutcome === 'REFUSE' ? 'danger' : 'caution'}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            Within your limits and every safety threshold — the agent may act alone.
          </p>
        )}
      </Section>

      {plan.approval && (
        <Section icon={<Fingerprint />} title="Approval record">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">Status</dt>
            <dd className="font-medium">{plan.approval.status.toLowerCase()}</dd>
            <dt className="text-muted-foreground">Provider</dt>
            <dd>
              {plan.approval.providerKind === 'dev' ? 'DEV (World ID in Phase 10)' : 'World ID'}
            </dd>
            <dt className="text-muted-foreground">Why</dt>
            <dd className="[overflow-wrap:anywhere]">{plan.approval.reason}</dd>
            <dt className="text-muted-foreground">Expires</dt>
            <dd>{formatFullTime(plan.approval.expiresAt)}</dd>
            {plan.approval.resolvedAt && (
              <>
                <dt className="text-muted-foreground">Resolved</dt>
                <dd>{formatFullTime(plan.approval.resolvedAt)}</dd>
              </>
            )}
            {plan.approval.authTime && (
              <>
                <dt className="text-muted-foreground">Human authenticated</dt>
                <dd>{formatFullTime(plan.approval.authTime)}</dd>
              </>
            )}
          </dl>
          <HashChip className="mt-2" label="plan hash" value={plan.approval.planHash} />
        </Section>
      )}

      <Section icon={<Send />} title="Transactions">
        {plan.calls.length > 0 && (
          <div className="mb-3">
            <p className="mb-1.5 text-xs text-muted-foreground">
              Unsigned calls built by the Uniswap MCP server (previewed)
            </p>
            <ul className="space-y-1.5">
              {plan.calls.map((c, i) => (
                <li
                  key={`${c.to}-${i}`}
                  className="flex flex-wrap items-center gap-1.5 rounded-md border border-border/70 px-2 py-1.5 text-xs"
                >
                  <Badge>{c.kind.toLowerCase().replace('_', ' ')}</Badge>
                  <span className="text-muted-foreground">to</span>
                  <AddressChip address={c.to} />
                  {c.selector && (
                    <code className="rounded bg-surface-2 px-1 font-mono text-xs">
                      {c.selector}
                    </code>
                  )}
                  {c.valueWei !== '0' && (
                    <span className="text-muted-foreground tabular-nums">
                      value {c.valueWei} wei
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {plan.executions.length ? (
          <ul className="space-y-1.5">
            {plan.executions.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-1.5 text-xs">
                <Badge
                  tone={
                    e.status === 'CONFIRMED'
                      ? 'safe'
                      : e.status === 'FAILED' || e.status === 'REVERTED'
                        ? 'danger'
                        : 'info'
                  }
                >
                  {e.kind.toLowerCase().replace('_', ' ')} · {e.status.toLowerCase()}
                </Badge>
                {e.txHash && (
                  <HashChip value={e.txHash} {...(e.explorerUrl ? { href: e.explorerUrl } : {})} />
                )}
                {e.error && <span className="text-danger">{e.error}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CircleDashed className="size-3.5" aria-hidden /> Nothing was sent on-chain.
          </p>
        )}
      </Section>

      <DecisionLogSection plan={plan} />

      <Section icon={<FileJson />} title="Raw intent">
        <Disclosure title="Technical details" technical>
          <Json value={plan.intent} />
        </Disclosure>
        <HashChip className="mt-2" label="plan hash" value={plan.planHash} />
      </Section>
    </>
  );
}

/** Mounted once at shell level; opens from `?plan=<id>`. */
export function PlanDrawer() {
  const { planId, close } = usePlanDrawer();
  const plan = usePlan(planId);
  return (
    <Sheet open={Boolean(planId)} onOpenChange={(o) => !o && close()}>
      {planId && (
        <SheetContent
          title={
            plan.data
              ? plan.data.summary.charAt(0).toUpperCase() + plan.data.summary.slice(1)
              : 'Plan details'
          }
          description={
            plan.data ? (
              <>
                {plan.data.requestText ? `“${plan.data.requestText}” · ` : ''}
                {formatFullTime(plan.data.createdAt)}
              </>
            ) : undefined
          }
          aria-describedby={undefined}
        >
          {plan.isPending ? (
            <div className="p-5">
              <SkeletonRows rows={6} label="Loading plan" />
            </div>
          ) : plan.isError ? (
            <ErrorState
              className="py-10"
              title="Couldn't load this plan"
              description={plan.error.message}
              onRetry={() => void plan.refetch()}
              retrying={plan.isFetching}
            />
          ) : (
            <PlanBody plan={plan.data} />
          )}
          <div className="flex items-center gap-1.5 border-t border-border px-5 py-3 text-xs text-subtle-foreground">
            <ScrollText className="size-3" aria-hidden /> Plan {planId}
          </div>
        </SheetContent>
      )}
    </Sheet>
  );
}
