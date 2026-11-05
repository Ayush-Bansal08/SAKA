import type { TraceEvent } from '@warden/shared';
import { createContext, useContext } from 'react';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface TraceStreamValue {
  events: TraceEvent[];
  status: StreamStatus;
  /** True once a frame arrived on this tab's connection. */
  hasReceived: boolean;
}

export const TraceStreamContext = createContext<TraceStreamValue | null>(null);

export function useTraceStream(): TraceStreamValue {
  const ctx = useContext(TraceStreamContext);
  if (!ctx) throw new Error('useTraceStream must be used inside <TraceStreamProvider>');
  return ctx;
}
