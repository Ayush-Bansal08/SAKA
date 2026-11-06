/**
 * Telegram text (PHASE 08 §4). Everything dynamic goes through escapeMd: MarkdownV2 rejects the
 * whole message on one unescaped character, and suggestion text comes from a model.
 */
import type { SuggestionApprover, SuggestionView } from '@warden/shared';

const SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export const escapeMd = (text: string) => text.replace(SPECIAL, '\\$&');
const escapeLinkUrl = (url: string) => url.replace(/[)\\]/g, '\\$&');

/**
 * Inline buttons with a localhost URL make Telegram reject the entire message, so only public
 * http(s) URLs may become buttons. Others are shown as text.
 */
export function isPublicUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'https:' && protocol !== 'http:') return false;
    return !(
      hostname === 'localhost' ||
      hostname === '0.0.0.0' ||
      hostname === '[::1]' ||
      hostname.endsWith('.local') ||
      /^127\./.test(hostname) ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      !hostname.includes('.')
    );
  } catch {
    return false;
  }
}

/** A clickable link when Telegram can open it, otherwise the plain address. */
export function linkLine(label: string, url: string): string {
  return isPublicUrl(url)
    ? `[${escapeMd(label)}](${escapeLinkUrl(url)})`
    : `${escapeMd(label)}: ${escapeMd(url)}`;
}

const SEVERITY_EMOJI: Record<SuggestionView['severity'], string> = {
  RED: '🔴',
  NORMAL: '💡',
  INFO: 'ℹ️',
};

const APPROVER: Record<SuggestionApprover, string> = {
  agent: 'Your agent, within your limits',
  you: 'You, one tap',
  verified_human: 'You, with a fresh human check',
};

function header(view: SuggestionView): string[] {
  return [
    `${SEVERITY_EMOJI[view.severity]} *${escapeMd(view.title)}*`,
    ...(view.simulated ? [`_${escapeMd('Simulated event (demo)')}_`] : []),
    '',
    escapeMd(view.message),
  ];
}

function numbers(view: SuggestionView): string[] {
  const plan = view.plan;
  if (!plan) return [];
  return [
    '',
    `Amount: *${escapeMd(`$${plan.amountUsd}`)}*`,
    ...(plan.tradeScore !== null ? [`Trade score: *${plan.tradeScore}/100*`] : []),
    ...(plan.hookScore !== null ? [`Hook score: *${plan.hookScore}/100*`] : []),
    `Who approves: ${escapeMd(APPROVER[plan.approver])}`,
  ];
}

const proof = (view: SuggestionView) =>
  view.zg ? ['', `_${escapeMd(`0G verified · ${view.zg.requestId}`)}_`] : [];

/** The first message: what was detected, the key numbers and who approves. */
export function renderAlert(view: SuggestionView): string {
  const auto = view.status === 'AUTO_EXECUTED';
  return [
    ...header(view),
    ...numbers(view),
    ...(auto ? ['', escapeMd('Within your limits: your agent is doing this now.')] : []),
    ...(view.note && view.status === 'INFO' ? ['', escapeMd(view.note)] : []),
    ...proof(view),
  ].join('\n');
}

function resultLine(view: SuggestionView): string {
  const plan = view.plan;
  if (plan?.status === 'EXECUTED') return `✅ ${escapeMd('Executed')}`;
  if (plan?.status === 'AWAITING_APPROVAL') return `🖐 ${escapeMd('Needs your approval')}`;
  if (view.status === 'DECLINED') return `✖️ ${escapeMd(view.note ?? 'Declined')}`;
  if (view.status === 'EXPIRED') return `⌛ ${escapeMd(view.note ?? 'Expired')}`;
  if (view.status === 'FAILED') return `⚠️ ${escapeMd(view.note ?? 'Nothing was traded')}`;
  return `⏳ ${escapeMd(view.note ?? 'Your agent is working on it')}`;
}

/** The same message after the human or the chain answered. */
export function renderOutcome(view: SuggestionView, extra: string[] = []): string {
  const tx = view.plan?.tx;
  return [
    ...header(view),
    ...numbers(view),
    '',
    resultLine(view),
    ...(tx?.explorerUrl ? [linkLine('View transaction', tx.explorerUrl)] : []),
    ...extra,
    ...proof(view),
  ].join('\n');
}

/** A rule's receipt or a one-off notice. */
export function renderNotice(title: string, body: string, extra: string[] = []): string {
  return [`*${escapeMd(title)}*`, escapeMd(body), ...extra].join('\n');
}
