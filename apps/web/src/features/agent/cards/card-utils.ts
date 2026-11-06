/** Pure helpers for chat cards (kept out of component files for Fast Refresh). */
import { InfoDataSchema, type Card, type InfoCard, type InfoData } from '@warden/shared';

export const usd = (v: string | number) =>
  `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "[V4] 100.00% = ETH -- 0.3% [0x3390…]USDC" → "V4 · 0.3% pool". */
export function shortRoute(route: string): string {
  const proto = /\[(v\d)\]/i.exec(route)?.[1]?.toUpperCase();
  const fees = [...route.matchAll(/(\d+(?:\.\d+)?)%\s*(?:\]|\[|pool|--|$)/g)]
    .map((m) => `${m[1]}%`)
    .filter((f) => !['100%', '100.00%'].includes(f));
  const unique = [...new Set(fees)].slice(0, 3);
  if (!proto && !unique.length) return route.length > 60 ? `${route.slice(0, 57)}…` : route;
  return [proto, unique.length ? `${unique.join(' + ')} pool${unique.length > 1 ? 's' : ''}` : null]
    .filter(Boolean)
    .join(' · ');
}

export function scoreTone(score: number): 'safe' | 'caution' | 'danger' {
  return score >= 70 ? 'safe' : score >= 40 ? 'caution' : 'danger';
}

/** The plain "Agent reply" info card repeats the message text: not rendered as a card. */
export function isReplyEcho(card: Card): boolean {
  return card.type === 'info' && card.title === 'Agent reply' && card.data === undefined;
}

export function infoData(card: InfoCard): InfoData | null {
  const parsed = InfoDataSchema.safeParse(card.data);
  return parsed.success ? parsed.data : null;
}

/** "Today", "Yesterday", or "Mon, Nov 4". */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
