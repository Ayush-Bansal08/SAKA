/**
 * Planner (PHASE 04 §2): GLM-5.3 (private) on 0G with the MCP READ tools + plan_trigger and two
 * local terminal functions, `propose(intent)` and `answer({ text, cards? })`. Build tools are
 * never exposed to the model. Output is a Zod-validated ActionIntent or an info answer.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  Decimal,
  ACTION_INTENT_TYPES,
  ActionIntentSchema,
  InfoCardSchema,
  UniswapMcp,
  type ActionIntent,
  type ZgProvenance,
} from '@warden/shared';
import { McpToolCallError, type UniswapMcpClient } from '../mcp/client.js';
import type { ZgClient, CallContext, ChatMessage, ChatTool } from '../ai0g/client.js';
import type { PlannerContext } from './context.js';

const PROMPT = readFileSync(new URL('./prompts/planner.v1.md', import.meta.url), 'utf8');

export const READ_TOOLS = [
  'get_quote',
  'quote_pool',
  'get_portfolio',
  'get_price_history',
  'get_lp_positions',
  'compare_pools',
  'check_token',
  'list_new_hooks',
  'score_hook',
  'get_hook_state',
  'plan_trigger',
] as const;
export type PlannerReadTool = (typeof READ_TOOLS)[number];

/** Short model-facing descriptions (the MCP server's own descriptions are longer). */
const TOOL_DESCRIPTIONS: Record<PlannerReadTool, string> = {
  get_quote:
    'Uniswap quote (classic AMM). amount is a human decimal of tokenIn (EXACT_INPUT) or tokenOut (EXACT_OUTPUT). Returns amounts, price impact, gas and route. chainId 1 gives mainnet reference prices.',
  quote_pool: 'Quote one specific Uniswap v4 pool by PoolKey (V4Quoter).',
  get_portfolio: 'Token balances of an address with USD reference prices.',
  get_price_history: 'USD price history (mainnet) for a symbol: window 1h | 24h | 7d.',
  get_lp_positions: 'Read Uniswap v4 LP positions by tokenId.',
  compare_pools:
    'Compare Uniswap v4 pools for a pair and return a deterministic recommended pool with reasons.',
  check_token:
    'Token safety check: allowlist, unsupported list, contract sanity, liquidity depth; verdict OK | CAUTION | BLOCK.',
  list_new_hooks: 'List recently seen Uniswap v4 hooks and their pools.',
  score_hook: 'Deterministic 0–100 safety score and band for a v4 hook address.',
  get_hook_state: 'Snapshot of a v4 hook (code hash, owner, fees) for change detection.',
  plan_trigger:
    'Validate and normalise a trigger (take profit, stop loss, DCA, chained, alert) and return a one-line summary. Creates nothing.',
};

export const PLANNER_MAX_READ_ROUNDS = 5;
const MAX_CALLS_PER_ROUND = 4;
const TOOL_OUTPUT_MAX_CHARS = 12_000;

export const AnswerSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  needsClarification: z.boolean().optional(),
  cards: z
    .array(InfoCardSchema.omit({ zg: true }))
    .max(5)
    .optional(),
});
export type PlannerAnswer = z.infer<typeof AnswerSchema>;

const ToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function').default('function'),
  function: z.object({ name: z.string(), arguments: z.string().max(20_000) }),
});
const ResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z.array(ToolCallSchema).max(12).nullable().optional(),
        }),
      }),
    )
    .min(1),
});

/** A successful read-tool result the planner saw (the deterministic facts behind an answer). */
export interface PlannerFact {
  tool: PlannerReadTool;
  output: unknown;
}

export type PlanResult =
  | { kind: 'intent'; intent: ActionIntent; zg: ZgProvenance; digest?: unknown }
  | ({ kind: 'answer'; zg: ZgProvenance; facts: PlannerFact[]; digest?: unknown } & PlannerAnswer);

export interface PlanOptions {
  /** Adds a `digest` argument of this shape to `propose` and `answer`; returned unvalidated. */
  digest?: z.ZodTypeAny;
  /** Per-call deadline, for runs that write more than a chat reply. */
  timeoutMs?: number;
  /** Fail fast instead of sitting out a long Retry-After. */
  maxRetryWaitMs?: number;
}

export class PlannerError extends Error {
  override name = 'PlannerError';
}

