/**
 * PHASE 05 test doubles. The MCP stub runs through the real UniswapMcpClient, so every scripted
 * tool output is validated by the shared schemas exactly as in production.
 */
import { createHash } from 'node:crypto';
import { Decimal, executionContracts, NATIVE_TOKEN_ADDRESS } from '@warden/shared';
import { getAddress, pad, toHex } from 'viem';
import type { PrismaClient } from '@prisma/client';
import { UniswapMcpClient, type McpClientLike } from '../src/modules/mcp/client.js';
import type { ChainClient, ChainReceipt, CallRequest } from '../src/modules/execution/chain.js';
import { SimulationRevert } from '../src/modules/execution/chain.js';
import type { JobQueues } from '../src/modules/execution/jobs.js';
import type { DecisionLogStorage } from '../src/modules/decisionlog/storage.js';
import type { TypedDataInput, UnsignedTx, WalletProvider } from '../src/modules/wallet/privy.js';
import { randomAddress, silentLog } from './fakes.js';

export const CHAIN_ID = 11155111;
export const SEPOLIA = executionContracts(11155111);
export const USDC = getAddress(SEPOLIA.usdc!);
export const ROUTER = SEPOLIA.universalRouter['2.1.2']!;
export const PERMIT2 = SEPOLIA.permit2;
export const POSITION_MANAGER = SEPOLIA.positionManager;
export const ETH_INFO = {
  address: NATIVE_TOKEN_ADDRESS,
  symbol: 'ETH',
  decimals: 18,
  isNative: true,
};
export const USDC_INFO = { address: USDC, symbol: 'USDC', decimals: 6, isNative: false };
export const SCAM = getAddress('0x00000000000000000000000000000000deadbeef');
export const POOL_ID = `0x${'11'.repeat(32)}`;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export class RecordingJobs implements JobQueues {
  executions: { planId: string; delayMs: number }[] = [];
  logs: string[] = [];
  async enqueueExecution(planId: string, opts: { delayMs?: number } = {}) {
    this.executions.push({ planId, delayMs: opts.delayMs ?? 0 });
  }
  async enqueueDecisionLog(planId: string) {
    this.logs.push(planId);
  }
  async close() {}
}

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

export class FakeChain implements ChainClient {
  calls: CallRequest[] = [];
  /** Return a revert reason to make eth_call fail for a request. */
  revert: (req: CallRequest) => string | null = () => null;
  /** Hashes whose receipt is withheld (timeout path) until released. */
  pending = new Set<string>();
  reverted = new Set<string>();
  /** Extra logs per tx hash (e.g. ERC-20 / ERC-721 transfers). */
  logs = new Map<string, ChainReceipt['logs']>();
  block = 100n;

  async call(req: CallRequest) {
    this.calls.push(req);
    const reason = this.revert(req);
    if (reason) throw new SimulationRevert(reason);
  }
  async estimateGas() {
    return 150_000n;
  }
  private receipt(hash: string): ChainReceipt {
    this.block += 1n;
    return {
      status: this.reverted.has(hash) ? 'reverted' : 'success',
      blockNumber: this.block,
      gasUsed: 120_000n,
      effectiveGasPrice: 1_000_000_000n,
      logs: this.logs.get(hash) ?? [],
    };
  }
  async waitForReceipt(hash: `0x${string}`) {
    return this.pending.has(hash) ? null : this.receipt(hash);
  }
  async getReceipt(hash: `0x${string}`) {
    return this.pending.has(hash) ? null : this.receipt(hash);
  }
}

// ---------------------------------------------------------------------------
// Wallet (Privy)
// ---------------------------------------------------------------------------

export class FakeWallets implements WalletProvider {
  readonly kind = 'privy' as const;
  sent: { walletId: string; tx: UnsignedTx; key: string | undefined; hash: `0x${string}` }[] = [];
  signed: TypedDataInput[] = [];
  /** Ordered log of wallet operations ("send:APPROVAL"…) for ordering assertions. */
  ops: string[] = [];
  /** Hook to attach receipt logs to a just-sent tx. */
  onSend: (hash: `0x${string}`, tx: UnsignedTx) => void = () => undefined;

