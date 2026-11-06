/**
 * Ask (Mode A): the chat, with the live trace beside it when agent internals are on.
 * On narrower screens the trace lives in the drawer behind the top bar's activity button.
 */
import type { UserView } from '@warden/shared';
import { useEffect } from 'react';
import { useOutletContext, useSearchParams } from 'react-router';
import { AgentPanel } from '@/features/agent/AgentPanel';
import { requestPrefill } from '@/features/agent/prefill';
import { InternalsToggle } from '@/features/agent/InternalsToggle';
import { LiveActivity } from '@/features/trace/LiveActivity';
import { useAgentInternals } from '@/hooks/useStoredFlag';

export function AskPage() {
  const { user } = useOutletContext<{ user: UserView }>();
  const [internals] = useAgentInternals();

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
    <div className="mx-auto grid h-[calc(100dvh-8.5rem)] w-full max-w-[1560px] grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] gap-4 p-3 sm:h-full md:p-4 xl:has-[>aside]:grid-cols-[minmax(0,1fr)_400px]">
      <AgentPanel user={user} actions={<InternalsToggle />} />
      {internals && (
        <aside aria-label="Agent trace" className="hidden min-h-0 xl:flex xl:flex-col">
          <LiveActivity className="min-h-0 flex-1" />
        </aside>
      )}
    </div>
  );
}
