/**
 * Plan routes (PHASE 05 §7). Owner only.
 *   GET  /plans/:id            everything for the detail views
 *   POST /plans/:id/cancel     stop an AUTO plan during its countdown (atomic: only while QUEUED)
 *   POST /plans/:id/repreview  fresh preview of the same intent after "Price moved" (new plan,
 *                              new planHash, new approval if needed — the old one stays closed)
 *   GET  /decision-logs/:planId payload + 0G Storage hashes
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ActionIntentSchema, Decimal, type DecisionLogView, type PlanView } from '@warden/shared';
import { devProvidersAllowed } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { authOf, requireUser } from '../auth/require-user.js';
import { buildPortfolio } from '../portfolio/service.js';
import { patchPlanCards, setPreviewStatus } from './card-store.js';
import { planView } from './plan-view.js';
import { runPipeline, type PipelineDeps } from './pipeline.js';
import { decisionLogExplorerUrl } from '../decisionlog/service.js';
import type { AppDeps } from '../../app.js';

const Params = z.object({ id: z.string().min(1).max(100) });
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

export function pipelineDepsFrom(d: AppDeps): PipelineDeps | null {
  if (!d.mcp) return null;
  return {
    env: d.env,
    prisma: d.prisma,
    mcp: d.mcp,
    prices: d.prices,
    traceBus: d.traceBus,
    zg: d.zg,
    chain: d.chain,
    approvals: d.approvals,
    approvalProvider: d.approvalProvider,
    jobs: d.jobs,
  };
}

export const planRoutes: FastifyPluginAsyncZod = async (app) => {
  const d = app.deps;
  const { prisma, env } = d;
  const devApprove = d.approvalProvider.kind === 'dev' && devProvidersAllowed(env);

  const loadPlan = async (id: string, userId: string) => {
    const plan = await prisma.actionPlan.findFirst({
      where: { id, userId },
      include: {
        approval: true,
        executions: { orderBy: { stepIndex: 'asc' } },
        decisionLog: true,
        agentRequest: true,
      },
    });
    if (!plan) throw AppError.notFound('Plan not found.');
    return plan;
  };

  app.get(
    '/plans/:id',
    { preHandler: requireUser, schema: { params: Params } },
    async (request): Promise<PlanView> => {
      const plan = await loadPlan(request.params.id, authOf(request).user.id);
      return planView(plan, {
        chainId: env.EXECUTION_CHAIN_ID,
        explorerBase: env.ZG_STORAGE_EXPLORER_URL,
        devApproveAvailable: devApprove,
      });
    },
  );

  app.post(
    '/plans/:id/cancel',
    { preHandler: requireUser, schema: { params: Params } },
    async (request) => {
      const plan = await loadPlan(request.params.id, authOf(request).user.id);
      const cancelled = await prisma.$transaction(async (tx) => {
        const res = await tx.actionPlan.updateMany({
          where: { id: plan.id, status: 'QUEUED' },
          data: { status: 'CANCELLED' },
        });
        if (res.count !== 1) return false;
        await tx.agentRequest.update({
          where: { id: plan.agentRequestId },
          data: { status: 'CANCELLED' },
        });
        return true;
      });
      if (!cancelled)
        throw new AppError(
          'CONFLICT',
          409,
          'Too late to cancel — your agent already started (or the plan is closed).',
        );
      await setPreviewStatus(prisma, plan.id, 'CANCELLED');
      await d.traceBus.emit({
        traceId: plan.agentRequest.traceId,
        userId: plan.userId,
        kind: 'policy',
        title: 'Cancelled by you',
        detail: 'Nothing was traded.',
        data: { actionPlanId: plan.id },
      });
      await d.jobs.enqueueDecisionLog(plan.id);
      return { id: plan.id, status: 'CANCELLED' as const };
    },
  );

  app.post(
    '/plans/:id/repreview',
    { preHandler: requireUser, schema: { params: Params } },
    async (request, reply) => {
      const { user } = authOf(request);
      const old = await loadPlan(request.params.id, user.id);
      if (!['CANCELLED', 'FAILED', 'EXPIRED'].includes(old.status))
        throw new AppError('CONFLICT', 409, 'This plan is still open — no re-preview needed.');
      const deps = pipelineDepsFrom(d);
      if (!deps)
        throw new AppError('SERVICE_UNAVAILABLE', 503, 'The Uniswap service is not configured.');
      const wallet = await prisma.agentWallet.findUnique({ where: { userId: user.id } });
      if (!wallet) throw new AppError('CONFLICT', 409, 'Create your agent wallet first.');
      const intent = ActionIntentSchema.parse(old.intent);
      const lockKey = `agent:planning:${user.id}`;
      const traceId = randomUUID();
      if (!(await d.redis.set(lockKey, traceId, 'EX', 120, 'NX')))
        throw new AppError('CONFLICT', 409, 'Your agent is still planning. Please wait.');
      try {
        const agentRequest = await prisma.agentRequest.create({
          data: {
            userId: user.id,
            channel: 'WEB',
            input: json({
              repreviewOf: old.id,
              text: (old.agentRequest.input as { text?: string })?.text ?? null,
            }),
            traceId,
            status: 'PLANNING',
          },
        });
        const ctx = { userId: user.id, traceId, agentRequestId: agentRequest.id };
        await d.traceBus.emit({
          ...ctx,
          kind: 'plan',
          title: 'Fresh preview',
          detail: 'Same request, new quote.',
        });
        const portfolio = await buildPortfolio(
          {
            prisma,
            prices: d.prices,
            balances: d.balances,
            chainId: env.EXECUTION_CHAIN_ID,
            allowlist: env.TOKEN_ALLOWLIST_JSON,
          },
          user,
          wallet,
        ).catch(() => null);
        const result = await runPipeline(deps, {
          ctx,
          user,
          wallet,
          intent,
          origin: 'user',
          channel: 'WEB',
          portfolioUsd: portfolio ? new Decimal(portfolio.totalUsd) : null,
        });
        await prisma.chatMessage.create({
          data: {
            userId: user.id,
            role: 'AGENT',
            text: result.text,
            cards: json(result.cards),
            traceId,
            requestId: agentRequest.id,
          },
        });
        await patchPlanCards(prisma, old.id, (c) =>
          c.type === 'price_moved' ? { ...c, repreviewed: true } : null,
        );
        await result.afterReply();
        return reply.code(201).send({ planId: result.planId, outcome: result.outcome, traceId });
      } finally {
        await d.redis.eval(
          "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
          1,
          lockKey,
          traceId,
        );
      }
    },
  );

  app.get(
    '/decision-logs/:planId',
    {
      preHandler: requireUser,
      schema: { params: z.object({ planId: z.string().min(1).max(100) }) },
    },
    async (request): Promise<DecisionLogView> => {
      const plan = await prisma.actionPlan.findFirst({
        where: { id: request.params.planId, userId: authOf(request).user.id },
        include: { decisionLog: true },
      });
      if (!plan?.decisionLog) throw AppError.notFound('No decision log for this plan yet.');
      const log = plan.decisionLog;
      return {
        actionPlanId: plan.id,
        status: log.status,
        payloadHash: log.payloadHash,
        rootHash: log.zgRootHash,
        txHash: log.zgTxHash,
        explorerUrl: decisionLogExplorerUrl(env.ZG_STORAGE_EXPLORER_URL, log.zgTxHash) ?? null,
        attempts: log.attempts,
        payload: log.payload,
      };
    },
  );
};