/** 0G's provider validates tools against JSON Schema 2020-12, where tuples use prefixItems. */
export function toolSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const convert = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(convert);
    if (!value || typeof value !== 'object') return value;
    const result = Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== '$schema')
        .map(([key, item]) => [key, convert(item)]),
    );
    if (Array.isArray(result.items)) {
      result.prefixItems = result.items;
      result.items = result.additionalItems ?? false;
      delete result.additionalItems;
    }
    return result;
  };
  return convert(zodToJsonSchema(schema, { $refStrategy: 'none' })) as Record<string, unknown>;
}

interface ObjectJsonSchema {
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
}

/**
 * `propose` parameters: ONE flat object holding every field of every ActionIntent member, each
 * with its declared JSON type, plus `type` naming the member. The router's GLM tool-call parser
 * types each argument from the function's top-level `properties`; with the raw union (a
 * top-level `anyOf`) nothing is typed and values are literal-evaluated — live, `"amount": "20"`
 * arrived as 20 and the recipient 0x…dEaD as the integer 57005. Zod still validates the exact
 * member afterwards (`parseIntent`).
 */
export function proposeParameters(): { schema: Record<string, unknown>; fieldsByType: string } {
  const union = toolSchema(ActionIntentSchema) as { anyOf: ObjectJsonSchema[] };
  const properties: Record<string, unknown> = {
    type: {
      type: 'string',
      enum: [...ACTION_INTENT_TYPES],
      description: 'Which intent this is; it decides which other fields are used.',
    },
  };
  const fields: string[] = [];
  for (const member of union.anyOf) {
    const type = member.properties.type?.const ?? member.properties.type?.enum;
    const required = (member.required ?? []).filter((k) => k !== 'type');
    fields.push(`${String(type)}: ${required.join(', ')}`);
    for (const [key, value] of Object.entries(member.properties))
      if (key !== 'type' && !(key in properties))
        // A nested union (e.g. `rule`) still needs a top-level JSON type for the parser.
        properties[key] =
          value.type === undefined &&
          Array.isArray(value.anyOf) &&
          value.anyOf.every((v) => (v as { type?: unknown }).type === 'object')
            ? { type: 'object', ...value }
            : value;
  }
  return {
    schema: {
      type: 'object',
      properties,
      required: ['type', 'reason'],
      additionalProperties: false,
    },
    fieldsByType: fields.join('; '),
  };
}

const PROPOSE = proposeParameters();

const TERMINAL_TOOLS: ChatTool[] = [
  {
    type: 'function',
    function: {
      name: 'propose',
      description: `Final step for an action: return the proposed ActionIntent. Planning only — nothing is executed. Amounts, prices and addresses are quoted JSON strings ("amount": "20", "recipient": "0x…"). Required fields by type — ${PROPOSE.fieldsByType}.`,
      parameters: PROPOSE.schema,
    },
  },
  {
    type: 'function',
    function: {
      name: 'answer',
      description:
        'Final step for information or a clarifying question (set needsClarification true when asking).',
      parameters: toolSchema(AnswerSchema),
    },
  },
];

export const plannerTools: ChatTool[] = [
  ...READ_TOOLS.map((name) => ({
    type: 'function' as const,
    function: {
      name,
      description: TOOL_DESCRIPTIONS[name],
      parameters: toolSchema(UniswapMcp.TOOL_INPUT_SCHEMAS[name]),
    },
  })),
  ...TERMINAL_TOOLS,
];

/** The terminal tools with one more argument. `propose` and `answer` validation ignore it. */
function withDigest(digest: z.ZodTypeAny): ChatTool[] {
  return TERMINAL_TOOLS.map((tool) => {
    if (tool.type !== 'function') return tool;
    const parameters = tool.function.parameters as { properties: Record<string, unknown> };
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: {
          ...parameters,
          properties: { ...parameters.properties, digest: toolSchema(digest) },
        },
      },
    };
  });
}

export function systemPrompt(context: PlannerContext): string {
  return `${PROMPT.replaceAll('{{CHAIN_NAME}}', context.chainName).replaceAll(
    '{{CHAIN_ID}}',
    String(context.chainId),
  )}\n# Trusted account context\n${JSON.stringify(context)}`;
}

/** Fill the arguments the model may leave out but that are fixed by the account. */
function withDefaults(
  name: PlannerReadTool,
  args: Record<string, unknown>,
  context: PlannerContext,
): Record<string, unknown> {
  const shape = UniswapMcp.TOOL_INPUT_SCHEMAS[name].shape as Record<string, unknown>;
  const next = { ...args };
  if ('chainId' in shape && next.chainId === undefined) next.chainId = context.chainId;
  if (name === 'get_quote' && next.swapper === undefined) next.swapper = context.quoteSwapper;
  if (name === 'get_portfolio' && next.address === undefined && context.wallet)
    next.address = context.wallet;
  return next;
}

