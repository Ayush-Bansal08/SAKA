import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { testEnvSource } from './helpers.js';

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('API process', () => {
  it('refuses to start with NODE_ENV=production AUTH_MODE=dev', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--conditions=@warden/source', 'src/server.ts'],
      {
        cwd: apiDir,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          ...testEnvSource({
            NODE_ENV: 'production',
            AUTH_MODE: 'dev',
            ALLOW_DEV_PROVIDERS: 'false',
          }),
          // Never pick up a developer's .env during this test.
          DOTENV_PATH: resolve(apiDir, 'does-not-exist.env'),
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing to start');
    expect(result.stderr).toContain('AUTH_MODE=dev is forbidden when NODE_ENV=production');
  });
});
