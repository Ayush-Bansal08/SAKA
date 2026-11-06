/**
 * Triggers (PHASE 07 §4): a `create_trigger` intent becomes a canonical TriggerSpec (MCP
 * plan_trigger) stored ACTIVE. Creating a rule moves no money (no step-up); every fire later
 * runs through the full pipeline as a new AgentRequest with channel TRIGGER.
 */
import type { Prisma, PrismaClient, Trigger } from '@prisma/client';
import {
  Decimal,
  UniswapMcp,
  type ActionIntent,
  type PriceOverridesResponse,
  type TriggerView,
} from '@warden/shared';
import type { Redis } from 'ioredis';
import { nextLocalRun } from '../../lib/time.js';

export type TriggerSpec = UniswapMcp.TriggerSpec;

/** Chained progress, stored in Trigger.state. */
export interface ChainState {
  /** Index of the step that last ran. */
  step: number;
  total: number;
  /** Plan of that step the chain waits on (null once settled). */
  waitingPlanId: string | null;
  /** USD value produced by the previous step (lp_open "with proceeds"). */
  previousUsd: string | null;
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

export function parseSpec(t: Pick<Trigger, 'spec'>): TriggerSpec {
  return UniswapMcp.TriggerSpecSchema.parse(t.spec);
}

/** First run of a schedule rule; price rules have none. */
export function firstRunAt(spec: TriggerSpec, timezone: string, now: Date): Date | null {
  const c = spec.condition;
  if (c.type !== 'schedule' || !c.atLocalTime) return null;
  return nextLocalRun(now, timezone, c.atLocalTime, c.every ?? 'day', c.dayOfWeek);
}

export async function createTrigger(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: {
    userId: string;
    timezone: string;
    rule: Extract<ActionIntent, { type: 'create_trigger' }>['rule'];
    plan: UniswapMcp.ToolOutput<'plan_trigger'>;
    now: Date;
  },
): Promise<Trigger> {
  const spec = input.plan.spec;
  return prisma.trigger.create({
    data: {
      userId: input.userId,
      kind: spec.kind,
      spec: json(spec),
      rule: json(input.rule),
      summary: input.plan.humanSummary.slice(0, 300),
      status: 'ACTIVE',
      nextRunAt: firstRunAt(spec, input.timezone, input.now),
    },
  });
}

/** Owner-only cancel; false when not found or already closed. */
export async function cancelTrigger(
  prisma: PrismaClient | Prisma.TransactionClient,
  userId: string,
  id: string,
): Promise<boolean> {
  const res = await prisma.trigger.updateMany({
    where: { id, userId, status: 'ACTIVE' },
    data: { status: 'CANCELLED', lastResult: 'Cancelled by you' },
  });
  return res.count === 1;
}

const money = (v: string) =>
  `$${new Decimal(v).toDecimalPlaces(2).toNumber().toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

export function triggerView(t: Trigger): TriggerView {
  let spec: TriggerSpec | null = null;
  try {
    spec = parseSpec(t);
  } catch {
    spec = null;
  }
  const c = spec?.condition;
  const state = (t.state ?? null) as ChainState | null;
  return {
    id: t.id,
    kind: t.kind,
    status: t.status,
    summary: t.summary || t.kind,
    symbol: c?.symbol ?? null,
    targetPriceUsd: c?.targetPriceUsd ?? null,
    direction: c?.type === 'price_above' ? 'above' : c?.type === 'price_below' ? 'below' : null,
    schedule:
      c?.type === 'schedule'
        ? `Every ${c.every === 'week' ? `week${c.dayOfWeek ? ` on ${c.dayOfWeek}` : ''}` : 'day'} at ${c.atLocalTime}`
        : null,
    nextRunAt: t.nextRunAt?.toISOString() ?? null,
    lastFiredAt: t.lastFiredAt?.toISOString() ?? null,
    fireCount: t.fireCount,
    lastResult: t.lastResult,
    chain:
      t.kind === 'CHAINED' && spec
        ? {
            step: state ? state.step + (state.waitingPlanId ? 0 : 1) : 0,
            total: spec.actions.length,
            waitingPlanId: state?.waitingPlanId ?? null,
          }
        : null,
    createdAt: t.createdAt.toISOString(),
  };
}

export function triggerCondition(spec: TriggerSpec): string {
  const c = spec.condition;
  if (c.type === 'schedule') return `every ${c.every ?? 'day'} at ${c.atLocalTime}`;
  return `${c.symbol} ${c.type === 'price_above' ? '≥' : '≤'} ${money(c.targetPriceUsd ?? '0')}`;
}

// --- Demo price override (admin) -----------------------------------------------------------
// Affects ONLY trigger / detector reference price reads, never quotes used for execution.

export const overrideKey = (symbol: string) => `price-override:${symbol.toUpperCase()}`;
const OVERRIDE_INDEX = 'price-override:index';

export async function setPriceOverride(
  redis: Redis,
  o: { symbol: string; priceUsd: string; ttlSec: number },
  now: Date,
): Promise<{ symbol: string; priceUsd: string; expiresAt: string }> {
  const expiresAt = new Date(now.getTime() + o.ttlSec * 1000).toISOString();
  const value = JSON.stringify({ priceUsd: o.priceUsd, expiresAt });
  await redis.set(overrideKey(o.symbol), value, 'EX', o.ttlSec);
  await redis.sadd(OVERRIDE_INDEX, o.symbol.toUpperCase());
  return { symbol: o.symbol.toUpperCase(), priceUsd: o.priceUsd, expiresAt };
}

export async function clearPriceOverride(redis: Redis, symbol: string): Promise<void> {
  await redis.del(overrideKey(symbol));
  await redis.srem(OVERRIDE_INDEX, symbol.toUpperCase());
}

export async function readPriceOverride(redis: Redis, symbol: string): Promise<Decimal | null> {
  const raw = await redis.get(overrideKey(symbol));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { priceUsd: string };
    return new Decimal(v.priceUsd);
  } catch {
    return null;
  }
}

export async function listPriceOverrides(redis: Redis): Promise<PriceOverridesResponse> {
  const symbols = await redis.smembers(OVERRIDE_INDEX);
  const overrides: PriceOverridesResponse['overrides'] = [];
  for (const s of symbols) {
    const raw = await redis.get(overrideKey(s));
    if (!raw) {
      await redis.srem(OVERRIDE_INDEX, s);
      continue;
    }
    const v = JSON.parse(raw) as { priceUsd: string; expiresAt: string };
    overrides.push({ symbol: s, priceUsd: v.priceUsd, expiresAt: v.expiresAt });
  }
  return { overrides };
}
