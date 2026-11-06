/**
 * HTTP contract shared by apps/api (response validation) and apps/web (parsing).
 */
import { z } from 'zod';
import { ExecutionChainIdSchema } from './chains.js';
import { DecimalStringSchema, IsoDateTimeSchema } from './primitives.js';
import {
  HookBandSchema,
  PolicyOutcomeSchema,
  PolicyReasonSchema,
  RiskProfileSchema,
} from './policy.js';
import {
  DecisionLogRefSchema,
  PlanStatusSchema,
  PreviewStepSchema,
  QuoteSummarySchema,
} from './cards.js';
import { ActionIntentSchema } from './intent.js';
import { ZgProvenanceSchema } from './trace.js';

export const PROVIDER_KINDS = ['dev', 'world'] as const;
export const ProviderKindSchema = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ONBOARDING_STEPS = ['VERIFY', 'WALLET', 'PROFILE', 'FUND', 'DONE'] as const;
export const OnboardingStepSchema = z.enum(ONBOARDING_STEPS);
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export const ProvidersResponseSchema = z.object({
  appName: z.string(),
  identity: ProviderKindSchema,
  approvals: ProviderKindSchema,
  executionChainId: ExecutionChainIdSchema,
});
export type ProvidersResponse = z.infer<typeof ProvidersResponseSchema>;

export const UserViewSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  identityKind: ProviderKindSchema,
  verifiedAt: IsoDateTimeSchema.nullable(),
  lastAuthAt: IsoDateTimeSchema.nullable(),
  timezone: z.string(),
  riskProfile: RiskProfileSchema,
  onboardingStep: OnboardingStepSchema,
  telegramLinked: z.boolean(),
  createdAt: IsoDateTimeSchema,
});
export type UserView = z.infer<typeof UserViewSchema>;

export const MeResponseSchema = z.object({ user: UserViewSchema });
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const DisplayNameSchema = z
  .string()
  .trim()
  .min(2, 'Name must be at least 2 characters')
  .max(40, 'Name must be at most 40 characters')
  .regex(/^[\p{L}\p{N} ._-]+$/u, 'Use letters, numbers, spaces, dots, dashes or underscores');

export const DevSignInRequestSchema = z.object({ displayName: DisplayNameSchema });
export type DevSignInRequest = z.infer<typeof DevSignInRequestSchema>;

export const SignInResponseSchema = z.object({
  token: z.string().min(1),
  expiresAt: IsoDateTimeSchema,
  user: UserViewSchema,
});
export type SignInResponse = z.infer<typeof SignInResponseSchema>;

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  uptimeSeconds: z.number(),
  checks: z.object({
    database: z.enum(['up', 'down']),
    redis: z.enum(['up', 'down']),
  }),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// --- Agent chat (PHASE 04) ----------------------------------------------------

export const AGENT_MESSAGE_MAX_CHARS = 4000;
export const AgentMessageRequestSchema = z.object({
  text: z.string().trim().min(1).max(AGENT_MESSAGE_MAX_CHARS),
});
export type AgentMessageRequest = z.infer<typeof AgentMessageRequestSchema>;

export const AgentMessageAcceptedSchema = z.object({
  agentRequestId: z.string().min(1),
  traceId: z.string().min(1),
});
export type AgentMessageAccepted = z.infer<typeof AgentMessageAcceptedSchema>;

export const AgentMessageViewSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['USER', 'AGENT', 'SYSTEM']),
  text: z.string(),
  /** Cards (validated by `CardSchema` on read; unknown legacy shapes are passed through). */
  cards: z.array(z.unknown()).nullable(),
  traceId: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type AgentMessageView = z.infer<typeof AgentMessageViewSchema>;

export const AgentMessagesResponseSchema = z.object({
  /** Newest first. */
  messages: z.array(AgentMessageViewSchema),
  nextCursor: z.string().nullable(),
});
export type AgentMessagesResponse = z.infer<typeof AgentMessagesResponseSchema>;

// --- Plans, approvals, decision logs (PHASE 05) ---------------------------------

