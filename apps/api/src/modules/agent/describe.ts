/** Deterministic one-line summaries of an ActionIntent for provisional cards and traces. */
import type { ActionIntent, RuleSpec, TokenRef } from '@warden/shared';

const tok = (t: TokenRef) => t.symbol ?? `${t.address!.slice(0, 6)}…${t.address!.slice(-4)}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const money = (amount: string, token: TokenRef, usd?: string) =>
  usd ? `$${usd} ${tok(token)}` : `${amount} ${tok(token)}`;

function describeRule(rule: RuleSpec): string {
  const cond = (c: Extract<RuleSpec, { condition: unknown }>['condition']) =>
    c.type === 'price_above'
      ? `${tok(c.token)} ≥ $${c.priceUsd}`
      : c.type === 'price_below'
        ? `${tok(c.token)} ≤ $${c.priceUsd}`
        : `${tok(c.token)} ${c.changePct >= 0 ? '+' : ''}${c.changePct}%`;
  switch (rule.kind) {
    case 'DCA':
      return `buy $${rule.amountUsd} of ${tok(rule.buy)} every ${rule.intervalHours === 24 ? 'day' : `${rule.intervalHours} h`}`;
    case 'TAKE_PROFIT':
      return `take profit when ${cond(rule.condition)}`;
    case 'STOP_LOSS':
      return `stop loss when ${cond(rule.condition)}`;
    case 'CHAINED':
      return `when ${cond(rule.condition)}, run ${rule.steps.length} steps`;
    case 'PRICE_ALERT':
      return `alert when ${cond(rule.condition)}`;
  }
}

export function describeIntent(intent: ActionIntent): string {
  switch (intent.type) {
    case 'swap_exact_in':
      return `swap ${money(intent.amountIn, intent.tokenIn, intent.amountUsd)} → ${tok(intent.tokenOut)}`;
    case 'swap_exact_out':
      return `get exactly ${intent.amountOut} ${tok(intent.tokenOut)} with ${tok(intent.tokenIn)}`;
    case 'swap_and_send':
      return `send ${intent.amount} ${tok(intent.mode === 'exact_out' ? intent.tokenOut : intent.tokenIn)} to ${short(intent.recipient)}, paid with ${tok(intent.tokenIn)}`;
    case 'transfer':
      return `send ${intent.amount} ${tok(intent.token)} to ${short(intent.recipient)}`;
    case 'lp_open':
      return `provide ${intent.amountUsd ? `$${intent.amountUsd}` : 'liquidity'} to ${tok(intent.token0)}/${tok(intent.token1)} (${intent.rangePreset} range)`;
    case 'lp_rebalance':
      return `rebalance position ${intent.positionId} (${intent.rangePreset} range)`;
    case 'lp_exit':
      return `exit ${intent.percent}% of position ${intent.positionId}`;
    case 'create_trigger':
      return describeRule(intent.rule);
    case 'cancel_trigger':
      return `cancel trigger ${intent.triggerId}`;
    case 'info':
      return `answer a ${intent.topic.replace('_', ' ')} question`;
  }
}
