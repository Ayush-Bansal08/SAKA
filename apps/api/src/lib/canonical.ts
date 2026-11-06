/**
 * Canonical JSON: object keys sorted recursively, no whitespace, bigint → decimal string,
 * `undefined` members dropped (as JSON.stringify does). Used for planHash and the decision-log
 * payload so the same facts always hash to the same value, on any machine.
 */
import { createHash } from 'node:crypto';

function normalise(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalise(v)));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = normalise(v);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new TypeError('Canonical JSON cannot encode a non-finite number');
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value));
}

export function sha256Hex(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
