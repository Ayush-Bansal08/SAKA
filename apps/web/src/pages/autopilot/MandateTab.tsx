/**
 * Mandate: what the agent may do alone. Profile and limit changes need a fresh human check, so
 * they stay disabled until World ID step-up exists. The auto-act switches and rules are live.
 */
import {
  RISK_PROFILES,
  riskProfileSettings,
  usd,
  type LimitsView,
  type UserView,
} from '@warden/shared';
import { Fingerprint, Gauge, SlidersHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { useOutletContext } from 'react-router';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge, Card, Panel } from '@/components/ui-kit';
import { AlertSettings } from '@/features/inbox/AlertSettings';
import { useSettings } from '@/features/portfolio/hooks';
import { PROFILE_COPY } from '@/features/portfolio/profile-copy';
import { StepUpButton } from '@/features/portfolio/StepUpButton';
import { RulesPanel } from '@/features/triggers/RulesPanel';

const HOOK_POLICY_LABEL: Record<LimitsView['hookPolicy'], string> = {
  SAFE_ONLY: 'Safe hooks only',
  SAFE_AND_CAUTION: 'Safe + Caution hooks',
};

function Mini({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-subtle-foreground">{label}</dt>
      <dd className="font-medium tabular">{children}</dd>
    </div>
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

export function MandateTab() {
  const { user } = useOutletContext<{ user: UserView }>();
  const settings = useSettings();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-2">
      <Panel
        className="lg:col-span-2"
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
              <Card
                key={p}
                selected={active}
                aria-current={active ? 'true' : undefined}
                className="p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{PROFILE_COPY[p].label}</span>
                  {active && <Badge tone="agent">Current</Badge>}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{PROFILE_COPY[p].blurb}</p>
                <dl className="mt-3 space-y-1.5 text-xs">
                  <Mini label="Per action">{usd(s.perActionUsd)}</Mini>
                  <Mini label="Per day">{usd(s.perDayUsd)}</Mini>
                  <Mini label="Max slippage">{s.maxSlippagePct}%</Mini>
                  <Mini label="Min safety score">{s.minTradeScoreAuto}</Mini>
                </dl>
              </Card>
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

      <AlertSettings sections={['autoAct']} />

      <div className="lg:col-span-2">
        <RulesPanel collapsible={false} showClosed />
      </div>
    </div>
  );
}
