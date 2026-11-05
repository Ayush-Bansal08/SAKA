/** Background worker entry: BullMQ workers + repeatable schedules (Mode B lands in later phases). */
import './config/load-dotenv.js';
import { Queue, Worker } from 'bullmq';
import { EnvError, loadEnv, type Env } from './config/env.js';
import { runHeartbeat } from './jobs/heartbeat.js';
import { HEARTBEAT_EVERY_MS, JOBS, QUEUES } from './jobs/queues.js';
import { createPrisma, createRedis } from './lib/infra.js';
import { createLogger } from './lib/logger.js';
import { onShutdown } from './lib/shutdown.js';

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

// The scheduler runs the first heartbeat immediately, then every HEARTBEAT_EVERY_MS.
log.info({ queues: Object.values(QUEUES), heartbeatMs: HEARTBEAT_EVERY_MS }, 'worker ready');

onShutdown(log, async () => {
  await systemWorker.close();
  await systemQueue.close();
  await Promise.allSettled([prisma.$disconnect(), redis.quit(), bullConnection.quit()]);
});
