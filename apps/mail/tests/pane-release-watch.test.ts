import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPaneReleaseWatch,
  fetchPaneVersion,
  loadedPaneBuild,
  PANE_RELOAD_GAP_MS,
  PANE_RELOAD_GUARD_KEY,
  sessionPaneReloadGuard,
  type PaneReloadGuard,
  type PaneVersion,
} from '../lib/workstation/pane-release-watch';

const RELEASE = 'a'.repeat(64);
const LOADED = 'build-loaded-0001';
const NEWER = 'build-newer-0002';
const T0 = 1_800_000_000_000;

function memoryGuard(): PaneReloadGuard {
  const state: { at: number | null } = { at: null };
  return {
    persistent: true,
    readAt: () => state.at,
    writeAt: (at: number) => {
      state.at = at;
      return true;
    },
  };
}

/** A watch whose served version the test controls. `served: undefined` means the fetch fails. */
function harness(options: { guard?: PaneReloadGuard; loadedBuild?: string } = {}) {
  const served: { value: PaneVersion | null } = { value: { release: RELEASE, build: LOADED } };
  const busy = { value: false };
  const clock = { now: T0 };
  const guard = options.guard ?? memoryGuard();
  const reload = vi.fn();
  const onNewerRelease = vi.fn();
  const watch = createPaneReleaseWatch({
    loadedBuild: options.loadedBuild ?? LOADED,
    fetchServed: async () => served.value,
    isBusy: () => busy.value,
    reload,
    guard,
    now: () => clock.now,
    onNewerRelease,
  });
  return { watch, served, busy, clock, guard, reload, onNewerRelease };
}

