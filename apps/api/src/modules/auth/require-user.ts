import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { bearerToken, type AuthContext } from './session-service.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

/** preHandler: requires a valid bearer session and attaches `request.auth`. */
export async function requireUser(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = bearerToken(request.headers.authorization);
  if (!token) throw AppError.unauthorized();
  const auth = await request.server.deps.sessions.authenticate(token);
  if (!auth) {
    throw new AppError('SESSION_EXPIRED', 401, 'Your session has expired. Please sign in again.');
  }
  request.auth = auth;
}

/** Returns the authenticated context inside a handler guarded by `requireUser`. */
export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw AppError.unauthorized();
  return request.auth;
}
