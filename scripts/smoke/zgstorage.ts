/* eslint-disable no-console -- Manual smoke CLI. */
/**
 * Live 0G Storage smoke (PHASE 05 §6): uploads a sample decision-log payload (canonical JSON)
 * with MemData through the turbo testnet indexer, downloads it back by root hash and asserts
 * byte equality. Needs ZG_STORAGE_PRIVATE_KEY (a funded 0G testnet key) in .env.
 * `pnpm smoke:zgstorage`
 */
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../../apps/api/src/config/env.js';
import { canonicalJson, sha256Hex } from '../../apps/api/src/lib/canonical.js';
import { createDecisionLogStorage } from '../../apps/api/src/modules/decisionlog/storage.js';
import { decisionLogExplorerUrl } from '../../apps/api/src/modules/decisionlog/service.js';

process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
const env = loadEnv();
const storage = createDecisionLogStorage(env);
if (!storage) {
  console.error('ZG_STORAGE_PRIVATE_KEY is not set in .env — nothing to test.');
  process.exit(1);
}

const sample = {
  version: 1,
  app: env.APP_NAME,
  chainId: env.EXECUTION_CHAIN_ID,
  kind: 'smoke',
  policy: {
    outcome: 'REFUSE',
    reasons: [{ code: 'GUARD_UNAVAILABLE', message: 'Safety check unavailable' }],
  },
  at: new Date().toISOString(),
};
const text = canonicalJson(sample);
const bytes = new TextEncoder().encode(text);
console.log(`payload ${bytes.length} bytes, sha256 ${sha256Hex(text)}`);

const started = Date.now();
const { rootHash, txHash } = await storage.upload(bytes);
console.log(`uploaded in ${Date.now() - started} ms`);
console.log(`  root hash ${rootHash}`);
console.log(`  tx hash   ${txHash}`);
console.log(`  explorer  ${decisionLogExplorerUrl(env.ZG_STORAGE_EXPLORER_URL, txHash)}`);

let back: Uint8Array | null = null;
for (let attempt = 1; attempt <= 10 && !back; attempt += 1) {
  try {
    back = await storage.download(rootHash);
  } catch (err) {
    console.log(`  download attempt ${attempt}: ${(err as Error).message.slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, 6_000));
  }
}
if (!back) {
  console.error('FAIL: could not download the payload back by root hash');
  process.exit(1);
}
const equal = new TextDecoder().decode(back) === text;
console.log(equal ? 'OK: downloaded payload equals the upload' : 'FAIL: payload mismatch');
process.exit(equal ? 0 : 1);
