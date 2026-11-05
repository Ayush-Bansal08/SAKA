/**
 * Loads the repository-root `.env` for local development. Imported for its side
 * effect by process entry points only (never by buildApp, so tests stay hermetic).
 * Real environment variables always win over the file.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

function findEnvFile(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const here = dirname(fileURLToPath(import.meta.url));
const envFile = process.env.DOTENV_PATH ?? findEnvFile(process.cwd()) ?? findEnvFile(here);
if (envFile && process.env.NODE_ENV !== 'production') {
  config({ path: envFile, quiet: true, override: false });
}
