/** HTTP entry point. */
import './config/load-dotenv.js';
import { buildApp } from './app.js';
import { EnvError, loadEnv, type Env } from './config/env.js';
import { onShutdown } from './lib/shutdown.js';

function readEnvOrExit(): Env {
  try {
    return loadEnv();
  } catch (err) {
    if (err instanceof EnvError) {
      console.error(`\n[api] Refusing to start.\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

const env = readEnvOrExit();
const app = await buildApp({ env });

onShutdown(app.log, async () => {
  await app.close();
});

try {
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(
    { authMode: env.AUTH_MODE, approvalMode: env.APPROVAL_MODE, chainId: env.EXECUTION_CHAIN_ID },
    `${env.APP_NAME} API ready on ${env.API_URL}`,
  );
} catch (err) {
  app.log.fatal({ err }, 'failed to start server');
  await app.close().catch(() => undefined);
  process.exit(1);
}
