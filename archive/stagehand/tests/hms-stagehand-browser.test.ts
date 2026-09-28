import { describe, expect, it, vi } from 'vitest';
import { stat } from 'node:fs/promises';

const EXTENSION_ID = 'a'.repeat(32);

describe('Stagehand development browser factory', () => {
  it('flushes recording before policy-driven context teardown and joins concurrent closes', async () => {
    const { createStagehandBrowserFactory } = await import('../src/hms/stagehand-browser.js');
    const events: string[] = [];
    const nativeClose = vi.fn(async () => {
      events.push('native-close');
    });
    const beforeClose = vi.fn(async () => {
      events.push('recording-stop');
    });
    const factory = createStagehandBrowserFactory({
      profileRoot: '/tmp/hms-stagehand-test-profiles',
      extensionDir: '/tmp/ext',
      extensionId: EXTENSION_ID,
      cdpPort: 19223,
      launchPersistentContext: vi.fn(async () => ({ close: nativeClose })) as never,
      onBeforeContextClose: beforeClose,
    });
    const owner = await factory({});
    const context = await owner.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    await Promise.all([context.close(), owner.close()]);
    expect(events).toEqual(['recording-stop', 'native-close']);
    expect(beforeClose).toHaveBeenCalledOnce();
    expect(nativeClose).toHaveBeenCalledOnce();
  });

  it('does not let failed recording cleanup keep a browser alive', async () => {
    const { createStagehandBrowserFactory } = await import('../src/hms/stagehand-browser.js');
    const nativeClose = vi.fn(async () => {});
    const factory = createStagehandBrowserFactory({
      profileRoot: '/tmp/hms-stagehand-test-profiles',
      extensionDir: '/tmp/ext',
      extensionId: EXTENSION_ID,
      cdpPort: 19223,
      launchPersistentContext: vi.fn(async () => ({ close: nativeClose })) as never,
      onBeforeContextClose: async () => {
        throw Error('RECORDING_FAILED');
      },
    });
    const owner = await factory({});
    const context = await owner.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    await expect(context.close()).rejects.toThrow('RECORDING_FAILED');
    expect(nativeClose).toHaveBeenCalledOnce();
    await owner.close();
  });

  it('bounds a hung recording flush before closing the native context', async () => {
    const { createStagehandBrowserFactory } = await import('../src/hms/stagehand-browser.js');
    const nativeClose = vi.fn(async () => {});
    const factory = createStagehandBrowserFactory({
      profileRoot: '/tmp/hms-stagehand-test-profiles',
      extensionDir: '/tmp/ext',
      extensionId: EXTENSION_ID,
      cdpPort: 19223,
      launchPersistentContext: vi.fn(async () => ({ close: nativeClose })) as never,
      onBeforeContextClose: () => new Promise<void>(() => {}),
    });
    const owner = await factory({});
    const context = await owner.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    vi.useFakeTimers();
    try {
      const closing = expect(context.close()).rejects.toThrow('STAGEHAND_PRE_CLOSE_TIMEOUT');
      await vi.advanceTimersByTimeAsync(5_001);
      await closing;
      expect(nativeClose).toHaveBeenCalledOnce();
      await owner.close();
    } finally {
      vi.useRealTimers();
    }
  });
  it('provides the opt-in persistent factory without replacing the normal factory', async () => {
    const module = await import('../src/hms/stagehand-browser.js').catch(() => null);
    expect(module?.createStagehandBrowserFactory).toBeTypeOf('function');
  });

  it('preloads the pinned extension, preserves proof guards/video options and closes only its owned context', async () => {
    const { createStagehandBrowserFactory } = await import('../src/hms/stagehand-browser.js');
    const native = { close: vi.fn(async () => {}) };
    const launch = vi.fn(async () => native);
    const nativeClose = native.close;
    const factory = createStagehandBrowserFactory({
      profileRoot: '/tmp/hms-stagehand-test-profiles',
      extensionDir: '/tmp/hms-stagehand-test-extension',
      extensionId: EXTENSION_ID,
      cdpPort: 19223,
      launchPersistentContext: launch as never,
    });
    const owner = await factory({ signal: new AbortController().signal });
    const options = {
      acceptDownloads: false as const,
      serviceWorkers: 'block' as const,
      recordVideo: { dir: '/tmp/hms-stagehand-test-video', size: { width: 1280, height: 720 } },
    };
    const context = await owner.newContext(options);
    expect(launch).toHaveBeenCalledOnce();
    const [profile, launchOptions] = launch.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(profile).toMatch(/^\/tmp\/hms-stagehand-test-profiles\//);
    expect(launchOptions).toMatchObject({ ...options, channel: 'chromium', headless: true });
    expect(launchOptions.args).toEqual(
      expect.arrayContaining([
        '--load-extension=/tmp/hms-stagehand-test-extension',
        '--disable-extensions-except=/tmp/hms-stagehand-test-extension',
        '--enable-unsafe-extension-debugging',
        `--remote-allow-origins=chrome-extension://${EXTENSION_ID}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=19223',
      ]),
    );
    await expect(owner.newContext(options)).rejects.toThrow('STAGEHAND_CONTEXT_BUSY');
    await context.close();
    await owner.close();
    expect(nativeClose).toHaveBeenCalledOnce();
  });

  it('rejects unsafe configuration and aborted setup before launch', async () => {
    const { createStagehandBrowserFactory } = await import('../src/hms/stagehand-browser.js');
    expect(() =>
      createStagehandBrowserFactory({
        profileRoot: '/',
        extensionDir: '/tmp/ext',
        extensionId: EXTENSION_ID,
        cdpPort: 9222,
      }),
    ).toThrow('STAGEHAND_PROFILE_ROOT');
    expect(() =>
      createStagehandBrowserFactory({
        profileRoot: '/tmp/profiles',
        extensionDir: '/tmp/ext',
        extensionId: EXTENSION_ID,
        cdpPort: 80,
      }),
    ).toThrow('STAGEHAND_CDP_PORT');
    const launch = vi.fn();
    const factory = createStagehandBrowserFactory({
      profileRoot: '/tmp/hms-stagehand-test-profiles',
      extensionDir: '/tmp/ext',
      extensionId: EXTENSION_ID,
      cdpPort: 19223,
      launchPersistentContext: launch as never,
    });
    await expect(factory({ signal: AbortSignal.abort() })).rejects.toThrow('aborted');
    expect(launch).not.toHaveBeenCalled();
  });

  it('requires a Chrome extension ID and rejects malformed IDs', async () => {
    const { createStagehandBrowserFactory } = await import('../src/hms/stagehand-browser.js');
    expect(() =>
      createStagehandBrowserFactory({
        profileRoot: '/tmp/profiles',
        extensionDir: '/tmp/ext',
        extensionId: 'not-an-extension-id',
        cdpPort: 19223,
        launchPersistentContext: vi.fn() as never,
      }),
    ).toThrow('STAGEHAND_EXTENSION_ID');
  });

  it('closes and removes a context when trusted setup inspection fails', async () => {
    const { createStagehandBrowserFactory } = await import('../src/hms/stagehand-browser.js');
    const nativeClose = vi.fn(async () => {});
    const launch = vi.fn(async (profile: string) => ({ close: nativeClose, profile }));
    const factory = createStagehandBrowserFactory({
      profileRoot: '/tmp/hms-stagehand-test-profiles',
      extensionDir: '/tmp/ext',
      extensionId: EXTENSION_ID,
      cdpPort: 19223,
      launchPersistentContext: launch as never,
      onContextCreated: () => {
        throw new Error('EXTENSION_MARKER_MISSING');
      },
    });
    const owner = await factory({});
    await expect(
      owner.newContext({ acceptDownloads: false, serviceWorkers: 'block' }),
    ).rejects.toThrow('EXTENSION_MARKER_MISSING');
    expect(nativeClose).toHaveBeenCalledOnce();
    const profile = (launch.mock.calls[0] as unknown as [string])[0];
    await expect(stat(profile)).rejects.toMatchObject({ code: 'ENOENT' });
    await owner.close();
    expect(nativeClose).toHaveBeenCalledOnce();
  });

  it('waits for an in-flight persistent launch before owner close resolves', async () => {
    const { createStagehandBrowserFactory } = await import('../src/hms/stagehand-browser.js');
    let finishLaunch!: (value: { close: () => Promise<void> }) => void;
    const nativeClose = vi.fn(async () => {});
    const launch = vi.fn(
      () =>
        new Promise<{ close: () => Promise<void> }>((resolve) => {
          finishLaunch = resolve;
        }),
    );
    const factory = createStagehandBrowserFactory({
      profileRoot: '/tmp/hms-stagehand-test-profiles',
      extensionDir: '/tmp/ext',
      extensionId: EXTENSION_ID,
      cdpPort: 19223,
      launchPersistentContext: launch as never,
    });
    const owner = await factory({});
    const creation = owner.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    while (!launch.mock.calls.length) await new Promise((resolve) => setTimeout(resolve, 0));
    let closed = false;
    const ownerClose = owner.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(false);
    finishLaunch({ close: nativeClose });
    await expect(creation).rejects.toThrow('STAGEHAND_SETUP_ABORTED');
    await ownerClose;
    expect(nativeClose).toHaveBeenCalledOnce();
  });

  it('joins concurrent owner/context cleanup without closing the native browser twice', async () => {
    const { createStagehandBrowserFactory } = await import('../src/hms/stagehand-browser.js');
    let finish!: () => void;
    const nativeClose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const factory = createStagehandBrowserFactory({
      profileRoot: '/tmp/hms-stagehand-test-profiles',
      extensionDir: '/tmp/ext',
      extensionId: EXTENSION_ID,
      cdpPort: 19223,
      launchPersistentContext: vi.fn(async () => ({ close: nativeClose })) as never,
    });
    const owner = await factory({});
    const context = await owner.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    const first = context.close();
    const second = owner.close();
    expect(nativeClose).toHaveBeenCalledOnce();
    finish();
    await Promise.all([first, second]);
  });
});
