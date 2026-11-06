/**
 * What-if: the same trade through a hook pool (quote_pool) and through the default route
 * (get_quote), before and after gas. Used by the hook page and by Mode B's NEW_HOOK detector.
 */
import type { PrismaClient } from '@prisma/client';
import { Decimal, type HookWhatIf } from '@warden/shared';
import { getAddress } from 'viem';
import { AppError } from '../../lib/errors.js';
import type { UniswapMcpClient } from '../mcp/client.js';
import type { PriceService } from '../portfolio/market.js';

const ZERO = '0x0000000000000000000000000000000000000000';

export interface WhatIfDeps {
  prisma: PrismaClient;
  mcp: Pick<UniswapMcpClient, 'callTool'> | null;
  prices: Pick<PriceService, 'usd'>;
  executionChainId: number;
}

export async function hookWhatIf(
  deps: WhatIfDeps,
  input: {
    chainId: number;
    address: string;
    pair: string;
    amountUsd: Decimal.Value;
    userId: string;
  },
): Promise<HookWhatIf> {
  const { prisma, mcp, prices } = deps;
  const { chainId, address, userId } = input;
  const empty = (reason: string): HookWhatIf => ({
    available: false,
    reason,
    tokenIn: null,
    tokenOut: null,
    amountIn: null,
    viaHook: null,
    defaultRoute: null,
    differencePct: null,
    netDifferencePct: null,
  });
  if (chainId !== deps.executionChainId)
    return empty('Market data only — swaps cannot be routed through mainnet hooks here.');
  if (!mcp)
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'The Uniswap service is not configured.');
  const [inSym, outSym] = input.pair.toUpperCase().split('-') as [string, string];
  const pools = await prisma.hookPool.findMany({
    where: { chainId, hookAddress: { equals: getAddress(address), mode: 'insensitive' } },
  });
  const pool = pools.find((p) => {
    const syms = [p.token0Symbol?.toUpperCase(), p.token1Symbol?.toUpperCase()];
    const want = [
      inSym === 'ETH' ? ['ETH', 'WETH'] : [inSym],
      outSym === 'ETH' ? ['ETH', 'WETH'] : [outSym],
    ];
    return want.every((alts) => alts.some((a) => syms.includes(a)));
  });
  if (!pool) return empty(`This hook has no ${inSym}/${outSym} pool on this chain.`);
  const ctx = { traceId: `what-if-${Date.now()}`, userId, quiet: true };
  const price = await prices.usd(inSym);
  if (!price) return empty(`No reference price for ${inSym}.`);
  const zeroForOne = [pool.token0Symbol?.toUpperCase()].some(
    (s) => s === inSym || (inSym === 'ETH' && s === 'WETH'),
  );
  const tokenIn = zeroForOne ? pool.token0 : pool.token1;
  const tokenOut = zeroForOne ? pool.token1 : pool.token0;
  const decimalsIn = tokenIn.toLowerCase() === ZERO ? 18 : inSym === 'USDC' ? 6 : 18;
  const amountIn = new Decimal(input.amountUsd)
    .div(price.priceUsd)
    .toDecimalPlaces(Math.min(decimalsIn, 8), Decimal.ROUND_DOWN)
    .toString();
  try {
    const [via, base] = await Promise.all([
      mcp.callTool(
        'quote_pool',
        {
          chainId,
          poolKey: {
            currency0: getAddress(pool.token0),
            currency1: getAddress(pool.token1),
            fee: pool.fee,
            tickSpacing: pool.tickSpacing,
            hooks: getAddress(address),
          },
          zeroForOne,
          exactAmount: amountIn,
          type: 'EXACT_INPUT',
        },
        ctx,
      ),
      mcp.callTool(
        'get_quote',
        {
          chainId,
          tokenIn: getAddress(tokenIn),
          tokenOut: getAddress(tokenOut),
          amount: amountIn,
          type: 'EXACT_INPUT',
          swapper: '0x000000000000000000000000000000000000dEaD',
        },
        ctx,
      ),
    ]);
    const a = new Decimal(via.amountOut.decimal);
    const b = new Decimal(base.amountOut.decimal);
    // Gas: the default route's fee gives the gas price; the hook pool's gas units × that
    // price = its cost. Both go into the output token, so "net" is what the user keeps.
    const ethUsd = (await prices.usd('ETH'))?.priceUsd ?? null;
    const outUsd = (await prices.usd(outSym === 'WETH' ? 'ETH' : outSym))?.priceUsd ?? null;
    const baseGasUsd = base.gasFee.usd ? new Decimal(base.gasFee.usd) : null;
    const gasUnits = base.gasUseEstimate ?? '';
    const gasPriceWei =
      base.gasFee.wei && /^[1-9]\d*$/.test(gasUnits)
        ? new Decimal(base.gasFee.wei).div(gasUnits)
        : null;
    const viaGasUsd =
      gasPriceWei && ethUsd
        ? new Decimal(via.gasEstimate).times(gasPriceWei).div(new Decimal(10).pow(18)).times(ethUsd)
        : null;
    let netDifferencePct: number | null = null;
    if (baseGasUsd && viaGasUsd && outUsd?.gt(0)) {
      const netVia = a.minus(viaGasUsd.div(outUsd));
      const netBase = b.minus(baseGasUsd.div(outUsd));
      if (netBase.gt(0))
        netDifferencePct = netVia
          .minus(netBase)
          .div(netBase)
          .times(100)
          .toDecimalPlaces(3)
          .toNumber();
    }
    return {
      available: true,
      reason: null,
      tokenIn: inSym,
      tokenOut: outSym,
      amountIn,
      viaHook: {
        amountOut: via.amountOut.decimal,
        poolId: pool.poolId,
        fee: pool.fee,
        gasUsd: viaGasUsd ? viaGasUsd.toDecimalPlaces(4).toString() : null,
      },
      defaultRoute: {
        amountOut: base.amountOut.decimal,
        route: base.route.summary,
        gasUsd: baseGasUsd ? baseGasUsd.toDecimalPlaces(4).toString() : null,
      },
      netDifferencePct,
      differencePct: b.gt(0) ? a.minus(b).div(b).times(100).toDecimalPlaces(3).toNumber() : null,
    };
  } catch (err) {
    return empty(
      `Quote failed: ${err instanceof Error ? err.message.slice(0, 160) : 'unknown error'}`,
    );
  }
}
