/**
 * Telegram bot entry (PHASE 08 §4). Locally it long-polls. In production Telegram calls
 * `API_URL/telegram/webhook` on the API; this process only registers that webhook, then exits.
 */
import './config/load-dotenv.js';
import { EnvError, loadEnv, type Env } from './config/env.js';
import { createPrisma, createRedis } from './lib/infra.js';
import { createLogger } from './lib/logger.js';
import { onShutdown } from './lib/shutdown.js';
import { ZgClient } from './modules/ai0g/client.js';
import { createApprovalProvider } from './modules/approvals/dev-approval-provider.js';
import { ApprovalsService } from './modules/approvals/service.js';
import { createChainClient } from './modules/execution/chain.js';
import { createBullJobs } from './modules/execution/jobs.js';
import { createUniswapMcpClient } from './modules/mcp/client.js';
import { approvalResolved, type ModeBDeps } from './modules/modeb/suggestions.js';
import { BalanceReader, PriceService } from './modules/portfolio/market.js';
import { createBot } from './modules/telegram/bot.js';
import { createNotifications } from './modules/telegram/notifications.js';
import { TraceBus } from './modules/trace/trace-bus.js';

function readEnvOrExit(): Env {
  try {
    return loadEnv();
  } catch (err) {
    if (err instanceof EnvError) {
      console.error(`\n[bot] Refusing to start.\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

const env = readEnvOrExit();
const log = createLogger(env, 'bot');
const token = env.TELEGRAM_BOT_TOKEN;

if (!token) {
  log.warn('TELEGRAM_BOT_TOKEN is not set: the Telegram bot is off (alerts stay in the inbox)');
  process.exit(0);
}

const prisma = createPrisma(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL, { name: 'bot' });
const traceBus = new TraceBus(prisma, redis, log.child({ module: 'trace' }));
const mcp = createUniswapMcpClient(env, { trace: traceBus, log: log.child({ module: 'mcp' }) });
const jobs = createBullJobs(env.REDIS_URL);
const notifications = createNotifications(env);
const approvals = new ApprovalsService({
  prisma,
  trace: traceBus,
  jobs,
  ttlSeconds: env.APPROVAL_TTL_SECONDS,
  onResolved: (a, outcome) => approvalResolved({ prisma, notifications }, a, outcome),
});
const approvalProvider = createApprovalProvider(env, approvals, (id) =>
  prisma.approval.findUnique({ where: { id }, select: { expiresAt: true } }),
);
const modeB: ModeBDeps | null = mcp
  ? {
      env,
      prisma,
      redis,
      mcp,
      prices: new PriceService(prisma, mcp, log.child({ module: 'prices' })),
      balances: new BalanceReader(mcp, redis),
      traceBus,
      zg: env.ZG_API_KEY ? new ZgClient(env, prisma, traceBus) : null,
      chain: createChainClient(env.EXECUTION_CHAIN_ID, env.EXECUTION_RPC_URL),
      approvals,
      approvalProvider,
      jobs,
      notifications,
      log,
    }
  : null;

const bot = createBot({
  token,
  secret: env.ENCRYPTION_KEY,
  webUrl: env.WEB_URL,
  appName: env.APP_NAME,
  prisma,
  traceBus,
  modeB,
  log,
});

await bot.api.setMyCommands([
  { command: 'stop', description: 'Mute alerts' },
  { command: 'resume', description: 'Turn alerts back on' },
  { command: 'help', description: 'What this bot does' },
]);

const close = async () => {
  await jobs.close();
  await notifications.close();
  await mcp?.close();
  await traceBus.close();
  await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
};

if (env.NODE_ENV === 'production') {
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    log.fatal('TELEGRAM_WEBHOOK_SECRET is required in production');
    process.exit(1);
  }
  await bot.api.setWebhook(`${env.API_URL}/telegram/webhook`, {
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
  });
  log.info({ url: `${env.API_URL}/telegram/webhook` }, 'telegram webhook registered');
  await close();
  process.exit(0);
}

onShutdown(log, async () => {
  await bot.stop();
  await close();
});
await bot.api.deleteWebhook();
log.info('telegram bot polling');
await bot.start({
  allowed_updates: ['message', 'callback_query'],
  onStart: (me) => log.info({ username: me.username }, 'telegram bot ready'),
});
