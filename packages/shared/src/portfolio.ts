/**
 * HTTP contract for PHASE 03: agent wallet onboarding, portfolio, limits and settings.
 * USD values and token amounts are decimal strings — never JS numbers.
 */
import { z } from 'zod';
import { ExecutionChainIdSchema } from './chains.js';
import {
  AddressSchema,
  DecimalStringSchema,
  IsoDateTimeSchema,
  SignedDecimalStringSchema,
} from './primitives.js';
import { HookPolicySchema, PolicyReasonCodeSchema, RiskProfileSchema } from './policy.js';
import { OnboardingStepSchema } from './api.js';
import { AutoActSettingsSchema, TelegramSettingsSchema } from './suggestions.js';

// ---------------------------------------------------------------------------
// Wallet, limits, faucets
// ---------------------------------------------------------------------------

export const AgentWalletViewSchema = z.object({
  address: AddressSchema,
  chainId: ExecutionChainIdSchema,
  createdAt: IsoDateTimeSchema,
  /** Privy policy enforced on the wallet (null = the plan has no policy API; backend guard only). */
  policyId: z.string().nullable(),
});
export type AgentWalletView = z.infer<typeof AgentWalletViewSchema>;

export const LimitsViewSchema = z.object({
  riskProfile: RiskProfileSchema,
  perActionUsd: DecimalStringSchema,
  perDayUsd: DecimalStringSchema,
  maxSlippagePct: DecimalStringSchema,
  minTradeScoreAuto: z.number().int().min(0).max(100),
  hookPolicy: HookPolicySchema,
});
export type LimitsView = z.infer<typeof LimitsViewSchema>;

export const FaucetLinkSchema = z.object({
  label: z.string().min(1),
  url: z.string().url(),
  asset: z.enum(['ETH', 'USDC']),
});

export const DepositViewSchema = z.object({
  symbol: z.string(),
  amount: DecimalStringSchema,
  valueUsd: DecimalStringSchema.nullable(),
  at: IsoDateTimeSchema,
});
export type DepositView = z.infer<typeof DepositViewSchema>;

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export const OnboardingResponseSchema = z.object({
  step: OnboardingStepSchema,
  wallet: AgentWalletViewSchema.nullable(),
  /** The profile the human picked (null until the PROFILE step is completed). */
  profile: RiskProfileSchema.nullable(),
  limits: LimitsViewSchema.nullable(),
  funding: z.object({
    chainId: ExecutionChainIdSchema,
    faucets: z.array(FaucetLinkSchema),
    /** Suggested first deposit, in ETH. */
    suggestedEth: DecimalStringSchema,
    /** The first deposit the balance watcher detected (null while waiting). */
    firstDeposit: DepositViewSchema.nullable(),
  }),
});
export type OnboardingResponse = z.infer<typeof OnboardingResponseSchema>;

export const OnboardingProfileRequestSchema = z.object({ riskProfile: RiskProfileSchema });
export type OnboardingProfileRequest = z.infer<typeof OnboardingProfileRequestSchema>;

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

export const TokenPnlSchema = z.object({
  /** Cost basis of the units still held (FIFO). */
  costBasisUsd: DecimalStringSchema,
  valueUsd: DecimalStringSchema,
  unrealizedUsd: SignedDecimalStringSchema,
  realizedUsd: SignedDecimalStringSchema,
  pnlUsd: SignedDecimalStringSchema,
  /** pnlUsd / cost of every lot ever acquired, in percent (null when there is no cost). */
  pct: SignedDecimalStringSchema.nullable(),
});
export type TokenPnl = z.infer<typeof TokenPnlSchema>;

export const PortfolioTokenViewSchema = z.object({
  symbol: z.string(),
  address: AddressSchema,
  decimals: z.number().int().min(0),
  isNative: z.boolean(),
  balanceRaw: z.string().regex(/^\d+$/),
  balance: DecimalStringSchema,
  priceUsd: DecimalStringSchema.nullable(),
  valueUsd: DecimalStringSchema.nullable(),
  /** Share of the priced portfolio, in percent. */
  sharePct: DecimalStringSchema.nullable(),
  pnl: TokenPnlSchema.nullable(),
});
export type PortfolioTokenView = z.infer<typeof PortfolioTokenViewSchema>;

export const RISK_LABELS = ['Low', 'Moderate', 'High'] as const;
export const RiskLabelSchema = z.enum(RISK_LABELS);
export type RiskLabel = z.infer<typeof RiskLabelSchema>;

export const RISK_FACTORS = [
  'concentration',
  'stablecoin',
  'lpOutOfRange',
  'hookExposure',
  'drawdown',
] as const;
export const RiskFactorSchema = z.enum(RISK_FACTORS);
export type RiskFactor = z.infer<typeof RiskFactorSchema>;

