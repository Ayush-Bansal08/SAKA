/** Small helpers shared by the detectors. */
import { Decimal } from '@warden/shared';
import { getAddress, isAddress, zeroAddress } from 'viem';

export const STABLES: ReadonlySet<string> = new Set(['USDC', 'USDT', 'DAI']);

export const usd2 = (d: Decimal) => d.toDecimalPlaces(2).toFixed(2);
export const pct1 = (d: Decimal) => d.toDecimalPlaces(1).toString();
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const norm = (symbol: string) => {
  const s = symbol.toUpperCase();
  return s === 'WETH' ? 'ETH' : s;
};

/** Order-independent pair label ("ETH/USDC"), the key of DetectorContext.pools. */
export function pairKey(a: string, b: string): string {
  return [norm(a), norm(b)].sort().join('/');
}

/** A real hook address, or undefined for the zero address (a hookless pool). */
export function hookOrUndefined(address: string | null | undefined): `0x${string}` | undefined {
  if (!address || !isAddress(address) || address === zeroAddress) return undefined;
  return getAddress(address);
}

/** ISO-8601 week of a UTC instant ("2026-W45"). */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** UTC hour of an instant ("2026-11-06T13"), the BIG_MOVE window. */
export function hourKey(date: Date): string {
  return date.toISOString().slice(0, 13);
}

export const decimal = (v: string | null | undefined): Decimal | null => {
  if (v === null || v === undefined) return null;
  try {
    return new Decimal(v);
  } catch {
    return null;
  }
};
