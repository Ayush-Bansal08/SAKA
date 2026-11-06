import { APIConnectionError, APIError, PrivyAPIError } from '@privy-io/node';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import {
  buildPolicyRules,
  createWalletProvider,
  externalIdFor,
  policyName,
  PrivyWalletProvider,
  toPrivyTypedData,
  toWalletError,
} from '../src/modules/wallet/privy.js';
import { FakePrivyBackend, randomAddress } from './fakes.js';

function provider(backend = new FakePrivyBackend()) {
  const warnings: object[] = [];
  const p = new PrivyWalletProvider({
    chainId: 11155111,
    allowlist: [],
    backend,
    log: { info: () => undefined, warn: (obj) => warnings.push(obj) },
    raceDelayMs: 1,
  });
  return { p, backend, warnings };
}

const apiError = (status: number, body: object = { error: 'nope' }) =>
  APIError.generate(status, body, undefined, new Headers());

describe('Privy adapter: createAgentWallet', () => {
  it('creates one wallet per user and finds it again (idempotent)', async () => {
    const { p, backend } = provider();
    const first = await p.createAgentWallet('user_1');
    const again = await p.createAgentWallet('user_1');
    expect(again).toEqual(first);
    expect(backend.wallets.size).toBe(1);
    expect(backend.calls.filter((c) => c === 'createWallet')).toHaveLength(1);
    // Address comes back checksummed even though Privy returned lower case.
    expect(first.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(first.address).not.toBe(first.address.toLowerCase());
  });

  it('gives different users different wallets', async () => {
    const { p } = provider();
    const a = await p.createAgentWallet('user_a');
    const b = await p.createAgentWallet('user_b');
    expect(a.walletId).not.toBe(b.walletId);
  });

  it('reads the winner when a concurrent create returns 409', async () => {
    const backend = new FakePrivyBackend();
    const { p } = provider(backend);
    // Another process created the wallet between our lookup and our create.
    const winner = {
      id: 'wallet_winner',
      address: randomAddress(),
      policyIds: [],
      externalId: externalIdFor('user_c'),
    };
    backend.findWalletByExternalId = async (externalId) => {
      backend.calls.push('findWalletByExternalId');
      return backend.calls.filter((c) => c === 'findWalletByExternalId').length > 1 &&
        externalId === winner.externalId
        ? winner
        : null;
    };
    backend.failNext.createWallet = apiError(409, { error: 'external_id already exists' });
    const ref = await p.createAgentWallet('user_c');
    expect(ref.walletId).toBe('wallet_winner');
  });

  it('waits for the winner when Privy says the same create is still in progress', async () => {
    const backend = new FakePrivyBackend();
    const { p } = provider(backend);
    const winner = {
      id: 'wallet_inflight',
      address: randomAddress(),
      policyIds: [],
      externalId: externalIdFor('user_e'),
    };
    let lookups = 0;
    backend.findWalletByExternalId = async () => {
      lookups += 1;
      return lookups >= 3 ? winner : null; // appears once the other request finishes
    };
    backend.failNext.createWallet = apiError(400, {
      error: 'Previous request with matching idempotency key is still in progress.',
      code: 'invalid_data',
    });
    await expect(p.createAgentWallet('user_e')).resolves.toMatchObject({
      walletId: 'wallet_inflight',
    });
  });

  it('does not retry an unrelated 400', async () => {
    const { p, backend } = provider();
    backend.failNext.createWallet = apiError(400, { error: 'chain_type invalid' });
    await expect(p.createAgentWallet('user_f')).rejects.toMatchObject({ httpStatus: 502 });
    expect(backend.calls.filter((c) => c === 'findWalletByExternalId')).toHaveLength(1);
  });

  it('maps provider failures to WALLET_PROVIDER_ERROR', async () => {
    const { p, backend } = provider();
    backend.failNext.findWalletByExternalId = apiError(401);
    await expect(p.createAgentWallet('user_d')).rejects.toMatchObject({
      code: 'WALLET_PROVIDER_ERROR',
      httpStatus: 502,
    });
  });

  it('derives a URL-safe external id within Privy limits', () => {
    expect(externalIdFor('cm123abc')).toBe('warden_cm123abc');
    expect(externalIdFor('a/b?c')).toBe('warden_abc');
    expect(externalIdFor('x'.repeat(100))).toHaveLength(64);
  });
});

describe('Privy adapter: sendTransaction', () => {
  it('sends with caip2, hex quantities and the idempotency key', async () => {
    const { p, backend } = provider();
    const { walletId } = await p.createAgentWallet('user_tx');
    const to = randomAddress();
    const res = await p.sendTransaction(
      walletId,
      {
        to: to.toLowerCase(),
        data: '0x1234',
        value: '1000000000000000',
        chainId: 11155111,
        gasLimit: '21000',
      },
      { idempotencyKey: 'exec_1' },
    );
    expect(res.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(backend.sent[0]?.input).toEqual({
      caip2: 'eip155:11155111',
      transaction: {
        to,
        data: '0x1234',
        value: '0x38d7ea4c68000',
        chain_id: 11155111,
        gas_limit: '0x5208',
      },
      idempotencyKey: 'exec_1',
    });
  });

  it('omits empty calldata for a plain transfer', async () => {
    const { p, backend } = provider();
    const { walletId, address } = await p.createAgentWallet('user_tx2');
    await p.sendTransaction(walletId, { to: address, data: '0x', value: '0', chainId: 11155111 });
    expect(backend.sent[0]?.input.transaction).toEqual({
      to: address,
      value: '0x0',
      chain_id: 11155111,
    });
  });

  it('refuses any chain other than the execution chain', async () => {
    const { p, backend } = provider();
    await expect(
      p.sendTransaction('w', { to: randomAddress(), value: '0', chainId: 1 }),
    ).rejects.toMatchObject({ code: 'WALLET_PROVIDER_ERROR', httpStatus: 400 });
    expect(backend.sent).toHaveLength(0);
  });

  it.each([
    ['connection failure', new APIConnectionError({ message: 'socket hang up' }), 503, true],
    ['rate limit', apiError(429), 503, true],
    ['server error', apiError(500), 503, true],
    [
      'policy denial (4xx)',
      apiError(400, { error: 'Policy violation: to not allowed' }),
      502,
      false,
    ],
    ['bad credentials', apiError(401), 502, false],
    ['other SDK error', new PrivyAPIError('weird'), 502, false],
  ])('maps %s to a typed AppError', async (_label, err, status, retryable) => {
    const { p, backend } = provider();
    const { walletId } = await p.createAgentWallet('user_err');
    backend.failNext.sendTransaction = err;
    const caught = await p
      .sendTransaction(walletId, { to: randomAddress(), value: '0', chainId: 11155111 })
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      code: 'WALLET_PROVIDER_ERROR',
      httpStatus: status,
      details: { provider: 'privy', operation: 'sendTransaction', retryable },
    });
  });

  it('surfaces the provider reason for a policy denial, never the request body', () => {
    const err = toWalletError('sendTransaction', apiError(400, { error: 'Policy violation' }));
    expect(err.userMessage).toContain('Policy violation');
    expect(JSON.stringify(err.details)).not.toMatch(/0x[0-9a-f]{40}/i);
  });
});

