import { Prisma, type PrismaClient, type User } from '@prisma/client';
import {
  DEFAULT_RISK_PROFILE,
  riskProfileSettings,
  type ProviderKind,
  type UserView,
} from '@warden/shared';
import type { VerifiedIdentity } from '../auth/identity-provider.js';

/** Default limits for a new user, from the default risk profile (PHASE_00 §9). */
function defaultLimits(): Omit<Prisma.LimitsCreateWithoutUserInput, 'id'> {
  const s = riskProfileSettings(DEFAULT_RISK_PROFILE);
  return {
    perActionUsd: new Prisma.Decimal(s.perActionUsd),
    perDayUsd: new Prisma.Decimal(s.perDayUsd),
    maxSlippagePct: new Prisma.Decimal(s.maxSlippagePct),
    minTradeScoreAuto: s.minTradeScoreAuto,
    hookPolicy: s.hooksWithoutApproval,
  };
}

/**
 * Finds or creates the single user for a verified human (one human = one agent,
 * enforced by the unique (identityIss, identitySub) constraint).
 */
export async function findOrCreateUserForIdentity(
  prisma: PrismaClient,
  identity: VerifiedIdentity,
  kind: ProviderKind,
  displayName?: string,
): Promise<{ user: User; created: boolean }> {
  const where = {
    identityIss_identitySub: { identityIss: identity.iss, identitySub: identity.sub },
  };
  const now = new Date();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await prisma.user.findUnique({ where });
    if (existing) {
      const user = await prisma.user.update({
        where: { id: existing.id },
        data: { lastAuthAt: identity.authTime, ...(displayName ? { displayName } : {}) },
      });
      return { user, created: false };
    }
    try {
      const user = await prisma.user.create({
        data: {
          identityIss: identity.iss,
          identitySub: identity.sub,
          identityKind: kind,
          verifiedAt: now,
          lastAuthAt: identity.authTime,
          displayName: displayName ?? null,
          riskProfile: DEFAULT_RISK_PROFILE,
          // Identity is verified at sign-in, so onboarding continues at the wallet step.
          onboardingStep: 'WALLET',
          limits: { create: defaultLimits() },
        },
      });
      return { user, created: true };
    } catch (err) {
      // A concurrent sign-in for the same human won the race: loop and read it.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
      throw err;
    }
  }
  throw new Error('Could not resolve user for identity after retry');
}

export function toUserView(user: User): UserView {
  return {
    id: user.id,
    displayName: user.displayName,
    identityKind: user.identityKind,
    verifiedAt: user.verifiedAt?.toISOString() ?? null,
    lastAuthAt: user.lastAuthAt?.toISOString() ?? null,
    timezone: user.timezone,
    riskProfile: user.riskProfile,
    onboardingStep: user.onboardingStep,
    telegramLinked: user.telegramChatId !== null,
    createdAt: user.createdAt.toISOString(),
  };
}
