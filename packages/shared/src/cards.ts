/**
 * Chat cards: structured agent replies rendered by the web chat (UI in P06).
 * Monetary values are decimal strings; never JS numbers.
 */
import { z } from 'zod';
import { AddressSchema, DecimalStringSchema, IsoDateTimeSchema } from './primitives.js';
import { HookBandSchema, PolicyOutcomeSchema, PolicyReasonSchema } from './policy.js';
import { ZgProvenanceSchema } from './trace.js';
import { ActionIntentSchema } from './intent.js';

const TokenAmountSchema = z.object({
  symbol: z.string().min(1),
  address: AddressSchema,
  amount: DecimalStringSchema,
  decimals: z.number().int().min(0).max(36),
  usd: DecimalStringSchema.optional(),
});
export type TokenAmount = z.infer<typeof TokenAmountSchema>;

export const PreviewStepSchema = z.object({
  label: z.string().min(1),
  detail: z.string().optional(),
  kind: z.enum([
    'approval',
    'permit_sign',
    'swap',
    'transfer',
    'lp_create',
    'lp_decrease',
    'lp_claim',
  ]),
});

export const QuoteSummarySchema = z.object({
  amountIn: TokenAmountSchema,
  amountOut: TokenAmountSchema,
  priceImpactPct: z.number().min(0),
  gasUsd: DecimalStringSchema.optional(),
  /** What you really get: output value minus gas, in USD (when both are priced). */
  netOutUsd: DecimalStringSchema.optional(),
  route: z.string().optional(),
  slippagePct: z.number().min(0),
});
export type QuoteSummary = z.infer<typeof QuoteSummarySchema>;
export type PreviewStep = z.infer<typeof PreviewStepSchema>;

/** One trade-score penalty: `{ rule, penalty ≤ 0, evidence }` (PHASE_00 §9). */
export const ScoreItemSchema = z.object({
  rule: z.string().min(1),
  penalty: z.number(),
  evidence: z.string(),
});
export type ScoreItem = z.infer<typeof ScoreItemSchema>;

/**
 * The safety checks behind a card (PHASE 06 §2): trade-score breakdown, simulation and the 0G
 * guard verdict. `null` = the check did not run (e.g. no simulation after a failed build).
 */
export const CardChecksSchema = z.object({
  breakdown: z.array(ScoreItemSchema),
  simulation: z
    .object({
      ok: z.boolean(),
      unavailable: z.boolean().optional(),
      /** Steps simulated now / deferred to execution time (approval-dependent or signed). */
      simulated: z.number().int().min(0),
      deferred: z.number().int().min(0),
      error: z.string().optional(),
    })
    .nullable(),
  guard: z
    .object({
      verdict: z.enum(['approve', 'block']),
      pApprove: z.number().min(0).max(1),
      reason: z.string(),
      unavailable: z.boolean(),
      zg: ZgProvenanceSchema.optional(),
    })
    .nullable(),
});
export type CardChecks = z.infer<typeof CardChecksSchema>;

/** One 0G inference behind an action (receipt "0G verified" popover). */
export const InferenceRefSchema = z.object({
  role: z.string().min(1),
  model: z.string().min(1),
  trustMode: z.string().min(1),
  requestId: z.string().nullable(),
  teeVerified: z.boolean().nullable(),
});
export type InferenceRef = z.infer<typeof InferenceRefSchema>;

/** Pointer to a decision log on 0G Storage (root hash once uploaded). */
export const DecisionLogRefSchema = z.object({
  status: z.enum(['PENDING', 'UPLOADED', 'FAILED']),
  rootHash: z.string().optional(),
  txHash: z.string().optional(),
  explorerUrl: z.string().url().optional(),
});
export type DecisionLogRef = z.infer<typeof DecisionLogRefSchema>;

export const PLAN_STATUSES = [
  'PREPARED',
  'AWAITING_APPROVAL',
  'APPROVED',
  'QUEUED',
  'EXECUTING',
  'EXECUTED',
  'REFUSED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
] as const;
export const PlanStatusSchema = z.enum(PLAN_STATUSES);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const PreviewCardSchema = z.object({
  type: z.literal('preview'),
  actionPlanId: z.string().min(1),
  /** Live plan status (patched in place as the plan moves). */
  status: PlanStatusSchema.optional(),
  /** AUTO only: when the countdown ends and the action is handed to the execution queue. */
  autoExecuteAt: IsoDateTimeSchema.optional(),
  title: z.string().min(1),
  summary: z.string().min(1),
  amountUsd: DecimalStringSchema,
  recipient: AddressSchema.optional(),
  quote: QuoteSummarySchema.optional(),
  steps: z.array(PreviewStepSchema),
  tradeScore: z.number().int().min(0).max(100).optional(),
  hook: z
    .object({
      address: AddressSchema,
      score: z.number().int().min(0).max(100),
      band: HookBandSchema,
    })
    .optional(),
  policyOutcome: PolicyOutcomeSchema,
  policyReasons: z.array(PolicyReasonSchema),
  checks: CardChecksSchema.optional(),
  zg: ZgProvenanceSchema.optional(),
});
export type PreviewCard = z.infer<typeof PreviewCardSchema>;

