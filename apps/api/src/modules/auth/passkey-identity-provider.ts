import { PasskeyVerifyRequestSchema } from '@warden/shared';
import { AppError } from '../../lib/errors.js';
import type {
  IdentityProvider,
  SignInContext,
  StartSignInResult,
  VerifiedIdentity,
} from './identity-provider.js';
import type { PasskeyService } from './passkey-service.js';

export class PasskeyIdentityProvider implements IdentityProvider {
  readonly kind = 'passkey' as const;

  constructor(private readonly passkeys: PasskeyService) {}

  async startSignIn(_ctx: SignInContext): Promise<StartSignInResult> {
    return { passkey: true };
  }

  async completeSignIn(input: unknown): Promise<VerifiedIdentity> {
    const parsed = PasskeyVerifyRequestSchema.safeParse(input);
    if (!parsed.success) throw AppError.badRequest('Invalid passkey response.');
    return this.passkeys.verifySignIn(parsed.data);
  }
}
