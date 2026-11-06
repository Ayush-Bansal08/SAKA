/** Test doubles for Privy and the Uniswap MCP server (no network). */
import { randomBytes } from 'node:crypto';
import { getAddress } from 'viem';
import { UniswapMcpClient, type McpClientLike } from '../src/modules/mcp/client.js';
import type {
  AgentWalletRef,
  PolicyRule,
  PrivyBackend,
  PrivyWalletRecord,
  TypedDataInput,
  UnsignedTx,
  WalletProvider,
} from '../src/modules/wallet/privy.js';

export const silentLog = {
  info: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
};

export function randomAddress(): `0x${string}` {
  return getAddress(`0x${randomBytes(20).toString('hex')}`);
}

/** In-memory Privy: wallets by external_id, policies by id. */
export class FakePrivyBackend implements PrivyBackend {
  wallets = new Map<string, PrivyWalletRecord & { externalId: string }>();
  policies = new Map<string, { name: string; rules: PolicyRule[] }>();
  calls: string[] = [];
  sent: { walletId: string; input: Parameters<PrivyBackend['sendTransaction']>[1] }[] = [];
  signed: Parameters<PrivyBackend['signTypedData']>[1][] = [];
  /** Throw this from the named operation once. */
  failNext: Partial<Record<keyof PrivyBackend, unknown>> = {};

  private maybeFail(op: keyof PrivyBackend): void {
    this.calls.push(op);
    const err = this.failNext[op];
    if (err !== undefined) {
      delete this.failNext[op];
      throw err;
    }
  }

  async findWalletByExternalId(externalId: string) {
    this.maybeFail('findWalletByExternalId');
    return [...this.wallets.values()].find((w) => w.externalId === externalId) ?? null;
  }
  async createWallet(input: { externalId: string; displayName: string; idempotencyKey: string }) {
    this.maybeFail('createWallet');
    const id = `wallet_${randomBytes(6).toString('hex')}`;
    const record = {
      id,
      address: randomAddress().toLowerCase(),
      policyIds: [],
      externalId: input.externalId,
    };
    this.wallets.set(id, record);
    return record;
  }
  async getWallet(walletId: string) {
    this.maybeFail('getWallet');
    const w = this.wallets.get(walletId);
    if (!w) throw new Error('not found');
    return w;
  }
  async getPolicyName(policyId: string) {
    this.maybeFail('getPolicyName');
    return this.policies.get(policyId)?.name ?? null;
  }
  async createPolicy(input: { name: string; rules: PolicyRule[]; idempotencyKey: string }) {
    this.maybeFail('createPolicy');
    const id = `policy_${randomBytes(6).toString('hex')}`;
    this.policies.set(id, { name: input.name, rules: input.rules });
    return { id };
  }
  async setWalletPolicy(walletId: string, policyId: string) {
    this.maybeFail('setWalletPolicy');
    const w = this.wallets.get(walletId);
    if (w) w.policyIds = [policyId];
  }
  async sendTransaction(walletId: string, input: Parameters<PrivyBackend['sendTransaction']>[1]) {
    this.maybeFail('sendTransaction');
    this.sent.push({ walletId, input });
    return { hash: `0x${'ab'.repeat(32)}` };
  }
  async signTypedData(_walletId: string, typedData: Parameters<PrivyBackend['signTypedData']>[1]) {
    this.maybeFail('signTypedData');
    this.signed.push(typedData);
    return { signature: `0x${'cd'.repeat(65)}` };
  }
}

/** A WalletProvider that never calls Privy; counts creations per user. */
export class FakeWalletProvider implements WalletProvider {
  readonly kind = 'privy' as const;
  created = new Map<string, AgentWalletRef>();
  createCalls = 0;
  policyId: string | null = 'policy_test';
  delayMs = 0;

  async createAgentWallet(userId: string): Promise<AgentWalletRef> {
    this.createCalls += 1;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const existing = this.created.get(userId);
    if (existing) return existing;
    const ref = { walletId: `wallet_${userId}`, address: randomAddress() };
    this.created.set(userId, ref);
    return ref;
  }
  async attachPolicy(): Promise<string | null> {
    return this.policyId;
  }
  async sendTransaction(_walletId: string, _tx: UnsignedTx) {
    return { hash: `0x${'ab'.repeat(32)}` as `0x${string}` };
  }
  async signTypedData(_walletId: string, _typedData: TypedDataInput) {
    return { signature: `0x${'cd'.repeat(65)}` as `0x${string}` };
  }
  async getAddress(walletId: string) {
    const found = [...this.created.values()].find((r) => r.walletId === walletId);
    if (!found) throw new Error('unknown wallet');
    return found.address;
  }
}

