/**
 * Opaque bearer sessions. The client receives a random 32-byte token; only its
 * sha256 is stored. Bearer headers (not cookies) keep Vercel ↔ API cross-origin
 * auth working without third-party cookies.
 */
import type { PrismaClient, User } from '@prisma/client';
import { randomToken, sha256Hex } from '../../lib/crypto.js';

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

export interface AuthContext {
  user: User;
  sessionId: string;
}

const MAX_TOKEN_LENGTH = 128;

export class SessionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ttlHours: number,
  ) {}

  async create(
    userId: string,
    meta: SessionMeta = {},
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + this.ttlHours * 3_600_000);
    await this.prisma.session.create({
      data: {
        userId,
        tokenHash: sha256Hex(token),
        expiresAt,
        ip: meta.ip?.slice(0, 64),
        userAgent: meta.userAgent?.slice(0, 256),
      },
    });
    return { token, expiresAt };
  }

  /** Returns the session's user, or null for unknown, revoked or expired tokens. */
  async authenticate(token: string): Promise<AuthContext | null> {
    if (!token || token.length > MAX_TOKEN_LENGTH) return null;
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null;
    return { user: session.user, sessionId: session.id };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

/** Extracts the token from `Authorization: Bearer <token>`. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+([A-Za-z0-9_-]+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
