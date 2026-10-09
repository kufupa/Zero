import { describe, expect, it, vi } from 'vitest';
import {
  createPaneVersionWatch,
  fetchPaneVersion,
  loadedPaneBuild,
  PANE_IDLE_RELOAD_MS,
  reloadAtEmailSwitch,
  reloadAtIdle,
  type PaneVersion,
} from '../lib/workstation/pane-release-watch';

const RELEASE = 'a'.repeat(64);
const LOADED = 'build-loaded-0001';
const NEWER = 'build-newer-0002';

/** A watch whose served version the test controls. `served.value` null means the fetch fails. */
function watchHarness() {
  const served: { value: PaneVersion | null } = { value: { release: RELEASE, build: LOADED } };
  const onPending = vi.fn();
  const watch = createPaneVersionWatch({
    loadedBuild: LOADED,
    fetchServed: async () => served.value,
    onPending,
  });
  return { watch, served, onPending };
}

describe('pane version watch', () => {
  it('reports a served build that differs from the loaded one, on the first successful check', async () => {
    // A page that loaded before a deploy and checks for the first time after it.
    const { watch, served, onPending } = watchHarness();
    served.value = { release: RELEASE, build: NEWER };
    await watch.check();
    expect(onPending).toHaveBeenCalledWith({ release: RELEASE, build: NEWER });
  });

  it('first fetch fails, then a deploy: reports on the first successful check after the deploy', async () => {
    const { watch, served, onPending } = watchHarness();
    served.value = null;
    await watch.check();
    await watch.check();
    expect(onPending).not.toHaveBeenCalled();
    served.value = { release: RELEASE, build: NEWER };
    await watch.check();
    expect(onPending).toHaveBeenCalledTimes(1);
  });

  it('reports nothing while the served build equals the loaded build', async () => {
    const { watch, onPending } = watchHarness();
    await watch.check();
    await watch.check();
    expect(onPending).not.toHaveBeenCalled();
  });

  it('stays silent when the version fetch fails', async () => {
    const { watch, served, onPending } = watchHarness();
    served.value = null;
    await expect(watch.check()).resolves.toBeUndefined();
    expect(onPending).not.toHaveBeenCalled();
  });
});

describe('reload boundaries', () => {
  it('an email switch reloads only when a build is pending and nothing is in flight', () => {
    expect(reloadAtEmailSwitch({ pending: true, mutationsInFlight: 0 })).toBe(true);
    expect(reloadAtEmailSwitch({ pending: false, mutationsInFlight: 0 })).toBe(false);
    expect(reloadAtEmailSwitch({ pending: true, mutationsInFlight: 1 })).toBe(false);
  });

  it('idle reloads only after 15 minutes with nothing in flight and no dirty quote session', () => {
    const idle = { pending: true, mutationsInFlight: 0, quoteSessionDirty: false };
    expect(reloadAtIdle({ ...idle, idleMs: PANE_IDLE_RELOAD_MS - 1 })).toBe(false);
    expect(reloadAtIdle({ ...idle, idleMs: PANE_IDLE_RELOAD_MS })).toBe(true);
    expect(reloadAtIdle({ ...idle, idleMs: PANE_IDLE_RELOAD_MS, quoteSessionDirty: true })).toBe(false);
    expect(reloadAtIdle({ ...idle, idleMs: PANE_IDLE_RELOAD_MS, mutationsInFlight: 1 })).toBe(false);
    expect(reloadAtIdle({ ...idle, idleMs: PANE_IDLE_RELOAD_MS, pending: false })).toBe(false);
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
