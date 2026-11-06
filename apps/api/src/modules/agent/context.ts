/**
 * Trusted planner context (PHASE 04 §2): risk profile and limits, today's remaining limit,
 * a compact portfolio snapshot, reference USD prices, known recipients, active triggers,
 * the token allowlist and the pending intent (for edits). No secrets, no signing material.
 */
import {
  ActionIntentSchema,
  type ActionIntent,
  type Decimal,
  type PortfolioResponse,
} from '@warden/shared';
import type { ChainToken } from '../wallet/tokens.js';

export interface PlannerContext {
  chainId: number;
  chainName: string;
  /** The user's agent wallet (null before onboarding). */
  wallet: string | null;
  /** `swapper` for quotes: the wallet, or a fixed reference address before one exists. */
  quoteSwapper: string;
  riskProfile?: string;
  limits?: {
    perActionUsd: string;
    perDayUsd: string;
    usedTodayUsd: string;
    remainingTodayUsd: string;
    maxSlippagePct?: number;
  };
  portfolio?: {
    totalUsd: string;
    tokens: { symbol: string; balance: string; valueUsd: string | null }[];
    riskLabel?: string;
    /** Open LP positions: `id` is what lp_rebalance / lp_exit take as positionId. */
    lpPositions?: { id: string; pair: string; inRange: boolean; valueUsd: string | null }[];
  };
  /** USD per whole token (mainnet reference), by symbol. */
  referencePricesUsd: Record<string, string>;
  knownRecipients: string[];
  activeTriggers: { id: string; kind: string; spec: unknown }[];
  tokenAllowlist: { symbol: string; address: string; decimals: number }[];
  pendingIntent?: ActionIntent;
}

const MAX_TOKENS = 12;

export function compactPortfolio(portfolio: PortfolioResponse): PlannerContext['portfolio'] {
  return {
    totalUsd: portfolio.totalUsd,
    tokens: portfolio.tokens
      .slice(0, MAX_TOKENS)
      .map((t) => ({ symbol: t.symbol, balance: t.balance, valueUsd: t.valueUsd })),
    riskLabel: portfolio.risk.label,
    lpPositions: portfolio.lpPositions.slice(0, 10).map((p) => ({
      id: p.id,
      pair: `${p.token0.symbol}/${p.token1.symbol}`,
      inRange: p.inRange,
      valueUsd: p.valueUsd,
    })),
  };
}

export function allowlistForPlanner(tokens: ChainToken[]): PlannerContext['tokenAllowlist'] {
  return tokens.map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals }));
}

/** Reference prices for every allowlisted symbol (null prices are left out). */
export async function referencePrices(
  tokens: ChainToken[],
  usd: (referenceSymbol: string) => Promise<{ priceUsd: Decimal } | null>,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    tokens.map(async (t) => {
      const quote = await usd(t.referenceSymbol).catch(() => null);
      if (!quote || quote.priceUsd.lte(0)) return null;
      const price = quote.priceUsd.gte(1)
        ? quote.priceUsd.toFixed(2)
        : quote.priceUsd.toSignificantDigits(6).toFixed();
      return [t.symbol, price] as const;
    }),
  );
  return Object.fromEntries(entries.filter((e): e is readonly [string, string] => e !== null));
}

/** The intent of the most recent agent message, if that message still holds a pending plan. */
export function pendingIntentFrom(cards: unknown): ActionIntent | undefined {
  if (!Array.isArray(cards)) return undefined;
  for (const card of cards) {
    if (card && typeof card === 'object' && (card as { type?: unknown }).type === 'intent') {
      const parsed = ActionIntentSchema.safeParse((card as { intent?: unknown }).intent);
      if (parsed.success) return parsed.data;
    }
  }
  return undefined;
}
