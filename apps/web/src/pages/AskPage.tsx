/**
 * The workspace: the agent in the middle, the portfolio beside it. Before the first message the
 * prompt sits in the centre with the overview under it. With agent internals on, the live trace
 * takes the side column. On narrower screens the trace lives in the top bar's activity drawer.
 */
import type { UserView } from '@warden/shared';
import { useEffect } from 'react';
import { useOutletContext, useSearchParams } from 'react-router';
import { AgentPanel } from '@/features/agent/AgentPanel';
import { useAgentMessages } from '@/features/agent/hooks';
import { InternalsToggle } from '@/features/agent/InternalsToggle';
import { requestPrefill } from '@/features/agent/prefill';
import { PortfolioRail } from '@/features/portfolio/PortfolioRail';
import { LiveActivity } from '@/features/trace/LiveActivity';
import { useAgentInternals } from '@/hooks/useStoredFlag';
import { Overview } from './workspace/Overview';

export function AskPage() {
  const { user } = useOutletContext<{ user: UserView }>();
  const [internals] = useAgentInternals();
  const talking = (useAgentMessages().data?.messages.length ?? 0) > 0;

  // "Change" on Telegram lands here: ?prefill=<text>&suggestion=<id> opens the chat pre-filled.
  const [params, setParams] = useSearchParams();
  const prefill = params.get('prefill');
  useEffect(() => {
    if (!prefill) return;
    requestPrefill(prefill);
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.delete('prefill');
        next.delete('suggestion');
        return next;
      },
      { replace: true },
    );
  }, [prefill, setParams]);

  return (
    <div className="grid h-[calc(100dvh-8.5rem)] w-full grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] gap-4 p-2 sm:h-full sm:p-3 xl:has-[>aside]:grid-cols-[minmax(0,1fr)_380px]">
      <AgentPanel user={user} actions={<InternalsToggle />} welcome={<Overview />} />
      {internals ? (
        <aside aria-label="Agent trace" className="hidden min-h-0 xl:flex xl:flex-col">
          <LiveActivity className="min-h-0 flex-1" />
        </aside>
      ) : talking ? (
        <aside aria-label="Portfolio summary" className="hidden min-h-0 xl:flex xl:flex-col">
          <PortfolioRail />
        </aside>
      ) : null}
    </div>
  );
}
