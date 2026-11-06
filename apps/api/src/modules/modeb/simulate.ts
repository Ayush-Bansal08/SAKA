/**
 * Demo events (PHASE 08 §1): POST /admin/simulate-event overrides a detector's INPUTS and lets the
 * real detector decide. From there the path is identical to a real tick (processEvent: explainer,
 * pipeline, policy, notifications), except that the suggestion is tagged "Simulated (demo)" and
 * skips the daily cap and dedupe so a demo can be repeated. Amounts stay real: an override decides
 * that the event fires, and execution still quotes live.
 */
import {
  Decimal,
  type PortfolioResponse,
  type SimulateOverrides,
  type SuggestionDetector,
} from '@warden/shared';
import { AppError } from '../../lib/errors.js';
import { briefData } from './brief.js';
import { DETECTORS } from './detectors/index.js';
import { pairKey, STABLES } from './detectors/util.js';
import { loadForUser } from './runner.js';
import { processEvent, type ModeBDeps, type ProcessResult } from './suggestions.js';
import type { DetectorContext } from './types.js';

const DEMO_HOOK = '0x00000000000000000000000000000000000d3a00';
const DEMO_NEW_OWNER = '0x000000000000000000000000000000000000bEEF';
const DEMO_POOL = `0x${'d3'.repeat(32)}`;

function pickPosition(ctx: DetectorContext, id: string | undefined) {
  return id ? ctx.portfolio.lpPositions.find((p) => p.id === id) : ctx.portfolio.lpPositions[0];
}

