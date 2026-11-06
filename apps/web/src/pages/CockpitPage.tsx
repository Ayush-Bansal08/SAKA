import type { UserView } from '@warden/shared';
import { useOutletContext } from 'react-router';
import { AgentPanel } from '@/features/agent/AgentPanel';
import { PortfolioPanel } from '@/features/portfolio/PortfolioPanel';
import { LiveActivity } from '@/features/trace/LiveActivity';

export function CockpitPage() {
  const { user } = useOutletContext<{ user: UserView }>();
  return (
    <div className="mx-auto grid w-full max-w-[1600px] grid-cols-1 gap-4 p-4 md:p-5 lg:h-full lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)_minmax(300px,380px)] lg:grid-rows-[minmax(0,1fr)]">
      <PortfolioPanel user={user} />
      <AgentPanel user={user} />
      <LiveActivity className="max-h-[70vh] lg:max-h-none" />
    </div>
  );
}
