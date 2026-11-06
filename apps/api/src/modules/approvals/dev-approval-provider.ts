/**
 * DEV approval provider (PHASE 05 §4). Enabled only with APPROVAL_MODE=dev,
 * ALLOW_DEV_PROVIDERS=true and NODE_ENV≠production (env validation + the factory both check).
 * The human taps "Approve (DEV)" in the web app; evidence is `providerKind='dev'`,
 * `approvedByIss='dev'`, `approvedBySub=<the signed-in human's sub>`. The service rejects
 * evidence whose sub is not the account owner, so the "wrong human" path exists before World.
 * World ID step-up (PHASE 10) replaces this with a fresh OIDC authentication.
 */
import type { User } from '@prisma/client';
import { devProvidersAllowed, type Env } from '../../config/env.js';
import type {
  ApprovalProvider,
  ApprovalRequestChannel,
  ApprovalRequestView,
} from './approval-provider.js';
import type { ApprovalsService, ResolveResult } from './service.js';

export const DEV_APPROVAL_ISSUER = 'dev';

export class DevApprovalProvider implements ApprovalProvider {
  readonly kind = 'dev' as const;

  constructor(
    private readonly env: Pick<Env, 'WEB_URL'>,
    private readonly approvals: ApprovalsService,
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
      providerKind: 'dev',
      channel,
      expiresAt: row.expiresAt,
      verificationUrl: `${this.env.WEB_URL}/approvals/${approvalId}`,
    };
  }

  /** The signed-in human tapped "Approve (DEV)". */
  approve(approvalId: string, human: Pick<User, 'identitySub'>): Promise<ResolveResult> {
    return this.approvals.resolve(approvalId, 'APPROVED', {
      providerKind: 'dev',
      iss: DEV_APPROVAL_ISSUER,
      sub: human.identitySub,
      authTime: new Date(),
      acr: 'dev',
      amr: ['dev'],
    });
  }
}

export function createApprovalProvider(
  env: Env,
  approvals: ApprovalsService,
  lookup: (approvalId: string) => Promise<{ expiresAt: Date } | null>,
): DevApprovalProvider {
  if (env.APPROVAL_MODE === 'dev') {
    if (!devProvidersAllowed(env))
      throw new Error(
        'APPROVAL_MODE=dev requires ALLOW_DEV_PROVIDERS=true and NODE_ENV!=production',
      );
    return new DevApprovalProvider(env, approvals, lookup);
  }
  throw new Error('APPROVAL_MODE=world is implemented in Phase 10 (World ID step-up)');
}
