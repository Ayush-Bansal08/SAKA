/**
 * Balance watcher (PHASE 03 §3). A repeatable worker job (every BALANCE_POLL_MS, default 15 s):
 * for each user with an agent wallet, read native + allowlisted ERC-20 balances through the MCP
 * `get_portfolio` tool and compare with the last snapshot in Redis.
 *
 *   - An increase not explained by our own executions (any Execution row in the last 2 min)
 *     is a deposit: a TokenLot (source DEPOSIT, cost = amount × mainnet reference price) and a
 *     trace event. The first native deposit while onboarding is at FUND moves it to DONE.
 *   - Users inactive for more than 24 h are polled every BALANCE_POLL_INACTIVE_MS (5 min).
 *   - A per-user Redis lock keeps concurrent workers from double-counting a deposit.
 */
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  CHAINS,
  Decimal,
  fromRaw,
  usd,
  type ExecutionChainId,
  type TraceEventInput,
} from '@warden/shared';
import type { Redis } from 'ioredis';
import type { AllowlistEntry } from '../config/env.js';
import { activityKey } from '../lib/activity.js';
import { dec } from '../modules/portfolio/fifo.js';
import type {
  BalanceReader,
  PortfolioSnapshot,
  PriceService,
} from '../modules/portfolio/market.js';
import { advanceStep } from '../modules/users/onboarding.js';
import { executionTokens, findToken } from '../modules/wallet/tokens.js';

export const OWN_EXECUTION_WINDOW_MS = 2 * 60_000;
export const INACTIVE_AFTER_MS = 24 * 3_600_000;
const LOCK_TTL_SECONDS = 60;
const CONCURRENCY = 4;

export const balanceKeys = {
  snapshot: (userId: string) => `balances:snapshot:${userId}`,
  polledAt: (userId: string) => `balances:polled:${userId}`,
  lock: (userId: string) => `lock:balances:${userId}`,
};

export { activityKey };

export interface BalanceWatcherDeps {
  prisma: PrismaClient;
  redis: Redis;
  balances: Pick<BalanceReader, 'read'>;
  prices: Pick<PriceService, 'usd'>;
  trace: { emit(input: TraceEventInput): Promise<unknown> };
  chainId: ExecutionChainId;
  allowlist: readonly AllowlistEntry[];
  inactivePollMs: number;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  now?: () => number;
}

export interface DetectedDeposit {
  tokenAddress: string;
  symbol: string;
  amountRaw: bigint;
  amount: string;
  costUsd: Decimal | null;
}

export interface UserCheckResult {
  userId: string;
  status:
    'skipped-inactive' | 'locked' | 'baseline' | 'unchanged' | 'explained' | 'deposit' | 'error';
  deposits: DetectedDeposit[];
  funded: boolean;
}

export interface WatchTickResult {
  checked: number;
  deposits: number;
  results: UserCheckResult[];
}

type SnapshotMap = Record<string, string>;

function toMap(snapshot: PortfolioSnapshot): SnapshotMap {
  return Object.fromEntries(snapshot.tokens.map((t) => [t.address.toLowerCase(), t.balanceRaw]));
}

/** One pass over every wallet (the job handler). */
export async function runBalanceWatch(deps: BalanceWatcherDeps): Promise<WatchTickResult> {
  const wallets = await deps.prisma.agentWallet.findMany({
    where: { chainId: deps.chainId },
    select: { userId: true, address: true },
  });
  const results: UserCheckResult[] = [];
  for (let i = 0; i < wallets.length; i += CONCURRENCY) {
    const batch = wallets.slice(i, i + CONCURRENCY);
    results.push(
      ...(await Promise.all(
        batch.map((w) =>
          checkUser(deps, w.userId, w.address).catch((err: unknown) => {
            deps.log.warn({ err, userId: w.userId }, 'balance check failed');
            const failed: UserCheckResult = {
              userId: w.userId,
              status: 'error',
              deposits: [],
              funded: false,
            };
            return failed;
          }),
        ),
      )),
    );
  }
  return {
    checked: results.filter((r) => r.status !== 'skipped-inactive' && r.status !== 'locked').length,
    deposits: results.reduce((acc, r) => acc + r.deposits.length, 0),
    results,
  };
}

