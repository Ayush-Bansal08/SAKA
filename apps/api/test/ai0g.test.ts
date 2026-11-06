import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { ZgClient, ZgError, collectStream } from '../src/modules/ai0g/client.js';
import { Explainer } from '../src/modules/ai0g/explainer.js';
import {
  guard,
  parseDecision,
  renderGuardState,
  GUARD_STATE_MAX_CHARS,
  GUARD_UNAVAILABLE_REASON,
  type GuardInput,
} from '../src/modules/safety/guard.js';
import {
  parseIntent,
  plan,
  plannerTools,
  proposeParameters,
  quoteDecimalFields,
  toolSchema,
} from '../src/modules/agent/planner.js';
import type { PlannerContext } from '../src/modules/agent/context.js';
import { testEnv } from './helpers.js';

const ctx = { userId: 'user', traceId: 'trace' };
const WALLET = '0x1111111111111111111111111111111111111111';
const context: PlannerContext = {
  chainId: 11155111,
  chainName: 'Ethereum Sepolia',
  wallet: WALLET,
  quoteSwapper: WALLET,
  referencePricesUsd: { ETH: '3000.00', USDC: '1.00' },
  knownRecipients: [],
  activeTriggers: [],
  tokenAllowlist: [
    { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000', decimals: 18 },
  ],
};

function setup(responses: Response[], env: Record<string, string> = {}) {
  const create = vi.fn(async () => ({ id: `inference-${create.mock.calls.length}` }));
  const emit = vi.fn(async () => undefined);
  const fetcher = vi.fn(async () => responses.shift() ?? new Response('{}', { status: 500 }));
  const client = new ZgClient(
    testEnv({
      ZG_API_KEY: 'test-api-secret-123456789',
      ZG_MODEL_PLANNER: 'planner-test',
      ZG_MODEL_PLANNER_FALLBACK: 'fallback-test',
      ZG_MODEL_GUARD: 'guard-test',
      ZG_MODEL_EXPLAINER: 'explainer-test',
      ...env,
    }),
    { inference: { create } } as unknown as PrismaClient,
    { emit },
    fetcher,
  );
  return { client, create, emit, fetcher };
}
const requestBody = (fetcher: ReturnType<typeof setup>['fetcher'], call = 0) =>
  JSON.parse((fetcher.mock.calls[call] as unknown as [unknown, RequestInit])[1].body as string);
const requestHeaders = (fetcher: ReturnType<typeof setup>['fetcher'], call = 0) =>
  new Headers((fetcher.mock.calls[call] as unknown as [unknown, RequestInit])[1].headers);

function envelope(body: Record<string, unknown>, id = 'zg-test') {
  return new Response(
    JSON.stringify({
      ...body,
      x_0g_trace: {
        request_id: id,
        provider: 'provider',
        tee_verified: true,
        billing: { total_cost: '10' },
      },
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    }),
    { headers: { 'content-type': 'application/json', 'x-request-id': id } },
  );
}
const response = (message: unknown, id?: string) => envelope({ choices: [{ message }] }, id);
const decision = (answers: unknown) => envelope({ answers });
function terminal(name: string, args: unknown, id = 'call') {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}
const swapIntent = {
  type: 'swap_exact_in',
  tokenIn: { symbol: 'ETH' },
  tokenOut: { symbol: 'USDC' },
  amountIn: '0.006666',
  amountUsd: '20',
  reason: 'Swap the requested amount',
};
const guardInput: GuardInput = {
  intent: swapIntent as GuardInput['intent'],
  prepared: { amountUsd: '20', tokenIn: 'ETH', tokenOut: 'USDC', priceImpactPct: 0.1 },
  tradeScore: { score: 92 },
  hook: null,
  simulation: { ok: true, steps: 1 },
};

describe('0G client', () => {
  it('uses 2020-12 prefixItems for tuple tool arguments', () => {
    const schema = toolSchema(z.object({ pair: z.tuple([z.string(), z.string()]) }));
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.pair!.prefixItems).toHaveLength(2);
    expect(properties.pair!.items).toBe(false);
  });

  it('sends trust mode, client request ID, verify_tee and reasoning effort', async () => {
    const { client, fetcher } = setup([response({ role: 'assistant', content: 'OK' })]);
    await client.chat({
      ...ctx,
      role: 'EXPLAINER',
      model: 'explainer-test',
      trustMode: 'private',
      messages: [],
      maxTokens: 10,
    });
    const headers = requestHeaders(fetcher);
    expect(headers.get('X-0G-Provider-Trust-Mode')).toBe('private');
    expect(headers.get('X-Client-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
    const body = requestBody(fetcher);
    expect(body).toMatchObject({ verify_tee: true, reasoning_effort: 'low', stream: false });
  });

  it('omits reasoning_effort when configured off and passes response_format', async () => {
    const { client, fetcher } = setup([response({ role: 'assistant', content: '{}' })], {
      ZG_REASONING_EFFORT: 'off',
    });
    await client.chat({
      ...ctx,
      role: 'EXPLAINER',
      model: 'explainer-test',
      trustMode: 'private',
      messages: [],
      maxTokens: 10,
      responseFormat: { type: 'json_object' },
    });
    const body = requestBody(fetcher);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('accepts a body ID contained in a multi-value response header and preserves the header', async () => {
    const reply = response({ role: 'assistant', content: 'OK' });
    reply.headers.set('x-request-id', 'proxy-id, zg-test');
    const { client, create } = setup([reply]);
    const result = await client.chat({
      ...ctx,
      role: 'EXPLAINER',
      model: 'explainer-test',
      trustMode: 'private',
      messages: [],
      maxTokens: 10,
    });
    expect(result.zg.requestId).toBe('zg-test');
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        trace: expect.objectContaining({ responseRequestIdHeader: 'proxy-id, zg-test' }),
      }),
    });
  });

  it('rejects mismatching provenance and records the failure', async () => {
    const reply = response({ role: 'assistant', content: 'OK' });
    reply.headers.set('x-request-id', 'different');
    const { client, create } = setup([reply]);
    await expect(
      client.chat({
        ...ctx,
        role: 'EXPLAINER',
        model: 'explainer-test',
        trustMode: 'private',
        messages: [],
        maxTokens: 10,
      }),
    ).rejects.toBeInstanceOf(ZgError);
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ ok: false }) });
  });

  it('retries 429 honouring Retry-After with separate persisted attempts', async () => {
    const { client, create } = setup([
      new Response('{}', { status: 429, headers: { 'retry-after': '0' } }),
      response({ role: 'assistant', content: 'OK' }),
    ]);
    await client.chat({
      ...ctx,
      role: 'EXPLAINER',
      model: 'explainer-test',
      trustMode: 'private',
      messages: [],
      maxTokens: 10,
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]).toEqual([
      {
        data: expect.objectContaining({ ok: true, trace: expect.objectContaining({ attempt: 1 }) }),
      },
    ]);
  });

  it('gives up after two retries', async () => {
    const busy = () => new Response('{}', { status: 503, headers: { 'retry-after': '0' } });
    const { client, create } = setup([busy(), busy(), busy(), busy()]);
    await expect(
      client.chat({
        ...ctx,
        role: 'EXPLAINER',
        model: 'explainer-test',
        trustMode: 'private',
        messages: [],
        maxTokens: 10,
      }),
    ).rejects.toBeInstanceOf(ZgError);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('persists provenance and emits a request ID chip', async () => {
    const { client, create, emit } = setup([response({ role: 'assistant', content: 'OK' })]);
    const result = await client.chat({
      ...ctx,
      role: 'EXPLAINER',
      model: 'explainer-test',
      trustMode: 'private',
      messages: [],
      maxTokens: 10,
    });
    expect(result.zg.requestId).toBe('zg-test');
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        zgRequestId: 'zg-test',
        teeVerified: true,
        costRaw: '10',
        providerAddress: 'provider',
        inputTokens: 10,
        outputTokens: 3,
        ok: true,
      }),
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'plan',
        zg: expect.objectContaining({ requestId: 'zg-test', teeVerified: true }),
      }),
    );
  });

  it('records a failed planner and a separate fallback linked by fallbackOf', async () => {
    const { client, create, fetcher } = setup([
      new Response('{}', { status: 502 }),
      response({ role: 'assistant', content: 'OK' }),
    ]);
    await client.chat({
      ...ctx,
      role: 'PLANNER',
      model: 'planner-test',
      trustMode: 'private',
      messages: [],
      maxTokens: 10,
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]).toEqual([
      {
        data: expect.objectContaining({
          model: 'fallback-test',
          trustMode: 'verified',
          trace: expect.objectContaining({ fallbackOf: 'inference-1' }),
        }),
      },
    ]);
    expect(requestHeaders(fetcher, 1).get('X-0G-Provider-Trust-Mode')).toBe('verified');
  });

  it('uses the configured fallback trust mode for private-only keys', async () => {
    const { client, create } = setup(
      [new Response('{}', { status: 502 }), response({ role: 'assistant', content: 'OK' })],
      { ZG_PLANNER_FALLBACK_TRUST_MODE: 'private' },
    );
    await client.chat({
      ...ctx,
      role: 'PLANNER',
      model: 'planner-test',
      trustMode: 'private',
      messages: [],
      maxTokens: 10,
    });
    expect(create.mock.calls[1]).toEqual([
      { data: expect.objectContaining({ model: 'fallback-test', trustMode: 'private' }) },
    ]);
  });

  it('falls back when the planner exceeds ZG_PLANNER_TIMEOUT_MS', async () => {
    let call = 0;
    const create = vi.fn(async () => ({ id: `inference-${create.mock.calls.length}` }));
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (call++ === 0)
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          ),
        );
      return response({ role: 'assistant', content: 'OK' });
    });
    const client = new ZgClient(
      testEnv({
        ZG_API_KEY: 'test-api-secret-123456789',
        ZG_MODEL_PLANNER: 'planner-test',
        ZG_MODEL_PLANNER_FALLBACK: 'fallback-test',
        ZG_PLANNER_TIMEOUT_MS: '100',
      }),
      { inference: { create } } as unknown as PrismaClient,
      { emit: vi.fn(async () => undefined) },
      fetcher as unknown as typeof fetch,
    );
    const result = await client.chat({
      ...ctx,
      role: 'PLANNER',
      model: 'planner-test',
      trustMode: 'private',
      messages: [],
      maxTokens: 10,
    });
    expect(result.zg.model).toBe('fallback-test');
    expect(create.mock.calls[0]).toEqual([
      { data: expect.objectContaining({ ok: false, error: '0G request timed out' }) },
    ]);
  });

  it('does not fall back when allowFallback is false', async () => {
    const { client, create } = setup([new Response('{}', { status: 502 })]);
    await expect(
      client.chat({
        ...ctx,
        role: 'PLANNER',
        model: 'planner-test',
        trustMode: 'private',
        allowFallback: false,
        messages: [],
        maxTokens: 10,
      }),
    ).rejects.toBeInstanceOf(ZgError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('refuses to send configured credentials to inference', async () => {
    const { client, fetcher, create } = setup([]);
    await expect(
      client.chat({
        ...ctx,
        role: 'PLANNER',
        model: 'planner-test',
        trustMode: 'private',
        messages: [{ role: 'user', content: 'my key is test-api-secret-123456789' }],
        maxTokens: 10,
      }),
    ).rejects.toThrow('must not be sent');
    expect(fetcher).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('streams: assembles content and tool calls and reads x_0g_trace from the final chunk', async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] },
      { choices: [{ index: 0, delta: { content: 'lo' } }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'c1', function: { name: 'answer', arguments: '{"text":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] } },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 16, completion_tokens: 3 } },
      { choices: [], x_0g_trace: { request_id: 'stream-id', provider: '0xabc' } },
    ];
    const sse = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
    const { client, create, fetcher } = setup([
      new Response(sse, {
        headers: { 'content-type': 'text/event-stream', 'x-request-id': 'edge, stream-id' },
      }),
    ]);
    const result = await client.chat({
      ...ctx,
      role: 'EXPLAINER',
      model: 'explainer-test',
      trustMode: 'private',
      messages: [],
      maxTokens: 10,
      stream: true,
    });
    expect(requestBody(fetcher)).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(result.zg.requestId).toBe('stream-id');
    expect(result.data).toMatchObject({
      choices: [
        {
          message: {
            content: 'Hello',
            tool_calls: [{ id: 'c1', function: { name: 'answer', arguments: '{"text":"hi"}' } }],
          },
        },
      ],
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        zgRequestId: 'stream-id',
        inputTokens: 16,
        trace: expect.objectContaining({ streamed: true }),
      }),
    });
  });

  it('collectStream tolerates chunks without choices', async () => {
    async function* gen() {
      yield { choices: [] };
      yield { x_0g_trace: { request_id: 'x' } };
    }
    expect(await collectStream(gen())).toMatchObject({
      choices: [{ message: { content: null } }],
      x_0g_trace: { request_id: 'x' },
    });
  });
});

