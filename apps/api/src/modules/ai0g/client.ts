/**
 * 0G Router adapter (PHASE 04 §1). Every inference — planner, fallback, guard decisions,
 * explainer — goes through `call()`, which:
 *  - sends `X-0G-Provider-Trust-Mode`, our own `X-Client-Request-Id` and `verify_tee: true`;
 *  - reads `X-Request-ID` from the response headers and `x_0g_trace` from the body (or from the
 *    final chunk when streaming — the router sends it as its own `choices: []` chunk before
 *    `[DONE]`) and requires the body ID to appear in the header;
 *  - persists one `Inference` row per HTTP attempt and emits a trace event with the 0G chip;
 *  - retries 429/503 (max 2, honouring Retry-After) inside one deadline, and falls back from the
 *    private planner to `ZG_MODEL_PLANNER_FALLBACK` recorded with `trace.fallbackOf`.
 */
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { z } from 'zod';
import type { PrismaClient, Prisma, InferenceRole } from '@prisma/client';
import type { ZgProvenance, ZgTrustMode } from '@warden/shared';
import type { Env } from '../../config/env.js';
import type { TraceEmitter } from '../mcp/client.js';

export interface CallContext {
  userId: string;
  traceId: string;
  agentRequestId?: string;
}

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

export interface ChatInput extends CallContext {
  role: InferenceRole;
  model: string;
  trustMode: ZgTrustMode;
  messages: ChatMessage[];
  tools?: ChatTool[];
  /** Defaults to `required` when tools are supplied. */
  toolChoice?: 'auto' | 'required';
  responseFormat?: { type: 'json_object' } | { type: 'json_schema'; json_schema: unknown };
  maxTokens: number;
  /** Stream the completion; content and tool calls are re-assembled before returning. */
  stream?: boolean;
  /** PLANNER calls fall back to the fallback model on failure unless this is false. */
  allowFallback?: boolean;
  /** Trace kind of the emitted event (defaults: GUARD → guard, otherwise plan). */
  traceKind?: 'plan' | 'guard';
}

export interface ZgResult {
  data: Record<string, unknown>;
  zg: ZgProvenance;
  inferenceId: string;
}

