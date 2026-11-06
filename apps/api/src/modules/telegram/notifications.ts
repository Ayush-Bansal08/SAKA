/**
 * Outgoing Telegram work. API, worker and bot only enqueue; the worker sends, so every message
 * passes one rate limiter (Telegram allows about 30 messages per second per bot).
 * Without a bot token this is a no-op: alerts stay in the web inbox.
 */
import { Queue } from 'bullmq';
import type { Env } from '../../config/env.js';
import { JOBS, QUEUES } from '../../jobs/queues.js';
import { createRedis } from '../../lib/infra.js';

export type Notification =
  /** A new suggestion: the alert with its buttons. */
  | { kind: 'suggestion'; suggestionId: string }
  /** A suggestion moved on: edit its message to show the result. */
  | { kind: 'outcome'; suggestionId: string; link?: { label: string; url: string } }
  /** A rule's plan ended: send the receipt. */
  | { kind: 'receipt'; planId: string }
  /** A one-off notice (first deposit, rule needs approval, rule stopped). */
  | {
      kind: 'text';
      userId: string;
      title: string;
      body: string;
      link?: { label: string; url: string };
    };

export interface Notifications {
  enqueue(n: Notification): Promise<void>;
  close(): Promise<void>;
}

export const NOOP_NOTIFICATIONS: Notifications = {
  enqueue: async () => undefined,
  close: async () => undefined,
};

export const NOTIFY_ATTEMPTS = 5;

export function createNotifications(
  env: Pick<Env, 'REDIS_URL' | 'TELEGRAM_BOT_TOKEN'>,
): Notifications {
  if (!env.TELEGRAM_BOT_TOKEN) return NOOP_NOTIFICATIONS;
  const connection = createRedis(env.REDIS_URL, { forBullMQ: true, name: 'notify-producer' });
  const queue = new Queue(QUEUES.notify, { connection });
  return {
    async enqueue(n) {
      await queue.add(JOBS.notify, n, {
        // One alert per suggestion, however often it is re-enqueued.
        ...(n.kind === 'suggestion' ? { jobId: `tg-suggestion-${n.suggestionId}` } : {}),
        attempts: NOTIFY_ATTEMPTS,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: 500,
        removeOnFail: 500,
      });
    },
    async close() {
      await queue.close().catch(() => undefined);
      await connection.quit().catch(() => connection.disconnect());
    },
  };
}
