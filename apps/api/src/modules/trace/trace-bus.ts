/**
 * Trace bus: persists every TraceEvent (TraceEventRow) and publishes it on the
 * Redis channel `trace:<userId>` so any API instance can stream it over SSE.
 */
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, TraceEventRow } from '@prisma/client';
import {
  parseTraceEvent,
  traceChannel,
  type TraceEvent,
  type TraceEventInput,
} from '@warden/shared';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';

export type TraceListener = (event: TraceEvent) => void;

/** JSON-safe copy (bigint → decimal string) so payloads persist and serialize identically. */
function toJsonSafe(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}

export function rowToEvent(row: TraceEventRow): TraceEvent {
  return parseTraceEvent({
    id: row.id,
    traceId: row.traceId,
    userId: row.userId,
    ts: row.ts.toISOString(),
    kind: row.kind,
    title: row.title,
    ...(row.detail !== null ? { detail: row.detail } : {}),
    ...(row.data !== null ? { data: row.data } : {}),
    ...(row.zg !== null ? { zg: row.zg } : {}),
  });
}

export class TraceBus {
  private subscriber: Redis | null = null;
  private subscriberReady: Promise<Redis> | null = null;
  private readonly listeners = new Map<string, Set<TraceListener>>();
  private readonly channelReady = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly publisher: Redis,
    private readonly log: Pick<FastifyBaseLogger, 'warn'>,
  ) {}

  /** Validate, persist and publish an event. Returns the stored event. */
  async emit(input: TraceEventInput): Promise<TraceEvent> {
    const event = parseTraceEvent({
      ...input,
      id: input.id ?? randomUUID(),
      ts: input.ts ?? new Date().toISOString(),
      data: toJsonSafe(input.data),
    });
    await this.prisma.traceEventRow.create({
      data: {
        id: event.id,
        traceId: event.traceId,
        userId: event.userId,
        ts: new Date(event.ts),
        kind: event.kind,
        title: event.title,
        detail: event.detail ?? null,
        data: toJsonSafe(event.data),
        zg: toJsonSafe(event.zg),
      },
    });
    try {
      await this.publisher.publish(traceChannel(event.userId), JSON.stringify(event));
    } catch (err) {
      // Persisted already; clients will see it on their next replay.
      this.log.warn({ err, eventId: event.id }, 'trace publish failed');
    }
    return event;
  }

  /** Most recent events for a user, oldest first. */
  async recent(userId: string, limit: number): Promise<TraceEvent[]> {
    const rows = await this.prisma.traceEventRow.findMany({
      where: { userId },
      orderBy: [{ ts: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.reverse().map(rowToEvent);
  }

  /** Subscribe to a user's live events. Resolves once Redis has confirmed the subscription. */
  async subscribe(userId: string, listener: TraceListener): Promise<() => Promise<void>> {
    if (this.closed) throw new Error('TraceBus is closed');
    const channel = traceChannel(userId);
    const sub = await this.ensureSubscriber();
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      this.channelReady.set(
        channel,
        sub.subscribe(channel).then(() => undefined),
      );
    }
    set.add(listener);
    await this.channelReady.get(channel);

    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      const current = this.listeners.get(channel);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(channel);
        this.channelReady.delete(channel);
        if (!this.closed) await sub.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    if (this.subscriber) {
      const sub = this.subscriber;
      this.subscriber = null;
      this.subscriberReady = null;
      await sub.quit().catch(() => sub.disconnect());
    }
  }

  private ensureSubscriber(): Promise<Redis> {
    if (!this.subscriberReady) {
      const sub = this.publisher.duplicate({ connectionName: 'trace-subscriber' });
      sub.on('message', (channel: string, message: string) => this.dispatch(channel, message));
      sub.on('error', (err: Error) => this.log.warn({ err }, 'trace subscriber error'));
      this.subscriber = sub;
      this.subscriberReady = (async () => {
        if (sub.status !== 'ready') {
          await new Promise<void>((resolve, reject) => {
            sub.once('ready', () => resolve());
            sub.once('end', () => reject(new Error('Redis subscriber closed before ready')));
          });
        }
        return sub;
      })();
    }
    return this.subscriberReady;
  }

  private dispatch(channel: string, message: string): void {
    const set = this.listeners.get(channel);
    if (!set || set.size === 0) return;
    let event: TraceEvent;
    try {
      event = parseTraceEvent(JSON.parse(message));
    } catch (err) {
      this.log.warn({ err, channel }, 'dropping malformed trace message');
      return;
    }
    for (const listener of set) {
      try {
        listener(event);
      } catch (err) {
        this.log.warn({ err }, 'trace listener threw');
      }
    }
  }
}
