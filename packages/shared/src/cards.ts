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
  route: z.string().optional(),
  slippagePct: z.number().min(0),
});
export type QuoteSummary = z.infer<typeof QuoteSummarySchema>;
export type PreviewStep = z.infer<typeof PreviewStepSchema>;

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
  providerKind: z.enum(['dev', 'world']),
  expiresAt: IsoDateTimeSchema,
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
