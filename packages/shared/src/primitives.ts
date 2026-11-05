import { z } from 'zod';

/** Non-negative decimal number encoded as a string, e.g. "20", "0.015". Never a JS number. */
export const DecimalStringSchema = z
  .string()
  .trim()
  .regex(/^(0|[1-9]\d*)(\.\d+)?$/, 'Must be a non-negative decimal number string');
export type DecimalString = z.infer<typeof DecimalStringSchema>;

/** 0x-prefixed 20-byte hex address (checksum is validated/normalised server-side with viem). */
export const AddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a 0x-prefixed 20-byte address')
  .transform((v) => v as `0x${string}`);
export type Address = `0x${string}`;

export const HexHashSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, 'Must be a 0x-prefixed 32-byte hash')
  .transform((v) => v as `0x${string}`);

export const IsoDateTimeSchema = z.string().datetime({ offset: true });

/** Percentage 0–100 (inclusive). */
export const PercentSchema = z.number().min(0).max(100);
