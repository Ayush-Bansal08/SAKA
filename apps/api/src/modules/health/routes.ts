import { HealthResponseSchema } from '@warden/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { pingDatabase, pingRedis } from '../../lib/infra.js';
import { APP_VERSION } from '../../version.js';

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    {
      config: { rateLimit: false },
      schema: { response: { 200: HealthResponseSchema, 503: HealthResponseSchema } },
    },
    async (_request, reply) => {
      const [db, redis] = await Promise.all([
        pingDatabase(app.deps.prisma),
        pingRedis(app.deps.redis),
      ]);
      const ok = db && redis;
      return reply.code(ok ? 200 : 503).send({
        status: ok ? 'ok' : 'degraded',
        version: APP_VERSION,
        uptimeSeconds: Math.round(process.uptime()),
        checks: { database: db ? 'up' : 'down', redis: redis ? 'up' : 'down' },
      });
    },
  );
};