describe('pane release watch', () => {
  it('reloads when the served build differs from the loaded build and the pane is idle', async () => {
    const { watch, served, reload } = harness();
    served.value = { release: RELEASE, build: NEWER };
    await watch.check();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads on the first successful check after a deploy, when the page loaded before it', async () => {
    // The page loaded LOADED. The first check that ever succeeds sees NEWER, so there is no
    // first-fetch baseline that could have been taken after the deploy.
    const { watch, served, reload } = harness();
    served.value = { release: RELEASE, build: NEWER };
    await watch.check();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('first fetch fails, then a deploy: reloads on the first successful check after the deploy', async () => {
    const { watch, served, reload } = harness();
    served.value = null;
    await watch.check();
    await watch.check();
    expect(reload).not.toHaveBeenCalled();
    served.value = { release: RELEASE, build: NEWER };
    await watch.check();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the served build equals the loaded build', async () => {
    const { watch, reload, onNewerRelease } = harness();
    await watch.check();
    await watch.check();
    expect(reload).not.toHaveBeenCalled();
    expect(onNewerRelease).not.toHaveBeenCalled();
  });

  it('does not reload while busy, and reloads on a later idle check', async () => {
    const { watch, served, busy, reload } = harness();
    served.value = { release: RELEASE, build: NEWER };
    busy.value = true;
    await watch.check();
    expect(reload).not.toHaveBeenCalled();
    busy.value = false;
    await watch.check();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the version fetch fails', async () => {
    const { watch, served, reload, onNewerRelease } = harness();
    served.value = null;
    await expect(watch.check()).resolves.toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
    expect(onNewerRelease).not.toHaveBeenCalled();
  });

  it('never reloads twice within the gap, so a flipping release cannot loop the pane', async () => {
    const guard = memoryGuard();
    const first = harness({ guard });
    first.served.value = { release: RELEASE, build: NEWER };
    await first.watch.check();
    expect(first.reload).toHaveBeenCalledTimes(1);

    // The reloaded page loads NEWER; the server flips back straight away.
    const second = harness({ guard, loadedBuild: NEWER });
    second.served.value = { release: RELEASE, build: LOADED };
    second.clock.now = T0 + 60_000;
    await second.watch.check();
    expect(second.reload).not.toHaveBeenCalled();

    second.clock.now = T0 + PANE_RELOAD_GAP_MS + 1;
    await second.watch.check();
    expect(second.reload).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the reload time cannot be recorded', async () => {
    const { watch, served, reload } = harness({
      guard: { persistent: true, readAt: () => null, writeAt: () => false },
    });
    served.value = { release: RELEASE, build: NEWER };
    await watch.check();
    expect(reload).not.toHaveBeenCalled();
  });

  it('turns auto-reload off, and reports the newer build, when the guard is not persistent', async () => {
    const { watch, served, reload, onNewerRelease } = harness({
      guard: { persistent: false, readAt: () => null, writeAt: () => false },
    });
    served.value = { release: RELEASE, build: NEWER };
    await watch.check();
    await watch.check();
    expect(reload).not.toHaveBeenCalled();
    expect(onNewerRelease).toHaveBeenCalledWith({ release: RELEASE, build: NEWER });
  });
});

describe('fetchPaneVersion', () => {
  it('returns the release and build for a well-formed JSON body', async () => {
    const ok = async () =>
      new Response(JSON.stringify({ release: RELEASE, build: NEWER }), {
        headers: { 'content-type': 'application/json' },
      });
    await expect(fetchPaneVersion(ok)).resolves.toEqual({ release: RELEASE, build: NEWER });
  });

  it('returns null for a network error, a non-OK status, HTML, or a malformed id; never throws', async () => {
    await expect(
      fetchPaneVersion(async () => {
        throw new TypeError('offline');
      }),
    ).resolves.toBeNull();
    await expect(
      fetchPaneVersion(async () => new Response('{"release":"x"}', { status: 404 })),
    ).resolves.toBeNull();
    await expect(
      fetchPaneVersion(async () => new Response('<!doctype html><html></html>')),
    ).resolves.toBeNull();
    await expect(
      fetchPaneVersion(async () => new Response(JSON.stringify({ release: 'bad', build: NEWER }))),
    ).resolves.toBeNull();
    await expect(
      fetchPaneVersion(async () => new Response(JSON.stringify({ release: RELEASE, build: 'x' }))),
    ).resolves.toBeNull();
    await expect(
      fetchPaneVersion(async () => new Response(JSON.stringify({ release: RELEASE }))),
    ).resolves.toBeNull();
  });
});

describe('loadedPaneBuild', () => {
  const docWith = (content: string | null) =>
    ({
      querySelector: () => (content === null ? null : { getAttribute: () => content }),
    }) as unknown as Document;

  it('reads the build id from the page meta', () => {
    expect(loadedPaneBuild(docWith(LOADED))).toBe(LOADED);
  });

  it('is null when the meta is missing or malformed', () => {
    expect(loadedPaneBuild(docWith(null))).toBeNull();
    expect(loadedPaneBuild(docWith('x'))).toBeNull();
    expect(loadedPaneBuild(null)).toBeNull();
  });
});

describe('sessionPaneReloadGuard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  });

  it('records the last reload time in sessionStorage and is persistent', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    });
    const guard = sessionPaneReloadGuard();
    expect(guard.persistent).toBe(true);
    expect(guard.readAt()).toBeNull();
    expect(guard.writeAt(T0)).toBe(true);
    expect(values.get(PANE_RELOAD_GUARD_KEY)).toBe(String(T0));
    expect(guard.readAt()).toBe(T0);
  });

  it('is not persistent when storage methods throw, so auto-reload stays off', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    const guard = sessionPaneReloadGuard();
    expect(guard.persistent).toBe(false);
    expect(guard.readAt()).toBeNull();
    expect(guard.writeAt(T0)).toBe(false);
  });

  it('is not persistent when reading sessionStorage itself throws; the watch never reloads', async () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('Access is denied', 'SecurityError');
      },
    });
    const guard = sessionPaneReloadGuard();
    expect(guard.persistent).toBe(false);
    const reload = vi.fn();
    const onNewerRelease = vi.fn();
    const served: { value: PaneVersion | null } = { value: { release: RELEASE, build: LOADED } };
    const watch = createPaneReleaseWatch({
      loadedBuild: LOADED,
      fetchServed: async () => served.value,
      isBusy: () => false,
      reload,
      guard,
      onNewerRelease,
    });
    served.value = { release: RELEASE, build: NEWER };
    await watch.check();
    await watch.check();
    expect(reload).not.toHaveBeenCalled();
    expect(onNewerRelease).toHaveBeenCalledWith({ release: RELEASE, build: NEWER });
  });

  it('is not persistent when sessionStorage does not exist', () => {
    expect(sessionPaneReloadGuard().persistent).toBe(false);
  });
});
