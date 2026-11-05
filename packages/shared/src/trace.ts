/**
 * Trace events: every step of the agent pipeline is emitted as a TraceEvent,
 * persisted, and streamed to the UI over SSE.
 */
import { z } from 'zod';
import { IsoDateTimeSchema } from './primitives.js';

export const TRACE_KINDS = [
  'system',
  'plan',
  'tool_call',
  'tool_result',
  'score',
  'simulation',
  'guard',
  'policy',
  'approval',
  'tx',
  'receipt',
  'log',
  'error',
  'detector',
] as const;
export const TraceKindSchema = z.enum(TRACE_KINDS);
export type TraceKind = z.infer<typeof TraceKindSchema>;

export const ZG_TRUST_MODES = ['private', 'verified'] as const;
export const ZgTrustModeSchema = z.enum(ZG_TRUST_MODES);
export type ZgTrustMode = z.infer<typeof ZgTrustModeSchema>;

/** 0G inference provenance attached to events produced by a 0G model call. */
export const ZgProvenanceSchema = z.object({
  requestId: z.string().min(1),
  clientRequestId: z.string().min(1),
  model: z.string().min(1),
  trustMode: ZgTrustModeSchema,
  teeVerified: z.boolean().optional(),
  provider: z.string().optional(),
});
export type ZgProvenance = z.infer<typeof ZgProvenanceSchema>;

const traceEventBase = {
  id: z.string().min(1),
  traceId: z.string().min(1),
  userId: z.string().min(1),
  ts: IsoDateTimeSchema,
  title: z.string().min(1).max(200),
  detail: z.string().max(4000).optional(),
  data: z.unknown().optional(),
  zg: ZgProvenanceSchema.optional(),
};

/**
 * Discriminated on `kind`. Every kind currently shares the same envelope; later
 * phases may narrow `data` per kind without changing the wire format.
 */
export const TraceEventSchema = z.discriminatedUnion(
  'kind',
  TRACE_KINDS.map((kind) => z.object({ ...traceEventBase, kind: z.literal(kind) })) as unknown as [
    z.ZodObject<typeof traceEventBase & { kind: z.ZodLiteral<TraceKind> }>,
    ...z.ZodObject<typeof traceEventBase & { kind: z.ZodLiteral<TraceKind> }>[],
  ],
);

export type TraceEvent = {
  [K in TraceKind]: {
    id: string;
    traceId: string;
    userId: string;
    ts: string;
    kind: K;
    title: string;
    detail?: string;
    data?: unknown;
    zg?: ZgProvenance;
  };
}[TraceKind];

/** Input accepted by the trace bus — ids and timestamp are assigned by the server. */
export type TraceEventInput = TraceEvent extends infer E
  ? E extends TraceEvent
    ? Omit<E, 'id' | 'ts'> & { id?: string; ts?: string }
    : never
  : never;

/** Validate an unknown value (e.g. from Redis or the network) as a TraceEvent. */
export function parseTraceEvent(value: unknown): TraceEvent {
  return TraceEventSchema.parse(value) as TraceEvent;
}

/** Number of recent events replayed to a client when it (re)connects. */
export const TRACE_REPLAY_LIMIT = 50;

export function traceChannel(userId: string): string {
  return `trace:${userId}`;
}
