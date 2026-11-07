/**
 * Fastify app factory. `buildApp` is used by the HTTP entry (server.ts) and by
 * tests (fastify.inject / ephemeral listen). It owns and closes its connections.
 */
import { randomUUID } from 'node:crypto';
import { agentRoutes } from './modules/agent/routes.js';
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
import { PasskeyService } from './modules/auth/passkey-service.js';
import { createIdentityProvider } from './modules/auth/providers.js';
import type { PasskeyApprovalProvider } from './modules/approvals/passkey-approval-provider.js';
import { authRoutes } from './modules/auth/routes.js';
import { SessionService } from './modules/auth/session-service.js';
import { healthRoutes } from './modules/health/routes.js';
import { createUniswapMcpClient, type UniswapMcpClient } from './modules/mcp/client.js';
import { TraceBus } from './modules/trace/trace-bus.js';
import { traceRoutes } from './modules/trace/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { onboardingRoutes } from './modules/users/onboarding-routes.js';
import { settingsRoutes } from './modules/users/settings-routes.js';
import { BalanceReader, PriceService } from './modules/portfolio/market.js';
import { portfolioRoutes } from './modules/portfolio/routes.js';
import { createWalletProvider, type WalletProvider } from './modules/wallet/privy.js';
import { ZgClient } from './modules/ai0g/client.js';
import { ApprovalsService } from './modules/approvals/service.js';
import {
  createApprovalProvider,
  type DevApprovalProvider,
} from './modules/approvals/dev-approval-provider.js';
import { approvalRoutes } from './modules/approvals/routes.js';
import { planRoutes } from './modules/agent/plan-routes.js';
import { hookRoutes } from './modules/hooks/routes.js';
import { triggerRoutes } from './modules/triggers/routes.js';
import { createChainClient, type ChainClient } from './modules/execution/chain.js';
import { createBullJobs, type JobQueues } from './modules/execution/jobs.js';
import { modeBRoutes } from './modules/modeb/routes.js';
import { simulatorRoutes } from './modules/modeb/simulator/routes.js';
import { approvalResolved } from './modules/modeb/suggestions.js';
import { createNotifications, type Notifications } from './modules/telegram/notifications.js';
import { telegramRoutes } from './modules/telegram/routes.js';

export interface AppDeps {
  env: Env;
  prisma: PrismaClient;
  redis: Redis;
  traceBus: TraceBus;
  sessions: SessionService;
  identity: IdentityProvider;
  /** Uniswap agent MCP client (null when MCP_AUTH_TOKEN is not configured). */
  mcp: UniswapMcpClient | null;
  /** Privy agent wallets (null when PRIVY_APP_ID / PRIVY_APP_SECRET are not configured). */
  wallets: WalletProvider | null;
  /** Mainnet reference prices via MCP get_quote (PriceCache, 30 s). */
  prices: PriceService;
  /** Execution-chain balances via MCP get_portfolio (short Redis cache). */
  balances: BalanceReader;
  /** 0G Router client (null when ZG_API_KEY is not configured: the guard then fails closed). */
  zg: ZgClient | null;
  /** Execution-chain RPC reads (null without EXECUTION_RPC_URL: simulation fails closed). */
  chain: ChainClient | null;
  /** Producers for the execute / decisionlog queues (the worker consumes them). */
  jobs: JobQueues;
  /** Outgoing Telegram work (a no-op without a bot token). */
  notifications: Notifications;
  approvals: ApprovalsService;
  approvalProvider: DevApprovalProvider | PasskeyApprovalProvider;
  passkeys: PasskeyService;
  log: FastifyBaseLogger;
}

export interface BuildAppOverrides {
  /** Replace the Privy wallet provider (tests). */
  wallets?: WalletProvider | null;
  /** Replace the MCP client (tests). */
  mcp?: UniswapMcpClient | null;
  /** Replace the job producers (tests). */
  jobs?: JobQueues;
  /** Replace the execution-chain client (tests). */
  chain?: ChainClient | null;
  /** Replace the Telegram queue (tests). */
  notifications?: Notifications;
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
  overrides?: BuildAppOverrides;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { env } = options;
  const prisma = createPrisma(env.DATABASE_URL);
  const passkeys = new PasskeyService(prisma, env);
  // Fail before opening connections if the identity configuration is invalid.
  const identity = createIdentityProvider(env, passkeys);

  const redis = createRedis(env.REDIS_URL, { name: 'api' });
  const sessions = new SessionService(prisma, env.SESSION_TTL_HOURS);

  const app = Fastify({
    logger: loggerOptions(env, 'api'),
    trustProxy: env.NODE_ENV === 'production' || env.TRUST_PROXY,
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
  const mcp =
    options.overrides?.mcp !== undefined
      ? options.overrides.mcp
      : createUniswapMcpClient(env, { trace: traceBus, log: log.child({ module: 'mcp' }) });
  const wallets =
    options.overrides?.wallets !== undefined
      ? options.overrides.wallets
      : createWalletProvider(env, log.child({ module: 'privy' }));
  const prices = new PriceService(prisma, mcp, log.child({ module: 'prices' }));
  const balances = new BalanceReader(mcp, redis);
  const zg = env.ZG_API_KEY ? new ZgClient(env, prisma, traceBus) : null;
  const chain =
    options.overrides?.chain !== undefined
      ? options.overrides.chain
      : createChainClient(env.EXECUTION_CHAIN_ID, env.EXECUTION_RPC_URL);
  const jobs = options.overrides?.jobs ?? createBullJobs(env.REDIS_URL);
  const notifications = options.overrides?.notifications ?? createNotifications(env);
  const approvals = new ApprovalsService({
    prisma,
    trace: traceBus,
    jobs,
    ttlSeconds: env.APPROVAL_TTL_SECONDS,
    onResolved: (approval, outcome) =>
      approvalResolved({ prisma, notifications }, approval, outcome),
  });
  const approvalProvider = createApprovalProvider(env, approvals, (id) =>
    prisma.approval.findUnique({ where: { id }, select: { expiresAt: true } }),
  );

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('deps', {
    env,
    prisma,
    redis,
    traceBus,
    sessions,
    identity,
    mcp,
    wallets,
    prices,
    balances,
    zg,
    chain,
    jobs,
    notifications,
    approvals,
    approvalProvider,
    passkeys,
    log,
  });
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
  await app.register(onboardingRoutes);
  await app.register(portfolioRoutes);
  await app.register(settingsRoutes);
  await app.register(agentRoutes);
  await app.register(planRoutes);
  await app.register(approvalRoutes);
  await app.register(hookRoutes);
  await app.register(triggerRoutes);
  await app.register(modeBRoutes);
  if (env.ENABLE_DEMO_SIMULATOR) await app.register(simulatorRoutes);
  await app.register(telegramRoutes);

  app.addHook('onClose', async () => {
    await mcp?.close();
    await jobs.close();
    await notifications.close();
    await traceBus.close();
    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
  });

  return app;
}
