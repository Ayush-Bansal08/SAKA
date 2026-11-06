/**
 * 0G Storage adapter — the only file that talks to `@0gfoundation/0g-storage-ts-sdk`.
 * Upload: MemData(bytes) → merkle root → Indexer(turbo testnet).upload(file, rpc, signer).
 * Download: Indexer.downloadToBlob(rootHash) (verified against the root by the SDK).
 */
import { Indexer, MemData } from '@0gfoundation/0g-storage-ts-sdk';
import { JsonRpcProvider, Wallet } from 'ethers';

export interface StorageUploadResult {
  rootHash: string;
  txHash: string;
}

export interface DecisionLogStorage {
  upload(bytes: Uint8Array): Promise<StorageUploadResult>;
  download(rootHash: string): Promise<Uint8Array>;
}

export class ZgStorageError extends Error {
  override name = 'ZgStorageError';
}

export interface ZgStorageConfig {
  rpcUrl: string;
  indexerUrl: string;
  privateKey: string;
}

export class ZgStorage implements DecisionLogStorage {
  private readonly indexer: Indexer;
  private readonly signer: Wallet;

  constructor(private readonly config: ZgStorageConfig) {
    this.indexer = new Indexer(config.indexerUrl);
    const key = config.privateKey.startsWith('0x') ? config.privateKey : `0x${config.privateKey}`;
    this.signer = new Wallet(key, new JsonRpcProvider(config.rpcUrl));
  }

  async upload(bytes: Uint8Array): Promise<StorageUploadResult> {
    const file = new MemData(bytes);
    const [tree, treeErr] = await file.merkleTree();
    if (treeErr || !tree)
      throw new ZgStorageError(`merkle tree failed: ${treeErr?.message ?? 'unknown'}`);
    const expectedRoot = tree.rootHash();
    // The SDK's .d.ts resolves ethers' CommonJS typings while we import its ESM build; at runtime
    // both are the same ESM module (the SDK's `import` entry), so this is a types-only bridge.
    const signer = this.signer as unknown as Parameters<Indexer['upload']>[2];
    const [result, err] = await this.indexer.upload(file, this.config.rpcUrl, signer);
    if (err) throw new ZgStorageError(`0G Storage upload failed: ${err.message.slice(0, 300)}`);
    // A small JSON payload is one segment: one root, one tx.
    const rootHash = 'rootHash' in result ? result.rootHash : result.rootHashes[0];
    const txHash = 'txHash' in result ? result.txHash : result.txHashes[0];
    if (!rootHash || !txHash) throw new ZgStorageError('0G Storage upload returned no root hash');
    if (expectedRoot && rootHash.toLowerCase() !== expectedRoot.toLowerCase())
      throw new ZgStorageError(`0G Storage root mismatch (${rootHash} ≠ ${expectedRoot})`);
    return { rootHash, txHash };
  }

  async download(rootHash: string): Promise<Uint8Array> {
    const [blob, err] = await this.indexer.downloadToBlob(rootHash);
    if (err) throw new ZgStorageError(`0G Storage download failed: ${err.message.slice(0, 300)}`);
    return new Uint8Array(await blob.arrayBuffer());
  }
}

export function createDecisionLogStorage(env: {
  ZG_STORAGE_PRIVATE_KEY?: string | undefined;
  ZG_STORAGE_RPC: string;
  ZG_STORAGE_INDEXER: string;
}): DecisionLogStorage | null {
  if (!env.ZG_STORAGE_PRIVATE_KEY) return null;
  return new ZgStorage({
    rpcUrl: env.ZG_STORAGE_RPC,
    indexerUrl: env.ZG_STORAGE_INDEXER,
    privateKey: env.ZG_STORAGE_PRIVATE_KEY,
  });
}
