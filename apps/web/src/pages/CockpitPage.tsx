import type { UserView } from '@warden/shared';
import { Bot, MessageSquareText, SendHorizontal } from 'lucide-react';
import { useOutletContext } from 'react-router';
import { Button } from '@/components/ui/button';
import { AgentBadge, EmptyState, Panel } from '@/components/ui-kit';
import { PortfolioPanel } from '@/features/portfolio/PortfolioPanel';
import { LiveActivity } from '@/features/trace/LiveActivity';

const EXAMPLE_PROMPTS = [
  'Swap $20 ETH to USDC',
  'Put $100 into ETH/USDC',
  'Is this token safe?',
  'Stop loss at $2,800',
];

function AgentPanel({ user }: { user: UserView }) {
  return (
    <Panel
      id="agent"
      title="Agent"
      subtitle="Plans on 0G · builds on Uniswap · you stay in control"
      icon={<Bot />}
      actions={<AgentBadge />}
      bodyClassName="flex flex-col p-0"
    >
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-10">
        <EmptyState
          className="py-0"
          icon={<MessageSquareText />}
          title={`Hi ${user.displayName ?? 'there'} — I'm your agent.`}
          description="Ask me to swap, provide liquidity, set a stop-loss or check if a token is safe. Small safe actions run on their own; anything bigger waits for you."
        >
          <ul
            className="mt-5 flex max-w-md flex-wrap justify-center gap-2"
            aria-label="Example requests"
          >
            {EXAMPLE_PROMPTS.map((p) => (
              <li
                key={p}
                className="rounded-full border border-border bg-surface-2 px-3 py-1.5 text-xs text-muted-foreground"
              >
                {p}
              </li>
            ))}
          </ul>
        </EmptyState>
      </div>
      <form
        className="flex items-center gap-2 border-t border-border p-3"
        onSubmit={(e) => e.preventDefault()}
        aria-label="Message your agent"
      >
        <label htmlFor="agent-input" className="sr-only">
          Message your agent
        </label>
        <input
          id="agent-input"
          disabled
          placeholder="Chat with your agent opens in an upcoming release"
          className="h-11 min-w-0 flex-1 rounded-md border border-input bg-surface-2 px-3.5 text-sm placeholder:text-subtle-foreground disabled:cursor-not-allowed"
        />
        <Button type="submit" size="icon" className="size-11" disabled aria-label="Send message">
          <SendHorizontal />
        </Button>
      </form>
    </Panel>
  );
}

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