describe('guard (Vela decisions)', () => {
  const approveAnswers = {
    verdict: { choice: 'approve', probabilities: { approve: 0.93, block: 0.07 } },
    risk: { score: 0.1 },
    concerns: { choice: 'none' },
  };

  it('approves with a template reason and no explainer call', async () => {
    const { client, fetcher } = setup([decision(approveAnswers)]);
    const result = await guard(client, ctx, guardInput);
    expect(result).toMatchObject({
      verdict: 'approve',
      pApprove: 0.93,
      risk: 0.1,
      concerns: ['none'],
      reason: 'Safety checks passed.',
      unavailable: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = requestBody(fetcher);
    expect(body.model).toBe('guard-test');
    expect(Object.keys(body.questions)).toEqual(['verdict', 'risk', 'concerns']);
    expect(typeof body.state).toBe('string');
  });

  it('blocks below pApprove 0.8 and explains the concern via the explainer', async () => {
    const { client, fetcher } = setup([
      decision({
        verdict: { choice: 'approve', probabilities: { approve: 0.79, block: 0.21 } },
        risk: { score: 0.4 },
        concerns: { choice: 'price_impact' },
      }),
      response({ role: 'assistant', content: 'Price impact is high for this size.' }),
    ]);
    const result = await guard(client, ctx, guardInput);
    expect(result).toMatchObject({
      verdict: 'block',
      concerns: ['price_impact'],
      reason: 'Price impact is high for this size.',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('blocks a block verdict even with a high approve probability', async () => {
    const { client } = setup([
      decision({
        ...approveAnswers,
        verdict: { choice: 'block', probabilities: { approve: 0.9 } },
      }),
      response({ role: 'assistant', content: 'Blocked.' }),
    ]);
    expect((await guard(client, ctx, guardInput)).verdict).toBe('block');
  });

  it('fails closed on decisions errors', async () => {
    const { client } = setup([new Response('{}', { status: 502 })]);
    expect(await guard(client, ctx, guardInput)).toEqual({
      verdict: 'block',
      pApprove: 0,
      risk: 1,
      concerns: [],
      reason: GUARD_UNAVAILABLE_REASON,
      unavailable: true,
    });
  });

  it('fails closed on an unrecognised answer shape', async () => {
    for (const answers of [{}, { verdict: 'approve' }, { verdict: { choice: 'maybe' } }]) {
      const { client } = setup([decision(answers)]);
      expect(await guard(client, ctx, guardInput)).toMatchObject({
        verdict: 'block',
        unavailable: true,
      });
    }
  });

  it('parses the plausible alternative answer shapes', () => {
    expect(
      parseDecision({
        answers: {
          verdict: { answer: 'approve', probability: 0.9 },
          risk: 0.2,
          concerns: 'none',
        },
      }),
    ).toEqual({ choice: 'approve', pApprove: 0.9, risk: 0.2, concern: 'none' });
    expect(
      parseDecision({
        answers: {
          verdict: { label: 'block', probs: { block: 0.75 } },
          risk: { value: 0.6 },
          concerns: { label: 'hook_risk' },
        },
      }).pApprove,
    ).toBeCloseTo(0.25);
  });

  it('renders a compact deterministic state that truncates long lists', () => {
    const big: GuardInput = {
      ...guardInput,
      tradeScore: {
        score: 40,
        breakdown: Array.from({ length: 50 }, (_, i) => ({ factor: `factor_${i}`, penalty: -1 })),
      },
      prepared: { ...guardInput.prepared, route: 'x'.repeat(5000) },
    };
    const state = renderGuardState(big);
    expect(state.length).toBeLessThanOrEqual(GUARD_STATE_MAX_CHARS);
    expect(state).toContain('+45 more');
    expect(renderGuardState(big)).toBe(state);
    expect(renderGuardState(guardInput)).toContain('Simulation: passed');
  });
});

describe('explainer', () => {
  const hook = { hookAddress: WALLET as `0x${string}`, score: 62, band: 'CAUTION' as const };

  it('accepts a well-formed three-line hook explanation', async () => {
    const text =
      'What it does: Charges a dynamic fee.\nWhy it matters to you: Fees can rise in volatile markets.\nOur verdict: Caution — 62/100.';
    const { client } = setup([response({ role: 'assistant', content: text })]);
    expect(await new Explainer(client, ctx).explainHook(hook)).toBe(text);
  });

  it('falls back to a deterministic template on malformed output or errors', async () => {
    const { client } = setup([
      response({ role: 'assistant', content: 'This hook is fine.' }),
      new Response('{}', { status: 502 }),
    ]);
    const explainer = new Explainer(client, ctx);
    const first = await explainer.explainHook(hook);
    expect(first.split('\n')).toHaveLength(3);
    expect(first).toContain('Our verdict: Caution — 62/100');
    const brief = await explainer.morningBrief({ totalUsd: '120.50', alerts: ['ETH −5% in 1 h'] });
    expect(brief.split('\n').every((l) => l.startsWith('- '))).toBe(true);
    expect(brief).toContain('$120.50');
  });

  it('strips think blocks and enforces word limits', async () => {
    const { client } = setup([
      response({
        role: 'assistant',
        content: '<think>internal</think>ETH dipped 10%; buying $20.',
      }),
      response({ role: 'assistant', content: Array.from({ length: 40 }, () => 'word').join(' ') }),
    ]);
    const explainer = new Explainer(client, ctx);
    const event = { kind: 'DIP', summary: 'ETH is 10% below its 7-day high' };
    expect(await explainer.explainSuggestion(event, swapIntent as never)).toBe(
      'ETH dipped 10%; buying $20.',
    );
    const fallback = await explainer.explainSuggestion(event, swapIntent as never);
    expect(fallback.split(/\s+/).length).toBeLessThanOrEqual(30);
  });
});

describe('planner loop', () => {
  it('never exposes build tools', () => {
    expect(
      plannerTools.every((t) => t.type === 'function' && !t.function.name.startsWith('build_')),
    ).toBe(true);
    expect(plannerTools.map((t) => (t.type === 'function' ? t.function.name : ''))).toEqual([
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
      'propose',
      'answer',
    ]);
  });

  it('replays a recorded swap: get_quote with account defaults, then a valid intent', async () => {
    const fixture = JSON.parse(
      readFileSync(new URL('./fixtures/planner-swap.json', import.meta.url), 'utf8'),
    ) as { rounds: { headers: Record<string, string>; body: unknown }[] };
    const { client, fetcher } = setup(
      fixture.rounds.map(
        (r) =>
          new Response(JSON.stringify(r.body), {
            headers: { 'content-type': 'application/json', ...r.headers },
          }),
      ),
    );
    const callTool = vi.fn(async () => ({ amountOut: { decimal: '19.98' } }));
    const result = await plan(client, { callTool } as never, ctx, context, [
      { role: 'user', content: 'Swap $20 ETH to USDC' },
    ]);
    expect(result).toMatchObject({
      kind: 'intent',
      intent: { type: 'swap_exact_in', amountUsd: '20', amountIn: '0.006666' },
      zg: { requestId: 'ea06b540-abaa-45b3-823f-938faaa38f18', trustMode: 'private' },
    });
    expect(callTool).toHaveBeenCalledWith(
      'get_quote',
      expect.objectContaining({ chainId: 11155111, swapper: WALLET, type: 'EXACT_INPUT' }),
      ctx,
    );
    // The tool result goes back to the model, paired with its call id.
    const second = requestBody(fetcher, 1);
    expect(second.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_quote' });
    expect(second.messages[0].content).toContain('Ethereum Sepolia');
  });

  it('repairs one invalid final intent with the Zod error', async () => {
    const { client, fetcher } = setup([
      response(terminal('propose', {})),
      response(terminal('propose', swapIntent)),
    ]);
    const callTool = vi.fn();
    expect(
      await plan(client, { callTool }, ctx, context, [
        { role: 'user', content: 'Swap $20 ETH to USDC' },
      ]),
    ).toMatchObject({ kind: 'intent', intent: swapIntent });
    expect(callTool).not.toHaveBeenCalled();
    expect(requestBody(fetcher, 1).messages.at(-1).content).toContain('must be one of');
  });

  it('fails after a second invalid final intent', async () => {
    const { client } = setup([
      response(terminal('propose', {})),
      response(terminal('propose', { type: 'swap_exact_in' })),
    ]);
    await expect(
      plan(client, { callTool: vi.fn() }, ctx, context, [{ role: 'user', content: 'swap' }]),
    ).rejects.toThrow('could not validate');
  });

  it('rejects an invented recipient address', async () => {
    const invented = {
      type: 'transfer',
      token: { symbol: 'USDC' },
      amount: '20',
      recipient: '0xabcabcabcabcabcabcabcabcabcabcabcabcabca',
      reason: 'Send USDC',
    };
    const { client, fetcher } = setup([
      response(terminal('propose', invented)),
      response(terminal('answer', { text: 'What is the full address?', needsClarification: true })),
    ]);
    expect(
      await plan(client, { callTool: vi.fn() }, ctx, context, [
        { role: 'user', content: 'Send 20 USDC to 0xabc' },
      ]),
    ).toMatchObject({ kind: 'answer', needsClarification: true });
    expect(requestBody(fetcher, 1).messages.at(-1).content).toContain('appear nowhere');
  });

  it('accepts a recipient taken from the user message', async () => {
    const recipient = '0x000000000000000000000000000000000000dEaD';
    const intent = {
      type: 'transfer',
      token: { symbol: 'USDC' },
      amount: '20',
      recipient,
      reason: 'Send USDC',
    };
    const { client } = setup([response(terminal('propose', intent))]);
    expect(
      await plan(client, { callTool: vi.fn() }, ctx, context, [
        { role: 'user', content: `Send 20 USDC to ${recipient}` },
      ]),
    ).toMatchObject({ kind: 'intent', intent: { recipient } });
  });

  it('returns clarification without inventing a recipient', async () => {
    const { client } = setup([
      response(
        terminal('answer', {
          text: 'What is the full recipient address?',
          needsClarification: true,
        }),
      ),
    ]);
    expect(await plan(client, { callTool: vi.fn() }, ctx, context, [])).toMatchObject({
      kind: 'answer',
      needsClarification: true,
    });
  });

  it('refuses tools outside the allowlist without calling MCP', async () => {
    const { client, fetcher } = setup([
      response(terminal('build_swap', { chainId: 1 })),
      response(terminal('answer', { text: 'I can only plan.' })),
    ]);
    const callTool = vi.fn();
    await plan(client, { callTool }, ctx, context, [{ role: 'user', content: 'swap' }]);
    expect(callTool).not.toHaveBeenCalled();
    expect(requestBody(fetcher, 1).messages.at(-1).content).toContain('not available');
  });

  it('repairs a plain-text reply once', async () => {
    const { client } = setup([
      response({ role: 'assistant', content: 'Sure, I will swap.' }),
      response(terminal('answer', { text: 'How much ETH?', needsClarification: true })),
    ]);
    expect(
      await plan(client, { callTool: vi.fn() }, ctx, context, [{ role: 'user', content: 'swap' }]),
    ).toMatchObject({ kind: 'answer' });
  });

  it('offers only terminal tools after five read rounds', async () => {
    const read = (i: number) =>
      response(
        terminal('get_price_history', { symbol: 'ETH', window: '24h', interval: 'hour' }, `r${i}`),
      );
    const { client, fetcher } = setup([
      read(1),
      read(2),
      read(3),
      read(4),
      read(5),
      response(terminal('answer', { text: 'ETH is flat today.' })),
    ]);
    const callTool = vi.fn(async () => ({ changePct: 0 }));
    expect(
      await plan(client, { callTool } as never, ctx, context, [
        { role: 'user', content: 'How is ETH doing?' },
      ]),
    ).toMatchObject({ kind: 'answer' });
    expect(callTool).toHaveBeenCalledTimes(5);
    const last = requestBody(fetcher, 5);
    expect(last.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual([
      'propose',
      'answer',
    ]);
  });

  it('sends the pending intent for edits', async () => {
    const pendingIntent = { ...swapIntent, amountUsd: '20' } as PlannerContext['pendingIntent'];
    const { client, fetcher } = setup([
      response(terminal('propose', { ...swapIntent, amountIn: '0.01', amountUsd: '30' })),
    ]);
    const result = await plan(client, { callTool: vi.fn() }, ctx, { ...context, pendingIntent }, [
      { role: 'user', content: 'Make it $30' },
    ]);
    expect(result).toMatchObject({ kind: 'intent', intent: { amountUsd: '30' } });
    expect(requestBody(fetcher).messages[0].content).toContain('"pendingIntent"');
  });
});

describe('planner argument hygiene (recorded live failure)', () => {
  // GLM-5.3 wrote `"amount": 20, "recipient": 0x…dEaD` unquoted; the router re-serialised it.
  const live =
    '{"amount": 20, "reason": "Send 20 USDC.", "recipient": 57005, "token": {"symbol": "USDC"}, "type": "transfer"}';

  it('quotes bare decimal fields exactly, never addresses or text', () => {
    expect(quoteDecimalFields('{"amountIn": 0.006666, "amountUsd": 20}')).toBe(
      '{"amountIn": "0.006666", "amountUsd": "20"}',
    );
    expect(quoteDecimalFields(live)).toContain('"recipient": 57005');
    expect(quoteDecimalFields('{"reason": "set \\"amount\\": 5"}')).toBe(
      '{"reason": "set \\"amount\\": 5"}',
    );
    expect(quoteDecimalFields('{"percent": 50, "changePct": 2}')).toBe(
      '{"percent": 50, "changePct": 2}',
    );
  });

  it('reports the exact failing field for the intent type', () => {
    try {
      parseIntent(JSON.parse(quoteDecimalFields(live)));
      expect.unreachable();
    } catch (err) {
      expect((err as z.ZodError).issues.map((i) => i.path.join('.'))).toEqual(['recipient']);
    }
    expect(() => parseIntent({ type: 'teleport' })).toThrow('"type" must be one of');
  });

  it('repairs the recorded failure into a valid transfer', async () => {
    const recipient = '0x000000000000000000000000000000000000dEaD';
    const raw = (args: string) => ({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'p', type: 'function', function: { name: 'propose', arguments: args } }],
    });
    const { client, fetcher } = setup([
      response(raw(live)),
      response(raw(live.replace('57005', `"${recipient}"`))),
    ]);
    const result = await plan(client, { callTool: vi.fn() }, ctx, context, [
      { role: 'user', content: `Send 20 USDC to ${recipient}` },
    ]);
    expect(result).toMatchObject({ kind: 'intent', intent: { amount: '20', recipient } });
    const repairMessage = requestBody(fetcher, 1).messages.at(-1).content as string;
    expect(repairMessage).toContain('"path":"recipient"');
    expect(repairMessage).toContain('double quotes');
  });
});

describe('propose tool schema', () => {
  it('is one flat typed object so the router types every argument', () => {
    const { schema, fieldsByType } = proposeParameters();
    expect(schema).not.toHaveProperty('anyOf');
    const props = schema.properties as Record<string, { type?: string; enum?: string[] }>;
    expect(props.type!.enum).toContain('transfer');
    for (const key of ['amount', 'amountIn', 'amountOut', 'amountUsd', 'recipient', 'reason'])
      expect(props[key]!.type).toBe('string');
    expect(props.rule!.type).toBe('object');
    expect(fieldsByType).toContain('transfer: token, amount, recipient, reason');
  });
});
