/**
 * Trigger evaluator (PHASE 07 §4), worker every 30 s.
 *   price rules   reference price (demo override first, then the mainnet quote) vs the target
 *   schedules     nextRunAt ≤ now (DCA reschedules to the next local run)
 * On fire the action template becomes an intent ("50%" resolved against current holdings, "$20"
 * against the reference price) and runs through the one pipeline: prepare → score → simulate →
 * guard → policy. AUTO executes; STEP_UP creates an approval (toast on the web, notice on
 * Telegram with a link to approve in the app).
 * CHAINED: step N+1 starts only after step N's plan is EXECUTED; any refusal or failure stops the
 * chain and tells the human. Idempotency: one fire per trigger per window — key
 * `${triggerId}:${windowStart}` (Redis NX) plus an optimistic claim on the row.
 */
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, Trigger, User, AgentWallet } from '@prisma/client';
import { Decimal, type ActionIntent, type Card } from '@warden/shared';
import type { Redis } from 'ioredis';
import type { Logger } from '../../lib/logger.js';
import { nextLocalRun } from '../../lib/time.js';
import { runPipeline, type PipelineDeps } from '../agent/pipeline.js';
import type { BalanceReader, PriceService } from '../portfolio/market.js';
import type { Notifications } from '../telegram/notifications.js';
import {
  parseSpec,
  readPriceOverride,
  triggerCondition,
  type ChainState,
  type TriggerSpec,
} from './service.js';

export const TRIGGER_EVAL_EVERY_MS = 30_000;
const FIRE_KEY_TTL_S = 86_400;
/** A claimed chain step that never recorded its plan is stopped after this long. */
export const STUCK_STEP_MS = 10 * 60_000;
const STABLES = new Set(['USDC', 'USDT', 'DAI']);
const SETTLED_FAIL = new Set(['REFUSED', 'FAILED', 'CANCELLED', 'EXPIRED']);

export interface TriggerDeps {
  prisma: PrismaClient;
  redis: Redis;
  prices: Pick<PriceService, 'usd'>;
  balances: Pick<BalanceReader, 'read'>;
  /** null without MCP: rules stay ACTIVE and wait. */
  pipeline: PipelineDeps | null;
  traceBus: PipelineDeps['traceBus'];
  chainId: number;
  /** Telegram notices; receipts follow from the executor (PHASE 08). */
  notifications?: Pick<Notifications, 'enqueue'>;
  /** Where "approve in app" links point. */
  webUrl?: string;
  log?: Pick<Logger, 'warn' | 'info'>;
  now?: () => Date;
}

export interface EvaluateResult {
  checked: number;
  fired: number;
  advanced: number;
  stopped: number;
}

