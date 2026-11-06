import type { FastifyReply, FastifyRequest } from 'fastify';
import { activityKey } from '../../lib/activity.js';
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
  markActive(request, auth.user.id);
}

/** Balance-watcher back-off reads this key (absent → inactive for more than 24 h). */
export const ACTIVITY_TTL_SECONDS = 24 * 3_600;
const ACTIVITY_THROTTLE_MS = 60_000;
const lastMarked = new Map<string, number>();

function markActive(request: FastifyRequest, userId: string): void {
  const now = Date.now();
  if (now - (lastMarked.get(userId) ?? 0) < ACTIVITY_THROTTLE_MS) return;
  lastMarked.set(userId, now);
  if (lastMarked.size > 10_000) lastMarked.clear();
  void request.server.deps.redis
    .set(activityKey(userId), String(now), 'EX', ACTIVITY_TTL_SECONDS)
    .catch(() => undefined);
}

/** Returns the authenticated context inside a handler guarded by `requireUser`. */
export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw AppError.unauthorized();
  return request.auth;
}
