/**
 * Passkeys (WebAuthn): sign-up, sign-in and approvals. Every challenge is single use and expires
 * in 5 minutes. An APPROVE challenge is derived from the approval id and plan hash, so the
 * signature covers exactly one pending action. User verification (fingerprint, face, PIN) is
 * always required.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient, PasskeyChallenge, PasskeyPurpose, User } from '@prisma/client';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { PasskeyOptionsResponse, PasskeyVerifyRequest } from '@warden/shared';
import type { Env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { findOrCreateUserForIdentity } from '../users/user-service.js';
import type { VerifiedIdentity } from './identity-provider.js';

export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60_000;
export const PASSKEY_ACR = 'passkey';
export const PASSKEY_AMR = ['webauthn'];

type PasskeyEnv = Pick<Env, 'APP_NAME' | 'WEB_URL' | 'WEBAUTHN_RP_ID'>;

export function passkeyRpId(env: PasskeyEnv): string {
  return env.WEBAUTHN_RP_ID ?? new URL(env.WEB_URL).hostname;
}

export function passkeyIssuer(env: PasskeyEnv): string {
  return `passkey:${passkeyRpId(env)}`;
}

/** 403, not 401: a failed check must not look like an expired session to the web app. */
function rejected(message = 'That passkey could not be verified. Please try again.'): AppError {
  return new AppError('FORBIDDEN', 403, message);
}

export interface ApprovalTarget {
  id: string;
  planHash: string;
}

export class PasskeyService {
  private readonly rpID: string;
  private readonly issuer: string;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: PasskeyEnv,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.rpID = passkeyRpId(env);
    this.issuer = passkeyIssuer(env);
  }

  async registrationOptions(displayName: string): Promise<PasskeyOptionsResponse> {
    const subject = randomUUID();
    const options = await generateRegistrationOptions({
      rpName: this.env.APP_NAME,
      rpID: this.rpID,
      userName: displayName,
      userDisplayName: displayName,
      userID: new TextEncoder().encode(subject),
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const row = await this.saveChallenge('REGISTER', options.challenge, { subject, displayName });
    return { challengeId: row.id, options: { ...options } };
  }

  /** Creates the account and its first passkey. */
  async verifyRegistration(input: PasskeyVerifyRequest) {
    const challenge = await this.consume(input.challengeId, 'REGISTER');
    if (!challenge.subject) throw rejected();
    const result = await verifyRegistrationResponse({
      response: input.response as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: this.env.WEB_URL,
      expectedRPID: this.rpID,
      requireUserVerification: true,
    }).catch(() => {
      throw rejected();
    });
    if (!result.verified || !result.registrationInfo) throw rejected();

    const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
    const { user, created } = await findOrCreateUserForIdentity(
      this.prisma,
      {
        iss: this.issuer,
        sub: challenge.subject,
        authTime: this.now(),
        acr: PASSKEY_ACR,
        amr: PASSKEY_AMR,
      },
      'passkey',
      challenge.displayName ?? undefined,
    );
    await this.prisma.passkeyCredential.create({
      data: {
        userId: user.id,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        transports: credential.transports ?? [],
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        lastUsedAt: this.now(),
      },
    });
    return { user, created };
  }

  /** No allow-list: the browser offers whichever passkey the human has for this site. */
  async signInOptions(): Promise<PasskeyOptionsResponse> {
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      userVerification: 'required',
    });
    const row = await this.saveChallenge('SIGN_IN', options.challenge);
    return { challengeId: row.id, options: { ...options } };
  }

  async verifySignIn(input: PasskeyVerifyRequest): Promise<VerifiedIdentity> {
    const challenge = await this.consume(input.challengeId, 'SIGN_IN');
    const user = await this.verifyAssertion(challenge.challenge, input);
    return this.identityOf(user);
  }

  async approvalOptions(user: User, target: ApprovalTarget): Promise<PasskeyOptionsResponse> {
    const credentials = await this.prisma.passkeyCredential.findMany({
      where: { userId: user.id },
    });
    if (credentials.length === 0) {
      throw new AppError('CONFLICT', 409, 'This account has no passkey to approve with.');
    }
    const bound = createHash('sha256')
      .update(`${randomBytes(32).toString('hex')}:${target.id}:${target.planHash}`)
      .digest();
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      challenge: new Uint8Array(bound),
      userVerification: 'required',
      allowCredentials: credentials.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransport[],
      })),
    });
    const row = await this.saveChallenge('APPROVE', options.challenge, {
      approvalId: target.id,
      planHash: target.planHash,
    });
    return { challengeId: row.id, options: { ...options } };
  }

  /** Proves the account owner signed this approval's challenge. Changes no approval state. */
  async verifyApproval(
    user: User,
    target: ApprovalTarget,
    input: PasskeyVerifyRequest,
  ): Promise<VerifiedIdentity> {
    const challenge = await this.consume(input.challengeId, 'APPROVE');
    if (challenge.approvalId !== target.id || challenge.planHash !== target.planHash) {
      throw rejected('That passkey check was for a different action.');
    }
    const signer = await this.verifyAssertion(challenge.challenge, input);
    if (signer.id !== user.id) throw rejected("This isn't the account owner's passkey.");
    return this.identityOf(signer);
  }

  private identityOf(user: User): VerifiedIdentity {
    return {
      iss: user.identityIss,
      sub: user.identitySub,
      authTime: this.now(),
      acr: PASSKEY_ACR,
      amr: PASSKEY_AMR,
    };
  }

  private async verifyAssertion(expectedChallenge: string, input: PasskeyVerifyRequest) {
    const response = input.response as unknown as AuthenticationResponseJSON;
    if (typeof response.id !== 'string') throw rejected();
    const stored = await this.prisma.passkeyCredential.findUnique({
      where: { credentialId: response.id },
      include: { user: true },
    });
    if (!stored) throw rejected();

    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: this.env.WEB_URL,
      expectedRPID: this.rpID,
      requireUserVerification: true,
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(stored.publicKey),
        counter: Number(stored.counter),
        transports: stored.transports as AuthenticatorTransport[],
      },
    }).catch(() => {
      throw rejected();
    });
    if (!result.verified) throw rejected();

    await this.prisma.passkeyCredential.update({
      where: { id: stored.id },
      data: {
        counter: BigInt(result.authenticationInfo.newCounter),
        backedUp: result.authenticationInfo.credentialBackedUp,
        lastUsedAt: this.now(),
      },
    });
    return stored.user;
  }

  private async saveChallenge(
    purpose: PasskeyPurpose,
    challenge: string,
    extra: Partial<
      Pick<PasskeyChallenge, 'subject' | 'displayName' | 'approvalId' | 'planHash'>
    > = {},
  ): Promise<PasskeyChallenge> {
    const now = this.now();
    await this.prisma.passkeyChallenge.deleteMany({ where: { expiresAt: { lt: now } } });
    return this.prisma.passkeyChallenge.create({
      data: {
        purpose,
        challenge,
        ...extra,
        expiresAt: new Date(now.getTime() + PASSKEY_CHALLENGE_TTL_MS),
      },
    });
  }

  /** Atomically claims a challenge, so a replayed response can never pass twice. */
  private async consume(id: string, purpose: PasskeyPurpose): Promise<PasskeyChallenge> {
    const now = this.now();
    const claimed = await this.prisma.passkeyChallenge.updateMany({
      where: { id, purpose, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) throw rejected('That passkey check expired. Please try again.');
    return this.prisma.passkeyChallenge.findUniqueOrThrow({ where: { id } });
  }
}
