/**
 * Singleton client for the Uniswap agent MCP server (streamable HTTP, bearer token).
 *
 * `callTool(name, args, { traceId, userId })`:
 *   - validates the arguments with the shared tool input schema (fails fast, no network)
 *   - emits a `tool_call` trace event ("Uniswap · get_quote")
 *   - calls the tool, reconnecting once if the transport/session dropped
 *   - validates `structuredContent` with the shared output schema (and BuildResult consistency)
 *   - emits a `tool_result` trace event with the server's one-line summary
 * Tool errors become `McpToolCallError { code, retryable }`. The server never signs; neither
 * does this client — it only forwards unsigned transactions to the safety pipeline.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UniswapMcp, type TraceEventInput } from '@warden/shared';
import type { FastifyBaseLogger } from 'fastify';

type ToolName = UniswapMcp.ToolName;

export interface TraceEmitter {
  emit(input: TraceEventInput): Promise<unknown>;
}

export interface McpCallContext {
  traceId: string;
  userId: string;
  /**
   * Skip the tool_call/tool_result trace events. For background reads (balance watcher,
   * portfolio polling, reference prices) that would otherwise flood the live activity feed.
   */
  quiet?: boolean;
}

/** The subset of the MCP SDK Client we use (lets tests inject a stub). */
export interface McpClientLike {
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{
    isError?: boolean;
    content?: unknown;
    structuredContent?: Record<string, unknown>;
  }>;
  close(): Promise<void>;
}

export interface UniswapMcpClientOptions {
  url: string;
  token: string;
  trace?: TraceEmitter;
  log: Pick<FastifyBaseLogger, 'warn' | 'debug'>;
  /** Override how a connected client is created (tests). */
  connect?: () => Promise<McpClientLike>;
}

export class McpToolCallError extends Error {
  override name = 'McpToolCallError';
  constructor(
    readonly tool: ToolName,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const TRACE_DETAIL_MAX = 3_900;

function firstText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const first = content[0] as { type?: string; text?: string } | undefined;
  return first?.type === 'text' && typeof first.text === 'string' ? first.text : '';
}

/** Parse the server's tool error envelope `{"error":{code,message,retryable}}` (or SDK text). */
export function parseToolError(tool: ToolName, content: unknown): McpToolCallError {
  const text = firstText(content);
  try {
    const parsed = UniswapMcp.ToolErrorEnvelopeSchema.parse(JSON.parse(text));
    return new McpToolCallError(
      tool,
      parsed.error.code,
      parsed.error.message,
      parsed.error.retryable,
    );
  } catch {
    // SDK-level failures (e.g. "Input validation error: …") are plain text.
    const code = /Input validation error/i.test(text) ? 'INVALID_INPUT' : 'INTERNAL';
    return new McpToolCallError(tool, code, text || 'Unknown MCP tool error', false);
  }
}

export class UniswapMcpClient {
  private client: McpClientLike | null = null;
  private connecting: Promise<McpClientLike> | null = null;
  private closed = false;

  constructor(private readonly options: UniswapMcpClientOptions) {}

  private connect(): Promise<McpClientLike> {
    if (this.closed) return Promise.reject(new Error('MCP client is closed'));
    if (this.client) return Promise.resolve(this.client);
    if (!this.connecting) {
      const create =
        this.options.connect ??
        (async () => {
          const client = new Client({ name: 'warden-api', version: '0.1.0' });
          await client.connect(
            new StreamableHTTPClientTransport(new URL(this.options.url), {
              requestInit: { headers: { authorization: `Bearer ${this.options.token}` } },
              reconnectionOptions: {
                initialReconnectionDelay: 500,
                maxReconnectionDelay: 10_000,
                reconnectionDelayGrowFactor: 2,
                maxRetries: 3,
              },
            }),
          );
          return client as unknown as McpClientLike;
        });
      this.connecting = create()
        .then((client) => {
          this.client = client;
          return client;
        })
        .finally(() => {
          this.connecting = null;
        });
    }
    return this.connecting;
  }

  private async reset(): Promise<void> {
    const old = this.client;
    this.client = null;
    await old?.close().catch(() => undefined);
  }

  private async emit(ctx: McpCallContext, input: TraceEventInput): Promise<void> {
    if (!this.options.trace || ctx.quiet) return;
    try {
      await this.options.trace.emit(input);
    } catch (err) {
      this.options.log.warn({ err }, 'mcp trace emit failed');
    }
  }

