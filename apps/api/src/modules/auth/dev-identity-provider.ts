/**
 * DEV identity provider — for local development and tests only.
 * The same display name always maps to the same human (sub = sha256 of the
 * normalised name), which lets us exercise "one human = one agent".
 * It cannot be constructed when dev providers are not allowed (e.g. production).
 */
import { DevSignInRequestSchema } from '@warden/shared';
import { devProvidersAllowed, type Env } from '../../config/env.js';
import { sha256Hex } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import type {
  IdentityProvider,
  SignInContext,
  StartSignInResult,
  VerifiedIdentity,
} from './identity-provider.js';

export const DEV_ISSUER = 'dev';

export function normaliseDevName(displayName: string): string {
  return displayName.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function devSubject(displayName: string): string {
  return sha256Hex(`warden-dev:${normaliseDevName(displayName)}`);
}

export class DevIdentityProvider implements IdentityProvider {
  readonly kind = 'dev' as const;

  constructor(env: Pick<Env, 'NODE_ENV' | 'ALLOW_DEV_PROVIDERS'>) {
    if (!devProvidersAllowed(env)) {
      throw new Error(
        'DevIdentityProvider requires ALLOW_DEV_PROVIDERS=true and NODE_ENV!=production',
      );
    }
  }

  async startSignIn(_ctx: SignInContext): Promise<StartSignInResult> {
    return { devForm: true };
  }

  async completeSignIn(input: unknown): Promise<VerifiedIdentity> {
    const parsed = DevSignInRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        parsed.error.issues[0]?.message ?? 'Invalid name',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return {
      iss: DEV_ISSUER,
      sub: devSubject(parsed.data.displayName),
      authTime: new Date(),
      amr: ['dev'],
    };
  }
}
