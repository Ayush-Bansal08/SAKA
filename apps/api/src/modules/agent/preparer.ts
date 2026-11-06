/**
 * Preparer (PHASE 05 §1): maps an ActionIntent to MCP build-tool calls — deterministic, no LLM.
 *
 *   swap_exact_in / swap_exact_out → build_swap        swap_and_send → build_swap + recipient
 *   transfer → build_transfer                         lp_open → compare_pools? → build_lp_position
 *   lp_rebalance → build_rebalance (+ next build_lp_position after the exit)
 *   lp_exit → build_lp_exit                           create_trigger → plan_trigger (no tx)
 *
 * It resolves tokens, applies the profile slippage, values the action in USD with the mainnet
 * reference price (value at risk: input value for swaps/LP, the amount for transfers) and
 * computes `planHash` = sha256(canonical JSON of intent, chain, tokens, raw amounts, recipient,
 * pool). The exact build-tool arguments are stored so execution can rebuild fresh calldata
 * from the same, already-approved facts.
 */
import type { PrismaClient } from '@prisma/client';
import {
  Decimal,
  NATIVE_TOKEN_ADDRESS,
  type ActionIntent,
  type ExecutionChainId,
  type QuoteSummary,
  type TokenRef,
  type UniswapMcp,
} from '@warden/shared';
import { getAddress } from 'viem';
import type { AllowlistEntry } from '../../config/env.js';
import { canonicalHash } from '../../lib/canonical.js';
import { McpToolCallError, type McpCallContext, type UniswapMcpClient } from '../mcp/client.js';
import type { PriceService } from '../portfolio/market.js';
import { executionTokens, findToken } from '../wallet/tokens.js';
import { describeIntent } from './describe.js';

type BuildTool =
  'build_swap' | 'build_transfer' | 'build_lp_position' | 'build_lp_exit' | 'build_rebalance';
export type BuildCall = {
  [K in BuildTool]: { tool: K; args: UniswapMcp.ToolInput<K> };
}[BuildTool];

export type StepKind = UniswapMcp.TxStep['kind'];
export interface PlanStep {
  index: number;
  kind: StepKind;
  description: string;
  tx: UniswapMcp.TxRequest;
}

/** Persisted in ActionPlan.steps (JSON). */
export interface StoredSteps {
  version: 1;
  call: BuildCall;
  status: 'READY' | 'NEEDS_SIGNATURE';
  steps: PlanStep[];
  signature: { kind: 'PERMIT2' | 'V4_BATCH_PERMIT' } | null;
  /** The main step that is only built after signing (shown in the preview). */
  pendingMain: { kind: StepKind; description: string } | null;
  /** lp_rebalance: the follow-up build_lp_position call, run after the exit confirms. */
  next: { tool: 'build_lp_position'; args: UniswapMcp.ToolInput<'build_lp_position'> } | null;
  summary: UniswapMcp.BuildSummary | null;
  /** Non-native tokens to run check_token on. */
  tokenChecks: string[];
  slippagePct: number | null;
  priceImpactPct: number | null;
  gasUsd: string | null;
  hookAddress: string | null;
  poolRef: string | null;
  recipient: string | null;
  lpPositionId: string | null;
  warnings: string[];
  /** Filled by the pipeline: the facts behind the trade score (for GET /plans/:id). */
  safety?: {
    breakdown: { rule: string; penalty: number; evidence: string }[];
    tokens: unknown[];
    portfolioUsd: string | null;
  };
}

export interface PreparedAction {
  kind: 'action';
  intent: ActionIntent;
  chainId: number;
  stored: StoredSteps;
  buildError: { code: string; message: string } | null;
  amountUsd: Decimal | null;
  quote: QuoteSummary | null;
  planHash: string;
  summary: string;
}

export interface PreparedTrigger {
  kind: 'trigger';
  intent: Extract<ActionIntent, { type: 'create_trigger' | 'cancel_trigger' }>;
  summary: string;
  plan: UniswapMcp.ToolOutput<'plan_trigger'> | null;
  error: string | null;
}

export type Prepared = PreparedAction | PreparedTrigger;

export interface PreparerDeps {
  prisma: PrismaClient;
  mcp: UniswapMcpClient;
  prices: Pick<PriceService, 'usd'>;
  chainId: ExecutionChainId;
  allowlist: readonly AllowlistEntry[];
}

export interface PrepareAccount {
  userId: string;
  wallet: `0x${string}`;
  maxSlippagePct: number;
}

export class PrepareError extends Error {
  override name = 'PrepareError';
}

