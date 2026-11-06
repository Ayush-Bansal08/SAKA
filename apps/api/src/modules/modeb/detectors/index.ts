/**
 * All detectors (PHASE 08 §1). Each file holds one pure rule; RED ones come first so a busy tick
 * reaches them before the daily cap or the time budget does.
 */
import type { SuggestionDetector } from '@warden/shared';
import type { Detector } from '../types.js';
import { detectBetterPool } from './better-pool.js';
import { detectBigMove } from './big-move.js';
import { detectDip } from './dip.js';
import { detectHookChanged } from './hook-changed.js';
import { detectIdleUsdc } from './idle-usdc.js';
import { detectMorningBrief } from './morning-brief.js';
import { detectNewHook } from './new-hook.js';
import { detectOutOfRange } from './out-of-range.js';
import { detectProfit } from './profit.js';

export const DETECTORS: Readonly<Record<SuggestionDetector, Detector>> = Object.freeze({
  HOOK_CHANGED: detectHookChanged,
  BIG_MOVE: detectBigMove,
  MORNING_BRIEF: detectMorningBrief,
  OUT_OF_RANGE: detectOutOfRange,
  DIP: detectDip,
  PROFIT: detectProfit,
  IDLE_USDC: detectIdleUsdc,
  BETTER_POOL: detectBetterPool,
  NEW_HOOK: detectNewHook,
});

export {
  detectBetterPool,
  detectBigMove,
  detectDip,
  detectHookChanged,
  detectIdleUsdc,
  detectMorningBrief,
  detectNewHook,
  detectOutOfRange,
  detectProfit,
};