/** Every 0x address in the intent must appear in the conversation, context or tool results. */
function inventedAddresses(intent: ActionIntent, corpus: string): string[] {
  const found = JSON.stringify(intent).match(/0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/g) ?? [];
  return [...new Set(found)].filter((a) => !corpus.includes(a.toLowerCase()));
}

/**
 * Decimal-string fields the model sometimes emits as bare JSON numbers (`"amount": 20`). They
 * are quoted in the raw argument text, so the exact digits received are kept (no float
 * round-trip). Addresses are never coerced: a bare 0x… arrives re-serialised as an integer and
 * cannot be trusted, so it fails validation and the model is asked to resend it quoted.
 */
const DECIMAL_KEYS =
  /("(?:amount|amountIn|amountOut|amountUsd|amount0|amount1|priceUsd|exactAmount)"\s*:\s*)"?(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)"?(?=\s*[,}\]])/g;
export function quoteDecimalFields(rawArguments: string): string {
  // Models write tiny amounts as 6.925e-5, quoted or not; amounts must be plain decimals.
  return rawArguments.replace(
    DECIMAL_KEYS,
    (_m, key: string, value: string) =>
      `${key}"${/e/i.test(value) ? new Decimal(value).toFixed() : value}"`,
  );
}

type IntentMember = (typeof ActionIntentSchema.options)[number];
const INTENT_MEMBERS = new Map<string, IntentMember>(
  ActionIntentSchema.options.map((member) => {
    const object = member instanceof z.ZodEffects ? member.innerType() : member;
    return [(object.shape.type as z.ZodLiteral<string>).value, member];
  }),
);

/** Validates against the member named by `type`, so errors point at the exact field. */
export function parseIntent(args: unknown): ActionIntent {
  const type = args && typeof args === 'object' ? (args as { type?: unknown }).type : undefined;
  const member = typeof type === 'string' ? INTENT_MEMBERS.get(type) : undefined;
  if (!member)
    throw new PlannerError(`"type" must be one of: ${[...INTENT_MEMBERS.keys()].join(', ')}.`);
  member.parse(args);
  return ActionIntentSchema.parse(args);
}

const QUOTE_HINT =
  'Every amount and address is a JSON string in double quotes, e.g. "amount": "20", "recipient": "0x000000000000000000000000000000000000dEaD".';

function errorPayload(err: unknown): unknown {
  if (err instanceof z.ZodError)
    return {
      error: 'invalid_arguments',
      issues: err.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
      hint: QUOTE_HINT,
    };
  if (err instanceof McpToolCallError)
    return { error: err.code, message: err.message.slice(0, 500), retryable: err.retryable };
  if (err instanceof SyntaxError) return { error: 'arguments_not_json' };
  if (err instanceof PlannerError) return { error: 'rejected', message: err.message };
  return { error: 'tool_unavailable', message: 'Do not invent results; answer or ask instead.' };
}

const USD_PEGGED = new Set(['USDC', 'USDT', 'DAI']);
const DOLLAR_AMOUNT = /\$\s*(\d[\d,]*(?:\.\d+)?)\s+(?:(?:worth\s+)?of\s+)?([a-z][a-z0-9]*)/gi;

/**
 * The prompt says "$20 ETH" means $20 worth of ETH, but the model has returned 1 ETH for "$1 ETH".
 * Returns the correction when a swap's token amount is the request's dollar figure. For a
 * dollar-pegged token the two really are the same number, so "$20 USDC" passes.
 */
export function dollarAmountMisread(request: string, intent: ActionIntent): string | null {
  if (intent.type !== 'swap_exact_in') return null;
  const symbol = intent.tokenIn.symbol?.toUpperCase();
  if (!symbol || USD_PEGGED.has(symbol)) return null;
  for (const [, dollars, token] of request.matchAll(DOLLAR_AMOUNT)) {
    const figure = dollars!.replace(/,/g, '');
    if (token!.toUpperCase() === symbol && new Decimal(intent.amountIn).eq(figure))
      return `The human asked for $${figure} worth of ${symbol}, not ${figure} ${symbol}. Set amountUsd to "${figure}" and amountIn to ${figure} / the ${symbol} reference price.`;
  }
  return null;
}

