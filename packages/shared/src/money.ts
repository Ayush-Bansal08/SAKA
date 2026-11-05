/**
 * Money helpers. Token amounts are bigint raw units; human amounts are decimal
 * strings; USD math uses decimal.js and is rounded to cents only for display.
 */
import { Decimal } from 'decimal.js';

export { Decimal };

const DECIMAL_RE = /^(0|[1-9]\d*)(\.(\d+))?$/;

export class MoneyFormatError extends Error {
  override name = 'MoneyFormatError';
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new MoneyFormatError(`Invalid token decimals: ${decimals}`);
  }
}

/**
 * Convert a non-negative decimal string to raw integer units.
 * Throws (never silently rounds) when the string has more fractional digits
 * than the token supports.
 */
export function toRaw(value: string, decimals: number): bigint {
  assertDecimals(decimals);
  const trimmed = value.trim();
  const match = DECIMAL_RE.exec(trimmed);
  if (!match) throw new MoneyFormatError(`Not a valid decimal amount: "${value}"`);
  const whole = match[1] ?? '0';
  const fraction = match[3] ?? '';
  if (fraction.length > decimals) {
    const extra = fraction.slice(decimals);
    if (/[^0]/.test(extra)) {
      throw new MoneyFormatError(
        `Amount "${value}" has more than ${decimals} decimal places for this token`,
      );
    }
  }
  const paddedFraction = fraction.slice(0, decimals).padEnd(decimals, '0');
  return BigInt(whole + paddedFraction);
}

/** Convert raw integer units to a canonical decimal string (no trailing zeros). */
export function fromRaw(raw: bigint, decimals: number): string {
  assertDecimals(decimals);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const digits = abs.toString().padStart(decimals + 1, '0');
  const whole = decimals === 0 ? digits : digits.slice(0, -decimals);
  const fraction = decimals === 0 ? '' : digits.slice(-decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Format a USD amount for display, rounding half-up to cents at the very end.
 * Values between 0 and 1 cent render as "<$0.01" so tiny amounts never look like zero.
 */
export function usd(value: Decimal.Value): string {
  const d = new Decimal(value);
  if (!d.isFinite()) throw new MoneyFormatError(`Not a finite USD amount: ${String(value)}`);
  if (!d.isZero() && d.abs().lt('0.01')) return d.isNegative() ? '-<$0.01' : '<$0.01';
  const cents = d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  // Intl receives a string with at most 2 decimals, so no float error is introduced.
  return usdFormatter.format(cents.toFixed(2) as `${number}`);
}

/** Sum USD decimal values exactly. */
export function sumUsd(values: readonly Decimal.Value[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(v), new Decimal(0));
}
