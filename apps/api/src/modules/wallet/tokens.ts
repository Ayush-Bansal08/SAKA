/**
 * Tokens the agent may hold on the execution chain: native ETH, the vendor-doc USDC/WETH
 * (mirrored in @warden/shared EXECUTION_CONTRACTS) and TOKEN_ALLOWLIST_JSON extras — the same
 * list the MCP server builds, so the Privy policy and deposit labels agree with get_portfolio.
 */
import { executionContracts, NATIVE_TOKEN_ADDRESS, type ExecutionChainId } from '@warden/shared';
import { getAddress } from 'viem';
import type { AllowlistEntry } from '../../config/env.js';

export interface ChainToken {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  isNative: boolean;
  /** Mainnet asset used for USD reference prices. */
  referenceSymbol: string;
}

export function executionTokens(
  chainId: ExecutionChainId,
  extra: readonly AllowlistEntry[] = [],
): ChainToken[] {
  const c = executionContracts(chainId);
  const list: ChainToken[] = [
    {
      address: NATIVE_TOKEN_ADDRESS,
      symbol: 'ETH',
      decimals: 18,
      isNative: true,
      referenceSymbol: 'ETH',
    },
  ];
  if (c.weth) {
    list.push({
      address: getAddress(c.weth),
      symbol: 'WETH',
      decimals: 18,
      isNative: false,
      referenceSymbol: 'ETH',
    });
  }
  if (c.usdc) {
    list.push({
      address: getAddress(c.usdc),
      symbol: 'USDC',
      decimals: 6,
      isNative: false,
      referenceSymbol: 'USDC',
    });
  }
  for (const e of extra) {
    if (e.chainId !== chainId) continue;
    const address = getAddress(e.address);
    // Built-ins win; config can never shadow ETH/WETH/USDC (same rule as the MCP registry).
    if (
      list.some((t) => t.address === address || t.symbol.toUpperCase() === e.symbol.toUpperCase())
    )
      continue;
    list.push({
      address,
      symbol: e.symbol,
      decimals: e.decimals,
      isNative: false,
      referenceSymbol: (e.referenceSymbol ?? e.symbol).toUpperCase(),
    });
  }
  return list;
}

export function findToken(tokens: readonly ChainToken[], address: string): ChainToken | undefined {
  const lower = address.toLowerCase();
  return tokens.find((t) => t.address.toLowerCase() === lower);
}

/** Contracts the agent wallet may send transactions to on the execution chain (Privy policy). */
export function allowedTransactionTargets(
  chainId: ExecutionChainId,
  extra: readonly AllowlistEntry[] = [],
): `0x${string}`[] {
  const c = executionContracts(chainId);
  const routers = Object.values(c.universalRouter).filter((a): a is `0x${string}` => a !== null);
  const tokens = executionTokens(chainId, extra)
    .filter((t) => !t.isNative)
    .map((t) => t.address);
  return unique([c.permit2, c.positionManager, ...routers, ...tokens]);
}

/** EIP-712 verifying contracts the agent may sign for (Permit2 + v4 PositionManager). */
export function allowedTypedDataDomains(chainId: ExecutionChainId): `0x${string}`[] {
  const c = executionContracts(chainId);
  return unique([c.permit2, c.positionManager]);
}

function unique(addresses: readonly string[]): `0x${string}`[] {
  return [...new Set(addresses.map((a) => getAddress(a)))];
}
