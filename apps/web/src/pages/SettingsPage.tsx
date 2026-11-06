import {
  CHAINS,
  RISK_PROFILES,
  riskProfileSettings,
  usd,
  type LimitsView,
  type UserView,
} from '@warden/shared';
import {
  ArrowUpRight,
  Fingerprint,
  Gauge,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  Wallet,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useOutletContext } from 'react-router';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { AddressChip, Badge, EmptyState, ErrorState, HumanBadge, Panel } from '@/components/ui-kit';
import { useSettings } from '@/features/portfolio/hooks';
import { PROFILE_COPY } from '@/features/portfolio/profile-copy';
import { formatFullTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AlertSettings } from '@/features/inbox/AlertSettings';
import { RulesPanel } from '@/features/triggers/RulesPanel';
import { PageContainer, PageHeader } from './PageHeader';

const STEP_UP_TOOLTIP = 'Needs World ID (coming in Phase 10)';

const HOOK_POLICY_LABEL: Record<LimitsView['hookPolicy'], string> = {
  SAFE_ONLY: 'Safe hooks only',
  SAFE_AND_CAUTION: 'Safe + Caution hooks',
};

export function SettingsPage() {
  const { user } = useOutletContext<{ user: UserView }>();
  const settings = useSettings();

  return (
    <PageContainer>
      <PageHeader
        title="Settings"
        description="Your identity, your agent's wallet and limits, and your alerts."
      />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <div className="grid gap-4">
          <Panel title="Account" icon={<UserRound />}>
            <dl className="space-y-3 text-sm">
              <Row label="Name">{user.displayName ?? '—'}</Row>
              <Row label="Identity">
                <span className="flex flex-wrap justify-end gap-1.5">
                  <HumanBadge>Verified human</HumanBadge>
                  {user.identityKind === 'dev' && <Badge tone="caution">DEV</Badge>}
                </span>
              </Row>
              <Row label="Verified">{user.verifiedAt ? formatFullTime(user.verifiedAt) : '—'}</Row>
              <Row label="Time zone">{settings.data?.timezone ?? user.timezone}</Row>
            </dl>
          </Panel>

          <Panel title="Agent wallet" icon={<Wallet />}>
            {settings.isPending ? (
              <div role="status" aria-label="Loading wallet" className="space-y-2">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-4 w-32" />
              </div>
            ) : settings.isError ? (
              <ErrorState
                className="py-4"
                title="Couldn't load your wallet"
                description={settings.error.message}
                onRetry={() => void settings.refetch()}
                retrying={settings.isFetching}
              />
            ) : settings.data.wallet ? (
              <div className="space-y-4">
                <dl className="space-y-3 text-sm">
                  <Row label="Address">
                    <AddressChip
                      address={settings.data.wallet.address}
                      chainId={settings.data.wallet.chainId}
                    />
                  </Row>
                  <Row label="Network">{CHAINS[settings.data.wallet.chainId].name}</Row>
                  <Row label="Created">{formatFullTime(settings.data.wallet.createdAt)}</Row>
                  <Row label="Wallet policy">
                    {settings.data.wallet.policyId ? (
                      <Badge tone="safe" icon={<ShieldCheck aria-hidden />}>
                        Privy policy enforced
                      </Badge>
                    ) : (
                      <Badge tone="neutral">Backend guard only</Badge>
                    )}
                  </Row>
                </dl>
                <p className="text-xs leading-relaxed text-subtle-foreground">
                  A Privy server wallet that only your agent controls. It can only call Uniswap
                  contracts, Permit2 and allowlisted tokens on this testnet.
                </p>
                <StepUpButton icon={<ArrowUpRight />}>Withdraw</StepUpButton>
              </div>
            ) : (
              <EmptyState
                className="py-4"
                icon={<Wallet />}
                title="No agent wallet yet"
                description="Finish onboarding to create it."
              />
            )}
          </Panel>
        </div>

        <div className="grid gap-4">
          <Panel
            title="Risk profile"
            subtitle="What your agent may do on its own"
            icon={<Gauge />}
            actions={<StepUpButton size="sm">Change profile</StepUpButton>}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              {RISK_PROFILES.map((p) => {
                const s = riskProfileSettings(p);
                const active = p === user.riskProfile;
                return (
                  <div
                    key={p}
                    aria-current={active ? 'true' : undefined}
                    className={cn(
                      'rounded-lg border p-3.5',
                      active ? 'border-agent/50 bg-agent/[0.06]' : 'border-border bg-surface-2/40',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold">{PROFILE_COPY[p].label}</span>
                      {active && <Badge tone="agent">Current</Badge>}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{PROFILE_COPY[p].blurb}</p>
                    <dl className="mt-3 space-y-1.5 text-xs">
                      <Mini label="Per action">{usd(s.perActionUsd)}</Mini>
                      <Mini label="Per day">{usd(s.perDayUsd)}</Mini>
                      <Mini label="Max slippage">{s.maxSlippagePct}%</Mini>
                      <Mini label="Min safety score">{s.minTradeScoreAuto}</Mini>
                    </dl>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 flex items-center gap-1.5 text-xs text-subtle-foreground">
              <Fingerprint className="size-3.5 text-human" aria-hidden />
              Changing your risk profile or limits always requires a fresh human verification.
            </p>
          </Panel>

          <Panel
            title="Limits"
            subtitle="Applied to every action your agent takes alone"
            icon={<SlidersHorizontal />}
            actions={<StepUpButton size="sm">Change limits</StepUpButton>}
          >
            {settings.isPending ? (
              <div role="status" aria-label="Loading limits" className="space-y-2">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-4 w-full" />
                ))}
              </div>
            ) : settings.data?.limits ? (
              <LimitsTable limits={settings.data.limits} />
            ) : (
              <p className="text-sm text-muted-foreground">
                Your limits are set when you choose a risk profile during onboarding.
              </p>
            )}
          </Panel>

          <RulesPanel collapsible={false} showClosed />
          <AlertSettings />
        </div>
      </div>
    </PageContainer>
  );
}

function LimitsTable({ limits }: { limits: LimitsView }) {
  const rows: [string, ReactNode][] = [
    ['Per action', usd(limits.perActionUsd)],
    ['Per day', usd(limits.perDayUsd)],
    ['Max slippage', `${Number(limits.maxSlippagePct)}%`],
    ['Min trade safety score', `${limits.minTradeScoreAuto} / 100`],
    ['Hooks without approval', HOOK_POLICY_LABEL[limits.hookPolicy]],
  ];
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">
        Agent limits for the {PROFILE_COPY[limits.riskProfile].label} profile
      </caption>
      <tbody className="divide-y divide-border">
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row" className="py-2.5 text-left font-normal text-muted-foreground">
              {label}
            </th>
            <td className="py-2.5 text-right font-medium tabular">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Present but disabled until approvals (P05) and World ID step-up (P10) exist. */
function StepUpButton({
  children,
  icon,
  size = 'default',
}: {
  children: ReactNode;
  icon?: ReactNode;
  size?: 'sm' | 'default';
}) {
  return (
    <SimpleTooltip label={STEP_UP_TOOLTIP}>
      {/* Disabled buttons swallow pointer events; the wrapper keeps the tooltip reachable. */}
      <span
        tabIndex={0}
        className="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Button variant="secondary" size={size} disabled>
          {icon}
          {children}
          <Fingerprint className="text-human" aria-hidden />
          <span className="sr-only">({STEP_UP_TOOLTIP})</span>
        </Button>
      </span>
    </SimpleTooltip>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium">{children}</dd>
    </div>
  );
}

function Mini({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-subtle-foreground">{label}</dt>
      <dd className="font-medium tabular">{children}</dd>
    </div>
  );
}
