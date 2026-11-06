/**
 * One agent wallet per user. Idempotent at both ends: Privy finds the wallet again by
 * `external_id`, and `AgentWallet.userId` is unique, so concurrent or retried requests always
 * converge on a single wallet.
 */
import { Prisma, type AgentWallet, type PrismaClient } from '@prisma/client';
import type { AgentWalletView, ExecutionChainId } from '@warden/shared';
import { walletProviderNotConfigured, type WalletProvider } from './privy.js';

export interface WalletServiceDeps {
  prisma: PrismaClient;
  wallets: WalletProvider | null;
  chainId: ExecutionChainId;
}

export async function findAgentWallet(
  prisma: PrismaClient,
  userId: string,
): Promise<AgentWallet | null> {
  return prisma.agentWallet.findUnique({ where: { userId } });
}

/** Returns the user's wallet, creating it (and attaching the Privy policy) on first call. */
export async function ensureAgentWallet(
  deps: WalletServiceDeps,
  userId: string,
): Promise<{ wallet: AgentWallet; created: boolean }> {
  const existing = await findAgentWallet(deps.prisma, userId);
  if (existing) return { wallet: existing, created: false };
  if (!deps.wallets) throw walletProviderNotConfigured();

  const ref = await deps.wallets.createAgentWallet(userId);
  const policyId = await deps.wallets.attachPolicy(ref.walletId);
  try {
    const wallet = await deps.prisma.agentWallet.create({
      data: {
        userId,
        privyWalletId: ref.walletId,
        address: ref.address,
        chainId: deps.chainId,
        policyId,
      },
    });
    return { wallet, created: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // A concurrent request stored the same wallet first.
      const winner = await findAgentWallet(deps.prisma, userId);
      if (winner) return { wallet: winner, created: false };
    }
    throw err;
  }
}

export function toWalletView(wallet: AgentWallet): AgentWalletView {
  return {
    address: wallet.address as `0x${string}`,
    chainId: wallet.chainId as ExecutionChainId,
    createdAt: wallet.createdAt.toISOString(),
    policyId: wallet.policyId,
  };
}
