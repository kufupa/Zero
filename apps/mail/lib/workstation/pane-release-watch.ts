/**
 * Stale-build check for the Outlook pane. nginx answers PANE_RELEASE_URL with the
 * release id of the candidate that serves it (see nginx.conf). A pane that loaded
 * an older release reloads once it is idle, so staff pick up fixes without
 * re-installing the add-in.
 */
export const PANE_RELEASE_URL = '/pane-version.json';
export const PANE_RELEASE_POLL_MS = 5 * 60 * 1000;
export const PANE_RELOAD_GAP_MS = 10 * 60 * 1000;
export const PANE_RELOAD_GUARD_KEY = 'nava_pane_auto_reload_at';

const RELEASE_ID = /^[0-9a-f]{64}$/;

/** Served release id, or null for any failure (offline, dev server, bad body). Never throws. */
export async function fetchPaneRelease(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(PANE_RELEASE_URL, { cache: 'no-store' });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const release =
      typeof body === 'object' && body !== null ? (body as { release?: unknown }).release : undefined;
    return typeof release === 'string' && RELEASE_ID.test(release) ? release : null;
  } catch {
    return null;
  }
}

export type PaneReloadGuard = {
  readAt(): number | null;
  /** False when the time could not be recorded; the caller must then not reload. */
  writeAt(at: number): boolean;
};

/** sessionStorage survives the reload it guards, so a reload loop cannot restart it. */
export function sessionPaneReloadGuard(
  storage: Storage | undefined = typeof sessionStorage === 'undefined' ? undefined : sessionStorage,
): PaneReloadGuard {
  return {
    readAt() {
      try {
        const raw = storage?.getItem(PANE_RELOAD_GUARD_KEY);
        const at = raw === null || raw === undefined ? NaN : Number(raw);
        return Number.isFinite(at) ? at : null;
      } catch {
        return null;
      }
    },
    writeAt(at) {
      try {
        storage?.setItem(PANE_RELOAD_GUARD_KEY, String(at));
        return storage !== undefined;
      } catch {
        return false;
      }
    },
  };
}

export type PaneReleaseWatchOptions = {
  fetchRelease: () => Promise<string | null>;
  /** True while staff work would be lost by a reload (in-flight mutation or unsent edits). */
  isBusy: () => boolean;
  reload: () => void;
  guard: PaneReloadGuard;
  now?: () => number;
  /** Called once with the release this page was loaded from. */
  onLoaded?: (release: string) => void;
};

export type PaneReleaseWatch = {
  /** One check: sets the loaded release on first success, otherwise reloads when newer and idle. */
  check(): Promise<void>;
};

export function createPaneReleaseWatch(options: PaneReleaseWatchOptions): PaneReleaseWatch {
  const now = options.now ?? Date.now;
  let loaded: string | null = null;
  let inFlight: Promise<void> | null = null;

  async function runCheck(): Promise<void> {
    const served = await options.fetchRelease();
    // Silent on failure: nothing to show and nothing to act on until a later check succeeds.
    if (served === null) return;
    if (loaded === null) {
      loaded = served;
      options.onLoaded?.(served);
      return;
    }
    if (served === loaded || options.isBusy()) return;
    const lastReloadAt = options.guard.readAt();
    if (lastReloadAt !== null && now() - lastReloadAt < PANE_RELOAD_GAP_MS) return;
    if (!options.guard.writeAt(now())) return;
    options.reload();
  }

  return {
    check() {
      if (!inFlight) {
        // Best effort: a failed check must never surface as an unhandled rejection.
        inFlight = runCheck()
          .catch(() => undefined)
          .finally(() => {
            inFlight = null;
          });
      }
      return inFlight;
    },
  };
}
