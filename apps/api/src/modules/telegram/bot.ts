/**
 * Telegram bot (PHASE 08 §4). Strictly: account link, alert buttons, mute. It is not a chatbot:
 * anything else gets one fixed line pointing at the web app, and no text ever reaches a model.
 * Every button is checked twice: the HMAC proves we issued it, the chat proves who pressed it.
 */
import type { PrismaClient } from '@prisma/client';
import { Bot, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { AppError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import {
  acceptSuggestion,
  changeSuggestion,
  declineSuggestion,
  type ModeBDeps,
} from '../modeb/suggestions.js';
import { verifyCallback } from './callback.js';
import { redeemLinkCode } from './link.js';

export interface BotDeps {
  token: string;
  /** Signs and checks button tokens (ENCRYPTION_KEY). */
  secret: string;
  webUrl: string;
  appName: string;
  prisma: PrismaClient;
  traceBus: Pick<ModeBDeps['traceBus'], 'emit'>;
  /** null without MCP: buttons answer that the agent is unavailable. */
  modeB: ModeBDeps | null;
  log?: Pick<Logger, 'warn' | 'info'>;
  now?: () => Date;
  /** Skips getMe (tests). */
  botInfo?: UserFromGetMe;
}

export const BOT_COPY = {
  help: (app: string, web: string) =>
    `I send you ${app} alerts and approval requests, nothing else. To ask your agent for something, use the web app: ${web}\n\n/stop mutes alerts. /resume turns them back on.`,
  redirect: (web: string) => `I only send alerts. To talk to your agent, use the web app: ${web}`,
  welcome: (web: string) =>
    `Connect this chat from Settings in the web app, then tap the link it gives you: ${web}/settings`,
  linked: (app: string) =>
    `Connected. ${app} will send your alerts and approval requests here. /stop mutes them.`,
  badCode: (web: string) =>
    `That link is invalid or expired. Get a new one from Settings: ${web}/settings`,
  chatTaken: 'This chat is already connected to another account.',
  userTaken: 'That account is already connected to another chat. Disconnect it in Settings first.',
  notLinked: (web: string) => `This chat is not connected yet. Connect it in ${web}/settings`,
  muted: 'Alerts muted. /resume turns them back on.',
  resumed: 'Alerts are back on.',
  privateOnly: 'Please message me directly: alerts are private.',
  notYours: 'This alert belongs to another account.',
  invalidButton: 'This button is no longer valid.',
  unavailable: 'Your agent is not available right now. Try again in the web app.',
};

const chatIdOf = (ctx: Context) => (ctx.chat ? String(ctx.chat.id) : null);

export function createBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.token, deps.botInfo ? { botInfo: deps.botInfo } : {});
  const now = () => deps.now?.() ?? new Date();

  // Alerts carry wallet facts: groups and channels are refused before anything else runs.
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private') {
      if (ctx.message) await ctx.reply(BOT_COPY.privateOnly);
      return;
    }
    await next();
  });

  bot.command('start', async (ctx) => {
    const code = ctx.match.trim();
    if (!code) return void (await ctx.reply(BOT_COPY.welcome(deps.webUrl)));
    const result = await redeemLinkCode(deps.prisma, code, chatIdOf(ctx)!, now());
    if (!result.ok) {
      const copy = {
        invalid: BOT_COPY.badCode(deps.webUrl),
        chat_taken: BOT_COPY.chatTaken,
        user_taken: BOT_COPY.userTaken,
      };
      return void (await ctx.reply(copy[result.reason]));
    }
    await deps.traceBus.emit({
      traceId: `telegram-${result.user.id}`,
      userId: result.user.id,
      kind: 'system',
      title: 'Telegram connected',
      detail: 'Your agent will send alerts and approval requests there.',
    });
    await ctx.reply(BOT_COPY.linked(deps.appName));
  });

  const setMuted = async (ctx: Context, muted: boolean) => {
    const res = await deps.prisma.user.updateMany({
      where: { telegramChatId: chatIdOf(ctx)! },
      data: { telegramMuted: muted },
    });
    await ctx.reply(
      res.count ? (muted ? BOT_COPY.muted : BOT_COPY.resumed) : BOT_COPY.notLinked(deps.webUrl),
    );
  };
  bot.command('stop', (ctx) => setMuted(ctx, true));
  bot.command('resume', (ctx) => setMuted(ctx, false));
  bot.command('help', (ctx) => ctx.reply(BOT_COPY.help(deps.appName, deps.webUrl)));

  bot.on('callback_query:data', async (ctx) => {
    const token = verifyCallback(deps.secret, ctx.callbackQuery.data);
    if (!token) return void (await ctx.answerCallbackQuery({ text: BOT_COPY.invalidButton }));
    const chatId = chatIdOf(ctx);
    const user = chatId
      ? await deps.prisma.user.findUnique({ where: { telegramChatId: chatId } })
      : null;
    const suggestion = await deps.prisma.suggestion.findUnique({
      where: { id: token.suggestionId },
      select: { userId: true },
    });
    if (!user || !suggestion || suggestion.userId !== user.id)
      return void (await ctx.answerCallbackQuery({ text: BOT_COPY.notYours, show_alert: true }));
    if (!deps.modeB)
      return void (await ctx.answerCallbackQuery({ text: BOT_COPY.unavailable, show_alert: true }));

    const act = { yes: acceptSuggestion, no: declineSuggestion, change: changeSuggestion };
    try {
      const r = await act[token.action](deps.modeB, token.suggestionId, user.id);
      await ctx.answerCallbackQuery({ text: r.message.slice(0, 190) });
    } catch (err) {
      const text = err instanceof AppError ? err.userMessage : BOT_COPY.unavailable;
      if (!(err instanceof AppError))
        deps.log?.warn({ err: err instanceof Error ? err.message : err }, 'telegram button failed');
      await ctx.answerCallbackQuery({ text: text.slice(0, 190), show_alert: true });
    }
  });

  // Everything else: one fixed line. No chat.
  bot.on('message', (ctx) => ctx.reply(BOT_COPY.redirect(deps.webUrl)));

  bot.catch((err) => {
    deps.log?.warn({ err: err.message }, 'telegram update failed');
  });
  return bot;
}
