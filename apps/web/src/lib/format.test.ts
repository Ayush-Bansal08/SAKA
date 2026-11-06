import { describe, expect, it } from 'vitest';
import { usd } from '@warden/shared';
import {
  deltaTone,
  formatRelative,
  formatSignedPct,
  formatSignedUsd,
  formatTokenAmount,
  initials,
  truncateAddress,
  truncateMiddle,
} from './format';

describe('format helpers', () => {
  it('truncates addresses in the middle', () => {
    expect(truncateAddress('0x000000000000000000000000000000000000dEaD')).toBe('0x0000…dEaD');
    expect(truncateMiddle('short')).toBe('short');
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-11-06T12:00:00Z');
    expect(formatRelative('2026-11-06T11:59:58Z', now)).toBe('just now');
    expect(formatRelative('2026-11-06T11:59:30Z', now)).toBe('30s ago');
    expect(formatRelative('2026-11-06T11:55:00Z', now)).toBe('5m ago');
    expect(formatRelative('2026-11-06T09:00:00Z', now)).toBe('3h ago');
    expect(formatRelative('2026-11-04T12:00:00Z', now)).toBe('2d ago');
    expect(formatRelative('not-a-date', now)).toBe('');
  });

  it('derives initials', () => {
    expect(initials('alice')).toBe('AL');
    expect(initials('Alice Bob')).toBe('AB');
    expect(initials(null)).toBe('?');
  });
});

describe('portfolio formatting', () => {
  it('formats token amounts without rounding up or hiding dust', () => {
    expect(formatTokenAmount('0.049987654321')).toBe('0.049987');
    expect(formatTokenAmount('1234567.5')).toBe('1,234,567.5');
    expect(formatTokenAmount('10')).toBe('10');
    expect(formatTokenAmount('0.0000000001')).toBe('<0.000001');
    expect(formatTokenAmount('0')).toBe('0');
  });

  it('formats signed USD and percentages', () => {
    const fmt = (v: string) => usd(v);
    expect(formatSignedUsd('12.4', fmt)).toBe('+$12.40');
    expect(formatSignedUsd('-3', fmt)).toBe('-$3.00');
    expect(formatSignedUsd('0', fmt)).toBe('$0.00');
    expect(formatSignedPct('22.73')).toBe('+22.73%');
    expect(formatSignedPct('-3.10')).toBe('-3.1%');
    expect(formatSignedPct('0.001')).toBe('0%');
    expect(deltaTone('-0.5')).toBe('down');
    expect(deltaTone('0')).toBe('flat');
    expect(deltaTone(null)).toBe('flat');
  });
});
