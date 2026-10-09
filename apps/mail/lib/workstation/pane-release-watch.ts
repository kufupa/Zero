/**
 * Stale-build check for the Outlook pane. The page knows the build it was served: root.tsx writes it
 * into index.html and the page reads it at load. nginx answers PANE_VERSION_URL with the release it
 * serves and that release's build. A different build is pending: the page keeps its content and says
 * so. It reloads only at a safe boundary, never mid-work:
 *   - an email switch: panels reset on switch anyway, so nothing typed is lost;
 *   - PANE_IDLE_RELOAD_MS with no input in the pane, nothing in flight, and no dirty quote session.
 */
export const PANE_VERSION_URL = '/pane-version.json';
export const PANE_BUILD_META = 'nava-pane-build';
export const PANE_RELEASE_POLL_MS = 5 * 60 * 1000;
export const PANE_IDLE_RELOAD_MS = 15 * 60 * 1000;
export const PANE_IDLE_CHECK_MS = 60 * 1000;

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

export type PaneVersionWatchOptions = {
  /** The build this page runs, captured at page load. Never taken from a fetch. */
  loadedBuild: string;
  fetchServed: () => Promise<PaneVersion | null>;
  /** Called with the served version whenever it differs from the loaded build. It never reloads. */
  onPending: (served: PaneVersion) => void;
};

export type PaneVersionWatch = {
  /** One check. Silent on failure. Concurrent calls share one request. */
  check(): Promise<void>;
};

export function createPaneVersionWatch(options: PaneVersionWatchOptions): PaneVersionWatch {
  let inFlight: Promise<void> | null = null;

  async function runCheck(): Promise<void> {
    const served = await options.fetchServed();
    if (served === null || served.build === options.loadedBuild) return;
    options.onPending(served);
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

/** Email switch: a pending build loads before the new email renders, unless a mutation is in flight. */
export function reloadAtEmailSwitch(state: { pending: boolean; mutationsInFlight: number }): boolean {
  return state.pending && state.mutationsInFlight === 0;
}

/** Idle: no input in the pane for PANE_IDLE_RELOAD_MS, nothing in flight, and no dirty quote session. */
export function reloadAtIdle(state: {
  pending: boolean;
  mutationsInFlight: number;
  quoteSessionDirty: boolean;
  idleMs: number;
}): boolean {
  return (
    state.pending &&
    state.mutationsInFlight === 0 &&
    !state.quoteSessionDirty &&
    state.idleMs >= PANE_IDLE_RELOAD_MS
  );
}

/** The one place the pane reloads itself. Only the two boundary checks above call it. */
export function reloadPane(): void {
  window.location.reload();
}
