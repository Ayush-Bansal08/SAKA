/**
 * Onboarding state machine on User.onboardingStep (PHASE 03 §2):
 *
 *   VERIFY ──(sign-in / World enrollment)──▶ WALLET ──POST /onboarding/wallet──▶ PROFILE
 *   PROFILE ──POST /onboarding/profile──▶ FUND ──(balance watcher: first native deposit)──▶ DONE
 *
 * Transitions are compare-and-set (`updateMany where step = from`), so retries and concurrent
 * requests can never skip or repeat a step. Choosing the first profile needs no step-up; once
 * onboarding is DONE, profile changes go through STEP_UP (PHASE 10).
 */
import { Prisma, type PrismaClient, type User } from '@prisma/client';
import {
  CHAINS,
  CIRCLE_USDC_FAUCET_URL,
  DEFAULT_ETH_FAUCETS,
  Decimal,
  ONBOARDING_STEPS,
  fromRaw,
  riskProfileSettings,
  type LimitsView,
  type OnboardingResponse,
  type OnboardingStep,
  type RiskProfile,
} from '@warden/shared';
import { randomUUID } from 'node:crypto';
import type { AllowlistEntry } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import type { TraceBus } from '../trace/trace-bus.js';
import { dec } from '../portfolio/fifo.js';
import { executionTokens, findToken } from '../wallet/tokens.js';
import {
  ensureAgentWallet,
  findAgentWallet,
  toWalletView,
  type WalletServiceDeps,
} from '../wallet/wallet-service.js';

export const SUGGESTED_FIRST_DEPOSIT_ETH = '0.05';

export interface OnboardingDeps extends WalletServiceDeps {
  traceBus: Pick<TraceBus, 'emit'>;
  allowlist: readonly AllowlistEntry[];
  faucets: { ethUrl?: string | undefined; usdcUrl: string };
}

const order = (step: OnboardingStep) => ONBOARDING_STEPS.indexOf(step);

export function isAtOrPast(step: OnboardingStep, target: OnboardingStep): boolean {
  return order(step) >= order(target);
}

/** Moves the user from `from` to `to` only if they are still at `from`. */
export async function advanceStep(
  prisma: PrismaClient,
  userId: string,
  from: OnboardingStep,
  to: OnboardingStep,
): Promise<boolean> {
  const res = await prisma.user.updateMany({
    where: { id: userId, onboardingStep: from },
    data: { onboardingStep: to },
  });
  return res.count === 1;
}

export function limitsForProfile(profile: RiskProfile) {
  const s = riskProfileSettings(profile);
  return {
    perActionUsd: new Prisma.Decimal(s.perActionUsd),
    perDayUsd: new Prisma.Decimal(s.perDayUsd),
    maxSlippagePct: new Prisma.Decimal(s.maxSlippagePct),
    minTradeScoreAuto: s.minTradeScoreAuto,
    hookPolicy: s.hooksWithoutApproval,
  };
}

export function toLimitsView(
  profile: RiskProfile,
  limits: {
    perActionUsd: Prisma.Decimal;
    perDayUsd: Prisma.Decimal;
    maxSlippagePct: Prisma.Decimal;
    minTradeScoreAuto: number;
    hookPolicy: LimitsView['hookPolicy'];
  },
): LimitsView {
  return {
    riskProfile: profile,
    perActionUsd: dec(new Decimal(limits.perActionUsd.toString()), 2),
    perDayUsd: dec(new Decimal(limits.perDayUsd.toString()), 2),
    maxSlippagePct: dec(new Decimal(limits.maxSlippagePct.toString()), 3),
    minTradeScoreAuto: limits.minTradeScoreAuto,
    hookPolicy: limits.hookPolicy,
  };
}

const PROFILE_LABEL: Record<RiskProfile, string> = {
  CAREFUL: 'Careful',
  BALANCED: 'Balanced',
  ADVENTUROUS: 'Adventurous',
};

