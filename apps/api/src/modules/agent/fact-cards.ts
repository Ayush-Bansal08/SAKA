/**
 * Fact cards (PHASE 06 §2 InfoCard). An info answer's numbers come from the MCP tool results
 * the planner actually used — never from model text. Each recognised tool output becomes one
 * typed info card (`data` is an `InfoData`); the model's own words stay in the reply text.
 *   check_token   → token safety verdict + flags
 *   compare_pools → ranked pool table + the pick
 *   score_hook    → hook score, band, permissions, breakdown
 *   portfolio     → asked for ("portfolio", "/risk", "balance"): totals, tokens, risk, limits
 */
import { UniswapMcp, type InfoCard, type InfoData, type PortfolioResponse } from '@warden/shared';
import { getAddress } from 'viem';
import type { PlannerFact } from './planner.js';

const PORTFOLIO_QUESTION = /\b(portfolio|balances?|holdings|my risk|net worth)\b|^\s*\/risk\b/i;
const MAX_FACT_CARDS = 3;

type Out<T extends UniswapMcp.ToolName> = UniswapMcp.ToolOutput<T>;

function tokenCard(o: Out<'check_token'>): InfoCard {
  const name = o.symbol ?? `${o.address.slice(0, 6)}…${o.address.slice(-4)}`;
  const data: InfoData = {
    kind: 'token_check',
    chainId: o.chainId,
    symbol: o.symbol,
    name: o.name,
    address: getAddress(o.address),
    isNative: o.isNative,
    verdict: o.verdict,
    onAllowlist: o.onAllowlist,
    onUniswapUnsupportedList: o.onUniswapUnsupportedList,
    liquidityDepthUsd: o.liquidityDepthUsd,
    riskFlags: o.riskFlags,
  };
  return {
    type: 'info',
    title: `Token check · ${name}`,
    body:
      o.verdict === 'OK'
        ? `${name} passed the token checks.`
        : o.verdict === 'CAUTION'
          ? `${name} needs caution.`
          : `${name} failed the token checks — your agent will not trade it.`,
    data,
    marketDataSource: o.chainId === 1 ? 'reference' : 'execution',
  };
}

function poolCard(o: Out<'compare_pools'>): InfoCard {
  const pair = `${o.tokenA.symbol}/${o.tokenB.symbol}`;
  const data: InfoData = {
    kind: 'pool_compare',
    pair,
    marketLabel: o.market.label,
    recommendedPoolId: o.recommended?.poolId ?? null,
    rows: o.ranked.slice(0, 6).map((r) => ({
      rank: r.rank,
      poolId: r.poolId,
      feePct: r.fee / 10_000,
      hookAddress: /^0x0{40}$/i.test(r.hookAddress) ? null : getAddress(r.hookAddress),
      hookBand: r.hookBand,
      hookScore: r.hookScore,
      aprPct: r.referenceFeeAprPct,
      adjustedAprPct: r.adjustedAprPct,
      tvlUsd: r.referenceTvlUsd,
      usable: r.usableOnExecutionChain,
      reasons: r.reasons.slice(0, 3),
    })),
    reasons: o.reasons.slice(0, 4),
  };
  return {
    type: 'info',
    title: `Best pool for ${pair}`,
    body: o.recommended
      ? `Pick: the ${o.recommended.fee / 10_000}% pool (rank 1 of ${o.ranked.length}).`
      : `No usable ${pair} pool on the execution chain.`,
    data,
    marketDataSource: 'reference',
  };
}

function hookCard(o: Out<'score_hook'>): InfoCard {
  const data: InfoData = {
    kind: 'hook_score',
    chainId: o.chainId,
    address: getAddress(o.hookAddress),
    score: o.score,
    band: o.band,
    permissions: o.enabledPermissions.map((p) => ({ flag: p.flag, risk: p.risk })),
    upgradeable: o.facts.proxy.upgradeable,
    verifiedSource: o.facts.verifiedSource,
    owner: o.facts.owner ? getAddress(o.facts.owner) : null,
    ageDays: o.facts.ageDays,
    breakdown: o.breakdown
      .filter((b) => b.penalty !== 0)
      .slice(0, 8)
      .map((b) => ({ rule: b.rule, penalty: -Math.abs(b.penalty), evidence: b.evidence })),
  };
  return {
    type: 'info',
    title: `Hook ${o.hookAddress.slice(0, 6)}…${o.hookAddress.slice(-4)} · ${o.score}/100`,
    body: `${o.band === 'SAFE' ? 'Safe' : o.band === 'CAUTION' ? 'Caution' : 'Danger'} — scored with the Uniswap v4 Security Framework.`,
    data,
    marketDataSource: o.chainId === 1 ? 'reference' : 'execution',
  };
}

export function portfolioCard(p: PortfolioResponse): InfoCard {
  const data: InfoData = {
    kind: 'portfolio',
    totalUsd: p.totalUsd,
    pnlUsd: p.pnl.totalUsd,
    tokens: p.tokens.slice(0, 20).map((t) => ({
      symbol: t.symbol,
      amount: t.balance,
      usd: t.valueUsd,
    })),
    risk: { score: p.risk.score, label: p.risk.label },
    limits: {
      perActionUsd: p.limits.perActionUsd,
      perDayUsd: p.limits.perDayUsd,
      usedTodayUsd: p.limits.usedTodayUsd,
    },
  };
  return {
    type: 'info',
    title: 'Your portfolio',
    body: `$${p.totalUsd} across ${p.tokens.length} token${p.tokens.length === 1 ? '' : 's'}.`,
    data,
    marketDataSource: 'execution',
  };
}

/** Typed info cards for an answer; unknown or failed tool outputs are skipped. */
export function factCards(
  facts: readonly PlannerFact[],
  opts: { userText: string; portfolio: PortfolioResponse | null },
): InfoCard[] {
  const latest = new Map<string, InfoCard>();
  for (const f of facts) {
    if (f.tool === 'check_token') {
      const o = UniswapMcp.TOOL_OUTPUT_SCHEMAS.check_token.safeParse(f.output);
      if (o.success) latest.set(`token:${o.data.address.toLowerCase()}`, tokenCard(o.data));
    } else if (f.tool === 'compare_pools') {
      const o = UniswapMcp.TOOL_OUTPUT_SCHEMAS.compare_pools.safeParse(f.output);
      if (o.success) latest.set('pools', poolCard(o.data));
    } else if (f.tool === 'score_hook') {
      const o = UniswapMcp.TOOL_OUTPUT_SCHEMAS.score_hook.safeParse(f.output);
      if (o.success) latest.set(`hook:${o.data.hookAddress.toLowerCase()}`, hookCard(o.data));
    }
  }
  const cards = [...latest.values()];
  if (opts.portfolio && PORTFOLIO_QUESTION.test(opts.userText))
    cards.unshift(portfolioCard(opts.portfolio));
  return cards.slice(0, MAX_FACT_CARDS);
}
