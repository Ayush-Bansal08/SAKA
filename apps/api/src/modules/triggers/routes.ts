/**
 * Rules API (PHASE 07 §4).
 *   GET  /triggers                       the human's rules, newest first
 *   POST /triggers/:id/cancel            owner only; ACTIVE → CANCELLED
 *   GET  /price-overrides                active demo overrides (header chip)
 *   POST /admin/price-override           { symbol, priceUsd, ttlSec } — x-admin-token
 *   DELETE /admin/price-override/:symbol x-admin-token
 * The override affects ONLY trigger / detector reference prices, never execution quotes.
 */
import { timingSafeEqual } from 'node:crypto';
import {
  PriceOverrideSchema,
  type PriceOverridesResponse,
  type TriggersResponse,
  type TriggerView,
} from '@warden/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { authOf, requireUser } from '../auth/require-user.js';
import {
  cancelTrigger,
  clearPriceOverride,
  listPriceOverrides,
  setPriceOverride,
  triggerView,
} from './service.js';

export function requireAdmin(token: string) {
  const expected = Buffer.from(token);
  return async (request: FastifyRequest) => {
    const header = request.headers['x-admin-token'];
    const given = Buffer.from(typeof header === 'string' ? header : '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw new AppError('UNAUTHORIZED', 401, 'Admin token required.');
  };
}

export const triggerRoutes: FastifyPluginAsyncZod = async (app) => {
  const { prisma, redis, env, traceBus } = app.deps;

  app.get('/triggers', { preHandler: requireUser }, async (request): Promise<TriggersResponse> => {
    const rows = await prisma.trigger.findMany({
      where: { userId: authOf(request).user.id },
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
    });
    // Active first, then the rest by recency.
    const order = { ACTIVE: 0, FIRED: 1, FAILED: 2, CANCELLED: 3 } as const;
    // lastResult is written when a rule fires; show how its latest plan actually ended.
    const settled = await Promise.all(
      rows.map(async (t) => {
        if (!t.fireCount || t.kind === 'CHAINED') return null;
        const req = await prisma.agentRequest.findFirst({
          where: {
            userId: t.userId,
            channel: 'TRIGGER',
            input: { path: ['event', 'triggerId'], equals: t.id },
          },
          orderBy: { createdAt: 'desc' },
          select: { actionPlans: { select: { status: true }, take: 1 } },
        });
        return req?.actionPlans[0]?.status ?? null;
      }),
    );
    const LABEL: Partial<Record<string, string>> = {
      EXECUTED: 'Executed ✓',
      AWAITING_APPROVAL: 'Waiting for your approval',
      FAILED: 'Execution failed',
      CANCELLED: 'Nothing was traded',
      EXPIRED: 'Approval expired — nothing was traded',
    };
    return {
      triggers: rows
        .map((t, i) => {
          const view = triggerView(t);
          const label = settled[i] ? LABEL[settled[i]!] : undefined;
          return label ? { ...view, lastResult: label } : view;
        })
        .sort((a, b) => order[a.status] - order[b.status]),
    };
  });

  app.post(
    '/triggers/:id/cancel',
    { preHandler: requireUser, schema: { params: z.object({ id: z.string().min(1).max(100) }) } },
    async (request): Promise<TriggerView> => {
      const { user } = authOf(request);
      const ok = await cancelTrigger(prisma, user.id, request.params.id);
      const row = await prisma.trigger.findFirst({
        where: { id: request.params.id, userId: user.id },
      });
      if (!row) throw AppError.notFound('Rule not found.');
      if (!ok)
        throw new AppError('CONFLICT', 409, `This rule is already ${row.status.toLowerCase()}.`);
      await traceBus.emit({
        traceId: `rule-${row.id}`,
        userId: user.id,
        kind: 'policy',
        title: 'Rule cancelled by you',
        detail: row.summary,
        data: { triggerId: row.id },
      });
      return triggerView(row);
    },
  );

  app.get(
    '/price-overrides',
    { preHandler: requireUser },
    async (): Promise<PriceOverridesResponse> => listPriceOverrides(redis),
  );

  const admin = requireAdmin(env.ADMIN_TOKEN);
  app.post(
    '/admin/price-override',
    { preHandler: admin, schema: { body: PriceOverrideSchema } },
    async (request) => {
      const set = await setPriceOverride(redis, request.body, new Date());
      request.log.warn({ symbol: set.symbol, priceUsd: set.priceUsd }, 'demo price override set');
      return set;
    },
  );
  app.delete(
    '/admin/price-override/:symbol',
    { preHandler: admin, schema: { params: z.object({ symbol: z.string().min(1).max(20) }) } },
    async (request) => {
      await clearPriceOverride(redis, request.params.symbol);
      return { ok: true as const };
    },
  );
};
