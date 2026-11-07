/**
 * Approval routes (PHASE 05 §4). Owner only — another human gets 404, never a state change.
 *   GET  /approvals/pending          the human's open approvals (nav badge, inbox)
 *   GET  /approvals/:id              approval page data
 *   POST /approvals/:id/dev-approve  DEV provider only (never registered in production)
 *   POST /approvals/:id/passkey/options  challenge bound to this approval and plan hash
 *   POST /approvals/:id/passkey/verify   checks the signature, then approves
 *   POST /approvals/:id/deny         provider-independent, stays forever
 */
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  ActionIntentSchema,
  Decimal,
  PasskeyOptionsResponseSchema,
  PasskeyVerifyRequestSchema,
  type ApprovalView,
  type PendingApprovalsResponse,
} from '@warden/shared';
import { devProvidersAllowed } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { authOf, requireUser } from '../auth/require-user.js';
import { describeIntent } from '../agent/describe.js';
import { approvalView } from '../agent/plan-view.js';
import type { ResolveResult } from './service.js';

const Params = z.object({ id: z.string().min(1).max(100) });

function assertApproved(result: ResolveResult): void {
  if (!result.changed)
    throw new AppError('CONFLICT', 409, `This approval is already ${result.status.toLowerCase()}.`);
  if (result.status !== 'APPROVED')
    throw new AppError(
      'CONFLICT',
      409,
      result.status === 'EXPIRED'
        ? 'This approval expired — nothing was traded.'
        : 'Approval rejected.',
    );
}

export const approvalRoutes: FastifyPluginAsyncZod = async (app) => {
  const { prisma, approvals, approvalProvider, passkeys, env } = app.deps;
  const devApprove = approvalProvider.kind === 'dev' && devProvidersAllowed(env);

  const load = async (id: string, userId: string) => {
    const row = await prisma.approval.findFirst({
      where: { id, userId },
      include: { actionPlan: true },
    });
    if (!row) throw AppError.notFound('Approval not found.');
    return row;
  };
  const view = (row: Awaited<ReturnType<typeof load>>): ApprovalView => {
    const intent = ActionIntentSchema.safeParse(row.actionPlan.intent);
    return approvalView(
      row,
      intent.success ? describeIntent(intent.data) : 'Agent action',
      devApprove,
    );
  };

  app.get(
    '/approvals/pending',
    { preHandler: requireUser },
    async (request): Promise<PendingApprovalsResponse> => {
      const rows = await prisma.approval.findMany({
        where: {
          userId: authOf(request).user.id,
          status: 'PENDING',
          expiresAt: { gt: new Date() },
        },
        include: { actionPlan: { select: { intent: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return {
        approvals: rows.map((a) => {
          const intent = ActionIntentSchema.safeParse(a.actionPlan.intent);
          return {
            id: a.id,
            actionPlanId: a.actionPlanId,
            summary: intent.success ? describeIntent(intent.data) : 'Agent action',
            reason: a.reason,
            amountUsd: new Decimal(a.amountUsd.toString()).toFixed(2),
            expiresAt: a.expiresAt.toISOString(),
            providerKind: a.providerKind,
            channel: a.channel,
            createdAt: a.createdAt.toISOString(),
          };
        }),
        devApproveAvailable: devApprove,
      };
    },
  );

  app.get(
    '/approvals/:id',
    { preHandler: requireUser, schema: { params: Params } },
    async (request) => {
      return view(await load(request.params.id, authOf(request).user.id));
    },
  );

  app.post(
    '/approvals/:id/deny',
    { preHandler: requireUser, schema: { params: Params } },
    async (request) => {
      const row = await load(request.params.id, authOf(request).user.id);
      const result = await approvals.resolve(row.id, 'DENIED');
      if (!result.changed)
        throw new AppError(
          'CONFLICT',
          409,
          `This approval is already ${result.status.toLowerCase()}.`,
        );
      return view(await load(row.id, row.userId));
    },
  );

  if (devApprove && approvalProvider.kind === 'dev') {
    const dev = approvalProvider;
    app.post(
      '/approvals/:id/dev-approve',
      { preHandler: requireUser, schema: { params: Params } },
      async (request) => {
        const { user } = authOf(request);
        const row = await load(request.params.id, user.id);
        assertApproved(await dev.approve(row.id, user));
        return view(await load(row.id, user.id));
      },
    );
  }

  if (approvalProvider.kind === 'passkey') {
    /** The plan and approval must still agree: an edited plan needs a fresh approval. */
    const loadPending = async (id: string, userId: string) => {
      const row = await load(id, userId);
      if (row.status !== 'PENDING')
        throw new AppError(
          'CONFLICT',
          409,
          `This approval is already ${row.status.toLowerCase()}.`,
        );
      if (row.planHash !== row.actionPlan.planHash) {
        await approvals.resolve(row.id, 'REJECTED');
        throw new AppError('CONFLICT', 409, 'The plan changed — approve again.');
      }
      return row;
    };

    app.post(
      '/approvals/:id/passkey/options',
      {
        preHandler: requireUser,
        schema: { params: Params, response: { 200: PasskeyOptionsResponseSchema } },
      },
      async (request) => {
        const { user } = authOf(request);
        const row = await loadPending(request.params.id, user.id);
        return passkeys.approvalOptions(user, row);
      },
    );

    app.post(
      '/approvals/:id/passkey/verify',
      {
        preHandler: requireUser,
        schema: { params: Params, body: PasskeyVerifyRequestSchema },
      },
      async (request) => {
        const { user } = authOf(request);
        const row = await loadPending(request.params.id, user.id);
        const identity = await passkeys.verifyApproval(user, row, request.body);
        assertApproved(
          await approvals.resolve(row.id, 'APPROVED', { ...identity, providerKind: 'passkey' }),
        );
        return view(await load(row.id, user.id));
      },
    );
  }
};
