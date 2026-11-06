/**
 * The one place that talks to Telegram for outgoing messages, run by the worker's notify queue
 * (concurrency 1, rate limited). On a 429 it waits Telegram's `retry_after` in place, which holds
 * the whole queue: flood control is per bot, so sending anything else would only make it worse.
 */
import type { PrismaClient } from '@prisma/client';
import { ActionIntentSchema, explorerTxUrl, type ExecutionChainId } from '@warden/shared';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { describeIntent } from '../agent/describe.js';
import { loadSuggestionView } from '../modeb/suggestions.js';
import { signCallback, type CallbackAction } from './callback.js';
import { isPublicUrl, linkLine, renderAlert, renderNotice, renderOutcome } from './format.js';
import type { Notification } from './notifications.js';

/** The subset of grammY's Api the delivery uses (tests pass a recording fake). */
export interface TelegramApi {
  sendMessage(
    chatId: string,
    text: string,
    other: { parse_mode: 'MarkdownV2'; reply_markup?: InlineKeyboardMarkup },
  ): Promise<{ message_id: number }>;
  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    other: { parse_mode: 'MarkdownV2'; reply_markup?: InlineKeyboardMarkup },
  ): Promise<unknown>;
}

export interface DeliveryDeps {
  prisma: PrismaClient;
  api: TelegramApi;
  /** Signs button tokens. */
  secret: string;
  webUrl: string;
  chainId: number;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_RETRY_AFTER_S = 60;
const MAX_429_RETRIES = 3;
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const retryAfter = (err: unknown): number | null => {
  const e = err as { error_code?: number; parameters?: { retry_after?: number } };
  return e?.error_code === 429 ? (e.parameters?.retry_after ?? 1) : null;
};

/** Runs a Telegram call, honouring 429 `retry_after`. */
export async function withFloodControl<T>(
  deps: Pick<DeliveryDeps, 'sleep'>,
  call: () => Promise<T>,
): Promise<T> {
  const sleep = deps.sleep ?? realSleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      const wait = retryAfter(err);
      if (wait === null || attempt >= MAX_429_RETRIES) throw err;
      await sleep(Math.min(wait, MAX_RETRY_AFTER_S) * 1000);
    }
  }
}

const LABEL: Record<CallbackAction, string> = {
  yes: '✅ Yes',
  change: '✏️ Change',
  no: '✖️ No',
};

function keyboard(
  secret: string,
  suggestionId: string,
  actions: readonly CallbackAction[],
): InlineKeyboardMarkup | undefined {
  if (!actions.length) return undefined;
  return {
    inline_keyboard: [
      actions.map((a) => ({
        text: LABEL[a],
        callback_data: signCallback(secret, a, suggestionId),
      })),
    ],
  };
}

const urlKeyboard = (label: string, url: string): InlineKeyboardMarkup | undefined =>
  isPublicUrl(url) ? { inline_keyboard: [[{ text: label, url }]] } : undefined;

/** Editing to identical text is an error at Telegram, and a harmless one. */
const notModified = (err: unknown) =>
  (err as { description?: string })?.description?.includes('message is not modified') === true;

async function chatOf(prisma: PrismaClient, userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { telegramChatId: true, telegramMuted: true },
  });
}

async function sendAlert(deps: DeliveryDeps, suggestionId: string): Promise<void> {
  const row = await deps.prisma.suggestion.findUnique({ where: { id: suggestionId } });
  if (!row || row.telegramMessageId) return;
  const user = await chatOf(deps.prisma, row.userId);
  if (!user?.telegramChatId || user.telegramMuted) return;
  const view = await loadSuggestionView(deps.prisma, deps.chainId, row.id);
  const markup = keyboard(deps.secret, row.id, view.actions);
  const sent = await withFloodControl(deps, () =>
    deps.api.sendMessage(user.telegramChatId!, renderAlert(view), {
      parse_mode: 'MarkdownV2',
      ...(markup ? { reply_markup: markup } : {}),
    }),
  );
  await deps.prisma.suggestion.update({
    where: { id: row.id },
    data: { telegramMessageId: String(sent.message_id) },
  });
}

