/**
 * NEW_HOOK: a new Safe hook pool for a pair the user holds, quoting ≥ 0.3% better than the usual
 * route → information, with an optional "try it" request. Routing is the Uniswap API's choice, so
 * this never proposes a swap on its own.
 */
import { MODE_B } from '@warden/shared';
import type { Detector } from '../types.js';
import { short } from './util.js';

export const detectNewHook: Detector = (ctx) => {
  for (const h of ctx.newHooks) {
    if (h.band !== 'SAFE' || !h.betterPct || h.betterPct.lt(MODE_B.newHookBetterPct)) continue;
    const dedupeKey = `newhook:${h.hookAddress.toLowerCase()}`;
    if (ctx.seen.has(dedupeKey)) continue;
    const better = h.betterPct.toDecimalPlaces(2).toString();
    return {
      detector: 'NEW_HOOK',
      dedupeKey,
      severity: 'INFO',
      title: `New Safe hook on ${h.pair}: ${better}% better`,
      summary: `Hook ${short(h.hookAddress)} on ${h.pair} scores ${h.score}/100 and quotes ${better}% better than your usual route.`,
      facts: { hookAddress: h.hookAddress, pair: h.pair, score: h.score, betterPct: better },
      intent: null,
      prefill: h.tryRequest,
    };
  }
  return null;
};
