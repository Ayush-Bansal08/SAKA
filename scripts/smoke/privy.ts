/**
 * PHASE 03 smoke for the Privy agent wallet (LIVE: real Privy app, real testnet broadcast).
 * Proves that server-side signing works end to end, through the same adapter the API uses
 * (apps/api/src/modules/wallet/privy.ts — this script makes no Privy calls of its own):
 *
 *   1. resolve the agent wallet: a user's wallet from the database (--user), or a dedicated,
 *      idempotent smoke wallet (Privy external_id "warden_smoke-test")
 *   2. attach the Warden Privy policy (or report that the plan has no policy API)
 *   3. check the wallet has gas on the execution chain
 *   4. send a 0 ETH self-transfer and print the transaction hash
 *   5. wait for the receipt
 *
 *   pnpm smoke:privy                    # dedicated smoke wallet
 *   pnpm smoke:privy --user alice       # the agent wallet of dev user "alice" (needs the DB)
 *   pnpm smoke:privy --no-wait          # print the hash without waiting for the receipt
 *
 * Needs PRIVY_APP_ID, PRIVY_APP_SECRET, EXECUTION_RPC_URL (and DATABASE_URL for --user) in the
 * root .env. Uses PRIVY_AUTHORIZATION_PRIVATE_KEY only if it is set. Exit codes: 0 sent,
 * 1 failure, 2 wallet needs funding.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
// Workspace sources by path (pnpm does not hoist packages to the repo root).
import {
  CHAINS,
  explorerAddressUrl,
  explorerTxUrl,
  fromRaw,
} from '../../packages/shared/src/index.js';
import { loadEnv } from '../../apps/api/src/config/env.js';
import { createPrisma } from '../../apps/api/src/lib/infra.js';
import { createWalletProvider } from '../../apps/api/src/modules/wallet/privy.js';
import { devSubject } from '../../apps/api/src/modules/auth/dev-identity-provider.js';

const { values } = parseArgs({
  options: {
    user: { type: 'string' },
    'no-wait': { type: 'boolean', default: false },
  },
});

const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const ok = (msg: string) => console.log(`  \u001b[32m✔\u001b[0m ${msg}`);
const info = (msg: string) => console.log(`    ${msg}`);
const fail = (msg: string, code = 1): never => {
  console.error(`  \u001b[31m✘\u001b[0m ${msg}`);
  process.exit(code);
};

const env = (() => {
  try {
    return loadEnv({ ...process.env, LOG_LEVEL: 'silent' });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
})();
if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET)
  fail('PRIVY_APP_ID and PRIVY_APP_SECRET must be set in .env');
if (!env.EXECUTION_RPC_URL)
  fail('EXECUTION_RPC_URL must be set in .env (used to check gas and the receipt)');

const chain = CHAINS[env.EXECUTION_CHAIN_ID];
const logs: string[] = [];
const wallets = createWalletProvider(env, {
  info: (_obj, msg) => logs.push(msg),
  warn: (obj, msg) => logs.push(`${msg} ${JSON.stringify(obj)}`),
})!;

/** Minimal JSON-RPC client for the execution chain (balance, gas price, receipt). */
async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(env.EXECUTION_RPC_URL!, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

async function waitForReceipt(hash: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await rpcCall<{ status: string; blockNumber: string; gasUsed: string } | null>(
      'eth_getTransactionReceipt',
      [hash],
    );
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`not mined after ${timeoutMs / 1000} s`);
}

console.log(`\nPrivy smoke · ${chain.name} (${env.EXECUTION_CHAIN_ID})`);
console.log(
  `  authorization key: ${env.PRIVY_AUTHORIZATION_PRIVATE_KEY ? 'set (signed requests)' : 'not set (app secret only)'}\n`,
);

// 1. Wallet ---------------------------------------------------------------------------------
let walletId: string;
let address: `0x${string}`;
if (values.user) {
  const prisma = createPrisma(env.DATABASE_URL);
  try {
    const name = values.user;
    const user =
      (await prisma.user.findUnique({ where: { id: name } })) ??
      (await prisma.user.findUnique({
        where: { identityIss_identitySub: { identityIss: 'dev', identitySub: devSubject(name) } },
      }));
    if (!user) fail(`No user "${name}" (by id or dev display name)`);
    const wallet = await prisma.agentWallet.findUnique({ where: { userId: user!.id } });
    if (!wallet) fail(`User "${name}" has no agent wallet yet — finish onboarding step 2 first`);
    walletId = wallet!.privyWalletId;
    address = await wallets.getAddress(walletId);
    if (address.toLowerCase() !== wallet!.address.toLowerCase()) {
      fail(`Privy reports ${address} but the database has ${wallet!.address}`);
    }
    ok(`agent wallet of ${user!.displayName ?? user!.id}: ${address}`);
  } finally {
    await prisma.$disconnect();
  }
} else {
  const ref = await wallets
    .createAgentWallet('smoke-test')
    .catch((err: unknown) =>
      fail(`createAgentWallet: ${err instanceof Error ? err.message : String(err)}`),
    );
  walletId = ref.walletId;
  address = ref.address;
  ok(`smoke wallet (idempotent, external_id warden_smoke-test): ${address}`);
}
info(`Privy wallet id ${walletId}`);
info(explorerAddressUrl(env.EXECUTION_CHAIN_ID, address));

// 2. Policy ---------------------------------------------------------------------------------
const policyId = await wallets.attachPolicy(walletId);
if (policyId) ok(`Privy policy attached: ${policyId}`);
else {
  console.log(
    '  \u001b[33m!\u001b[0m Privy policy API unavailable — continuing with the backend guard only',
  );
  for (const line of logs) info(line);
}

// 3. Gas ------------------------------------------------------------------------------------
const balance = BigInt(await rpcCall<string>('eth_getBalance', [address, 'latest']));
const gasPrice = BigInt(await rpcCall<string>('eth_gasPrice', []));
const needed = gasPrice * 21_000n * 2n;
info(`balance ${fromRaw(balance, 18)} ETH · ~${fromRaw(needed, 18)} ETH needed for gas`);
if (balance < needed) {
  console.log(
    `\n  Fund ${address} on ${chain.name} with a little testnet ETH (0.001 is plenty), then re-run.`,
  );
  fail('wallet needs funding', 2);
}
ok('wallet has gas');

// 4. Send -----------------------------------------------------------------------------------
const started = Date.now();
const { hash } = await wallets
  .sendTransaction(
    walletId,
    { to: address, value: '0', data: '0x', chainId: env.EXECUTION_CHAIN_ID },
    { idempotencyKey: `smoke-${walletId}-${started}` },
  )
  .catch((err: unknown) =>
    fail(`sendTransaction: ${err instanceof Error ? err.message : String(err)}`),
  );
ok(`0 ETH self-transfer sent in ${Date.now() - started} ms`);
console.log(`\n  tx hash: ${hash}\n  ${explorerTxUrl(env.EXECUTION_CHAIN_ID, hash)}\n`);

// 5. Receipt --------------------------------------------------------------------------------
if (!values['no-wait']) {
  info('waiting for the receipt…');
  const receipt = await waitForReceipt(hash, 180_000).catch((err: unknown) =>
    fail(
      `no receipt yet (${err instanceof Error ? err.message : String(err)}); check the explorer link`,
    ),
  );
  const block = BigInt(receipt.blockNumber);
  if (receipt.status !== '0x1') fail(`transaction reverted in block ${block}`);
  ok(`confirmed in block ${block} · gas used ${BigInt(receipt.gasUsed)}`);
}
process.exit(0);
