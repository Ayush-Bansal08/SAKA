/**
 * ActionIntent — the validated output of the 0G planner. The backend prepares
 * transactions deterministically from an intent; the model never builds txs.
 */
import { z } from 'zod';
import { AddressSchema, DecimalStringSchema, PercentSchema } from './primitives.js';

/** A token referenced by symbol (resolved against the allowlist) and/or address. */
export const TokenRefSchema = z
  .object({
    symbol: z.string().trim().min(1).max(20).optional(),
    address: AddressSchema.optional(),
  })
  .refine((t) => t.symbol !== undefined || t.address !== undefined, {
    message: 'Token needs a symbol or an address',
  });
export type TokenRef = z.infer<typeof TokenRefSchema>;

export const RANGE_PRESETS = ['narrow', 'balanced', 'wide', 'full'] as const;
export const RangePresetSchema = z.enum(RANGE_PRESETS);
export type RangePreset = z.infer<typeof RangePresetSchema>;

/** Reference to a pool: Uniswap v4 poolId (bytes32) and/or a descriptive key. */
export const PoolRefSchema = z
  .object({
    poolId: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/)
      .optional(),
    fee: z.number().int().min(0).max(1_000_000).optional(),
    tickSpacing: z.number().int().positive().optional(),
    hookAddress: AddressSchema.optional(),
  })
  .refine((p) => p.poolId !== undefined || p.fee !== undefined, {
    message: 'Pool needs a poolId or a fee tier',
  });
export type PoolRef = z.infer<typeof PoolRefSchema>;

const reason = z.string().trim().min(1).max(500);
const amountUsd = DecimalStringSchema.optional();
const slippage = z.number().positive().max(50).optional();

// --- Trigger rule specs ------------------------------------------------------

export const PriceConditionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('price_above'),
    token: TokenRefSchema,
    priceUsd: DecimalStringSchema,
  }),
  z.object({
    type: z.literal('price_below'),
    token: TokenRefSchema,
    priceUsd: DecimalStringSchema,
  }),
  z.object({
    type: z.literal('change_pct'),
    token: TokenRefSchema,
    /** Signed percent change from the reference price at creation (e.g. 2 or -5). */
    changePct: z.number().min(-99).max(1000),
  }),
]);
export type PriceCondition = z.infer<typeof PriceConditionSchema>;

/** A single step that a trigger may run once it fires. */
export const TriggerStepSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sell_percent'),
    token: TokenRefSchema,
    percent: PercentSchema,
    receiveToken: TokenRefSchema,
  }),
  z.object({
    type: z.literal('buy_usd'),
    token: TokenRefSchema,
    amountUsd: DecimalStringSchema,
    payToken: TokenRefSchema,
  }),
  z.object({
    type: z.literal('lp_open_with_proceeds'),
    token0: TokenRefSchema,
    token1: TokenRefSchema,
    rangePreset: RangePresetSchema,
  }),
]);
export type TriggerStep = z.infer<typeof TriggerStepSchema>;

export const RuleSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('TAKE_PROFIT'),
    condition: PriceConditionSchema,
    step: TriggerStepSchema,
  }),
  z.object({
    kind: z.literal('STOP_LOSS'),
    condition: PriceConditionSchema,
    step: TriggerStepSchema,
  }),
  z.object({
    kind: z.literal('DCA'),
    buy: TokenRefSchema,
    pay: TokenRefSchema,
    amountUsd: DecimalStringSchema,
    intervalHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30),
    maxRuns: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal('CHAINED'),
    condition: PriceConditionSchema,
    steps: z.array(TriggerStepSchema).min(2).max(4),
  }),
  z.object({
    kind: z.literal('PRICE_ALERT'),
    condition: PriceConditionSchema,
  }),
]);
export type RuleSpec = z.infer<typeof RuleSpecSchema>;

// --- Intents -------------------------------------------------------------------

export const SwapExactInIntentSchema = z.object({
  type: z.literal('swap_exact_in'),
  tokenIn: TokenRefSchema,
  tokenOut: TokenRefSchema,
  amountIn: DecimalStringSchema,
  amountUsd,
  maxSlippagePct: slippage,
  reason,
});

export const SwapExactOutIntentSchema = z.object({
  type: z.literal('swap_exact_out'),
  tokenIn: TokenRefSchema,
  tokenOut: TokenRefSchema,
  amountOut: DecimalStringSchema,
  amountUsd,
  maxSlippagePct: slippage,
  reason,
});

