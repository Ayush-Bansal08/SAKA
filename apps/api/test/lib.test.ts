import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/lib/crypto.js';
import { bearerToken } from '../src/modules/auth/session-service.js';
import { createTestApp } from './helpers.js';

describe('AES-GCM secrets at rest', () => {
  const key = randomBytes(32).toString('base64');

  it('round-trips and binds to its context', () => {
    const enc = encryptSecret('pkce-verifier-value', key, 'attempt_1');
    expect(enc).not.toContain('pkce-verifier-value');
    expect(decryptSecret(enc, key, 'attempt_1')).toBe('pkce-verifier-value');
    expect(() => decryptSecret(enc, key, 'attempt_2')).toThrow();
  });

  it('detects tampering and wrong keys', () => {
    const enc = encryptSecret('secret', key);
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
    expect(() => decryptSecret(enc, randomBytes(32).toString('base64'))).toThrow();
  });
});

describe('bearerToken', () => {
  it('parses only well-formed bearer headers', () => {
    expect(bearerToken('Bearer abc_DEF-123')).toBe('abc_DEF-123');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('GET /health', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('reports database and redis status', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ok',
      checks: { database: 'up', redis: 'up' },
    });
  });
});
