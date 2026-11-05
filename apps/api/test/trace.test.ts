import { randomUUID } from 'node:crypto';
import type { TraceEvent } from '@warden/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { presenceKey } from '../src/modules/trace/routes.js';
import { createTestApp, devSignIn, uniqueName } from './helpers.js';

let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  app = await createTestApp();
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
});

/** Minimal SSE reader: collects `event: trace` payloads until `until` matches or timeout. */
async function openStream(token: string) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/stream`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const events: TraceEvent[] = [];
  const waiters: Array<() => void> = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const data = chunk
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n');
          if (data && chunk.includes('event: trace')) {
            events.push(JSON.parse(data) as TraceEvent);
            waiters.splice(0).forEach((w) => w());
          }
        }
      }
    } catch {
      // aborted
    }
  })();

  async function waitFor(pred: (e: TraceEvent) => boolean, timeoutMs = 5_000): Promise<TraceEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = events.find(pred);
      if (found) return found;
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(`timed out; got: ${events.map((e) => e.title).join(', ')}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, remaining);
        waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  return { res, events, waitFor, close: () => controller.abort() };
}

describe('GET /stream (SSE)', () => {
  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/stream`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  it('announces "Agent online" on first connect and delivers emitted events live', async () => {
    const { token, user } = await devSignIn(app, uniqueName('alice'));
    const stream = await openStream(token);
    try {
      expect(stream.res.status).toBe(200);
      expect(stream.res.headers.get('content-type')).toMatch(/text\/event-stream/);

      const online = await stream.waitFor((e) => e.title === 'Agent online');
      expect(online).toMatchObject({ kind: 'system', userId: user.id });

      const traceId = randomUUID();
      await app.deps.traceBus.emit({
        kind: 'plan',
        traceId,
        userId: user.id,
        title: 'Planning your swap',
        data: { amountRaw: 20_000_000n },
        zg: {
          requestId: 'req_123',
          clientRequestId: randomUUID(),
          model: 'glm-5.3',
          trustMode: 'private',
        },
      });
      const live = await stream.waitFor((e) => e.traceId === traceId);
      expect(live.kind).toBe('plan');
      expect(live.data).toEqual({ amountRaw: '20000000' });
      expect(live.zg?.requestId).toBe('req_123');

      const persisted = await app.deps.prisma.traceEventRow.findUnique({ where: { id: live.id } });
      expect(persisted?.title).toBe('Planning your swap');
    } finally {
      stream.close();
    }
  });

  it('replays recent events on reconnect without re-announcing', async () => {
    const { token, user } = await devSignIn(app, uniqueName('bob'));
    const first = await openStream(token);
    await first.waitFor((e) => e.title === 'Agent online');
    first.close();

    await app.deps.traceBus.emit({
      kind: 'log',
      traceId: randomUUID(),
      userId: user.id,
      title: 'Emitted while away',
    });

    const second = await openStream(token);
    try {
      await second.waitFor((e) => e.title === 'Emitted while away');
      const titles = second.events.map((e) => e.title);
      expect(titles.filter((t) => t === 'Agent online')).toHaveLength(1); // replayed, not re-emitted
      expect(await app.deps.redis.exists(presenceKey(user.id))).toBe(1);
    } finally {
      second.close();
    }
  });

  it('never leaks events across users', async () => {
    const alice = await devSignIn(app, uniqueName('alice'));
    const bob = await devSignIn(app, uniqueName('bob'));
    const stream = await openStream(alice.token);
    try {
      await stream.waitFor((e) => e.title === 'Agent online');
      await app.deps.traceBus.emit({
        kind: 'log',
        traceId: randomUUID(),
        userId: bob.user.id,
        title: 'Bob only',
      });
      const marker = randomUUID();
      await app.deps.traceBus.emit({
        kind: 'log',
        traceId: marker,
        userId: alice.user.id,
        title: 'Alice only',
      });
      await stream.waitFor((e) => e.traceId === marker);
      expect(stream.events.some((e) => e.title === 'Bob only')).toBe(false);
      expect(stream.events.every((e) => e.userId === alice.user.id)).toBe(true);
    } finally {
      stream.close();
    }
  });
});
