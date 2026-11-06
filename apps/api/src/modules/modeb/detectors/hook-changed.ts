/**
 * HOOK_CHANGED: a hook the user is exposed to changed its code, implementation, owner or an LP fee
 * → RED. With money in the pool it proposes exiting 100%; otherwise it only warns. It never runs
 * alone: leaving a hook pool always waits for the human.
 */
import { createHash } from 'node:crypto';
import type { Detector, HookStateFacts } from '../types.js';
import { short } from './util.js';

const low = (v: string | null) => v?.toLowerCase() ?? null;

/** What changed between two states, in plain words (empty = nothing the user should fear). */
export function hookStateDiff(prev: HookStateFacts, next: HookStateFacts): string[] {
  const out: string[] = [];
  if (low(prev.codeHash) !== low(next.codeHash)) out.push('its contract code changed');
  if (low(prev.implementation) !== low(next.implementation))
    out.push(`its implementation changed to ${next.implementation ?? 'none'}`);
  if (low(prev.owner) !== low(next.owner)) out.push(`its owner changed to ${next.owner ?? 'none'}`);
  for (const [pool, fee] of Object.entries(next.fees)) {
    const before = prev.fees[pool];
    if (before !== undefined && before !== fee)
      out.push(`a pool fee went from ${before / 10_000}% to ${fee / 10_000}%`);
  }
  return out;
}

/** Stable identity of a state: the same change can never alert twice. */
export function hookStateHash(state: HookStateFacts): string {
  const fees = Object.keys(state.fees)
    .sort()
    .map((k) => `${k}=${state.fees[k]}`);
  return createHash('sha256')
    .update(
      JSON.stringify([low(state.codeHash), low(state.implementation), low(state.owner), fees]),
    )
    .digest('hex')
    .slice(0, 16);
}

export const detectHookChanged: Detector = (ctx) => {
  for (const e of ctx.hookExposures) {
    const changes = hookStateDiff(e.previous, e.current);
    if (!changes.length) continue;
    const dedupeKey = `hookchg:${e.hookAddress.toLowerCase()}:${hookStateHash(e.current)}`;
    if (ctx.seen.has(dedupeKey)) continue;
    const hook = short(e.hookAddress);
    const positionId = e.positionIds[0] ?? null;
    return {
      detector: 'HOOK_CHANGED',
      dedupeKey,
      severity: 'RED',
      title: `Hook ${hook} changed`,
      summary: `Hook ${hook} changed: ${changes.join('; ')}.`,
      facts: { hookAddress: e.hookAddress, changes: changes.join('; '), positionId },
      intent: positionId
        ? {
            type: 'lp_exit',
            positionId,
            percent: 100,
            reason: `Leave the pool: hook ${hook} changed after you joined it.`,
          }
        : null,
      ...(positionId ? { prefill: `Exit 100% of position ${positionId}` } : {}),
    };
  }
  return null;
};
