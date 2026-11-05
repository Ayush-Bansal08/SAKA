import { describe, expect, it } from 'vitest';
import { fromRaw, MoneyFormatError, sumUsd, toRaw, usd } from '../src/money.js';

describe('toRaw', () => {
  it('converts whole and fractional amounts', () => {
    expect(toRaw('20', 6)).toBe(20_000_000n);
    expect(toRaw('0.015', 18)).toBe(15_000_000_000_000_000n);
    expect(toRaw('1.5', 1)).toBe(15n);
  });

  it('accepts trailing zeros beyond token precision', () => {
    expect(toRaw('1.500000000', 6)).toBe(1_500_000n);
  });

  it('refuses to silently round extra precision', () => {
    expect(() => toRaw('1.0000001', 6)).toThrow(MoneyFormatError);
  });

  it('rejects malformed input', () => {
    for (const bad of ['', '-1', '1e6', '01', '1.', '.5', 'abc', '1,000']) {
      expect(() => toRaw(bad, 18), bad).toThrow(MoneyFormatError);
    }
  });
});

describe('fromRaw', () => {
  it('round-trips with toRaw', () => {
    for (const v of ['0', '1', '0.000001', '123.456', '1000000']) {
      expect(fromRaw(toRaw(v, 18), 18)).toBe(v);
    }
  });

  it('handles zero decimals and negatives', () => {
    expect(fromRaw(42n, 0)).toBe('42');
    expect(fromRaw(-1_500_000n, 6)).toBe('-1.5');
  });
});

describe('usd', () => {
  it('formats to cents with half-up rounding', () => {
    expect(usd('1234.565')).toBe('$1,234.57');
    expect(usd('0.1')).toBe('$0.10');
    expect(usd(0)).toBe('$0.00');
  });

  it('never shows a tiny non-zero amount as zero', () => {
    expect(usd('0.0001')).toBe('<$0.01');
  });

  it('sums exactly without float error', () => {
    expect(sumUsd(['0.1', '0.2']).toString()).toBe('0.3');
  });
});