export async function plan(
  client: ZgClient,
  mcp: Pick<UniswapMcpClient, 'callTool'>,
  ctx: CallContext,
  context: PlannerContext,
  history: { role: 'user' | 'assistant'; content: string }[],
  options: PlanOptions = {},
): Promise<PlanResult> {
  const terminalTools = options.digest ? withDigest(options.digest) : TERMINAL_TOOLS;
  const allTools = options.digest
    ? [...plannerTools.slice(0, READ_TOOLS.length), ...terminalTools]
    : plannerTools;
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(context) },
    ...history.slice(-12),
  ];
  let readRounds = 0;
  let repaired = false;
  const facts: PlannerFact[] = [];
  const repair = (why: string) => {
    if (repaired) throw new PlannerError(why);
    repaired = true;
  };

  // read rounds + one terminal-only round + one repair round
  for (let round = 0; round < PLANNER_MAX_READ_ROUNDS + 2; round++) {
    const terminalOnly = readRounds >= PLANNER_MAX_READ_ROUNDS;
    const response = await client.chat({
      ...ctx,
      role: 'PLANNER',
      model: client.model('PLANNER'),
      trustMode: 'private',
      messages,
      tools: terminalOnly ? terminalTools : allTools,
      toolChoice: 'required',
      maxTokens: options.digest ? 3000 : 2000,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxRetryWaitMs !== undefined ? { maxRetryWaitMs: options.maxRetryWaitMs } : {}),
    });
    const message = ResponseSchema.parse(response.data).choices[0]!.message;
    const calls = message.tool_calls ?? [];

    if (!calls.length) {
      // The model replied in plain text despite tool_choice=required.
      repair('The planner did not return a structured result.');
      messages.push({ role: 'assistant', content: message.content ?? '' });
      messages.push({
        role: 'user',
        content: 'Reply only by calling `propose` or `answer` (or a read tool first).',
      });
      continue;
    }
    messages.push({
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: c.function })),
    });

    const finalCall = calls.find(
      (c) => c.function.name === 'propose' || c.function.name === 'answer',
    );
    if (finalCall) {
      let problem: unknown;
      try {
        if (calls.length > 1)
          throw new PlannerError('Call propose or answer alone, after any read tools.');
        const args: unknown = JSON.parse(quoteDecimalFields(finalCall.function.arguments));
        const digest = options.digest ? { digest: (args as { digest?: unknown })?.digest } : {};
        if (finalCall.function.name === 'answer')
          return { kind: 'answer', ...AnswerSchema.parse(args), zg: response.zg, facts, ...digest };
        const intent = parseIntent(args);
        // Only what the model was given (system/user/tool), never its own output.
        const corpus = JSON.stringify(messages.filter((m) => m.role !== 'assistant')).toLowerCase();
        const invented = inventedAddresses(intent, corpus);
        if (invented.length)
          throw new PlannerError(
            `These addresses appear nowhere in the conversation or tools: ${invented.join(', ')}. Use symbols or ask for the full address.`,
          );
        // Chat only: a simulator run's "request" is a generated event, not the human's words.
        const request = history.filter((m) => m.role === 'user').at(-1)?.content;
        const misread = options.digest || !request ? null : dollarAmountMisread(request, intent);
        if (misread) throw new PlannerError(misread);
        return { kind: 'intent', intent, zg: response.zg, ...digest };
      } catch (err) {
        problem = err;
      }
      repair('I could not validate that plan. Please clarify the amount, token and recipient.');
      for (const call of calls)
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(
            call === finalCall
              ? errorPayload(problem)
              : { error: 'skipped: call one tool at a time' },
          ),
        });
      continue;
    }

    readRounds++;
    for (const [index, call] of calls.entries()) {
      let output: unknown;
      try {
        if (index >= MAX_CALLS_PER_ROUND)
          throw new PlannerError('Too many tool calls in one round.');
        if (!(READ_TOOLS as readonly string[]).includes(call.function.name))
          throw new PlannerError(`Tool ${call.function.name} is not available.`);
        const name = call.function.name as PlannerReadTool;
        const raw: unknown = JSON.parse(quoteDecimalFields(call.function.arguments || '{}'));
        const args = withDefaults(name, z.record(z.unknown()).parse(raw), context);
        output = await mcp.callTool(
          name,
          UniswapMcp.TOOL_INPUT_SCHEMAS[name].parse(args) as never,
          ctx,
        );
        facts.push({ tool: name, output });
      } catch (err) {
        output = errorPayload(err);
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(output).slice(0, TOOL_OUTPUT_MAX_CHARS),
      });
    }
  }
  throw new PlannerError('Planning reached its limit. Please simplify your request.');
}
