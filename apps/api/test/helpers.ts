import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildAppOverrides } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';

import { TEST_DATABASE_URL, TEST_REDIS_URL } from './constants.js';

export { TEST_DATABASE_URL, TEST_REDIS_URL };

/** A complete, valid env for tests. Override any variable per test. */
export function testEnvSource(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PORT: '3001',
    APP_NAME: 'Warden',
    WEB_URL: 'http://localhost:5173',
    API_URL: 'http://localhost:3001',
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    ADMIN_TOKEN: 'test-admin-token-0123456789abcdef',
    AUTH_MODE: 'dev',
    APPROVAL_MODE: 'dev',
    ALLOW_DEV_PROVIDERS: 'true',
    EXECUTION_CHAIN_ID: '11155111',
    ...overrides,
  };
}

export function testEnv(overrides: Record<string, string | undefined> = {}): Env {
  return loadEnv(testEnvSource(overrides));
}

export async function createTestApp(
  overrides: Record<string, string | undefined> = {},
  deps?: BuildAppOverrides,
) {
  const app = await buildApp({
    env: testEnv(overrides),
    redisRateLimit: false,
    ...(deps ? { overrides: deps } : {}),
  });
  await app.ready();
  return app;
}

/** Unique dev display name so test runs never collide with each other or dev data. */
export function uniqueName(prefix: string): string {
  return `${prefix} ${randomBytes(4).toString('hex')}`;
}

export async function devSignIn(app: FastifyInstance, displayName: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/dev/sign-in',
    payload: { displayName },
  });
  if (res.statusCode !== 200) throw new Error(`sign-in failed ${res.statusCode}: ${res.body}`);
  return res.json() as {
    token: string;
    expiresAt: string;
    user: { id: string; displayName: string };
  };
}