  async callTool<N extends ToolName>(
    name: N,
    args: UniswapMcp.ToolInput<N>,
    ctx: McpCallContext,
  ): Promise<UniswapMcp.ToolOutput<N>> {
    const inputSchema = UniswapMcp.TOOL_INPUT_SCHEMAS[name];
    const input = inputSchema.safeParse(args);
    if (!input.success) {
      throw new McpToolCallError(
        name,
        'INVALID_INPUT',
        input.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        false,
      );
    }
    const title = `Uniswap · ${name}`;
    await this.emit(ctx, {
      kind: 'tool_call',
      traceId: ctx.traceId,
      userId: ctx.userId,
      title,
      detail: describeArgs(name, input.data as Record<string, unknown>),
      data: { tool: name, args: redactArgs(input.data as Record<string, unknown>) },
    });

    const started = Date.now();
    let result: Awaited<ReturnType<McpClientLike['callTool']>>;
    try {
      result = await this.invoke(name, input.data as Record<string, unknown>);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.emit(ctx, {
        kind: 'tool_result',
        traceId: ctx.traceId,
        userId: ctx.userId,
        title: `${title} failed`,
        detail: `MCP server unreachable: ${message}`.slice(0, TRACE_DETAIL_MAX),
        data: {
          tool: name,
          ms: Date.now() - started,
          error: { code: 'MCP_UNAVAILABLE', retryable: true },
        },
      });
      throw new McpToolCallError(
        name,
        'MCP_UNAVAILABLE',
        `Uniswap MCP server unreachable: ${message}`,
        true,
      );
    }
    const ms = Date.now() - started;

    if (result.isError) {
      const error = parseToolError(name, result.content);
      await this.emit(ctx, {
        kind: 'tool_result',
        traceId: ctx.traceId,
        userId: ctx.userId,
        title: `${title} failed`,
        detail: `${error.code}: ${error.message}`.slice(0, TRACE_DETAIL_MAX),
        data: { tool: name, ms, error: { code: error.code, retryable: error.retryable } },
      });
      throw error;
    }

    const outputSchema = UniswapMcp.TOOL_OUTPUT_SCHEMAS[name];
    const parsed = outputSchema.safeParse(result.structuredContent);
    const problems = parsed.success
      ? 'status' in (parsed.data as object)
        ? UniswapMcp.checkBuildResult(parsed.data as UniswapMcp.BuildResultObject)
        : []
      : parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`);
    if (!parsed.success || problems.length > 0) {
      const message = `Tool output failed shared-schema validation: ${problems.join('; ')}`;
      await this.emit(ctx, {
        kind: 'tool_result',
        traceId: ctx.traceId,
        userId: ctx.userId,
        title: `${title} failed`,
        detail: message.slice(0, TRACE_DETAIL_MAX),
        data: { tool: name, ms, error: { code: 'INVALID_OUTPUT', retryable: false } },
      });
      throw new McpToolCallError(name, 'INVALID_OUTPUT', message, false);
    }

    await this.emit(ctx, {
      kind: 'tool_result',
      traceId: ctx.traceId,
      userId: ctx.userId,
      title,
      detail: firstText(result.content).slice(0, TRACE_DETAIL_MAX),
      data: { tool: name, ms, output: parsed.data },
    });
    return parsed.data as UniswapMcp.ToolOutput<N>;
  }

  /** Call once; if the transport failed (not a tool error), reconnect and retry once. */
  private async invoke(name: ToolName, args: Record<string, unknown>) {
    try {
      const client = await this.connect();
      return await client.callTool({ name, arguments: args });
    } catch (err) {
      this.options.log.debug({ err, tool: name }, 'mcp call failed, reconnecting once');
      await this.reset();
      const client = await this.connect();
      return await client.callTool({ name, arguments: args });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.reset();
  }
}

/** One-line description of a call for the live trace (no addresses beyond short forms). */
function describeArgs(name: ToolName, args: Record<string, unknown>): string {
  const pick = (k: string) => (args[k] !== undefined ? String(args[k]) : undefined);
  if (name === 'get_quote' || name === 'build_swap') {
    return `${pick('amount')} ${pick('tokenIn')} → ${pick('tokenOut')} (${pick('type')}) on chain ${pick('chainId')}`;
  }
  const parts = ['chainId', 'token', 'tokenA', 'tokenB', 'hookAddress', 'symbol', 'scope', 'kind']
    .map((k) => (args[k] !== undefined ? `${k}=${String(args[k])}` : null))
    .filter(Boolean);
  return parts.join(' ') || name;
}

/** Signatures and resume tokens never go into the trace store. */
function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { signature, resumeToken, ...rest } = args;
  return {
    ...rest,
    ...(signature !== undefined ? { signature: '[redacted]' } : {}),
    ...(resumeToken !== undefined ? { resumeToken: '[redacted]' } : {}),
  };
}

/**
 * The process-wide client: `buildApp` creates exactly one (exposed as `app.deps.mcp`) when
 * MCP_AUTH_TOKEN is set, and closes it on shutdown. It connects lazily on the first call.
 */
export function createUniswapMcpClient(
  env: { MCP_URL: string; MCP_AUTH_TOKEN?: string | undefined },
  deps: { trace: TraceEmitter; log: UniswapMcpClientOptions['log'] },
): UniswapMcpClient | null {
  if (!env.MCP_AUTH_TOKEN) return null;
  return new UniswapMcpClient({
    url: env.MCP_URL,
    token: env.MCP_AUTH_TOKEN,
    trace: deps.trace,
    log: deps.log,
  });
}