export const RiskMeterSchema = z.object({
  score: z.number().int().min(0).max(100),
  label: RiskLabelSchema,
  /** Up to 3 human-readable reasons, biggest contribution first. */
  drivers: z.array(z.string()).max(3),
  /** Each factor's 0–100 risk and its weighted contribution (points of the final score). */
  factors: z.array(
    z.object({
      factor: RiskFactorSchema,
      risk: z.number().min(0).max(100),
      weight: z.number().min(0).max(1),
      points: z.number().min(0).max(100),
      available: z.boolean(),
    }),
  ),
});
export type RiskMeter = z.infer<typeof RiskMeterSchema>;

export const LimitsUsageSchema = z.object({
  perActionUsd: DecimalStringSchema,
  perDayUsd: DecimalStringSchema,
  usedTodayUsd: DecimalStringSchema,
  remainingTodayUsd: DecimalStringSchema,
  /** Calendar day the usage is counted for, in the user's time zone (YYYY-MM-DD). */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string(),
});
export type LimitsUsage = z.infer<typeof LimitsUsageSchema>;

/** An open Uniswap v4 LP position (PHASE 07): live amounts, range, value, P&L and hook. */
export const LpPositionViewSchema = z.object({
  id: z.string(),
  tokenId: z.string(),
  poolId: z.string(),
  token0: z.object({ symbol: z.string(), address: AddressSchema }),
  token1: z.object({ symbol: z.string(), address: AddressSchema }),
  amount0: DecimalStringSchema,
  amount1: DecimalStringSchema,
  fees0: DecimalStringSchema.nullable(),
  fees1: DecimalStringSchema.nullable(),
  tickLower: z.number().int(),
  tickUpper: z.number().int(),
  currentTick: z.number().int(),
  /** token1 per token0 at the range bounds and now. */
  priceLower: z.string(),
  priceUpper: z.string(),
  priceCurrent: z.string(),
  inRange: z.boolean(),
  valueUsd: DecimalStringSchema.nullable(),
  costBasisUsd: DecimalStringSchema,
  pnlUsd: SignedDecimalStringSchema.nullable(),
  hook: z
    .object({
      address: AddressSchema,
      score: z.number().int().nullable(),
      band: z.enum(['SAFE', 'CAUTION', 'DANGER']).nullable(),
    })
    .nullable(),
  openedAt: IsoDateTimeSchema,
});
export type LpPositionView = z.infer<typeof LpPositionViewSchema>;

export const PortfolioResponseSchema = z.object({
  chainId: ExecutionChainIdSchema,
  /** Null until the agent wallet exists. */
  address: AddressSchema.nullable(),
  totalUsd: DecimalStringSchema,
  tokens: z.array(PortfolioTokenViewSchema),
  /** Uniswap LP positions (added in PHASE 07). */
  lpPositions: z.array(LpPositionViewSchema),
  pnl: z.object({
    totalUsd: SignedDecimalStringSchema,
    pct: SignedDecimalStringSchema.nullable(),
    costBasisUsd: DecimalStringSchema,
    perToken: z.array(TokenPnlSchema.extend({ symbol: z.string(), address: AddressSchema })),
  }),
  risk: RiskMeterSchema,
  limits: LimitsUsageSchema,
  priceSource: z.string(),
  /** Symbols held but not priced (excluded from totals). */
  unpriced: z.array(z.string()),
  warnings: z.array(z.string()),
  asOf: IsoDateTimeSchema,
});
export type PortfolioResponse = z.infer<typeof PortfolioResponseSchema>;

/** Label shown next to every USD value (PHASE 03 §4). */
export const PORTFOLIO_PRICE_SOURCE = 'Uniswap API · Ethereum mainnet reference';

// ---------------------------------------------------------------------------
// Settings (changes aren't available yet: approvals only cover trade plans)
// ---------------------------------------------------------------------------

export const SettingsResponseSchema = z.object({
  riskProfile: RiskProfileSchema,
  limits: LimitsViewSchema.nullable(),
  wallet: AgentWalletViewSchema.nullable(),
  timezone: z.string(),
  telegram: TelegramSettingsSchema,
  autoAct: AutoActSettingsSchema,
});
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;

export const ChangeRiskProfileRequestSchema = z.object({ riskProfile: RiskProfileSchema });
export const ChangeLimitsRequestSchema = z.object({
  perActionUsd: DecimalStringSchema.optional(),
  perDayUsd: DecimalStringSchema.optional(),
});
export const WithdrawRequestSchema = z.object({
  to: AddressSchema,
  token: z.string().min(1).max(64),
  amount: DecimalStringSchema,
});

/** `details` of a 409 STEP_UP_REQUIRED error. */
export const StepUpRequiredDetailsSchema = z.object({
  reason: PolicyReasonCodeSchema,
  availableIn: z.string(),
});
export type StepUpRequiredDetails = z.infer<typeof StepUpRequiredDetailsSchema>;
