/**
 * Inline-button tokens (PHASE 08 §4). Telegram echoes callback data from the client, so it is
 * treated as untrusted: `a:<suggestionId>:<mac>` is HMAC-signed with a key derived from
 * ENCRYPTION_KEY and must fit Telegram's 64 bytes. The bot still checks the clicking chat.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type CallbackAction = 'yes' | 'change' | 'no';

const CODE: Record<CallbackAction, string> = { yes: 'y', change: 'c', no: 'n' };
const ACTION: Record<string, CallbackAction> = { y: 'yes', c: 'change', n: 'no' };
const MAC_CHARS = 22;

const keyOf = (secret: string) =>
  createHmac('sha256', secret).update('warden-telegram-callback-v1').digest();

const macOf = (secret: string, body: string) =>
  createHmac('sha256', keyOf(secret)).update(body).digest('base64url').slice(0, MAC_CHARS);

export function signCallback(secret: string, action: CallbackAction, suggestionId: string): string {
  const body = `${CODE[action]}:${suggestionId}`;
  return `${body}:${macOf(secret, body)}`;
}

export function verifyCallback(
  secret: string,
  data: string,
): { action: CallbackAction; suggestionId: string } | null {
  const [code, suggestionId, mac, ...rest] = data.split(':');
  if (!code || !suggestionId || !mac || rest.length) return null;
  const action = ACTION[code];
  if (!action) return null;
  const expected = Buffer.from(macOf(secret, `${code}:${suggestionId}`));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { action, suggestionId };
}
