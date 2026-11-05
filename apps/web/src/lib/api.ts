/**
 * Typed fetch wrapper for the Warden API. Attaches the Bearer session, parses
 * `{ error: { code, message } }` bodies into ApiError, validates responses with
 * Zod, and clears the session on 401 so the app falls back to sign-in.
 */
import { ApiErrorBodySchema } from '@warden/shared';
import type { z } from 'zod';
import { API_URL } from './config';
import { session } from './session';

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }
}

interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>;
  signal?: AbortSignal;
  /** Skip attaching the session token (public endpoints). */
  anonymous?: boolean;
}

export async function api<T>(path: string, options: RequestOptions<T> = {}): Promise<T> {
  const token = options.anonymous ? null : session.token();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', `Can't reach the Warden API at ${API_URL}.`);
  }

  const requestId = res.headers.get('x-request-id') ?? undefined;
  const text = await res.text();
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }

  if (!res.ok) {
    const parsed = ApiErrorBodySchema.safeParse(json);
    const error = parsed.success
      ? new ApiError(
          res.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.requestId ?? requestId,
          parsed.data.error.details,
        )
      : new ApiError(res.status, 'HTTP_ERROR', `Request failed (${res.status}).`, requestId);
    if (res.status === 401 && token) session.clear();
    throw error;
  }

  if (!options.schema) return json as T;
  const parsed = options.schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(
      res.status,
      'BAD_RESPONSE',
      'The API returned an unexpected response.',
      requestId,
      parsed.error.issues,
    );
  }
  return parsed.data;
}
