import {
  createFetchBrowserFactory,
  createHmsRuntime,
  createPlaywrightBrowserFactory,
  waitForAuthenticatedShell,
  type HmsPage,
} from '../../../../../apps/server-pilot/src/hms/runtime.js';
import { buildLiveGuestStayReadManifest } from '../../../../../apps/server-pilot/src/hms/live-read-manifest.js';
import { FIXTURE_IDS, startHmsFixtureServer } from '../../../../../apps/server-pilot/tests/helpers/hms-fixture-server.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://hms.example';
const NOTES_URL = `${ORIGIN}/api/booking/HRCEN/notesInquiry`;
const TRC_URL = `${ORIGIN}/web/base/OSRESV.TRC`;
const NOTES_RESPONSE_MAX_BYTES = 32 * 1024;
const TRC_RESPONSE_BOUNDS = { maxBytes: NOTES_RESPONSE_MAX_BYTES, timeoutMs: 5_000 };
const FOL_RESPONSE_MAX_BYTES = 256 * 1024;
const FOL_RESPONSE_BOUNDS = { maxBytes: FOL_RESPONSE_MAX_BYTES, timeoutMs: 5_000 };

function locator() {
  return {
    fill: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    count: vi.fn(async () => 0),
    nth: () => ({
      isVisible: vi.fn(async () => false),
      scrollIntoViewIfNeeded: vi.fn(async () => undefined),
      click: vi.fn(async () => undefined),
    }),
    first: () => ({ click: vi.fn(async () => undefined) }),
  };
}

async function nativePageHarness() {
  const evaluate = vi.fn(async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg));
  const requestPost = vi.fn(async () => ({
    text: async () => 'fallback-body',
    status: 200,
  }));
  const nativePage = {
    goto: vi.fn(async () => undefined),
    content: vi.fn(async () => '<html></html>'),
    close: vi.fn(async () => undefined),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    url: vi.fn(() => `${ORIGIN}/web/base/OSRESV`),
    title: vi.fn(async () => 'HMS'),
    locator,
    getByLabel: () => ({ fill: vi.fn(async () => undefined) }),
    getByRole: () => ({ click: vi.fn(async () => undefined) }),
    getByText: () => ({ first: () => ({ click: vi.fn(async () => undefined) }) }),
    waitForResponse: vi.fn(async () => undefined),
    waitForURL: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    request: { post: requestPost },
    evaluate,
  };
  const context = {
    tracing: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
    route: vi.fn(async () => undefined),
    routeWebSocket: vi.fn(async () => undefined),
    newPage: vi.fn(async () => nativePage),
    close: vi.fn(async () => undefined),
    pages: vi.fn(() => [nativePage]),
    on: vi.fn(),
    storageState: vi.fn(async () => ({})),
  };
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  };
  const factory = createPlaywrightBrowserFactory({
    launchBrowser: vi.fn(async () => browser),
  });
  const wrappedBrowser = await factory({});
  const wrappedContext = await wrappedBrowser.newContext({});
  const page = await wrappedContext.newPage();
  return { page, evaluate, requestPost, close: () => wrappedBrowser.close() };
}

