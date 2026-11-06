/**
 * Execution-chain reads through viem (EXECUTION_RPC_URL): eth_call simulation, gas estimates
 * and receipts. Broadcasting is Privy's job (wallet/privy.ts); this client never signs.
 * The narrow `ChainClient` interface lets tests replace the RPC entirely.
 */
import {
  BaseError,
  createPublicClient,
  http,
  type Hex,
  WaitForTransactionReceiptTimeoutError,
  TransactionReceiptNotFoundError,
} from 'viem';
import { sepolia, baseSepolia, unichainSepolia } from 'viem/chains';
import type { ExecutionChainId } from '@warden/shared';

export interface CallRequest {
  account: `0x${string}`;
  to: `0x${string}`;
  data: Hex;
  value: bigint;
  gas?: bigint;
}

export interface ChainLog {
  address: `0x${string}`;
  topics: readonly Hex[];
  data: Hex;
}

export interface ChainReceipt {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: ChainLog[];
}

export interface ChainClient {
  /** eth_call against the latest block. Throws `SimulationRevert` on revert. */
  call(req: CallRequest): Promise<void>;
  estimateGas(req: CallRequest): Promise<bigint>;
  /** Resolves null on timeout (the caller re-checks by hash; it never re-broadcasts). */
  waitForReceipt(hash: `0x${string}`, timeoutMs: number): Promise<ChainReceipt | null>;
  getReceipt(hash: `0x${string}`): Promise<ChainReceipt | null>;
  /** Current gas price in wei (Mode B payback maths). */
  gasPrice?(): Promise<bigint>;
}

/**
 * The limit a built transaction runs with. Uniswap's figure can fall short: a Permit2 swap needed
 * 293,085 against a quoted 277,512 and reverted with no reason. Unused gas is not charged.
 */
export const bufferedGas = (limit: string): bigint => (BigInt(limit) * 3n) / 2n;

export class SimulationRevert extends Error {
  override name = 'SimulationRevert';
}

/** Short, human-readable revert reason from a viem error (never the calldata). */
export function revertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const reverted = err.walk(
      (e) => 'reason' in (e as object) && Boolean((e as { reason?: string }).reason),
    ) as { reason?: string } | null;
    const text = reverted?.reason ?? err.shortMessage ?? err.message;
    return text.split('\n')[0]!.slice(0, 200);
  }
  return (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200);
}

const VIEM_CHAINS = { 11155111: sepolia, 84532: baseSepolia, 1301: unichainSepolia } as const;

export function createChainClient(
  chainId: ExecutionChainId,
  rpcUrl: string | undefined,
): ChainClient | null {
  if (!rpcUrl) return null;
  const client = createPublicClient({
    chain: VIEM_CHAINS[chainId],
    transport: http(rpcUrl, { timeout: 20_000 }),
  });
  const toReceipt = (
    r: Awaited<ReturnType<typeof client.getTransactionReceipt>>,
  ): ChainReceipt => ({
    status: r.status,
    blockNumber: r.blockNumber,
    gasUsed: r.gasUsed,
    effectiveGasPrice: r.effectiveGasPrice,
    logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
  });
  return {
    async call(req) {
      try {
        await client.call({
          account: req.account,
          to: req.to,
          data: req.data,
          value: req.value,
          ...(req.gas ? { gas: req.gas } : {}),
        });
      } catch (err) {
        throw new SimulationRevert(revertReason(err));
      }
    },
    estimateGas(req) {
      return client.estimateGas({
        account: req.account,
        to: req.to,
        data: req.data,
        value: req.value,
      });
    },
    async waitForReceipt(hash, timeoutMs) {
      try {
        return toReceipt(
          await client.waitForTransactionReceipt({
            hash,
            timeout: timeoutMs,
            pollingInterval: 2_000,
          }),
        );
      } catch (err) {
        if (err instanceof WaitForTransactionReceiptTimeoutError) return null;
        throw err;
      }
    },
    gasPrice() {
      return client.getGasPrice();
    },
    async getReceipt(hash) {
      try {
        return toReceipt(await client.getTransactionReceipt({ hash }));
      } catch (err) {
        if (err instanceof TransactionReceiptNotFoundError) return null;
        throw err;
      }
    },
  };
}
