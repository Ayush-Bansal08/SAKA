import { History } from 'lucide-react';
import { EmptyState, Panel } from '@/components/ui-kit';
import { PageContainer, PageHeader } from './PageHeader';

export function ActivityPage() {
  return (
    <PageContainer>
      <PageHeader
        title="Activity"
        description="Every action your agent executed, who approved it, and its tamper-proof record on 0G Storage."
      />
      <Panel>
        <EmptyState
          icon={<History />}
          title="No actions yet"
          description="Swaps, transfers and liquidity moves appear here with their transaction hashes, 0G request IDs and decision-log root hashes."
        />
      </Panel>
    </PageContainer>
  );
}
