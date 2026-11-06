/**
 * Demo market simulator API. Registered only with ENABLE_DEMO_SIMULATOR on, so with the flag off
 * every path here is a plain 404. Owner only: another human's run answers 404.
 *   GET  /simulator/scenarios   the conditions on offer
 *   GET  /simulator/runs        this user's latest runs
 *   GET  /simulator/runs/:id    one run
 *   POST /simulator/runs        { scenarioId, mode } → 202; the run continues in the background
 */
import { SimulatorRunRequestSchema, type SimulatorRunView } from '@warden/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../../lib/errors.js';
import { authOf, requireUser } from '../../auth/require-user.js';
import { modeBDepsFrom } from '../routes.js';
import { listRuns, loadRun, runView, startRun } from './run.js';
import { SCENARIOS } from './scenarios/index.js';

const Params = z.object({ id: z.string().min(1).max(100) });

export const simulatorRoutes: FastifyPluginAsyncZod = async (app) => {
  const d = app.deps;
  const pending = new Set<Promise<void>>();
  // Before shutdown closes Redis and Prisma, which a run in flight still needs.
  app.addHook('preClose', async () => {
    await Promise.allSettled(pending);
  });

  app.get('/simulator/scenarios', { preHandler: requireUser }, async () => ({
    scenarios: Object.values(SCENARIOS).map(({ id, label, description }) => ({
      id,
      label,
      description,
    })),
  }));

  app.get('/simulator/runs', { preHandler: requireUser }, async (request) => ({
    runs: await listRuns(d, authOf(request).user.id),
  }));

  app.get(
    '/simulator/runs/:id',
    { preHandler: requireUser, schema: { params: Params } },
    async (request): Promise<SimulatorRunView> =>
      loadRun(d, authOf(request).user.id, request.params.id),
  );

  app.post(
    '/simulator/runs',
    { preHandler: requireUser, schema: { body: SimulatorRunRequestSchema } },
    async (request, reply) => {
      const deps = modeBDepsFrom(d);
      if (!deps)
        throw new AppError('SERVICE_UNAVAILABLE', 503, 'The Uniswap service is not configured.');
      const { run, work } = await startRun(deps, authOf(request).user.id, request.body);
      pending.add(work);
      void work.finally(() => pending.delete(work));
      return reply.code(202).send(await runView(d, run));
    },
  );
};
