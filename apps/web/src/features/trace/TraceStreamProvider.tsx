/**
 * One SSE connection per signed-in tab, shared by every view (lives at shell
 * level so navigating never reconnects). Auth uses a Bearer header via
 * @microsoft/fetch-event-source; reconnects with exponential backoff.
 */
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { TraceEventSchema, type TraceEvent } from '@warden/shared';
import { type ReactNode, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { API_URL } from '@/lib/config';
import { session } from '@/lib/session';
import { TraceStreamContext, type StreamStatus } from './trace-context';
import { backoffDelay, mergeEvents } from './trace-utils';

class FatalStreamError extends Error {}
class RetriableStreamError extends Error {}

export function TraceStreamProvider({ token, children }: { token: string; children: ReactNode }) {
  const [events, dispatch] = useReducer(
    (state: TraceEvent[], incoming: TraceEvent[]) => mergeEvents(state, incoming),
    [],
  );
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [hasReceived, setHasReceived] = useState(false);
  const attempt = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    attempt.current = 0;
    setStatus('connecting');

    void fetchEventSource(`${API_URL}/stream`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      signal: controller.signal,
      openWhenHidden: true,
      async onopen(res) {
        const type = res.headers.get('content-type') ?? '';
        if (res.ok && type.includes('text/event-stream')) {
          attempt.current = 0;
          setStatus('live');
          return;
        }
        if (res.status === 401) {
          session.clear();
          throw new FatalStreamError('unauthorized');
        }
        throw new RetriableStreamError(`stream open failed: ${res.status}`);
      },
      onmessage(msg) {
        if (msg.event !== 'trace' || !msg.data) return;
        try {
          const parsed = TraceEventSchema.safeParse(JSON.parse(msg.data));
          if (parsed.success) {
            dispatch([parsed.data as TraceEvent]);
            setHasReceived(true);
          }
        } catch {
          // ignore malformed frames
        }
      },
      onclose() {
        // Server closed the stream (deploy/restart): reconnect.
        throw new RetriableStreamError('closed');
      },
      onerror(err) {
        if (err instanceof FatalStreamError) {
          setStatus('offline');
          throw err; // stop retrying
        }
        setStatus(navigator.onLine === false ? 'offline' : 'reconnecting');
        const delay = backoffDelay(attempt.current);
        attempt.current += 1;
        return delay;
      },
    }).catch(() => {
      // Fatal (e.g. 401) or aborted on unmount — nothing to do.
    });

    return () => controller.abort();
  }, [token]);

  const value = useMemo(() => ({ events, status, hasReceived }), [events, status, hasReceived]);
  return <TraceStreamContext.Provider value={value}>{children}</TraceStreamContext.Provider>;
}
