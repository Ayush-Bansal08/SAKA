/**
 * Typed, validated environment. The process fails fast with a readable list of
 * every missing/invalid variable. Later phases add their own groups here.
 */
import { EXECUTION_CHAIN_IDS, type ExecutionChainId } from '@warden/shared';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'], {
    errorMap: () => ({ message: 'must be true or false' }),
  })
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const urlWithoutTrailingSlash = z
  .string()
  .url()
  .transform((v) => v.replace(/\/+$/, ''));

const encryptionKey = z
  .string()
  .min(1)
  .refine(
    (v) => {
      try {
        return Buffer.from(v, 'base64').length === 32 && /^[A-Za-z0-9+/_-]+=*$/.test(v);
      } catch {
        return false;
      }
    },
    { message: 'must be 32 random bytes, base64-encoded (generate: openssl rand -base64 32)' },
  );

const providerMode = z.enum(['dev', 'world']);

export const AllowlistEntrySchema = z.object({
  chainId: z.number().int().positive(),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x address'),
  symbol: z.string().trim().min(1).max(20),
  decimals: z.number().int().min(0).max(36),
  referenceSymbol: z.string().trim().min(1).max(20).optional(),
});
export type AllowlistEntry = z.infer<typeof AllowlistEntrySchema>;

/** TOKEN_ALLOWLIST_JSON: a JSON array of extra tokens (verified on-chain by the human first). */
const tokenAllowlist = z.string().transform((raw, ctx): AllowlistEntry[] => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a JSON array' });
    return z.NEVER;
  }
  const parsed = z.array(AllowlistEntrySchema).safeParse(json);
  if (!parsed.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `invalid entry: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`,
    });
    return z.NEVER;
  }
  return parsed.data;
});

