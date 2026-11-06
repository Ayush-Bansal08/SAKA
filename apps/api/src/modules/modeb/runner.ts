/**
 * Mode B tick (PHASE 08 §1), a repeatable worker job every 60 s. Expired suggestions close first.
 * Then every user with a funded wallet is checked once, with a little jitter so upstreams see a
 * trickle rather than a burst, inside a total time budget. Users left over start the next tick,
 * so nobody is starved however long a slow upstream makes a pass.
 */
import type { AgentWallet, User } from '@prisma/client';
import { Decimal, riskProfileSettings, type SuggestionDetector } from '@warden/shared';
import { dayBoundsInZone } from '../../lib/time.js';
import { buildPortfolio } from '../portfolio/service.js';
import { briefData, recordPortfolioValue } from './brief.js';
import { buildContext, loadMarket, modebKeys } from './context.js';
import { DETECTORS, detectMorningBrief } from './detectors/index.js';
import {
  processEvent,
  sweepExpiredSuggestions,
  type ModeBDeps,
  type ProcessResult,
} from './suggestions.js';
import type { DetectorContext, DetectorEvent, MarketFacts } from './types.js';

export const JITTER_MAX_MS = 250;

export interface TickOptions {
  budgetMs: number;
  /** Tests skip the wait. */
  sleep?: (ms: number) => Promise<void>;
  /** The real clock for the budget, whatever deps.now says. */
  elapsedMs?: () => number;
}

