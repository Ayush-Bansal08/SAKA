import { HOOK_BAND_THRESHOLDS } from '@warden/shared';
import { Blocks } from 'lucide-react';
import { CautionBadge, DangerBadge, EmptyState, Panel, SafeBadge } from '@/components/ui-kit';
import { PageContainer, PageHeader } from './PageHeader';

export function HooksPage() {
  return (
    <PageContainer>
      <PageHeader
        title="Hook explorer"
        description="Uniswap v4 hooks with a 0–100 safety score and a plain-English explanation."
      />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Score bands:</span>
        <SafeBadge>Safe · {HOOK_BAND_THRESHOLDS.safeMin}–100</SafeBadge>
        <CautionBadge>
          Caution · {HOOK_BAND_THRESHOLDS.cautionMin}–{HOOK_BAND_THRESHOLDS.safeMin - 1}
        </CautionBadge>
        <DangerBadge>Danger · below {HOOK_BAND_THRESHOLDS.cautionMin}</DangerBadge>
      </div>
      <Panel>
        <EmptyState
          icon={<Blocks />}
          title="No hooks indexed yet"
          description="Hooks discovered on the testnet and on Ethereum mainnet will be listed here with their permissions, owner, upgradeability and safety score."
        />
      </Panel>
    </PageContainer>
  );
}
