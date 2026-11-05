/**
 * GET /stream — Server-Sent Events for the authenticated user's trace events.
 * Auth is a Bearer header (the web uses @microsoft/fetch-event-source).
 * On connect: subscribe → replay the last 50 events → flush live events
 * (de-duplicated by id), so nothing emitted during the replay is lost.
 */
import { randomUUID } from 'node:crypto';
import type { OutgoingHttpHeaders } from 'node:http';
import { TRACE_REPLAY_LIMIT, type TraceEvent } from '@warden/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authOf, requireUser } from '../auth/require-user.js';

export const SSE_HEARTBEAT_MS = 15_000;
/** Presence window: "Agent online" is emitted when a user connects after this long away. */
export const PRESENCE_TTL_SECONDS = 600;

export function presenceKey(userId: string): string {
  return `presence:agent:${userId}`;
}

function formatSse(event: TraceEvent): string {
  return `id: ${event.id}\nevent: trace\ndata: ${JSON.stringify(event)}\n\n`;
}

export const traceRoutes: FastifyPluginAsyncZod = async (app) => {
  const openStreams = new Set<() => void>();

  // End open streams before the server stops accepting, so close() never hangs.
  app.addHook('preClose', async () => {
    for (const end of [...openStreams]) end();
  });

  app.get('/stream', { preHandler: requireUser }, async (request, reply) => {
    const { user } = authOf(request);
    const { traceBus, redis } = app.deps;

    reply.hijack();
    const res = reply.raw;
    const headers: OutgoingHttpHeaders = {
      ...(reply.getHeaders() as OutgoingHttpHeaders),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': request.id,
    };
    res.writeHead(200, headers);
    res.write('retry: 3000\n\n');

    const sent = new Set<string>();
    const buffered: TraceEvent[] = [];
    let replaying = true;
    let closed = false;

    const send = (event: TraceEvent): void => {
      if (closed || sent.has(event.id)) return;
      sent.add(event.id);
      if (sent.size > 2_000) sent.delete(sent.values().next().value as string);
      res.write(formatSse(event));
    };

    let unsubscribe: (() => Promise<void>) | null = null;
    let heartbeat: NodeJS.Timeout | null = null;

    const end = (): void => {
      if (closed) return;
      closed = true;
      openStreams.delete(end);
      if (heartbeat) clearInterval(heartbeat);
      void unsubscribe?.();
      if (!res.writableEnded) res.end();
    };
    openStreams.add(end);
    request.raw.on('close', end);
    res.on('error', end);

    try {
      unsubscribe = await app.deps.traceBus.subscribe(user.id, (event) => {
        if (replaying) buffered.push(event);
        else send(event);
      });
      if (closed) {
        await unsubscribe();
        return;
      }

      for (const event of await traceBus.recent(user.id, TRACE_REPLAY_LIMIT)) send(event);
      replaying = false;
      for (const event of buffered.splice(0)) send(event);

      heartbeat = setInterval(() => {
        if (closed) return;
        res.write(': heartbeat\n\n');
        void redis.expire(presenceKey(user.id), PRESENCE_TTL_SECONDS).catch(() => undefined);
      }, SSE_HEARTBEAT_MS);

      const firstConnect = await redis.set(
        presenceKey(user.id),
        '1',
        'EX',
        PRESENCE_TTL_SECONDS,
        'NX',
      );
      if (firstConnect === 'OK') {
        await traceBus.emit({
          kind: 'system',
          traceId: randomUUID(),
          userId: user.id,
          title: 'Agent online',
          detail: 'Your agent is connected and listening. Every step it takes will appear here.',
        });
      }
    } catch (err) {
      request.log.error({ err }, 'trace stream failed');
      end();
    }
  });
};
