/**
 * Guard (PHASE 04 §3): Vela 2.0 via POST /v1/decisions decides approve/block with a
 * probability; the explainer writes the reason. Block when verdict=block OR pApprove < 0.8.
 * FAIL CLOSED: any error, timeout or unrecognised answer shape → block, nothing executes.
 */
import { z } from 'zod';
import type { ActionIntent, HookBand, ZgProvenance } from '@warden/shared';
import type { ZgClient, CallContext } from '../ai0g/client.js';
import { Explainer, type Facts } from '../ai0g/explainer.js';

export const GUARD_CONCERNS = [
  'price_impact',
  'large_size',
  'unknown_token',
  'hook_risk',
  'simulation_failed',
  'recipient_risk',
  'limit_breach',
  'none',
] as const;
export type GuardConcern = (typeof GUARD_CONCERNS)[number];

export const GUARD_MIN_P_APPROVE = 0.8;
export const GUARD_UNAVAILABLE_REASON = 'Safety check unavailable — nothing was executed.';
/** ≈ 450 tokens of English: inside the 512-token budget for Vela's English checkpoint. */
export const GUARD_STATE_MAX_CHARS = 1800;

export interface GuardInput {
  intent: ActionIntent;
  prepared?: {
    amountUsd?: string | null;
    tokenIn?: string | null;
    tokenOut?: string | null;
    amountIn?: string | null;
    amountOut?: string | null;
    priceImpactPct?: number | null;
    slippagePct?: number | null;
    gasUsd?: string | null;
    route?: string | null;
    recipient?: string | null;
  };
  tradeScore?: { score: number; breakdown?: { factor: string; penalty: number }[] };
  hook?: { score: number; band: HookBand } | null;
  simulation?: { ok: boolean; error?: string | null; steps?: number };
  limits?: {
    riskProfile?: string;
    perActionUsd?: string;
    perDayUsd?: string;
    todaySpendUsd?: string;
    maxSlippagePct?: number;
  };
  portfolioSharePct?: number | null;
  recipientKnown?: boolean | null;
  tokensAllowlisted?: boolean | null;
}

export interface GuardResult {
  verdict: 'approve' | 'block';
  pApprove: number;
  risk: number;
  concerns: GuardConcern[];
  reason: string;
  /** True when the guard could not decide (error/timeout/bad shape) — the fail-closed path. */
  unavailable: boolean;
  zg?: ZgProvenance;
}

const MAX_LIST = 5;
const fmt = (v: unknown) => (v === null || v === undefined || v === '' ? 'unknown' : String(v));

