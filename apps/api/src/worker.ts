/** Background worker entry: BullMQ workers + repeatable schedules, including Mode B and Telegram. */
import './config/load-dotenv.js';
import { Queue, Worker } from 'bullmq';
import { Api } from 'grammy';
import { EnvError, loadEnv, type Env } from './config/env.js';
import { runBalanceWatch } from './jobs/balance-watcher.js';
import { runHeartbeat } from './jobs/heartbeat.js';
import {
  APPROVAL_SWEEP_EVERY_MS,
  HEARTBEAT_EVERY_MS,
  HOOK_INDEX_EVERY_MS,
  JOBS,
  MODEB_TICK_EVERY_MS,
  NOTIFY_MAX_PER_SECOND,
  QUEUES,
  TRIGGER_EVALUATE_EVERY_MS,
} from './jobs/queues.js';
import { ZgClient } from './modules/ai0g/client.js';
import { Explainer } from './modules/ai0g/explainer.js';
import { indexHooks } from './modules/hooks/indexer.js';
import { evaluateTriggers } from './modules/triggers/evaluator.js';
import { ApprovalsService } from './modules/approvals/service.js';
import { createApprovalProvider } from './modules/approvals/dev-approval-provider.js';
import { createChainClient } from './modules/execution/chain.js';
import { createBullJobs } from './modules/execution/jobs.js';
import {
  abandonPlan,
  executePlan,
  LockBusyError,
  PendingReceiptError,
  type ExecutorDeps,
} from './modules/execution/executor.js';
import { markDecisionLogFailed, uploadDecisionLog } from './modules/decisionlog/service.js';
import { createDecisionLogStorage } from './modules/decisionlog/storage.js';
import { createWalletProvider } from './modules/wallet/privy.js';
import { createPrisma, createRedis } from './lib/infra.js';
import { createLogger } from './lib/logger.js';
import { onShutdown } from './lib/shutdown.js';
import { createUniswapMcpClient } from './modules/mcp/client.js';
import { BalanceReader, PriceService } from './modules/portfolio/market.js';
import { runModeBTick } from './modules/modeb/runner.js';
import { approvalResolved, planSettled, type ModeBDeps } from './modules/modeb/suggestions.js';
import { deliver, type TelegramApi } from './modules/telegram/delivery.js';
import { createNotifications, type Notification } from './modules/telegram/notifications.js';
import { TraceBus } from './modules/trace/trace-bus.js';

