/**
 * Fastify app factory. `buildApp` is used by the HTTP entry (server.ts) and by
 * tests (fastify.inject / ephemeral listen). It owns and closes its connections.
 */
import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { PrismaClient } from '@prisma/client';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import type { Env } from './config/env.js';
import { AppError } from './lib/errors.js';
import { registerErrorHandling } from './lib/error-handler.js';
import { createPrisma, createRedis } from './lib/infra.js';
import { loggerOptions } from './lib/logger.js';
import type { IdentityProvider } from './modules/auth/identity-provider.js';
import { createIdentityProvider } from './modules/auth/providers.js';
import { authRoutes } from './modules/auth/routes.js';
import { SessionService } from './modules/auth/session-service.js';
import { healthRoutes } from './modules/health/routes.js';
import { TraceBus } from './modules/trace/trace-bus.js';
import { traceRoutes } from './modules/trace/routes.js';
import { userRoutes } from './modules/users/routes.js';

export interface AppDeps {
  env: Env;
  prisma: PrismaClient;
  redis: Redis;
  traceBus: TraceBus;
  sessions: SessionService;
  identity: IdentityProvider;
  log: FastifyBaseLogger;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export interface BuildAppOptions {
  env: Env;
  /** Use a shared Redis store for rate limits (multi-instance). Defaults to true outside tests. */
  redisRateLimit?: boolean;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { env } = options;
  // Fail before opening connections if the identity configuration is invalid.
  const identity = createIdentityProvider(env);

  const prisma = createPrisma(env.DATABASE_URL);
  const redis = createRedis(env.REDIS_URL, { name: 'api' });
  const sessions = new SessionService(prisma, env.SESSION_TTL_HOURS);

  const app = Fastify({
    logger: loggerOptions(env, 'api'),
    trustProxy: env.NODE_ENV === 'production',
    bodyLimit: 1_048_576,
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();

  const log = app.log;
  const traceBus = new TraceBus(prisma, redis, log.child({ module: 'trace' }));

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('deps', { env, prisma, redis, traceBus, sessions, identity, log });
  app.decorateRequest('auth', null);

  registerErrorHandling(app);

  await app.register(cors, {
    origin: env.WEB_URL,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'x-request-id', 'last-event-id'],
    exposedHeaders: ['x-request-id'],
    credentials: false,
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    ...((options.redisRateLimit ?? env.NODE_ENV !== 'test')
      ? { redis, nameSpace: 'ratelimit:' }
      : {}),
    errorResponseBuilder: (_req, context) =>
      new AppError(
        'RATE_LIMITED',
        context.statusCode,
        `Too many requests. Try again in ${context.after}.`,
      ),
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(traceRoutes);

  app.addHook('onClose', async () => {
    await traceBus.close();
    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
  });

  return app;
}