export async function checkUser(
  deps: BalanceWatcherDeps,
  userId: string,
  address: string,
): Promise<UserCheckResult> {
  const now = deps.now?.() ?? Date.now();
  const none = (status: UserCheckResult['status']): UserCheckResult => ({
    userId,
    status,
    deposits: [],
    funded: false,
  });

  // Back-off for users who have not used the app for a day.
  const active = (await deps.redis.exists(activityKey(userId))) === 1;
  if (!active) {
    const last = Number((await deps.redis.get(balanceKeys.polledAt(userId))) ?? 0);
    if (now - last < deps.inactivePollMs) return none('skipped-inactive');
  }

  const locked = await deps.redis.set(balanceKeys.lock(userId), '1', 'EX', LOCK_TTL_SECONDS, 'NX');
  if (locked !== 'OK') return none('locked');
  try {
    const snapshot = await deps.balances.read(userId, deps.chainId, address, { maxAgeMs: 0 });
    await deps.redis.set(balanceKeys.polledAt(userId), String(now), 'EX', 7 * 86_400);
    const current = toMap(snapshot);
    const previousRaw = await deps.redis.hgetall(balanceKeys.snapshot(userId));
    const hasPrevious = Object.keys(previousRaw).length > 0;

    let previous: SnapshotMap = previousRaw;
    if (!hasPrevious) {
      // First observation. A brand-new wallet started at zero, so anything already there is
      // the user's deposit; for a wallet with history (Redis was flushed), just re-baseline.
      const [lots, executions] = await Promise.all([
        deps.prisma.tokenLot.count({ where: { userId } }),
        deps.prisma.execution.count({ where: { userId } }),
      ]);
      if (lots > 0 || executions > 0) {
        await writeSnapshot(deps.redis, userId, current);
        return none('baseline');
      }
      previous = {};
    }

    const tokens = executionTokens(deps.chainId, deps.allowlist);
    const increases = snapshot.tokens
      .map((t) => ({
        t,
        delta: BigInt(t.balanceRaw) - BigInt(previous[t.address.toLowerCase()] ?? '0'),
      }))
      .filter((x) => x.delta > 0n);

    if (increases.length === 0) {
      await writeSnapshot(deps.redis, userId, current);
      return none('unchanged');
    }

    const recentOwn = await deps.prisma.execution.count({
      where: { userId, createdAt: { gte: new Date(now - OWN_EXECUTION_WINDOW_MS) } },
    });
    if (recentOwn > 0) {
      await writeSnapshot(deps.redis, userId, current);
      deps.log.info({ userId, recentOwn }, 'balance increase explained by our own execution');
      return none('explained');
    }

    const deposits: DetectedDeposit[] = [];
    for (const { t, delta } of increases) {
      const known = findToken(tokens, t.address);
      const quote = known ? await deps.prices.usd(known.referenceSymbol) : null;
      const amount = fromRaw(delta, t.decimals);
      const price = quote?.priceUsd ?? (t.priceUsd !== null ? new Decimal(t.priceUsd) : null);
      deposits.push({
        tokenAddress: t.address,
        symbol: t.symbol,
        amountRaw: delta,
        amount,
        costUsd: price ? new Decimal(amount).times(price) : null,
      });
    }

    await deps.prisma.tokenLot.createMany({
      data: deposits.map((d) => ({
        userId,
        tokenAddress: d.tokenAddress,
        amountRaw: d.amountRaw.toString(),
        costUsd: dec(d.costUsd ?? new Decimal(0), 8),
        source: 'DEPOSIT' as const,
      })),
    });
    // Only after the lots exist: a crash before this line re-detects rather than loses.
    await writeSnapshot(deps.redis, userId, current);

    const nativeDeposit = deposits.find((d) => d.tokenAddress.toLowerCase() === tokens[0]!.address);
    const funded = nativeDeposit ? await advanceStep(deps.prisma, userId, 'FUND', 'DONE') : false;

    for (const d of deposits) {
      const value = d.costUsd ? ` (~${usd(d.costUsd)})` : '';
      const isFunding = funded && d === nativeDeposit;
      await deps.trace.emit({
        kind: 'receipt',
        traceId: randomUUID(),
        userId,
        title: isFunding
          ? `Funded: ${d.amount} ${d.symbol}${value}`
          : `Deposit received: ${d.amount} ${d.symbol}${value}`,
        detail: isFunding
          ? `Your agent is ready on ${CHAINS[deps.chainId].name}.`
          : `Detected in your agent wallet on ${CHAINS[deps.chainId].name}.`,
        data: {
          token: d.tokenAddress,
          symbol: d.symbol,
          amount: d.amount,
          amountRaw: d.amountRaw.toString(),
          costUsd: d.costUsd ? dec(d.costUsd, 2) : null,
          onboardingDone: isFunding,
        },
      });
    }
    deps.log.info({ userId, deposits: deposits.length, funded }, 'deposit detected');
    return { userId, status: 'deposit', deposits, funded };
  } finally {
    await deps.redis.del(balanceKeys.lock(userId)).catch(() => undefined);
  }
}

async function writeSnapshot(redis: Redis, userId: string, map: SnapshotMap): Promise<void> {
  const key = balanceKeys.snapshot(userId);
  const multi = redis.multi().del(key);
  if (Object.keys(map).length > 0) multi.hset(key, map);
  await multi.exec();
}