describe('Privy adapter: signTypedData', () => {
  const permit = {
    domain: {
      name: 'Permit2',
      chainId: 11155111,
      verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    },
    types: {
      PermitSingle: [
        { name: 'details', type: 'PermitDetails' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
      ],
      PermitDetails: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ],
    },
    primaryType: 'PermitSingle',
    message: {
      spender: '0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3',
      sigDeadline: 123n,
      details: { amount: 10n },
    },
  };

  it('adds an explicit EIP712Domain type and JSON-safe values', () => {
    const out = toPrivyTypedData(permit);
    expect(out.primary_type).toBe('PermitSingle');
    expect(out.types.EIP712Domain).toEqual([
      { name: 'name', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ]);
    expect(out.message).toEqual({
      spender: '0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3',
      sigDeadline: '123',
      details: { amount: '10' },
    });
  });

  it('keeps an EIP712Domain the caller already provided', () => {
    const custom = [{ name: 'name', type: 'string' }];
    const out = toPrivyTypedData({ ...permit, types: { ...permit.types, EIP712Domain: custom } });
    expect(out.types.EIP712Domain).toEqual(custom);
  });

  it('returns the signature and rejects malformed ones', async () => {
    const { p, backend } = provider();
    const { walletId } = await p.createAgentWallet('user_sig');
    await expect(p.signTypedData(walletId, permit)).resolves.toEqual({
      signature: `0x${'cd'.repeat(65)}`,
    });
    backend.signTypedData = async () => ({ signature: 'not-hex' });
    await expect(p.signTypedData(walletId, permit)).rejects.toMatchObject({
      code: 'WALLET_PROVIDER_ERROR',
    });
  });
});

describe('Privy adapter: attachPolicy', () => {
  it('allows only Uniswap contracts, allowlisted tokens and permits on the execution chain', () => {
    const wallet = randomAddress();
    const rules = buildPolicyRules(11155111, wallet, [
      {
        chainId: 11155111,
        address: '0x779877A7B0D9E8603169DdbD7836e478b4624789',
        symbol: 'LINK',
        decimals: 18,
      },
      {
        chainId: 1,
        address: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
        symbol: 'LINK',
        decimals: 18,
      },
    ]);
    const targets = rules[0]!.conditions.find((c) => c.field === 'to')!.value as string[];
    for (const a of [
      '0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3', // Universal Router 2.1.2
      '0x000000000022D473030F116dDEE9F6B43aC78BA3', // Permit2
      '0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4', // v4 PositionManager
      '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', // USDC
      '0x779877A7B0D9E8603169DdbD7836e478b4624789', // extra allowlisted token on this chain
    ]) {
      expect(targets).toContain(a);
      expect(targets).toContain(a.toLowerCase());
    }
    // A token allowlisted on another chain is not a target here.
    expect(targets).not.toContain('0x514910771AF9Ca656af840dff83E8264EcF986CA');
    for (const r of rules) {
      expect(r.action).toBe('ALLOW');
      expect(r.conditions.some((c) => c.field === 'chain_id' && c.value === '11155111')).toBe(true);
    }
    expect(rules[1]!.conditions).toContainEqual({
      field_source: 'ethereum_transaction',
      field: 'value',
      operator: 'eq',
      value: '0',
    });
    expect(rules[2]!.method).toBe('eth_signTypedData_v4');
    expect(rules[2]!.conditions[0]!.value).toContain('0x000000000022D473030F116dDEE9F6B43aC78BA3');
  });

  it('creates and attaches the policy once, then reuses it by name', async () => {
    const { p, backend } = provider();
    const { walletId } = await p.createAgentWallet('user_pol');
    const id = await p.attachPolicy(walletId);
    expect(id).toMatch(/^policy_/);
    expect(backend.wallets.get(walletId)?.policyIds).toEqual([id]);
    const again = await p.attachPolicy(walletId);
    expect(again).toBe(id);
    expect(backend.policies.size).toBe(1);
    expect(backend.policies.get(id!)?.name).toMatch(/^warden-agent-v1-11155111-[0-9a-f]{16}$/);
  });

  it('logs a warning and returns null when the plan has no policy API', async () => {
    const { p, backend, warnings } = provider();
    const { walletId } = await p.createAgentWallet('user_nopol');
    backend.failNext.createPolicy = apiError(403, {
      error: 'Policies are not enabled for this app',
    });
    await expect(p.attachPolicy(walletId)).resolves.toBeNull();
    expect(warnings).toHaveLength(1);
    expect(backend.wallets.get(walletId)?.policyIds).toEqual([]);
  });

  it('names policies deterministically by rule content', () => {
    const w = randomAddress();
    expect(policyName(11155111, buildPolicyRules(11155111, w, []))).toBe(
      policyName(11155111, buildPolicyRules(11155111, w, [])),
    );
    expect(policyName(11155111, buildPolicyRules(11155111, w, []))).not.toBe(
      policyName(11155111, buildPolicyRules(11155111, randomAddress(), [])),
    );
  });
});

describe('createWalletProvider', () => {
  it('is null without Privy credentials and works without an authorization key', () => {
    const base = { EXECUTION_CHAIN_ID: 11155111 as const, TOKEN_ALLOWLIST_JSON: [] };
    const log = { info: () => undefined, warn: () => undefined };
    expect(
      createWalletProvider(
        {
          ...base,
          PRIVY_APP_ID: undefined,
          PRIVY_APP_SECRET: undefined,
          PRIVY_AUTHORIZATION_PRIVATE_KEY: undefined,
        },
        log,
      ),
    ).toBeNull();
    const p = createWalletProvider(
      {
        ...base,
        PRIVY_APP_ID: 'app',
        PRIVY_APP_SECRET: 'secret',
        PRIVY_AUTHORIZATION_PRIVATE_KEY: undefined,
      },
      log,
    );
    expect(p?.kind).toBe('privy');
  });
});
