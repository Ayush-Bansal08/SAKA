/**
 * Demo market simulator: the API contract between the simulator routes and its panel. A scenario
 * supplies market conditions only; the decision comes from the 0G planner and is reported here.
 */
import { z } from 'zod';
import { IsoDateTimeSchema } from './primitives.js';
import { SuggestionViewSchema } from './suggestions.js';
import { ZgProvenanceSchema } from './trace.js';

export const SIMULATOR_SCENARIO_IDS = [
  'ETH_DIP_STABILIZING',
  'ETH_CRASH_GUARD',
  'LP_MIGRATION_NOT_WORTH_IT',
] as const;
export const SimulatorScenarioIdSchema = z.enum(SIMULATOR_SCENARIO_IDS);
export type SimulatorScenarioId = z.infer<typeof SimulatorScenarioIdSchema>;

/** DEMO broadcasts on the testnet; PAPER stops after transaction simulation. */
export const SIMULATOR_MODES = ['DEMO', 'PAPER'] as const;
export const SimulatorModeSchema = z.enum(SIMULATOR_MODES);
export type SimulatorMode = z.infer<typeof SimulatorModeSchema>;

export const SimulatorRunRequestSchema = z
  .object({ scenarioId: SimulatorScenarioIdSchema, mode: SimulatorModeSchema })
  .strict();
export type SimulatorRunRequest = z.infer<typeof SimulatorRunRequestSchema>;

export const SimulatorScenarioViewSchema = z.object({
  id: SimulatorScenarioIdSchema,
  label: z.string(),
  /** The conditions, never the expected outcome. */
  description: z.string(),
});
export type SimulatorScenarioView = z.infer<typeof SimulatorScenarioViewSchema>;

export const SimulatorScenariosResponseSchema = z.object({
  scenarios: z.array(SimulatorScenarioViewSchema),
});

/**
 * What the model reports next to its decision. Every field is tolerant: a field the model omits
 * or malforms is dropped and shown as missing, never filled in.
 */
const tolerant = <T extends z.ZodTypeAny>(schema: T) => schema.optional().catch(undefined);

export const DecisionDigestSchema = z.object({
  signalsChecked: tolerant(
    z
      .array(
        z.object({
          signal: z.string(),
          value: z.string(),
          supports: z.enum(['ACT', 'HOLD', 'NEUTRAL']),
        }),
      )
      .max(20),
  ),
  estimatedCosts: tolerant(
    z.object({
      gasUsd: tolerant(z.coerce.number().min(0)),
      slippageBps: tolerant(z.coerce.number().min(0)),
      priceImpactBps: tolerant(z.coerce.number().min(0)),
    }),
  ),
  risks: tolerant(z.array(z.string()).max(20)),
  alternativesConsidered: tolerant(
    z.array(z.object({ option: z.string(), whyRejected: z.string() })).max(10),
  ),
  /** 0 to 1. */
  confidence: tolerant(z.coerce.number().min(0).max(1)),
  tranche: tolerant(
    z.object({
      index: z.coerce.number().int().min(1),
      maxTranches: z.coerce.number().int().min(1),
      cooldownMinutes: z.coerce.number().min(0),
    }),
  ),
});
export type DecisionDigest = z.infer<typeof DecisionDigestSchema>;

export const SIMULATOR_OUTCOMES = [
  'BUY',
  'SELL',
  'SWAP',
  'MIGRATE_LP',
  'ADD_LIQUIDITY',
  'REMOVE_LIQUIDITY',
  'NO_ACTION',
  /** The model asked a question instead of deciding: reported, not dressed up as a decision. */
  'NO_DECISION',
] as const;
export const SimulatorOutcomeSchema = z.enum(SIMULATOR_OUTCOMES);
export type SimulatorOutcome = z.infer<typeof SimulatorOutcomeSchema>;

export const SimulatorDecisionSchema = z.object({
  outcome: SimulatorOutcomeSchema,
  /** The action in plain words; null when there is none. */
  summary: z.string().nullable(),
  /** The model's own words. */
  rationale: z.string(),
  digest: DecisionDigestSchema.nullable(),
  zg: ZgProvenanceSchema.nullable(),
});
export type SimulatorDecision = z.infer<typeof SimulatorDecisionSchema>;

export const SimulatorRunViewSchema = z.object({
  /** Also the trace id of the run. */
  id: z.string().min(1),
  scenarioId: SimulatorScenarioIdSchema,
  label: z.string(),
  /** What was asked for. */
  mode: SimulatorModeSchema,
  /** What really happened: DEMO falls back to PAPER when the testnet cannot run the action. */
  effectiveMode: SimulatorModeSchema,
  status: z.enum(['RUNNING', 'DONE', 'FAILED']),
  /** What changed, in one line. */
  event: z.string(),
  decision: SimulatorDecisionSchema.nullable(),
  /** The action was stopped outside the pipeline's own refusals (out of mandate). */
  rejected: z.boolean(),
  /** How the run ended, in plain words (rejection reason, paper notice, fallback notice). */
  notice: z.string().nullable(),
  /** Why the run failed; a failed run has no decision to show. */
  error: z.string().nullable(),
  suggestion: SuggestionViewSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type SimulatorRunView = z.infer<typeof SimulatorRunViewSchema>;

export const SimulatorRunsResponseSchema = z.object({ runs: z.array(SimulatorRunViewSchema) });
export type SimulatorRunsResponse = z.infer<typeof SimulatorRunsResponseSchema>;
