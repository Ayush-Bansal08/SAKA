/**
 * Job producers for the execution pipeline. The API enqueues; the worker (src/worker.ts) runs.
 *   execute            one job per plan (jobId `exec-<planId>`, never two for the same plan)
 *   decisionlog.upload one job per plan (jobId `dlog-<planId>`, 5 attempts, exponential backoff)
 * Tests swap this for an in-memory recorder.
 */
import { Queue } from 'bullmq';
import { createRedis } from '../../lib/infra.js';
import { JOBS, QUEUES } from '../../jobs/queues.js';

export interface JobQueues {
  enqueueExecution(planId: string, opts?: { delayMs?: number }): Promise<void>;
  enqueueDecisionLog(planId: string): Promise<void>;
  close(): Promise<void>;
}

/** Re-runs of a job for a plan that is still locked by a sibling (per-user lock) wait this long. */
export const EXECUTION_LOCK_RETRY_MS = 2_000;
export const EXECUTION_ATTEMPTS = 30;
export const DECISION_LOG_ATTEMPTS = 5;

export const executionJobId = (planId: string) => `exec-${planId}`;
export const decisionLogJobId = (planId: string) => `dlog-${planId}`;

export function createBullJobs(redisUrl: string): JobQueues {
  const connection = createRedis(redisUrl, { forBullMQ: true, name: 'jobs-producer' });
  const execute = new Queue(QUEUES.execute, { connection });
  const decisionLog = new Queue(QUEUES.decisionLog, { connection });
  return {
    async enqueueExecution(planId, opts = {}) {
      await execute.add(
        JOBS.execute,
        { planId },
        {
          jobId: executionJobId(planId),
          delay: opts.delayMs ?? 0,
          attempts: EXECUTION_ATTEMPTS,
          backoff: { type: 'fixed', delay: EXECUTION_LOCK_RETRY_MS },
          removeOnComplete: 500,
          removeOnFail: 500,
        },
      );
    },
    async enqueueDecisionLog(planId) {
      await decisionLog.add(
        JOBS.decisionLogUpload,
        { planId },
        {
          jobId: decisionLogJobId(planId),
          attempts: DECISION_LOG_ATTEMPTS,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: 500,
          removeOnFail: 500,
        },
      );
    },
    async close() {
      await Promise.allSettled([execute.close(), decisionLog.close()]);
      await connection.quit().catch(() => connection.disconnect());
    },
  };
}
