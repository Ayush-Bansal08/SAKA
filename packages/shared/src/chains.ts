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

/** Native ETH as the Uniswap API and LP API address it. */
export const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

// ---------------------------------------------------------------------------
// Execution-chain contracts the agent wallet may call (Privy policy allowlist)
// ---------------------------------------------------------------------------

export interface ExecutionContracts {
  permit2: `0x${string}`;
  positionManager: `0x${string}`;
  /** Universal Router per version (null = not deployed / not in the vendored docs). */
  universalRouter: { '2.1.2': `0x${string}` | null; '2.2.0': `0x${string}` | null };
  usdc: `0x${string}` | null;
  weth: `0x${string}` | null;
}

/**
 * Mirror of the execution-chain addresses in packages/uniswap-agent-mcp/src/chains.ts, which
 * copies each one from the vendored Uniswap docs. apps/api/test/chain-contracts-mirror.test.ts
 * fails if the two ever differ — change the MCP file first, then this one.
 */
const contracts = (c: ExecutionContracts): Readonly<ExecutionContracts> => Object.freeze(c);

export const EXECUTION_CONTRACTS: Readonly<Record<ExecutionChainId, Readonly<ExecutionContracts>>> =
  Object.freeze({
    11155111: contracts({
      permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      positionManager: '0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4',
      universalRouter: { '2.1.2': '0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3', '2.2.0': null },
      usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      weth: null,
    }),
    84532: contracts({
      permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      positionManager: '0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80',
      universalRouter: { '2.1.2': '0x8702463e73f74d0b6765aBceb314Ef07aCb92650', '2.2.0': null },
      usdc: null,
      weth: null,
    }),
    1301: contracts({
      permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      positionManager: '0xf969Aee60879C54bAAed9F3eD26147Db216Fd664',
      universalRouter: { '2.1.2': '0xDf38F24fE153761634Be942F9d859f3DBA857E95', '2.2.0': null },
      usdc: null,
      weth: null,
    }),
  });

export function executionContracts(id: ExecutionChainId): Readonly<ExecutionContracts> {
  return EXECUTION_CONTRACTS[id];
}

// ---------------------------------------------------------------------------
// Testnet faucets shown during onboarding (overridable with FAUCET_* env vars)
// ---------------------------------------------------------------------------

export interface FaucetLink {
  label: string;
  url: string;
  asset: 'ETH' | 'USDC';
}

/** Circle's faucet serves testnet USDC on every supported execution chain. */
export const CIRCLE_USDC_FAUCET_URL = 'https://faucet.circle.com';

export const DEFAULT_ETH_FAUCETS: Readonly<Record<ExecutionChainId, string>> = Object.freeze({
  11155111: 'https://cloud.google.com/application/web3/faucet/ethereum/sepolia',
  84532: 'https://portal.cdp.coinbase.com/products/faucet',
  1301: 'https://docs.unichain.org/docs/tools/faucets',
});
