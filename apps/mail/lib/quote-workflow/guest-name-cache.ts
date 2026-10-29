const PREFIX = 'nava.guest-name.v1:';
const memory = new Map<string, string | null>();
const revisions = new Map<string, number>();
const listeners = new Set<() => void>();

export function subscribeStayingGuestName(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function guestNameRevision(key: string): number {
  return revisions.get(key) ?? 0;
}

export function rememberGuestName(key: string, name: string): void {
  if (!key) return;
  revisions.set(key, guestNameRevision(key) + 1);
  memory.set(key, name);
  try {
    sessionStorage.setItem(`${PREFIX}${key}`, name);
  } catch {
    // In-memory copy still covers a switch while the pane stays mounted.
  }
  listeners.forEach((listener) => listener());
}

/** Clear only the value present when staff requested a discard, never a later edit. */
export function forgetGuestName(key: string, expectedRevision: number): boolean {
  if (!key || guestNameRevision(key) !== expectedRevision) return false;
  try {
    sessionStorage.removeItem(`${PREFIX}${key}`);
  } catch {
    // If removal failed, a later reload could bring back the old value. Keep it visible instead.
    return false;
  }
  revisions.set(key, expectedRevision + 1);
  memory.set(key, null);
  listeners.forEach((listener) => listener());
  return true;
}

export function recalledGuestName(key: string): string | null {
  if (!key) return null;
  if (memory.has(key)) return memory.get(key) ?? null;
  try {
    const stored = sessionStorage.getItem(`${PREFIX}${key}`);
    if (stored === null) return null;
    memory.set(key, stored);
    return stored;
  } catch {
    return null;
  }
}

export function resetGuestNameCacheForTests(options?: { keepSession?: boolean }): void {
  memory.clear();
  revisions.clear();
  if (options?.keepSession) return;
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {
    // Tests without sessionStorage still clear the in-memory cache.
  }
}
