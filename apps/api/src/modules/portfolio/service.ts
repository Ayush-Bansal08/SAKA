/**
 * GET /portfolio: balances (MCP get_portfolio) × reference prices (MCP get_quote, mainnet),
 * FIFO P&L over TokenLot, the deterministic risk meter and today's limit usage.
 */
import type { AgentWallet, LpPosition, PrismaClient, User } from '@prisma/client';
import {
  Decimal,
  PORTFOLIO_PRICE_SOURCE,
  type ExecutionChainId,
  type LimitsUsage,
  type LpPositionView,
  type PortfolioResponse,
  type UniswapMcp,
  type PortfolioTokenView,
} from '@warden/shared';
import type { AllowlistEntry } from '../../config/env.js';
import { dayBoundsInZone } from '../../lib/time.js';
import type { UniswapMcpClient } from '../mcp/client.js';
import { executionTokens, findToken } from '../wallet/tokens.js';
import { dec, tokenPnl, type Lot } from './fifo.js';
import type { BalanceReader, PriceService } from './market.js';
import { computeRisk, type RiskHolding } from './risk.js';

export interface PortfolioDeps {
  prisma: PrismaClient;
  prices: PriceService;
  balances: BalanceReader;
  chainId: ExecutionChainId;
  allowlist: readonly AllowlistEntry[];
  /** For LP positions (PHASE 07); without it the portfolio shows tokens only. */
  mcp?: Pick<UniswapMcpClient, 'callTool'> | null;
  now?: () => Date;
}

/** Budget for the live LP read (get_lp_positions); the portfolio never waits longer. */
const LP_BUDGET_MS = 6_000;

interface LpResult {
  views: LpPositionView[];
  valueUsd: Decimal;
  outOfRangeUsd: Decimal;
  cautionHookUsd: Decimal;
  dangerHookUsd: Decimal;
}

/** Open LP positions: live amounts, range and value (MCP), cost basis and P&L (ours), hook band. */
async function lpPositions(
  deps: PortfolioDeps,
  user: User,
  wallet: AgentWallet,
  rows: LpPosition[],
): Promise<LpResult> {
  const zero = new Decimal(0);
  const out: LpResult = {
    views: [],
    valueUsd: zero,
    outOfRangeUsd: zero,
    cautionHookUsd: zero,
    dangerHookUsd: zero,
  };
  if (!rows.length || !deps.mcp) return out;
  const live = await withBudget<UniswapMcp.ToolOutput<'get_lp_positions'> | null>(
    deps.mcp
      .callTool(
        'get_lp_positions',
        {
          chainId: deps.chainId,
          owner: wallet.address,
          tokenIds: rows.slice(0, 50).map((r) => r.tokenId),
        },
        { traceId: 'portfolio', userId: user.id, quiet: true },
      )
      .catch(() => null),
    LP_BUDGET_MS,
    null,
  );
  const hookAddresses = [
    ...new Set(rows.map((r) => r.hookAddress).filter((h): h is string => Boolean(h))),
  ];
  const hooks = hookAddresses.length
    ? await deps.prisma.hook.findMany({
        where: { chainId: deps.chainId, address: { in: hookAddresses } },
        select: { address: true, score: true, band: true },
      })
    : [];
  const hookOf = new Map(hooks.map((h) => [h.address.toLowerCase(), h]));
  for (const row of rows) {
    const p = live?.positions.find((x) => x.tokenId === row.tokenId);
    if (!p) continue; // burned or unreadable right now; never show stale numbers
    const value = p.valueUsd !== null ? new Decimal(p.valueUsd) : null;
    const cost = new Decimal(row.costBasisUsd.toString());
    const hook = row.hookAddress ? hookOf.get(row.hookAddress.toLowerCase()) : undefined;
    if (value) {
      out.valueUsd = out.valueUsd.plus(value);
      if (!p.inRange) out.outOfRangeUsd = out.outOfRangeUsd.plus(value);
      if (hook?.band === 'CAUTION') out.cautionHookUsd = out.cautionHookUsd.plus(value);
      if (hook?.band === 'DANGER') out.dangerHookUsd = out.dangerHookUsd.plus(value);
    }
    out.views.push({
      id: row.id,
      tokenId: row.tokenId,
      poolId: p.poolId,
      token0: { symbol: p.token0.symbol, address: p.token0.address as `0x${string}` },
      token1: { symbol: p.token1.symbol, address: p.token1.address as `0x${string}` },
      amount0: p.amount0.decimal,
      amount1: p.amount1.decimal,
      fees0: p.uncollectedFees0?.decimal ?? null,
      fees1: p.uncollectedFees1?.decimal ?? null,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      currentTick: p.currentTick,
      priceLower: p.priceLower,
      priceUpper: p.priceUpper,
      priceCurrent: p.priceCurrent,
      inRange: p.inRange,
      valueUsd: value ? dec(value) : null,
      costBasisUsd: dec(cost),
      pnlUsd: value ? dec(value.minus(cost)) : null,
      hook: row.hookAddress
        ? {
            address: row.hookAddress as `0x${string}`,
            score: hook?.score ?? null,
            band: hook?.band ?? null,
          }
        : null,
      openedAt: row.createdAt.toISOString(),
    });
  }
  return out;
}

