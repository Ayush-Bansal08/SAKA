/**
 * Domain rules from PHASE_00 §9. These numbers are the single source of truth
 * for the policy engine, the safety scorer and the UI. Do not duplicate them.
 *
 * USD limits are plain config numbers; any arithmetic on them must go through
 * decimal.js (see money.ts) — never add USD values with JS numbers.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Risk profiles
// ---------------------------------------------------------------------------

export const RISK_PROFILES = ['CAREFUL', 'BALANCED', 'ADVENTUROUS'] as const;
export const RiskProfileSchema = z.enum(RISK_PROFILES);
export type RiskProfile = z.infer<typeof RiskProfileSchema>;

export const DEFAULT_RISK_PROFILE: RiskProfile = 'BALANCED';

export const HOOK_POLICIES = ['SAFE_ONLY', 'SAFE_AND_CAUTION'] as const;
export const HookPolicySchema = z.enum(HOOK_POLICIES);
export type HookPolicy = z.infer<typeof HookPolicySchema>;

export interface RiskProfileSettings {
  /** Max USD value of a single action the agent may run without the human. */
  perActionUsd: number;
  /** Max USD the agent may spend alone per calendar day (user time zone). */
  perDayUsd: number;
  /** Max slippage tolerance, in percent (0.5 = 0.5%). */
  maxSlippagePct: number;
  /** Minimum trade safety score for AUTO execution. */
  minTradeScoreAuto: number;
  /** Which hook bands may be used without human approval. */
  hooksWithoutApproval: HookPolicy;
  /** Max number of proactive (Mode B) auto actions per day. */
  maxProactivePerDay: number;
  /** Size of a Mode B dip buy, in USD. */
  dipBuyUsd: number;
}

export const RISK_PROFILE_SETTINGS: Readonly<Record<RiskProfile, Readonly<RiskProfileSettings>>> =
  Object.freeze({
    CAREFUL: Object.freeze({
      perActionUsd: 10,
      perDayUsd: 40,
      maxSlippagePct: 0.3,
      minTradeScoreAuto: 80,
      hooksWithoutApproval: 'SAFE_ONLY',
      maxProactivePerDay: 3,
      dipBuyUsd: 10,
    }),
    BALANCED: Object.freeze({
      perActionUsd: 25,
      perDayUsd: 100,
      maxSlippagePct: 0.5,
      minTradeScoreAuto: 70,
      hooksWithoutApproval: 'SAFE_ONLY',
      maxProactivePerDay: 5,
      dipBuyUsd: 20,
    }),
    ADVENTUROUS: Object.freeze({
      perActionUsd: 50,
      perDayUsd: 200,
      maxSlippagePct: 1.0,
      minTradeScoreAuto: 60,
      hooksWithoutApproval: 'SAFE_AND_CAUTION',
      maxProactivePerDay: 8,
      dipBuyUsd: 40,
    }),
  });

export function riskProfileSettings(profile: RiskProfile): Readonly<RiskProfileSettings> {
  return RISK_PROFILE_SETTINGS[profile];
}

// ---------------------------------------------------------------------------
// Trade safety score (0–100) = 100 − penalties, floor 0
// ---------------------------------------------------------------------------

export const TRADE_SCORE = Object.freeze({
  max: 100,
  min: 0,
  priceImpact: Object.freeze({
    /** No penalty below this price impact (percent). */
    freeBelowPct: 0.3,
    /** Penalty applied per started step above the free threshold. */
    stepPct: 0.5,
    penaltyPerStep: 10,
    /** Above this price impact (percent) the action is refused. */
    refuseAbovePct: 5,
  }),
  sizeVsPortfolio: Object.freeze({
    over25PctPenalty: 10,
    over50PctPenalty: 25,
  }),
  token: Object.freeze({
    notOnAllowlistPenalty: 40,
    /** Liquidity depth below this (USD, reference chain) refuses the action. */
    minLiquidityDepthUsd: 10_000,
  }),
  gas: Object.freeze({
    /** Gas cost above this share of the action value (percent) is penalised. */
    maxGasSharePct: 3,
    penalty: 15,
  }),
  /** Hook pool penalty = (100 − hookScore) × this factor. */
  hookPenaltyFactor: 0.5,
  slippageAboveProfileMaxPenalty: 10,
});

