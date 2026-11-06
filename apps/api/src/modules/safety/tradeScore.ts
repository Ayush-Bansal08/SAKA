/**
 * Deterministic trade safety score (PHASE_00 §9): 100 − penalties, floor 0. Every penalty is a
 * breakdown entry `{ rule, penalty, evidence }` (penalty ≤ 0). Facts that refuse the action
 * outright (price impact > 5%, unsupported token, too little liquidity) are returned as
 * REFUSE reasons for the policy engine — the score never decides alone.
 */
import { Decimal, TRADE_SCORE, type PolicyReason } from '@warden/shared';

export interface TokenCheckFact {
  symbol: string | null;
  address: string;
  isNative: boolean;
  onAllowlist: boolean;
  /** null = the unsupported list could not be fetched. */
  onUniswapUnsupportedList: boolean | null;
  liquidityDepthUsd: string | null;
  verdict: 'OK' | 'CAUTION' | 'BLOCK';
  riskFlags: string[];
}

export interface TradeScoreInput {
  /** Effective impact of the whole quote vs the deepest direct pool's mid price. */
  priceImpactPct: number | null;
  /** The Uniswap API's raw `priceImpact` — evidence only, never scored. */
  apiPriceImpactPct?: number | null;
  amountUsd: Decimal | null;
  portfolioUsd: Decimal | null;
  /** check_token result for every non-native token involved. */
  tokens: TokenCheckFact[];
  gasUsd: Decimal | null;
  /** Hook score when a v4 hook pool is in the route or is the LP target. */
  hookScore: number | null;
  slippagePct: number | null;
  maxSlippagePct: number;
}

export interface TradeScoreItem {
  rule: string;
  penalty: number;
  evidence: string;
}

export interface TradeScoreResult {
  score: number;
  breakdown: TradeScoreItem[];
  refuse: PolicyReason[];
}

const T = TRADE_SCORE;
const pct = (d: Decimal) => d.toDecimalPlaces(2).toString();
const tokenName = (t: TokenCheckFact) =>
  t.symbol ?? `${t.address.slice(0, 6)}…${t.address.slice(-4)}`;

/**
 * The Uniswap API's own figure, shown next to ours when it differs: on thin testnets a split
 * through a mispriced pool can make it report ~96% for a quote that is actually the best one.
 */
function apiImpactNote(api: number | null | undefined, ours: Decimal): string {
  if (api === null || api === undefined) return '';
  const a = new Decimal(api);
  if (a.minus(ours).abs().lt(0.01)) return '';
  return `; effective price vs the main pool — the Uniswap API reported ${pct(a)}%`;
}

export function tradeScore(input: TradeScoreInput): TradeScoreResult {
  const breakdown: TradeScoreItem[] = [];
  const refuse: PolicyReason[] = [];
  const add = (rule: string, penalty: number, evidence: string) =>
    breakdown.push({ rule, penalty: penalty === 0 ? 0 : -Math.abs(penalty), evidence });

  // Price impact: free below 0.3%, then −10 per started 0.5%; REFUSE above 5%.
  if (input.priceImpactPct !== null) {
    const impact = new Decimal(input.priceImpactPct);
    const excess = impact.minus(T.priceImpact.freeBelowPct);
    const steps = excess.gt(0) ? excess.div(T.priceImpact.stepPct).ceil().toNumber() : 0;
    add(
      'price_impact',
      // Capped at the whole score so the breakdown stays readable for extreme impacts.
      Math.min(steps * T.priceImpact.penaltyPerStep, T.max),
      `Price impact ${pct(impact)}%${steps ? ` (${steps} × 0.5% above ${T.priceImpact.freeBelowPct}%)` : ''}${apiImpactNote(input.apiPriceImpactPct, impact)}`,
    );
    if (impact.gt(T.priceImpact.refuseAbovePct))
      refuse.push({
        code: 'PRICE_IMPACT_TOO_HIGH',
        message: `Price impact ${pct(impact)}% is above the ${T.priceImpact.refuseAbovePct}% hard limit`,
        value: impact.toDecimalPlaces(2).toNumber(),
        limit: T.priceImpact.refuseAbovePct,
      });
  }

  // Size vs portfolio.
  if (input.amountUsd && input.portfolioUsd && input.portfolioUsd.gt(0)) {
    const share = input.amountUsd.div(input.portfolioUsd).times(100);
    const penalty = share.gt(50)
      ? T.sizeVsPortfolio.over50PctPenalty
      : share.gt(25)
        ? T.sizeVsPortfolio.over25PctPenalty
        : 0;
    add('size_vs_portfolio', penalty, `${pct(share)}% of your portfolio`);
  }

  // Tokens: −40 each when not allowlisted; REFUSE when unsupported, blocked or too illiquid.
  for (const t of input.tokens) {
    if (t.isNative) continue;
    const name = tokenName(t);
    if (!t.onAllowlist)
      add(
        'token_not_allowlisted',
        T.token.notOnAllowlistPenalty,
        `${name} is not on the allowlist`,
      );
    if (t.onUniswapUnsupportedList === true || t.verdict === 'BLOCK') {
      refuse.push({
        code: 'UNSUPPORTED_TOKEN',
        message:
          t.onUniswapUnsupportedList === true
            ? `${name} is on the Uniswap unsupported-token list`
            : `${name} failed the token check (${t.riskFlags.join(', ') || 'blocked'})`,
      });
      continue;
    }
    if (!t.onAllowlist) {
      const depth = t.liquidityDepthUsd !== null ? new Decimal(t.liquidityDepthUsd) : null;
      if (depth === null || depth.lt(T.token.minLiquidityDepthUsd))
        refuse.push({
          code: 'UNSUPPORTED_TOKEN',
          message:
            depth === null
              ? `${name} has no measurable liquidity on Uniswap`
              : `${name} has only $${depth.toDecimalPlaces(0).toString()} of liquidity (minimum $${T.token.minLiquidityDepthUsd.toLocaleString('en-US')})`,
          ...(depth !== null ? { value: depth.toDecimalPlaces(0).toNumber() } : {}),
          limit: T.token.minLiquidityDepthUsd,
        });
    }
  }

  // Gas vs value.
  if (input.gasUsd && input.amountUsd && input.amountUsd.gt(0)) {
    const share = input.gasUsd.div(input.amountUsd).times(100);
    add(
      'gas_vs_value',
      share.gt(T.gas.maxGasSharePct) ? T.gas.penalty : 0,
      `Gas ≈ $${input.gasUsd.toDecimalPlaces(2).toString()} (${pct(share)}% of the value)`,
    );
  }

  // Hook pool: −(100 − hookScore) / 2, rounded up (the conservative side).
  if (input.hookScore !== null) {
    const penalty = Math.ceil((100 - input.hookScore) * T.hookPenaltyFactor);
    add('hook_pool', penalty, `Pool hook scores ${input.hookScore}/100`);
  }

  // Slippage setting above the profile max.
  if (input.slippagePct !== null && input.slippagePct > input.maxSlippagePct)
    add(
      'slippage_above_profile',
      T.slippageAboveProfileMaxPenalty,
      `Slippage ${input.slippagePct}% is above your ${input.maxSlippagePct}% profile max`,
    );

  const total = breakdown.reduce((acc, b) => acc + b.penalty, 0);
  return { score: Math.max(T.min, T.max + total), breakdown, refuse };
}
