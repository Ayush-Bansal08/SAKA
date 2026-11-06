/**
 * Policy engine (PHASE_00 §9, PHASE 05 §3). A pure function: facts in, outcome out.
 * Rules, first match wins:
 *   1. REFUSE  — build failed, simulation reverted/unavailable, unsupported token, Danger hook,
 *                guard blocked/unavailable, trade score < 40, price impact > 5%.
 *   2. STEP_UP — withdrawal, limit change, risk-profile change, never-used recipient (always).
 *   3. STEP_UP — over the per-action or per-day limit (exactly at the limit is allowed), or the
 *                value could not be priced.
 *   4. STEP_UP — Caution hook (unless the profile allows it), trade score < minTradeScoreAuto.
 *   5. ASK     — a Mode B suggestion that would need the human and was not accepted yet.
 *   6. AUTO.
 * Every reason carries a plain-English message plus the measured value and the limit.
 */
import {
  Decimal,
  POLICY_REFUSE,
  hookAllowedWithoutApproval,
  type HookBand,
  type HookPolicy,
  type PolicyOutcome,
  type PolicyReason,
} from '@warden/shared';

export interface PolicyInput {
  /** `proactive` = Mode B detector/trigger; `user` = the human asked (Mode A). */
  origin: 'user' | 'proactive';
  /** Mode B only: the human already said "Yes" to the suggestion. */
  proactiveAccepted?: boolean;
  buildError?: string | null;
  simulation: { ok: boolean; unavailable?: boolean; error?: string | null } | null;
  /** REFUSE facts from the trade score (unsupported/illiquid tokens, price impact). */
  refuseFacts: PolicyReason[];
  hook: { band: HookBand; score: number } | null;
  /** null = the guard did not run (no 0G key): fail closed. */
  guard: { verdict: 'approve' | 'block'; unavailable: boolean; reason: string } | null;
  tradeScore: number | null;
  priceImpactPct: number | null;
  withdrawal: boolean;
  limitChange?: boolean;
  riskProfileChange?: boolean;
  /** Who receives funds when it is not the agent wallet itself. */
  recipient: { address: string; known: boolean } | null;
  /** null = could not be priced. */
  amountUsd: Decimal | null;
  todaySpendUsd: Decimal;
  limits: {
    perActionUsd: Decimal.Value;
    perDayUsd: Decimal.Value;
    minTradeScoreAuto: number;
    hookPolicy: HookPolicy;
  };
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  reasons: PolicyReason[];
}

const money = (d: Decimal) =>
  d.isInteger() ? `$${d.toString()}` : `$${d.toDecimalPlaces(2).toFixed(2)}`;
const num = (d: Decimal) => d.toDecimalPlaces(2).toNumber();
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function refuseReasons(input: PolicyInput): PolicyReason[] {
  const out: PolicyReason[] = [...input.refuseFacts];
  if (input.buildError)
    out.push({
      code: 'BUILD_FAILED',
      message: `Uniswap could not build this action: ${input.buildError}`,
    });
  if (!input.buildError) {
    if (!input.simulation || input.simulation.unavailable)
      out.push({
        code: 'SIMULATION_UNAVAILABLE',
        message: 'The transaction could not be simulated, so it was not sent',
      });
    else if (!input.simulation.ok)
      out.push({
        code: 'SIMULATION_REVERTED',
        message: `The simulation failed${input.simulation.error ? `: ${input.simulation.error}` : ''}`,
      });
  }
  if (input.hook?.band === 'DANGER')
    out.push({
      code: 'DANGER_HOOK',
      message: `The pool hook is rated Danger (${input.hook.score}/100)`,
      value: input.hook.score,
      limit: 50,
    });
  if (!input.guard || input.guard.unavailable)
    out.push({ code: 'GUARD_UNAVAILABLE', message: 'Safety check unavailable' });
  else if (input.guard.verdict === 'block')
    out.push({ code: 'GUARD_BLOCKED', message: input.guard.reason });
  if (input.tradeScore !== null && input.tradeScore < POLICY_REFUSE.minTradeScore)
    out.push({
      code: 'TRADE_SCORE_TOO_LOW',
      message: `Trade safety score ${input.tradeScore}/100 is below ${POLICY_REFUSE.minTradeScore}`,
      value: input.tradeScore,
      limit: POLICY_REFUSE.minTradeScore,
    });
  if (
    input.priceImpactPct !== null &&
    input.priceImpactPct > POLICY_REFUSE.maxPriceImpactPct &&
    !out.some((r) => r.code === 'PRICE_IMPACT_TOO_HIGH')
  )
    out.push({
      code: 'PRICE_IMPACT_TOO_HIGH',
      message: `Price impact ${input.priceImpactPct}% is above the ${POLICY_REFUSE.maxPriceImpactPct}% hard limit`,
      value: input.priceImpactPct,
      limit: POLICY_REFUSE.maxPriceImpactPct,
    });
  return out;
}

