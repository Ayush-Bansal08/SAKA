/**
 * Pluggable identity (PHASE_00 §7). PHASE 01 ships the DEV provider; PHASE 10
 * adds WorldIdentityProvider (World ID Agent Pass, OIDC) behind this interface.
 */
import type { ProviderKind } from '@warden/shared';

export interface SignInContext {
  ip?: string;
  userAgent?: string;
}

export type StartSignInResult = { redirectUrl: string } | { devForm: true };

/** A human identity that the provider has validated server-side. */
export interface VerifiedIdentity {
  iss: string;
  sub: string;
  authTime: Date;
  acr?: string;
  amr?: string[];
}

export interface IdentityProvider {
  kind: ProviderKind;
  startSignIn(ctx: SignInContext): Promise<StartSignInResult>;
  /** Validates provider-specific input and returns the verified human. Never trusts the client. */
  completeSignIn(input: unknown): Promise<VerifiedIdentity>;
}
