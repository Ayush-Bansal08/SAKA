/**
 * Telegram API (PHASE 08 §4).
 *   POST /telegram/link-code   one-time code → t.me link (10 min)
 *   POST /telegram/disconnect  unlink this account
 *   PUT  /telegram/mute        { muted }
 *   POST /telegram/webhook     updates from Telegram (production; needs TELEGRAM_WEBHOOK_SECRET)
 */
import { timingSafeEqual } from 'node:crypto';
import { TelegramLinkResponseSchema, TelegramMuteRequestSchema } from '@warden/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Bot } from 'grammy';
import { AppError } from '../../lib/errors.js';
import { authOf, requireUser } from '../auth/require-user.js';
import { modeBDepsFrom } from '../modeb/routes.js';
import { createBot } from './bot.js';
import { createLinkCode } from './link.js';

export const telegramRoutes: FastifyPluginAsyncZod = async (app) => {
  const d = app.deps;
  const { prisma, env, traceBus } = d;

  app.post(
    '/telegram/link-code',
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { response: { 200: TelegramLinkResponseSchema } },
    },
    async (request) => {
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_BOT_USERNAME)
        throw new AppError('SERVICE_UNAVAILABLE', 503, 'Telegram is not set up on this server.');
      const { user } = authOf(request);
      if (user.telegramChatId)
        throw new AppError('CONFLICT', 409, 'Telegram is already connected.');
      const { code, expiresAt } = await createLinkCode(prisma, user.id, new Date());
      return {
        url: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=${code}`,
        expiresAt: expiresAt.toISOString(),
      };
    },
  );

  app.post('/telegram/disconnect', { preHandler: requireUser }, async (request) => {
    const { user } = authOf(request);
    await prisma.user.update({
      where: { id: user.id },
      data: { telegramChatId: null, telegramMuted: false },
    });
    await traceBus.emit({
      traceId: `telegram-${user.id}`,
      userId: user.id,
      kind: 'system',
      title: 'Telegram disconnected',
      detail: 'Alerts stay in your inbox.',
    });
    return { ok: true as const };
  });

  app.put(
    '/telegram/mute',
    { preHandler: requireUser, schema: { body: TelegramMuteRequestSchema } },
    async (request) => {
      const { user } = authOf(request);
      if (!user.telegramChatId) throw new AppError('CONFLICT', 409, 'Connect Telegram first.');
      await prisma.user.update({
        where: { id: user.id },
        data: { telegramMuted: request.body.muted },
      });
      return { muted: request.body.muted };
    },
  );

  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret } = env;
  if (!token || !secret) return;
  const expected = Buffer.from(secret);
  let bot: Bot | null = null;
  app.post('/telegram/webhook', { config: { rateLimit: false } }, async (request) => {
    const header = request.headers['x-telegram-bot-api-secret-token'];
    const given = Buffer.from(typeof header === 'string' ? header : '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw new AppError('UNAUTHORIZED', 401, 'Bad webhook secret.');
    if (!bot) {
      bot = createBot({
        token,
        secret: env.ENCRYPTION_KEY,
        webUrl: env.WEB_URL,
        appName: env.APP_NAME,
        prisma,
        traceBus,
        modeB: modeBDepsFrom(d),
        log: d.log,
      });
      await bot.init();
    }
    await bot.handleUpdate(request.body as Parameters<Bot['handleUpdate']>[0]);
    return { ok: true as const };
  });
};