/** How long a cached get_portfolio snapshot may be reused by the API route. */
export const PORTFOLIO_SNAPSHOT_MAX_AGE_MS = 10_000;
/** Budget for the best-effort 7-day high lookups (drawdown factor). */
const DRAWDOWN_BUDGET_MS = 3_000;

const STABLES = new Set(['USDC', 'USDT', 'DAI']);

/** Today's AUTO spend (agent-approved executions) in the user's time zone. */
export async function limitsUsage(
  prisma: PrismaClient,
  user: Pick<User, 'id' | 'timezone'>,
  now: Date = new Date(),
): Promise<LimitsUsage> {
  const limits = await prisma.limits.findUnique({ where: { userId: user.id } });
  const { start, end, day, timeZone } = dayBoundsInZone(now, user.timezone);
  const spent = await prisma.execution.aggregate({
    _sum: { usdValue: true },
    where: {
      userId: user.id,
      approvedBy: 'AGENT',
      status: { in: ['SIGNED', 'BROADCAST', 'CONFIRMED'] },
      createdAt: { gte: start, lt: end },
    },
  });
  const perDay = new Decimal(limits?.perDayUsd.toString() ?? '0');
  const used = new Decimal(spent._sum.usdValue?.toString() ?? '0');
  return {
    perActionUsd: dec(new Decimal(limits?.perActionUsd.toString() ?? '0'), 2),
    perDayUsd: dec(perDay, 2),
    usedTodayUsd: dec(used, 2),
    remainingTodayUsd: dec(Decimal.max(0, perDay.minus(used)), 2),
    day,
    timezone: timeZone,
  };
}

