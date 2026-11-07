/**
 * Passkey approvals. The human opens the approval page and signs a challenge bound to the
 * approval and plan hash (see PasskeyService); the route then resolves it with that evidence.
 */
import type { Env } from '../../config/env.js';
import type {
  ApprovalProvider,
  ApprovalRequestChannel,
  ApprovalRequestView,
} from './approval-provider.js';

export class PasskeyApprovalProvider implements ApprovalProvider {
  readonly kind = 'passkey' as const;

  constructor(
    private readonly env: Pick<Env, 'WEB_URL'>,
    private readonly lookup: (approvalId: string) => Promise<{ expiresAt: Date } | null>,
  ) {}

  async requestApproval(
    approvalId: string,
    channel: ApprovalRequestChannel,
  ): Promise<ApprovalRequestView> {
    const row = await this.lookup(approvalId);
    if (!row) throw new Error(`Approval ${approvalId} not found`);
    return {
      approvalId,
      providerKind: 'passkey',
      channel,
      expiresAt: row.expiresAt,
      verificationUrl: `${this.env.WEB_URL}/approvals/${approvalId}`,
    };
  }
}