/** Deterministic, compact text rendering of the guard inputs (stable order, truncated lists). */
export function renderGuardState(input: GuardInput): string {
  const i = input.intent as Record<string, unknown>;
  const token = (v: unknown) =>
    v && typeof v === 'object'
      ? fmt(
          (v as { symbol?: string; address?: string }).symbol ??
            (v as { address?: string }).address,
        )
      : fmt(v);
  const out: string[] = [`Action: ${input.intent.type}.`];
  const parts: string[] = [];
  if ('tokenIn' in i) parts.push(`in ${token(i.tokenIn)}`);
  if ('tokenOut' in i) parts.push(`out ${token(i.tokenOut)}`);
  if ('token' in i) parts.push(`token ${token(i.token)}`);
  if ('token0' in i) parts.push(`pair ${token(i.token0)}/${token(i.token1)}`);
  for (const k of ['amountIn', 'amountOut', 'amount', 'amountUsd', 'percent', 'rangePreset'])
    if (i[k] !== undefined) parts.push(`${k} ${fmt(i[k])}`);
  if (parts.length) out.push(`Intent: ${parts.join(', ')}.`);

  const p = input.prepared;
  if (p) {
    out.push(
      `Prepared: value $${fmt(p.amountUsd)}, ${fmt(p.amountIn)} ${fmt(p.tokenIn)} -> ${fmt(p.amountOut)} ${fmt(p.tokenOut)}, price impact ${fmt(p.priceImpactPct)}%, slippage ${fmt(p.slippagePct)}%, gas $${fmt(p.gasUsd)}.`,
    );
    if (p.route) out.push(`Route: ${p.route.slice(0, 160)}.`);
    if (p.recipient)
      out.push(
        `Recipient: ${p.recipient} (${input.recipientKnown === true ? 'used before' : input.recipientKnown === false ? 'NEW, never used' : 'unknown history'}).`,
      );
  }
  if (input.tokensAllowlisted !== undefined && input.tokensAllowlisted !== null)
    out.push(`Tokens allowlisted: ${input.tokensAllowlisted ? 'yes' : 'NO'}.`);
  if (input.tradeScore) {
    const b = (input.tradeScore.breakdown ?? []).filter((x) => x.penalty !== 0);
    const shown = b.slice(0, MAX_LIST).map((x) => `${x.factor} ${x.penalty}`);
    if (b.length > MAX_LIST) shown.push(`+${b.length - MAX_LIST} more`);
    out.push(
      `Trade score: ${input.tradeScore.score}/100${shown.length ? ` (penalties: ${shown.join('; ')})` : ''}.`,
    );
  }
  if (input.hook) out.push(`Hook: ${input.hook.band} ${input.hook.score}/100.`);
  else if (input.hook === null) out.push('Hook: none (hookless pool).');
  if (input.simulation)
    out.push(
      `Simulation: ${input.simulation.ok ? 'passed' : `FAILED${input.simulation.error ? ` (${input.simulation.error.slice(0, 120)})` : ''}`}${input.simulation.steps !== undefined ? `, ${input.simulation.steps} steps` : ''}.`,
    );
  else out.push('Simulation: not run.');
  const l = input.limits;
  if (l)
    out.push(
      `User: profile ${fmt(l.riskProfile)}, per-action limit $${fmt(l.perActionUsd)}, per-day limit $${fmt(l.perDayUsd)}, spent today $${fmt(l.todaySpendUsd)}, max slippage ${fmt(l.maxSlippagePct)}%.`,
    );
  if (input.portfolioSharePct !== undefined && input.portfolioSharePct !== null)
    out.push(`Share of portfolio: ${input.portfolioSharePct}%.`);
  const reason = 'reason' in input.intent ? input.intent.reason : '';
  if (reason) out.push(`Agent rationale: ${reason.slice(0, 160)}`);

  let text = out.join('\n');
  if (text.length > GUARD_STATE_MAX_CHARS) text = `${text.slice(0, GUARD_STATE_MAX_CHARS - 1)}…`;
  return text;
}

export const GUARD_QUESTIONS = {
  verdict: {
    type: 'choice',
    instructions:
      'Should this DeFi action run on the user’s behalf? Approve only if every fact indicates it is safe; block if anything is unsafe or uncertain.',
    criteria: {
      approve: 'Safe: simulation passed, small price impact, known tokens, within limits',
      block: 'Unsafe or uncertain',
    },
  },
  risk: {
    type: 'score',
    instructions: 'Overall risk of this action to the user, from 0 (no risk) to 1 (very risky).',
  },
  // VERIFY: `set` is listed for Vela in 0g-models.json but not in the /decisions endpoint
  // description; `choice` (documented) picks the single most important concern.
  concerns: {
    type: 'choice',
    instructions: 'The most important concern about this action, or none.',
    criteria: {
      price_impact: 'Price impact or slippage is high',
      large_size: 'Large relative to the portfolio',
      unknown_token: 'Token not on the allowlist or unknown',
      hook_risk: 'Pool hook is risky',
      simulation_failed: 'Simulation failed or was not run',
      recipient_risk: 'Recipient is new or suspicious',
      limit_breach: 'Exceeds the user limits',
      none: 'No concern',
    },
  },
} as const;

const probability = z.number().finite().min(0).max(1);
const AnswerSchema = z.record(z.unknown());

