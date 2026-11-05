import type { TraceEvent } from '@warden/shared';
import { describe, expect, it } from 'vitest';
import { backoffDelay, mergeEvents } from './trace-utils';

const ev = (id: string, ts: string): TraceEvent => ({
  id,
  ts,
  traceId: 't',
  userId: 'u',
  kind: 'log',
  title: id,
});

describe('mergeEvents', () => {
  it('dedupes by id and sorts newest first', () => {
    const a = ev('a', '2026-11-06T10:00:00.000Z');
    const b = ev('b', '2026-11-06T10:01:00.000Z');
    const merged = mergeEvents([a], [b, a]);
    expect(merged.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('returns the same array when nothing is new (no re-render)', () => {
    const list = [ev('a', '2026-11-06T10:00:00.000Z')];
    expect(mergeEvents(list, [list[0]!])).toBe(list);
  });

  it('caps the list size', () => {
    const many = Array.from({ length: 10 }, (_, i) => ev(`e${i}`, `2026-11-06T10:00:0${i}.000Z`));
    expect(mergeEvents([], many, 3).map((e) => e.id)).toEqual(['e9', 'e8', 'e7']);
  });
});

describe('backoffDelay', () => {
  it('grows exponentially and caps at 30s', () => {
    const mid = () => 0.5;
    expect(backoffDelay(0, mid)).toBe(1_000);
    expect(backoffDelay(3, mid)).toBe(8_000);
    expect(backoffDelay(20, mid)).toBe(30_000);
  });
});