export async function onboardingView(
  deps: OnboardingDeps,
  userId: string,
): Promise<OnboardingResponse> {
  const user = await deps.prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { wallet: true, limits: true },
  });
  const profileChosen = isAtOrPast(user.onboardingStep, 'FUND');
  const firstLot = await deps.prisma.tokenLot.findFirst({
    where: { userId, source: 'DEPOSIT' },
    orderBy: { createdAt: 'asc' },
  });
  const tokens = executionTokens(deps.chainId, deps.allowlist);
  const lotToken = firstLot ? findToken(tokens, firstLot.tokenAddress) : undefined;
  const chain = CHAINS[deps.chainId];

  return {
    step: user.onboardingStep,
    wallet: user.wallet ? toWalletView(user.wallet) : null,
    profile: profileChosen ? user.riskProfile : null,
    limits: profileChosen && user.limits ? toLimitsView(user.riskProfile, user.limits) : null,
    funding: {
      chainId: deps.chainId,
      faucets: [
        {
          label: `${chain.name} ETH faucet`,
          url: deps.faucets.ethUrl ?? DEFAULT_ETH_FAUCETS[deps.chainId],
          asset: 'ETH',
        },
        {
          label: 'Circle USDC faucet',
          url: deps.faucets.usdcUrl || CIRCLE_USDC_FAUCET_URL,
          asset: 'USDC',
        },
      ],
      suggestedEth: SUGGESTED_FIRST_DEPOSIT_ETH,
      firstDeposit:
        firstLot && lotToken
          ? {
              symbol: lotToken.symbol,
              amount: fromRaw(BigInt(firstLot.amountRaw), lotToken.decimals),
              valueUsd: firstLot.costUsd.gt(0)
                ? dec(new Decimal(firstLot.costUsd.toString()), 2)
                : null,
              at: firstLot.createdAt.toISOString(),
            }
          : null,
    },
  };
}

/** POST /onboarding/wallet — creates the agent wallet + policy; WALLET → PROFILE. */
export async function createWalletStep(
  deps: OnboardingDeps,
  user: User,
): Promise<OnboardingResponse> {
  if (user.onboardingStep === 'VERIFY') {
    throw new AppError(
      'ONBOARDING_OUT_OF_ORDER',
      409,
      'Verify that you are a human before creating an agent wallet.',
      { step: user.onboardingStep },
    );
  }
  const { wallet, created } = await ensureAgentWallet(deps, user.id);
  await advanceStep(deps.prisma, user.id, 'WALLET', 'PROFILE');
  if (created) {
    await deps.traceBus.emit({
      kind: 'system',
      traceId: randomUUID(),
      userId: user.id,
      title: 'Agent wallet created',
      detail: `${wallet.address} on ${CHAINS[deps.chainId].name}${
        wallet.policyId ? ' · Privy policy attached' : ' · backend policy only'
      }`,
      data: { address: wallet.address, chainId: wallet.chainId, policyId: wallet.policyId },
    });
  }
  return onboardingView(deps, user.id);
}

/** POST /onboarding/profile — writes the profile + limits; PROFILE → FUND. */
export async function chooseProfileStep(
  deps: OnboardingDeps,
  user: User,
  riskProfile: RiskProfile,
): Promise<OnboardingResponse> {
  const step = user.onboardingStep;
  if (!isAtOrPast(step, 'PROFILE')) {
    throw new AppError(
      'ONBOARDING_OUT_OF_ORDER',
      409,
      'Create your agent wallet before choosing a risk profile.',
      { step },
    );
  }
  if (step === 'DONE') {
    throw new AppError(
      'STEP_UP_REQUIRED',
      409,
      'Changing your risk profile needs a fresh World ID verification (coming in Phase 10).',
      { reason: 'RISK_PROFILE_CHANGE', availableIn: 'Phase 10' },
    );
  }
  if (!(await findAgentWallet(deps.prisma, user.id))) {
    throw new AppError('ONBOARDING_OUT_OF_ORDER', 409, 'Create your agent wallet first.', { step });
  }

  const limits = limitsForProfile(riskProfile);
  const moved = await deps.prisma.$transaction(async (tx) => {
    // Re-check inside the transaction: the profile can only be (re)chosen before funding.
    const res = await tx.user.updateMany({
      where: { id: user.id, onboardingStep: { in: ['PROFILE', 'FUND'] } },
      data: { riskProfile, onboardingStep: 'FUND' },
    });
    if (res.count !== 1) return false;
    await tx.limits.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...limits },
      update: limits,
    });
    return true;
  });
  if (!moved) {
    throw new AppError(
      'STEP_UP_REQUIRED',
      409,
      'Your agent is already funded; changing the profile now needs World ID (coming in Phase 10).',
      { reason: 'RISK_PROFILE_CHANGE', availableIn: 'Phase 10' },
    );
  }
  const s = riskProfileSettings(riskProfile);
  await deps.traceBus.emit({
    kind: 'policy',
    traceId: randomUUID(),
    userId: user.id,
    title: `Risk profile: ${PROFILE_LABEL[riskProfile]}`,
    detail: `Agent alone: up to $${s.perActionUsd} per action, $${s.perDayUsd} per day, ${s.maxSlippagePct}% max slippage`,
    data: { riskProfile, ...s },
  });
  return onboardingView(deps, user.id);
}
