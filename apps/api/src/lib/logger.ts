import { pino, type LoggerOptions } from 'pino';
import type { Env } from '../config/env.js';

/**
 * The single redaction list for every log line (PHASE_00 §11). Add new secret
 * field names here — never log keys, tokens, PKCE verifiers, device codes,
 * signatures or session tokens.
 */
export const REDACT_PATHS = [
  'env.ZG_API_KEY',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-admin-token"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers["x-api-key"]',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.idToken',
  '*.sessionToken',
  '*.password',
  '*.secret',
  '*.apiKey',
  '*.privateKey',
  '*.signature',
  '*.resumeToken',
  '*.pkceVerifier',
  '*.codeVerifier',
  '*.deviceCode',
  '*.encryptionKey',
  'env.ENCRYPTION_KEY',
  'env.ADMIN_TOKEN',
  'env.MCP_AUTH_TOKEN',
  'env.PRIVY_APP_SECRET',
  'env.PRIVY_AUTHORIZATION_PRIVATE_KEY',
  '*.appSecret',
  '*.authorization_private_keys',
  '*.typedData',
  '*.typed_data',
  'err.config.headers',
  'env.DATABASE_URL',
  'env.REDIS_URL',
];

export function loggerOptions(
  env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>,
  name: string,
): LoggerOptions {
  // Human-readable logs in local dev (set LOG_FORMAT=json to keep raw JSON).
  const pretty = env.NODE_ENV === 'development' && process.env.LOG_FORMAT !== 'json';
  return {
    name,
    level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  };
}

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>, name: string) {
  return pino(loggerOptions(env, name));
}

export type Logger = ReturnType<typeof createLogger>;