export interface TickResult {
  users: number;
  checked: number;
  skippedUnfunded: number;
  suggestions: number;
  capped: number;
  expired: number;
  failures: number;
  /** Users the budget did not reach (they go first next tick). */
  deferred: number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** RED alerts and the brief never count against the daily cap, and neither do demo events. */
export const countsTowardCap = (e: Pick<DetectorEvent, 'severity' | 'detector'>) =>
  e.severity !== 'RED' && e.detector !== 'MORNING_BRIEF';

export async function proactiveToday(
  deps: Pick<ModeBDeps, 'prisma'>,
  user: Pick<User, 'id' | 'timezone'>,
  now: Date,
): Promise<number> {
  const { start, end } = dayBoundsInZone(now, user.timezone);
  return deps.prisma.suggestion.count({
    where: {
      userId: user.id,
      simulated: false,
      severity: { not: 'RED' },
      detector: { not: 'MORNING_BRIEF' },
      createdAt: { gte: start, lt: end },
    },
  });
}

export function detectAll(ctx: DetectorContext): DetectorEvent[] {
  return Object.values(DETECTORS).flatMap((detect) => {
    const event = detect(ctx);
    return event ? [event] : [];
  });
}

function portfolioDeps(deps: ModeBDeps) {
  return {
    prisma: deps.prisma,
    prices: deps.prices,
    balances: deps.balances,
    chainId: deps.env.EXECUTION_CHAIN_ID,
    allowlist: deps.env.TOKEN_ALLOWLIST_JSON,
    mcp: deps.mcp,
    ...(deps.now ? { now: deps.now } : {}),
  };
}

interface UserResult {
  funded: boolean;
  created: ProcessResult[];
  capped: number;
}

async function checkUser(
  deps: ModeBDeps,
  owner: { user: User; wallet: AgentWallet },
  market: MarketFacts,
  now: Date,
): Promise<UserResult> {
  const { user } = owner;
  const portfolio = await buildPortfolio(portfolioDeps(deps), user, owner.wallet);
  const total = new Decimal(portfolio.totalUsd);
  if (total.lte(0)) return { funded: false, created: [], capped: 0 };
  await recordPortfolioValue(deps, user.id, portfolio.totalUsd, now);

  const ctx = await buildContext(deps, owner, portfolio, market, { track: true });
  const events = detectAll(ctx);
  const created: ProcessResult[] = [];
  let capped = 0;
  const cap = riskProfileSettings(user.riskProfile).maxProactivePerDay;
  let used = await proactiveToday(deps, user, now);
  for (const event of events) {
    if (countsTowardCap(event) && used >= cap) {
      capped += 1;
      continue;
    }
    const result = await processEvent(deps, owner, event, {
      portfolioUsd: total,
      ...(event.detector === 'MORNING_BRIEF'
        ? { brief: await briefData(deps, user.id, portfolio, ctx) }
        : {}),
    });
    if (!result) continue;
    created.push(result);
    if (countsTowardCap(event)) used += 1;
  }
  return { funded: true, created, capped };
}

export async function runModeBTick(deps: ModeBDeps, opts: TickOptions): Promise<TickResult> {
  const now = deps.now?.() ?? new Date();
  const started = opts.elapsedMs?.() ?? Date.now();
  const elapsed = () => (opts.elapsedMs?.() ?? Date.now()) - started;
  const sleep = opts.sleep ?? realSleep;
  const out: TickResult = {
    users: 0,
    checked: 0,
    skippedUnfunded: 0,
    suggestions: 0,
    capped: 0,
    expired: await sweepExpiredSuggestions(deps),
    failures: 0,
    deferred: 0,
  };

  const owners = await deps.prisma.user.findMany({
    where: {
      onboardingStep: 'DONE',
      wallet: { is: { chainId: deps.env.EXECUTION_CHAIN_ID } },
    },
    include: { wallet: true },
    orderBy: { id: 'asc' },
  });
  out.users = owners.length;
  if (!owners.length) return out;

  // Continue after the last user the previous tick reached.
  const cursor = await deps.redis.get(modebKeys.cursor);
  const at = cursor ? owners.findIndex((o) => o.id > cursor) : 0;
  const ordered = at > 0 ? [...owners.slice(at), ...owners.slice(0, at)] : owners;

  const market = await loadMarket(deps, now);
  for (const [i, owner] of ordered.entries()) {
    if (elapsed() >= opts.budgetMs) {
      out.deferred = ordered.length - i;
      deps.log?.warn(
        { budgetMs: opts.budgetMs, deferred: out.deferred },
        'Mode B tick ran out of budget; the rest go first next tick',
      );
      break;
    }
    if (i > 0) await sleep(Math.floor(Math.random() * JITTER_MAX_MS));
    try {
      const r = await checkUser(deps, { user: owner, wallet: owner.wallet! }, market, now);
      if (r.funded) out.checked += 1;
      else out.skippedUnfunded += 1;
      out.suggestions += r.created.length;
      out.capped += r.capped;
    } catch (err) {
      out.failures += 1;
      deps.log?.warn(
        { userId: owner.id, err: err instanceof Error ? err.message.slice(0, 200) : String(err) },
        'Mode B check failed for one user',
      );
    }
    await deps.redis.set(modebKeys.cursor, owner.id, 'EX', 3600);
  }
  if (!out.deferred) await deps.redis.del(modebKeys.cursor);
  deps.log?.info(out, 'Mode B tick');
  return out;
}

/** Loads what a one-off run needs (simulate-event, on-demand brief). Null = no wallet. */
export async function loadForUser(deps: ModeBDeps, userId: string, only: SuggestionDetector) {
  const user = await deps.prisma.user.findUnique({
    where: { id: userId },
    include: { wallet: true },
  });
  if (!user?.wallet) return null;
  const now = deps.now?.() ?? new Date();
  const owner = { user, wallet: user.wallet };
  const portfolio = await buildPortfolio(portfolioDeps(deps), user, user.wallet);
  const market = await loadMarket(deps, now);
  const ctx = await buildContext(deps, owner, portfolio, market, { track: false, only });
  return { owner, portfolio, ctx };
}

/** POST /admin/run-brief: the brief now, whatever the hour; it does not use up today's key. */
export async function runBriefNow(deps: ModeBDeps, userId: string): Promise<ProcessResult | null> {
  const loaded = await loadForUser(deps, userId, 'MORNING_BRIEF');
  if (!loaded) return null;
  const { owner, portfolio, ctx } = loaded;
  const event = detectMorningBrief({ ...ctx, localHour: 8, localMinute: 0, seen: new Set() });
  if (!event) return null;
  return processEvent(deps, owner, event, {
    portfolioUsd: new Decimal(portfolio.totalUsd),
    fresh: true,
    brief: await briefData(deps, userId, portfolio, ctx),
  });
}
