/**
 * The API's Uniswap MCP client against the real MCP server (in-process, streamable HTTP,
 * no upstream network: plan_trigger is pure when reference prices are supplied).
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { parseTraceEvent, type TraceEventInput, type UniswapMcp } from '@warden/shared';
import { createDeps, createMcpHttpServer, loadConfig } from 'uniswap-agent-mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  McpToolCallError,
  UniswapMcpClient,
  type McpClientLike,
} from '../src/modules/mcp/client.js';
import { createTestApp } from './helpers.js';

const TOKEN = 'api-test-mcp-token-0123456789abcdef';
const ctx = { traceId: 'trace-1', userId: 'user-1' };
const silent = { warn: () => undefined, debug: () => undefined };

function traceSink() {
  const events: TraceEventInput[] = [];
  return {
    events,
    async emit(input: TraceEventInput) {
      // Same validation the real TraceBus applies.
      parseTraceEvent({ ...input, id: `e${events.length}`, ts: new Date().toISOString() });
      events.push(input);
    },
  };
}

type PlanArgs = UniswapMcp.ToolInput<'plan_trigger'>;

const alert: PlanArgs = {
  kind: 'TAKE_PROFIT',
  condition: { type: 'price_change_pct', symbol: 'ETH', pct: 2, from: 'now' },
  actions: [{ type: 'swap_exact_in', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: '50%' }],
  referencePricesUsd: { ETH: '3247.45' },
};

describe('UniswapMcpClient ↔ uniswap-agent-mcp over streamable HTTP', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      UNISWAP_API_KEY: 'unused-in-this-test',
      EXECUTION_RPC_URL: 'http://127.0.0.1:1',
      MAINNET_RPC_URL: 'http://127.0.0.1:1',
      MCP_RESUME_SECRET: 'r'.repeat(40),
      LOG_LEVEL: 'silent',
    });
    const deps = createDeps(config, {
      fetch: async () => new Response('{"errorCode":"NoNetworkInTests"}', { status: 599 }),
      readers: {},
      sleep: async () => undefined,
    });
    server = createMcpHttpServer({ deps, authToken: TOKEN, rateLimitPerMinute: 1000 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('calls a tool, validates the output with the shared schema and emits tool_call/tool_result', async () => {
    const trace = traceSink();
    const client = new UniswapMcpClient({ url, token: TOKEN, trace, log: silent });
    const out = await client.callTool('plan_trigger', alert, ctx);
    expect(out.humanSummary).toBe('Sell 50% of your ETH for USDC when ETH ≥ $3,312.40 (+2%)');
    expect(out.spec.condition.targetPriceUsd).toBe('3312.40');
    expect(trace.events.map((e) => [e.kind, e.title])).toEqual([
      ['tool_call', 'Uniswap · plan_trigger'],
      ['tool_result', 'Uniswap · plan_trigger'],
    ]);
    expect(trace.events[1]!.detail).toContain('Sell 50% of your ETH');
    expect(trace.events.every((e) => e.traceId === 'trace-1' && e.userId === 'user-1')).toBe(true);
    await client.close();
  });

  it('maps tool errors to McpToolCallError and traces the failure', async () => {
    const trace = traceSink();
    const client = new UniswapMcpClient({ url, token: TOKEN, trace, log: silent });
    const bad: PlanArgs = {
      ...alert,
      condition: { type: 'price_below', symbol: 'ETH', priceUsd: '2000' },
    };
    const err = await client.callTool('plan_trigger', bad, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolCallError);
    expect(err).toMatchObject({ code: 'INVALID_INPUT', retryable: false, tool: 'plan_trigger' });
    expect(trace.events.at(-1)).toMatchObject({
      kind: 'tool_result',
      title: 'Uniswap · plan_trigger failed',
    });
    await client.close();
  });

  it('rejects invalid arguments before any network call', async () => {
    const trace = traceSink();
    let connected = false;
    const client = new UniswapMcpClient({
      url,
      token: TOKEN,
      trace,
      log: silent,
      connect: async () => {
        connected = true;
        throw new Error('should not connect');
      },
    });
    const err = await client
      .callTool('get_quote', { chainId: 1 } as never, ctx)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'INVALID_INPUT' });
    expect(connected).toBe(false);
    expect(trace.events).toEqual([]);
  });

  it('reports an unreachable or unauthorized server as MCP_UNAVAILABLE (retryable)', async () => {
    const client = new UniswapMcpClient({
      url,
      token: 'wrong-token-wrong-token-wrong',
      log: silent,
    });
    const err = await client.callTool('plan_trigger', alert, ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'MCP_UNAVAILABLE', retryable: true });
    await client.close();
  });
});

describe('UniswapMcpClient (stubbed transport)', () => {
  const ok = {
    content: [{ type: 'text', text: 'Alert me when ETH ≥ $4,000.00.' }],
    structuredContent: {
      spec: {
        kind: 'PRICE_ALERT',
        condition: {
          type: 'price_above',
          symbol: 'ETH',
          targetPriceUsd: '4000',
          referencePriceUsd: null,
          changePct: null,
          every: null,
          atLocalTime: null,
          dayOfWeek: null,
        },
        actions: [],
      },
      humanSummary: 'Alert me when ETH ≥ $4,000.00',
      warnings: [],
    },
  };
  const args: PlanArgs = {
    kind: 'PRICE_ALERT',
    condition: { type: 'price_above', symbol: 'ETH', priceUsd: '4000' },
    actions: [],
  };

  it('reconnects once when the transport fails', async () => {
    let connects = 0;
    const client = new UniswapMcpClient({
      url: 'http://unused',
      token: TOKEN,
      log: silent,
      connect: async () => {
        connects += 1;
        const attempt = connects;
        return {
          callTool: async () => {
            if (attempt === 1) throw new Error('socket hang up');
            return ok;
          },
          close: async () => undefined,
        } satisfies McpClientLike;
      },
    });
    const out = await client.callTool('plan_trigger', args, ctx);
    expect(out.humanSummary).toBe('Alert me when ETH ≥ $4,000.00');
    expect(connects).toBe(2);
  });

  it('rejects output that does not match the shared schema', async () => {
    const trace = traceSink();
    const client = new UniswapMcpClient({
      url: 'http://unused',
      token: TOKEN,
      trace,
      log: silent,
      connect: async () => ({
        callTool: async () => ({ ...ok, structuredContent: { humanSummary: 42 } }),
        close: async () => undefined,
      }),
    });
    const err = await client.callTool('plan_trigger', args, ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'INVALID_OUTPUT', retryable: false });
    expect(trace.events.at(-1)?.title).toBe('Uniswap · plan_trigger failed');
  });

  it('redacts signatures and resume tokens from traces', async () => {
    const trace = traceSink();
    const client = new UniswapMcpClient({
      url: 'http://unused',
      token: TOKEN,
      trace,
      log: silent,
      connect: async () => ({
        callTool: async () => ({
          isError: true,
          content: [
            {
              type: 'text',
              text: '{"error":{"code":"RESUME_TOKEN_EXPIRED","message":"expired","retryable":true}}',
            },
          ],
        }),
        close: async () => undefined,
      }),
    });
    const err = await client
      .callTool(
        'build_swap',
        {
          chainId: 11155111,
          swapper: '0xC9bebBA9f481b12cE6f3EA54c4B182c9636ec421',
          tokenIn: 'USDC',
          tokenOut: 'ETH',
          amount: '20',
          type: 'EXACT_INPUT',
          slippagePct: 0.5,
          resumeToken: 'abcdefghijklmnop.qrstuvwxyz012345',
          signature: `0x${'ab'.repeat(65)}`,
        },
        ctx,
      )
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'RESUME_TOKEN_EXPIRED', retryable: true });
    const data = trace.events[0]!.data as { args: Record<string, unknown> };
    expect(data.args.signature).toBe('[redacted]');
    expect(data.args.resumeToken).toBe('[redacted]');
  });
});

describe('buildApp wiring', () => {
  it('exposes deps.mcp only when MCP_AUTH_TOKEN is configured (lazy: no connection at boot)', async () => {
    const without = await createTestApp();
    expect(without.deps.mcp).toBeNull();
    await without.close();
    const withToken = await createTestApp({
      MCP_AUTH_TOKEN: TOKEN,
      MCP_URL: 'http://127.0.0.1:1/mcp',
    });
    expect(withToken.deps.mcp).toBeInstanceOf(UniswapMcpClient);
    expect(withToken.deps.env.MCP_URL).toBe('http://127.0.0.1:1/mcp');
    await withToken.close();
  });
});
