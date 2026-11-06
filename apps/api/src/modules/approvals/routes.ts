/**
 * Approval routes (PHASE 05 §4). Owner only — another human gets 404, never a state change.
 *   GET  /approvals/:id              approval page data
 *   POST /approvals/:id/dev-approve  DEV provider only (never registered in production)
 *   POST /approvals/:id/deny         provider-independent, stays forever
 */
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ActionIntentSchema, type ApprovalView } from '@warden/shared';
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
