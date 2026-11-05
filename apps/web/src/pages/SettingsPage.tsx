import {
  RISK_PROFILES,
  riskProfileSettings,
  usd,
  type RiskProfile,
  type UserView,
} from '@warden/shared';
import { Bell, Gauge, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { useOutletContext } from 'react-router';
import { Badge, EmptyState, HumanBadge, Panel } from '@/components/ui-kit';
import { formatFullTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PageContainer, PageHeader } from './PageHeader';

const PROFILE_COPY: Record<RiskProfile, { label: string; blurb: string }> = {
  CAREFUL: { label: 'Careful', blurb: 'Small moves, asks you often.' },
  BALANCED: { label: 'Balanced', blurb: 'Sensible limits for everyday use.' },
  ADVENTUROUS: { label: 'Adventurous', blurb: 'Bigger moves, fewer interruptions.' },
};

export function SettingsPage() {
  const { user } = useOutletContext<{ user: UserView }>();
  return (
    <PageContainer>
      <PageHeader
        title="Settings"
        description="Your identity, your agent's limits and your alerts."
      />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
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
            <Row label="Time zone">{user.timezone}</Row>
          </dl>
        </Panel>

        <Panel title="Risk profile" subtitle="What your agent may do on its own" icon={<Gauge />}>
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
          <p className="mt-3 text-xs text-subtle-foreground">
            Changing your risk profile or limits always requires a fresh human verification.
          </p>
        </Panel>

        <Panel title="Alerts" icon={<Bell />} className="lg:col-span-2">
          <EmptyState
            className="py-6"
            icon={<Bell />}
            title={user.telegramLinked ? 'Telegram connected' : 'Telegram not connected'}
            description="Your agent sends proactive alerts, approval requests and a morning brief to Telegram."
          />
        </Panel>
      </div>
    </PageContainer>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
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