  async createAgentWallet() {
    return { walletId: 'wallet_x', address: randomAddress() };
  }
  async attachPolicy() {
    return null;
  }
  async sendTransaction(walletId: string, tx: UnsignedTx, opts: { idempotencyKey?: string } = {}) {
    // Privy dedupes by idempotency key: same key → same hash, never a second broadcast.
    const existing = this.sent.find((s) => opts.idempotencyKey && s.key === opts.idempotencyKey);
    if (existing) return { hash: existing.hash };
    const hash =
      `0x${createHash('sha256').update(`${opts.idempotencyKey}:${this.sent.length}`).digest('hex')}` as `0x${string}`;
    this.sent.push({ walletId, tx, key: opts.idempotencyKey, hash });
    this.ops.push(`send:${tx.to.toLowerCase()}`);
    this.onSend(hash, tx);
    return { hash };
  }
  async signTypedData(_walletId: string, typedData: TypedDataInput) {
    this.signed.push(typedData);
    this.ops.push('sign');
    return { signature: `0x${'cd'.repeat(65)}` as `0x${string}` };
  }
  async getAddress() {
    return randomAddress();
  }
}

// ---------------------------------------------------------------------------
// Decision-log storage
// ---------------------------------------------------------------------------

export class FakeStorage implements DecisionLogStorage {
  blobs = new Map<string, Uint8Array>();
  failTimes = 0;
  uploads = 0;
  async upload(bytes: Uint8Array) {
    this.uploads += 1;
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      throw new Error('indexer unavailable');
    }
    const rootHash = `0x${createHash('sha256').update(bytes).digest('hex')}`;
    this.blobs.set(rootHash, bytes);
    return { rootHash, txHash: `0x${'ef'.repeat(32)}` };
  }
  async download(rootHash: string) {
    const b = this.blobs.get(rootHash);
    if (!b) throw new Error('not found');
    return b;
  }
}

// ---------------------------------------------------------------------------
// Scripted Uniswap MCP
// ---------------------------------------------------------------------------

export interface Market {
  /** USD per ETH on the execution chain quotes (mutate to move the price). */
  eth: Decimal;
  calls: { name: string; args: Record<string, unknown> }[];
  /** Per-tool overrides: return structuredContent, or `{ error: { code, message } }`. */
  handlers: Partial<Record<string, (args: Record<string, unknown>) => unknown>>;
  /** USDC → ETH swaps need a Permit2 signature (approval preStep first). */
  permitForErc20: boolean;
}

export function createMarket(): Market {
  return { eth: new Decimal(2500), calls: [], handlers: {}, permitForErc20: true };
}

const now = () => new Date().toISOString();
const amount = (value: Decimal, decimals: number) => {
  const raw = value.times(new Decimal(10).pow(decimals)).toDecimalPlaces(0, Decimal.ROUND_DOWN);
  return { raw: raw.toFixed(0), decimal: raw.div(new Decimal(10).pow(decimals)).toFixed() };
};
const tokenInfo = (t: string) => {
  if (t === 'ETH' || t.toLowerCase() === NATIVE_TOKEN_ADDRESS) return ETH_INFO;
  if (t === 'USDC' || t.toLowerCase() === USDC.toLowerCase()) return USDC_INFO;
  if (t.toLowerCase() === SCAM.toLowerCase())
    return { address: SCAM, symbol: 'SCAM', decimals: 18, isNative: false };
  return null;
};

function quoteAmounts(m: Market, args: Record<string, unknown>) {
  const tin = tokenInfo(String(args.tokenIn));
  const tout = tokenInfo(String(args.tokenOut));
  if (!tin || !tout || tin.symbol === 'SCAM' || tout.symbol === 'SCAM') return null;
  const price = (t: typeof tin) => (t.symbol === 'ETH' ? m.eth : new Decimal(1));
  const amt = new Decimal(String(args.amount));
  const exactIn = args.type === 'EXACT_INPUT';
  const inValue = exactIn ? amt : amt.times(price(tout)).div(price(tin));
  const outValue = exactIn ? amt.times(price(tin)).div(price(tout)) : amt;
  return {
    tin,
    tout,
    amountIn: amount(inValue, tin.decimals),
    amountOut: amount(outValue, tout.decimals),
  };
}

const err = (code: string, message: string) => ({ error: { code, message } });