export const EnvSchema = z.object({
  ZG_BASE_URL: urlWithoutTrailingSlash.default('https://router-api.0g.ai/v1'),
  ZG_API_KEY: z.string().min(1).optional(),
  ZG_MODEL_PLANNER: z.string().min(1).optional(),
  ZG_MODEL_PLANNER_FALLBACK: z.string().min(1).optional(),
  ZG_MODEL_GUARD: z.string().min(1).optional(),
  /**
   * How the guard asks: `decisions` (Vela 2.0 via /v1/decisions, the default) or `chat` (the
   * guard model via /v1/chat/completions with a strict JSON verdict — for when the decisions
   * models are down; set ZG_MODEL_GUARD to a chat model such as glm-5.3). Fail-closed either way.
   */
  ZG_GUARD_MODE: z.enum(['decisions', 'chat']).default('decisions'),
  ZG_MODEL_EXPLAINER: z.string().min(1).optional(),
  ZG_PLANNER_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(12000),
  /** Per-call budget for guard (/decisions) and explainer calls. */
  ZG_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(20000),
  /** PHASE_00 §10: the fallback runs `verified`. Keys restricted to `private` must set `private`. */
  ZG_PLANNER_FALLBACK_TRUST_MODE: z.enum(['private', 'verified']).default('verified'),
  /** Sent as `reasoning_effort` on chat calls; `off` omits the field. */
  ZG_REASONING_EFFORT: z.enum(['off', 'low', 'medium', 'high']).default('low'),
  // --- core -----------------------------------------------------------------
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().min(1).default('0.0.0.0'),
  APP_NAME: z.string().trim().min(1).max(40).default('Warden'),
  WEB_URL: urlWithoutTrailingSlash,
  API_URL: urlWithoutTrailingSlash,
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'must be a postgresql:// connection string'),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis:// or rediss:// URL'),
  ENCRYPTION_KEY: encryptionKey,
  SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24 * 7),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  EXECUTION_CHAIN_ID: z.coerce
    .number()
    .int()
    .refine((v): v is ExecutionChainId => (EXECUTION_CHAIN_IDS as readonly number[]).includes(v), {
      message: `must be one of ${EXECUTION_CHAIN_IDS.join(', ')} (testnets only)`,
    })
    // Ethereum Sepolia: verified routable on the Uniswap Trading + LP APIs (Base Sepolia
    // returned UpstreamTimeoutError for every quote on 2026-11-06 — see FEEDBACK.md).
    .default(11155111)
    .transform((v) => v as ExecutionChainId),

  // --- modes ----------------------------------------------------------------
  AUTH_MODE: providerMode.default('world'),
  APPROVAL_MODE: providerMode.default('world'),
  ALLOW_DEV_PROVIDERS: booleanString.default('false'),
  /** Demo market simulator: its button and its routes exist only when this is on. */
  ENABLE_DEMO_SIMULATOR: booleanString.default('false'),

  // --- admin ----------------------------------------------------------------
  ADMIN_TOKEN: z.string().min(24, 'must be at least 24 characters'),

  // --- Uniswap agent MCP server (PHASE 02) ------------------------------------
  /** Streamable HTTP endpoint of packages/uniswap-agent-mcp. */
  MCP_URL: urlWithoutTrailingSlash.default('http://localhost:3002/mcp'),
  /** Bearer token for the MCP server. Without it the API runs with Uniswap tools disabled. */
  MCP_AUTH_TOKEN: z.string().min(24, 'must be at least 24 characters').optional(),
  /** Extra allowlisted tokens (same JSON the MCP server reads); used for the Privy policy. */
  TOKEN_ALLOWLIST_JSON: tokenAllowlist.default('[]'),
  /** Universal Router version the MCP server builds for (Privy policy allowlist). */
  UNISWAP_UNIVERSAL_ROUTER_VERSION: z.enum(['2.1.2', '2.2.0']).default('2.1.2'),

  // --- Privy agent wallets (PHASE 03) ----------------------------------------
  /** Without PRIVY_APP_ID + PRIVY_APP_SECRET, wallet creation answers 503 (WALLET_PROVIDER_ERROR). */
  PRIVY_APP_ID: z.string().trim().min(1).optional(),
  PRIVY_APP_SECRET: z.string().trim().min(1).optional(),
  /** Only when the Privy dashboard requires signed requests (authorization key, `wallet-auth:` PKCS8). */
  PRIVY_AUTHORIZATION_PRIVATE_KEY: z.string().trim().min(1).optional(),
  /** Execution-chain RPC (smoke scripts and receipt checks; Privy broadcasts on its own). */
  EXECUTION_RPC_URL: urlWithoutTrailingSlash.optional(),

  // --- onboarding & balance watcher (PHASE 03) -------------------------------
  /** Testnet ETH faucet shown in onboarding (defaults to a known faucet for the chain). */
  FAUCET_ETH_URL: z.string().url().optional(),
  /** Testnet USDC faucet shown in onboarding. */
  FAUCET_USDC_URL: z.string().url().default('https://faucet.circle.com'),
  /** How often the worker polls balances of active users (ms). */
  BALANCE_POLL_MS: z.coerce.number().int().min(5_000).max(600_000).default(15_000),
  /** Poll interval for users inactive for more than 24 h (ms). */
  BALANCE_POLL_INACTIVE_MS: z.coerce.number().int().min(15_000).max(3_600_000).default(300_000),

  // --- safety, approvals, execution (PHASE 05) --------------------------------
  /** How long a step-up approval stays valid (PHASE_00 §9: default 5 min). */
  APPROVAL_TTL_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
  /** Visible countdown before an AUTO action is queued (Cancel works during it). */
  AUTO_EXECUTE_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(3_000),
  /** Receipt wait per broadcast transaction before the job re-checks by hash. */
  RECEIPT_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(90_000),

  // --- 0G Storage decision log (PHASE 05) --------------------------------------
  /** Funded 0G testnet key that pays for decision-log uploads. Without it, uploads stay PENDING. */
  ZG_STORAGE_PRIVATE_KEY: z
    .string()
    .trim()
    .regex(/^(0x)?[0-9a-fA-F]{64}$/, 'must be a 32-byte hex private key')
    .optional(),
  ZG_STORAGE_RPC: urlWithoutTrailingSlash.default('https://evmrpc-testnet.0g.ai'),
  ZG_STORAGE_INDEXER: urlWithoutTrailingSlash.default(
    'https://indexer-storage-testnet-turbo.0g.ai',
  ),
  /** 0G chain explorer used for decision-log links (`<base>/tx/<zgTxHash>`). */
  ZG_STORAGE_EXPLORER_URL: urlWithoutTrailingSlash.default('https://chainscan-galileo.0g.ai'),

  // --- Mode B & Telegram (PHASE 08) ---------------------------------------------
  /** Without it, alerts stay in the web inbox and the bot does not start. */
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1).optional(),
  /** Bot username without "@", for the t.me link. */
  TELEGRAM_BOT_USERNAME: z
    .string()
    .trim()
    .regex(/^@?[A-Za-z0-9_]{3,64}$/, 'must be a Telegram username')
    .transform((v) => v.replace(/^@/, ''))
    .optional(),
  /** Checks that webhook calls come from Telegram. Required to use the webhook (production). */
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{16,256}$/, 'must be 16-256 letters, digits, _ or -')
    .optional(),
  /** Budget for one Mode B pass over every user; the rest continue next tick. */
  MODEB_TICK_BUDGET_MS: z.coerce.number().int().min(1_000).max(300_000).default(45_000),
});

