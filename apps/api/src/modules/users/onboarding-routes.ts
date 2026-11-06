import { OnboardingProfileRequestSchema, OnboardingResponseSchema } from '@warden/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sha256Hex } from '../../lib/crypto.js';
import { authOf, requireUser } from '../auth/require-user.js';
import {
  chooseProfileStep,
  createWalletStep,
  onboardingView,
  type OnboardingDeps,
} from './onboarding.js';

export function onboardingDeps(app: FastifyInstance): OnboardingDeps {
  const { env, prisma, traceBus, wallets } = app.deps;
  return {
    prisma,
    wallets,
    traceBus,
    chainId: env.EXECUTION_CHAIN_ID,
    allowlist: env.TOKEN_ALLOWLIST_JSON,
    faucets: { ethUrl: env.FAUCET_ETH_URL, usdcUrl: env.FAUCET_USDC_URL },
  };
}

/**
 * Wallet creation talks to Privy: keep it well below the global limit. Keyed by session (not
 * IP), so users behind one NAT don't throttle each other.
 */
const WALLET_RATE_LIMIT = {
  max: 10,
  timeWindow: '1 minute',
  keyGenerator: (request: FastifyRequest) =>
    `onboarding-wallet:${sha256Hex(request.headers.authorization ?? request.ip)}`,
};

export const onboardingRoutes: FastifyPluginAsyncZod = async (app) => {
  const deps = onboardingDeps(app);

  app.get(
    '/onboarding',
    { preHandler: requireUser, schema: { response: { 200: OnboardingResponseSchema } } },
    async (request) => onboardingView(deps, authOf(request).user.id),
  );

  app.post(
    '/onboarding/wallet',
    {
      preHandler: requireUser,
      config: { rateLimit: WALLET_RATE_LIMIT },
      schema: { response: { 200: OnboardingResponseSchema } },
    },
    async (request) => createWalletStep(deps, authOf(request).user),
  );

  app.post(
    '/onboarding/profile',
    {
      preHandler: requireUser,
      schema: { body: OnboardingProfileRequestSchema, response: { 200: OnboardingResponseSchema } },
    },
    async (request) => chooseProfileStep(deps, authOf(request).user, request.body.riskProfile),
  );
};