/** A failed 0G call. `inferenceId` is the persisted row of the last attempt. */
export class ZgError extends Error {
  override name = 'ZgError';
  constructor(
    message: string,
    readonly inferenceId?: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const TraceSchema = z
  .object({
    request_id: z.string().min(1),
    provider: z.string().optional(),
    provider_identity: z.string().optional(),
    tee_verified: z.boolean().optional(),
    billing: z.object({ total_cost: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const EnvelopeSchema = z
  .object({
    x_0g_trace: TraceSchema,
    usage: z
      .object({
        prompt_tokens: z.number().int().optional(),
        completion_tokens: z.number().int().optional(),
        input_tokens: z.number().int().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ChunkSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            delta: z
              .object({
                role: z.string().nullish(),
                content: z.string().nullish(),
                tool_calls: z
                  .array(
                    z.object({
                      index: z.number().int().min(0).max(31).optional(),
                      id: z.string().nullish(),
                      function: z
                        .object({ name: z.string().nullish(), arguments: z.string().nullish() })
                        .nullish(),
                    }),
                  )
                  .nullish(),
              })
              .passthrough()
              .nullish(),
            finish_reason: z.string().nullish(),
          })
          .passthrough(),
      )
      .optional(),
    usage: z.record(z.unknown()).nullish(),
    x_0g_trace: z.unknown().optional(),
  })
  .passthrough();

/** Re-assembles an OpenAI-style chat stream into the non-streaming response shape. */
export async function collectStream(stream: AsyncIterable<unknown>) {
  let content = '';
  let finishReason: string | null = null;
  let usage: Record<string, unknown> | undefined;
  let trace: unknown;
  const calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] =
    [];
  for await (const item of stream) {
    const chunk = ChunkSchema.parse(item);
    if (chunk.x_0g_trace !== undefined) trace = chunk.x_0g_trace;
    if (chunk.usage) usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) continue;
      if (delta.content) content += delta.content;
      for (const part of delta.tool_calls ?? []) {
        const index = part.index ?? 0;
        const slot = (calls[index] ??= {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        });
        if (part.id) slot.id = part.id;
        if (part.function?.name) slot.function.name += part.function.name;
        if (part.function?.arguments) slot.function.arguments += part.function.arguments;
      }
    }
  }
  const toolCalls = calls.filter(Boolean);
  return {
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        message: {
          role: 'assistant',
          content: content || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
    ...(usage ? { usage } : {}),
    ...(trace !== undefined ? { x_0g_trace: trace } : {}),
  };
}

const ROLE_LABEL: Record<InferenceRole, string> = {
  PLANNER: 'planner',
  GUARD: 'guard',
  EXPLAINER: 'explainer',
};

function failureText(failure: unknown): string {
  if (
    failure instanceof OpenAI.APIUserAbortError ||
    failure instanceof OpenAI.APIConnectionTimeoutError
  )
    return '0G request timed out';
  if (failure instanceof OpenAI.APIError && failure.status !== undefined)
    return `0G HTTP ${failure.status} (${failure.code ?? failure.type ?? 'upstream_error'})`;
  if (failure instanceof OpenAI.APIConnectionError) return '0G connection failed';
  return '0G request failed or returned invalid provenance';
}

export class ZgClient {
  private sdk: OpenAI;
  private secrets: string[];

  constructor(
    readonly env: Env,
    private prisma: PrismaClient,
    private trace: TraceEmitter,
    fetch?: typeof globalThis.fetch,
  ) {
    if (!env.ZG_API_KEY) throw new Error('ZG_API_KEY is not configured');
    this.sdk = new OpenAI({
      apiKey: env.ZG_API_KEY,
      baseURL: env.ZG_BASE_URL,
      maxRetries: 0,
      timeout: Math.max(env.ZG_PLANNER_TIMEOUT_MS, env.ZG_REQUEST_TIMEOUT_MS),
      ...(fetch ? { fetch } : {}),
    });
    // Every configured credential (keys, secrets, tokens, private keys). Prompts must never
    // contain any of them.
    this.secrets = Object.entries(env)
      .filter(
        (entry): entry is [string, string] =>
          /KEY|SECRET|TOKEN|PASSWORD/.test(entry[0]) &&
          typeof entry[1] === 'string' &&
          entry[1].length >= 8,
      )
      .map(([, value]) => value);
  }

  model(role: 'PLANNER' | 'PLANNER_FALLBACK' | 'GUARD' | 'EXPLAINER'): string {
    const value = this.env[`ZG_MODEL_${role}`];
    if (!value) throw new Error(`ZG_MODEL_${role} is not configured`);
    return value;
  }

  /** Trust tier for the planner fallback (PHASE_00 §10: verified, overridable per key). */
  get fallbackTrustMode(): ZgTrustMode {
    return this.env.ZG_PLANNER_FALLBACK_TRUST_MODE;
  }

  private assertNoSecrets(body: Record<string, unknown>) {
    const serialized = JSON.stringify(body);
    if (
      this.secrets.some((secret) => serialized.includes(secret)) ||
      /sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(serialized)
    )
      throw new ZgError('Signing material or credentials must not be sent to inference.');
  }

  private async call(
    input: CallContext & {
      role: InferenceRole;
      model: string;
      trustMode: ZgTrustMode;
      traceKind?: 'plan' | 'guard';
    },
    path: string,
    body: Record<string, unknown>,
    options: { timeoutMs: number; stream?: boolean; fallbackOf?: string },
  ): Promise<ZgResult> {
    this.assertNoSecrets(body);
    const label = `${ROLE_LABEL[input.role]}${options.fallbackOf ? ' fallback' : ''}`;
    const deadline = Date.now() + options.timeoutMs;
    for (let attempt = 0; ; attempt++) {
      const clientRequestId = randomUUID();
      const started = Date.now();
      let response: Response | undefined;
      let raw: unknown;
      let failure: unknown;
      // One budget covers the whole attempt, including reading a streamed body.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), Math.max(1, deadline - Date.now()));
      try {
        const result = await this.sdk
          .post<unknown>(path, {
            timeout: Math.max(1, deadline - Date.now()),
            signal: abort.signal,
            body: { ...body, model: input.model, verify_tee: true },
            headers: {
              'X-0G-Provider-Trust-Mode': input.trustMode,
              'X-Client-Request-Id': clientRequestId,
            },
            ...(options.stream ? { stream: true } : {}),
          })
          .withResponse();
        response = result.response;
        raw = options.stream
          ? await collectStream(result.data as AsyncIterable<unknown>)
          : result.data;
      } catch (err) {
        failure = err;
      } finally {
        clearTimeout(timer);
      }

      const parsed = EnvelopeSchema.safeParse(raw);
      const rawHeader =
        response?.headers.get('x-request-id') ??
        (failure instanceof OpenAI.APIError ? failure.headers?.get('x-request-id') : undefined) ??
        undefined;
      // The router may append its own ID to an upstream one: "proxy-id, request-id".
      const headerIds =
        rawHeader
          ?.split(',')
          .map((value: string) => value.trim())
          .filter(Boolean) ?? [];
      const bodyId = parsed.success ? parsed.data.x_0g_trace.request_id : undefined;
      const requestId = bodyId && headerIds.includes(bodyId) ? bodyId : headerIds.at(-1);
      if (!failure && (!bodyId || !headerIds.includes(bodyId)))
        failure = new Error('Invalid 0G provenance');
      const t = parsed.success ? parsed.data.x_0g_trace : undefined;
      const usage = parsed.success ? parsed.data.usage : undefined;
      const latencyMs = Date.now() - started;
      const error = failure ? failureText(failure) : null;

      const record = await this.prisma.inference.create({
        data: {
          ...(input.agentRequestId ? { agentRequestId: input.agentRequestId } : {}),
          role: input.role,
          model: input.model,
          trustMode: input.trustMode,
          clientRequestId,
          zgRequestId: requestId ?? null,
          providerAddress: t?.provider ?? null,
          providerIdentity: t?.provider_identity ?? null,
          teeVerified: t?.tee_verified ?? null,
          latencyMs,
          inputTokens: usage?.prompt_tokens ?? usage?.input_tokens ?? null,
          outputTokens: usage?.completion_tokens ?? null,
          costRaw: t?.billing?.total_cost ?? null,
          trace: {
            ...(t ?? {}),
            responseRequestIdHeader: rawHeader ?? null,
            attempt,
            ...(options.stream ? { streamed: true } : {}),
            ...(options.fallbackOf ? { fallbackOf: options.fallbackOf } : {}),
          } as Prisma.InputJsonObject,
          ok: !failure,
          error,
        },
      });

      const zg: ZgProvenance | undefined = requestId
        ? {
            requestId,
            clientRequestId,
            model: input.model,
            trustMode: input.trustMode,
            ...(t?.provider ? { provider: t.provider } : {}),
            ...(t?.tee_verified !== undefined ? { teeVerified: t.tee_verified } : {}),
          }
        : undefined;
      await this.trace.emit({
        userId: input.userId,
        traceId: input.traceId,
        kind: input.traceKind ?? (input.role === 'GUARD' ? 'guard' : 'plan'),
        title: failure ? `0G ${label} failed` : `0G ${label}`,
        detail: `${input.model} · ${input.trustMode} · ${latencyMs} ms${error ? ` · ${error}` : ''}`,
        data: {
          inferenceId: record.id,
          ok: !failure,
          ...(options.fallbackOf ? { fallbackOf: options.fallbackOf } : {}),
        },
        ...(zg ? { zg } : {}),
      });

      if (!failure && zg)
        return { data: raw as Record<string, unknown>, zg, inferenceId: record.id };

      const status = failure instanceof OpenAI.APIError ? failure.status : undefined;
      if (status !== undefined && [429, 503].includes(status) && attempt < 2) {
        const retryAfter =
          failure instanceof OpenAI.APIError ? failure.headers?.get('retry-after') : null;
        const delay = retryAfter
          ? Number.isFinite(Number(retryAfter))
            ? Number(retryAfter) * 1000
            : Date.parse(retryAfter) - Date.now()
          : 500 * 2 ** attempt;
        const wait = Number.isFinite(delay) ? Math.max(0, delay) : 500 * 2 ** attempt;
        if (wait <= 30_000 && Date.now() + wait < deadline) {
          await new Promise((resolve) => setTimeout(resolve, wait));
          continue;
        }
      }
      throw new ZgError('0G is unavailable. Please try again.', record.id, status);
    }
  }

  async chat(input: ChatInput): Promise<ZgResult> {
    const body: Record<string, unknown> = {
      messages: input.messages,
      max_tokens: input.maxTokens,
      ...(input.tools?.length
        ? { tools: input.tools, tool_choice: input.toolChoice ?? 'required' }
        : {}),
      ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
      ...(this.env.ZG_REASONING_EFFORT !== 'off'
        ? { reasoning_effort: this.env.ZG_REASONING_EFFORT }
        : {}),
      ...(input.stream
        ? { stream: true, stream_options: { include_usage: true } }
        : { stream: false }),
    };
    const timeoutMs =
      input.role === 'PLANNER' ? this.env.ZG_PLANNER_TIMEOUT_MS : this.env.ZG_REQUEST_TIMEOUT_MS;
    const options = { timeoutMs, ...(input.stream ? { stream: true } : {}) };
    try {
      return await this.call(input, '/chat/completions', body, options);
    } catch (error) {
      if (input.role !== 'PLANNER' || input.allowFallback === false) throw error;
      if (error instanceof ZgError && !error.inferenceId) throw error; // refused before sending
      return this.call(
        { ...input, model: this.model('PLANNER_FALLBACK'), trustMode: this.fallbackTrustMode },
        '/chat/completions',
        body,
        {
          ...options,
          ...(error instanceof ZgError && error.inferenceId
            ? { fallbackOf: error.inferenceId }
            : {}),
        },
      );
    }
  }

  /** Vela decisions (`POST /v1/decisions`): typed answers with probabilities, never text. */
  decide(
    input: CallContext & { state: string; questions: Record<string, unknown> },
  ): Promise<ZgResult> {
    return this.call(
      { ...input, role: 'GUARD', model: this.model('GUARD'), trustMode: 'private' },
      '/decisions',
      { state: input.state, questions: input.questions },
      { timeoutMs: this.env.ZG_REQUEST_TIMEOUT_MS },
    );
  }
}
