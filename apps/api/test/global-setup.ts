/**
 * Applies migrations to the dedicated test database before the suite runs.
 * Requires `docker compose up -d` locally (CI provides service containers).
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_DATABASE_URL } from './constants.js';

export default function setup(): void {
  const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  } catch (err) {
    const output =
      err && typeof err === 'object' && 'stdout' in err
        ? `${String((err as { stdout: unknown }).stdout)}${String((err as { stderr?: unknown }).stderr ?? '')}`
        : String(err);
    throw new Error(
      `Could not migrate the test database (${TEST_DATABASE_URL}).\n` +
        'Is Postgres running? Try: docker compose up -d\n' +
        output,
    );
  }
}
