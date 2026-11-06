/**
 * Hook detail (PHASE 07 §2): score breakdown with framework sections, permissions grid, facts,
 * pools, snapshot history (changes highlighted), the 0G explanation with its request ID, and the
 * what-if quote (through the hook pool vs the default route — execution chain only).
 */
import {
  ArrowLeft,
  BadgeCheck,
  CheckCircle2,
  History,
  ListChecks,
  Loader2,
  MessageSquareText,
  Shapes,
  Waves,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { AddressChip, Badge, ErrorState, HashChip, Panel, SkeletonRows } from '@/components/ui-kit';
import { requestPrefill } from '@/features/agent/prefill';
import { PermissionChips, ScoreRing } from '@/features/hooks/HookCard';
import { useHook, useWhatIf } from '@/features/hooks/hooks';
import {
  ageLabel,
  pairLabel,
  BAND_META,
  compactUsd,
  permissionCopy,
  riskTone,
} from '@/features/hooks/permission-copy';
import { formatFullTime, formatTokenAmount } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PageContainer } from './PageHeader';

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/70 bg-background/40 px-3 py-2">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function WhatIf({
  chainId,
  address,
  pairs,
}: {
  chainId: number;
  address: string;
  pairs: string[];
}) {
  const [pair, setPair] = useState(pairs[0] ?? 'ETH-USDC');
  const [amount, setAmount] = useState(100);
  const [run, setRun] = useState(false);
  const q = useWhatIf(chainId, address, pair, amount, run);
  return (
    <Panel
      title="What if I swap through it?"
      icon={<Waves />}
      subtitle="Quote through this hook's pool vs the default Uniswap route"
    >
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setRun(true);
          void q.refetch();
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="whatif-pair" className="text-[11px] text-muted-foreground">
            Pair
          </label>
          <select
            id="whatif-pair"
            value={pair}
            onChange={(e) => setPair(e.target.value)}
            className="h-9 rounded-md border border-input bg-surface-2 px-2.5 text-sm"
          >
            {[...new Set([...pairs, 'ETH-USDC'])].map((p) => (
              <option key={p} value={p}>
                {p.replace('-', ' → ')}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="whatif-amount" className="text-[11px] text-muted-foreground">
            Amount (USD)
          </label>
          <input
            id="whatif-amount"
            type="number"
            min={1}
            max={10000}
            value={amount}
            onChange={(e) => setAmount(Math.max(1, Number(e.target.value) || 1))}
            className="h-9 w-28 rounded-md border border-input bg-surface-2 px-2.5 text-sm tabular-nums"
          />
        </div>
        <Button type="submit" size="sm" disabled={q.isFetching}>
          {q.isFetching && <Loader2 className="animate-spin" />} Compare
        </Button>
      </form>
      {q.data && (
        <div className="mt-4">
          {!q.data.available ? (
            <p className="text-sm text-muted-foreground">{q.data.reason}</p>
          ) : (
            <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <Fact
                label={`Through this hook (${(q.data.viaHook!.fee / 10_000).toFixed(2)}% pool)`}
              >
                {formatTokenAmount(q.data.viaHook!.amountOut)} {q.data.tokenOut}
              </Fact>
              <Fact label="Default route">
                {formatTokenAmount(q.data.defaultRoute!.amountOut)} {q.data.tokenOut}
              </Fact>
              <Fact label="Difference after gas">
                <span
                  className={cn(
                    q.data.netDifferencePct === null
                      ? 'text-muted-foreground'
                      : q.data.netDifferencePct >= 0
                        ? 'text-safe'
                        : 'text-danger',
                  )}
                >
                  {q.data.netDifferencePct === null
                    ? 'gas unknown'
                    : `${q.data.netDifferencePct >= 0 ? '+' : ''}${q.data.netDifferencePct.toFixed(2)}%`}
                </span>
              </Fact>
              <Fact label="Difference before gas">
                <span
                  className={cn((q.data.differencePct ?? 0) >= 0 ? 'text-safe' : 'text-danger')}
                >
                  {q.data.differencePct === null
                    ? '—'
                    : `${q.data.differencePct >= 0 ? '+' : ''}${q.data.differencePct.toFixed(2)}%`}
                </span>
              </Fact>
            </dl>
          )}
        </div>
      )}
      {q.isError && <p className="mt-3 text-sm text-danger">{q.error.message}</p>}
    </Panel>
  );
}

export function HookDetailPage() {
  const { chainId = '1', address = '' } = useParams();
  const navigate = useNavigate();
  const hook = useHook(Number(chainId), address);
  const h = hook.data;
  return (
    <PageContainer>
      <Link
        to="/hooks"
        className="mb-4 inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden /> All hooks
      </Link>
      {hook.isPending ? (
        <SkeletonRows rows={6} label="Loading hook" />
      ) : hook.isError ? (
        <ErrorState
          title="Couldn't load this hook"
          description={hook.error.message}
          onRetry={() => void hook.refetch()}
          retrying={hook.isFetching}
        />
      ) : h ? (
        <div className="grid gap-5">
          <header className="flex flex-wrap items-start gap-4 rounded-lg border border-border bg-card p-5">
            <ScoreRing score={h.score} band={h.band} size="lg" />
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">
                {h.name ?? `Hook ${h.address.slice(0, 6)}…${h.address.slice(-4)}`}
              </h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <AddressChip address={h.address} />
                <Badge tone={BAND_META[h.band].tone}>{BAND_META[h.band].label}</Badge>
                {h.frameworkTier && <Badge>Framework tier ≥ {h.frameworkTier}</Badge>}
                <span>
                  {h.chainId === 1
                    ? 'Ethereum mainnet · read-only'
                    : 'Tradeable on the execution chain'}
                </span>
                <span>
                  · TVL {compactUsd(h.tvlUsd)} · {ageLabel(h.ageDays)}
                </span>
              </div>
              <div className="mt-3">
                <PermissionChips permissions={h.permissions} max={14} />
              </div>
            </div>
            <Button
              variant="outline"
              onClick={() => {
                requestPrefill(`Explain hook ${h.address}`);
                void navigate('/ask');
              }}
            >
              <MessageSquareText aria-hidden /> Ask agent about this
            </Button>
          </header>

          <Panel
            title="In plain English"
            icon={<BadgeCheck />}
            subtitle="Written on 0G; the score above is deterministic"
          >
            <p className="text-sm leading-relaxed whitespace-pre-line">
              {h.explanation?.text ??
                'Explanation pending — it is written on the next indexer run.'}
            </p>
            {h.explanation?.requestId ? (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <HashChip
                  tone="zg"
                  label={h.explanation.model ?? '0G'}
                  value={h.explanation.requestId}
                  icon={<BadgeCheck className="size-3" aria-hidden />}
                />
                {h.explanation.trustMode && <Badge tone="zg">{h.explanation.trustMode}</Badge>}
                {h.explanation.teeVerified && <Badge tone="safe">TEE ✓</Badge>}
              </div>
            ) : h.explanation ? (
              <p className="mt-2 text-[11px] text-subtle-foreground">
                Template text — the 0G explainer was unavailable; it retries automatically.
              </p>
            ) : null}
          </Panel>

          <div className="grid gap-5 lg:grid-cols-2">
            <Panel
              title="Score breakdown"
              icon={<ListChecks />}
              subtitle="100 minus penalties · Uniswap v4 Security Framework"
              bodyClassName="p-0"
            >
              {h.breakdown.length === 0 ? (
                <p className="flex items-center gap-2 p-4 text-sm text-safe">
                  <CheckCircle2 className="size-4" aria-hidden /> No penalties.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-border text-xs text-muted-foreground">
                      <tr>
                        <th className="px-4 py-2 font-medium">Rule</th>
                        <th className="px-2 py-2 text-right font-medium">Penalty</th>
                        <th className="px-4 py-2 font-medium">Evidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {h.breakdown.map((b) => (
                        <tr
                          key={b.rule}
                          className="border-b border-border/60 last:border-0 align-top"
                        >
                          <td className="px-4 py-2">
                            <span className="font-medium">{b.rule.replace(/_/g, ' ')}</span>
                            {b.source && (
                              <span className="block text-[11px] text-subtle-foreground">
                                {b.source}
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-2 text-right font-semibold text-caution tabular-nums">
                            {b.penalty}
                          </td>
                          <td className="px-4 py-2 text-xs text-muted-foreground">{b.evidence}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <Panel
              title="Permissions"
              icon={<Shapes />}
              subtitle="The 14 v4 callbacks — what this hook can do"
            >
              <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {h.permissionGrid.map((p) => (
                  <li
                    key={p.flag}
                    className={cn(
                      'rounded-md border px-2.5 py-1.5 text-xs',
                      p.enabled
                        ? 'border-border-strong bg-surface-2'
                        : 'border-border/50 text-subtle-foreground',
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium">{permissionCopy(p.flag).short}</span>
                      {p.enabled ? (
                        <Badge tone={riskTone(p.risk)}>{(p.risk ?? 'on').toLowerCase()}</Badge>
                      ) : (
                        <span>off</span>
                      )}
                    </span>
                    <span className="block font-mono text-[10.5px] text-subtle-foreground">
                      {p.flag}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>

          <Panel title="Facts" icon={<ListChecks />}>
            <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <Fact label="Upgradeable">
                {h.facts.upgradeable
                  ? `Yes${h.facts.proxyKind ? ` (${h.facts.proxyKind})` : ''}`
                  : 'No'}
              </Fact>
              <Fact label="Verified source">
                {h.facts.verifiedSource === null
                  ? 'Unknown'
                  : h.facts.verifiedSource
                    ? 'Yes'
                    : 'No'}
              </Fact>
              <Fact label="Owner">
                {h.facts.owner ? <AddressChip address={h.facts.owner} /> : 'None'}
              </Fact>
              <Fact label="Implementation">
                {h.facts.implementation ? <AddressChip address={h.facts.implementation} /> : '—'}
              </Fact>
              <Fact label="Code hash">
                {h.facts.codeHash ? <HashChip value={h.facts.codeHash} /> : '—'}
              </Fact>
              <Fact label="Admin functions">
                {h.facts.adminSelectors.length ? h.facts.adminSelectors.join(', ') : 'None found'}
              </Fact>
              <Fact label="Contract">{h.facts.contractName ?? '—'}</Fact>
              <Fact label="Last checked">{formatFullTime(h.lastCheckedAt)}</Fact>
            </dl>
          </Panel>

          <div className="grid gap-5 lg:grid-cols-2">
            <Panel title="Pools" icon={<Waves />} bodyClassName="p-0">
              {h.pairs.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  No pools found for this hook yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-border text-xs text-muted-foreground">
                      <tr>
                        <th className="px-4 py-2 font-medium">Pair</th>
                        <th className="px-2 py-2 font-medium">Fee</th>
                        <th className="px-4 py-2 text-right font-medium">TVL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {h.pairs.map((p) => (
                        <tr key={p.poolId} className="border-b border-border/60 last:border-0">
                          <td className="px-4 py-2 font-medium">{pairLabel(p)}</td>
                          <td className="px-2 py-2 tabular-nums">{(p.fee / 10_000).toFixed(2)}%</td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {compactUsd(p.tvlUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
            <Panel
              title="History"
              icon={<History />}
              subtitle="First sight and every observable change"
            >
              <ol className="space-y-3">
                {h.snapshots.map((s, i) => (
                  <li key={s.takenAt} className="flex gap-3 text-sm">
                    <span
                      className={cn(
                        'mt-1.5 size-2 shrink-0 rounded-full',
                        s.changes.length ? 'bg-caution' : 'bg-border-strong',
                      )}
                      aria-hidden
                    />
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">
                        {formatFullTime(s.takenAt)} · score {s.score} · {BAND_META[s.band].label}
                      </p>
                      {s.changes.length ? (
                        <ul className="mt-1 space-y-0.5">
                          {s.changes.map((c) => (
                            <li
                              key={c}
                              className="rounded bg-caution/10 px-1.5 py-0.5 text-xs font-medium text-caution"
                            >
                              {c}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs">
                          {i === h.snapshots.length - 1 ? 'First seen' : 'No changes'}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
                {h.snapshots.length === 0 && (
                  <li className="text-sm text-muted-foreground">No snapshots yet.</li>
                )}
              </ol>
            </Panel>
          </div>

          {h.tradeable ? (
            <WhatIf
              chainId={h.chainId}
              address={h.address}
              pairs={[
                ...new Set(
                  h.pairs
                    .filter((p) => p.token0Symbol && p.token1Symbol)
                    .map((p) => `${p.token0Symbol}-${p.token1Symbol}`),
                ),
              ]}
            />
          ) : (
            <p className="text-xs text-subtle-foreground">
              Market data only — this hook lives on Ethereum mainnet, where your agent never trades.
            </p>
          )}
        </div>
      ) : null}
    </PageContainer>
  );
}