async function loginTimingPageHarness(options: {
  useridFails?: boolean;
  labelFails?: boolean;
  usernameFails?: boolean;
  passwordFails?: boolean;
  buttonFails?: boolean;
  buttonCount?: number;
  buttonVisible?: boolean;
} = {}) {
  const fill = (fails = false) =>
    vi.fn(async () => {
      if (fails) throw new Error('selector miss');
    });
  const useridFill = fill(options.useridFails);
  const labelFill = fill(options.labelFails);
  const usernameFill = fill(options.usernameFails);
  const passwordFill = fill(options.passwordFails);
  const buttonClick = vi.fn(async () => {
    if (options.buttonFails) throw new Error('button miss');
  });
  const enterPress = vi.fn(async () => undefined);
  const nativePage = {
    goto: vi.fn(async () => undefined),
    content: vi.fn(async () => '<html></html>'),
    close: vi.fn(async () => undefined),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    url: vi.fn(() => `${ORIGIN}/login`),
    title: vi.fn(async () => 'HMS'),
    locator: vi.fn((selector: string) => {
      if (selector === 'input[name="userid"]') return { fill: useridFill };
      if (selector === 'input[name="username"]') return { fill: usernameFill };
      if (selector === 'input[name="password"]') {
        return { fill: passwordFill, press: enterPress };
      }
      return { fill: vi.fn(async () => undefined), press: enterPress };
    }),
    getByLabel: vi.fn((label: string) => ({
      fill: label === 'Username' ? labelFill : passwordFill,
    })),
    getByRole: vi.fn(() => ({
      click: buttonClick,
      count: vi.fn(async () => options.buttonCount ?? 1),
      isVisible: vi.fn(async () => options.buttonVisible ?? true),
    })),
    getByText: vi.fn(() => ({ first: () => ({ click: buttonClick }) })),
    waitForResponse: vi.fn(async () => undefined),
    waitForURL: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    request: { post: vi.fn(async () => ({ text: async () => '', status: 200 })) },
    evaluate: vi.fn(async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg)),
  };
  const context = {
    tracing: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
    route: vi.fn(async () => undefined),
    routeWebSocket: vi.fn(async () => undefined),
    newPage: vi.fn(async () => nativePage),
    close: vi.fn(async () => undefined),
    pages: vi.fn(() => [nativePage]),
    on: vi.fn(),
    storageState: vi.fn(async () => ({})),
  };
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  };
  const factory = createPlaywrightBrowserFactory({
    launchBrowser: vi.fn(async () => browser),
  });
  const wrappedBrowser = await factory({});
  const wrappedContext = await wrappedBrowser.newContext({});
  const page = await wrappedContext.newPage();
  return {
    page,
    useridFill,
    labelFill,
    usernameFill,
    buttonClick,
    enterPress,
    close: () => wrappedBrowser.close(),
  };
}