function stepUpReasons(input: PolicyInput): PolicyReason[] {
  const always: PolicyReason[] = [];
  if (input.withdrawal)
    always.push({
      code: 'WITHDRAWAL',
      message: 'Sending funds out of your agent wallet always needs you',
    });
  if (input.limitChange)
    always.push({ code: 'LIMIT_CHANGE', message: 'Changing limits always needs you' });
  if (input.riskProfileChange)
    always.push({
      code: 'RISK_PROFILE_CHANGE',
      message: 'Changing your risk profile always needs you',
    });
  if (input.recipient && !input.recipient.known)
    always.push({
      code: 'NEW_RECIPIENT',
      message: `${short(input.recipient.address)} has never received funds from your agent`,
    });
  if (always.length) return always; // rule 2 matched

  const limits: PolicyReason[] = [];
  const perAction = new Decimal(input.limits.perActionUsd);
  const perDay = new Decimal(input.limits.perDayUsd);
  if (input.amountUsd === null) {
    limits.push({
      code: 'VALUE_UNKNOWN',
      message: 'The USD value could not be priced, so limits cannot be checked',
    });
  } else {
    if (input.amountUsd.gt(perAction))
      limits.push({
        code: 'OVER_PER_ACTION_LIMIT',
        message: `Over your ${money(perAction)} per-action limit`,
        value: num(input.amountUsd),
        limit: num(perAction),
      });
    const after = input.todaySpendUsd.plus(input.amountUsd);
    if (after.gt(perDay))
      limits.push({
        code: 'OVER_DAILY_LIMIT',
        message: `Would bring today's agent spending to ${money(after)}, over your ${money(perDay)} daily limit`,
        value: num(after),
        limit: num(perDay),
      });
  }
  if (limits.length) return limits; // rule 3 matched

  const quality: PolicyReason[] = [];
  if (
    input.hook?.band === 'CAUTION' &&
    !hookAllowedWithoutApproval('CAUTION', input.limits.hookPolicy)
  )
    quality.push({
      code: 'CAUTION_HOOK',
      message: `The pool hook is rated Caution (${input.hook.score}/100)`,
      value: input.hook.score,
      limit: 80,
    });
  if (input.tradeScore !== null && input.tradeScore < input.limits.minTradeScoreAuto)
    quality.push({
      code: 'TRADE_SCORE_BELOW_AUTO',
      message: `Trade safety score ${input.tradeScore}/100 is below your auto threshold of ${input.limits.minTradeScoreAuto}`,
      value: input.tradeScore,
      limit: input.limits.minTradeScoreAuto,
    });
  return quality; // rule 4 (may be empty)
}

export function decide(input: PolicyInput): PolicyDecision {
  const refuse = refuseReasons(input);
  if (refuse.length) return { outcome: 'REFUSE', reasons: refuse };

  const stepUp = stepUpReasons(input);
  if (stepUp.length) {
    if (input.origin === 'proactive' && !input.proactiveAccepted)
      return {
        outcome: 'ASK',
        reasons: [
          {
            code: 'PROACTIVE_NEEDS_ACCEPTANCE',
            message: 'Your agent suggests this; it needs your yes first',
          },
          ...stepUp,
        ],
      };
    return { outcome: 'STEP_UP', reasons: stepUp };
  }
  return { outcome: 'AUTO', reasons: [] };
}
