import { MeResponseSchema } from '@warden/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authOf, requireUser } from '../auth/require-user.js';
import { toUserView } from './user-service.js';

export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/me',
    { preHandler: requireUser, schema: { response: { 200: MeResponseSchema } } },
    async (request) => ({ user: toUserView(authOf(request).user) }),
  );
};