function diagnosticsFrom(write: ReturnType<typeof vi.spyOn>) {
  return write.mock.calls
    .map(([value]) => String(value))
    .map((value) => {
      try {
        return JSON.parse(value) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((value): value is Record<string, unknown> => value?.stage === 'login_timing');
}

function installBrowserAuth(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('location', { origin: ORIGIN, href: `${ORIGIN}/web/base/OSRESV` });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EAM', {
    AppData: {
      getRawAppData: vi.fn(() => ({ HMSLoginSessionCookieName: 'COOKIE-NAME' })),
    },
  });
  vi.stubGlobal('CryptoJS', {
    SHA256: vi.fn((value: unknown) => ({ value })),
    enc: { Base64: { stringify: vi.fn(() => 'derived-token') } },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('native authenticated notes JSON adapter', () => {
  it('derives Authorization in-page and never returns the session material', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.body).toBe(JSON.stringify({ confirmationNumber: 'CONF-123' }));
      expect(init.headers).toEqual({
        'content-type': 'application/json',
        authorization: 'Bearer derived-token',
      });
      return new Response('{"ok":true}', { status: 200 });
    });
    installBrowserAuth(fetchMock);
    vi.stubEnv('HMS_PROOF_DIAGNOSTICS', '1');
    const diagnosticWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const harness = await nativePageHarness();

    await expect(
      harness.page.postJson?.(NOTES_URL, { confirmationNumber: 'CONF-123' }),
    ).resolves.toBe('{"ok":true}');
    expect(fetchMock).toHaveBeenCalledOnce();
    const rawAppData = (globalThis as any).EAM.AppData.getRawAppData;
    expect(rawAppData).toHaveBeenCalledOnce();
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('COOKIE-NAME');
    expect(JSON.stringify(diagnosticWrite.mock.calls)).not.toContain('COOKIE-NAME');
    expect(JSON.stringify(diagnosticWrite.mock.calls)).not.toContain('derived-token');
    await harness.close();
  });

  it.each([
    `${ORIGIN}/api/booking/OTHER/notesInquiry`,
    `${ORIGIN}/api/booking/HRCEN/notesInquiry?x=1`,
    `${ORIGIN}/api/booking/HRCEN/notesInquiry#fragment`,
    'https://other.example/api/booking/HRCEN/notesInquiry',
  ])('rejects unapproved URL before browser credential access: %s', async (url) => {
    const fetchMock = vi.fn();
    installBrowserAuth(fetchMock);
    const harness = await nativePageHarness();
    const rawAppData = (globalThis as any).EAM.AppData.getRawAppData;

    await expect(
      harness.page.postJson?.(url, { confirmationNumber: 'CONF-123' }),
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(harness.evaluate).not.toHaveBeenCalled();
    expect(rawAppData).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await harness.close();
  });

  it('fails closed when browser auth material or CryptoJS is unavailable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('location', { origin: ORIGIN, href: `${ORIGIN}/web/base/OSRESV` });
    vi.stubGlobal('fetch', fetchMock);
    const harness = await nativePageHarness();

    await expect(
      harness.page.postJson?.(NOTES_URL, { confirmationNumber: 'CONF-123' }),
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(fetchMock).not.toHaveBeenCalled();
    await harness.close();
  });

  it.each([401, 302])('rejects non-success or redirect response: %s', async (status) => {
    const fetchMock = vi.fn(async () => new Response('', { status }));
    installBrowserAuth(fetchMock);
    const harness = await nativePageHarness();

    await expect(
      harness.page.postJson?.(NOTES_URL, { confirmationNumber: 'CONF-123' }),
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(fetchMock).toHaveBeenCalledOnce();
    await harness.close();
  });

  it('reads bounded JSON response bytes and cancels the reader on overflow', async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const read = vi.fn(async () => ({
      done: false,
      value: new Uint8Array(NOTES_RESPONSE_MAX_BYTES + 1),
    }));
    const fetchMock = vi.fn(async () => ({
      status: 200,
      type: 'basic',
      redirected: false,
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    }));
    installBrowserAuth(fetchMock);
    const harness = await nativePageHarness();

    await expect(
      harness.page.postJson?.(NOTES_URL, { confirmationNumber: 'CONF-123' }),
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    expect(read).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
    await harness.close();
  });

  it('does not await a never-resolving reader cancellation on JSON overflow', async () => {
    const cancel = vi.fn(() => new Promise<never>(() => {}));
    const releaseLock = vi.fn();
    const read = vi.fn(async () => ({
      done: false,
      value: new Uint8Array(NOTES_RESPONSE_MAX_BYTES + 1),
    }));
    const fetchMock = vi.fn(async () => ({
      status: 200,
      type: 'basic',
      redirected: false,
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    }));
    installBrowserAuth(fetchMock);
    const harness = await nativePageHarness();
    const pending = harness.page.postJson?.(NOTES_URL, { confirmationNumber: 'CONF-123' });
    const outcome = await Promise.race([
      pending!.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 100)),
    ]);

    expect(outcome).toBe('rejected');
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
    await harness.close();
  });

  it.each([
    ['missing body', { status: 200, type: 'basic', redirected: false }],
    ['opaque response', { status: 200, type: 'opaque', redirected: false, body: null }],
    [
      'unknown response type',
      {
        status: 200,
        redirected: false,
        body: {
          getReader: () => ({
            read: vi.fn(async () => ({ done: true, value: undefined })),
            cancel: vi.fn(async () => undefined),
            releaseLock: vi.fn(),
          }),
        },
      },
    ],
  ])('rejects %s without a text fallback', async (_label, response) => {
    const fetchMock = vi.fn(async () => response);
    installBrowserAuth(fetchMock);
    const harness = await nativePageHarness();

    await expect(
      harness.page.postJson?.(NOTES_URL, { confirmationNumber: 'CONF-123' }),
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(fetchMock).toHaveBeenCalledOnce();
    await harness.close();
  });

  it('aborts a stalled browser fetch at the fixed deadline and reports only a safe code', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      await new Promise((resolve, reject) => {
        init.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('browser request aborted'));
          },
          { once: true },
        );
      });
      return new Response('never');
    });
    installBrowserAuth(fetchMock);
    vi.stubEnv('HMS_PROOF_DIAGNOSTICS', '1');
    const diagnosticWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const harness = await nativePageHarness();
    const pending = harness.page.postJson?.(NOTES_URL, { confirmationNumber: 'CONF-123' });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });

    await vi.advanceTimersByTimeAsync(8_001);
    await rejected;
    expect(aborted).toBe(true);
    const diagnostics = JSON.stringify(diagnosticWrite.mock.calls);
    expect(diagnostics).toContain('timeout');
    expect(diagnostics).not.toContain('browser request aborted');
    expect(diagnostics).not.toContain('Bearer');
    await harness.close();
    vi.useRealTimers();
  });

  it('clears the browser deadline after a successful bounded body read', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal;
      return new Response('{"ok":true}', { status: 200 });
    });
    installBrowserAuth(fetchMock);
    const harness = await nativePageHarness();

    await expect(
      harness.page.postJson?.(NOTES_URL, { confirmationNumber: 'CONF-123' }),
    ).resolves.toBe('{"ok":true}');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(8_001);
    expect(signal?.aborted).toBe(false);
    await harness.close();
    vi.useRealTimers();
  });
});