async function sendOutcome(
  deps: DeliveryDeps,
  n: Extract<Notification, { kind: 'outcome' }>,
): Promise<void> {
  const row = await deps.prisma.suggestion.findUnique({ where: { id: n.suggestionId } });
  if (!row) return;
  const user = await chatOf(deps.prisma, row.userId);
  if (!user?.telegramChatId) return;
  const view = await loadSuggestionView(deps.prisma, deps.chainId, row.id);

  // P10 replaces this button with the World device flow inside Telegram.
  const approvalId = view.plan?.status === 'AWAITING_APPROVAL' ? view.plan.approvalId : null;
  const link =
    n.link ??
    (approvalId
      ? { label: 'Approve in app', url: `${deps.webUrl}/approvals/${approvalId}` }
      : null);
  const text = renderOutcome(view, link ? [linkLine(link.label, link.url)] : []);
  const markup = link ? urlKeyboard(link.label, link.url) : undefined;
  const other = {
    parse_mode: 'MarkdownV2' as const,
    // An empty keyboard removes the buttons from the edited message.
    reply_markup: markup ?? { inline_keyboard: [] },
  };
  if (row.telegramMessageId) {
    try {
      await withFloodControl(deps, () =>
        deps.api.editMessageText(user.telegramChatId!, Number(row.telegramMessageId), text, other),
      );
    } catch (err) {
      if (!notModified(err)) throw err;
    }
    return;
  }
  if (user.telegramMuted) return;
  const sent = await withFloodControl(deps, () =>
    deps.api.sendMessage(user.telegramChatId!, text, {
      parse_mode: 'MarkdownV2',
      ...(markup ? { reply_markup: markup } : {}),
    }),
  );
  await deps.prisma.suggestion.update({
    where: { id: row.id },
    data: { telegramMessageId: String(sent.message_id) },
  });
}

async function sendReceipt(deps: DeliveryDeps, planId: string): Promise<void> {
  const plan = await deps.prisma.actionPlan.findUnique({
    where: { id: planId },
    include: { executions: { orderBy: { stepIndex: 'asc' } } },
  });
  if (!plan) return;
  const user = await chatOf(deps.prisma, plan.userId);
  if (!user?.telegramChatId || user.telegramMuted) return;
  const intent = ActionIntentSchema.safeParse(plan.intent);
  const what = intent.success ? describeIntent(intent.data) : 'your rule';
  const hash = plan.executions.filter((e) => e.txHash).at(-1)?.txHash ?? null;
  const url = hash ? explorerTxUrl(deps.chainId as ExecutionChainId, hash) : null;
  const ok = plan.status === 'EXECUTED';
  const text = renderNotice(
    ok ? '✅ Rule executed' : '⚠️ Rule did not trade',
    ok ? `Done: ${what}.` : `${what}: nothing was traded (${plan.status.toLowerCase()}).`,
    url ? [linkLine('View transaction', url)] : [],
  );
  await withFloodControl(deps, () =>
    deps.api.sendMessage(user.telegramChatId!, text, { parse_mode: 'MarkdownV2' }),
  );
}

async function sendText(
  deps: DeliveryDeps,
  n: Extract<Notification, { kind: 'text' }>,
): Promise<void> {
  const user = await chatOf(deps.prisma, n.userId);
  if (!user?.telegramChatId || user.telegramMuted) return;
  const markup = n.link ? urlKeyboard(n.link.label, n.link.url) : undefined;
  const text = renderNotice(n.title, n.body, n.link ? [linkLine(n.link.label, n.link.url)] : []);
  await withFloodControl(deps, () =>
    deps.api.sendMessage(user.telegramChatId!, text, {
      parse_mode: 'MarkdownV2',
      ...(markup ? { reply_markup: markup } : {}),
    }),
  );
}

export async function deliver(deps: DeliveryDeps, n: Notification): Promise<void> {
  switch (n.kind) {
    case 'suggestion':
      return sendAlert(deps, n.suggestionId);
    case 'outcome':
      return sendOutcome(deps, n);
    case 'receipt':
      return sendReceipt(deps, n.planId);
    case 'text':
      return sendText(deps, n);
  }
}
