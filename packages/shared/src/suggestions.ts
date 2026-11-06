/**
 * Mode B (PHASE 08): the rules detectors apply, suggestions as the inbox shows them, Telegram
 * link state and per-detector auto-act settings. Numbers live here so the worker, the API and the
 * UI can never disagree.
 */
import { z } from 'zod';
import { AddressSchema, DecimalStringSchema, IsoDateTimeSchema } from './primitives.js';
import { PolicyOutcomeSchema, PolicyReasonSchema } from './policy.js';
import { PlanStatusSchema, SuggestionDetectorSchema, type SuggestionDetector } from './cards.js';
import { ZgProvenanceSchema } from './trace.js';

/** Detector thresholds (PHASE 08 §1 table). */
export const MODE_B = Object.freeze({
  /** DIP: ETH at or below this share of its 7-day high. */
  dipRatio: '0.90',
  /** PROFIT: position P&L at or above this percent. */
  profitPct: '12',
  /** PROFIT: share of the position to sell, in percent. */
  profitSellPct: '25',
  /** IDLE_USDC: fires strictly above this balance. */
  idleUsdcMinUsd: '20',
  idleUsdcHours: 24,
  /** BETTER_POOL: APR gap strictly above this (points), payback strictly under this (days). */
  betterPoolAprGapPts: '3',
  betterPoolPaybackDays: '7',
  /** OUT_OF_RANGE: consecutive checks out of range before it fires. */
  outOfRangeChecks: 2,
  /** NEW_HOOK: quote better than the usual route by at least this percent. */
  newHookBetterPct: '0.3',
  /** NEW_HOOK: only hooks first seen this recently count as new. */
  newHookMaxAgeDays: 7,
  /** BIG_MOVE: absolute ETH move over one hour. */
  bigMovePct: '5',
  /** MORNING_BRIEF window in the user's time zone. */
  briefHour: 8,
  briefWindowMinutes: 15,
  /** A prepared suggestion plan goes stale after this long. */
  suggestionTtlMs: 15 * 60_000,
  /** Worker cadence. */
  tickEveryMs: 60_000,
});

export const SUGGESTION_STATUSES = [
  'OPEN',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'AUTO_EXECUTED',
  'INFO',
  'FAILED',
] as const;
export const SuggestionStatusSchema = z.enum(SUGGESTION_STATUSES);
export type SuggestionStatus = z.infer<typeof SuggestionStatusSchema>;

export const SUGGESTION_SEVERITIES = ['INFO', 'NORMAL', 'RED'] as const;
export const SuggestionSeveritySchema = z.enum(SUGGESTION_SEVERITIES);
export type SuggestionSeverity = z.infer<typeof SuggestionSeveritySchema>;

// --- Auto-act ---------------------------------------------------------------------------------

/** Detectors whose proposals may run alone when they pass every check. */
export const AUTO_ACT_DETECTORS = [
  'DIP',
  'PROFIT',
  'IDLE_USDC',
  'BETTER_POOL',
  'OUT_OF_RANGE',
] as const satisfies readonly SuggestionDetector[];
export type AutoActDetector = (typeof AUTO_ACT_DETECTORS)[number];

export const AutoActSettingsSchema = z.object({
  DIP: z.boolean(),
  PROFIT: z.boolean(),
  IDLE_USDC: z.boolean(),
  BETTER_POOL: z.boolean(),
  OUT_OF_RANGE: z.boolean(),
});
export type AutoActSettings = z.infer<typeof AutoActSettingsSchema>;

export const DEFAULT_AUTO_ACT: Readonly<AutoActSettings> = Object.freeze({
  DIP: true,
  PROFIT: true,
  IDLE_USDC: true,
  BETTER_POOL: false,
  OUT_OF_RANGE: false,
});

/** Stored JSON → complete settings (unknown or missing keys fall back to the defaults). */
export function autoActSettings(stored: unknown): AutoActSettings {
  const parsed = AutoActSettingsSchema.partial().safeParse(stored ?? {});
  return { ...DEFAULT_AUTO_ACT, ...(parsed.success ? parsed.data : {}) };
}

// --- Suggestions ------------------------------------------------------------------------------

/** Who has to say yes: `agent` runs alone, `you` is one tap, `verified_human` is a step-up. */
export const SUGGESTION_APPROVERS = ['agent', 'you', 'verified_human'] as const;
export const SuggestionApproverSchema = z.enum(SUGGESTION_APPROVERS);
export type SuggestionApprover = z.infer<typeof SuggestionApproverSchema>;

export const SuggestionPlanViewSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1),
  status: PlanStatusSchema,
  policyOutcome: PolicyOutcomeSchema,
  amountUsd: DecimalStringSchema,
  tradeScore: z.number().int().nullable(),
  hookScore: z.number().int().nullable(),
  approver: SuggestionApproverSchema,
  reasons: z.array(PolicyReasonSchema),
  /** Set when the plan waits for a step-up approval. */
  approvalId: z.string().min(1).nullable(),
  tx: z.object({ hash: z.string().min(1), explorerUrl: z.string().url().nullable() }).nullable(),
});
export type SuggestionPlanView = z.infer<typeof SuggestionPlanViewSchema>;

