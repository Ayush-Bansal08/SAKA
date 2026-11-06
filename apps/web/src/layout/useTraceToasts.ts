/**
 * Toasts for executed / refused / approval-needed when the human is not in the chat
 * (PHASE 06 §5), and for RED alerts wherever they are (PHASE 08 §3). Only events that arrive
 * after mount; replayed history never toasts.
 */
import type { TraceEvent } from '@warden/shared';
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useTraceStream } from '@/features/trace/trace-context';

export type ToastKind = 'executed' | 'refused' | 'approval' | 'red' | null;

export function toastKind(e: TraceEvent): ToastKind {
  if (e.kind === 'receipt' && e.title.startsWith('Done')) return 'executed';
  if (e.kind === 'policy' && e.title === 'Policy: refused') return 'refused';
  if (e.kind === 'approval' && e.title === 'Waiting for your approval') return 'approval';
  if (e.kind === 'detector' && (e.data as { severity?: unknown })?.severity === 'RED') return 'red';
  return null;
}

export function useTraceToasts(): void {
  const { events } = useTraceStream();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const seen = useRef<Set<string> | null>(null);
  const inChat = pathname === '/ask';

  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(events.map((e) => e.id));
      return;
    }
    for (const e of events) {
      if (seen.current.has(e.id)) continue;
      seen.current.add(e.id);
      const kind = toastKind(e);
      if (kind === 'red') {
        toast.error(e.title, {
          description: e.detail?.slice(0, 140),
          action: { label: 'Open Autopilot', onClick: () => void navigate('/autopilot') },
        });
        continue;
      }
      if (inChat) continue;
      if (kind === 'executed')
        toast.success(e.title, { description: 'Receipt and 0G proof are in your activity.' });
      else if (kind === 'refused')
        toast.error('Your agent refused an action', {
          description: e.detail?.slice(0, 140),
          action: { label: 'Why?', onClick: () => void navigate('/activity') },
        });
      else if (kind === 'approval')
        toast.warning('Your agent needs your approval', {
          description: e.detail?.slice(0, 140),
          action: { label: 'Review', onClick: () => void navigate('/autopilot') },
        });
    }
  }, [events, inChat, navigate]);
}
