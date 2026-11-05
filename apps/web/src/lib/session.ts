/**
 * Session token store: memory first, mirrored to localStorage (`warden.session`)
 * so a reload keeps the user signed in. Tabs stay in sync via the storage event.
 */
export const SESSION_STORAGE_KEY = 'warden.session';

export interface StoredSession {
  token: string;
  expiresAt: string;
}

type Listener = (session: StoredSession | null) => void;

function isValid(value: unknown): value is StoredSession {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.token === 'string' &&
    v.token.length > 0 &&
    typeof v.expiresAt === 'string' &&
    Date.parse(v.expiresAt) > Date.now()
  );
}

export function parseStoredSession(raw: string | null): StoredSession | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

class SessionStore {
  private current: StoredSession | null;
  private readonly listeners = new Set<Listener>();

  constructor() {
    this.current = parseStoredSession(safeStorage()?.getItem(SESSION_STORAGE_KEY) ?? null);
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key !== SESSION_STORAGE_KEY) return;
        this.current = parseStoredSession(e.newValue);
        this.notify();
      });
    }
  }

  get(): StoredSession | null {
    if (this.current && Date.parse(this.current.expiresAt) <= Date.now()) {
      this.clear();
    }
    return this.current;
  }

  token(): string | null {
    return this.get()?.token ?? null;
  }

  set(session: StoredSession): void {
    this.current = session;
    try {
      safeStorage()?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch {
      // Storage may be unavailable (private mode); the in-memory session still works.
    }
    this.notify();
  }

  clear(): void {
    if (this.current === null) return;
    this.current = null;
    try {
      safeStorage()?.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // ignore
    }
    this.notify();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l(this.current);
  }
}

export const session = new SessionStore();