function defaultHandler(m: Market, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'get_quote': {
      const q = quoteAmounts(m, args);
      if (!q) return err('NO_ROUTE', 'No route found');
      return {
        chainId: args.chainId,
        routing: 'CLASSIC',
        quoteId: 'q1',
        requestId: 'r1',
        type: args.type,
        tokenIn: q.tin,
        tokenOut: q.tout,
        amountIn: q.amountIn,
        amountOut: q.amountOut,
        minAmountOut: null,
        maxAmountIn: null,
        slippagePct: args.slippagePct ?? null,
        priceImpactPct: 0.05,
        gasFee: { wei: '100000000000000', usd: '0.05' },
        gasUseEstimate: '150000',
        route: { summary: 'ETH → USDC (v4 0.05%)', pools: [], hooks: [] },
        txFailureReasons: [],
        blockNumber: '1',
        quotedAt: now(),
        expiresAt: now(),
      };
    }
    case 'build_swap': {
      const q = quoteAmounts(m, args);
      if (!q) return err('NO_ROUTE', 'No route found for this token');
      const swapper = getAddress(String(args.swapper));
      const summary = {
        tokenIn: q.tin,
        tokenOut: q.tout,
        amountIn: q.amountIn,
        amountOut: q.amountOut,
        priceImpactPct: 0.05,
        gasFeeUsd: '0.05',
        route: 'ETH → USDC (v4 0.05%)',
        ...(args.recipient ? { recipient: getAddress(String(args.recipient)) } : {}),
      };
      const swapTx = {
        kind: 'SWAP',
        description: 'Swap via Uniswap Universal Router',
        tx: {
          to: ROUTER,
          from: swapper,
          data: '0x3593564c',
          value: q.tin.isNative ? q.amountIn.raw : '0',
          chainId: CHAIN_ID,
        },
      };
      if (!q.tin.isNative && m.permitForErc20) {
        if (args.resumeToken && args.signature)
          return { status: 'READY', steps: [swapTx], summary };
        return {
          status: 'NEEDS_SIGNATURE',
          preSteps: [
            {
              kind: 'APPROVAL',
              description: 'Approve USDC for Permit2 (Uniswap)',
              tx: {
                to: q.tin.address,
                from: swapper,
                data: '0x095ea7b3',
                value: '0',
                chainId: CHAIN_ID,
              },
            },
          ],
          signature: {
            kind: 'PERMIT2',
            typedData: {
              domain: { name: 'Permit2', chainId: CHAIN_ID, verifyingContract: PERMIT2 },
              types: { PermitSingle: [{ name: 'spender', type: 'address' }] },
              primaryType: 'PermitSingle',
              message: { spender: ROUTER },
            },
          },
          resumeToken: 'abcdefghijklmnop.qrstuvwxyz012345',
          expiresAt: now(),
          summary,
        };
      }
      return { status: 'READY', steps: [swapTx], summary };
    }
    case 'build_transfer': {
      const t = tokenInfo(String(args.token));
      if (!t) return err('UNKNOWN_TOKEN', 'unknown');
      const amt = amount(new Decimal(String(args.amount)), t.decimals);
      const from = getAddress(String(args.from));
      const to = getAddress(String(args.to));
      return {
        status: 'READY',
        steps: [
          {
            kind: 'TRANSFER',
            description: `Send ${args.amount} ${t.symbol} to ${to}`,
            tx: t.isNative
              ? { to, from, data: '0x', value: amt.raw, chainId: CHAIN_ID }
              : { to: t.address, from, data: '0xa9059cbb', value: '0', chainId: CHAIN_ID },
          },
        ],
        summary: { tokenIn: t, amountIn: amt, recipient: to },
      };
    }
    case 'check_token': {
      const t = tokenInfo(String(args.token));
      const known = t && t.symbol !== 'SCAM';
      const address =
        t?.address ?? getAddress(String(args.token).startsWith('0x') ? String(args.token) : SCAM);
      return {
        chainId: args.chainId,
        address,
        symbol: t?.symbol ?? null,
        name: null,
        decimals: t?.decimals ?? null,
        isNative: t?.isNative ?? false,
        onAllowlist: Boolean(known),
        onUniswapUnsupportedList: false,
        hasQuote: Boolean(known),
        liquidityDepthUsd: known ? '5000000' : null,
        liquidityProbe: null,
        isContract: true,
        riskFlags: known ? [] : ['NOT_ON_ALLOWLIST', 'NO_LIQUIDITY'],
        verdict: known ? 'OK' : 'CAUTION',
      };
    }
    case 'compare_pools': {
      const ranked = {
        rank: 1,
        poolId: POOL_ID,
        source: 'execution',
        usableOnExecutionChain: true,
        fee: 500,
        tickSpacing: 10,
        hookAddress: NATIVE_TOKEN_ADDRESS,
        hookBand: null,
        hookScore: null,
        referenceFeeAprPct: '12.5',
        adjustedAprPct: '12.5',
        referenceTvlUsd: '1000000',
        reasons: ['Deepest pool'],
      };
      return {
        chainId: args.chainId,
        tokenA: ETH_INFO,
        tokenB: USDC_INFO,
        execution: {
          chainId: CHAIN_ID,
          label: 'Sepolia',
          source: 'StateView',
          pools: [],
          error: null,
        },
        market: {
          chainId: 1,
          label: 'Mainnet',
          source: 'subgraph',
          pools: [],
          asOf: null,
          error: null,
          warnings: [],
        },
        ranked: [ranked],
        recommended: ranked,
        reasons: ['Deepest pool'],
      };
    }
    case 'build_lp_position': {
      const owner = getAddress(String(args.owner));
      const ind = args.independentToken as { token: string; amount: string };
      const a0 = new Decimal(ind.amount);
      return {
        status: 'READY',
        steps: [
          {
            kind: 'LP_CREATE',
            description: 'Open the v4 position',
            tx: {
              to: POSITION_MANAGER,
              from: owner,
              data: '0xdd46508f',
              value: amount(a0, 18).raw,
              chainId: CHAIN_ID,
            },
          },
        ],
        summary: {
          lp: {
            token0: ETH_INFO,
            token1: USDC_INFO,
            amount0: amount(a0, 18),
            amount1: amount(a0.times(m.eth), 6),
            tickLower: -200_000,
            tickUpper: -190_000,
          },
        },
      };
    }
    case 'build_lp_exit': {
      const owner = getAddress(String(args.owner));
      return {
        status: 'READY',
        steps: [
          {
            kind: 'LP_DECREASE',
            description: 'Withdraw liquidity',
            tx: {
              to: POSITION_MANAGER,
              from: owner,
              data: '0xdd46508f',
              value: '0',
              chainId: CHAIN_ID,
            },
          },
        ],
        summary: {
          lp: {
            token0: ETH_INFO,
            token1: USDC_INFO,
            amount0: amount(new Decimal('0.01'), 18),
            amount1: amount(new Decimal(25), 6),
            percent: args.percent as number,
          },
        },
      };
    }
    case 'get_portfolio':
      return {
        chainId: args.chainId,
        address: getAddress(String(args.address)),
        tokens: [
          {
            ...ETH_INFO,
            balanceRaw: '1000000000000000000',
            balance: '1',
            priceUsd: m.eth.toFixed(),
            valueUsd: m.eth.toFixed(),
          },
          { ...USDC_INFO, balanceRaw: '100000000', balance: '100', priceUsd: '1', valueUsd: '100' },
        ],
        totalUsd: m.eth.plus(100).toFixed(),
        unpriced: [],
        priceSource: 'test',
        blockNumber: '1',
        asOf: now(),
      };
    case 'get_lp_positions':
      return {
        chainId: args.chainId,
        owner: args.owner,
        positions: [],
        notFound: args.tokenIds,
        totalValueUsd: null,
        blockNumber: '1',
        asOf: now(),
      };
    case 'plan_trigger':
      return {
        spec: {
          kind: (args as { kind: string }).kind,
          condition: {
            type: 'price_below',
            symbol: 'ETH',
            targetPriceUsd: '2800',
            referencePriceUsd: null,
            changePct: null,
            every: null,
            atLocalTime: null,
            dayOfWeek: null,
          },
          actions: [],
        },
        humanSummary: 'When ETH ≤ $2,800, sell 100% of ETH for USDC.',
        warnings: [],
      };
    default:
      return err('INTERNAL', `not scripted: ${name}`);
  }
}