const ZERO = NATIVE_TOKEN_ADDRESS;
const tokenArg = (t: TokenRef) => (t.address ? getAddress(t.address) : t.symbol!.toUpperCase());
const isNativeRef = (t: TokenRef) =>
  (t.address ? t.address.toLowerCase() === ZERO : false) ||
  (!t.address && t.symbol?.toUpperCase() === 'ETH');
const RANGE_PRESET = { narrow: 'narrow', balanced: 'medium', wide: 'wide', full: 'wide' } as const;

/** USD per whole token from the mainnet reference price (null when not priceable). */
async function priceOf(
  deps: PreparerDeps,
  token: { address: string } | undefined,
): Promise<Decimal | null> {
  if (!token) return null;
  const known = findToken(executionTokens(deps.chainId, deps.allowlist), token.address);
  if (!known) return null;
  const quote = await deps.prices.usd(known.referenceSymbol).catch(() => null);
  return quote && quote.priceUsd.gt(0) ? quote.priceUsd : null;
}

function emptyStored(call: BuildCall, extra: Partial<StoredSteps> = {}): StoredSteps {
  return {
    version: 1,
    call,
    status: 'READY',
    steps: [],
    signature: null,
    pendingMain: null,
    next: null,
    summary: null,
    tokenChecks: [],
    slippagePct: null,
    priceImpactPct: null,
    gasUsd: null,
    hookAddress: null,
    poolRef: null,
    recipient: null,
    lpPositionId: null,
    warnings: [],
    ...extra,
  };
}

const MAIN_KIND: Record<BuildTool, StepKind> = {
  build_swap: 'SWAP',
  build_transfer: 'TRANSFER',
  build_lp_position: 'LP_CREATE',
  build_lp_exit: 'LP_DECREASE',
  build_rebalance: 'LP_DECREASE',
};

/** Calls the build tool and folds the result into `stored`. */
async function runBuild(
  deps: PreparerDeps,
  ctx: McpCallContext,
  stored: StoredSteps,
): Promise<{ code: string; message: string } | null> {
  try {
    const out = (await deps.mcp.callTool(
      stored.call.tool,
      stored.call.args as never,
      ctx,
    )) as UniswapMcp.BuildResultObject & { next?: StoredSteps['next'] & { expected?: unknown } };
    stored.status = out.status;
    stored.summary = out.summary;
    stored.warnings = out.warnings ?? [];
    const txs = out.status === 'READY' ? (out.steps ?? []) : (out.preSteps ?? []);
    stored.steps = txs.map((s, index) => ({
      index,
      kind: s.kind,
      description: s.description,
      tx: s.tx,
    }));
    if (out.status === 'NEEDS_SIGNATURE') {
      stored.signature = { kind: out.signature!.kind };
      stored.pendingMain = {
        kind: MAIN_KIND[stored.call.tool],
        description:
          stored.call.tool === 'build_swap'
            ? 'Swap via Uniswap Universal Router'
            : 'Open the v4 position',
      };
    }
    if (out.next) stored.next = { tool: 'build_lp_position', args: out.next.args };
    stored.priceImpactPct = out.summary.priceImpactPct ?? null;
    stored.gasUsd = out.summary.gasFeeUsd ?? null;
    stored.hookAddress = out.summary.hookAddress ?? stored.hookAddress;
    stored.poolRef = out.summary.poolRef ?? stored.poolRef;
    return null;
  } catch (err) {
    if (err instanceof McpToolCallError)
      return { code: err.code, message: err.message.slice(0, 300) };
    throw err;
  }
}

function tokenAmount(
  info: UniswapMcp.TokenInfo | undefined,
  amount: UniswapMcp.Amount | undefined,
  price: Decimal | null,
): QuoteSummary['amountIn'] | null {
  if (!info || !amount) return null;
  return {
    symbol: info.symbol,
    address: getAddress(info.address),
    amount: amount.decimal,
    decimals: info.decimals,
    ...(price
      ? { usd: new Decimal(amount.decimal).times(price).toDecimalPlaces(2).toFixed(2) }
      : {}),
  };
}

/** Decimal string with at most `decimals` (and 8) fractional digits, rounded down. */
function toTokenDecimal(value: Decimal, decimals: number): string {
  return value.toDecimalPlaces(Math.min(decimals, 8), Decimal.ROUND_DOWN).toFixed();
}

// ---------------------------------------------------------------------------

