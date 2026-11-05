import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { pingDatabase, pingRedis } from '../lib/infra.js';

export interface HeartbeatResult {
  database: boolean;
  redis: boolean;
  at: string;
}

/**
 * Proves the worker is alive and can reach its dependencies. Logs only; emits
 * nothing user-facing. Records the last beat in Redis for ops visibility.
 */
export async function runHeartbeat(deps: {
  prisma: PrismaClient;
  redis: Redis;
  log: Pick<Logger, 'info' | 'warn'>;
}): Promise<HeartbeatResult> {
  const [database, redis] = await Promise.all([pingDatabase(deps.prisma), pingRedis(deps.redis)]);
  const result: HeartbeatResult = { database, redis, at: new Date().toISOString() };
  if (database && redis) deps.log.info(result, 'worker heartbeat');
  else deps.log.warn(result, 'worker heartbeat: dependency down');
  if (redis) await deps.redis.set('worker:heartbeat', result.at, 'EX', 300);
  return result;
}
