/**
 * Typed application error. Every refusal and failure carries a human-readable
 * `userMessage`; `details` must never contain secrets.
 */
export const ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'SESSION_EXPIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PROVIDER_DISABLED',
  'SERVICE_UNAVAILABLE',
  'WALLET_PROVIDER_ERROR',
  'MARKET_DATA_UNAVAILABLE',
  'ONBOARDING_OUT_OF_ORDER',
  'STEP_UP_REQUIRED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class AppError extends Error {
  override name = 'AppError';

  constructor(
    public readonly code: ErrorCode,
    public readonly httpStatus: number,
    public readonly userMessage: string,
    public readonly details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(userMessage, options);
  }

  static unauthorized(message = 'Please sign in to continue.'): AppError {
    return new AppError('UNAUTHORIZED', 401, message);
  }

  static notFound(message = 'Not found.'): AppError {
    return new AppError('NOT_FOUND', 404, message);
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError('BAD_REQUEST', 400, message, details);
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
