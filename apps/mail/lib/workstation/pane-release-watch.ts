/**
 * Stale-build check for the Outlook pane. The page knows the build it was served: root.tsx
 * writes it into index.html as <meta name="nava-pane-build">, and the page reads it at load.
 * nginx answers PANE_VERSION_URL with the release it serves, and that release's build id.
 * When the served build differs from the loaded one, the page reloads once it is idle, so
 * staff pick up fixes without re-installing the add-in.
 *
 * The loaded identity is never taken from a fetch. A pane that loaded before a deploy stays
 * stale whether or not its first check ever succeeded.
 */
export const PANE_VERSION_URL = '/pane-version.json';
export const PANE_BUILD_META = 'nava-pane-build';
export const PANE_RELEASE_POLL_MS = 5 * 60 * 1000;
export const PANE_RELOAD_GAP_MS = 10 * 60 * 1000;
export const PANE_RELOAD_GUARD_KEY = 'nava_pane_auto_reload_at';

const RELEASE_ID = /^[0-9a-f]{64}$/;
const BUILD_ID = /^[A-Za-z0-9._-]{8,64}$/;

export type PaneVersion = { release: string; build: string };

/** The build this page was served, from its own index.html meta. Null when the meta is absent (dev, tests). */
export function loadedPaneBuild(
  doc: Document | null = typeof document === 'undefined' ? null : document,
): string | null {
  try {
    const content = doc?.querySelector(`meta[name="${PANE_BUILD_META}"]`)?.getAttribute('content');
    return typeof content === 'string' && BUILD_ID.test(content) ? content : null;
  } catch {
    return null;
  }
}

/** The release nginx serves now, or null for any failure (offline, dev server, bad body). Never throws. */
export async function fetchPaneVersion(fetchImpl: typeof fetch = fetch): Promise<PaneVersion | null> {
  try {
    const response = await fetchImpl(PANE_VERSION_URL, { cache: 'no-store' });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;
    const { release, build } = body as { release?: unknown; build?: unknown };
    if (typeof release !== 'string' || !RELEASE_ID.test(release)) return null;
    if (typeof build !== 'string' || !BUILD_ID.test(build)) return null;
    return { release, build };
  } catch {
    return null;
  }
}

export type PaneReloadGuard = {
  /** False when the reload limit cannot survive a reload. Auto-reload is then off for this page. */
  readonly persistent: boolean;
  readAt(): number | null;
  /** Records a reload. False when it could not be recorded, and the caller must not reload. */
  writeAt(at: number): boolean;
};

/**
 * sessionStorage survives the reload it guards, so the 10-minute limit holds across it.
 * WebViews can block storage, or make even reading it throw. An in-memory record would
 * reset on the reload it guards, so in that case the guard is not persistent and the pane
 * never reloads itself.
 */
export function sessionPaneReloadGuard(): PaneReloadGuard {
  let storage: Storage | null = null;
  try {
    storage = typeof sessionStorage === 'undefined' ? null : sessionStorage;
    // Probe: reading throws when storage is blocked.
    storage?.getItem(PANE_RELOAD_GUARD_KEY);
  } catch {
    storage = null;
  }
  return {
    persistent: storage !== null,
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
        return storage !== null;
      } catch {
        return false;
      }
    },
  };
}

export type PaneReleaseWatchOptions = {
  /** The build this page runs, captured at page load. Never taken from a fetch. */
  loadedBuild: string;
  fetchServed: () => Promise<PaneVersion | null>;
  /** True while staff work would be lost by a reload (in-flight mutation or unsent edits). */
  isBusy: () => boolean;
  reload: () => void;
  guard: PaneReloadGuard;
  now?: () => number;
  /** Called when a different build is served but auto-reload is off, so staff can reopen the pane. */
  onNewerRelease?: (served: PaneVersion) => void;
};

export type PaneReleaseWatch = {
  /** One check: reloads when the served build differs from the loaded one, the pane is idle, and the limit allows. */
  check(): Promise<void>;
};

export function createPaneReleaseWatch(options: PaneReleaseWatchOptions): PaneReleaseWatch {
  const now = options.now ?? Date.now;
  let inFlight: Promise<void> | null = null;

  async function runCheck(): Promise<void> {
    const served = await options.fetchServed();
    // Silent on failure. The loaded build is known from the page, so a missed check only delays the reload.
    if (served === null || served.build === options.loadedBuild) return;
    if (!options.guard.persistent) {
      options.onNewerRelease?.(served);
      return;
    }
    if (options.isBusy()) return;
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