function withBudget<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function buildPortfolio(
  deps: PortfolioDeps,
  user: User,
  wallet: AgentWallet | null,
): Promise<PortfolioResponse> {
  const now = deps.now?.() ?? new Date();
  const limits = await limitsUsage(deps.prisma, user, now);

  if (!wallet) {
    return {
      chainId: deps.chainId,
      address: null,
      totalUsd: '0',
      tokens: [],
      lpPositions: [],
      pnl: { totalUsd: '0', pct: null, costBasisUsd: '0', perToken: [] },
      risk: computeRisk({ holdings: [] }),
      limits,
      priceSource: PORTFOLIO_PRICE_SOURCE,
      unpriced: [],
      warnings: [],
      asOf: now.toISOString(),
    };
  }

  const registry = executionTokens(deps.chainId, deps.allowlist);
  const lpRows = await deps.prisma.lpPosition.findMany({
    where: { userId: user.id, chainId: deps.chainId, status: 'OPEN' },
    orderBy: { createdAt: 'desc' },
  });
  const [snapshot, lotRows, lp] = await Promise.all([
    deps.balances.read(user.id, deps.chainId, wallet.address, {
      maxAgeMs: PORTFOLIO_SNAPSHOT_MAX_AGE_MS,
    }),
    deps.prisma.tokenLot.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
    }),
    lpPositions(deps, user, wallet, lpRows),
  ]);

  const warnings: string[] = [];
  const priced = await Promise.all(
    snapshot.tokens.map(async (t) => {
      const known = findToken(registry, t.address);
      const ref = known?.referenceSymbol ?? null;
      const quote = ref ? await deps.prices.usd(ref) : null;
      if (quote?.stale) warnings.push(`${t.symbol} price is from ${quote.fetchedAt.toISOString()}`);
      // Our reference quote first; the MCP server's own reference price as a fallback.
      const priceUsd = quote?.priceUsd ?? (t.priceUsd !== null ? new Decimal(t.priceUsd) : null);
      return { token: t, ref, priceUsd };
    }),
  );

  const held = priced.filter((p) => p.token.balanceRaw !== '0' || p.token.isNative);
  const value = (p: (typeof priced)[number]) =>
    p.priceUsd === null ? null : new Decimal(p.token.balance).times(p.priceUsd);
  const tokensUsd = held.reduce((acc, p) => acc.plus(value(p) ?? 0), new Decimal(0));
  const totalUsd = tokensUsd.plus(lp.valueUsd);

  // Drawdown inputs (best-effort, bounded so the portfolio never waits on price history).
  const drawdowns = await withBudget(
    Promise.all(
      held.map(async (p) =>
        p.ref && p.priceUsd && p.token.balanceRaw !== '0'
          ? deps.prices.drawdownPct(p.ref, p.priceUsd).catch(() => null)
          : null,
      ),
    ),
    DRAWDOWN_BUDGET_MS,
    held.map(() => null),
  );

  const lotsByToken = new Map<string, Lot[]>();
  for (const row of lotRows) {
    const key = row.tokenAddress.toLowerCase();
    const list = lotsByToken.get(key) ?? [];
    list.push({
      amountRaw: BigInt(row.amountRaw),
      costUsd: new Decimal(row.costUsd.toString()),
      at: row.createdAt,
    });
    lotsByToken.set(key, list);
  }

  let pnlTotal = new Decimal(0);
  let costBasisTotal = new Decimal(0);
  let costEver = new Decimal(0);
  const perToken: PortfolioResponse['pnl']['perToken'] = [];
  const tokens: PortfolioTokenView[] = held.map((p) => {
    const v = value(p);
    const lots = lotsByToken.get(p.token.address.toLowerCase()) ?? [];
    const pnl = tokenPnl({
      lots,
      disposals: [], // recorded by the execution pipeline from PHASE 05
      balanceRaw: BigInt(p.token.balanceRaw),
      decimals: p.token.decimals,
      priceUsd: p.priceUsd,
      now,
    });
    let pnlView: PortfolioTokenView['pnl'] = null;
    if (pnl) {
      pnlTotal = pnlTotal.plus(pnl.pnlUsd);
      costBasisTotal = costBasisTotal.plus(pnl.costBasisUsd);
      costEver = costEver.plus(lots.reduce((acc, l) => acc.plus(l.costUsd), new Decimal(0)));
      pnlView = {
        costBasisUsd: dec(pnl.costBasisUsd),
        valueUsd: dec(pnl.valueUsd),
        unrealizedUsd: dec(pnl.unrealizedUsd),
        realizedUsd: dec(pnl.realizedUsd),
        pnlUsd: dec(pnl.pnlUsd),
        pct: pnl.pct ? dec(pnl.pct, 2) : null,
      };
      perToken.push({
        symbol: p.token.symbol,
        address: p.token.address as `0x${string}`,
        ...pnlView,
      });
    }
    return {
      symbol: p.token.symbol,
      address: p.token.address as `0x${string}`,
      decimals: p.token.decimals,
      isNative: p.token.isNative,
      balanceRaw: p.token.balanceRaw,
      balance: p.token.balance,
      priceUsd: p.priceUsd ? dec(p.priceUsd) : null,
      valueUsd: v ? dec(v) : null,
      sharePct: v && totalUsd.gt(0) ? dec(v.div(totalUsd).times(100), 2) : null,
      pnl: pnlView,
    };
  });

  const holdings: RiskHolding[] = held.map((p, i) => ({
    symbol: p.token.symbol,
    valueUsd: value(p) ?? new Decimal(0),
    isStable: STABLES.has((p.ref ?? p.token.symbol).toUpperCase()),
    drawdownPct: drawdowns[i] ?? null,
  }));
  if (holdings.some((h) => !h.isStable && h.valueUsd.gt(0) && h.drawdownPct === null)) {
    warnings.push('7-day price history is unavailable; drawdown is left out of the risk score.');
  }

  const unpriced = held.filter((p) => p.priceUsd === null && p.token.balanceRaw !== '0');
  return {
    chainId: deps.chainId,
    address: wallet.address as `0x${string}`,
    totalUsd: dec(totalUsd),
    tokens: tokens.sort(
      (a, b) =>
        new Decimal(b.valueUsd ?? 0).cmp(new Decimal(a.valueUsd ?? 0)) ||
        Number(b.isNative) - Number(a.isNative),
    ),
    lpPositions: lp.views,
    pnl: {
      totalUsd: dec(
        pnlTotal.plus(lp.views.reduce((a, v) => a.plus(v.pnlUsd ?? 0), new Decimal(0))),
      ),
      pct: costEver.gt(0) ? dec(pnlTotal.div(costEver).times(100), 2) : null,
      costBasisUsd: dec(costBasisTotal),
      perToken,
    },
    risk: computeRisk({
      holdings,
      lpOutOfRangeUsd: lp.outOfRangeUsd,
      cautionHookUsd: lp.cautionHookUsd,
      dangerHookUsd: lp.dangerHookUsd,
    }),
    limits,
    priceSource: PORTFOLIO_PRICE_SOURCE,
    unpriced: unpriced.map((p) => p.token.symbol),
    warnings,
    asOf: snapshot.asOf,
  };
}
