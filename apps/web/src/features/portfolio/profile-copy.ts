import type { RiskProfile } from '@warden/shared';

/** Human copy for the three risk profiles (numbers come from @warden/shared policy.ts). */
export const PROFILE_COPY: Record<RiskProfile, { label: string; blurb: string; detail: string }> = {
  CAREFUL: {
    label: 'Careful',
    blurb: 'Small moves, asks you often.',
    detail: 'Only safe hooks and tight slippage. Best while you get to know your agent.',
  },
  BALANCED: {
    label: 'Balanced',
    blurb: 'Sensible limits for everyday use.',
    detail: 'Handles routine swaps on its own and checks with you for anything bigger.',
  },
  ADVENTUROUS: {
    label: 'Adventurous',
    blurb: 'Bigger moves, fewer interruptions.',
    detail: 'Higher limits and Caution-rated hooks allowed. You still approve the big stuff.',
  },
};
