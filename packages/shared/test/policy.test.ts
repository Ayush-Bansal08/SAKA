import { describe, expect, it } from 'vitest';
import {
  hookAllowedWithoutApproval,
  hookBand,
  RISK_PROFILE_SETTINGS,
  riskProfileSettings,
} from '../src/policy.js';

describe('risk profiles (PHASE_00 §9)', () => {
  it('matches the locked table exactly', () => {
    expect(RISK_PROFILE_SETTINGS).toEqual({
      CAREFUL: {
        perActionUsd: 10,
        perDayUsd: 40,
        maxSlippagePct: 0.3,
        minTradeScoreAuto: 80,
        hooksWithoutApproval: 'SAFE_ONLY',
        maxProactivePerDay: 3,
        dipBuyUsd: 10,
      },
      BALANCED: {
        perActionUsd: 25,
        perDayUsd: 100,
        maxSlippagePct: 0.5,
        minTradeScoreAuto: 70,
        hooksWithoutApproval: 'SAFE_ONLY',
        maxProactivePerDay: 5,
        dipBuyUsd: 20,
      },
      ADVENTUROUS: {
        perActionUsd: 50,
        perDayUsd: 200,
        maxSlippagePct: 1.0,
        minTradeScoreAuto: 60,
        hooksWithoutApproval: 'SAFE_AND_CAUTION',
        maxProactivePerDay: 8,
        dipBuyUsd: 40,
      },
    });
  });

  it('is immutable', () => {
    expect(() => {
      (riskProfileSettings('BALANCED') as { perActionUsd: number }).perActionUsd = 1_000;
    }).toThrow();
  });
});

describe('hook bands', () => {
  it('maps scores to bands at the boundaries', () => {
    expect(hookBand(100)).toBe('SAFE');
    expect(hookBand(80)).toBe('SAFE');
    expect(hookBand(79)).toBe('CAUTION');
    expect(hookBand(50)).toBe('CAUTION');
    expect(hookBand(49)).toBe('DANGER');
    expect(hookBand(0)).toBe('DANGER');
  });

  it('never allows danger hooks without approval', () => {
    expect(hookAllowedWithoutApproval('DANGER', 'SAFE_AND_CAUTION')).toBe(false);
    expect(hookAllowedWithoutApproval('CAUTION', 'SAFE_ONLY')).toBe(false);
    expect(hookAllowedWithoutApproval('CAUTION', 'SAFE_AND_CAUTION')).toBe(true);
  });
});
