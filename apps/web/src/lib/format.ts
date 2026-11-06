/** Display helpers. Pure functions — covered by unit tests. */

export function truncateMiddle(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function truncateAddress(address: string): string {
  return truncateMiddle(address, 6, 4);
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const dateFormatter = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
const fullFormatter = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

/** "just now", "42s ago", "5m ago", "3h ago", "2d ago", then a short date. */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const diff = Math.max(0, now - ts);
  if (diff < 10 * SECOND) return 'just now';
  if (diff < MINUTE) return `${Math.floor(diff / SECOND)}s ago`;
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return dateFormatter.format(ts);
}

export function formatFullTime(iso: string): string {
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? '' : fullFormatter.format(ts);
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

/**
 * Token amount for display: at most `maxDecimals` fractional digits (truncated, never rounded
 * up), thousands separators, and "<0.000001" for dust so a balance never looks like zero.
 */
export function formatTokenAmount(value: string, maxDecimals = 6): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return value;
  const [, sign, whole = '0', frac = ''] = match;
  const cut = frac.slice(0, maxDecimals).replace(/0+$/, '');
  if (whole === '0' && !cut && /[1-9]/.test(frac))
    return `${sign}<0.${'0'.repeat(maxDecimals - 1)}1`;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}${cut ? `.${cut}` : ''}`;
}

/** "+$12.40" / "-$3.00" / "$0.00" from a signed decimal string. */
export function formatSignedUsd(value: string, usdFormat: (v: string) => string): string {
  const negative = value.trim().startsWith('-');
  const abs = negative ? value.trim().slice(1) : value.trim();
  const formatted = usdFormat(abs);
  if (/^\$?0\.00$/.test(formatted)) return formatted;
  return `${negative ? '-' : '+'}${formatted}`;
}

/** "+12.5%" / "-3.1%" / "0%" from a signed decimal percent string. */
export function formatSignedPct(value: string, decimals = 2): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const fixed = Math.abs(n)
    .toFixed(decimals)
    .replace(/\.?0+$/, '');
  if (fixed === '0' || fixed === '') return '0%';
  return `${n < 0 ? '-' : '+'}${fixed}%`;
}

export function deltaTone(value: string | null | undefined): 'up' | 'down' | 'flat' {
  if (!value) return 'flat';
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) < 0.005) return 'flat';
  return n > 0 ? 'up' : 'down';
}
