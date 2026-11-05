import { PrismaClient } from '@prisma/client';
import { Redis, type RedisOptions } from 'ioredis';

export function createPrisma(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

/**
 * Redis connection. `forBullMQ` sets maxRetriesPerRequest=null, which BullMQ
 * requires for blocking worker connections.
 */
export function createRedis(url: string, opts: { forBullMQ?: boolean; name?: string } = {}): Redis {
  const options: RedisOptions = {
    connectionName: opts.name,
    maxRetriesPerRequest: opts.forBullMQ ? null : 3,
    enableReadyCheck: true,
    lazyConnect: false,
  };
  return new Redis(url, options);
}

export async function pingDatabase(prisma: PrismaClient, timeoutMs = 2_000): Promise<boolean> {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

export async function pingRedis(redis: Redis, timeoutMs = 2_000): Promise<boolean> {
  try {
    return (await withTimeout(redis.ping(), timeoutMs)) === 'PONG';
  } catch {
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