describe('native bounded form adapter', () => {
  it.each([
    '/web/base/OSRESV.TRC',
    '/web/base/OSRESV.FOL',
    '/web/base/OSRESV.FOL.xmlhttp',
    '/web/base/GETCACHE',
  ])('accepts each reviewed bounded read path: %s', async (path) => {
    const bounds = path === '/web/base/OSRESV.TRC' ? TRC_RESPONSE_BOUNDS : FOL_RESPONSE_BOUNDS;
    const fetchMock = vi.fn(async () => new Response('bounded-body', { status: 200 }));
    vi.stubGlobal('location', { origin: ORIGIN, href: `${ORIGIN}/web/base/OSRESV` });
    vi.stubGlobal('fetch', fetchMock);
    const harness = await nativePageHarness();

    await expect(harness.page.postForm(`${ORIGIN}${path}`, {}, bounds)).resolves.toBe(
      'bounded-body',
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    await harness.close();
  });

  it.each([
    `${ORIGIN}/web/base/OSRESV.FOL?cursor=1`,
    `${ORIGIN}/web/base/OSRESV.FOL.xmlhttp#fragment`,
    `${ORIGIN}/web/base/GETCACHE?x=1`,
    'https://other.example/web/base/OSRESV.FOL',
    `${ORIGIN}/web/base/OSRESV.HDR`,
  ])('rejects unapproved bounded read URL before browser dispatch: %s', async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('location', { origin: ORIGIN, href: `${ORIGIN}/web/base/OSRESV` });
    vi.stubGlobal('fetch', fetchMock);
    const harness = await nativePageHarness();

    await expect(harness.page.postForm(url, {}, FOL_RESPONSE_BOUNDS)).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
    });
    expect(harness.evaluate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await harness.close();
  });

  it.each([
    [{ maxBytes: NOTES_RESPONSE_MAX_BYTES + 1, timeoutMs: 5_000 }, 'maxBytes'],
    [{ maxBytes: NOTES_RESPONSE_MAX_BYTES, timeoutMs: 5_001 }, 'timeoutMs'],
  ])(
    'rejects bounded form limits above the fixed cap before browser dispatch: %s',
    async (bounds) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('location', { origin: ORIGIN, href: `${ORIGIN}/web/base/OSRESV` });
      vi.stubGlobal('fetch', fetchMock);
      const harness = await nativePageHarness();

      await expect(harness.page.postForm(TRC_URL, {}, bounds)).rejects.toMatchObject({
        code: 'SOURCE_UNAVAILABLE',
      });
      expect(harness.evaluate).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      await harness.close();
    },
  );

  it('rejects a folio response limit above its fixed cap before browser dispatch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('location', { origin: ORIGIN, href: `${ORIGIN}/web/base/OSRESV` });
    vi.stubGlobal('fetch', fetchMock);
    const harness = await nativePageHarness();

    await expect(
      harness.page.postForm(
        `${ORIGIN}/web/base/OSRESV.FOL`,
        {},
        {
          maxBytes: FOL_RESPONSE_MAX_BYTES + 1,
          timeoutMs: 5_000,
        },
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(harness.evaluate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await harness.close();
  });

  it.each([500, 302])(
    'rejects non-success or redirect response without API-request fallback: %s',
    async (status) => {
      const fetchMock = vi.fn(async () => new Response('', { status }));
      vi.stubGlobal('location', { origin: ORIGIN, href: `${ORIGIN}/web/base/OSRESV` });
      vi.stubGlobal('fetch', fetchMock);
      const harness = await nativePageHarness();

      await expect(harness.page.postForm(TRC_URL, {}, TRC_RESPONSE_BOUNDS)).rejects.toMatchObject({
        code: 'SOURCE_UNAVAILABLE',
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(harness.requestPost).not.toHaveBeenCalled();
      await harness.close();
    },
  );

  it('reads bounded form response bytes and cancels the reader on overflow', async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const read = vi.fn(async () => ({
      done: false,
      value: new Uint8Array(TRC_RESPONSE_BOUNDS.maxBytes + 1),
    }));
    const fetchMock = vi.fn(async () => ({
      status: 200,
      type: 'basic',
      redirected: false,
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    }));
    vi.stubGlobal('location', { origin: ORIGIN, href: `${ORIGIN}/web/base/OSRESV` });
    vi.stubGlobal('fetch', fetchMock);
    const harness = await nativePageHarness();

    await expect(harness.page.postForm(TRC_URL, {}, TRC_RESPONSE_BOUNDS)).rejects.toMatchObject({
      code: 'SIZE_LIMIT',
    });
    expect(read).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(harness.requestPost).not.toHaveBeenCalled();
    await harness.close();
  });

  it('does not await a never-resolving reader cancellation on form overflow', async () => {
    const cancel = vi.fn(() => new Promise<never>(() => {}));
    const releaseLock = vi.fn();
    const read = vi.fn(async () => ({
      done: false,
      value: new Uint8Array(TRC_RESPONSE_BOUNDS.maxBytes + 1),
    }));
    const fetchMock = vi.fn(async () => ({
      status: 200,
      type: 'basic',
      redirected: false,
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    }));
    vi.stubGlobal('location', { origin: ORIGIN, href: `${ORIGIN}/web/base/OSRESV` });
    vi.stubGlobal('fetch', fetchMock);
    const harness = await nativePageHarness();
    const pending = harness.page.postForm(TRC_URL, {}, TRC_RESPONSE_BOUNDS);
    const outcome = await Promise.race([
      pending.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 100)),
    ]);

    expect(outcome).toBe('rejected');
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
    await harness.close();
  });

  it('aborts a stalled bounded form fetch at its fixed deadline without fallback', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      await new Promise((resolve, reject) => {
        init.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('browser request aborted'));
          },
          { once: true },
        );
      });
      return new Response('never');
    });
    vi.stubGlobal('location', { origin: ORIGIN, href: `${ORIGIN}/web/base/OSRESV` });
    vi.stubGlobal('fetch', fetchMock);
    const harness = await nativePageHarness();
    const pending = harness.page.postForm(TRC_URL, {}, TRC_RESPONSE_BOUNDS);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });

    await vi.advanceTimersByTimeAsync(TRC_RESPONSE_BOUNDS.timeoutMs + 1);
    await rejected;
    expect(aborted).toBe(true);
    expect(harness.requestPost).not.toHaveBeenCalled();
    await harness.close();
    vi.useRealTimers();
  });

  it('rejects an unknown response type without reading or falling back', async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      redirected: false,
      body: { getReader: vi.fn() },
    }));
    vi.stubGlobal('location', { origin: ORIGIN, href: `${ORIGIN}/web/base/OSRESV` });
    vi.stubGlobal('fetch', fetchMock);
    const harness = await nativePageHarness();

    await expect(harness.page.postForm(TRC_URL, {}, TRC_RESPONSE_BOUNDS)).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
    });
    expect(harness.requestPost).not.toHaveBeenCalled();
    await harness.close();
  });
});

