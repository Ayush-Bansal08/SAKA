/**
 * App-wide "put this in the agent's composer" (PHASE 07: hook cards, LP position actions,
 * rules). Works from any page: the text waits here until the chat panel picks it up, and the
 * shell observes every request so the human is taken to the chat.
 */
type Listener = (text: string) => void;

let pending: string | null = null;
const listeners = new Set<Listener>();
const observers = new Set<Listener>();

export function requestPrefill(text: string): void {
  pending = text;
  for (const l of listeners) l(text);
  for (const o of observers) o(text);
}

/** Told about every request without consuming it. Returns the unsubscribe. */
export function observePrefill(observer: Listener): () => void {
  observers.add(observer);
  return () => void observers.delete(observer);
}

/** The chat panel subscribes; returns the text waiting from before it mounted (once). */
export function subscribePrefill(listener: Listener): {
  initial: string | null;
  unsubscribe: () => void;
} {
  listeners.add(listener);
  const initial = pending;
  pending = null;
  return { initial, unsubscribe: () => listeners.delete(listener) };
}

/** Called after a listener consumed a live prefill. */
export function consumePrefill(): void {
  pending = null;
}