export type Env = z.infer<typeof EnvSchema>;

export class EnvError extends Error {
  override name = 'EnvError';
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
  }
}

/**
 * Dev identity/approval providers are allowed only when explicitly enabled and
 * never in production (PHASE_00 §7).
 */
export function devProvidersAllowed(env: Pick<Env, 'NODE_ENV' | 'ALLOW_DEV_PROVIDERS'>): boolean {
  return env.NODE_ENV !== 'production' && env.ALLOW_DEV_PROVIDERS;
}

type ModeEnv = Pick<Env, 'NODE_ENV' | 'AUTH_MODE' | 'APPROVAL_MODE' | 'ALLOW_DEV_PROVIDERS'>;

/** The mode fields alone, so the production guard is reported even when other vars are missing. */
const ModeSchema = EnvSchema.pick({
  NODE_ENV: true,
  AUTH_MODE: true,
  APPROVAL_MODE: true,
  ALLOW_DEV_PROVIDERS: true,
});

function validateModes(env: ModeEnv): string[] {
  const issues: string[] = [];
  if (env.NODE_ENV === 'production') {
    if (env.AUTH_MODE === 'dev')
      issues.push('AUTH_MODE=dev is forbidden when NODE_ENV=production (use AUTH_MODE=world)');
    if (env.APPROVAL_MODE === 'dev')
      issues.push(
        'APPROVAL_MODE=dev is forbidden when NODE_ENV=production (use APPROVAL_MODE=world)',
      );
    if (env.ALLOW_DEV_PROVIDERS)
      issues.push('ALLOW_DEV_PROVIDERS=true is forbidden when NODE_ENV=production');
  } else {
    const wantsDev = env.AUTH_MODE === 'dev' || env.APPROVAL_MODE === 'dev';
    if (wantsDev && !env.ALLOW_DEV_PROVIDERS) {
      issues.push(
        'AUTH_MODE/APPROVAL_MODE=dev requires ALLOW_DEV_PROVIDERS=true (non-production only)',
      );
    }
  }
  if (env.AUTH_MODE === 'world' || env.APPROVAL_MODE === 'world') {
    // World ID Agent Pass is implemented in PHASE 10; until then refuse to boot
    // in a mode that would leave sign-in or approvals without a provider.
    issues.push(
      'AUTH_MODE/APPROVAL_MODE=world is not available yet (World ID arrives in Phase 10); ' +
        'use dev providers in development',
    );
  }
  return issues;
}

/**
 * Parse and validate an environment. Throws EnvError listing every problem.
 * Includes the production safety guard for dev providers.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Treat empty strings as unset so `FOO=` in .env falls back to defaults / errors clearly.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  const parsed = EnvSchema.safeParse(cleaned);
  const modes = ModeSchema.safeParse(cleaned);
  // Mode/safety problems first: they are the most important thing to fix.
  const issues = modes.success ? validateModes(modes.data) : [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '(root)';
      const message =
        issue.code === 'invalid_type' && issue.received === 'undefined'
          ? 'is required but missing'
          : issue.message;
      issues.push(`${key} ${message}`);
    }
  }
  if (issues.length > 0 || !parsed.success) throw new EnvError(issues);
  return parsed.data;
}
