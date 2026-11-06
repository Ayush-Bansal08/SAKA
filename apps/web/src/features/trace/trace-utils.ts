import type { TraceEvent } from '@warden/shared';

export const MAX_EVENTS = 600;

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

// --- Runs (PHASE 06 §3): events grouped by traceId ---------------------------------------------

export type ActivityFilter = 'all' | 'zg' | 'uniswap' | 'safety' | 'human' | 'chain';

export const ACTIVITY_FILTERS: { id: ActivityFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'zg', label: '0G' },
  { id: 'uniswap', label: 'Uniswap' },
  { id: 'safety', label: 'Safety' },
  { id: 'human', label: 'Human' },
  { id: 'chain', label: 'Chain' },
];

/** Which filter chips an event belongs to. */
export function eventMatches(e: TraceEvent, filter: ActivityFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'zg':
      return Boolean(e.zg) || e.kind === 'guard' || /0G/.test(e.title);
    case 'uniswap':
      return e.kind === 'tool_call' || e.kind === 'tool_result';
    case 'safety':
      return (
        e.kind === 'score' || e.kind === 'simulation' || e.kind === 'guard' || e.kind === 'policy'
      );
    case 'human':
      return e.kind === 'approval';
    case 'chain':
      return e.kind === 'tx' || e.kind === 'receipt' || e.kind === 'log';
  }
}

export type RunStatus =
  'running' | 'done' | 'needs_you' | 'refused' | 'failed' | 'cancelled' | 'info';

export interface Run {
  traceId: string;
  /** Oldest first. */
  events: TraceEvent[];
  startedAt: string;
  endedAt: string;
  status: RunStatus;
  /** Short label of what the run is about. */
  title: string;
}

/** Status of a run from its events (latest decisive event wins). */
export function runStatus(events: readonly TraceEvent[]): RunStatus {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'log' && /0G Storage/.test(e.title)) continue; // logs follow the outcome
    if (e.kind === 'receipt' && /^Done/.test(e.title)) return 'done';
    if (e.kind === 'error') return /Price moved/.test(e.title) ? 'cancelled' : 'failed';
    if (e.kind === 'approval') {
      if (/Waiting/.test(e.title)) return 'needs_you';
      if (/Approved/.test(e.title)) return 'running';
      return 'cancelled'; // denied / expired / rejected
    }
    if (e.kind === 'policy') {
      if (/refused/i.test(e.title)) return 'refused';
      if (/Cancelled|Declined/.test(e.title)) return 'cancelled';
      if (/needs your approval/.test(e.title)) return 'needs_you';
      if (/suggestion/i.test(e.title)) return 'info';
      return 'running';
    }
    if (e.kind === 'plan' && e.title === 'Agent reply') return 'info';
    if (e.kind === 'system') return 'info';
    if (e.kind === 'detector') return /expired/i.test(e.title) ? 'cancelled' : 'info';
  }
  return 'running';
}

function runTitle(events: readonly TraceEvent[]): string {
  const prepared = events.find((e) => e.kind === 'plan' && e.title.startsWith('Prepared: '));
  if (prepared) return prepared.title.slice('Prepared: '.length);
  const reply = events.find((e) => e.kind === 'plan' && e.title === 'Agent reply');
  if (reply) return 'Answered a question';
  const first = events[0];
  return first ? first.title : 'Run';
}

/** Groups newest-first events into runs, newest run first. */
export function groupRuns(events: readonly TraceEvent[]): Run[] {
  const byTrace = new Map<string, TraceEvent[]>();
  for (const e of events) {
    const list = byTrace.get(e.traceId);
    if (list) list.push(e);
    else byTrace.set(e.traceId, [e]);
  }
  const runs: Run[] = [];
  for (const [traceId, list] of byTrace) {
    const sorted = [...list].sort((a, b) =>
      a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts.localeCompare(b.ts),
    );
    runs.push({
      traceId,
      events: sorted,
      startedAt: sorted[0]!.ts,
      endedAt: sorted[sorted.length - 1]!.ts,
      status: runStatus(sorted),
      title: runTitle(sorted),
    });
  }
  return runs.sort((a, b) => b.endedAt.localeCompare(a.endedAt));
}

/** "850 ms", "4.2 s", "1 m 12 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m} m ${Math.round((ms % 60_000) / 1000)} s`;
}

/** Hash-like values worth a chip on an event row (tx hash, 0G Storage root). */
export function eventChips(e: TraceEvent): { label: string; value: string; href?: string }[] {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const out: { label: string; value: string; href?: string }[] = [];
  if (typeof d.txHash === 'string' && e.kind !== 'log')
    out.push({
      label: 'tx',
      value: d.txHash,
      ...(typeof d.explorerUrl === 'string' ? { href: d.explorerUrl } : {}),
    });
  if (typeof d.rootHash === 'string')
    out.push({
      label: '0G Storage',
      value: d.rootHash,
      ...(typeof d.explorerUrl === 'string' ? { href: d.explorerUrl } : {}),
    });
  return out;
}
