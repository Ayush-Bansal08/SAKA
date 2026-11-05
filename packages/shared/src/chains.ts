/**
 * Chain identities and display metadata. Contract addresses are added from the
 * vendor deployment docs in later phases — never hard-code them elsewhere.
 */
import { z } from 'zod';

export const MAINNET_CHAIN_ID = 1;
export const EXECUTION_CHAIN_IDS = [11155111, 84532, 1301] as const;
export const CHAIN_IDS = [MAINNET_CHAIN_ID, ...EXECUTION_CHAIN_IDS] as const;

export type ChainId = (typeof CHAIN_IDS)[number];
export type ExecutionChainId = (typeof EXECUTION_CHAIN_IDS)[number];

export const ChainIdSchema = z.union([
  z.literal(1),
  z.literal(11155111),
  z.literal(84532),
  z.literal(1301),
]);
export const ExecutionChainIdSchema = z.union([
  z.literal(11155111),
  z.literal(84532),
  z.literal(1301),
]);

export interface ChainMeta {
  id: ChainId;
  name: string;
  shortName: string;
  nativeSymbol: string;
  explorerBaseUrl: string;
  isTestnet: boolean;
  /** Execution happens only on testnets; mainnet is read-only market data. */
  role: 'execution' | 'reference';
}

export const CHAINS: Readonly<Record<ChainId, Readonly<ChainMeta>>> = Object.freeze({
  1: {
    id: 1,
    name: 'Ethereum',
    shortName: 'Ethereum mainnet',
    nativeSymbol: 'ETH',
    explorerBaseUrl: 'https://etherscan.io',
    isTestnet: false,
    role: 'reference',
  },
  11155111: {
    id: 11155111,
    name: 'Ethereum Sepolia',
    shortName: 'Sepolia',
    nativeSymbol: 'ETH',
    explorerBaseUrl: 'https://sepolia.etherscan.io',
    isTestnet: true,
    role: 'execution',
  },
  84532: {
    id: 84532,
    name: 'Base Sepolia',
    shortName: 'Base Sepolia',
    nativeSymbol: 'ETH',
    explorerBaseUrl: 'https://sepolia.basescan.org',
    isTestnet: true,
    role: 'execution',
  },
  1301: {
    id: 1301,
    name: 'Unichain Sepolia',
    shortName: 'Unichain Sepolia',
    nativeSymbol: 'ETH',
    explorerBaseUrl: 'https://sepolia.uniscan.xyz',
    isTestnet: true,
    role: 'execution',
  },
});

export function isChainId(value: unknown): value is ChainId {
  return typeof value === 'number' && (CHAIN_IDS as readonly number[]).includes(value);
}

export function chainMeta(id: ChainId): Readonly<ChainMeta> {
  return CHAINS[id];
}

export function explorerAddressUrl(id: ChainId, address: string): string {
  return `${CHAINS[id].explorerBaseUrl}/address/${address}`;
}

export function explorerTxUrl(id: ChainId, hash: string): string {
  return `${CHAINS[id].explorerBaseUrl}/tx/${hash}`;
}
