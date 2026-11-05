import type { Logger } from 'pino';

const FORCE_EXIT_AFTER_MS = 10_000;

/** Runs `close` once on SIGINT/SIGTERM, then exits. Forces exit if close hangs. */
export function onShutdown(log: Pick<Logger, 'info' | 'error'>, close: () => Promise<void>): void {
  let shuttingDown = false;
  const handler = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      log.error({ signal }, 'graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, FORCE_EXIT_AFTER_MS);
    timer.unref();
    close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        log.error({ err }, 'error during shutdown');
        process.exit(1);
      });
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
}
