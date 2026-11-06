/**
 * Mode B API (PHASE 08). Owner only: another human's suggestion answers 404.
 *   GET  /suggestions               inbox: pinned brief, list, open count
 *   POST /suggestions/:id/accept    "Yes"
 *   POST /suggestions/:id/decline   "No"
 *   POST /suggestions/:id/change    "Change": closes the plan, returns the chat text
 *   POST /admin/simulate-event      { userId, detector, overrides? } — x-admin-token
 *   POST /admin/run-brief           { userId } — x-admin-token
 */
import {
  RunBriefRequestSchema,
  SimulateEventRequestSchema,
  type SuggestionActionResponse,
  type SuggestionsResponse,
  type SuggestionView,
} from '@warden/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { AppError } from '../../lib/errors.js';
import { pipelineDepsFrom } from '../agent/plan-routes.js';
import { authOf, requireUser } from '../auth/require-user.js';
import { requireAdmin } from '../triggers/routes.js';
import { runBriefNow } from './runner.js';
import { simulateEvent } from './simulate.js';
import {
  acceptSuggestion,
  changeSuggestion,
  declineSuggestion,
  listSuggestions,
  loadSuggestionView,
  type ModeBDeps,
} from './suggestions.js';

const Params = z.object({ id: z.string().min(1).max(100) });

export function modeBDepsFrom(d: AppDeps): ModeBDeps | null {
  const pipeline = pipelineDepsFrom(d);
  if (!pipeline) return null;
  return {
    ...pipeline,
    redis: d.redis,
    prices: d.prices,
    balances: d.balances,
    notifications: d.notifications,
    log: d.log,
  };
}

export const modeBRoutes: FastifyPluginAsyncZod = async (app) => {
  const d = app.deps;
  const { prisma, env } = d;
  const chainId = env.EXECUTION_CHAIN_ID;
  const live = (): ModeBDeps => {
    const deps = modeBDepsFrom(d);
    if (!deps)
      throw new AppError('SERVICE_UNAVAILABLE', 503, 'The Uniswap service is not configured.');
    return deps;
  };

  app.get(
    '/suggestions',
    { preHandler: requireUser },
    async (request): Promise<SuggestionsResponse> =>
      listSuggestions(prisma, chainId, authOf(request).user.id, new Date()),
  );

  app.post(
    '/suggestions/:id/accept',
    { preHandler: requireUser, schema: { params: Params } },
    async (request): Promise<SuggestionActionResponse> =>
      acceptSuggestion(live(), request.params.id, authOf(request).user.id),
  );

  app.post(
    '/suggestions/:id/decline',
    { preHandler: requireUser, schema: { params: Params } },
    async (request): Promise<SuggestionActionResponse> =>
      declineSuggestion(live(), request.params.id, authOf(request).user.id),
  );

  app.post(
    '/suggestions/:id/change',
    { preHandler: requireUser, schema: { params: Params } },
    async (request): Promise<SuggestionActionResponse> =>
      changeSuggestion(live(), request.params.id, authOf(request).user.id),
  );

  const admin = requireAdmin(env.ADMIN_TOKEN);
  app.post(
    '/admin/simulate-event',
    { preHandler: admin, schema: { body: SimulateEventRequestSchema } },
    async (request): Promise<SuggestionView> => {
      const { userId, detector, overrides } = request.body;
      request.log.warn({ userId, detector }, 'demo event simulated');
      const result = await simulateEvent(live(), { userId, detector, overrides });
      return loadSuggestionView(prisma, chainId, result.suggestionId);
    },
  );

  app.post(
    '/admin/run-brief',
    { preHandler: admin, schema: { body: RunBriefRequestSchema } },
    async (request): Promise<SuggestionView> => {
      const result = await runBriefNow(live(), request.body.userId);
      if (!result) throw AppError.notFound('That user has no agent wallet.');
      return loadSuggestionView(prisma, chainId, result.suggestionId);
    },
  );
};
