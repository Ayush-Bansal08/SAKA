import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Test against workspace sources (no build step needed).
    alias: {
      '@warden/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
      'uniswap-agent-mcp': fileURLToPath(
        new URL('../../packages/uniswap-agent-mcp/src/lib.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Integration tests share one Postgres + Redis; run files sequentially.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