function readEnvOrExit(): Env {
  try {
    return loadEnv();
  } catch (err) {
    if (err instanceof EnvError) {
      console.error(`\n[worker] Refusing to start.\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

const env = readEnvOrExit();
const log = createLogger(env, 'worker');
const prisma = createPrisma(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL, { name: 'worker' });
const bullConnection = createRedis(env.REDIS_URL, { forBullMQ: true, name: 'worker-bullmq' });
const traceBus = new TraceBus(prisma, redis, log.child({ module: 'trace' }));
const mcp = createUniswapMcpClient(env, { trace: traceBus, log: log.child({ module: 'mcp' }) });
const prices = new PriceService(prisma, mcp, log.child({ module: 'prices' }));
const balances = new BalanceReader(mcp, redis);

const systemQueue = new Queue(QUEUES.system, { connection: bullConnection });
await systemQueue.upsertJobScheduler(
  JOBS.heartbeat,
  { every: HEARTBEAT_EVERY_MS },
  { name: JOBS.heartbeat, opts: { removeOnComplete: 100, removeOnFail: 100 } },
);

await systemQueue.upsertJobScheduler(
  JOBS.approvalSweep,
  { every: APPROVAL_SWEEP_EVERY_MS },
  { name: JOBS.approvalSweep, opts: { removeOnComplete: 50, removeOnFail: 100 } },
);

// --- PHASE 05: approvals, execution, decision logs ------------------------------------------
const jobs = createBullJobs(env.REDIS_URL);
const notifications = createNotifications(env);
const approvals = new ApprovalsService({
  prisma,
  trace: traceBus,
  jobs,
  ttlSeconds: env.APPROVAL_TTL_SECONDS,
  onResolved: (approval, outcome) => approvalResolved({ prisma, notifications }, approval, outcome),
});
const approvalProvider = createApprovalProvider(env, approvals, (id) =>
  prisma.approval.findUnique({ where: { id }, select: { expiresAt: true } }),
);
const chain = createChainClient(env.EXECUTION_CHAIN_ID, env.EXECUTION_RPC_URL);
const wallets = createWalletProvider(env, log.child({ module: 'privy' }));
const storage = createDecisionLogStorage(env);
const decisionLogDeps = { prisma, storage, traceBus, env };

const systemWorker = new Worker(
  QUEUES.system,
  async (job) => {
    switch (job.name) {
      case JOBS.heartbeat:
        return runHeartbeat({ prisma, redis, log });
      case JOBS.approvalSweep:
        return { expired: await approvals.sweepExpired() };
      default:
        throw new Error(`Unknown system job: ${job.name}`);
    }
  },
  { connection: bullConnection, concurrency: 1 },
);

systemWorker.on('failed', (job, err) =>
  log.error({ err, jobId: job?.id, name: job?.name }, 'job failed'),
);
systemWorker.on('error', (err) => log.error({ err }, 'worker error'));

// --- PHASE 03: balance watcher (needs the Uniswap MCP server for get_portfolio) ---------------
const walletQueue = new Queue(QUEUES.wallet, { connection: bullConnection });
let walletWorker: Worker | null = null;
if (mcp) {
  await walletQueue.upsertJobScheduler(
    JOBS.balanceWatch,
    { every: env.BALANCE_POLL_MS },
    { name: JOBS.balanceWatch, opts: { removeOnComplete: 50, removeOnFail: 100 } },
  );
  walletWorker = new Worker(
    QUEUES.wallet,
    async (job) => {
      if (job.name !== JOBS.balanceWatch) throw new Error(`Unknown wallet job: ${job.name}`);
      const result = await runBalanceWatch({
        prisma,
        redis,
        balances,
        prices,
        trace: traceBus,
        chainId: env.EXECUTION_CHAIN_ID,
        allowlist: env.TOKEN_ALLOWLIST_JSON,
        inactivePollMs: env.BALANCE_POLL_INACTIVE_MS,
        notifications,
        log,
      });
      return { checked: result.checked, deposits: result.deposits };
    },
    // One tick at a time: a slow RPC must not stack overlapping passes.
    { connection: bullConnection, concurrency: 1 },
  );
  walletWorker.on('failed', (job, err) =>
    log.error({ err, jobId: job?.id, name: job?.name }, 'job failed'),
  );
  walletWorker.on('error', (err) => log.error({ err }, 'worker error'));
} else {
  await walletQueue.removeJobScheduler(JOBS.balanceWatch).catch(() => undefined);
  log.warn('MCP_AUTH_TOKEN is not set: the balance watcher is disabled (no deposit detection)');
}

let executeWorker: Worker | null = null;
if (mcp) {
  const executorDeps: ExecutorDeps = {
    env,
    prisma,
    redis,
    mcp,
    wallets,
    chain,
    traceBus,
    jobs,
    approvals,
    approvalProvider,
    onPlanSettled: (planId, outcome) => planSettled({ prisma, notifications }, planId, outcome),
  };
  executeWorker = new Worker(
    QUEUES.execute,
    async (job) => {
      if (job.name !== JOBS.execute) throw new Error(`Unknown execute job: ${job.name}`);
      return { outcome: await executePlan(executorDeps, String(job.data.planId)) };
    },
    // Different users run in parallel; one user's plans are serialised by lock:exec:<userId>.
    { connection: bullConnection, concurrency: 4, lockDuration: 5 * 60_000 },
  );
  executeWorker.on('failed', (job, err) => {
    if (!job) return;
    const retryable = err instanceof LockBusyError || err instanceof PendingReceiptError;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!retryable || exhausted) {
      log.error({ err: err.message, planId: job.data.planId }, 'execution job gave up');
      void abandonPlan(executorDeps, String(job.data.planId), err.message).catch((e: unknown) =>
        log.error({ err: e }, 'abandonPlan failed'),
      );
    }
  });
  executeWorker.on('error', (err) => log.error({ err }, 'worker error'));
} else {
  log.warn('MCP_AUTH_TOKEN is not set: execution is disabled');
}

const decisionLogWorker = new Worker(
  QUEUES.decisionLog,
  async (job) => {
    if (job.name !== JOBS.decisionLogUpload)
      throw new Error(`Unknown decision-log job: ${job.name}`);
    return { outcome: await uploadDecisionLog(decisionLogDeps, String(job.data.planId)) };
  },
  { connection: bullConnection, concurrency: 2 },
);
decisionLogWorker.on('failed', (job, err) => {
  if (!job) return;
  log.warn(
    { err: err.message, planId: job.data.planId, attempt: job.attemptsMade },
    '0G Storage upload failed',
  );
  if (job.attemptsMade >= (job.opts.attempts ?? 1))
    void markDecisionLogFailed(decisionLogDeps, String(job.data.planId), err.message).catch(
      () => undefined,
    );
});
decisionLogWorker.on('error', (err) => log.error({ err }, 'worker error'));
if (!storage)
  log.warn('ZG_STORAGE_PRIVATE_KEY is not set: decision logs stay PENDING (not uploaded)');

// --- PHASE 07: hook indexer + trigger evaluator -----------------------------------------------
const hooksQueue = new Queue(QUEUES.hooks, { connection: bullConnection });
const triggersQueue = new Queue(QUEUES.triggers, { connection: bullConnection });
const modebQueue = new Queue(QUEUES.modeb, { connection: bullConnection });
let hooksWorker: Worker | null = null;
let triggersWorker: Worker | null = null;
let modebWorker: Worker | null = null;
if (mcp) {
  // Pipeline inferences are traced to the user; indexer explanations have no user (no-op trace).
  const zg = env.ZG_API_KEY ? new ZgClient(env, prisma, traceBus) : null;
  const zgSystem = env.ZG_API_KEY
    ? new ZgClient(env, prisma, { emit: async () => undefined })
    : null;
  const explainer = zgSystem
    ? new Explainer(zgSystem, { userId: 'system', traceId: 'hook-indexer' })
    : null;
  await hooksQueue.upsertJobScheduler(
    JOBS.hookIndex,
    { every: HOOK_INDEX_EVERY_MS },
    { name: JOBS.hookIndex, opts: { removeOnComplete: 20, removeOnFail: 50 } },
  );
  hooksWorker = new Worker(
    QUEUES.hooks,
    async () => {
      const deps = {
        prisma,
        redis,
        mcp,
        explain: explainer
          ? (s: Parameters<Explainer['explainHookDetailed']>[0]) =>
              explainer.explainHookDetailed(s, { scope: 'hook explorer' })
          : null,
        traceBus,
        executionChainId: env.EXECUTION_CHAIN_ID,
        log: log.child({ module: 'hooks' }),
      };
      const market = await indexHooks(deps, 'market').catch((err: unknown) => ({
        error: err instanceof Error ? err.message : String(err),
      }));
      const execution = await indexHooks(deps, 'execution').catch((err: unknown) => ({
        error: err instanceof Error ? err.message : String(err),
      }));
      return { market, execution };
    },
    { connection: bullConnection, concurrency: 1, lockDuration: 10 * 60_000 },
  );
  hooksWorker.on('error', (err) => log.error({ err }, 'worker error'));

  await triggersQueue.upsertJobScheduler(
    JOBS.triggerEvaluate,
    { every: TRIGGER_EVALUATE_EVERY_MS },
    { name: JOBS.triggerEvaluate, opts: { removeOnComplete: 20, removeOnFail: 50 } },
  );
  triggersWorker = new Worker(
    QUEUES.triggers,
    async () =>
      evaluateTriggers({
        prisma,
        redis,
        prices,
        balances,
        traceBus,
        chainId: env.EXECUTION_CHAIN_ID,
        notifications,
        webUrl: env.WEB_URL,
        log: log.child({ module: 'triggers' }),
        pipeline: {
          env,
          prisma,
          mcp,
          prices,
          traceBus,
          zg,
          chain,
          approvals,
          approvalProvider,
          jobs,
        },
      }),
    // One evaluation at a time: rules fire at most once per window.
    { connection: bullConnection, concurrency: 1, lockDuration: 5 * 60_000 },
  );
  triggersWorker.on('error', (err) => log.error({ err }, 'worker error'));

  // --- PHASE 08: Mode B detectors ---------------------------------------------------------------
  const modeBDeps: ModeBDeps = {
    env,
    prisma,
    redis,
    mcp,
    prices,
    balances,
    traceBus,
    zg,
    chain,
    approvals,
    approvalProvider,
    jobs,
    notifications,
    log: log.child({ module: 'modeb' }),
  };
  await modebQueue.upsertJobScheduler(
    JOBS.modebTick,
    { every: MODEB_TICK_EVERY_MS },
    { name: JOBS.modebTick, opts: { removeOnComplete: 20, removeOnFail: 50 } },
  );
  modebWorker = new Worker(
    QUEUES.modeb,
    async () => runModeBTick(modeBDeps, { budgetMs: env.MODEB_TICK_BUDGET_MS }),
    // One pass at a time: a slow tick must not overlap the next one.
    { connection: bullConnection, concurrency: 1, lockDuration: 5 * 60_000 },
  );
  modebWorker.on('failed', (job, err) =>
    log.error({ err: err.message, jobId: job?.id }, 'Mode B tick failed'),
  );
  modebWorker.on('error', (err) => log.error({ err }, 'worker error'));
} else {
  await hooksQueue.removeJobScheduler(JOBS.hookIndex).catch(() => undefined);
  await triggersQueue.removeJobScheduler(JOBS.triggerEvaluate).catch(() => undefined);
  await modebQueue.removeJobScheduler(JOBS.modebTick).catch(() => undefined);
  log.warn('MCP_AUTH_TOKEN is not set: Mode B is disabled');
}

// --- PHASE 08: outgoing Telegram --------------------------------------------------------------
let notifyWorker: Worker | null = null;
if (env.TELEGRAM_BOT_TOKEN) {
  const telegram = new Api(env.TELEGRAM_BOT_TOKEN) as unknown as TelegramApi;
  notifyWorker = new Worker(
    QUEUES.notify,
    async (job) =>
      deliver(
        {
          prisma,
          api: telegram,
          secret: env.ENCRYPTION_KEY,
          webUrl: env.WEB_URL,
          chainId: env.EXECUTION_CHAIN_ID,
        },
        job.data as Notification,
      ),
    {
      connection: bullConnection,
      // One at a time: a 429 wait in delivery holds the whole queue, which is what Telegram wants.
      concurrency: 1,
      limiter: { max: NOTIFY_MAX_PER_SECOND, duration: 1_000 },
    },
  );
  notifyWorker.on('failed', (job, err) =>
    log.warn({ err: err.message, kind: job?.data?.kind }, 'telegram delivery failed'),
  );
  notifyWorker.on('error', (err) => log.error({ err }, 'worker error'));
} else {
  log.warn('TELEGRAM_BOT_TOKEN is not set: alerts stay in the web inbox');
}

// The scheduler runs the first heartbeat immediately, then every HEARTBEAT_EVERY_MS.
log.info(
  {
    queues: Object.values(QUEUES),
    heartbeatMs: HEARTBEAT_EVERY_MS,
    balancePollMs: mcp ? env.BALANCE_POLL_MS : null,
  },
  'worker ready',
);

onShutdown(log, async () => {
  await systemWorker.close();
  await walletWorker?.close();
  await executeWorker?.close();
  await decisionLogWorker.close();
  await hooksWorker?.close();
  await triggersWorker?.close();
  await modebWorker?.close();
  await notifyWorker?.close();
  await jobs.close();
  await notifications.close();
  await Promise.allSettled([
    systemQueue.close(),
    walletQueue.close(),
    hooksQueue.close(),
    triggersQueue.close(),
    modebQueue.close(),
  ]);
  await mcp?.close();
  await traceBus.close();
  await Promise.allSettled([prisma.$disconnect(), redis.quit(), bullConnection.quit()]);
});