export function scriptedMcp(m: Market): UniswapMcpClient {
  const client: McpClientLike = {
    async callTool({ name, arguments: args = {} }) {
      m.calls.push({ name, args });
      const out = m.handlers[name]?.(args) ?? defaultHandler(m, name, args);
      if (out && typeof out === 'object' && 'error' in out) {
        const e = (out as { error: { code: string; message: string } }).error;
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: { ...e, retryable: false } }) }],
        };
      }
      return {
        content: [{ type: 'text', text: `${name} ok` }],
        structuredContent: out as Record<string, unknown>,
      };
    },
    async close() {},
  };
  return new UniswapMcpClient({
    url: 'http://fake.invalid/mcp',
    token: 'x'.repeat(24),
    log: silentLog,
    connect: async () => client,
  });
}

export const fixedPrices = (m: Market) => ({
  async usd(symbol: string) {
    const price = symbol.toUpperCase() === 'ETH' ? m.eth : new Decimal(1);
    return { priceUsd: price, fetchedAt: new Date(), stale: false };
  },
});

// ---------------------------------------------------------------------------
// 0G router (planner, explainer, Vela decisions)
// ---------------------------------------------------------------------------

export interface ZgScript {
  /** Next planner `propose` arguments (consumed in order; the last one repeats). */
  proposals: unknown[];
  guard: 'approve' | 'block' | 'error';
  decisions: number;
}

