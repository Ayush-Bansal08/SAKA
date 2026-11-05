import { describe, expect, it } from 'vitest';
import { devProvidersAllowed, EnvError, loadEnv } from '../src/config/env.js';
import { DevIdentityProvider } from '../src/modules/auth/dev-identity-provider.js';
import { testEnvSource } from './helpers.js';

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof EnvError) return err.issues;
    throw err;
  }
  throw new Error('expected EnvError');
}

describe('env validation', () => {
  it('parses a valid environment with typed values', () => {
    const env = loadEnv(testEnvSource({ PORT: '4000', SESSION_TTL_HOURS: '12' }));
    expect(env.PORT).toBe(4000);
    expect(env.SESSION_TTL_HOURS).toBe(12);
    expect(env.ALLOW_DEV_PROVIDERS).toBe(true);
    expect(env.EXECUTION_CHAIN_ID).toBe(11155111);
  });

  it('defaults the execution chain to Ethereum Sepolia', () => {
    const env = loadEnv(testEnvSource({ EXECUTION_CHAIN_ID: undefined }));
    expect(env.EXECUTION_CHAIN_ID).toBe(11155111);
  });

  it('still accepts the other supported testnets', () => {
    expect(loadEnv(testEnvSource({ EXECUTION_CHAIN_ID: '1301' })).EXECUTION_CHAIN_ID).toBe(1301);
    expect(loadEnv(testEnvSource({ EXECUTION_CHAIN_ID: '84532' })).EXECUTION_CHAIN_ID).toBe(84532);
  });

  it('lists every missing variable in one readable error', () => {
    const issues = issuesOf(() =>
      loadEnv({ NODE_ENV: 'development', AUTH_MODE: 'dev', APPROVAL_MODE: 'dev' }),
    );
    for (const key of [
      'WEB_URL',
      'API_URL',
      'DATABASE_URL',
      'REDIS_URL',
      'ENCRYPTION_KEY',
      'ADMIN_TOKEN',
    ]) {
      expect(issues).toContain(`${key} is required but missing`);
    }
  });

  it('treats empty strings as missing', () => {
    const issues = issuesOf(() => loadEnv(testEnvSource({ DATABASE_URL: '' })));
    expect(issues).toContain('DATABASE_URL is required but missing');
  });

  it('rejects a weak encryption key', () => {
    const issues = issuesOf(() => loadEnv(testEnvSource({ ENCRYPTION_KEY: 'too-short' })));
    expect(issues.some((i) => i.startsWith('ENCRYPTION_KEY must be 32 random bytes'))).toBe(true);
  });

  it('rejects mainnet as the execution chain', () => {
    const issues = issuesOf(() => loadEnv(testEnvSource({ EXECUTION_CHAIN_ID: '1' })));
    expect(issues.some((i) => i.startsWith('EXECUTION_CHAIN_ID'))).toBe(true);
  });

  it('requires ALLOW_DEV_PROVIDERS for dev modes', () => {
    const issues = issuesOf(() => loadEnv(testEnvSource({ ALLOW_DEV_PROVIDERS: 'false' })));
    expect(issues[0]).toMatch(/requires ALLOW_DEV_PROVIDERS=true/);
  });

  it('refuses world mode until Phase 10', () => {
    const issues = issuesOf(() => loadEnv(testEnvSource({ AUTH_MODE: 'world' })));
    expect(issues[0]).toMatch(/Phase 10/);
  });
});

describe('production startup guard', () => {
  it('reports the dev-provider refusal even when other variables are missing', () => {
    const issues = issuesOf(() => loadEnv({ NODE_ENV: 'production', AUTH_MODE: 'dev' }));
    expect(issues[0]).toBe(
      'AUTH_MODE=dev is forbidden when NODE_ENV=production (use AUTH_MODE=world)',
    );
    expect(issues).toContain('DATABASE_URL is required but missing');
  });

  it('refuses AUTH_MODE=dev in production', () => {
    const issues = issuesOf(() =>
      loadEnv(
        testEnvSource({
          NODE_ENV: 'production',
          ALLOW_DEV_PROVIDERS: 'false',
          APPROVAL_MODE: 'dev',
        }),
      ),
    );
    expect(issues).toContain(
      'AUTH_MODE=dev is forbidden when NODE_ENV=production (use AUTH_MODE=world)',
    );
    expect(issues).toContain(
      'APPROVAL_MODE=dev is forbidden when NODE_ENV=production (use APPROVAL_MODE=world)',
    );
  });

  it('refuses ALLOW_DEV_PROVIDERS=true in production', () => {
    const issues = issuesOf(() => loadEnv(testEnvSource({ NODE_ENV: 'production' })));
    expect(issues).toContain('ALLOW_DEV_PROVIDERS=true is forbidden when NODE_ENV=production');
  });

  it('never allows dev providers in production, even if flagged', () => {
    expect(devProvidersAllowed({ NODE_ENV: 'production', ALLOW_DEV_PROVIDERS: true })).toBe(false);
    expect(
      () => new DevIdentityProvider({ NODE_ENV: 'production', ALLOW_DEV_PROVIDERS: true }),
    ).toThrow(/NODE_ENV!=production/);
    expect(
      () => new DevIdentityProvider({ NODE_ENV: 'development', ALLOW_DEV_PROVIDERS: false }),
    ).toThrow();
  });
});