export const SwapAndSendIntentSchema = z.object({
  type: z.literal('swap_and_send'),
  tokenIn: TokenRefSchema,
  tokenOut: TokenRefSchema,
  /** "Send 20 USDC to X, pay with ETH" is exact-output; exact-input is also allowed. */
  mode: z.enum(['exact_in', 'exact_out']),
  amount: DecimalStringSchema,
  recipient: AddressSchema,
  amountUsd,
  maxSlippagePct: slippage,
  reason,
});

export const TransferIntentSchema = z.object({
  type: z.literal('transfer'),
  token: TokenRefSchema,
  amount: DecimalStringSchema,
  recipient: AddressSchema,
  amountUsd,
  reason,
});

export const LpOpenIntentSchema = z
  .object({
    type: z.literal('lp_open'),
    token0: TokenRefSchema,
    token1: TokenRefSchema,
    /** Total USD to deploy; the preparer splits it across both sides. */
    amountUsd: DecimalStringSchema.optional(),
    amount0: DecimalStringSchema.optional(),
    amount1: DecimalStringSchema.optional(),
    poolRef: PoolRefSchema.optional(),
    /** Omitted unless the user named a range: the preparer uses the risk profile's preset. */
    rangePreset: RangePresetSchema.optional(),
    reason,
  })
  .refine((i) => i.amountUsd !== undefined || i.amount0 !== undefined || i.amount1 !== undefined, {
    message: 'LP open needs amountUsd or a token amount',
  });

export const LpRebalanceIntentSchema = z.object({
  type: z.literal('lp_rebalance'),
  /** Our LpPosition.id. */
  positionId: z.string().min(1),
  /** Omitted → the risk profile's preset. */
  rangePreset: RangePresetSchema.optional(),
  /** Move to this pool instead of re-ranging in place (Mode B "better pool"). */
  targetPool: z
    .object({
      poolId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      hookAddress: AddressSchema.optional(),
    })
    .optional(),
  amountUsd,
  reason,
});

export const LpExitIntentSchema = z.object({
  type: z.literal('lp_exit'),
  positionId: z.string().min(1),
  percent: z.number().gt(0).max(100).default(100),
  amountUsd,
  reason,
});

export const CreateTriggerIntentSchema = z.object({
  type: z.literal('create_trigger'),
  rule: RuleSpecSchema,
  reason,
});

export const CancelTriggerIntentSchema = z.object({
  type: z.literal('cancel_trigger'),
  triggerId: z.string().min(1),
  reason,
});

export const INFO_TOPICS = [
  'portfolio',
  'risk',
  'token_safety',
  'hook_explain',
  'best_pool',
  'general',
] as const;

export const InfoIntentSchema = z.object({
  type: z.literal('info'),
  topic: z.enum(INFO_TOPICS),
  /** Token / hook address / pair the question is about, when relevant. */
  subject: z.string().max(200).optional(),
  reason,
});

// Note: discriminatedUnion requires plain ZodObjects, so refined schemas are
// wrapped with z.union below and validated per-member.
export const ActionIntentSchema = z.union([
  SwapExactInIntentSchema,
  SwapExactOutIntentSchema,
  SwapAndSendIntentSchema,
  TransferIntentSchema,
  LpOpenIntentSchema,
  LpRebalanceIntentSchema,
  LpExitIntentSchema,
  CreateTriggerIntentSchema,
  CancelTriggerIntentSchema,
  InfoIntentSchema,
]);
export type ActionIntent = z.infer<typeof ActionIntentSchema>;
export type ActionIntentType = ActionIntent['type'];

export const ACTION_INTENT_TYPES = [
  'swap_exact_in',
  'swap_exact_out',
  'swap_and_send',
  'transfer',
  'lp_open',
  'lp_rebalance',
  'lp_exit',
  'create_trigger',
  'cancel_trigger',
  'info',
] as const satisfies readonly ActionIntentType[];

/**
 * Intents that move funds immediately (and therefore go through
 * prepare → score → simulate → guard → policy). Triggers move funds only when
 * they fire, at which point the fired step runs through the same pipeline.
 */
export function isMoneyMovingIntent(intent: ActionIntent): boolean {
  return (
    intent.type !== 'info' && intent.type !== 'cancel_trigger' && intent.type !== 'create_trigger'
  );
}
