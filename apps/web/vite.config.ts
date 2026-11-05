import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Use workspace sources directly (no build step for the shared package).
      '@warden/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: {
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        // Long-lived vendor chunks cache across deploys.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // zod + decimal.js have no runtime deps, so splitting them can't create a cycle.
          // Vite module ids use forward slashes on every OS.
          if (/\/node_modules\/(zod|decimal\.js)\//.test(id)) return 'schema';
          return 'vendor';
        },
      },
    },
  },
});
