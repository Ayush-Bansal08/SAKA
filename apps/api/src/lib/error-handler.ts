import type { ApiErrorBody } from '@warden/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import { isAppError, type AppError, type ErrorCode } from './errors.js';

interface ValidationEntry {
  instancePath?: string;
  message?: string;
}

function body(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: unknown,
): ApiErrorBody {
  return { error: { code, message, requestId, ...(details !== undefined ? { details } : {}) } };
}

/** Maps every error to `{ error: { code, message, details? } }` without leaking internals. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError | Error, request, reply) => {
    if (isAppError(err)) {
      if (err.httpStatus >= 500) request.log.error({ err }, err.message);
      return reply
        .code(err.httpStatus)
        .send(body(err.code, err.userMessage, request.id, err.details));
    }

    const fastifyErr = err as FastifyError & { validation?: ValidationEntry[] };
    if (fastifyErr.validation) {
      const details = fastifyErr.validation.map((v) => ({
        path: (v.instancePath ?? '').replace(/^\//, '').replace(/\//g, '.') || '(body)',
        message: v.message ?? 'Invalid value',
      }));
      const first = details[0];
      const message = first ? `${first.path}: ${first.message}` : 'Invalid request';
      return reply.code(400).send(body('VALIDATION_ERROR', message, request.id, details));
    }

    const status = fastifyErr.statusCode ?? 500;
    if (status === 429) {
      return reply
        .code(429)
        .send(
          body('RATE_LIMITED', 'Too many requests. Please slow down and try again.', request.id),
        );
    }
    if (status >= 400 && status < 500) {
      // Fastify's own client errors (bad JSON, unsupported media type, body too large) are safe to show.
      return reply.code(status).send(body('BAD_REQUEST', fastifyErr.message, request.id));
    }

    request.log.error({ err }, 'unhandled error');
    return reply
      .code(500)
      .send(body('INTERNAL', 'Something went wrong on our side. Please try again.', request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send(body('NOT_FOUND', `Route ${request.method} ${request.url} not found`, request.id));
  });
}