export class TriggerActionError extends Error {
  override name = 'TriggerActionError';
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const sym = (s: string | null | undefined) => (s ?? 'ETH').toUpperCase();

/** Live mainnet reference price — never overridden (used for amounts and value at risk). */
export async function livePrice(
  deps: Pick<TriggerDeps, 'prices'>,
  symbol: string,
): Promise<Decimal | null> {
  const s = sym(symbol) === 'WETH' ? 'ETH' : sym(symbol);
  if (STABLES.has(s)) return new Decimal(1);
  return (await deps.prices.usd(s))?.priceUsd ?? null;
}

/**
 * Trigger / detector reference price: the demo override wins, else the mainnet quote. Used ONLY
 * to decide whether a condition holds — amounts always use livePrice().
 */
export async function referencePrice(
  deps: Pick<TriggerDeps, 'redis' | 'prices'>,
  symbol: string,
): Promise<Decimal | null> {
  const s = sym(symbol) === 'WETH' ? 'ETH' : sym(symbol);
  const override = await readPriceOverride(deps.redis, s);
  if (override) return override;
  if (STABLES.has(s)) return new Decimal(1);
  return (await deps.prices.usd(s))?.priceUsd ?? null;
}

/** True when a price / schedule condition holds now. */
export async function conditionMet(
  deps: Pick<TriggerDeps, 'redis' | 'prices'>,
  t: Pick<Trigger, 'nextRunAt'>,
  spec: TriggerSpec,
  now: Date,
): Promise<boolean> {
  const c = spec.condition;
  if (c.type === 'schedule') return t.nextRunAt !== null && t.nextRunAt.getTime() <= now.getTime();
  if (!c.targetPriceUsd || !c.symbol) return false;
  const price = await referencePrice(deps, c.symbol);
  if (!price) return false;
  const target = new Decimal(c.targetPriceUsd);
  return c.type === 'price_above' ? price.gte(target) : price.lte(target);
}

const decimalsOf = (symbol: string) => (STABLES.has(symbol) ? 6 : 8);
const trimAmount = (d: Decimal, symbol: string) =>
  d.toDecimalPlaces(decimalsOf(symbol), Decimal.ROUND_DOWN);

/**
 * Action template → intent. `holdings` are current balances by symbol; `previousUsd` is what the
 * previous chained step produced (lp_open "with the proceeds").
 */
export async function templateToIntent(
  action: TriggerSpec['actions'][number],
  ctx: {
    holdings: Map<string, Decimal>;
    price: (symbol: string) => Promise<Decimal | null>;
    previousUsd: Decimal | null;
    summary: string;
  },
): Promise<ActionIntent> {
  const reason = `Your rule: ${ctx.summary}`.slice(0, 500);
  const amt = action.amount;
  const value = new Decimal(amt.value);
  const held = (s: string) => ctx.holdings.get(s === 'WETH' ? 'ETH' : s) ?? new Decimal(0);
  const resolveTokenAmount = async (token: string) => {
    if (amt.kind === 'percent') return held(token).times(value).div(100);
    if (amt.kind === 'usd') {
      const p = await ctx.price(token);
      if (!p) throw new TriggerActionError(`No reference price for ${token}.`);
      return value.div(p);
    }
    return value;
  };
  switch (action.type) {
    case 'swap_exact_in': {
      const tokenIn = sym(action.tokenIn);
      const tokenOut = sym(action.tokenOut);
      const amountIn = trimAmount(await resolveTokenAmount(tokenIn), tokenIn);
      if (amountIn.lte(0)) throw new TriggerActionError(`You hold no ${tokenIn} to swap.`);
      const p = await ctx.price(tokenIn);
      return {
        type: 'swap_exact_in',
        tokenIn: { symbol: tokenIn },
        tokenOut: { symbol: tokenOut },
        amountIn: amountIn.toString(),
        ...(p ? { amountUsd: amountIn.times(p).toDecimalPlaces(2).toString() } : {}),
        ...(action.maxSlippagePct ? { maxSlippagePct: action.maxSlippagePct } : {}),
        reason,
      };
    }
    case 'swap_exact_out':
      return {
        type: 'swap_exact_out',
        tokenIn: { symbol: sym(action.tokenIn) },
        tokenOut: { symbol: sym(action.tokenOut) },
        amountOut: value.toString(),
        ...(action.maxSlippagePct ? { maxSlippagePct: action.maxSlippagePct } : {}),
        reason,
      };
    case 'lp_open': {
      const usd =
        amt.kind === 'usd'
          ? value
          : amt.kind === 'percent'
            ? ctx.previousUsd
              ? ctx.previousUsd.times(value).div(100)
              : null
            : null;
      if (!usd || usd.lte(0))
        throw new TriggerActionError('This liquidity step needs a USD amount or a previous step.');
      return {
        type: 'lp_open',
        token0: { symbol: sym(action.token0) },
        token1: { symbol: sym(action.token1) },
        amountUsd: usd.toDecimalPlaces(2, Decimal.ROUND_DOWN).toString(),
        rangePreset:
          action.rangePreset === 'narrow'
            ? 'narrow'
            : action.rangePreset === 'wide'
              ? 'wide'
              : 'balanced',
        reason,
      };
    }
    case 'transfer': {
      const token = sym(action.token);
      const amount = trimAmount(await resolveTokenAmount(token), token);
      if (amount.lte(0)) throw new TriggerActionError(`You hold no ${token} to send.`);
      if (!action.recipient) throw new TriggerActionError('The transfer has no recipient.');
      return {
        type: 'transfer',
        token: { symbol: token },
        amount: amount.toString(),
        recipient: action.recipient as `0x${string}`,
        reason,
      };
    }
  }
}

interface StepResult {
  planId: string | null;
  outcome: 'AUTO' | 'STEP_UP' | 'REFUSE' | 'ASK' | null;
  text: string;
  amountUsd: Decimal | null;
}

async function postAgentMessage(
  prisma: PrismaClient,
  userId: string,
  traceId: string,
  requestId: string | null,
  text: string,
  cards: Card[],
) {
  await prisma.chatMessage.create({
    data: {
      userId,
      role: 'AGENT',
      text,
      cards: json(cards),
      traceId,
      ...(requestId ? { requestId } : {}),
    },
  });
}

/** Runs one action of a rule through the pipeline and posts the result in the chat. */
async function runStep(
  deps: TriggerDeps & { pipeline: PipelineDeps },
  trigger: Trigger,
  user: User,
  wallet: AgentWallet,
  spec: TriggerSpec,
  index: number,
  previousUsd: Decimal | null,
  idempotencyKey: string,
): Promise<StepResult> {
  const traceId = randomUUID();
  const total = spec.actions.length;
  const label = total > 1 ? ` (step ${index + 1} of ${total})` : '';
  const request = await deps.prisma.agentRequest.create({
    data: {
      userId: user.id,
      channel: 'TRIGGER',
      input: json({
        text: `Rule fired${label}: ${trigger.summary}`,
        event: { detector: 'TRIGGER', triggerId: trigger.id, step: index },
        idempotencyKey,
      }),
      traceId,
      status: 'PLANNING',
    },
  });
  const ctx = { userId: user.id, traceId, agentRequestId: request.id };
  await deps.traceBus.emit({
    ...ctx,
    kind: 'detector',
    title: `Rule fired${label}: ${trigger.summary}`.slice(0, 200),
    detail: `Condition met: ${triggerCondition(spec)}. Running it through every safety check.`,
    data: { triggerId: trigger.id, step: index },
  });

  const snapshot = await deps.balances
    .read(user.id, deps.chainId, wallet.address, { maxAgeMs: 10_000 })
    .catch(() => null);
  const holdings = new Map<string, Decimal>();
  let portfolioUsd: Decimal | null = snapshot ? new Decimal(0) : null;
  for (const t of snapshot?.tokens ?? []) {
    const s = t.symbol.toUpperCase() === 'WETH' ? 'ETH' : t.symbol.toUpperCase();
    holdings.set(s, (holdings.get(s) ?? new Decimal(0)).plus(new Decimal(t.balance)));
    const p = await livePrice(deps, s).catch(() => null);
    if (p && portfolioUsd) portfolioUsd = portfolioUsd.plus(new Decimal(t.balance).times(p));
  }

  let intent: ActionIntent;
  try {
    intent = await templateToIntent(spec.actions[index]!, {
      holdings,
      // Real prices only: a demo override decides WHEN a rule fires, never HOW MUCH it trades.
      price: (s) => livePrice(deps, s),
      previousUsd,
      summary: trigger.summary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.prisma.agentRequest.update({
      where: { id: request.id },
      data: { status: 'FAILED' },
    });
    const text = `Your rule "${trigger.summary}" fired${label}, but I could not run it: ${message}`;
    await postAgentMessage(deps.prisma, user.id, traceId, request.id, text, [
      { type: 'info', title: 'Rule could not run', body: text },
    ]);
    await deps.traceBus.emit({
      ...ctx,
      kind: 'error',
      title: 'Rule could not run',
      detail: message,
    });
    return { planId: null, outcome: null, text: message, amountUsd: null };
  }

  const result = await runPipeline(deps.pipeline, {
    ctx,
    user,
    wallet,
    intent,
    origin: 'user',
    channel: 'WEB',
    portfolioUsd: portfolioUsd && portfolioUsd.gt(0) ? portfolioUsd : null,
  });
  await postAgentMessage(
    deps.prisma,
    user.id,
    traceId,
    request.id,
    `Your rule "${trigger.summary}" fired${label}. ${result.text}`,
    result.cards,
  );
  if (!result.planId)
    await deps.prisma.agentRequest.update({
      where: { id: request.id },
      data: { status: 'FAILED' },
    });
  await result.afterReply();
  const plan = result.planId
    ? await deps.prisma.actionPlan.findUnique({
        where: { id: result.planId },
        select: { amountUsd: true, approval: { select: { id: true } } },
      })
    : null;
  if (result.outcome === 'STEP_UP' && plan?.approval)
    await deps.notifications?.enqueue({
      kind: 'text',
      userId: user.id,
      title: '🖐 Your rule needs approval',
      body: `${trigger.summary}${label}. ${result.text}`,
      ...(deps.webUrl
        ? {
            link: {
              label: 'Approve in app',
              url: `${deps.webUrl}/approvals/${plan.approval.id}`,
            },
          }
        : {}),
    });
  else if (result.outcome === 'REFUSE')
    await deps.notifications?.enqueue({
      kind: 'text',
      userId: user.id,
      title: '🛑 Your rule was refused',
      body: `${trigger.summary}${label}. ${result.text}`,
    });
  return {
    planId: result.planId,
    outcome: result.outcome,
    text: result.text,
    amountUsd: plan ? new Decimal(plan.amountUsd.toString()) : null,
  };
}

function resultLine(r: StepResult): string {
  switch (r.outcome) {
    case 'AUTO':
      return 'Executing';
    case 'STEP_UP':
      return 'Waiting for your approval';
    case 'REFUSE':
      return `Refused: ${r.text.replace(/^I did not do this:\s*/, '')}`.slice(0, 300);
    case 'ASK':
      return 'Suggested — waiting for your yes';
    default:
      return `Could not run: ${r.text}`.slice(0, 300);
  }
}

/** Optimistic claim: only the evaluator that still sees this exact row version proceeds. */
async function claim(
  prisma: PrismaClient,
  t: Trigger,
  data: Prisma.TriggerUpdateManyMutationInput,
): Promise<boolean> {
  const res = await prisma.trigger.updateMany({
    where: { id: t.id, status: 'ACTIVE', updatedAt: t.updatedAt },
    data,
  });
  return res.count === 1;
}

async function loadOwner(prisma: PrismaClient, userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { wallet: true } });
  return user?.wallet ? { user, wallet: user.wallet } : null;
}

async function stopChain(
  deps: TriggerDeps,
  t: Trigger,
  state: ChainState,
  why: string,
  now: Date,
): Promise<void> {
  const line = `Stopped at step ${state.step + 1} of ${state.total}: ${why}`;
  if (
    !(await claim(deps.prisma, t, {
      status: 'FAILED',
      lastResult: line.slice(0, 300),
      state: json({ ...state, waitingPlanId: null }),
    }))
  )
    return;
  const traceId = randomUUID();
  const text = `Your rule "${t.summary}" stopped: step ${state.step + 1} ${why}. Nothing else in the chain will run.`;
  await postAgentMessage(deps.prisma, t.userId, traceId, null, text, [
    { type: 'info', title: 'Rule stopped', body: text },
  ]);
  await deps.traceBus.emit({
    traceId,
    userId: t.userId,
    kind: 'error',
    title: 'Rule stopped',
    detail: text,
    data: { triggerId: t.id, at: now.toISOString() },
  });
  await deps.notifications?.enqueue({
    kind: 'text',
    userId: t.userId,
    title: '⚠️ Rule stopped',
    body: text,
  });
}

/** A chain waiting on a plan: advance on EXECUTED, stop on any failure, else keep waiting. */
async function advanceChain(
  deps: TriggerDeps & { pipeline: PipelineDeps },
  t: Trigger,
  spec: TriggerSpec,
  state: ChainState,
  now: Date,
): Promise<'advanced' | 'stopped' | 'waiting' | 'done'> {
  const plan = await deps.prisma.actionPlan.findUnique({
    where: { id: state.waitingPlanId! },
    select: { status: true, amountUsd: true, approval: { select: { status: true } } },
  });
  if (!plan) {
    await stopChain(deps, t, state, 'lost its plan', now);
    return 'stopped';
  }
  if (SETTLED_FAIL.has(plan.status)) {
    const why =
      plan.status === 'REFUSED'
        ? 'was refused by the safety checks'
        : plan.status === 'EXPIRED' || plan.approval?.status === 'EXPIRED'
          ? 'expired before you approved it'
          : plan.approval?.status === 'DENIED'
            ? 'was rejected by you'
            : `ended ${plan.status.toLowerCase()}`;
    await stopChain(deps, t, state, why, now);
    return 'stopped';
  }
  if (plan.status !== 'EXECUTED') return 'waiting';

  const next = state.step + 1;
  if (next >= state.total) {
    await claim(deps.prisma, t, {
      status: 'FIRED',
      lastResult: `All ${state.total} steps done`,
      state: json({ ...state, waitingPlanId: null }),
    });
    return 'done';
  }
  const previousUsd = new Decimal(plan.amountUsd.toString());
  // Claim before running so a concurrent evaluator cannot start the same step twice.
  const pending: ChainState = {
    step: next,
    total: state.total,
    waitingPlanId: null,
    previousUsd: previousUsd.toString(),
  };
  if (
    !(await claim(deps.prisma, t, {
      state: json(pending),
      lastResult: `Running step ${next + 1} of ${state.total}`,
    }))
  )
    return 'waiting';
  const owner = await loadOwner(deps.prisma, t.userId);
  if (!owner) {
    const fresh = await deps.prisma.trigger.findUniqueOrThrow({ where: { id: t.id } });
    await stopChain(deps, fresh, pending, 'has no agent wallet', now);
    return 'stopped';
  }
  const r = await runStep(
    deps,
    t,
    owner.user,
    owner.wallet,
    spec,
    next,
    previousUsd,
    `${t.id}:step:${next}`,
  );
  const fresh = await deps.prisma.trigger.findUniqueOrThrow({ where: { id: t.id } });
  if (!r.planId || r.outcome === 'REFUSE' || r.outcome === null) {
    await stopChain(
      deps,
      fresh,
      pending,
      r.outcome === 'REFUSE' ? 'was refused by the safety checks' : 'could not be prepared',
      now,
    );
    return 'stopped';
  }
  await claim(deps.prisma, fresh, {
    state: json({ ...pending, waitingPlanId: r.planId }),
    lastResult: `Step ${next + 1} of ${state.total}: ${resultLine(r)}`,
  });
  return 'advanced';
}

export async function evaluateTriggers(deps: TriggerDeps): Promise<EvaluateResult> {
  const now = deps.now?.() ?? new Date();
  const out: EvaluateResult = { checked: 0, fired: 0, advanced: 0, stopped: 0 };
  if (!deps.pipeline) return out;
  const pipelineDeps = { ...deps, pipeline: deps.pipeline };
  const active = await deps.prisma.trigger.findMany({
    where: { status: 'ACTIVE' },
    include: { user: { select: { timezone: true } } },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });

  for (const row of active) {
    out.checked += 1;
    const { user: owner, ...t } = row;
    try {
      const spec = parseSpec(t);
      const state = (t.state ?? null) as ChainState | null;
      if (state) {
        if (state.waitingPlanId) {
          const r = await advanceChain(pipelineDeps, t, spec, state, now);
          if (r === 'advanced') out.advanced += 1;
          if (r === 'stopped') out.stopped += 1;
        } else if (now.getTime() - t.updatedAt.getTime() > STUCK_STEP_MS) {
          // A step was claimed but never recorded its plan (process crashed mid-step).
          await stopChain(deps, t, state, 'was interrupted before it could start', now);
          out.stopped += 1;
        }
        continue; // a chain in progress never re-checks its condition
      }
      if (!(await conditionMet(deps, t, spec, now))) continue;

      const schedule = spec.condition.type === 'schedule';
      const windowStart = schedule
        ? t.nextRunAt!.toISOString()
        : new Date(
            Math.floor(now.getTime() / TRIGGER_EVAL_EVERY_MS) * TRIGGER_EVAL_EVERY_MS,
          ).toISOString();
      const key = `${t.id}:${windowStart}`;
      if ((await deps.redis.set(`trigger:fire:${key}`, '1', 'EX', FIRE_KEY_TTL_S, 'NX')) !== 'OK')
        continue;
      const chained = spec.kind === 'CHAINED' && spec.actions.length > 1;
      const claimed = await claim(deps.prisma, t, {
        fireCount: { increment: 1 },
        lastFiredAt: now,
        ...(schedule && spec.condition.atLocalTime
          ? {
              nextRunAt: nextLocalRun(
                now,
                owner.timezone,
                spec.condition.atLocalTime,
                spec.condition.every ?? 'day',
                spec.condition.dayOfWeek,
              ),
            }
          : {}),
        // One-shot price rules close on fire; chains close when their last step settles.
        ...(!schedule && !chained ? { status: 'FIRED' } : {}),
        ...(chained
          ? {
              state: json({
                step: 0,
                total: spec.actions.length,
                waitingPlanId: null,
                previousUsd: null,
              } satisfies ChainState),
            }
          : {}),
      });
      if (!claimed) continue;
      out.fired += 1;

      // Price alert: nothing to execute, just tell the human.
      if (!spec.actions.length) {
        const traceId = randomUUID();
        const text = `Price alert: ${t.summary}`;
        await postAgentMessage(deps.prisma, t.userId, traceId, null, text, [
          { type: 'info', title: 'Price alert', body: text },
        ]);
        await deps.traceBus.emit({
          traceId,
          userId: t.userId,
          kind: 'detector',
          title: text.slice(0, 200),
        });
        await deps.prisma.trigger.update({
          where: { id: t.id },
          data: { lastResult: 'Alert sent' },
        });
        await deps.notifications?.enqueue({
          kind: 'text',
          userId: t.userId,
          title: '🔔 Price alert',
          body: t.summary,
        });
        continue;
      }

      const ownerWallet = await loadOwner(deps.prisma, t.userId);
      if (!ownerWallet) {
        await deps.prisma.trigger.update({
          where: { id: t.id },
          data: {
            lastResult: 'Could not run: no agent wallet',
            ...(chained ? { status: 'FAILED' } : {}),
          },
        });
        continue;
      }
      const r = await runStep(
        pipelineDeps,
        t,
        ownerWallet.user,
        ownerWallet.wallet,
        spec,
        0,
        null,
        key,
      );
      const fresh = await deps.prisma.trigger.findUniqueOrThrow({ where: { id: t.id } });
      if (chained) {
        const st: ChainState = {
          step: 0,
          total: spec.actions.length,
          waitingPlanId: null,
          previousUsd: null,
        };
        if (!r.planId || r.outcome === 'REFUSE' || r.outcome === null) {
          await stopChain(
            deps,
            fresh,
            st,
            r.outcome === 'REFUSE' ? 'was refused by the safety checks' : 'could not be prepared',
            now,
          );
          out.stopped += 1;
        } else
          await claim(deps.prisma, fresh, {
            state: json({ ...st, waitingPlanId: r.planId }),
            lastResult: `Step 1 of ${st.total}: ${resultLine(r)}`,
          });
      } else {
        await deps.prisma.trigger.update({
          where: { id: t.id },
          data: { lastResult: resultLine(r) },
        });
      }
    } catch (err) {
      deps.log?.warn(
        { triggerId: t.id, err: err instanceof Error ? err.message.slice(0, 200) : String(err) },
        'trigger evaluation failed',
      );
    }
  }
  return out;
}