export async function prepare(
  deps: PreparerDeps,
  ctx: McpCallContext,
  account: PrepareAccount,
  intent: ActionIntent,
): Promise<Prepared> {
  const chainId = deps.chainId;
  const slippage = (s?: number) => Math.min(s ?? account.maxSlippagePct, 50);

  if (intent.type === 'create_trigger' || intent.type === 'cancel_trigger')
    return prepareTrigger(deps, ctx, intent);
  if (intent.type === 'info') throw new PrepareError('Info answers are not prepared');

  let stored: StoredSteps;
  let fallbackUsd: string | undefined = 'amountUsd' in intent ? intent.amountUsd : undefined;
  const checks = (...refs: TokenRef[]) => refs.filter((r) => !isNativeRef(r)).map(tokenArg);

  switch (intent.type) {
    case 'swap_exact_in':
    case 'swap_exact_out':
    case 'swap_and_send': {
      const exactIn =
        intent.type === 'swap_exact_in' ||
        (intent.type === 'swap_and_send' && intent.mode === 'exact_in');
      const amount =
        intent.type === 'swap_exact_in'
          ? intent.amountIn
          : intent.type === 'swap_exact_out'
            ? intent.amountOut
            : intent.amount;
      const recipient =
        intent.type === 'swap_and_send' && getAddress(intent.recipient) !== account.wallet
          ? getAddress(intent.recipient)
          : undefined;
      const slippagePct = slippage(intent.maxSlippagePct);
      stored = emptyStored(
        {
          tool: 'build_swap',
          args: {
            chainId,
            swapper: account.wallet,
            tokenIn: tokenArg(intent.tokenIn),
            tokenOut: tokenArg(intent.tokenOut),
            amount,
            type: exactIn ? 'EXACT_INPUT' : 'EXACT_OUTPUT',
            slippagePct,
            ...(recipient ? { recipient } : {}),
          },
        },
        {
          tokenChecks: checks(intent.tokenIn, intent.tokenOut),
          slippagePct,
          recipient: recipient ?? null,
        },
      );
      break;
    }
    case 'transfer': {
      const to = getAddress(intent.recipient);
      stored = emptyStored(
        {
          tool: 'build_transfer',
          args: {
            chainId,
            from: account.wallet,
            token: tokenArg(intent.token),
            amount: intent.amount,
            to,
          },
        },
        { tokenChecks: checks(intent.token), recipient: to === account.wallet ? null : to },
      );
      break;
    }
    case 'lp_open': {
      const slippagePct = slippage();
      let poolId = intent.poolRef?.poolId ?? null;
      let hookAddress: string | null = intent.poolRef?.hookAddress ?? null;
      let pair: [UniswapMcp.TokenInfo, UniswapMcp.TokenInfo] | null = null;
      if (!poolId) {
        const comparison = await deps.mcp.callTool(
          'compare_pools',
          { chainId, tokenA: tokenArg(intent.token0), tokenB: tokenArg(intent.token1) },
          ctx,
        );
        const pick =
          (comparison.recommended?.usableOnExecutionChain ? comparison.recommended : null) ??
          comparison.ranked.find((r) => r.usableOnExecutionChain) ??
          null;
        if (!pick)
          throw new PrepareError(
            `No usable ${comparison.tokenA.symbol}/${comparison.tokenB.symbol} pool on this chain.`,
          );
        poolId = pick.poolId;
        hookAddress = pick.hookAddress;
        pair = [comparison.tokenA, comparison.tokenB];
      }
      // build_lp_position wants token0/token1 in currency order (lower address first).
      const refs = [tokenArg(intent.token0), tokenArg(intent.token1)];
      const ordered = pair
        ? [...pair].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))
        : null;
      const [t0, t1] = ordered
        ? [getAddress(ordered[0]!.address), getAddress(ordered[1]!.address)]
        : refs;
      const swapped = ordered
        ? getAddress(ordered[0]!.address) !== getAddress(pair![0]!.address)
        : false;
      let independent: { token: string; amount: string };
      const a0 = swapped ? intent.amount1 : intent.amount0;
      const a1 = swapped ? intent.amount0 : intent.amount1;
      if (a0) independent = { token: t0!, amount: a0 };
      else if (a1) independent = { token: t1!, amount: a1 };
      else {
        // Half of the USD into token0; the LP API computes the token1 side for the range.
        const info = ordered?.[0];
        const price = await priceOf(deps, info ?? { address: t0! });
        if (!price || !intent.amountUsd)
          throw new PrepareError(
            'Could not price the liquidity amount. Please give a token amount.',
          );
        independent = {
          token: t0!,
          amount: toTokenDecimal(
            new Decimal(intent.amountUsd).div(2).div(price),
            info?.decimals ?? 18,
          ),
        };
      }
      stored = emptyStored(
        {
          tool: 'build_lp_position',
          args: {
            chainId,
            owner: account.wallet,
            pool: { poolReference: poolId as `0x${string}`, token0: t0!, token1: t1! },
            independentToken: independent,
            range: { preset: RANGE_PRESET[intent.rangePreset] },
            slippagePct,
          },
        },
        {
          tokenChecks: checks(intent.token0, intent.token1),
          slippagePct,
          poolRef: poolId,
          hookAddress:
            hookAddress && hookAddress.toLowerCase() !== ZERO ? getAddress(hookAddress) : null,
          ...(intent.rangePreset === 'full'
            ? { warnings: ['Full range is opened as the widest preset (±40%).'] }
            : {}),
        },
      );
      break;
    }
    case 'lp_exit':
    case 'lp_rebalance': {
      const position = await deps.prisma.lpPosition.findFirst({
        where: { id: intent.positionId, userId: account.userId, status: 'OPEN' },
      });
      if (!position)
        throw new PrepareError('That liquidity position was not found or is already closed.');
      const slippagePct = slippage();
      const base = {
        chainId,
        owner: account.wallet,
        tokenId: position.tokenId,
        token0: getAddress(position.token0),
        token1: getAddress(position.token1),
      };
      stored =
        intent.type === 'lp_exit'
          ? emptyStored(
              {
                tool: 'build_lp_exit',
                args: {
                  ...base,
                  protocol: 'V4',
                  percent: Math.min(100, Math.max(1, Math.round(intent.percent))),
                  claimFees: true,
                  slippagePct,
                },
              },
              {
                lpPositionId: position.id,
                poolRef: position.poolId,
                hookAddress: position.hookAddress,
                slippagePct,
              },
            )
          : emptyStored(
              {
                tool: 'build_rebalance',
                args: {
                  ...base,
                  poolReference: position.poolId as `0x${string}`,
                  newRange: { preset: RANGE_PRESET[intent.rangePreset] },
                  slippagePct,
                },
              },
              {
                lpPositionId: position.id,
                poolRef: position.poolId,
                hookAddress: position.hookAddress,
                slippagePct,
              },
            );
      // Value at risk: the position's current value (falls back to its cost basis).
      const read = await deps.mcp
        .callTool(
          'get_lp_positions',
          { chainId, owner: account.wallet, tokenIds: [position.tokenId] },
          ctx,
        )
        .catch(() => null);
      const share =
        intent.type === 'lp_exit' ? new Decimal(intent.percent).div(100) : new Decimal(1);
      const value = read?.positions[0]?.valueUsd ?? position.costBasisUsd.toString();
      fallbackUsd = new Decimal(value).times(share).toDecimalPlaces(2).toFixed(2);
      break;
    }
  }

  const buildError = await runBuild(deps, ctx, stored);
  const s = stored.summary;

  // --- USD value at risk ------------------------------------------------------
  let amountUsd: Decimal | null = null;
  let priceIn: Decimal | null = null;
  let priceOut: Decimal | null = null;
  if (s?.tokenIn) priceIn = await priceOf(deps, s.tokenIn);
  if (s?.tokenOut) priceOut = await priceOf(deps, s.tokenOut);
  if (stored.call.tool === 'build_swap' || stored.call.tool === 'build_transfer') {
    if (s?.amountIn && priceIn) amountUsd = new Decimal(s.amountIn.decimal).times(priceIn);
    else if (s?.amountOut && priceOut) amountUsd = new Decimal(s.amountOut.decimal).times(priceOut);
  } else if (stored.call.tool === 'build_lp_position' && s?.lp) {
    const [p0, p1] = await Promise.all([priceOf(deps, s.lp.token0), priceOf(deps, s.lp.token1)]);
    const v0 = s.lp.amount0 && p0 ? new Decimal(s.lp.amount0.decimal).times(p0) : null;
    const v1 = s.lp.amount1 && p1 ? new Decimal(s.lp.amount1.decimal).times(p1) : null;
    if (v0 && v1) amountUsd = v0.plus(v1);
  }
  if (!amountUsd && fallbackUsd) amountUsd = new Decimal(fallbackUsd);
  if (amountUsd) amountUsd = amountUsd.toDecimalPlaces(2);

  const quote: QuoteSummary | null =
    stored.call.tool === 'build_swap' && s
      ? (() => {
          const amountIn = tokenAmount(s.tokenIn, s.amountIn, priceIn);
          const amountOut = tokenAmount(s.tokenOut, s.amountOut, priceOut);
          if (!amountIn || !amountOut) return null;
          return {
            amountIn,
            amountOut,
            priceImpactPct: Math.max(0, s.priceImpactPct ?? 0),
            ...(s.gasFeeUsd
              ? { gasUsd: new Decimal(s.gasFeeUsd).toDecimalPlaces(2).toFixed(2) }
              : {}),
            ...(s.route ? { route: s.route } : {}),
            slippagePct: stored.slippagePct ?? 0,
          };
        })()
      : null;

  const planHash = canonicalHash({
    intent,
    chainId,
    tool: stored.call.tool,
    tokens: {
      in: s?.tokenIn?.address ?? s?.lp?.token0.address ?? null,
      out: s?.tokenOut?.address ?? s?.lp?.token1.address ?? null,
    },
    amounts: {
      in: s?.amountIn?.raw ?? s?.lp?.amount0?.raw ?? null,
      out: s?.amountOut?.raw ?? s?.lp?.amount1?.raw ?? null,
      args: 'amount' in stored.call.args ? stored.call.args.amount : null,
    },
    recipient: stored.recipient,
    poolRef: stored.poolRef,
    lpPositionId: stored.lpPositionId,
  });

  return {
    kind: 'action',
    intent,
    chainId,
    stored,
    buildError,
    amountUsd,
    quote,
    planHash,
    summary: describeIntent(intent),
  };
}

