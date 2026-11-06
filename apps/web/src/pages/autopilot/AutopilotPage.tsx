/**
 * Autopilot (Mode B): what SAKA does on its own. The header states the mandate in plain chips;
 * the tabs hold the decisions, the mandate itself and, when the server allows it, the simulator.
 */
import { usd, type UserView } from '@warden/shared';
import { Sparkles } from 'lucide-react';
import { Outlet, useOutletContext } from 'react-router';
import { Badge, TabNav, type TabNavItem } from '@/components/ui-kit';
import { InternalsToggle } from '@/features/agent/InternalsToggle';
import { useProviders } from '@/features/auth/hooks';
import { useTriggers } from '@/features/hooks/hooks';
import { useSettings } from '@/features/portfolio/hooks';
import { useAutoActCount, usePendingCount } from '@/layout/shell-hooks';
import { PageContainer, PageHeader } from '../PageHeader';

function MandateChips() {
  const autoAct = useAutoActCount();
  const limits = useSettings().data?.limits;
  const rules = useTriggers().data?.triggers.filter((t) => t.status === 'ACTIVE').length ?? 0;
  return (
    <ul className="mb-6 flex flex-wrap gap-2" aria-label="Your mandate">
      {autoAct && (
        <li>
          <Badge tone="agent" icon={<Sparkles aria-hidden />} className="px-2.5 py-1">
            Auto-act {autoAct.on} of {autoAct.total}
          </Badge>
        </li>
      )}
      {limits && (
        <>
          <li>
            <Badge className="px-2.5 py-1 tabular">{usd(limits.perActionUsd)} per action</Badge>
          </li>
          <li>
            <Badge className="px-2.5 py-1 tabular">{usd(limits.perDayUsd)} per day</Badge>
          </li>
          <li>
            <Badge className="px-2.5 py-1 tabular">
              {Number(limits.maxSlippagePct)}% max slippage
            </Badge>
          </li>
        </>
      )}
      {rules > 0 && (
        <li>
          <Badge className="px-2.5 py-1 tabular">
            {rules} active rule{rules === 1 ? '' : 's'}
          </Badge>
        </li>
      )}
    </ul>
  );
}

export function AutopilotPage() {
  const { user } = useOutletContext<{ user: UserView }>();
  const providers = useProviders();
  const pending = usePendingCount();
  const tabs: TabNavItem[] = [
    {
      to: '/autopilot',
      label: 'Decisions',
      end: true,
      ...(pending > 0
        ? {
            badge: (
              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-warm px-1.5 text-xs leading-5 font-semibold text-background tabular-nums">
                {pending > 9 ? '9+' : pending}
              </span>
            ),
          }
        : {}),
    },
    { to: '/autopilot/mandate', label: 'Mandate' },
    ...(providers.data?.demoSimulator ? [{ to: '/autopilot/simulator', label: 'Simulator' }] : []),
  ];
  return (
    <PageContainer>
      <PageHeader
        title="Autopilot"
        description="What SAKA does on its own, and what it needs from you."
        actions={<InternalsToggle />}
      />
      <MandateChips />
      <TabNav label="Autopilot" items={tabs} />
      <div className="mt-6">
        <Outlet context={{ user }} />
      </div>
    </PageContainer>
  );
}
