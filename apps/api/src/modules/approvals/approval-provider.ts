/**
 * Pluggable human approvals (PHASE_00 §7): DevApprovalProvider for local work,
 * PasskeyApprovalProvider everywhere else.
 */
import type { ProviderKind } from '@warden/shared';

export type ApprovalRequestChannel = 'web' | 'telegram';

export interface ApprovalRequestView {
  approvalId: string;
  providerKind: ProviderKind;
  channel: ApprovalRequestChannel;
  expiresAt: Date;
  /** Where the human completes the approval (web URL). */
  verificationUrl?: string;
}

export interface ApprovalProvider {
  kind: ProviderKind;
  /** Creates the human-facing request for an approval that is already persisted (status=PENDING). */
  requestApproval(
    approvalId: string,
    channel: ApprovalRequestChannel,
  ): Promise<ApprovalRequestView>;
  // Implementations validate the human in their own callback/poller, re-check the
  // binding (user, plan hash, amount, expiry) and call approvalsService.resolve().
}
