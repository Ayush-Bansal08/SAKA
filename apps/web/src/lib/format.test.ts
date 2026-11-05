import { describe, expect, it } from 'vitest';
import { formatRelative, initials, truncateAddress, truncateMiddle } from './format';

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
