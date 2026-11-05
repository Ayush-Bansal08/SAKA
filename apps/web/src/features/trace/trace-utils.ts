import type { TraceEvent } from '@warden/shared';

export const MAX_EVENTS = 200;

/** Merge incoming events into the list: de-duplicated by id, newest first, capped. */
export function mergeEvents(
  current: readonly TraceEvent[],
  incoming: readonly TraceEvent[],
  max = MAX_EVENTS,
): TraceEvent[] {
  if (incoming.length === 0) return current as TraceEvent[];
  const byId = new Map<string, TraceEvent>();
  for (const e of current) byId.set(e.id, e);
  let changed = false;
  for (const e of incoming) {
    if (!byId.has(e.id)) changed = true;
    byId.set(e.id, e);
  }
  if (!changed) return current as TraceEvent[];
  return [...byId.values()]
    .sort((a, b) => (a.ts === b.ts ? b.id.localeCompare(a.id) : b.ts.localeCompare(a.ts)))
    .slice(0, max);
}

/** Exponential backoff with jitter for SSE reconnects: 1s, 2s, 4s… capped at 30s. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + random() * 0.4));
}
