const PREFIX = 'nava.guest-name.v1:';
const memory = new Map<string, string>();

export function rememberGuestName(key: string, name: string): void {
  if (!key) return;
  memory.set(key, name);
  try {
    sessionStorage.setItem(`${PREFIX}${key}`, name);
  } catch {
    // In-memory copy still covers a switch while the pane stays mounted.
  }
}

export function recalledGuestName(key: string): string | null {
  if (!key) return null;
  const remembered = memory.get(key);
  if (remembered !== undefined) return remembered;
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
