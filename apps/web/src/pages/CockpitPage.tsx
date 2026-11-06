/**
 * Cockpit (PHASE 06 §1). Desktop ≥ 1280px: Portfolio 320 | Agent | Live activity 380.
 * Tablet: Portfolio | Agent, activity in a slide-over from the header. Mobile: tabs.
 */
import type { UserView } from '@warden/shared';
import { Activity, Bot, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router';
import { AgentPanel } from '@/features/agent/AgentPanel';
import { requestPrefill } from '@/features/agent/prefill';
import { PortfolioPanel } from '@/features/portfolio/PortfolioPanel';
import { LiveActivity } from '@/features/trace/LiveActivity';
import { RulesPanel } from '@/features/triggers/RulesPanel';
import { cn } from '@/lib/utils';

type Tab = 'agent' | 'portfolio' | 'activity';
const TABS: { id: Tab; label: string; icon: typeof Bot }[] = [
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'portfolio', label: 'Portfolio', icon: Wallet },
  { id: 'activity', label: 'Activity', icon: Activity },
];

export function CockpitPage() {
  const { user } = useOutletContext<{ user: UserView }>();
  const [tab, setTab] = useState<Tab>('agent');

  // "Change" on Telegram lands here: /?prefill=<text>&suggestion=<id> opens the chat pre-filled.
  const [params, setParams] = useSearchParams();
  const prefill = params.get('prefill');
  useEffect(() => {
    if (!prefill) return;
    requestPrefill(prefill);
    setTab('agent');
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
    <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-3 p-3 md:h-full md:p-5">
      {/* Mobile tabs */}
      <div
        role="tablist"
        aria-label="Cockpit"
        className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-card p-1 md:hidden"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex h-9 items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              tab === t.id ? 'bg-surface-3 text-foreground' : 'text-muted-foreground',
            )}
          >
            <t.icon className={cn('size-4', tab === t.id && 'text-agent')} aria-hidden />
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[minmax(260px,300px)_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)_380px]">
        <div
          id="panel-portfolio"
          role="tabpanel"
          aria-labelledby="tab-portfolio"
          className={cn('min-h-0 md:block', tab === 'portfolio' ? 'block' : 'hidden')}
        >
          <div className="flex flex-col gap-4 md:h-full md:overflow-y-auto">
            <PortfolioPanel user={user} />
            <RulesPanel />
          </div>
        </div>
        <div
          id="panel-agent"
          role="tabpanel"
          aria-labelledby="tab-agent"
          className={cn(
            'min-h-0 flex-col md:flex [&>section]:h-[calc(100dvh-210px)] md:[&>section]:h-auto md:[&>section]:flex-1',
            tab === 'agent' ? 'flex' : 'hidden',
          )}
        >
          <AgentPanel user={user} />
        </div>
        <div
          id="panel-activity"
          role="tabpanel"
          aria-labelledby="tab-activity"
          className={cn(
            'min-h-0 xl:flex xl:flex-col',
            tab === 'activity' ? 'flex flex-col md:hidden' : 'hidden',
          )}
        >
          <LiveActivity className="h-[calc(100dvh-210px)] xl:h-auto xl:flex-1" />
        </div>
      </div>
    </div>
  );
}
