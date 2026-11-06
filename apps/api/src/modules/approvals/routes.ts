/**
 * Approval routes (PHASE 05 §4). Owner only — another human gets 404, never a state change.
 *   GET  /approvals/pending          the human's open approvals (nav badge, inbox)
 *   GET  /approvals/:id              approval page data
 *   POST /approvals/:id/dev-approve  DEV provider only (never registered in production)
 *   POST /approvals/:id/deny         provider-independent, stays forever
 */
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  ActionIntentSchema,
  Decimal,
  type ApprovalView,
  type PendingApprovalsResponse,
} from '@warden/shared';
import { devProvidersAllowed } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { authOf, requireUser } from '../auth/require-user.js';
import { describeIntent } from '../agent/describe.js';
import { approvalView } from '../agent/plan-view.js';

const Params = z.object({ id: z.string().min(1).max(100) });

export const approvalRoutes: FastifyPluginAsyncZod = async (app) => {
  const { prisma, approvals, approvalProvider, env } = app.deps;
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

  if (devApprove) {
    app.post(
      '/approvals/:id/dev-approve',
      { preHandler: requireUser, schema: { params: Params } },
      async (request) => {
        const { user } = authOf(request);
        const row = await load(request.params.id, user.id);
        const result = await approvalProvider.approve(row.id, user);
        if (!result.changed)
          throw new AppError(
            'CONFLICT',
            409,
            `This approval is already ${result.status.toLowerCase()}.`,
          );
        if (result.status !== 'APPROVED')
          throw new AppError(
            'CONFLICT',
            409,
            result.status === 'EXPIRED'
              ? 'This approval expired — nothing was traded.'
              : 'Approval rejected.',
          );
        return view(await load(row.id, user.id));
      },
    );
  }
};
