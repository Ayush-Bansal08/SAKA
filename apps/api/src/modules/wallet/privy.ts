/**
 * Privy adapter — the ONLY file that talks to Privy (`@privy-io/node`, not the deprecated
 * `@privy-io/server-auth`). Method names and shapes were checked against the installed
 * package's TypeScript types (v0.36.0) and docs/vendor/privy-node-notes.md.
 *
 * Agent wallets are app-controlled server wallets (no owner): PRIVY_APP_ID + PRIVY_APP_SECRET
 * authenticate every call. PRIVY_AUTHORIZATION_PRIVATE_KEY is used only when it is set (apps
 * whose dashboard requires signed requests).
 *
 * Exposed operations (nothing else is used outside this file):
 *   createAgentWallet(userId) · attachPolicy(walletId) · sendTransaction(walletId, tx)
 *   signTypedData(walletId, typedData) · getAddress(walletId)
 * Every failure becomes AppError('WALLET_PROVIDER_ERROR'). Request bodies (transactions,
 * typed data) and signatures are never logged.
 */
import { createHash } from 'node:crypto';
import {
  APIConnectionError,
  APIError,
  PrivyAPIError,
  PrivyClient,
  type AuthorizationContext,
} from '@privy-io/node';
import type { ExecutionChainId } from '@warden/shared';
import { getAddress, isAddress, isHex, toHex } from 'viem';
import type { AllowlistEntry, Env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { allowedTransactionTargets, allowedTypedDataDomains } from './tokens.js';

// ---------------------------------------------------------------------------
// Types used by callers
// ---------------------------------------------------------------------------

export interface AgentWalletRef {
  walletId: string;
  address: `0x${string}`;
}

/** An unsigned transaction as produced by the MCP build tools (TxRequest). */
export interface UnsignedTx {
  to: string;
  data?: string;
  /** wei, decimal string */
  value: string;
  chainId: number;
  gasLimit?: string;
}

export interface SendOptions {
  /** Stable key so a retried call never broadcasts twice (Privy dedupes for 24 h). */
  idempotencyKey?: string;
}

export interface TypedDataInput {
  domain: Record<string, unknown>;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface WalletProvider {
  readonly kind: 'privy';
  createAgentWallet(userId: string): Promise<AgentWalletRef>;
  /** Returns the policy id, or null when the plan has no policy API (backend guard only). */
  attachPolicy(walletId: string): Promise<string | null>;
  sendTransaction(
    walletId: string,
    tx: UnsignedTx,
    opts?: SendOptions,
  ): Promise<{ hash: `0x${string}` }>;
  signTypedData(walletId: string, typedData: TypedDataInput): Promise<{ signature: `0x${string}` }>;
  getAddress(walletId: string): Promise<`0x${string}`>;
}

// ---------------------------------------------------------------------------
// The narrow seam over the SDK (tests replace it with a fake)
// ---------------------------------------------------------------------------

export interface PrivyWalletRecord {
  id: string;
  address: string;
  policyIds: string[];
}

export interface PolicyRule {
  name: string;
  method: 'eth_sendTransaction' | 'eth_signTypedData_v4';
  action: 'ALLOW';
  conditions: (
    | {
        field_source: 'ethereum_transaction';
        field: 'to' | 'value' | 'chain_id';
        operator: 'eq' | 'in';
        value: string | string[];
      }
    | {
        field_source: 'ethereum_typed_data_domain';
        field: 'verifying_contract' | 'chain_id';
        operator: 'eq' | 'in';
        value: string | string[];
      }
  )[];
}

export interface PrivyBackend {
  findWalletByExternalId(externalId: string): Promise<PrivyWalletRecord | null>;
  createWallet(input: {
    externalId: string;
    displayName: string;
    idempotencyKey: string;
  }): Promise<PrivyWalletRecord>;
  getWallet(walletId: string): Promise<PrivyWalletRecord>;
  getPolicyName(policyId: string): Promise<string | null>;
  createPolicy(input: {
    name: string;
    rules: PolicyRule[];
    idempotencyKey: string;
  }): Promise<{ id: string }>;
  setWalletPolicy(walletId: string, policyId: string): Promise<void>;
  sendTransaction(
    walletId: string,
    input: {
      caip2: string;
      transaction: {
        to: string;
        data?: `0x${string}`;
        value: `0x${string}`;
        chain_id: number;
        gas_limit?: `0x${string}`;
      };
      idempotencyKey?: string;
    },
  ): Promise<{ hash: string }>;
  signTypedData(
    walletId: string,
    typedData: {
      domain: Record<string, unknown>;
      types: Record<string, { name: string; type: string }[]>;
      primary_type: string;
      message: Record<string, unknown>;
    },
  ): Promise<{ signature: string }>;
}

/** The real backend: the only code that calls the Privy SDK. */
export function sdkBackend(client: PrivyClient, authorizationKey?: string): PrivyBackend {
  const auth: AuthorizationContext | undefined = authorizationKey
    ? { authorization_private_keys: [authorizationKey] }
    : undefined;
  const withAuth = auth ? { authorization_context: auth } : {};
  const record = (w: { id: string; address: string; policy_ids: string[] }): PrivyWalletRecord => ({
    id: w.id,
    address: w.address,
    policyIds: w.policy_ids,
  });

  return {
    async findWalletByExternalId(externalId) {
      const page = await client.wallets().list({ external_id: externalId, chain_type: 'ethereum' });
      const first = page.data[0];
      return first ? record(first) : null;
    },
    async createWallet({ externalId, displayName, idempotencyKey }) {
      const w = await client.wallets().create({
        chain_type: 'ethereum',
        external_id: externalId,
        display_name: displayName,
        idempotency_key: idempotencyKey,
      });
      return record(w);
    },
    async getWallet(walletId) {
      return record(await client.wallets().get(walletId));
    },
    async getPolicyName(policyId) {
      const p = await client.policies().get(policyId);
      return p.name ?? null;
    },
    async createPolicy({ name, rules, idempotencyKey }) {
      const p = await client.policies().create({
        name,
        version: '1.0',
        chain_type: 'ethereum',
        rules,
        idempotency_key: idempotencyKey,
      });
      return { id: p.id };
    },
    async setWalletPolicy(walletId, policyId) {
      await client.wallets().update(walletId, { policy_ids: [policyId], ...withAuth });
    },
    async sendTransaction(walletId, { caip2, transaction, idempotencyKey }) {
      const res = await client
        .wallets()
        .ethereum()
        .sendTransaction(walletId, {
          caip2,
          params: { transaction },
          ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
          ...withAuth,
        });
      return { hash: res.hash };
    },
    async signTypedData(walletId, typedData) {
      const res = await client
        .wallets()
        .ethereum()
        .signTypedData(walletId, { params: { typed_data: typedData }, ...withAuth });
      return { signature: res.signature };
    },
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Maps any Privy/SDK failure to a typed AppError without leaking request bodies. */
export function toWalletError(operation: string, err: unknown): AppError {
  if (err instanceof AppError) return err;
  const what = OPERATION_COPY[operation] ?? 'talk to the wallet provider';
  if (err instanceof APIConnectionError) {
    return new AppError(
      'WALLET_PROVIDER_ERROR',
      503,
      `Couldn't reach Privy to ${what}. Please try again.`,
      { provider: 'privy', operation, retryable: true },
      { cause: err },
    );
  }
  if (err instanceof APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    const retryable = status === undefined || status === 429 || status >= 500;
    const message =
      status === 401 || status === 403
        ? `Privy rejected our credentials while trying to ${what}. Check PRIVY_APP_ID / PRIVY_APP_SECRET.`
        : status === 429
          ? `Privy is rate-limiting us. Please try again in a moment.`
          : status !== undefined && status < 500
            ? `Privy refused to ${what}: ${providerMessage(err)}`
            : `Privy had a problem trying to ${what}. Please try again.`;
    return new AppError(
      'WALLET_PROVIDER_ERROR',
      retryable ? 503 : 502,
      message,
      { provider: 'privy', operation, status, retryable },
      { cause: err },
    );
  }
  if (err instanceof PrivyAPIError) {
    return new AppError(
      'WALLET_PROVIDER_ERROR',
      502,
      `Privy failed to ${what}: ${err.message.slice(0, 200)}`,
      { provider: 'privy', operation, retryable: false },
      { cause: err },
    );
  }
  return new AppError(
    'WALLET_PROVIDER_ERROR',
    502,
    `Unexpected wallet provider error while trying to ${what}.`,
    { provider: 'privy', operation, retryable: false },
    { cause: err },
  );
}

const OPERATION_COPY: Record<string, string> = {
  createAgentWallet: 'create your agent wallet',
  attachPolicy: 'attach the wallet policy',
  sendTransaction: 'send the transaction',
  signTypedData: 'sign the permit',
  getAddress: 'look up the wallet',
};

/** The provider's own error text (bounded). Privy error bodies never echo the request. */
function providerMessage(err: APIError): string {
  const body = err.error as { error?: unknown; message?: unknown } | undefined;
  const text =
    (typeof body?.error === 'string' && body.error) ||
    (typeof body?.message === 'string' && body.message) ||
    err.message;
  return String(text).slice(0, 200);
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface PrivyWalletProviderOptions {
  chainId: ExecutionChainId;
  allowlist: readonly AllowlistEntry[];
  backend: PrivyBackend;
  log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };
  /** Wait between re-reads after losing a concurrent create (tests shorten it). */
  raceDelayMs?: number;
}

export const POLICY_VERSION = 'v1';
const RACE_RETRIES = 8;
const RACE_DELAY_MS = 750;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Privy's answers when another request is creating the same wallet right now. */
export function isConcurrentCreate(err: unknown): boolean {
  if (!(err instanceof APIError)) return false;
  if (err.status === 409) return true;
  const body = err.error as { error?: unknown } | undefined;
  const text = `${typeof body?.error === 'string' ? body.error : ''} ${err.message}`;
  return err.status === 400 && /idempotency key.*in progress/i.test(text);
}

export class PrivyWalletProvider implements WalletProvider {
  readonly kind = 'privy' as const;

  constructor(private readonly opts: PrivyWalletProviderOptions) {}

  /** Idempotent per user: the Privy `external_id` is derived from our user id. */
  async createAgentWallet(userId: string): Promise<AgentWalletRef> {
    const externalId = externalIdFor(userId);
    try {
      const existing = await this.opts.backend.findWalletByExternalId(externalId);
      const wallet =
        existing ??
        (await this.opts.backend
          .createWallet({
            externalId,
            displayName: `Warden agent ${userId}`.slice(0, 64),
            idempotencyKey: `create-${externalId}`,
          })
          .catch(async (err: unknown) => {
            // Lost a race with a concurrent create for the same user (another tab, a retry):
            // Privy answers 409 (external_id taken) or 400 "idempotency key … still in
            // progress". Wait for the winner and read it back.
            if (!isConcurrentCreate(err)) throw err;
            for (let attempt = 0; attempt < RACE_RETRIES; attempt += 1) {
              await sleep(this.opts.raceDelayMs ?? RACE_DELAY_MS);
              const winner = await this.opts.backend.findWalletByExternalId(externalId);
              if (winner) return winner;
            }
            throw err;
          }));
      return { walletId: wallet.id, address: checksum(wallet.address) };
    } catch (err) {
      throw toWalletError('createAgentWallet', err);
    }
  }

  /**
   * Creates (once per rule set, found again by name) and attaches a policy that ALLOWs only:
   *   - eth_sendTransaction to Universal Router, Permit2, v4 PositionManager and allowlisted
   *     tokens, on EXECUTION_CHAIN_ID;
   *   - a zero-value self-transaction (liveness probe / stuck-nonce cancellation);
   *   - eth_signTypedData_v4 for the Permit2 / PositionManager domains on EXECUTION_CHAIN_ID.
   * Anything else is denied by Privy. If the plan has no policy API, logs a warning and
   * returns null — our backend policy engine stays the primary guard.
   */
  async attachPolicy(walletId: string): Promise<string | null> {
    try {
      const wallet = await this.opts.backend.getWallet(walletId);
      const rules = buildPolicyRules(
        this.opts.chainId,
        checksum(wallet.address),
        this.opts.allowlist,
      );
      const name = policyName(this.opts.chainId, rules);

      for (const id of wallet.policyIds) {
        const existingName = await this.opts.backend.getPolicyName(id).catch(() => null);
        if (existingName === name) return id;
      }
      const policy = await this.opts.backend.createPolicy({
        name,
        rules,
        idempotencyKey: `policy-${name}`,
      });
      await this.opts.backend.setWalletPolicy(walletId, policy.id);
      this.opts.log.info({ walletId, policyId: policy.id, name }, 'privy policy attached');
      return policy.id;
    } catch (err) {
      const mapped = toWalletError('attachPolicy', err);
      this.opts.log.warn(
        { walletId, code: mapped.code, details: mapped.details },
        'Privy policy unavailable — continuing with the backend policy engine only (policyId=null)',
      );
      return null;
    }
  }

  async sendTransaction(
    walletId: string,
    tx: UnsignedTx,
    opts: SendOptions = {},
  ): Promise<{ hash: `0x${string}` }> {
    if (tx.chainId !== this.opts.chainId) {
      throw new AppError(
        'WALLET_PROVIDER_ERROR',
        400,
        `Refusing to send on chain ${tx.chainId}: the agent only executes on chain ${this.opts.chainId}.`,
        { provider: 'privy', operation: 'sendTransaction', retryable: false },
      );
    }
    if (!isAddress(tx.to, { strict: false }))
      throw AppError.badRequest('Invalid transaction target.');
    if (tx.data !== undefined && !isHex(tx.data)) throw AppError.badRequest('Invalid calldata.');
    try {
      const { hash } = await this.opts.backend.sendTransaction(walletId, {
        caip2: `eip155:${tx.chainId}`,
        transaction: {
          to: getAddress(tx.to),
          ...(tx.data && tx.data !== '0x' ? { data: tx.data as `0x${string}` } : {}),
          value: toHex(BigInt(tx.value)),
          chain_id: tx.chainId,
          ...(tx.gasLimit ? { gas_limit: toHex(BigInt(tx.gasLimit)) } : {}),
        },
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      });
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        throw new PrivyAPIError(`Privy returned a malformed transaction hash`);
      }
      return { hash: hash as `0x${string}` };
    } catch (err) {
      throw toWalletError('sendTransaction', err);
    }
  }

  async signTypedData(
    walletId: string,
    typedData: TypedDataInput,
  ): Promise<{ signature: `0x${string}` }> {
    try {
      const { signature } = await this.opts.backend.signTypedData(
        walletId,
        toPrivyTypedData(typedData),
      );
      if (!/^0x([0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(signature)) {
        throw new PrivyAPIError('Privy returned a malformed signature');
      }
      return { signature: signature as `0x${string}` };
    } catch (err) {
      throw toWalletError('signTypedData', err);
    }
  }

  async getAddress(walletId: string): Promise<`0x${string}`> {
    try {
      return checksum((await this.opts.backend.getWallet(walletId)).address);
    } catch (err) {
      throw toWalletError('getAddress', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function externalIdFor(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '');
  return `warden_${safe}`.slice(0, 64);
}

function checksum(address: string): `0x${string}` {
  if (!isAddress(address, { strict: false })) {
    throw new PrivyAPIError('Privy returned an invalid wallet address');
  }
  return getAddress(address);
}

/** Both checksum and lower-case forms, so matching never depends on address casing. */
function anyCase(addresses: readonly string[]): string[] {
  return [...new Set(addresses.flatMap((a) => [getAddress(a), a.toLowerCase()]))];
}

export function buildPolicyRules(
  chainId: ExecutionChainId,
  walletAddress: `0x${string}`,
  allowlist: readonly AllowlistEntry[],
): PolicyRule[] {
  const chain = {
    field_source: 'ethereum_transaction',
    field: 'chain_id',
    operator: 'eq',
    value: String(chainId),
  } as const;
  return [
    {
      name: 'Uniswap contracts and allowlisted tokens',
      method: 'eth_sendTransaction',
      action: 'ALLOW',
      conditions: [
        {
          field_source: 'ethereum_transaction',
          field: 'to',
          operator: 'in',
          value: anyCase(allowedTransactionTargets(chainId, allowlist)),
        },
        chain,
      ],
    },
    {
      name: 'Zero-value self transaction',
      method: 'eth_sendTransaction',
      action: 'ALLOW',
      conditions: [
        {
          field_source: 'ethereum_transaction',
          field: 'to',
          operator: 'in',
          value: anyCase([walletAddress]),
        },
        { field_source: 'ethereum_transaction', field: 'value', operator: 'eq', value: '0' },
        chain,
      ],
    },
    {
      name: 'Permit2 and PositionManager permits',
      method: 'eth_signTypedData_v4',
      action: 'ALLOW',
      conditions: [
        {
          field_source: 'ethereum_typed_data_domain',
          field: 'verifying_contract',
          operator: 'in',
          value: anyCase(allowedTypedDataDomains(chainId)),
        },
        {
          field_source: 'ethereum_typed_data_domain',
          field: 'chain_id',
          operator: 'eq',
          value: String(chainId),
        },
      ],
    },
  ];
}

/** Deterministic name: same chain + rules → same name → the existing policy is reused. */
export function policyName(chainId: number, rules: readonly PolicyRule[]): string {
  const digest = createHash('sha256').update(JSON.stringify(rules)).digest('hex').slice(0, 16);
  return `warden-agent-${POLICY_VERSION}-${chainId}-${digest}`;
}

/** Field order of the EIP712Domain struct (EIP-712). */
const DOMAIN_FIELDS: readonly { name: string; type: string }[] = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
  { name: 'salt', type: 'bytes32' },
];

/**
 * viem-style typed data → Privy's `typed_data`. Adds an explicit EIP712Domain type when it is
 * missing (uniswap-lp-api.md: "Some signing libraries require an explicit EIP712Domain type"),
 * and turns bigints into decimal strings so the payload is plain JSON.
 */
export function toPrivyTypedData(input: TypedDataInput) {
  const domain = jsonSafe(input.domain) as Record<string, unknown>;
  const types: Record<string, { name: string; type: string }[]> = Object.fromEntries(
    Object.entries(input.types).map(([k, v]) => [
      k,
      v.map((f) => ({ name: f.name, type: f.type })),
    ]),
  );
  if (!types.EIP712Domain) {
    types.EIP712Domain = DOMAIN_FIELDS.filter((f) => domain[f.name] !== undefined).map((f) => ({
      ...f,
    }));
  }
  return {
    domain,
    types,
    primary_type: input.primaryType,
    message: jsonSafe(input.message) as Record<string, unknown>,
  };
}

function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWalletProvider(
  env: Pick<
    Env,
    | 'PRIVY_APP_ID'
    | 'PRIVY_APP_SECRET'
    | 'PRIVY_AUTHORIZATION_PRIVATE_KEY'
    | 'EXECUTION_CHAIN_ID'
    | 'TOKEN_ALLOWLIST_JSON'
  >,
  log: PrivyWalletProviderOptions['log'],
): WalletProvider | null {
  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) return null;
  const client = new PrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET });
  return new PrivyWalletProvider({
    chainId: env.EXECUTION_CHAIN_ID,
    allowlist: env.TOKEN_ALLOWLIST_JSON,
    backend: sdkBackend(client, env.PRIVY_AUTHORIZATION_PRIVATE_KEY),
    log,
  });
}

/** Thrown by callers when no Privy credentials are configured. */
export function walletProviderNotConfigured(): AppError {
  return new AppError(
    'WALLET_PROVIDER_ERROR',
    503,
    'Agent wallets are not configured on this server (PRIVY_APP_ID / PRIVY_APP_SECRET).',
    { provider: 'privy', retryable: false },
  );
}
