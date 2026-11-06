/**
 * Hooks explorer (PHASE 07 §1–2): list, detail and what-if views. Scores are deterministic
 * (MCP `score_hook`, Uniswap v4 Security Framework); the 0G model only writes the explanation.
 */
import { z } from 'zod';
import { HookBandSchema } from './policy.js';
import { AddressSchema, IsoDateTimeSchema } from './primitives.js';

export const HOOK_SCOPES = ['market', 'execution'] as const;
export const HookScopeSchema = z.enum(HOOK_SCOPES);
export type HookScope = z.infer<typeof HookScopeSchema>;

export const HOOK_SORTS = ['new', 'tvl', 'score'] as const;

export const HookListQuerySchema = z.object({
  scope: HookScopeSchema.default('market'),
  band: HookBandSchema.optional(),
  /** Only hooks first seen in the last 7 days. */
  fresh: z.enum(['true', 'false']).optional(),
  /** Address prefix or token symbol. */
  q: z.string().trim().max(64).optional(),
  sort: z.enum(HOOK_SORTS).default('new'),
  cursor: z.coerce.number().int().min(0).max(10_000).optional(),
  limit: z.coerce.number().int().min(1).max(60).default(24),
});
export type HookListQuery = z.infer<typeof HookListQuerySchema>;

export const HookPermissionViewSchema = z.object({
  flag: z.string(),
  risk: z.string(),
});

export const HookPairViewSchema = z.object({
  poolId: z.string(),
  token0: AddressSchema,
  token1: AddressSchema,
  token0Symbol: z.string().nullable(),
  token1Symbol: z.string().nullable(),
  fee: z.number().int(),
  tickSpacing: z.number().int(),
  tvlUsd: z.string().nullable(),
});

export const HookExplanationSchema = z.object({
  text: z.string(),
  /** null when the explanation is our deterministic template (0G explainer unavailable). */
  model: z.string().nullable(),
  requestId: z.string().nullable(),
  trustMode: z.string().nullable(),
  teeVerified: z.boolean().nullable(),
});

export const HookListItemSchema = z.object({
  chainId: z.number().int(),
  address: AddressSchema,
  name: z.string().nullable(),
  score: z.number().int().min(0).max(100),
  band: HookBandSchema,
  permissions: z.array(HookPermissionViewSchema),
  pairs: z.array(HookPairViewSchema),
  poolCount: z.number().int(),
  tvlUsd: z.string().nullable(),
  ageDays: z.number().nullable(),
  firstSeenAt: IsoDateTimeSchema,
  lastCheckedAt: IsoDateTimeSchema,
  explanation: HookExplanationSchema.nullable(),
  /** True on the execution chain: swaps can actually be routed through it. */
  tradeable: z.boolean(),
});
export type HookListItem = z.infer<typeof HookListItemSchema>;

export const HookListResponseSchema = z.object({
  scope: HookScopeSchema,
  chainId: z.number().int(),
  hooks: z.array(HookListItemSchema),
  total: z.number().int(),
  nextCursor: z.number().int().nullable(),
  /** When the indexer last finished this scope (null = never). */
  indexedAt: IsoDateTimeSchema.nullable(),
});
export type HookListResponse = z.infer<typeof HookListResponseSchema>;

export const HookSnapshotViewSchema = z.object({
  takenAt: IsoDateTimeSchema,
  score: z.number().int(),
  band: HookBandSchema,
  codeHash: z.string().nullable(),
  implementation: z.string().nullable(),
  owner: z.string().nullable(),
  changes: z.array(z.string()),
});
export type HookSnapshotView = z.infer<typeof HookSnapshotViewSchema>;

export const HookDetailSchema = HookListItemSchema.extend({
  breakdown: z.array(
    z.object({ rule: z.string(), penalty: z.number(), evidence: z.string(), source: z.string() }),
  ),
  /** All 14 permission flags, enabled or not. */
  permissionGrid: z.array(
    z.object({ flag: z.string(), enabled: z.boolean(), risk: z.string().nullable() }),
  ),
  facts: z.object({
    proxyKind: z.string().nullable(),
    upgradeable: z.boolean(),
    implementation: z.string().nullable(),
    owner: z.string().nullable(),
    verifiedSource: z.boolean().nullable(),
    codeHash: z.string().nullable(),
    contractName: z.string().nullable(),
    adminSelectors: z.array(z.string()),
  }),
  frameworkTier: z.string().nullable(),
  snapshots: z.array(HookSnapshotViewSchema),
});
export type HookDetail = z.infer<typeof HookDetailSchema>;

export const HookWhatIfQuerySchema = z.object({
  pair: z
    .string()
    .regex(/^[A-Za-z0-9.]{1,20}-[A-Za-z0-9.]{1,20}$/)
    .default('ETH-USDC'),
  amountUsd: z.coerce.number().positive().max(10_000).default(100),
});

export const HookWhatIfSchema = z.object({
  available: z.boolean(),
  /** Why the comparison is not available (market hook, no pool for the pair, quote failed). */
  reason: z.string().nullable(),
  tokenIn: z.string().nullable(),
  tokenOut: z.string().nullable(),
  amountIn: z.string().nullable(),
  viaHook: z
    .object({
      amountOut: z.string(),
      poolId: z.string(),
      fee: z.number(),
      /** Estimated gas in USD (hook callbacks cost extra gas). */
      gasUsd: z.string().nullable(),
    })
    .nullable(),
  defaultRoute: z
    .object({ amountOut: z.string(), route: z.string().nullable(), gasUsd: z.string().nullable() })
    .nullable(),
  /** (viaHook − default) / default, percent, before gas; positive = the hook pool pays more. */
  differencePct: z.number().nullable(),
  /** The same comparison NET OF GAS (what the user really keeps); null when gas is unknown. */
  netDifferencePct: z.number().nullable(),
});
export type HookWhatIf = z.infer<typeof HookWhatIfSchema>;