// ---------------------------------------------------------------------------
// MCP stub: real UniswapMcpClient (schema validation included) over a scripted transport
// ---------------------------------------------------------------------------

export interface FakeMarket {
  /** address(lower) → token balances returned by get_portfolio */
  balances: Map<
    string,
    { symbol: string; address: string; decimals: number; isNative: boolean; balanceRaw: string }[]
  >;
  /** reference symbol → USD price used by get_quote */
  prices: Record<string, string>;
  /** symbol → 7-day high used by get_price_history (missing → tool error) */
  highs: Record<string, string>;
  calls: { name: string; args: Record<string, unknown> }[];
  failPortfolio?: boolean;
}

export function sepoliaTokens(eth: string, usdc = '0') {
  return [
    {
      symbol: 'ETH',
      address: '0x0000000000000000000000000000000000000000',
      decimals: 18,
      isNative: true,
      balanceRaw: eth,
    },
    {
      symbol: 'USDC',
      address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      decimals: 6,
      isNative: false,
      balanceRaw: usdc,
    },
  ];
}

function decimal(raw: string, decimals: number): string {
  const s = raw.padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export function createFakeMarket(): FakeMarket {
  return { balances: new Map(), prices: { ETH: '2500' }, highs: { ETH: '2600' }, calls: [] };
}

function toolError(code: string, message: string) {
  return {
    isError: true,
    content: [
      { type: 'text', text: JSON.stringify({ error: { code, message, retryable: true } }) },
    ],
  };
}

export function fakeMcpClient(market: FakeMarket): UniswapMcpClient {
  const now = () => new Date().toISOString();
  const client: McpClientLike = {
    async callTool({ name, arguments: args = {} }) {
      market.calls.push({ name, args });
      if (name === 'get_portfolio') {
        if (market.failPortfolio) return toolError('RPC_UNAVAILABLE', 'rpc down');
        const address = String(args.address);
        const tokens = (market.balances.get(address.toLowerCase()) ?? sepoliaTokens('0')).map(
          (t) => ({
            ...t,
            address: getAddress(t.address),
            balance: decimal(t.balanceRaw, t.decimals),
            priceUsd: t.symbol === 'USDC' ? '1' : (market.prices[t.symbol] ?? null),
            valueUsd: null,
          }),
        );
        return {
          content: [{ type: 'text', text: 'portfolio' }],
          structuredContent: {
            chainId: args.chainId,
            address: getAddress(address),
            tokens,
            totalUsd: '0',
            unpriced: [],
            priceSource: 'test',
            blockNumber: '1',
            asOf: now(),
          },
        };
      }
      if (name === 'get_quote') {
        const symbol = String(args.tokenIn);
        const price = market.prices[symbol];
        if (!price) return toolError('NO_ROUTE', 'no route');
        const token = {
          address: '0x0000000000000000000000000000000000000000',
          symbol,
          decimals: 18,
          isNative: true,
        };
        const usdc = {
          address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          symbol: 'USDC',
          decimals: 6,
          isNative: false,
        };
        const raw = BigInt(Math.round(Number(price) * 1e6)).toString();
        return {
          content: [{ type: 'text', text: 'quote' }],
          structuredContent: {
            chainId: 1,
            routing: 'CLASSIC',
            quoteId: 'q',
            requestId: 'r',
            type: 'EXACT_INPUT',
            tokenIn: token,
            tokenOut: usdc,
            amountIn: { raw: '1000000000000000000', decimal: '1' },
            amountOut: { raw, decimal: price },
            minAmountOut: null,
            maxAmountIn: null,
            slippagePct: null,
            priceImpactPct: 0.01,
            gasFee: { wei: null, usd: null },
            gasUseEstimate: null,
            route: { summary: null, pools: [], hooks: [] },
            txFailureReasons: [],
            blockNumber: null,
            quotedAt: now(),
            expiresAt: now(),
          },
        };
      }
      if (name === 'get_price_history') {
        const symbol = String(args.symbol);
        const high = market.highs[symbol];
        if (!high) return toolError('MARKET_DATA_UNAVAILABLE', 'down');
        return {
          content: [{ type: 'text', text: 'history' }],
          structuredContent: {
            symbol,
            window: '7d',
            interval: 'day',
            source: { kind: 'pool', id: 'p', description: 'd', provider: 'test' },
            series: [],
            open: high,
            close: high,
            high,
            low: high,
            changePct: '0',
            asOf: null,
            lagSeconds: null,
            stale: false,
            hasIndexingErrors: null,
            warnings: [],
          },
        };
      }
      return toolError('NOT_IMPLEMENTED', name);
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
