/** A young pool with a higher headline APR, a mutable hook, and real costs to move into it. */
import type { Scenario } from '../types.js';

export const lpMigrationNotWorthIt: Scenario = {
  id: 'LP_MIGRATION_NOT_WORTH_IT',
  label: 'A better LP pool?',
  description:
    'A 31-hour-old ETH/USDC pool shows 1.8 points more APR, with low TVL, spiky volume and a new upgradeable hook. Moving costs gas and slippage.',
  detector: 'BETTER_POOL',
  severity: 'NORMAL',
  eventType: 'LP_OPPORTUNITY_DETECTED',
  subject: { asset: 'ETH/USDC' },
  eventLine: 'A new ETH/USDC pool shows a higher headline fee APR than your position',
  prices: null,
  allocation: null,
  signals: {
    currentPositionInRange: true,
    currentPositionFees: 'steady',
    gas: 'normal',
    marketDataFresh: true,
  },
  lp: {
    assumedPositionUsd: '5000',
    currentAprPct: '6.4',
    candidateAprPct: '8.2',
    candidatePoolId: `0x${'5a'.repeat(32)}`,
    candidateTvlUsd: '41000',
    candidateAgeHours: 31,
    candidateVolume: 'spiky: two bursts carry most of it, unproven',
    migrationGasUsd: '14',
    migrationSlippagePct: '0.75',
    hook: {
      // Distinctive on purpose: the model miscopied a long run of zeros.
      address: '0x7f3a9c41d2e85b06a1c4f7e3b92d5c8e10a65c00',
      score: 46,
      band: 'CAUTION',
      owner: '0x000000000000000000000000000000000000a11c',
      implementation: '0x000000000000000000000000000000000000b0b0',
      findings: [
        'Permission flags allow the hook to change pool fees',
        'The hook owner can upgrade the implementation',
        'First seen 31 hours ago',
      ],
    },
  },
};