describe('legacy folio transport diagnostics', () => {
  it.each(['/web/base/OSRESV.FOL', '/web/base/OSRESV.FOL.xmlhttp', '/web/base/GETCACHE'])(
    'records bounded safe timing fields for %s',
    async (path) => {
      const fetchMock = vi.fn(async () => ({
        text: async () => 'safe-body',
        status: 200,
        type: 'basic',
        redirected: false,
        url: '',
      }));
      vi.stubGlobal('location', { origin: ORIGIN, href: `${ORIGIN}/web/base/OSRESV` });
      vi.stubGlobal('fetch', fetchMock);
      vi.stubEnv('HMS_PROOF_DIAGNOSTICS', '1');
      const diagnosticWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const harness = await nativePageHarness();

      await expect(harness.page.postForm(`${ORIGIN}${path}`, {})).resolves.toBe('safe-body');

      const diagnostic = diagnosticWrite.mock.calls
        .map(([value]) => String(value))
        .map((value) => {
          try {
            return JSON.parse(value) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find((value) => value?.stage === 'legacy_read_post_form');
      expect(diagnostic).toMatchObject({
        type: 'HMS_PROOF_DIAGNOSTIC',
        stage: 'legacy_read_post_form',
        path,
        status: 200,
        responseType: 'basic',
        bodyBytes: 9,
      });
      expect(diagnostic?.durationMs).toEqual(expect.any(Number));
      expect(JSON.stringify(diagnostic)).not.toContain('safe-body');
      expect(Object.keys(diagnostic ?? {}).sort()).toEqual(
        ['bodyBytes', 'durationMs', 'path', 'responseType', 'stage', 'status', 'type'].sort(),
      );
      await harness.close();
    },
  );
});

describe('fixture bounded form adapter', () => {
  it('refuses bounded form reads before fixture route dispatch', async () => {
    const route = vi.fn(async () => undefined);
    const browser = await createFetchBrowserFactory([route])({});
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
    const page = await context.newPage();

    await expect(page.postForm(TRC_URL, {}, TRC_RESPONSE_BOUNDS)).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
    });
    expect(route).not.toHaveBeenCalled();

    await context.close();
    await browser.close();
  });
});

describe('login timing diagnostics', () => {
  it('is gated and emits phase/duration/branch metadata without credentials', async () => {
    vi.stubEnv('HMS_PROOF_DIAGNOSTICS', '1');
    const diagnosticWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const harness = await loginTimingPageHarness();

    await harness.page.fillLogin('private-login-user', 'private-login-password');
    await harness.page.submitLogin();

    const diagnostics = diagnosticsFrom(diagnosticWrite);
    expect(diagnostics.map((entry) => entry.phase)).toEqual(['login_fill', 'login_submit']);
    expect(diagnostics.map((entry) => entry.selectorBranch)).toEqual(['userid', 'button']);
    for (const entry of diagnostics) {
      expect(entry.durationMs).toEqual(expect.any(Number));
      expect(Object.keys(entry).sort()).toEqual(
        ['durationMs', 'phase', 'selectorBranch', 'stage', 'type'].sort(),
      );
    }
    expect(JSON.stringify(diagnostics)).not.toContain('private-login-user');
    expect(JSON.stringify(diagnostics)).not.toContain('private-login-password');
    await harness.close();
  });

  it.each([
    ['label', { useridFails: true }],
    ['username', { useridFails: true, labelFails: true }],
  ])('records fill selector fallback branch: %s', async (branch, options) => {
    vi.stubEnv('HMS_PROOF_DIAGNOSTICS', '1');
    const diagnosticWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const harness = await loginTimingPageHarness(options);

    await harness.page.fillLogin('private-login-user', 'private-login-password');

    expect(diagnosticsFrom(diagnosticWrite).map((entry) => entry.selectorBranch)).toEqual([
      branch,
    ]);
    await harness.close();
  });

  it('retains the proven button attempt when button metadata is unavailable', async () => {
    vi.stubEnv('HMS_PROOF_DIAGNOSTICS', '1');
    const diagnosticWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const harness = await loginTimingPageHarness({ buttonCount: 0 });

    await harness.page.submitLogin();

    expect(diagnosticsFrom(diagnosticWrite).map((entry) => entry.selectorBranch)).toEqual([
      'button',
    ]);
    expect(harness.buttonClick).toHaveBeenCalledOnce();
    expect(harness.enterPress).not.toHaveBeenCalled();
    await harness.close();
  });

  it('does not gate the proven button attempt on count or visibility probes', async () => {
    vi.stubEnv('HMS_PROOF_DIAGNOSTICS', '1');
    const diagnosticWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const harness = await loginTimingPageHarness({ buttonCount: 0, buttonVisible: false });
    const startedAt = Date.now();

    await harness.page.submitLogin();

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(harness.buttonClick).toHaveBeenCalledOnce();
    expect(harness.enterPress).not.toHaveBeenCalled();
    expect(diagnosticsFrom(diagnosticWrite).map((entry) => entry.selectorBranch)).toEqual([
      'button',
    ]);
    await harness.close();
  });

  it('falls back to Enter when the proven button attempt fails', async () => {
    vi.stubEnv('HMS_PROOF_DIAGNOSTICS', '1');
    const diagnosticWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const harness = await loginTimingPageHarness({ buttonFails: true });

    await harness.page.submitLogin();

    expect(harness.buttonClick).toHaveBeenCalledOnce();
    expect(harness.enterPress).toHaveBeenCalledWith('Enter');
    expect(diagnosticsFrom(diagnosticWrite).map((entry) => entry.selectorBranch)).toEqual([
      'enter',
    ]);
    await harness.close();
  });

  it('times authenticated-shell polling only when diagnostics are enabled', async () => {
    const page = {
      content: vi.fn(async () =>
        '<main data-tenant="HMS_LEGACY" data-property-code="HRCEN" data-property-name="Centurion Hotel"></main>',
      ),
      title: vi.fn(async () => 'Centurion Hotel'),
      url: vi.fn(() => `${ORIGIN}/COMMON`),
    } as unknown as HmsPage;
    const secret = {
      expectedTenant: 'HMS_LEGACY',
      expectedPropertyCode: 'HRCEN',
      expectedPropertyName: 'Centurion Hotel',
    };

    const disabledWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubEnv('HMS_PROOF_DIAGNOSTICS', '0');
    await waitForAuthenticatedShell(page, secret, 1_000);
    expect(diagnosticsFrom(disabledWrite)).toHaveLength(0);

    vi.stubEnv('HMS_PROOF_DIAGNOSTICS', '1');
    await waitForAuthenticatedShell(page, secret, 1_000);
    const diagnostics = diagnosticsFrom(disabledWrite);
    expect(diagnostics.map((entry) => entry.phase)).toEqual(['wait_authenticated_shell']);
    expect(diagnostics[0]?.durationMs).toEqual(expect.any(Number));
  });

  it('covers single-context login goto, shell wait, and property verification phases', async () => {
    vi.stubEnv('HMS_PROOF_DIAGNOSTICS', '1');
    vi.stubEnv('HMS_SINGLE_CONTEXT_LOGIN', '1');
    const diagnosticWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const server = await startHmsFixtureServer({ shape: 'live-infor' });
    const secret = {
      loginUrl: `${server.origin}/web/base/logindisp?tenant=HMS_LEGACY`,
      username: 'private-login-user',
      password: 'private-login-password',
      expectedTenant: FIXTURE_IDS.tenant,
      expectedPropertyCode: FIXTURE_IDS.livePropertyCode,
      expectedPropertyName: FIXTURE_IDS.propertyName,
      mailboxTransportId: FIXTURE_IDS.transportId,
      credentialMode: 'view_only' as const,
    };
    const runtime = createHmsRuntime({
      manifest: buildLiveGuestStayReadManifest(server.origin),
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-login-timing',
      loadSecret: async () => secret,
      browserFactory: createFetchBrowserFactory(),
      runStartupCanary: false,
    });
    try {
      await runtime.start(AbortSignal.timeout(15_000));
      const session = await runtime.openReadSession({
        transportId: secret.mailboxTransportId,
        signal: AbortSignal.timeout(15_000),
      });
      await session.close();
    } finally {
      await runtime.close().catch(() => undefined);
      await server.close();
    }

    const diagnostics = diagnosticsFrom(diagnosticWrite);
    expect(diagnostics.map((entry) => entry.phase)).toEqual(
      expect.arrayContaining(['login_goto', 'wait_authenticated_shell', 'verify_property']),
    );
    expect(JSON.stringify(diagnostics)).not.toContain('private-login-user');
    expect(JSON.stringify(diagnostics)).not.toContain('private-login-password');
  });
});