export const SuggestionViewSchema = z.object({
  id: z.string().min(1),
  detector: SuggestionDetectorSchema,
  severity: SuggestionSeveritySchema,
  status: SuggestionStatusSchema,
  title: z.string(),
  message: z.string(),
  /** How it ended, in plain words ("Price moved — nothing was traded"). */
  note: z.string().nullable(),
  simulated: z.boolean(),
  plan: SuggestionPlanViewSchema.nullable(),
  /** Chat text for "Change"; null when there is nothing to edit. */
  prefill: z.string().nullable(),
  actions: z.array(z.enum(['yes', 'change', 'no'])),
  expiresAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  zg: ZgProvenanceSchema.nullable(),
});
export type SuggestionView = z.infer<typeof SuggestionViewSchema>;

export const SuggestionsResponseSchema = z.object({
  /** Today's morning brief, pinned above the list. */
  brief: SuggestionViewSchema.nullable(),
  /** Newest first, morning briefs left out. */
  suggestions: z.array(SuggestionViewSchema),
  /** Suggestions waiting for a Yes / Change / No (nav badge). */
  openCount: z.number().int().min(0),
});
export type SuggestionsResponse = z.infer<typeof SuggestionsResponseSchema>;

export const SUGGESTION_RESULTS = [
  'EXECUTING',
  'NEEDS_APPROVAL',
  'PRICE_MOVED',
  'REFUSED',
  'DECLINED',
  'EXPIRED',
  'CHANGED',
] as const;
export const SuggestionResultSchema = z.enum(SUGGESTION_RESULTS);
export type SuggestionResult = z.infer<typeof SuggestionResultSchema>;

export const SuggestionActionResponseSchema = z.object({
  result: SuggestionResultSchema,
  message: z.string(),
  approvalId: z.string().min(1).nullable(),
  /** Where "Change" continues: the chat, pre-filled. */
  prefill: z.string().nullable(),
  suggestion: SuggestionViewSchema,
});
export type SuggestionActionResponse = z.infer<typeof SuggestionActionResponseSchema>;

// --- Settings ---------------------------------------------------------------------------------

export const TelegramSettingsSchema = z.object({
  /** False when this server has no bot token. */
  available: z.boolean(),
  linked: z.boolean(),
  muted: z.boolean(),
  botUsername: z.string().nullable(),
});
export type TelegramSettings = z.infer<typeof TelegramSettingsSchema>;

export const TelegramLinkResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: IsoDateTimeSchema,
});
export type TelegramLinkResponse = z.infer<typeof TelegramLinkResponseSchema>;

export const TelegramMuteRequestSchema = z.object({ muted: z.boolean() }).strict();
export const AutoActUpdateSchema = AutoActSettingsSchema.partial().strict();
export const TimezoneUpdateSchema = z
  .object({ timezone: z.string().trim().min(1).max(64) })
  .strict();

// --- Demo controls (admin) --------------------------------------------------------------------

const Signed = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal number');

/** Inputs a demo may override. Anything left out keeps its live value. */
export const SimulateOverridesSchema = z
  .object({
    /** DIP / BIG_MOVE: reference ETH price and its 7-day high. */
    ethPriceUsd: DecimalStringSchema,
    ethHigh7dUsd: DecimalStringSchema,
    /** BIG_MOVE: signed percent over the last hour. */
    ethChange1hPct: Signed,
    /** DIP: size of the buy (over the limit shows the step-up path). */
    amountUsd: DecimalStringSchema,
    /** PROFIT: which holding, and its P&L percent. */
    token: z.string().trim().min(1).max(20),
    pnlPct: Signed,
    /** IDLE_USDC: the balance the detector sees. */
    usdcBalance: DecimalStringSchema,
    /** OUT_OF_RANGE / BETTER_POOL / HOOK_CHANGED: which position (LpPosition.id). */
    positionId: z.string().min(1).max(100),
    /** BETTER_POOL: APR of the position's pool and of the candidate. */
    currentAprPct: DecimalStringSchema,
    candidateAprPct: DecimalStringSchema,
    /** NEW_HOOK / HOOK_CHANGED: which hook. */
    hookAddress: AddressSchema,
    /** NEW_HOOK: how much better the quote is, in percent. */
    betterPct: DecimalStringSchema,
    /** HOOK_CHANGED: the new owner in the simulated snapshot. */
    newOwner: AddressSchema,
  })
  .partial()
  .strict();
export type SimulateOverrides = z.infer<typeof SimulateOverridesSchema>;

export const SimulateEventRequestSchema = z
  .object({
    userId: z.string().min(1).max(100),
    detector: SuggestionDetectorSchema,
    overrides: SimulateOverridesSchema.optional(),
  })
  .strict();
export type SimulateEventRequest = z.infer<typeof SimulateEventRequestSchema>;

export const RunBriefRequestSchema = z.object({ userId: z.string().min(1).max(100) }).strict();
