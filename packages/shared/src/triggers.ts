/** Triggers (PHASE 07 §4): stored rules that later run through the one pipeline. */
import { z } from 'zod';
import { IsoDateTimeSchema } from './primitives.js';

export const TRIGGER_KINDS = ['TAKE_PROFIT', 'STOP_LOSS', 'DCA', 'CHAINED', 'PRICE_ALERT'] as const;
export const TRIGGER_STATUSES = ['ACTIVE', 'FIRED', 'CANCELLED', 'FAILED'] as const;

export const TriggerViewSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(TRIGGER_KINDS),
  status: z.enum(TRIGGER_STATUSES),
  summary: z.string(),
  /** Price rules: the watched symbol and target; schedules: the local time. */
  symbol: z.string().nullable(),
  targetPriceUsd: z.string().nullable(),
  direction: z.enum(['above', 'below']).nullable(),
  schedule: z.string().nullable(),
  nextRunAt: IsoDateTimeSchema.nullable(),
  lastFiredAt: IsoDateTimeSchema.nullable(),
  fireCount: z.number().int(),
  lastResult: z.string().nullable(),
  /** Chained rules: steps done / total, and the plan the chain waits on. */
  chain: z
    .object({
      step: z.number().int(),
      total: z.number().int(),
      waitingPlanId: z.string().nullable(),
    })
    .nullable(),
  createdAt: IsoDateTimeSchema,
});
export type TriggerView = z.infer<typeof TriggerViewSchema>;

export const TriggersResponseSchema = z.object({ triggers: z.array(TriggerViewSchema) });
export type TriggersResponse = z.infer<typeof TriggersResponseSchema>;

/** Demo price override (admin): affects ONLY trigger / detector reference prices. */
export const PriceOverrideSchema = z.object({
  symbol: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9.]+$/)
    .transform((s) => s.toUpperCase()),
  priceUsd: z
    .string()
    .regex(/^(0|[1-9]\d*)(\.\d+)?$/)
    .refine((v) => Number(v) > 0, 'Price must be positive'),
  ttlSec: z.number().int().min(10).max(3600).default(600),
});
export type PriceOverride = z.infer<typeof PriceOverrideSchema>;

export const PriceOverridesResponseSchema = z.object({
  overrides: z.array(
    z.object({ symbol: z.string(), priceUsd: z.string(), expiresAt: IsoDateTimeSchema }),
  ),
});
export type PriceOverridesResponse = z.infer<typeof PriceOverridesResponseSchema>;
