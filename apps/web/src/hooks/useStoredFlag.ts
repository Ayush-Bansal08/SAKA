/**
 * A remembered UI preference. Storage can be blocked or empty, so every access is guarded and the
 * app always works from the default. Components sharing a key stay in step.
 */
import { useCallback, useSyncExternalStore } from 'react';

const listeners = new Map<string, Set<() => void>>();
const memory = new Map<string, boolean>();

function read(key: string, fallback: boolean): boolean {
  const held = memory.get(key);
  if (held !== undefined) return held;
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

function write(key: string, value: boolean): void {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // The in-memory copy above keeps it for this session.
  }
  listeners.get(key)?.forEach((l) => l());
}

export function useStoredFlag(key: string, fallback = false): [boolean, (next: boolean) => void] {
  const subscribe = useCallback(
    (l: () => void) => {
      const set = listeners.get(key) ?? new Set();
      listeners.set(key, set);
      set.add(l);
      return () => void set.delete(l);
    },
    [key],
  );
  const value = useSyncExternalStore(subscribe, () => read(key, fallback));
  const set = useCallback((next: boolean) => write(key, next), [key]);
  return [value, set];
}

/** "Show agent internals": opens technical details by default. Purely a display preference. */
export const useAgentInternals = () => useStoredFlag('saka.agentInternals');
