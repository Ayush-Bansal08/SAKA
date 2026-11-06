/**
 * Telegram account link (PHASE 08 §4): a one-time code, 10 minutes, stored only as a sha256. Used
 * atomically, so the same code can never bind two chats. One chat ↔ one user, both ways: the
 * unique column on User is the final word if two links race.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient, type User } from '@prisma/client';

export const LINK_CODE_TTL_MS = 10 * 60_000;

const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');

export async function createLinkCode(
  prisma: PrismaClient,
  userId: string,
  now: Date,
): Promise<{ code: string; expiresAt: Date }> {
  const code = randomBytes(18).toString('base64url');
  const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MS);
  await prisma.$transaction([
    // A new code replaces any earlier one.
    prisma.telegramLinkCode.deleteMany({ where: { userId, usedAt: null } }),
    prisma.telegramLinkCode.create({ data: { userId, codeHash: hashCode(code), expiresAt } }),
  ]);
  return { code, expiresAt };
}

export type LinkResult =
  { ok: true; user: User } | { ok: false; reason: 'invalid' | 'chat_taken' | 'user_taken' };

export async function redeemLinkCode(
  prisma: PrismaClient,
  code: string,
  chatId: string,
  now: Date,
): Promise<LinkResult> {
  const row = await prisma.telegramLinkCode.findUnique({ where: { codeHash: hashCode(code) } });
  if (!row || row.usedAt || row.expiresAt.getTime() <= now.getTime())
    return { ok: false, reason: 'invalid' };

  const inChat = await prisma.user.findUnique({ where: { telegramChatId: chatId } });
  if (inChat && inChat.id !== row.userId) return { ok: false, reason: 'chat_taken' };
  const owner = await prisma.user.findUnique({ where: { id: row.userId } });
  if (!owner) return { ok: false, reason: 'invalid' };
  if (owner.telegramChatId && owner.telegramChatId !== chatId)
    return { ok: false, reason: 'user_taken' };

  try {
    const user = await prisma.$transaction(async (tx) => {
      const used = await tx.telegramLinkCode.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: now },
      });
      if (used.count !== 1) return null;
      return tx.user.update({
        where: { id: row.userId },
        data: { telegramChatId: chatId, telegramMuted: false },
      });
    });
    return user ? { ok: true, user } : { ok: false, reason: 'invalid' };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
      return { ok: false, reason: 'chat_taken' };
    throw err;
  }
}
