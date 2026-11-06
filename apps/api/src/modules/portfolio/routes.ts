import { PortfolioResponseSchema } from '@warden/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authOf, requireUser } from '../auth/require-user.js';
import { findAgentWallet } from '../wallet/wallet-service.js';
import { buildPortfolio } from './service.js';

export const portfolioRoutes: FastifyPluginAsyncZod = async (app) => {
  const { env, prisma, prices, balances } = app.deps;

  app.get(
    '/portfolio',
    { preHandler: requireUser, schema: { response: { 200: PortfolioResponseSchema } } },
    async (request) => {
      const { user } = authOf(request);
      const wallet = await findAgentWallet(prisma, user.id);
      return buildPortfolio(
        {
          prisma,
          prices,
          balances,
          chainId: env.EXECUTION_CHAIN_ID,
          allowlist: env.TOKEN_ALLOWLIST_JSON,
        },
        user,
        wallet,
      );
    },
  );
};