/** Probabilities map of a choice answer, whatever key the provider uses. */
function probabilitiesOf(answer: Record<string, unknown>): Record<string, number> | undefined {
  for (const key of ['probabilities', 'probs', 'distribution', 'scores']) {
    const parsed = z.record(probability).safeParse(answer[key]);
    if (parsed.success && Object.keys(parsed.data).length) return parsed.data;
  }
  return undefined;
}
function choiceOf(answer: Record<string, unknown>): string | undefined {
  for (const key of ['choice', 'answer', 'label', 'value']) {
    if (typeof answer[key] === 'string') return answer[key];
  }
  return undefined;
}

/**
 * VERIFY: the Router OpenAPI types the /decisions 200 body as an open object ("typed answers
 * keyed by question name", each "with a probability"). Accept the plausible shapes only; any
 * other shape throws, which the guard turns into a block.
 */
export function parseDecision(data: unknown): {
  choice: 'approve' | 'block';
  pApprove: number;
  risk: number;
  concern: GuardConcern;
} {
  const answers = z.object({ answers: z.record(z.unknown()) }).parse(data).answers;
  const verdict = AnswerSchema.parse(answers.verdict);
  const choice = z.enum(['approve', 'block']).parse(choiceOf(verdict));
  const probs = probabilitiesOf(verdict);
  let pApprove: number;
  if (probs && probs.approve !== undefined) pApprove = probability.parse(probs.approve);
  else if (probs && probs.block !== undefined) pApprove = 1 - probability.parse(probs.block);
  else {
    const p = probability.parse(verdict.probability ?? verdict.confidence);
    pApprove = choice === 'approve' ? p : 1 - p;
  }

  const riskRaw = answers.risk;
  const risk =
    typeof riskRaw === 'number'
      ? probability.parse(riskRaw)
      : probability.parse(AnswerSchema.parse(riskRaw).score ?? AnswerSchema.parse(riskRaw).value);

  const concernRaw = answers.concerns;
  const concern = z
    .enum(GUARD_CONCERNS)
    .parse(typeof concernRaw === 'string' ? concernRaw : choiceOf(AnswerSchema.parse(concernRaw)));
  return { choice, pApprove, risk, concern };
}

/** Facts handed to the explainer for the reason text (flat, no secrets). */
function reasonFacts(input: GuardInput): Facts {
  return {
    action: input.intent.type,
    amountUsd:
      input.prepared?.amountUsd ??
      ('amountUsd' in input.intent ? input.intent.amountUsd : undefined),
    priceImpactPct: input.prepared?.priceImpactPct ?? null,
    tradeScore: input.tradeScore?.score ?? null,
    hookBand: input.hook?.band ?? null,
    simulation: input.simulation ? (input.simulation.ok ? 'passed' : 'failed') : 'not run',
    recipientKnown: input.recipientKnown ?? null,
    portfolioSharePct: input.portfolioSharePct ?? null,
  };
}

export async function guard(
  client: ZgClient,
  ctx: CallContext,
  input: GuardInput,
): Promise<GuardResult> {
  try {
    const result = await client.decide({
      ...ctx,
      state: renderGuardState(input),
      questions: GUARD_QUESTIONS,
    });
    const decision = parseDecision(result.data);
    const blocked = decision.choice === 'block' || decision.pApprove < GUARD_MIN_P_APPROVE;
    const concerns: GuardConcern[] = [decision.concern];
    const reason =
      !blocked && decision.concern === 'none'
        ? 'Safety checks passed.'
        : await new Explainer(client, ctx).guardReason(concerns, reasonFacts(input));
    return {
      verdict: blocked ? 'block' : 'approve',
      pApprove: decision.pApprove,
      risk: decision.risk,
      concerns,
      reason,
      unavailable: false,
      zg: result.zg,
    };
  } catch {
    return {
      verdict: 'block',
      pApprove: 0,
      risk: 1,
      concerns: [],
      reason: GUARD_UNAVAILABLE_REASON,
      unavailable: true,
    };
  }
}