// ---------------------------------------------------------------------------
// Hook safety score bands
// ---------------------------------------------------------------------------

export const HOOK_BANDS = ['SAFE', 'CAUTION', 'DANGER'] as const;
export const HookBandSchema = z.enum(HOOK_BANDS);
export type HookBand = z.infer<typeof HookBandSchema>;

export const HOOK_BAND_THRESHOLDS = Object.freeze({ safeMin: 80, cautionMin: 50 });

export function hookBand(score: number): HookBand {
  if (!Number.isFinite(score)) throw new RangeError(`Invalid hook score: ${score}`);
  if (score >= HOOK_BAND_THRESHOLDS.safeMin) return 'SAFE';
  if (score >= HOOK_BAND_THRESHOLDS.cautionMin) return 'CAUTION';
  return 'DANGER';
}

/** Whether a hook band may be used without a fresh human approval under a hook policy. */
export function hookAllowedWithoutApproval(band: HookBand, policy: HookPolicy): boolean {
  if (band === 'SAFE') return true;
  if (band === 'CAUTION') return policy === 'SAFE_AND_CAUTION';
  return false;
}

// ---------------------------------------------------------------------------
// Policy engine outcomes (first match wins — see PHASE_00 §9)
// ---------------------------------------------------------------------------

export const POLICY_OUTCOMES = ['AUTO', 'STEP_UP', 'REFUSE', 'ASK'] as const;
export const PolicyOutcomeSchema = z.enum(POLICY_OUTCOMES);
export type PolicyOutcome = z.infer<typeof PolicyOutcomeSchema>;

export const POLICY_REASON_CODES = [
  // REFUSE
  'BUILD_FAILED',
  'SIMULATION_REVERTED',
  'SIMULATION_UNAVAILABLE',
  'UNSUPPORTED_TOKEN',
  'DANGER_HOOK',
  'GUARD_BLOCKED',
  'GUARD_UNAVAILABLE',
  'TRADE_SCORE_TOO_LOW',
  'PRICE_IMPACT_TOO_HIGH',
  // STEP_UP (always)
  'WITHDRAWAL',
  'LIMIT_CHANGE',
  'RISK_PROFILE_CHANGE',
  'NEW_RECIPIENT',
  // STEP_UP (limits)
  'OVER_PER_ACTION_LIMIT',
  'OVER_DAILY_LIMIT',
  /** The USD value could not be priced, so limits cannot be checked: a human decides. */
  'VALUE_UNKNOWN',
  // STEP_UP (quality)
  'CAUTION_HOOK',
  'TRADE_SCORE_BELOW_AUTO',
  // ASK
  'PROACTIVE_NEEDS_ACCEPTANCE',
] as const;
export const PolicyReasonCodeSchema = z.enum(POLICY_REASON_CODES);
export type PolicyReasonCode = z.infer<typeof PolicyReasonCodeSchema>;

export const PolicyReasonSchema = z.object({
  code: PolicyReasonCodeSchema,
  message: z.string().min(1),
  /** The measured value (USD, percent or score) that triggered the rule. */
  value: z.number().finite().optional(),
  /** The limit it was compared with. */
  limit: z.number().finite().optional(),
});
export type PolicyReason = z.infer<typeof PolicyReasonSchema>;

/** Hard floors that refuse an action regardless of profile. */
export const POLICY_REFUSE = Object.freeze({
  minTradeScore: 40,
  maxPriceImpactPct: TRADE_SCORE.priceImpact.refuseAbovePct,
});

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export const APPROVAL_DEFAULT_TTL_SECONDS = 300;
/** AUTO actions wait this long (visible countdown + Cancel) before they are queued for execution. */
export const AUTO_EXECUTE_DELAY_MS = 3_000;
/** Execution re-quote must be within this percentage of the previewed quote. */
export const REQUOTE_MAX_DRIFT_PCT = 1;
