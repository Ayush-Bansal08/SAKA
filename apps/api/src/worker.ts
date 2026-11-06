/** Background worker entry: BullMQ workers + repeatable schedules (Mode B lands in later phases). */
import './config/load-dotenv.js';
import { Queue, Worker } from 'bullmq';
import { EnvError, loadEnv, type Env } from './config/env.js';
import { runBalanceWatch } from './jobs/balance-watcher.js';
import { runHeartbeat } from './jobs/heartbeat.js';
import { HEARTBEAT_EVERY_MS, JOBS, QUEUES } from './jobs/queues.js';
import { createPrisma, createRedis } from './lib/infra.js';
import { createLogger } from './lib/logger.js';
import { onShutdown } from './lib/shutdown.js';
import { createUniswapMcpClient } from './modules/mcp/client.js';
import { BalanceReader, PriceService } from './modules/portfolio/market.js';
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

const systemWorker = new Worker(
  QUEUES.system,
  async (job) => {
    switch (job.name) {
      case JOBS.heartbeat:
        return runHeartbeat({ prisma, redis, log });
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
  await Promise.allSettled([systemQueue.close(), walletQueue.close()]);
  await mcp?.close();
  await traceBus.close();
  await Promise.allSettled([prisma.$disconnect(), redis.quit(), bullConnection.quit()]);
});
