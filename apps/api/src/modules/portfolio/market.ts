/**
 * Market reads for the portfolio, all through the Uniswap agent MCP server:
 *   - balances: `get_portfolio` on the execution chain (the single source of truth)
 *   - USD reference prices: `get_quote` on Ethereum mainnet, 1 token → USDC, cached 30 s in
 *     the PriceCache table (shared by the API and the worker)
 *   - 7-day highs (risk drawdown): `get_price_history` on mainnet, cached 10 min, best-effort
 * Background calls are `quiet` so they do not flood the user's live activity feed.
 */
import type { PrismaClient } from '@prisma/client';
import { Decimal, MAINNET_CHAIN_ID, UniswapMcp } from '@warden/shared';
import type { Redis } from 'ioredis';
import { AppError } from '../../lib/errors.js';
import { McpToolCallError, type UniswapMcpClient } from '../mcp/client.js';

export const PRICE_TTL_MS = 30_000;
/** A stale price is still better than none for display, up to this age. */
export const PRICE_STALE_MAX_MS = 10 * 60_000;
export const HIGH_TTL_MS = 10 * 60_000;
/** Mainnet quotes need a swapper; prices do not depend on it (same as the MCP server). */
export const REFERENCE_SWAPPER = '0x000000000000000000000000000000000000dEaD';

const SYSTEM_CTX = { traceId: 'market-data', userId: 'system', quiet: true } as const;

export interface PriceQuote {
  priceUsd: Decimal;
  fetchedAt: Date;
  stale: boolean;
}

function mcpUnavailable(err: unknown): AppError {
  const message =
    err instanceof McpToolCallError
      ? `Market data is unavailable right now (${err.code}). Please try again shortly.`
      : 'Market data is unavailable right now. Please try again shortly.';
  return new AppError('MARKET_DATA_UNAVAILABLE', 503, message, {
    code: err instanceof McpToolCallError ? err.code : 'UNKNOWN',
    retryable: err instanceof McpToolCallError ? err.retryable : true,
  });
}

export function requireMcp(mcp: UniswapMcpClient | null): UniswapMcpClient {
  if (!mcp) {
    throw new AppError(
      'MARKET_DATA_UNAVAILABLE',
      503,
      'The Uniswap data service is not configured on this server (MCP_AUTH_TOKEN).',
      { code: 'NOT_CONFIGURED', retryable: false },
    );
  }
  return mcp;
}

