/**
 * HTTP contract shared by apps/api (response validation) and apps/web (parsing).
 */
import { z } from 'zod';
import { ExecutionChainIdSchema } from './chains.js';
import { IsoDateTimeSchema } from './primitives.js';
import { RiskProfileSchema } from './policy.js';

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