export const TradeScoreBreakdownItemSchema = z.object({
  rule: z.string().min(1),
  penalty: z.number(),
  evidence: z.string(),
});
export type TradeScoreBreakdownItem = z.infer<typeof TradeScoreBreakdownItemSchema>;

export const SimulationStepViewSchema = z.object({
  index: z.number().int().min(0),
  ok: z.boolean(),
  revertReason: z.string().optional(),
  gasEstimate: z.string().optional(),
  /** Depends on an earlier step (approval) or a signature: simulated at execution time. */
  deferred: z.boolean().optional(),
});

export const SimulationViewSchema = z.object({
  ok: z.boolean(),
  unavailable: z.boolean().optional(),
  error: z.string().optional(),
  steps: z.array(SimulationStepViewSchema),
});
export type SimulationView = z.infer<typeof SimulationViewSchema>;

export const ExecutionViewSchema = z.object({
  id: z.string().min(1),
  stepIndex: z.number().int().min(0),
  kind: z.enum([
    'APPROVAL',
    'PERMIT_SIGN',
    'SWAP',
    'TRANSFER',
    'LP_CREATE',
    'LP_DECREASE',
    'LP_CLAIM',
  ]),
  status: z.enum(['PENDING', 'SIGNED', 'BROADCAST', 'CONFIRMED', 'FAILED', 'REVERTED']),
  txHash: z.string().nullable(),
  explorerUrl: z.string().url().nullable(),
  usdValue: DecimalStringSchema,
  approvedBy: z.enum(['AGENT', 'HUMAN']),
  error: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type ExecutionView = z.infer<typeof ExecutionViewSchema>;

export const ApprovalViewSchema = z.object({
  id: z.string().min(1),
  actionPlanId: z.string().min(1),
  status: z.enum(['PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'USED', 'REJECTED']),
  reason: z.string(),
  amountUsd: DecimalStringSchema,
  planHash: z.string().min(1),
  channel: z.enum(['WEB', 'TELEGRAM']),
  providerKind: ProviderKindSchema,
  expiresAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.nullable(),
  authTime: IsoDateTimeSchema.nullable(),
  /** One-line description of the action waiting for the human. */
  summary: z.string(),
  /** True when this server offers the DEV approve button (never in production). */
  devApproveAvailable: z.boolean(),
});
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;

export const PlanViewSchema = z.object({
  id: z.string().min(1),
  status: PlanStatusSchema,
  summary: z.string(),
  intent: ActionIntentSchema,
  planHash: z.string().min(1),
  amountUsd: DecimalStringSchema,
  steps: z.array(PreviewStepSchema),
  quote: QuoteSummarySchema.nullable(),
  tradeScore: z.number().int().nullable(),
  tradeScoreBreakdown: z.array(TradeScoreBreakdownItemSchema),
  hook: z.object({ address: z.string(), score: z.number().int(), band: HookBandSchema }).nullable(),
  simulation: SimulationViewSchema.nullable(),
  guard: z
    .object({
      verdict: z.enum(['approve', 'block']),
      pApprove: z.number(),
      reason: z.string(),
      unavailable: z.boolean(),
      zg: ZgProvenanceSchema.optional(),
    })
    .nullable(),
  policyOutcome: PolicyOutcomeSchema,
  policyReasons: z.array(PolicyReasonSchema),
  approval: ApprovalViewSchema.nullable(),
  executions: z.array(ExecutionViewSchema),
  decisionLog: DecisionLogRefSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type PlanView = z.infer<typeof PlanViewSchema>;

export const DecisionLogViewSchema = z.object({
  actionPlanId: z.string().min(1),
  status: z.enum(['PENDING', 'UPLOADED', 'FAILED']),
  payloadHash: z.string().min(1),
  rootHash: z.string().nullable(),
  txHash: z.string().nullable(),
  explorerUrl: z.string().url().nullable(),
  attempts: z.number().int(),
  payload: z.unknown(),
});
export type DecisionLogView = z.infer<typeof DecisionLogViewSchema>;
