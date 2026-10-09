import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPaneReleaseWatch,
  fetchPaneRelease,
  PANE_RELOAD_GAP_MS,
  PANE_RELOAD_GUARD_KEY,
  sessionPaneReloadGuard,
  type PaneReloadGuard,
} from '../lib/workstation/pane-release-watch';

const RELEASE_A = 'a'.repeat(64);
const RELEASE_B = 'b'.repeat(64);
const T0 = 1_800_000_000_000;

function memoryGuard(): PaneReloadGuard {
  const state: { at: number | null } = { at: null };
  return {
    readAt: () => state.at,
    writeAt: (at: number) => {
      state.at = at;
      return true;
    },
  };
}

function harness(options: { guard?: PaneReloadGuard } = {}) {
  const served: { release: string | null } = { release: RELEASE_A };
  const busy = { value: false };
  const clock = { now: T0 };
  const guard = options.guard ?? memoryGuard();
  const reload = vi.fn();
  const onLoaded = vi.fn();
  const watch = createPaneReleaseWatch({
    fetchRelease: async () => served.release,
    isBusy: () => busy.value,
    reload,
    guard,
    now: () => clock.now,
    onLoaded,
  });
  return { watch, served, busy, clock, guard, reload, onLoaded };
}

describe('pane release watch', () => {
  it('takes the first served release as the loaded baseline without reloading', async () => {
    const { watch, onLoaded, reload } = harness();
    await watch.check();
    expect(onLoaded).toHaveBeenCalledWith(RELEASE_A);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads once when a new release is served and the pane is idle', async () => {
    const { watch, served, reload } = harness();
    await watch.check();
    served.release = RELEASE_B;
    await watch.check();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload while busy, and reloads on a later idle check', async () => {
    const { watch, served, busy, reload } = harness();
    await watch.check();
    served.release = RELEASE_B;
    busy.value = true;
    await watch.check();
    expect(reload).not.toHaveBeenCalled();
    busy.value = false;
    await watch.check();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the served release is the one already loaded', async () => {
    const { watch, reload, onLoaded } = harness();
    await watch.check();
    await watch.check();
    await watch.check();
    expect(reload).not.toHaveBeenCalled();
    expect(onLoaded).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the release fetch fails, before or after the baseline', async () => {
    const { watch, served, reload, onLoaded } = harness();
    served.release = null;
    await expect(watch.check()).resolves.toBeUndefined();
    expect(onLoaded).not.toHaveBeenCalled();
    served.release = RELEASE_A;
    await watch.check();
    served.release = null;
    await expect(watch.check()).resolves.toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
  });

  it('never reloads twice within the gap, so a flipping release cannot loop the pane', async () => {
    const guard = memoryGuard();
    const first = harness({ guard });
    await first.watch.check();
    first.served.release = RELEASE_B;
    await first.watch.check();
    expect(first.reload).toHaveBeenCalledTimes(1);

    // The reloaded page loads B, then the server flips back to A straight away.
    const second = harness({ guard });
    second.served.release = RELEASE_B;
    await second.watch.check();
    second.served.release = RELEASE_A;
    second.clock.now = T0 + 60_000;
    await second.watch.check();
    expect(second.reload).not.toHaveBeenCalled();

    second.clock.now = T0 + PANE_RELOAD_GAP_MS + 1;
    await second.watch.check();
    expect(second.reload).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the reload time cannot be recorded', async () => {
    const { watch, served, reload } = harness({
      guard: { readAt: () => null, writeAt: () => false },
    });
    await watch.check();
    served.release = RELEASE_B;
    await watch.check();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('fetchPaneRelease', () => {
  it('returns the release id only for a well-formed JSON body', async () => {
    const ok = async () =>
      new Response(JSON.stringify({ release: RELEASE_A }), {
        headers: { 'content-type': 'application/json' },
      });
    await expect(fetchPaneRelease(ok)).resolves.toBe(RELEASE_A);
  });

  it('returns null for a network error, a non-OK status, HTML, or a malformed id; never throws', async () => {
    await expect(
      fetchPaneRelease(async () => {
        throw new TypeError('offline');
      }),
    ).resolves.toBeNull();
    await expect(
      fetchPaneRelease(async () => new Response('{"release":"x"}', { status: 404 })),
    ).resolves.toBeNull();
    await expect(
      fetchPaneRelease(async () => new Response('<!doctype html><html></html>')),
    ).resolves.toBeNull();
    await expect(
      fetchPaneRelease(async () => new Response(JSON.stringify({ release: 'not-a-release' }))),
    ).resolves.toBeNull();
  });
});

describe('sessionPaneReloadGuard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  });

  it('records the last reload time in sessionStorage', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    });
    const guard = sessionPaneReloadGuard();
    expect(guard.readAt()).toBeNull();
    expect(guard.writeAt(T0)).toBe(true);
    expect(values.get(PANE_RELOAD_GUARD_KEY)).toBe(String(T0));
    expect(guard.readAt()).toBe(T0);
  });

  it('keeps the guard in memory when storage methods throw', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    const guard = sessionPaneReloadGuard();
    expect(guard.readAt()).toBeNull();
    expect(guard.writeAt(T0)).toBe(true);
    expect(guard.readAt()).toBe(T0);
  });

  it('does not throw when reading sessionStorage itself throws, and still rate-limits reloads', async () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('Access is denied', 'SecurityError');
      },
    });
    const guard = sessionPaneReloadGuard();
    const clock = { now: T0 };
    const reload = vi.fn();
    const served = { release: RELEASE_A };
    const watch = createPaneReleaseWatch({
      fetchRelease: async () => served.release,
      isBusy: () => false,
      reload,
      guard,
      now: () => clock.now,
    });
    await watch.check();
    served.release = RELEASE_B;
    await watch.check();
    expect(reload).toHaveBeenCalledTimes(1);
    clock.now = T0 + 60_000;
    served.release = RELEASE_A;
    await watch.check();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