export const ApprovalCardSchema = z.object({
  type: z.literal('approval'),
  approvalId: z.string().min(1),
  actionPlanId: z.string().min(1),
  title: z.string().min(1),
  /** One-line description of the action that waits for the human. */
  summary: z.string().min(1).optional(),
  reason: z.string().min(1),
  reasons: z.array(PolicyReasonSchema).optional(),
  amountUsd: DecimalStringSchema,
  recipient: AddressSchema.optional(),
  quote: QuoteSummarySchema.optional(),
  tradeScore: z.number().int().min(0).max(100).optional(),
  status: z.enum(['PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'USED', 'REJECTED']),
  channel: z.enum(['WEB', 'TELEGRAM']),
  providerKind: z.enum(['dev', 'passkey']),
  expiresAt: IsoDateTimeSchema,
  hook: PreviewCardSchema.shape.hook,
  checks: CardChecksSchema.optional(),
  zg: ZgProvenanceSchema.optional(),
});
export type ApprovalCard = z.infer<typeof ApprovalCardSchema>;

export const RefusalCardSchema = z.object({
  type: z.literal('refusal'),
  actionPlanId: z.string().min(1).optional(),
  title: z.string().min(1),
  summary: z.string().min(1),
  reasons: z.array(PolicyReasonSchema).min(1),
  tradeScore: z.number().int().min(0).max(100).optional(),
  /** Plain-English suggestion of what to try instead. */
  suggestion: z.string().optional(),
  /** A corrected request the UI offers as a chip that pre-fills the composer. */
  suggestedRequest: z.string().min(1).max(500).optional(),
  quote: QuoteSummarySchema.optional(),
  checks: CardChecksSchema.optional(),
  decisionLog: DecisionLogRefSchema.optional(),
  zg: ZgProvenanceSchema.optional(),
});
export type RefusalCard = z.infer<typeof RefusalCardSchema>;

export const ReceiptCardSchema = z.object({
  type: z.literal('receipt'),
  actionPlanId: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  amountUsd: DecimalStringSchema,
  approvedBy: z.enum(['AGENT', 'HUMAN']),
  txs: z.array(
    z.object({
      hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      kind: PreviewStepSchema.shape.kind,
      explorerUrl: z.string().url(),
      status: z.enum(['CONFIRMED', 'FAILED', 'REVERTED']),
    }),
  ),
  /** Previewed amounts in/out (the executed swap may differ within slippage). */
  quote: QuoteSummarySchema.optional(),
  /** Every 0G inference behind this action (planner, guard, explainer). */
  inferences: z.array(InferenceRefSchema).optional(),
  completedAt: IsoDateTimeSchema.optional(),
  decisionLog: DecisionLogRefSchema.optional(),
});
export type ReceiptCard = z.infer<typeof ReceiptCardSchema>;

/** Execution aborted before anything was sent because the re-quote moved > 1% (PHASE 05 §5). */
export const PriceMovedCardSchema = z.object({
  type: z.literal('price_moved'),
  actionPlanId: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  /** Previewed and re-quoted amounts of the side that moved (decimal strings). */
  previewAmount: DecimalStringSchema,
  currentAmount: DecimalStringSchema,
  symbol: z.string().min(1),
  /** How much worse the new quote is, in percent. */
  worsePct: z.number().min(0),
  /** True once the user asked for a fresh preview. */
  repreviewed: z.boolean().optional(),
});
export type PriceMovedCard = z.infer<typeof PriceMovedCardSchema>;

/** Execution failed or reverted — no silent partial state. */
export const FailureCardSchema = z.object({
  type: z.literal('failure'),
  actionPlanId: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  txs: ReceiptCardSchema.shape.txs.optional(),
  decisionLog: DecisionLogRefSchema.optional(),
});
export type FailureCard = z.infer<typeof FailureCardSchema>;

/**
 * Deterministic facts behind an info answer (PHASE 06 §2 InfoCard), built from the MCP tool
 * results the planner actually used — never from model text.
 */
export const TokenCheckDataSchema = z.object({
  kind: z.literal('token_check'),
  chainId: z.number().int(),
  symbol: z.string().nullable(),
  name: z.string().nullable(),
  address: AddressSchema,
  isNative: z.boolean(),
  verdict: z.enum(['OK', 'CAUTION', 'BLOCK']),
  onAllowlist: z.boolean(),
  onUniswapUnsupportedList: z.boolean().nullable(),
  liquidityDepthUsd: z.string().nullable(),
  riskFlags: z.array(z.string()),
});
export const PoolCompareDataSchema = z.object({
  kind: z.literal('pool_compare'),
  pair: z.string(),
  marketLabel: z.string(),
  recommendedPoolId: z.string().nullable(),
  rows: z
    .array(
      z.object({
        rank: z.number().int(),
        poolId: z.string(),
        feePct: z.number(),
        hookAddress: AddressSchema.nullable(),
        hookBand: HookBandSchema.nullable(),
        hookScore: z.number().nullable(),
        aprPct: z.string().nullable(),
        adjustedAprPct: z.string().nullable(),
        tvlUsd: z.string().nullable(),
        usable: z.boolean(),
        reasons: z.array(z.string()),
      }),
    )
    .max(10),
  reasons: z.array(z.string()),
});
export const HookScoreDataSchema = z.object({
  kind: z.literal('hook_score'),
  chainId: z.number().int(),
  address: AddressSchema,
  score: z.number().int().min(0).max(100),
  band: HookBandSchema,
  permissions: z.array(z.object({ flag: z.string(), risk: z.string() })),
  upgradeable: z.boolean(),
  verifiedSource: z.boolean().nullable(),
  owner: AddressSchema.nullable(),
  ageDays: z.number().nullable(),
  breakdown: z.array(ScoreItemSchema),
});
export const PortfolioDataSchema = z.object({
  kind: z.literal('portfolio'),
  totalUsd: DecimalStringSchema,
  pnlUsd: z.string().nullable(),
  tokens: z
    .array(
      z.object({
        symbol: z.string(),
        amount: DecimalStringSchema,
        usd: DecimalStringSchema.nullable(),
      }),
    )
    .max(20),
  risk: z.object({ score: z.number(), label: z.string() }).nullable(),
  limits: z.object({
    perActionUsd: DecimalStringSchema,
    perDayUsd: DecimalStringSchema,
    usedTodayUsd: DecimalStringSchema,
  }),
});
/** A rule the agent stored (PHASE 07): shown with a Cancel button. */
export const TriggerDataSchema = z.object({
  kind: z.literal('trigger'),
  triggerId: z.string().min(1),
  triggerKind: z.enum(['TAKE_PROFIT', 'STOP_LOSS', 'DCA', 'CHAINED', 'PRICE_ALERT']),
  summary: z.string(),
  symbol: z.string().nullable(),
  targetPriceUsd: z.string().nullable(),
  nextRunAt: IsoDateTimeSchema.nullable(),
  warnings: z.array(z.string()),
});

export const InfoDataSchema = z.discriminatedUnion('kind', [
  TriggerDataSchema,
  TokenCheckDataSchema,
  PoolCompareDataSchema,
  HookScoreDataSchema,
  PortfolioDataSchema,
]);
export type InfoData = z.infer<typeof InfoDataSchema>;

export const InfoCardSchema = z.object({
  type: z.literal('info'),
  title: z.string().min(1),
  body: z.string().min(1),
  bullets: z.array(z.string()).optional(),
  /** Optional structured payload (portfolio rows, pool comparison, risk meter...). */
  data: z.unknown().optional(),
  /** Labels data sourced from mainnet as read-only market data. */
  marketDataSource: z.enum(['execution', 'reference']).optional(),
  zg: ZgProvenanceSchema.optional(),
});
export type InfoCard = z.infer<typeof InfoCardSchema>;

export const SUGGESTION_DETECTORS = [
  'DIP',
  'PROFIT',
  'IDLE_USDC',
  'BETTER_POOL',
  'OUT_OF_RANGE',
  'NEW_HOOK',
  'HOOK_CHANGED',
  'BIG_MOVE',
  'MORNING_BRIEF',
] as const;
export const SuggestionDetectorSchema = z.enum(SUGGESTION_DETECTORS);
export type SuggestionDetector = z.infer<typeof SuggestionDetectorSchema>;

export const SuggestionCardSchema = z.object({
  type: z.literal('suggestion'),
  suggestionId: z.string().min(1),
  detector: SuggestionDetectorSchema,
  severity: z.enum(['INFO', 'NORMAL', 'RED']),
  title: z.string().min(1),
  message: z.string().min(1),
  actionPlanId: z.string().min(1).optional(),
  amountUsd: DecimalStringSchema.optional(),
  actions: z.array(z.enum(['yes', 'change', 'no'])),
  /** Kept in step with the suggestion so a card in the chat never offers a closed choice. */
  status: z
    .enum(['OPEN', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'AUTO_EXECUTED', 'INFO', 'FAILED'])
    .optional(),
  simulated: z.boolean().optional(),
  prefill: z.string().optional(),
  zg: ZgProvenanceSchema.optional(),
});
export type SuggestionCard = z.infer<typeof SuggestionCardSchema>;

export const IntentCardSchema = z.object({
  type: z.literal('intent'),
  intent: ActionIntentSchema,
  zg: ZgProvenanceSchema,
});
export type IntentCard = z.infer<typeof IntentCardSchema>;

export const CardSchema = z.discriminatedUnion('type', [
  IntentCardSchema,
  PreviewCardSchema,
  ApprovalCardSchema,
  RefusalCardSchema,
  ReceiptCardSchema,
  InfoCardSchema,
  SuggestionCardSchema,
  PriceMovedCardSchema,
  FailureCardSchema,
]);
export type Card = z.infer<typeof CardSchema>;