function zgJson(body: unknown, requestId: string): Response {
  return new Response(
    JSON.stringify({ ...(body as object), x_0g_trace: { request_id: requestId } }),
    {
      headers: { 'content-type': 'application/json', 'x-request-id': requestId },
    },
  );
}

export function zgRouter(script: ZgScript) {
  let n = 0;
  return async (input: unknown, init?: { body?: unknown }) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : String((input as { url?: string }).url);
    n += 1;
    const id = `zg-${n}`;
    if (url.endsWith('/decisions')) {
      script.decisions += 1;
      if (script.guard === 'error')
        return new Response(JSON.stringify({ error: { message: 'provider_error' } }), {
          status: 502,
          headers: { 'content-type': 'application/json', 'x-request-id': id },
        });
      const approve = script.guard === 'approve';
      return zgJson(
        {
          answers: {
            verdict: {
              choice: approve ? 'approve' : 'block',
              probabilities: { approve: approve ? 0.97 : 0.1, block: approve ? 0.03 : 0.9 },
            },
            risk: { score: approve ? 0.1 : 0.8 },
            concerns: { choice: approve ? 'none' : 'price_impact' },
          },
        },
        id,
      );
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { tools?: unknown[] };
    if (body.tools?.length) {
      const args = script.proposals.length > 1 ? script.proposals.shift() : script.proposals[0];
      return zgJson(
        {
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'p',
                    type: 'function',
                    function: { name: 'propose', arguments: JSON.stringify(args) },
                  },
                ],
              },
            },
          ],
        },
        id,
      );
    }
    return zgJson(
      {
        choices: [{ message: { role: 'assistant', content: 'This was blocked for your safety.' } }],
      },
      id,
    );
  };
}

export const ZG_ENV = {
  ZG_API_KEY: 'phase5-secret-123456789',
  ZG_MODEL_PLANNER: 'test-planner',
  ZG_MODEL_PLANNER_FALLBACK: 'test-fallback',
  ZG_MODEL_GUARD: 'test-guard',
  ZG_MODEL_EXPLAINER: 'test-explainer',
};

// ---------------------------------------------------------------------------
// Account setup
// ---------------------------------------------------------------------------

export async function giveWallet(
  prisma: PrismaClient,
  userId: string,
  profile: 'BALANCED' | 'CAREFUL' = 'BALANCED',
) {
  const address = randomAddress();
  const wallet = await prisma.agentWallet.create({
    data: { userId, privyWalletId: `wallet_${userId}`, address, chainId: CHAIN_ID },
  });
  const limits =
    profile === 'BALANCED'
      ? { perActionUsd: '25', perDayUsd: '100', maxSlippagePct: '0.5', minTradeScoreAuto: 70 }
      : { perActionUsd: '10', perDayUsd: '40', maxSlippagePct: '0.3', minTradeScoreAuto: 80 };
  await prisma.limits.upsert({
    where: { userId },
    create: { userId, ...limits, hookPolicy: 'SAFE_ONLY' },
    update: { ...limits, hookPolicy: 'SAFE_ONLY' },
  });
  await prisma.user.update({
    where: { id: userId },
    data: { riskProfile: profile, onboardingStep: 'DONE' },
  });
  return wallet;
}

/** ERC-721 mint log (PositionManager → owner) for LP_CREATE receipts. */
export function mintLog(owner: string, tokenId: bigint) {
  return {
    address: POSITION_MANAGER,
    topics: [
      TRANSFER_TOPIC,
      pad('0x0', { size: 32 }),
      pad(owner as `0x${string}`, { size: 32 }),
      pad(toHex(tokenId), { size: 32 }),
    ] as `0x${string}`[],
    data: '0x' as `0x${string}`,
  };
}
