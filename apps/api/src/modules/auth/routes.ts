import {
  DevSignInRequestSchema,
  DisplayNameSchema,
  PasskeyOptionsResponseSchema,
  PasskeyVerifyRequestSchema,
  ProvidersResponseSchema,
  SignInResponseSchema,
} from '@warden/shared';
import type { User } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { devProvidersAllowed } from '../../config/env.js';
import { findOrCreateUserForIdentity, toUserView } from '../users/user-service.js';
import { authOf, requireUser } from './require-user.js';

/** Stricter per-IP limit for sign-in endpoints. */
export const AUTH_RATE_LIMIT = { max: 20, timeWindow: '1 minute' } as const;

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const { env } = app.deps;

  app.get(
    '/auth/providers',
    { schema: { response: { 200: ProvidersResponseSchema } } },
    async () => ({
      appName: env.APP_NAME,
      identity: env.AUTH_MODE,
      approvals: env.APPROVAL_MODE,
      executionChainId: env.EXECUTION_CHAIN_ID,
      ...(env.ENABLE_DEMO_SIMULATOR ? { demoSimulator: true } : {}),
    }),
  );

  // The DEV sign-in route does not exist at all unless dev providers are allowed.
  if (env.AUTH_MODE === 'dev' && devProvidersAllowed(env) && app.deps.identity.kind === 'dev') {
    app.post(
      '/auth/dev/sign-in',
      {
        config: { rateLimit: AUTH_RATE_LIMIT },
        schema: {
          body: DevSignInRequestSchema,
          response: { 200: SignInResponseSchema },
        },
      },
      async (request) => {
        const identity = await app.deps.identity.completeSignIn(request.body);
        const { user, created } = await findOrCreateUserForIdentity(
          app.deps.prisma,
          identity,
          'dev',
          request.body.displayName,
        );
        const session = await app.deps.sessions.create(user.id, {
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });
        request.log.info({ userId: user.id, created }, 'dev sign-in');
        return {
          token: session.token,
          expiresAt: session.expiresAt.toISOString(),
          user: toUserView(user),
        };
      },
    );
  }

  if (env.AUTH_MODE === 'passkey') {
    const { passkeys, prisma, sessions, identity } = app.deps;
    const signedIn = async (request: FastifyRequest, user: User) => {
      const session = await sessions.create(user.id, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      return {
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
        user: toUserView(user),
      };
    };

    app.post(
      '/auth/passkey/register/options',
      {
        config: { rateLimit: AUTH_RATE_LIMIT },
        schema: {
          body: z.object({ displayName: DisplayNameSchema }),
          response: { 200: PasskeyOptionsResponseSchema },
        },
      },
      (request) => passkeys.registrationOptions(request.body.displayName),
    );

    app.post(
      '/auth/passkey/register/verify',
      {
        config: { rateLimit: AUTH_RATE_LIMIT },
        schema: { body: PasskeyVerifyRequestSchema, response: { 200: SignInResponseSchema } },
      },
      async (request) => {
        const { user } = await passkeys.verifyRegistration(request.body);
        request.log.info({ userId: user.id }, 'passkey registered');
        return signedIn(request, user);
      },
    );

    app.post(
      '/auth/passkey/sign-in/options',
      {
        config: { rateLimit: AUTH_RATE_LIMIT },
        schema: { response: { 200: PasskeyOptionsResponseSchema } },
      },
      () => passkeys.signInOptions(),
    );

    app.post(
      '/auth/passkey/sign-in/verify',
      {
        config: { rateLimit: AUTH_RATE_LIMIT },
        schema: { body: PasskeyVerifyRequestSchema, response: { 200: SignInResponseSchema } },
      },
      async (request) => {
        const verified = await identity.completeSignIn(request.body);
        const user = await prisma.user.update({
          where: {
            identityIss_identitySub: { identityIss: verified.iss, identitySub: verified.sub },
          },
          data: { lastAuthAt: verified.authTime },
        });
        request.log.info({ userId: user.id }, 'passkey sign-in');
        return signedIn(request, user);
      },
    );
  }

  app.post(
    '/auth/sign-out',
    {
      preHandler: requireUser,
      schema: { response: { 200: z.object({ ok: z.literal(true) }) } },
    },
    async (request) => {
      await app.deps.sessions.revoke(authOf(request).sessionId);
      return { ok: true as const };
    },
  );
};
