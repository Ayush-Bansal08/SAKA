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

export const EnvSchema = z.object({
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

  // --- admin ----------------------------------------------------------------
  ADMIN_TOKEN: z.string().min(24, 'must be at least 24 characters'),
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