/** The context as if the detector's condition held, keeping every value the demo left out. */
export function applyOverrides(
  detector: SuggestionDetector,
  ctx: DetectorContext,
  o: SimulateOverrides,
): DetectorContext {
  const base: DetectorContext = { ...ctx, seen: new Set() };
  switch (detector) {
    case 'DIP': {
      const high = o.ethHigh7dUsd
        ? new Decimal(o.ethHigh7dUsd)
        : (ctx.market.ethHigh7dUsd ?? ctx.market.ethPriceUsd ?? new Decimal(3000));
      return {
        ...base,
        market: {
          ...ctx.market,
          ethHigh7dUsd: high,
          ethPriceUsd: o.ethPriceUsd ? new Decimal(o.ethPriceUsd) : high.times('0.88'),
        },
        ...(o.amountUsd ? { profile: { dipBuyUsd: Number(o.amountUsd) } } : {}),
      };
    }
    case 'PROFIT': {
      const held = ctx.portfolio.tokens.filter(
        (t) => t.balanceRaw !== '0' && !STABLES.has(t.symbol.toUpperCase()),
      );
      const wanted = o.token?.toUpperCase();
      const token = wanted ? held.find((t) => t.symbol.toUpperCase() === wanted) : held[0];
      if (!token) return base;
      const pct = o.pnlPct ?? '15';
      const tokens = ctx.portfolio.tokens.map((t) =>
        t === token
          ? ({
              ...t,
              pnl: {
                costBasisUsd: t.pnl?.costBasisUsd ?? '0',
                valueUsd: t.pnl?.valueUsd ?? '0',
                unrealizedUsd: t.pnl?.unrealizedUsd ?? '0',
                realizedUsd: t.pnl?.realizedUsd ?? '0',
                pnlUsd: t.pnl?.pnlUsd ?? '0',
                pct,
              },
            } satisfies PortfolioResponse['tokens'][number])
          : t,
      );
      // Only this token is in profit, so the event is about the one the demo chose.
      const others = tokens.map((t) =>
        t.symbol === token.symbol ? t : ({ ...t, pnl: null } satisfies typeof t),
      );
      return { ...base, portfolio: { ...ctx.portfolio, tokens: others } };
    }
    case 'IDLE_USDC': {
      const longAgo = new Date(ctx.now.getTime() - 25 * 3_600_000);
      const balance = o.usdcBalance
        ? new Decimal(o.usdcBalance)
        : Decimal.max(ctx.usdc.balance, new Decimal('20.01'));
      return { ...base, usdc: { balance, lastOutflowAt: longAgo, heldSince: longAgo } };
    }
    case 'OUT_OF_RANGE': {
      const position = pickPosition(ctx, o.positionId);
      if (!position) return base;
      return {
        ...base,
        portfolio: {
          ...ctx.portfolio,
          lpPositions: ctx.portfolio.lpPositions.map((p) =>
            p.id === position.id ? { ...p, inRange: false } : { ...p, inRange: true },
          ),
        },
        outOfRangeChecks: { ...ctx.outOfRangeChecks, [position.tokenId]: 2 },
      };
    }
    case 'BETTER_POOL': {
      const position = pickPosition(ctx, o.positionId);
      if (!position) return base;
      const key = pairKey(position.token0.symbol, position.token1.symbol);
      const comparison = ctx.pools[key];
      if (!comparison) return base;
      const rankRow = comparison.ranked.find((r) => r.poolId === position.poolId);
      const candidate = comparison.ranked.find(
        (r) => r.usableOnExecutionChain && r.poolId !== position.poolId,
      );
      if (!candidate) return base;
      const ranked = comparison.ranked.map((r) =>
        r === candidate
          ? { ...r, adjustedAprPct: o.candidateAprPct ?? '20' }
          : r === rankRow
            ? { ...r, adjustedAprPct: o.currentAprPct ?? '5' }
            : r,
      );
      return {
        ...base,
        pools: { ...ctx.pools, [key]: { ...comparison, ranked } },
        moveGasUsd: ctx.moveGasUsd ?? new Decimal('0.01'),
      };
    }
    case 'NEW_HOOK':
      return {
        ...base,
        newHooks: [
          {
            hookAddress: o.hookAddress ?? DEMO_HOOK,
            pair: 'ETH/USDC',
            band: 'SAFE',
            score: 88,
            betterPct: new Decimal(o.betterPct ?? '0.45'),
            tryRequest: `Swap $5 ETH to USDC through hook ${o.hookAddress ?? DEMO_HOOK}`,
          },
        ],
      };
    case 'HOOK_CHANGED': {
      const position = pickPosition(ctx, o.positionId);
      const fees = { [DEMO_POOL]: 3000 };
      return {
        ...base,
        hookExposures: [
          {
            hookAddress: o.hookAddress ?? position?.hook?.address ?? DEMO_HOOK,
            positionIds: position ? [position.id] : [],
            previous: { codeHash: `0x${'ab'.repeat(32)}`, implementation: null, owner: null, fees },
            current: {
              codeHash: `0x${'ab'.repeat(32)}`,
              implementation: null,
              owner: o.newOwner ?? DEMO_NEW_OWNER,
              fees,
            },
          },
        ],
      };
    }
    case 'BIG_MOVE':
      return {
        ...base,
        market: {
          ...ctx.market,
          ethChange1hPct: new Decimal(o.ethChange1hPct ?? '-6'),
          // Only this detector runs here, so a DIP it would normally defer to must not count.
          ethHigh7dUsd: null,
          ...(o.ethPriceUsd ? { ethPriceUsd: new Decimal(o.ethPriceUsd) } : {}),
        },
        ...(o.amountUsd ? { profile: { dipBuyUsd: Number(o.amountUsd) } } : {}),
      };
    case 'MORNING_BRIEF':
      return { ...base, localHour: 8, localMinute: 0 };
  }
}

export async function simulateEvent(
  deps: ModeBDeps,
  input: {
    userId: string;
    detector: SuggestionDetector;
    overrides?: SimulateOverrides | undefined;
  },
): Promise<ProcessResult> {
  const loaded = await loadForUser(deps, input.userId, input.detector);
  if (!loaded) throw AppError.notFound('That user has no agent wallet.');
  const { owner, portfolio, ctx } = loaded;
  const simulated = applyOverrides(input.detector, ctx, input.overrides ?? {});
  const event = DETECTORS[input.detector](simulated);
  if (!event)
    throw new AppError(
      'CONFLICT',
      409,
      `${input.detector} did not fire: this account lacks what it needs (a position, a holding or a second pool).`,
    );
  const result = await processEvent(deps, owner, event, {
    portfolioUsd: new Decimal(portfolio.totalUsd),
    simulated: true,
    ...(input.detector === 'MORNING_BRIEF'
      ? { brief: await briefData(deps, input.userId, portfolio, simulated) }
      : {}),
  });
  if (!result) throw new AppError('CONFLICT', 409, 'That event could not be recorded.');
  return result;
}
