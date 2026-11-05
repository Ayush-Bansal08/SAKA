import { Inbox } from 'lucide-react';
import { EmptyState, Panel } from '@/components/ui-kit';
import { PageContainer, PageHeader } from './PageHeader';

export function InboxPage() {
  return (
    <PageContainer>
      <PageHeader
        title="Inbox"
        description="Suggestions from your agent and actions waiting for your approval."
      />
      <Panel>
        <EmptyState
          icon={<Inbox />}
          title="You're all caught up"
          description="When your agent spots a dip, idle USDC, an out-of-range position or a hook change, it shows up here — and on Telegram if you connect it."
        />
      </Panel>
    </PageContainer>
  );
}
