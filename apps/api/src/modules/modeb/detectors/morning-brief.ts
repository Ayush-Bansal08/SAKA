/** MORNING_BRIEF: 08:00–08:15 in the user's time zone, once a day. brief.ts writes the content. */
import { MODE_B } from '@warden/shared';
import type { Detector } from '../types.js';

export const detectMorningBrief: Detector = (ctx) => {
  if (ctx.localHour !== MODE_B.briefHour || ctx.localMinute >= MODE_B.briefWindowMinutes)
    return null;
  const dedupeKey = `brief:${ctx.localDay}`;
  if (ctx.seen.has(dedupeKey)) return null;
  return {
    detector: 'MORNING_BRIEF',
    dedupeKey,
    severity: 'INFO',
    title: 'Morning brief',
    summary: `Your portfolio is $${ctx.portfolio.totalUsd}.`,
    facts: { totalUsd: ctx.portfolio.totalUsd },
    intent: null,
  };
};