export class PriceService {
  private readonly inflight = new Map<string, Promise<PriceQuote | null>>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly mcp: UniswapMcpClient | null,
    private readonly log: { warn(obj: object, msg: string): void },
    private readonly now: () => number = Date.now,
  ) {}

  /** USD per whole token for a mainnet reference symbol (USDC ≡ 1). Null when unpriceable. */
  async usd(referenceSymbol: string): Promise<PriceQuote | null> {
    const symbol = normalise(referenceSymbol);
    if (symbol === 'USDC')
      return { priceUsd: new Decimal(1), fetchedAt: new Date(this.now()), stale: false };
    const key = `ref-price:v1:${symbol}`;
    const cached = await this.readCache(key);
    if (cached && this.now() - cached.fetchedAt.getTime() < PRICE_TTL_MS) return cached;

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.fetchQuote(symbol, key)
        .catch((err: unknown) => {
          this.log.warn({ err, symbol }, 'reference price unavailable');
          return null;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const fresh = await pending;
    if (fresh) return fresh;
    if (cached && this.now() - cached.fetchedAt.getTime() < PRICE_STALE_MAX_MS) {
      return { ...cached, stale: true };
    }
    return null;
  }

  /** Percent below the 7-day high (≥ 0), or null when price history is unavailable. */
  async drawdownPct(referenceSymbol: string, current: Decimal): Promise<Decimal | null> {
    const symbol = normalise(referenceSymbol);
    if (symbol === 'USDC') return new Decimal(0);
    const high = await this.high7d(symbol);
    if (!high) return null;
    // The live quote can be above the last recorded daily high.
    const peak = Decimal.max(high, current);
    return peak.minus(current).div(peak).times(100);
  }

  /** 7-day high in USD (10 min cache), or null when price history is unavailable. */
  async high7d(referenceSymbol: string): Promise<Decimal | null> {
    const symbol = normalise(referenceSymbol);
    const key = `ref-high7d:v1:${symbol}`;
    let high = await this.readCache(key);
    if (!high || this.now() - high.fetchedAt.getTime() >= HIGH_TTL_MS) {
      high = await this.fetchHigh(symbol, key).catch((err: unknown) => {
        this.log.warn({ err, symbol }, '7-day high unavailable');
        return high ?? null;
      });
    }
    return high && high.priceUsd.gt(0) ? high.priceUsd : null;
  }

  /** Mainnet percent change over the last hour, or null when history is unavailable. */
  async change1hPct(referenceSymbol: string): Promise<{ openUsd: Decimal } | null> {
    const mcp = requireMcp(this.mcp);
    const history = await mcp.callTool(
      'get_price_history',
      { symbol: normalise(referenceSymbol), window: '1h', interval: 'hour' },
      SYSTEM_CTX,
    );
    return history.open ? { openUsd: new Decimal(history.open) } : null;
  }

  private async fetchQuote(symbol: string, key: string): Promise<PriceQuote> {
    const mcp = requireMcp(this.mcp);
    const quote = await mcp.callTool(
      'get_quote',
      {
        chainId: MAINNET_CHAIN_ID,
        tokenIn: symbol,
        tokenOut: 'USDC',
        amount: '1',
        type: 'EXACT_INPUT',
        swapper: REFERENCE_SWAPPER,
      },
      SYSTEM_CTX,
    );
    const priceUsd = new Decimal(quote.amountOut.decimal);
    return this.writeCache(key, priceUsd);
  }

  private async fetchHigh(symbol: string, key: string): Promise<PriceQuote | null> {
    const mcp = requireMcp(this.mcp);
    const history = await mcp.callTool(
      'get_price_history',
      { symbol, window: '7d', interval: 'day' },
      SYSTEM_CTX,
    );
    if (!history.high) return null;
    return this.writeCache(key, new Decimal(history.high));
  }

  private async readCache(key: string): Promise<PriceQuote | null> {
    const row = await this.prisma.priceCache.findUnique({ where: { key } });
    if (!row) return null;
    const value = row.value as { priceUsd?: unknown } | null;
    if (typeof value?.priceUsd !== 'string') return null;
    try {
      return { priceUsd: new Decimal(value.priceUsd), fetchedAt: row.fetchedAt, stale: false };
    } catch {
      return null;
    }
  }

  private async writeCache(key: string, priceUsd: Decimal): Promise<PriceQuote> {
    const fetchedAt = new Date(this.now());
    const value = { priceUsd: priceUsd.toFixed(), source: 'uniswap-mcp' };
    await this.prisma.priceCache.upsert({
      where: { key },
      create: { key, value, fetchedAt },
      update: { value, fetchedAt },
    });
    return { priceUsd, fetchedAt, stale: false };
  }
}

function normalise(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  return upper === 'WETH' ? 'ETH' : upper;
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export type PortfolioSnapshot = UniswapMcp.ToolOutput<'get_portfolio'>;

export function snapshotCacheKey(userId: string): string {
  return `portfolio:raw:${userId}`;
}

/** Reads balances via MCP get_portfolio, sharing a short Redis cache between API and worker. */
export class BalanceReader {
  constructor(
    private readonly mcp: UniswapMcpClient | null,
    private readonly redis: Redis,
    private readonly cacheTtlSeconds = 60,
  ) {}

  async read(
    userId: string,
    chainId: number,
    address: string,
    opts: { maxAgeMs: number },
  ): Promise<PortfolioSnapshot> {
    if (opts.maxAgeMs > 0) {
      const cached = await this.redis.get(snapshotCacheKey(userId)).catch(() => null);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as { at: number; snapshot: unknown };
          const snapshot = UniswapMcp.GetPortfolioOutputSchema.parse(parsed.snapshot);
          if (
            Date.now() - parsed.at < opts.maxAgeMs &&
            snapshot.address.toLowerCase() === address.toLowerCase() &&
            snapshot.chainId === chainId
          ) {
            return snapshot;
          }
        } catch {
          // Corrupt cache entry: fall through to a fresh read.
        }
      }
    }
    const mcp = requireMcp(this.mcp);
    let snapshot: PortfolioSnapshot;
    try {
      snapshot = await mcp.callTool(
        'get_portfolio',
        { chainId, address },
        { traceId: `portfolio:${userId}`, userId, quiet: true },
      );
    } catch (err) {
      throw mcpUnavailable(err);
    }
    await this.redis
      .set(
        snapshotCacheKey(userId),
        JSON.stringify({ at: Date.now(), snapshot }),
        'EX',
        this.cacheTtlSeconds,
      )
      .catch(() => undefined);
    return snapshot;
  }
}
