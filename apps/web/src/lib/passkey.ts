/** Browser side of passkeys: ask the API for a challenge, sign it on this device, send it back. */
import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { PasskeyOptionsResponseSchema, SignInResponseSchema } from '@warden/shared';
import { z } from 'zod';
import { api, ApiError } from './api';

export async function registerPasskey(displayName: string) {
  const { challengeId, options } = await api('/auth/passkey/register/options', {
    method: 'POST',
    body: { displayName },
    schema: PasskeyOptionsResponseSchema,
    anonymous: true,
  });
  const response = await startRegistration({
    optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
  });
  return api('/auth/passkey/register/verify', {
    method: 'POST',
    body: { challengeId, response },
    schema: SignInResponseSchema,
    anonymous: true,
  });
}

export async function signInWithPasskey() {
  const { challengeId, options } = await api('/auth/passkey/sign-in/options', {
    method: 'POST',
    body: {},
    schema: PasskeyOptionsResponseSchema,
    anonymous: true,
  });
  const response = await startAuthentication({
    optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
  });
  return api('/auth/passkey/sign-in/verify', {
    method: 'POST',
    body: { challengeId, response },
    schema: SignInResponseSchema,
    anonymous: true,
  });
}

export async function approveWithPasskey(approvalId: string) {
  const { challengeId, options } = await api(`/approvals/${approvalId}/passkey/options`, {
    method: 'POST',
    body: {},
    schema: PasskeyOptionsResponseSchema,
  });
  const response = await startAuthentication({
    optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
  });
  return api(`/approvals/${approvalId}/passkey/verify`, {
    method: 'POST',
    body: { challengeId, response },
    schema: z.unknown(),
  });
}

/** Friendly copy for anything a passkey prompt can throw. */
export function passkeyErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.name === 'NotAllowedError') {
    return 'The passkey check was cancelled or timed out.';
  }
  return 'That passkey did not work. Please try again.';
}
