import { describe, expect, it } from 'vitest';
import { parseStoredSession } from './session';

describe('parseStoredSession', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();

  it('accepts a valid, unexpired session', () => {
    expect(parseStoredSession(JSON.stringify({ token: 'abc', expiresAt: future }))).toEqual({
      token: 'abc',
      expiresAt: future,
    });
  });

  it('rejects expired, malformed or empty values', () => {
    expect(parseStoredSession(JSON.stringify({ token: 'abc', expiresAt: past }))).toBeNull();
    expect(parseStoredSession('{not json')).toBeNull();
    expect(parseStoredSession(JSON.stringify({ token: '', expiresAt: future }))).toBeNull();
    expect(parseStoredSession(null)).toBeNull();
  });
});