async function prepareTrigger(
  deps: PreparerDeps,
  ctx: McpCallContext,
  intent: Extract<ActionIntent, { type: 'create_trigger' | 'cancel_trigger' }>,
): Promise<PreparedTrigger> {
  if (intent.type === 'cancel_trigger')
    return { kind: 'trigger', intent, summary: describeIntent(intent), plan: null, error: null };
  const input = triggerInput(intent.rule);
  try {
    const out = await deps.mcp.callTool('plan_trigger', input, ctx);
    return { kind: 'trigger', intent, summary: out.humanSummary, plan: out, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'trigger',
      intent,
      summary: describeIntent(intent),
      plan: null,
      error: message.slice(0, 300),
    };
  }
}

/** RuleSpec (planner) → plan_trigger input (MCP). */
export function triggerInput(
  rule: Extract<ActionIntent, { type: 'create_trigger' }>['rule'],
): UniswapMcp.PlanTriggerInput {
  const sym = (t: TokenRef) => (t.symbol ?? 'ETH').toUpperCase();
  type Cond = UniswapMcp.PlanTriggerInput['condition'];
  const cond = (c: Extract<typeof rule, { condition: unknown }>['condition']): Cond =>
    c.type === 'change_pct'
      ? { type: 'price_change_pct', symbol: sym(c.token), pct: c.changePct, from: 'now' }
      : { type: c.type, symbol: sym(c.token), priceUsd: c.priceUsd };
  type Action = UniswapMcp.PlanTriggerInput['actions'][number];
  const step = (s: Extract<typeof rule, { step: unknown }>['step']): Action =>
    s.type === 'sell_percent'
      ? {
          type: 'swap_exact_in',
          tokenIn: sym(s.token),
          tokenOut: sym(s.receiveToken),
          amountIn: `${s.percent}%`,
        }
      : s.type === 'buy_usd'
        ? {
            type: 'swap_exact_in',
            tokenIn: sym(s.payToken),
            tokenOut: sym(s.token),
            amountIn: `$${s.amountUsd}`,
          }
        : {
            type: 'lp_open',
            token0: sym(s.token0),
            token1: sym(s.token1),
            rangePreset: RANGE_PRESET[s.rangePreset],
          };
  switch (rule.kind) {
    case 'DCA':
      return {
        kind: 'DCA',
        condition: {
          type: 'schedule',
          every: rule.intervalHours >= 24 * 7 ? 'week' : 'day',
          atLocalTime: '09:00',
        },
        actions: [
          {
            type: 'swap_exact_in',
            tokenIn: sym(rule.pay),
            tokenOut: sym(rule.buy),
            amountIn: `$${rule.amountUsd}`,
          },
        ],
      };
    case 'CHAINED':
      return { kind: 'CHAINED', condition: cond(rule.condition), actions: rule.steps.map(step) };
    case 'PRICE_ALERT':
      return { kind: 'PRICE_ALERT', condition: cond(rule.condition), actions: [] };
    default:
      return { kind: rule.kind, condition: cond(rule.condition), actions: [step(rule.step)] };
  }
}
