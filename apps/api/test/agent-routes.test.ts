import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, devSignIn, uniqueName } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());
describe('agent HTTP boundary', () => {
  it('requires authentication and isolates history and cursors by human', async () => {
    const app = await createTestApp();
    try {
      expect((await app.inject({ method: 'GET', url: '/agent/messages' })).statusCode).toBe(401);
      const a = await devSignIn(app, uniqueName('history-a'));
      const b = await devSignIn(app, uniqueName('history-b'));
      const row = await app.deps.prisma.chatMessage.create({
        data: { userId: a.user.id, role: 'USER', text: 'private message' },
      });
      const result = await app.inject({
        method: 'GET',
        url: '/agent/messages',
        headers: { authorization: `Bearer ${b.token}` },
      });
      expect(result.json().messages).toEqual([]);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/agent/messages?cursor=${row.id}`,
            headers: { authorization: `Bearer ${b.token}` },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
  it('persists async intent and emits provenance through the real trace bus', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'final',
                        type: 'function',
                        function: {
                          name: 'propose',
                          arguments: JSON.stringify({
                            type: 'swap_exact_in',
                            tokenIn: { symbol: 'ETH' },
                            tokenOut: { symbol: 'USDC' },
                            amountIn: '0.01',
                            amountUsd: '20',
                            reason: 'Swap requested amount',
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
              x_0g_trace: { request_id: 'route-test', tee_verified: true },
            }),
            {
              headers: { 'content-type': 'application/json', 'x-request-id': 'proxy, route-test' },
            },
          ),
      ),
    );
    const app = await createTestApp(
      {
        ZG_API_KEY: 'route-secret-123456789',
        ZG_MODEL_PLANNER: 'test-planner',
        ZG_MODEL_PLANNER_FALLBACK: 'test-fallback',
      },
      {
        mcp: { callTool: vi.fn(), close: vi.fn() } as unknown as NonNullable<
          Parameters<typeof createTestApp>[1]
        >['mcp'],
      },
    );
    try {
      const login = await devSignIn(app, uniqueName('agent-route'));
      const reply = await app.inject({
        method: 'POST',
        url: '/agent/messages',
        headers: { authorization: `Bearer ${login.token}` },
        payload: { text: 'Swap $20 ETH to USDC' },
      });
      expect(reply.statusCode).toBe(202);
      const { agentRequestId, traceId } = reply.json();
      await vi.waitFor(
        async () =>
          expect(
            (await app.deps.prisma.agentRequest.findUnique({ where: { id: agentRequestId } }))
              ?.status,
          ).toBe('DONE'),
        { timeout: 10000 },
      );
      const messages = await app.deps.prisma.chatMessage.findMany({
        where: { requestId: agentRequestId },
      });
      expect(messages).toHaveLength(2);
      expect(messages.find((m) => m.role === 'AGENT')?.cards).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'intent' })]),
      );
      const events = await app.deps.prisma.traceEventRow.findMany({ where: { traceId } });
      expect(events.some((e) => e.title === 'Proposed intent')).toBe(true);
      expect(
        events.some(
          (e) =>
            e.zg &&
            typeof e.zg === 'object' &&
            !Array.isArray(e.zg) &&
            e.zg.requestId === 'route-test',
        ),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  const zgEnv = {
    ZG_API_KEY: 'route-secret-123456789',
    ZG_MODEL_PLANNER: 'test-planner',
    ZG_MODEL_PLANNER_FALLBACK: 'test-fallback',
  };
  const stubMcp = () =>
    ({ callTool: vi.fn(async () => ({})), close: vi.fn() }) as unknown as NonNullable<
      Parameters<typeof createTestApp>[1]
    >['mcp'];
  function plannerReply(name: 'propose' | 'answer', args: unknown) {
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'final',
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
          },
        ],
        x_0g_trace: { request_id: 'route-zg' },
      }),
      { headers: { 'content-type': 'application/json', 'x-request-id': 'edge, route-zg' } },
    );
  }
  async function send(
    app: Awaited<ReturnType<typeof createTestApp>>,
    token: string,
    text: string,
  ): Promise<{ agentRequestId: string; traceId: string }> {
    const reply = await app.inject({
      method: 'POST',
      url: '/agent/messages',
      headers: { authorization: `Bearer ${token}` },
      payload: { text },
    });
    expect(reply.statusCode).toBe(202);
    const body = reply.json() as { agentRequestId: string; traceId: string };
    await vi.waitFor(
      async () =>
        expect(
          (await app.deps.prisma.agentRequest.findUnique({ where: { id: body.agentRequestId } }))
            ?.status,
        ).toMatch(/DONE|FAILED/),
      { timeout: 10000 },
    );
    const userId = (
      await app.deps.prisma.agentRequest.findUniqueOrThrow({ where: { id: body.agentRequestId } })
    ).userId;
    await vi.waitFor(
      async () => expect(await app.deps.redis.get(`agent:planning:${userId}`)).toBeNull(),
      { timeout: 5000 },
    );
    return body;
  }
  const swap = {
    type: 'swap_exact_in',
    tokenIn: { symbol: 'ETH' },
    tokenOut: { symbol: 'USDC' },
    amountIn: '0.0066',
    amountUsd: '20',
    reason: 'Swap requested amount',
  };

  it('writes a provisional intent card, streams plan steps in order and serves a typed history view', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => plannerReply('propose', swap)),
    );
    const app = await createTestApp(zgEnv, { mcp: stubMcp() });
    try {
      const login = await devSignIn(app, uniqueName('agent-view'));
      const { traceId } = await send(app, login.token, 'Swap $20 ETH to USDC');
      const history = await app.inject({
        method: 'GET',
        url: '/agent/messages',
        headers: { authorization: `Bearer ${login.token}` },
      });
      const { messages, nextCursor } = history.json() as {
        messages: Record<string, unknown>[];
        nextCursor: string | null;
      };
      expect(nextCursor).toBeNull();
      expect(messages[0]).toMatchObject({
        role: 'AGENT',
        // No agent wallet yet: the plan is shown, and nothing is prepared or executed.
        text: 'Planned: swap $20 ETH → USDC. Create your agent wallet (onboarding) before it can run.',
        traceId,
      });
      expect(messages[0]).not.toHaveProperty('userId');
      expect(typeof messages[0]!.createdAt).toBe('string');
      expect(messages[1]).toMatchObject({ role: 'USER', text: 'Swap $20 ETH to USDC' });
      const titles = (
        await app.deps.prisma.traceEventRow.findMany({
          where: { traceId },
          orderBy: { ts: 'asc' },
        })
      ).map((e) => e.title);
      expect(titles).toEqual(['Planning on 0G', '0G planner', 'Proposed intent']);
    } finally {
      await app.close();
    }
  });

  it('passes the pending intent to the planner for edits', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(async () => plannerReply('propose', swap))
      .mockImplementationOnce(async () =>
        plannerReply('propose', { ...swap, amountIn: '0.0099', amountUsd: '30' }),
      );
    vi.stubGlobal('fetch', fetcher);
    const app = await createTestApp(zgEnv, { mcp: stubMcp() });
    try {
      const login = await devSignIn(app, uniqueName('agent-edit'));
      await send(app, login.token, 'Swap $20 ETH to USDC');
      await send(app, login.token, 'Make it $30');
      const init = fetcher.mock.calls[1]![1] as RequestInit;
      const body = JSON.parse(init.body as string) as { messages: { content: string }[] };
      expect(body.messages[0]!.content).toContain('"pendingIntent":{"type":"swap_exact_in"');
      expect(body.messages.map((m) => m.content)).toContain('Make it $30');
    } finally {
      await app.close();
    }
  });

  it('persists a friendly failure card when 0G is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 502 })),
    );
    const app = await createTestApp(zgEnv, { mcp: stubMcp() });
    try {
      const login = await devSignIn(app, uniqueName('agent-fail'));
      const { agentRequestId, traceId } = await send(app, login.token, 'Swap $20 ETH to USDC');
      expect(
        (await app.deps.prisma.agentRequest.findUnique({ where: { id: agentRequestId } }))?.status,
      ).toBe('FAILED');
      const agent = await app.deps.prisma.chatMessage.findFirst({
        where: { requestId: agentRequestId, role: 'AGENT' },
      });
      expect(agent?.text).toBe('0G is unavailable. Please try again.');
      expect(agent?.cards).toEqual([
        { type: 'info', title: 'Planning failed', body: '0G is unavailable. Please try again.' },
      ]);
      const inferences = await app.deps.prisma.inference.findMany({ where: { agentRequestId } });
      expect(inferences.map((i) => i.model).sort()).toEqual(['test-fallback', 'test-planner']);
      const events = await app.deps.prisma.traceEventRow.findMany({ where: { traceId } });
      expect(events.some((e) => e.kind === 'error')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('limits each human to 10 messages per minute', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => plannerReply('answer', { text: 'Hi!' })),
    );
    const app = await createTestApp(zgEnv, { mcp: stubMcp() });
    try {
      const login = await devSignIn(app, uniqueName('agent-rate'));
      for (let i = 0; i < 10; i++) await send(app, login.token, `hello ${i}`);
      const limited = await app.inject({
        method: 'POST',
        url: '/agent/messages',
        headers: { authorization: `Bearer ${login.token}` },
        payload: { text: 'one more' },
      });
      expect(limited.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});
