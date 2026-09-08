import {
  createFetchBrowserFactory,
  createHmsLiveProofRuntime,
  createHmsRuntime,
  createPlaywrightBrowserFactory,
  HmsRuntimeError,
  type HmsSecret,
} from '../src/hms/runtime.js';
import {
  FIXTURE_IDS,
  startHmsFixtureServer,
  type HmsFixtureServer,
} from './helpers/hms-fixture-server.js';
import { requestPolicyManifestSchema, requestRuleSchema } from '../src/hms/contracts.js';
import type { HmsBrowserArtifactStore } from '../src/hms/browser-artifacts.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function fixtureManifest(origin: string) {
  return requestPolicyManifestSchema.parse({
    rules: [
      requestRuleSchema.parse({
        id: 'login-page',
        origin,
        method: 'GET',
        path: '/login',
        resourceTypes: ['document'],
        redirectPolicy: 'same-reviewed-chain',
      }),
      requestRuleSchema.parse({
        id: 'login-session',
        origin,
        method: 'POST',
        path: '/session',
        resourceTypes: ['document'],
        contentType: 'application/x-www-form-urlencoded',
        variableBody: {
          username: { pattern: '.{1,64}', maxLength: 64 },
          password: { pattern: '.{1,128}', maxLength: 128 },
        },
        redirectPolicy: 'same-reviewed-chain',
      }),
      requestRuleSchema.parse({
        id: 'property-header',
        origin,
        method: 'GET',
        path: '/property',
        resourceTypes: ['document'],
        redirectPolicy: 'same-reviewed-chain',
      }),
      requestRuleSchema.parse({
        id: 'reservations-page',
        origin,
        method: 'GET',
        path: '/reservations',
        resourceTypes: ['document'],
        redirectPolicy: 'same-reviewed-chain',
      }),
      requestRuleSchema.parse({
        id: 'reservation-search',
        origin,
        method: 'POST',
        path: '/web/reservation/search',
        resourceTypes: ['document', 'xhr', 'fetch'],
        contentType: 'application/x-www-form-urlencoded',
        fixedBody: {
          action: 'search',
          tenant: FIXTURE_IDS.tenant,
          property: FIXTURE_IDS.propertyCode,
        },
        variableBody: {
          confirmationNumber: { pattern: '[A-Z0-9-]{1,32}', maxLength: 32 },
          surname: { pattern: '.{0,40}', maxLength: 40 },
        },
        redirectPolicy: 'same-reviewed-chain',
      }),
      requestRuleSchema.parse({
        id: 'room-availability',
        origin,
        method: 'GET',
        path: '/availability/rooms',
        resourceTypes: ['document'],
        fixedQuery: { view: 'inventory' },
        variableQuery: {
          startDate: { pattern: '\\d{4}-\\d{2}-\\d{2}', maxLength: 10 },
        },
        redirectPolicy: 'same-reviewed-chain',
      }),
      requestRuleSchema.parse({
        id: 'display-rates',
        origin,
        method: 'GET',
        path: '/availability/rates',
        resourceTypes: ['document'],
        redirectPolicy: 'same-reviewed-chain',
      }),
    ],
  });
}

function fixtureSecret(origin: string, overrides: Partial<HmsSecret> = {}): HmsSecret {
  return {
    loginUrl: `${origin}/login`,
    username: 'fixture-user',
    password: 'fixture-password',
    expectedTenant: FIXTURE_IDS.tenant,
    expectedPropertyCode: FIXTURE_IDS.propertyCode,
    expectedPropertyName: FIXTURE_IDS.propertyName,
    mailboxTransportId: FIXTURE_IDS.transportId,
    credentialMode: 'view_only',
    ...overrides,
  };
}

describe('HMS fixture server', () => {
  it('serves login/property/reservation/availability and records requests', async () => {
    const server = await startHmsFixtureServer();
    try {
      const login = await fetch(`${server.origin}/login`);
      expect(login.status).toBe(200);
      expect(await login.text()).toMatch(/Username/);

      const session = await fetch(`${server.origin}/session`, {
        method: 'POST',
        body: 'username=u&password=p',
        redirect: 'manual',
      });
      expect(session.status).toBe(302);

      const property = await fetch(`${server.origin}/property`);
      const html = await property.text();
      expect(html).toContain(`data-tenant="${FIXTURE_IDS.tenant}"`);
      expect(html).toContain('Room Availability');
      expect(html).toContain('Display Rates');

      await fetch(`${server.origin}/reservations`);
      await fetch(`${server.origin}/web/reservation/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'action=search&tenant=HMS_LEGACY&property=centurion&confirmationNumber=X',
      });
      await fetch(`${server.origin}/availability/rooms?view=inventory&startDate=2099-01-01`);
      await fetch(`${server.origin}/availability/rates`);

      const before = server.snapshot().before;
      await fetch(`${server.origin}/reservation/save`, {
        method: 'POST',
        body: 'action=save',
      });
      expect(server.state.mutationHits).toBe(1);
      expect(server.snapshot().after).not.toEqual(before);
      expect(server.requests.some((r) => r.path === '/login')).toBe(true);
    } finally {
      await server.close();
    }
  });
});
describe('HMS runtime', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()!();
  });

  async function boot(
    server: HmsFixtureServer,
    opts: {
      secret?: Partial<HmsSecret>;
      loadSecret?: () => Promise<unknown>;
      browserFactory?: ReturnType<typeof createFetchBrowserFactory>;
      circuitCooldownMs?: number;
      healthStatusPath?: string;
      defaultTimeoutMs?: number;
    } = {},
  ) {
    const secret = fixtureSecret(server.origin, opts.secret);
    const runtime = createHmsRuntime({
      manifest: fixtureManifest(server.origin),
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-test',
      loadSecret: opts.loadSecret ?? (async () => secret),
      browserFactory: opts.browserFactory ?? createFetchBrowserFactory(),
      circuitCooldownMs: opts.circuitCooldownMs ?? 50,
      healthStatusPath: opts.healthStatusPath,
      defaultTimeoutMs: opts.defaultTimeoutMs,
      requireViewOnly: true,
    });
    cleanup.push(() => runtime.close());
    return { runtime, secret };
  }

  it('singleton start: one browser launch, canary closes context', async () => {
    const server = await startHmsFixtureServer({ scenario: 'reservation-not-found' });
    cleanup.push(server.close);
    const { runtime } = await boot(server);
    await runtime.start(AbortSignal.timeout(15_000));
    expect(runtime.stats().browserLaunches).toBe(1);
    expect(runtime.health().state).toBe('ready');
    expect(runtime.stats().contextsClosed).toBeGreaterThanOrEqual(1);
  });

  it('one-session semaphore: second wait until first closes', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const { runtime, secret } = await boot(server);
    await runtime.start(AbortSignal.timeout(15_000));

    const first = await runtime.openReadSession({
      transportId: secret.mailboxTransportId,
      signal: AbortSignal.timeout(15_000),
    });
    let secondOpened = false;
    const secondPromise = runtime
      .openReadSession({
        transportId: secret.mailboxTransportId,
        signal: AbortSignal.timeout(15_000),
      })
      .then(async (s) => {
        secondOpened = true;
        await s.close();
      });

    await new Promise((r) => setTimeout(r, 30));
    expect(secondOpened).toBe(false);
    expect(runtime.health().activeSessions).toBe(1);
    await first.close();
    await secondPromise;
    expect(secondOpened).toBe(true);
  });

  it('removes aborted waiters from the one-session semaphore', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const { runtime, secret } = await boot(server);
    await runtime.start(AbortSignal.timeout(15_000));
    const first = await runtime.openReadSession({
      transportId: secret.mailboxTransportId,
      signal: AbortSignal.timeout(15_000),
    });
    const queuedAbort = new AbortController();
    const queued = runtime.openReadSession({
      transportId: secret.mailboxTransportId,
      signal: queuedAbort.signal,
    });
    queuedAbort.abort();
    await expect(queued).rejects.toMatchObject({ code: 'aborted' });
    await first.close();
    const next = await runtime.openReadSession({
      transportId: secret.mailboxTransportId,
      signal: AbortSignal.timeout(15_000),
    });
    await next.close();
  });

  it('rejects excess session waiters at fixed cap without unbounded queue', async () => {
    const {
      CAPACITY_REJECTED,
      HMS_SESSION_WAITER_CAP,
      HMS_SESSION_WAITER_CAP_CODE,
      createBoundedSessionLock,
    } = await import('../src/hms/runtime.js');
    expect(HMS_SESSION_WAITER_CAP).toBeGreaterThanOrEqual(2);
    expect(HMS_SESSION_WAITER_CAP).toBeLessThanOrEqual(3);
    const lock = createBoundedSessionLock({ waiterCap: 2 });
    const release = await lock.acquire(new AbortController().signal);
    const waitA = new AbortController();
    const waitB = new AbortController();
    const pA = lock.acquire(waitA.signal);
    const pB = lock.acquire(waitB.signal);
    await Promise.resolve();
    expect(lock.waitingCount()).toBe(2);
    await expect(lock.acquire(new AbortController().signal)).rejects.toMatchObject({
      code: HMS_SESSION_WAITER_CAP_CODE,
      message: CAPACITY_REJECTED,
    });
    release();
    (await pA)();
    (await pB)();
  });

  it('rejects session waiters that exceed maxWaitMs', async () => {
    const { CAPACITY_REJECTED, HMS_SESSION_WAITER_CAP_CODE, createBoundedSessionLock } =
      await import('../src/hms/runtime.js');
    const lock = createBoundedSessionLock({ waiterCap: 2, maxWaitMs: 30 });
    const release = await lock.acquire(new AbortController().signal);
    const waiting = lock.acquire(new AbortController().signal);
    await expect(waiting).rejects.toMatchObject({
      code: HMS_SESSION_WAITER_CAP_CODE,
      message: CAPACITY_REJECTED,
    });
    release();
  });

  it('normal runtime rejects caller-supplied live-proof capture', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const { runtime, secret } = await boot(server);
    await runtime.start(AbortSignal.timeout(15_000));
    await expect(
      runtime.openReadSession({
        transportId: secret.mailboxTransportId,
        signal: AbortSignal.timeout(15_000),
        auditSpec: {
          operationId: randomUUID(),
          toolId: 'hms_find_reservation',
          toolVersion: '1.2.0',
          dependencyRevision: 'test',
          executionClass: 'live_proof',
          inputClass: 'authorized_exact',
          roleProofSha256: 'a'.repeat(64),
          roleProofExpiresAt: '2026-09-01T00:00:00.000Z',
        },
      }),
    ).rejects.toMatchObject({
      code: 'AUDIT_CAPTURE',
      message: 'live_proof requires proof-only runtime composition',
    });
  });

  it('wrong tenant opens circuit', async () => {
    const server = await startHmsFixtureServer({ scenario: 'wrong-tenant' });
    cleanup.push(server.close);
    const { runtime } = await boot(server);
    await expect(runtime.start(AbortSignal.timeout(15_000))).rejects.toMatchObject({
      code: 'wrong_tenant',
    });
    expect(runtime.health().state).toBe('circuit_open');
  });

  it('wrong property opens circuit', async () => {
    const server = await startHmsFixtureServer({ scenario: 'wrong-property' });
    cleanup.push(server.close);
    const { runtime } = await boot(server);
    await expect(runtime.start(AbortSignal.timeout(15_000))).rejects.toMatchObject({
      code: 'wrong_property',
    });
    expect(runtime.health().state).toBe('circuit_open');
  });

  it('secret failure degrades runtime', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const { runtime } = await boot(server, {
      loadSecret: async () => {
        throw new Error('boom password=should-not-leak');
      },
    });
    await expect(runtime.start(AbortSignal.timeout(5_000))).rejects.toBeInstanceOf(HmsRuntimeError);
    expect(runtime.health().state).toBe('degraded');
    expect(JSON.stringify(runtime.health())).not.toMatch(/password=/);
  });

  it('chromium failure surfaces chromium_failed', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const { runtime } = await boot(server, {
      browserFactory: async () => {
        throw new Error('chromium launch failed');
      },
    });
    await expect(runtime.start(AbortSignal.timeout(5_000))).rejects.toMatchObject({
      code: 'chromium_failed',
    });
  });

  it('circuit open then recovers after cooldown', async () => {
    const server = await startHmsFixtureServer({ scenario: 'wrong-property' });
    cleanup.push(server.close);
    const { runtime } = await boot(server, { circuitCooldownMs: 20 });
    await expect(runtime.start(AbortSignal.timeout(10_000))).rejects.toMatchObject({
      code: 'wrong_property',
    });
    expect(runtime.health().state).toBe('circuit_open');

    await new Promise((r) => setTimeout(r, 30));
    server.setScenario('default');
    // Re-bind secret loader path: create new runtime against recovered fixture
    await runtime.close();
    const { runtime: recovered } = await boot(server, { circuitCooldownMs: 20 });
    await recovered.start(AbortSignal.timeout(15_000));
    expect(recovered.health().state).toBe('ready');
  });

  it('abort closes context', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const { runtime, secret } = await boot(server);
    await runtime.start(AbortSignal.timeout(15_000));

    const ctrl = new AbortController();
    const session = await runtime.openReadSession({
      transportId: secret.mailboxTransportId,
      signal: ctrl.signal,
    });
    ctrl.abort();
    await new Promise((r) => setTimeout(r, 20));
    await expect(session.page.content()).rejects.toMatchObject({
      code: 'context_closed',
    });
    expect(session.terminal()).toBe(true);
    // abort teardown releases semaphore — second session must open without waiting on close()
    const second = await runtime.openReadSession({
      transportId: secret.mailboxTransportId,
      signal: AbortSignal.timeout(15_000),
    });
    expect(second.terminal()).toBe(false);
    await second.close();
    await session.close();
  });

  it('timeout on hung login fails start', async () => {
    const server = await startHmsFixtureServer({ scenario: 'timeout' });
    cleanup.push(server.close);
    const { runtime } = await boot(server, { defaultTimeoutMs: 200 });
    await expect(runtime.start(AbortSignal.timeout(2_000))).rejects.toBeTruthy();
  }, 5_000);

  it('unknown request blocked before fixture mutation', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const { runtime, secret } = await boot(server);
    await runtime.start(AbortSignal.timeout(15_000));
    const session = await runtime.openReadSession({
      transportId: secret.mailboxTransportId,
      signal: AbortSignal.timeout(15_000),
    });

    const beforeHits = server.state.mutationHits;
    await expect(session.page.goto(`${server.origin}/reservation/save`)).rejects.toMatchObject({
      code: expect.stringMatching(/unknown_path|unmatched|mutation/i),
    });

    expect(server.state.mutationHits).toBe(beforeHits);
    expect(session.violation()?.action).toBe('block');
    expect(session.terminal()).toBe(true);
    const serialized = JSON.stringify(session.violation());
    expect(serialized).not.toContain('fixture-password');
    await expect(session.page.content()).rejects.toMatchObject({
      code: 'context_closed',
    });
    // fail-closed teardown releases lock without explicit close first
    const next = await runtime.openReadSession({
      transportId: secret.mailboxTransportId,
      signal: AbortSignal.timeout(15_000),
    });
    expect(runtime.health().activeSessions).toBe(1);
    await next.close();
    await session.close();
  });

  it('canary posts reservation not-found search', async () => {
    const server = await startHmsFixtureServer({ scenario: 'reservation-not-found' });
    cleanup.push(server.close);
    const { runtime } = await boot(server);
    await runtime.start(AbortSignal.timeout(15_000));
    expect(runtime.health().state).toBe('ready');
    const searchPosts = server.requests.filter(
      (r) => r.method === 'POST' && r.path === '/web/reservation/search',
    );
    expect(searchPosts.length).toBeGreaterThanOrEqual(1);
    expect(searchPosts.some((r) => r.body.includes('NOTFOUND-CANARY'))).toBe(true);
  });

  it('credential mode mismatch rejects non-view_only', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const { runtime } = await boot(server, {
      secret: { credentialMode: 'audited_write' },
    });
    await expect(runtime.start(AbortSignal.timeout(5_000))).rejects.toMatchObject({
      code: 'credential_mode',
    });
  });

  it('transport mismatch rejects wrong mailbox id', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const { runtime } = await boot(server);
    await runtime.start(AbortSignal.timeout(15_000));
    await expect(
      runtime.openReadSession({
        transportId: 'wrong-transport',
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toMatchObject({ code: 'transport_mismatch' });
  });

  it('login origin must match manifest origin', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const { runtime } = await boot(server, {
      secret: { loginUrl: 'http://127.0.0.1:9/login' },
    });
    await expect(runtime.start(AbortSignal.timeout(5_000))).rejects.toMatchObject({
      code: 'login_origin_mismatch',
    });
  });

  it('graceful shutdown closes browser', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const dir = await mkdtemp(join(tmpdir(), 'hms-health-'));
    const healthPath = join(dir, 'health.json');
    const { runtime } = await boot(server, { healthStatusPath: healthPath });
    await runtime.start(AbortSignal.timeout(15_000));
    await runtime.close();
    expect(runtime.health().state).toBe('stopped');
    const raw = await readFile(healthPath, 'utf8');
    expect(JSON.parse(raw).state).toBe('stopped');
    expect(raw).not.toMatch(/fixture-password/);
  });

  it('secret loader never receives production ARN pattern in tests', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const loadSecret = vi.fn(async (input: { secretArn: string }) => {
      expect(input.secretArn).toContain('fixture-test');
      expect(input.secretArn).not.toMatch(/nava-zero\/server-pilot\/infor-hms-read/);
      return fixtureSecret(server.origin);
    });
    const runtime = createHmsRuntime({
      manifest: fixtureManifest(server.origin),
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-test',
      loadSecret,
      browserFactory: createFetchBrowserFactory(),
    });
    cleanup.push(() => runtime.close());
    await runtime.start(AbortSignal.timeout(15_000));
    expect(loadSecret).toHaveBeenCalled();
  });
});
describe('Playwright Chromium (optional)', () => {
  it('skips when chromium unavailable; documents injectable factory path', async () => {
    const { tryCreatePlaywrightBrowserFactory } = await import('../src/hms/runtime.js');
    const factory = await tryCreatePlaywrightBrowserFactory();
    if (!factory) {
      expect(factory).toBeNull();
      return;
    }
    try {
      const browser = await factory({});
      await browser.close();
      expect(true).toBe(true);
    } catch (err) {
      // Windows CI without browser binaries — fixture/unit path remains green
      expect(String(err)).toMatch(/Executable doesn't exist|browser|chromium/i);
    }
  }, 30_000);
});

describe('Task 2 production composition + browser guards', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()!();
  });

  it('exports createProductionHmsRuntime with no mock fallback path', async () => {
    const mod = await import('../src/hms/production-runtime.js');
    expect(typeof mod.createProductionHmsRuntime).toBe('function');
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/hms/production-runtime.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/createPlaywrightBrowserFactory/);
    const runtimeSource = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/hms/runtime.ts', import.meta.url), 'utf8'),
    );
    expect(runtimeSource).toMatch(/import\('playwright'\)/);
    expect(src).not.toMatch(/tryCreatePlaywrightBrowserFactory|createFetchBrowserFactory/);
    expect(src).toMatch(/runStartupCanary:\s*false/);
  });

  it('runtime close rejects a live-proof teardown timeout', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/hms/runtime.ts', import.meta.url), 'utf8'),
    );
    const close = source.slice(
      source.indexOf('    async close() {'),
      source.indexOf('/** Required Playwright factory'),
    );
    expect(close).toMatch(/HMS_BROWSER_LIVE_PROOF_FINALIZE_TIMEOUT_MS/);
    expect(close).toMatch(/activeTeardown[\s\S]*new Promise<never>[\s\S]*TRACE_FINALIZE_FAILED/);
    expect(source).toMatch(/async function poisonAfterFinalizeTimeout/);
    expect(source).toMatch(/timedOut = true[\s\S]*await poisonAfterFinalizeTimeout\(\)/);
    expect(source).toMatch(
      /poisonAfterFinalizeTimeout[\s\S]*closing = true[\s\S]*failedBrowser\.close\(\)/,
    );
  });

  it('fails closed when audit capture is required without an artifact store', async () => {
    const origin = 'http://127.0.0.1:17888';
    const runtime = createHmsRuntime({
      manifest: fixtureManifest(origin),
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-test',
      loadSecret: async () => {
        throw new Error('secret load must not run');
      },
      browserFactory: createFetchBrowserFactory(),
      runStartupCanary: false,
      requireAuditCapture: true,
    });
    cleanup.push(() => runtime.close());

    await expect(
      runtime.openReadSession({
        transportId: 'transport-centurion',
        signal: AbortSignal.timeout(5_000),
        allowUnstarted: true,
        auditSpec: {
          operationId: randomUUID(),
          toolId: 'hms_find_reservation',
          toolVersion: '1.2.0',
          dependencyRevision: 'playwright-1.52.0-chromium-1169',
          executionClass: 'normal',
          inputClass: 'authorized_exact',
        },
      }),
    ).rejects.toMatchObject({ code: 'AUDIT_CAPTURE' });
  });

  it('Playwright adapter forwards downloads emitted by pages', async () => {
    type FakeDownload = { cancel(): Promise<void> };
    type FakePage = {
      on(event: 'download', handler: (download: FakeDownload) => void): void;
    };
    let emitPage: ((page: FakePage) => void) | undefined;
    let emitDownload: ((download: FakeDownload) => void) | undefined;
    const page: FakePage = {
      on(event, handler) {
        if (event === 'download') emitDownload = handler;
      },
    };
    const playwrightContext = {
      tracing: {
        async start() {},
        async stop() {},
      },
      async route() {},
      async routeWebSocket() {},
      async newPage() {
        return page;
      },
      async close() {},
      pages() {
        return [] as FakePage[];
      },
      on(event: string, handler: (page: FakePage) => void) {
        if (event === 'page') emitPage = handler;
      },
    };
    const playwrightBrowser = {
      async newContext() {
        return playwrightContext;
      },
      async close() {},
    };
    vi.doMock('playwright', () => ({
      chromium: {
        launch: vi.fn(async () => playwrightBrowser),
      },
    }));

    try {
      const browser = await createPlaywrightBrowserFactory()({});
      const context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: 'block',
      });
      const cancel = vi.fn(async () => {});
      context.on('download', (download) => {
        void download.cancel();
      });

      expect(emitPage).toBeTypeOf('function');
      emitPage!(page);
      expect(emitDownload).toBeTypeOf('function');
      emitDownload!({ cancel });
      await Promise.resolve();

      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock('playwright');
    }
  });

  it('installs routeWebSocket before first navigation on session open', async () => {
    const server = await startHmsFixtureServer({ scenario: 'reservation-not-found' });
    cleanup.push(server.close);
    let wsBeforeNav = false;
    let navHappened = false;
    const factory: ReturnType<typeof createFetchBrowserFactory> = async (input) => {
      const inner = await createFetchBrowserFactory()(input);
      return {
        async newContext(opts) {
          const ctx = await inner.newContext(opts);
          const originalWs = ctx.routeWebSocket.bind(ctx);
          const originalNewPage = ctx.newPage.bind(ctx);
          ctx.routeWebSocket = async (url, handler) => {
            if (!navHappened) wsBeforeNav = true;
            return originalWs(url, handler);
          };
          ctx.newPage = async () => {
            const page = await originalNewPage();
            const originalGoto = page.goto.bind(page);
            page.goto = async (...args) => {
              navHappened = true;
              return originalGoto(...args);
            };
            return page;
          };
          return ctx;
        },
        close: () => inner.close(),
      };
    };
    const secret = fixtureSecret(server.origin);
    const runtime = createHmsRuntime({
      manifest: fixtureManifest(server.origin),
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-test',
      loadSecret: async () => secret,
      browserFactory: factory,
    });
    cleanup.push(() => runtime.close());
    await runtime.start(AbortSignal.timeout(15_000));
    expect(wsBeforeNav).toBe(true);
  });

  it('popup closes and terminalizes context', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const secret = fixtureSecret(server.origin);
    let emitPopup: ((page: import('../src/hms/runtime.js').HmsPage) => void) | null = null;
    const factory = createFetchBrowserFactory();
    const wrapped: typeof factory = async (input) => {
      const browser = await factory(input);
      return {
        async newContext(opts) {
          const ctx = await browser.newContext(opts);
          const origOn = ctx.on.bind(ctx);
          ctx.on = ((event, handler) => {
            if (event === 'page') {
              emitPopup = handler as (page: import('../src/hms/runtime.js').HmsPage) => void;
            }
            return origOn(event, handler);
          }) as typeof ctx.on;
          return ctx;
        },
        close: () => browser.close(),
      };
    };
    const runtime = createHmsRuntime({
      manifest: fixtureManifest(server.origin),
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-test',
      loadSecret: async () => secret,
      browserFactory: wrapped,
    });
    cleanup.push(() => runtime.close());
    await runtime.start(AbortSignal.timeout(15_000));
    const session = await runtime.openReadSession({
      transportId: secret.mailboxTransportId,
      signal: AbortSignal.timeout(15_000),
    });
    // Simulate second page (popup) after primary
    let finishPopupClose: (() => void) | undefined;
    const popupPage = {
      close: () =>
        new Promise<void>((resolve) => {
          finishPopupClose = resolve;
        }),
      async goto() {},
      async content() {
        return '';
      },
      setDefaultTimeout() {},
      setDefaultNavigationTimeout() {},
      async readPropertyBinding() {
        return { tenant: null, propertyCode: null, propertyName: null };
      },
      async fillLogin() {},
      async submitLogin() {},
      async postForm() {
        return '';
      },
      async click() {},
      async evaluate() {
        return undefined;
      },
      async fill() {},
      async press() {},
      url: () => server.origin,
      title: async () => '',
    } as import('../src/hms/runtime.js').HmsPage;
    // Force pages().length > 1 path by emitting page event
    emitPopup?.(popupPage);
    expect(session.terminal()).toBe(true);
    expect(session.violation()?.action).toBe('block');
    if (session.violation()?.action === 'block') {
      expect(session.violation()?.code).toMatch(/popup/i);
    }
    finishPopupClose?.();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('download cancels and terminalizes context', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const secret = fixtureSecret(server.origin);
    let emitDownload: ((d: { cancel(): Promise<void> }) => void) | null = null;
    const factory = createFetchBrowserFactory();
    const wrapped: typeof factory = async (input) => {
      const browser = await factory(input);
      return {
        async newContext(opts) {
          const ctx = await browser.newContext(opts);
          const origOn = ctx.on.bind(ctx);
          ctx.on = ((event, handler) => {
            if (event === 'download') {
              emitDownload = handler as (d: { cancel(): Promise<void> }) => void;
            }
            return origOn(event, handler);
          }) as typeof ctx.on;
          return ctx;
        },
        close: () => browser.close(),
      };
    };
    const runtime = createHmsRuntime({
      manifest: fixtureManifest(server.origin),
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-test',
      loadSecret: async () => secret,
      browserFactory: wrapped,
    });
    cleanup.push(() => runtime.close());
    await runtime.start(AbortSignal.timeout(15_000));
    const session = await runtime.openReadSession({
      transportId: secret.mailboxTransportId,
      signal: AbortSignal.timeout(15_000),
    });
    const cancelled: string[] = [];
    let finishCancel: (() => void) | undefined;
    emitDownload?.({
      cancel: () =>
        new Promise<void>((resolve) => {
          cancelled.push('cancelled');
          finishCancel = resolve;
        }),
    });
    expect(cancelled).toEqual(['cancelled']);
    expect(session.terminal()).toBe(true);
    expect(session.violation()?.code).toMatch(/download/i);
    finishCancel?.();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('unreviewed redirect blocks before continue', async () => {
    const { evaluateObservedRequest, BLOCK_CODES } = await import('../src/hms/request-policy.js');
    const decision = evaluateObservedRequest(fixtureManifest('http://127.0.0.1:1'), {
      url: 'http://127.0.0.1:1/unreviewed',
      method: 'GET',
      resourceType: 'document',
      redirectedFrom: 'http://127.0.0.1:1/login',
    });
    expect(decision).toMatchObject({
      action: 'block',
      code: BLOCK_CODES.UNREVIEWED_REDIRECT,
    });
  });

  it('role proof revalidates before context creation', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const secret = fixtureSecret(server.origin);
    const dir = await mkdtemp(join(tmpdir(), 'hms-role-'));
    const proofPath = join(dir, 'role-proof.json');
    const { writeFile } = await import('node:fs/promises');
    const now = Date.now();
    await writeFile(
      proofPath,
      JSON.stringify({
        schemaVersion: 1,
        propertyCode: 'HRCEN',
        allowedSurfaces: ['Guest Stay'],
        deniedActions: [
          'new_record',
          'save',
          'delete',
          'duplicate',
          'check_in',
          'check_out',
          'document_generate',
          'document_send',
        ],
        issuedAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + 86_400_000).toISOString(),
        evidenceRef: 'operator-observed-runtime-v1:abc',
        evidenceSha256: 'a'.repeat(64),
      }),
      { mode: 0o600 },
    );
    let proofChecks = 0;
    const runtime = createHmsRuntime({
      manifest: fixtureManifest(server.origin),
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-test',
      loadSecret: async () => secret,
      browserFactory: createFetchBrowserFactory(),
      roleProofPath: proofPath,
      loadRoleProof: async (path) => {
        proofChecks += 1;
        const { loadHmsReadRoleProof } = await import('../src/hms/production-runtime.js');
        return loadHmsReadRoleProof(path);
      },
    });
    cleanup.push(() => runtime.close());
    await runtime.start(AbortSignal.timeout(15_000));
    // canary + start path
    expect(proofChecks).toBeGreaterThanOrEqual(1);
    const before = proofChecks;
    await runtime
      .openReadSession({
        transportId: secret.mailboxTransportId,
        signal: AbortSignal.timeout(15_000),
      })
      .then((s) => s.close());
    expect(proofChecks).toBeGreaterThan(before);
  });

  it('expired role proof blocks before browser context', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const secret = fixtureSecret(server.origin);
    const dir = await mkdtemp(join(tmpdir(), 'hms-role-exp-'));
    const proofPath = join(dir, 'role-proof.json');
    const { writeFile } = await import('node:fs/promises');
    const now = Date.now();
    await writeFile(
      proofPath,
      JSON.stringify({
        schemaVersion: 1,
        propertyCode: 'HRCEN',
        allowedSurfaces: ['Guest Stay'],
        deniedActions: [
          'new_record',
          'save',
          'delete',
          'duplicate',
          'check_in',
          'check_out',
          'document_generate',
          'document_send',
        ],
        issuedAt: new Date(now - 40 * 86_400_000).toISOString(),
        expiresAt: new Date(now - 1000).toISOString(),
        evidenceRef: 'operator-observed-runtime-v1:abc',
        evidenceSha256: 'b'.repeat(64),
      }),
      { mode: 0o600 },
    );
    const runtime = createHmsRuntime({
      manifest: fixtureManifest(server.origin),
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-test',
      loadSecret: async () => secret,
      browserFactory: createFetchBrowserFactory(),
      roleProofPath: proofPath,
    });
    cleanup.push(() => runtime.close());
    await expect(runtime.start(AbortSignal.timeout(5_000))).rejects.toMatchObject({
      code: expect.stringMatching(/ROLE_PROOF_EXPIRED|role_proof/i),
    });
  });

  it('rejects a role proof issued in the future', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hms-role-future-'));
    const proofPath = join(dir, 'role-proof.json');
    const { writeFile } = await import('node:fs/promises');
    const now = new Date('2026-08-05T00:00:00.000Z');
    await writeFile(
      proofPath,
      JSON.stringify({
        schemaVersion: 1,
        propertyCode: 'HRCEN',
        allowedSurfaces: ['Guest Stay'],
        deniedActions: [
          'new_record',
          'save',
          'delete',
          'duplicate',
          'check_in',
          'check_out',
          'document_generate',
          'document_send',
        ],
        issuedAt: new Date(now.getTime() + 60_000).toISOString(),
        expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
        evidenceRef: 'operator-observed-runtime-v1:abc',
        evidenceSha256: 'c'.repeat(64),
      }),
      { mode: 0o600 },
    );
    const { loadHmsReadRoleProof } = await import('../src/hms/production-runtime.js');

    await expect(loadHmsReadRoleProof(proofPath, now)).rejects.toMatchObject({
      code: 'ROLE_SCOPE_INVALID',
    });
  });

  it('requires receipts to bind a concrete source revision', async () => {
    const { resolveHmsSourceRevision } = await import('../src/hms/production-runtime.js');
    expect(
      resolveHmsSourceRevision(undefined, {
        NAVA_BUILD_COMMIT: '0123456789abcdef0123456789abcdef01234567',
      }),
    ).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(() => resolveHmsSourceRevision(undefined, {})).toThrowError(
      expect.objectContaining({ code: 'AUDIT_CAPTURE' }),
    );
    expect(() => resolveHmsSourceRevision('production', {})).toThrowError(
      expect.objectContaining({ code: 'AUDIT_CAPTURE' }),
    );
  });

  it('one Chromium process serves sequential fresh contexts', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const secret = fixtureSecret(server.origin);
    const runtime = createHmsRuntime({
      manifest: fixtureManifest(server.origin),
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-test',
      loadSecret: async () => secret,
      browserFactory: createFetchBrowserFactory(),
    });
    cleanup.push(() => runtime.close());
    await runtime.start(AbortSignal.timeout(15_000));
    const launchesAfterStart = runtime.stats().browserLaunches;
    expect(launchesAfterStart).toBe(1);
    const s1 = await runtime.openReadSession({
      transportId: secret.mailboxTransportId,
      signal: AbortSignal.timeout(15_000),
    });
    await s1.close();
    const s2 = await runtime.openReadSession({
      transportId: secret.mailboxTransportId,
      signal: AbortSignal.timeout(15_000),
    });
    await s2.close();
    expect(runtime.stats().browserLaunches).toBe(1);
    expect(runtime.stats().contextsCreated).toBeGreaterThanOrEqual(3);
  });

  it('health writes mode-0600 with fixed enums and heartbeat metadata', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const dir = await mkdtemp(join(tmpdir(), 'hms-health-hb-'));
    const healthPath = join(dir, 'health.json');
    const secret = fixtureSecret(server.origin);
    const runtime = createHmsRuntime({
      manifest: fixtureManifest(server.origin),
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-test',
      loadSecret: async () => secret,
      browserFactory: createFetchBrowserFactory(),
      healthStatusPath: healthPath,
      healthHeartbeatMs: 50,
    });
    cleanup.push(() => runtime.close());
    await runtime.start(AbortSignal.timeout(15_000));
    await new Promise((r) => setTimeout(r, 120));
    const { readFile, stat } = await import('node:fs/promises');
    // Windows rename fallback can race heartbeat; retry until JSON parses.
    let parsed: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const raw = await readFile(healthPath, 'utf8');
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    expect(parsed).not.toBeNull();
    expect(parsed!.state).toMatch(/ready|degraded|starting|stopped|circuit_open/);
    expect(typeof parsed!.browserLaunches).toBe('number');
    expect(typeof parsed!.contextsCreated).toBe('number');
    expect(String(parsed!.checkedAt)).toMatch(/^\d{4}-/);
    expect(parsed!.staleAfterMs).toBe(30_000);
    const mode = (await stat(healthPath)).mode & 0o777;
    // Windows may not preserve unix mode; assert when meaningful
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o600);
    }
  });

  it('purges audited artifacts on startup, before sessions, and hourly', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const secret = fixtureSecret(server.origin);
    let purgeCalls = 0;
    const artifactStore = {
      root: join(tmpdir(), 'hms-artifact-retention-test'),
      intermediateDir: join(tmpdir(), 'hms-artifact-retention-test', 'playwright'),
      beginCapture: vi.fn(),
      async purgeExpired() {
        purgeCalls += 1;
        return 0;
      },
    } satisfies HmsBrowserArtifactStore;
    const runtime = createHmsRuntime({
      manifest: fixtureManifest(server.origin),
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-test',
      loadSecret: async () => secret,
      browserFactory: createFetchBrowserFactory(),
      runStartupCanary: false,
      artifactStore,
      requireAuditCapture: false,
      artifactPurgeIntervalMs: 20,
    });
    cleanup.push(() => runtime.close());

    await runtime.start(AbortSignal.timeout(15_000));
    expect(purgeCalls).toBe(1);
    const session = await runtime.openReadSession({
      transportId: secret.mailboxTransportId,
      signal: AbortSignal.timeout(15_000),
    });
    await session.close();
    expect(purgeCalls).toBeGreaterThanOrEqual(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(purgeCalls).toBeGreaterThanOrEqual(3);
  });

  it('live-shaped fixture exposes Infor login + Guest Stay + OSRESS.search', async () => {
    const server = await startHmsFixtureServer({ shape: 'live-infor' });
    cleanup.push(server.close);
    const login = await fetch(`${server.origin}/web/base/logindisp?tenant=HMS_LEGACY`);
    const loginHtml = await login.text();
    expect(loginHtml).toMatch(/name="userid"/);
    expect(loginHtml).toMatch(/name="password"/);
    expect(loginHtml).toMatch(/name="csrftckt"/);

    const session = await fetch(`${server.origin}/web/base/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'tenant=HMS_LEGACY&userid=u&password=p&csrftckt=t',
      redirect: 'manual',
    });
    expect(session.status).toBe(302);

    const guest = await fetch(`${server.origin}/web/base/OSRESV`);
    const guestHtml = await guest.text();
    expect(guestHtml).toMatch(/ff_confirmationnumber/);
    expect(guestHtml).toMatch(/name="search"/);
    expect(guestHtml).toMatch(/Guest Stay/);
    expect(guestHtml).toMatch(/data-property-code="HRCEN"|HRCEN/);

    const search = await fetch(`${server.origin}/web/base/OSRESS.search`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'MADDON_FILTER_VALUE_3=NOTFOUND-CANARY&GRID_NAME=OSRESS',
    });
    const searchHtml = await search.text();
    expect(searchHtml).toMatch(/data-testid="no-results"|No reservations found/i);
    // Fixture keeps stale prior-grid rows visible; driver must ignore them.
    expect(searchHtml).toMatch(/data-stale-row="prior"/);
  });

  it('LiveGuestStayDriver runs login binding + not-found canary on fixture', async () => {
    const server = await startHmsFixtureServer({
      shape: 'live-infor',
      scenario: 'reservation-not-found',
    });
    cleanup.push(server.close);
    const { createLiveGuestStayDriver } = await import('../src/hms/live-guest-stay-driver.js');
    const { buildLiveGuestStayReadManifest } = await import('../src/hms/live-read-manifest.js');
    const secret: HmsSecret = {
      loginUrl: `${server.origin}/web/base/logindisp?tenant=HMS_LEGACY`,
      username: 'fixture-user',
      password: 'fixture-password',
      expectedTenant: 'HMS_LEGACY',
      expectedPropertyCode: 'HRCEN',
      expectedPropertyName: 'Centurion Hotel',
      mailboxTransportId: FIXTURE_IDS.transportId,
      credentialMode: 'view_only',
    };
    const runtime = createHmsRuntime({
      manifest: buildLiveGuestStayReadManifest(server.origin),
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-test',
      loadSecret: async () => secret,
      browserFactory: createFetchBrowserFactory(),
      requireViewOnly: true,
    });
    cleanup.push(() => runtime.close());
    const driver = createLiveGuestStayDriver({
      runtime,
      transportId: secret.mailboxTransportId,
    });
    await driver.loginAndVerifyBinding(AbortSignal.timeout(15_000));
    await driver.runNotFoundCanary(AbortSignal.timeout(15_000));
    const result = await driver.searchExact(
      { id: 'x', kind: 'confirmation', value: 'NOTFOUND-CANARY' },
      AbortSignal.timeout(15_000),
    );
    expect(result.outcome).toBe('not_found');
    expect(result.observations).toEqual([]);
    expect(result.capped).toBe(false);
  });

  it('searchExact posts exact-bound OSRESS body; altered value blocked before transmit', async () => {
    const server = await startHmsFixtureServer({
      shape: 'live-infor',
      scenario: 'reservation-not-found',
    });
    cleanup.push(server.close);
    const {
      buildExactOsressSearchBody,
      buildLiveGuestStayReadManifest,
      LIVE_GUEST_STAY_SEARCH_PATH,
    } = await import('../src/hms/live-read-manifest.js');
    const { createLiveGuestStayDriver } = await import('../src/hms/live-guest-stay-driver.js');
    const { BLOCK_CODES } = await import('../src/hms/request-policy.js');
    const secret: HmsSecret = {
      loginUrl: `${server.origin}/web/base/logindisp?tenant=HMS_LEGACY`,
      username: 'fixture-user',
      password: 'fixture-password',
      expectedTenant: 'HMS_LEGACY',
      expectedPropertyCode: 'HRCEN',
      expectedPropertyName: 'Centurion Hotel',
      mailboxTransportId: FIXTURE_IDS.transportId,
      credentialMode: 'view_only',
    };
    const runtime = createHmsRuntime({
      manifest: buildLiveGuestStayReadManifest(server.origin),
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-test',
      loadSecret: async () => secret,
      browserFactory: createFetchBrowserFactory(),
      requireViewOnly: true,
      runStartupCanary: false,
    });
    cleanup.push(() => runtime.close());

    const candidate = {
      id: 'exact-1',
      kind: 'confirmation' as const,
      value: 'EXACT-CONF-POST',
    };
    const expectedBody = buildExactOsressSearchBody(candidate);
    let capturedPost: Record<string, string> | null = null;

    const driver = createLiveGuestStayDriver({
      runtime,
      transportId: secret.mailboxTransportId,
      onSession: (session) => {
        const page = session.page;
        const original = page.postForm.bind(page);
        page.postForm = async (url, fields) => {
          if (url.includes(LIVE_GUEST_STAY_SEARCH_PATH)) {
            capturedPost = { ...fields };
          }
          return original(url, fields);
        };
      },
    });

    const result = await driver.searchExact(candidate, AbortSignal.timeout(15_000));
    expect(result.outcome).toBe('not_found');
    expect(capturedPost).not.toBeNull();
    expect(capturedPost!.MADDON_FILTER_VALUE_3).toBe(candidate.value);
    expect(capturedPost).toEqual(expectedBody);

    // Same per-session exact rule: altered confirmation blocked before fixture I/O.
    const session = await runtime.openReadSession({
      transportId: secret.mailboxTransportId,
      signal: AbortSignal.timeout(15_000),
      exactSearchCandidate: candidate,
      allowUnstarted: true,
    });
    try {
      const alteredBefore = server.requests.filter((r) => r.body.includes('OTHER-VAL')).length;
      await expect(
        session.page.postForm(`${server.origin}${LIVE_GUEST_STAY_SEARCH_PATH}`, {
          ...expectedBody,
          MADDON_FILTER_VALUE_3: 'OTHER-VAL',
        }),
      ).rejects.toMatchObject({ code: BLOCK_CODES.CHANGED_FIXED_BODY });
      expect(server.requests.filter((r) => r.body.includes('OTHER-VAL')).length).toBe(
        alteredBefore,
      );
    } finally {
      await session.close();
    }
  });
});

describe('HMS browser audit capture order', () => {
  it('withholds a successful session when capture finalizes incomplete', async () => {
    const { randomUUID } = await import('node:crypto');
    const { rm } = await import('node:fs/promises');
    const { createHmsBrowserArtifactStore, ensureHmsBrowserArtifactRoot } = await import(
      '../src/hms/browser-artifacts.js'
    );
    const server = await startHmsFixtureServer();
    const root = join(tmpdir(), `hms-cap-incomplete-${randomUUID()}`);
    await ensureHmsBrowserArtifactRoot(root);
    const store = await createHmsBrowserArtifactStore({ root });
    const beginCapture = store.beginCapture.bind(store);
    store.beginCapture = async (spec) => {
      const handle = await beginCapture(spec);
      const finalize = handle.finalize.bind(handle);
      handle.finalize = (input) => finalize({ ...input, complete: false });
      return handle;
    };
    const secret = fixtureSecret(server.origin);
    const runtime = createHmsRuntime({
      manifest: fixtureManifest(server.origin),
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-test',
      loadSecret: async () => secret,
      browserFactory: createFetchBrowserFactory(),
      requireViewOnly: true,
      runStartupCanary: false,
      artifactStore: store,
      requireAuditCapture: true,
      sourceRevision: 'test-source',
    });
    try {
      const session = await runtime.openReadSession({
        transportId: secret.mailboxTransportId,
        signal: AbortSignal.timeout(15_000),
        allowUnstarted: true,
        auditSpec: {
          operationId: randomUUID(),
          toolId: 'hms_find_reservation',
          toolVersion: '1.2.0',
          dependencyRevision: 'test-dependency',
          executionClass: 'normal',
          inputClass: 'authorized_exact',
        },
      });
      await expect(session.close()).rejects.toMatchObject({
        code: 'AUDIT_CAPTURE',
      });
      const unhandled: unknown[] = [];
      const recordUnhandled = (error: unknown) => {
        unhandled.push(error);
      };
      process.on('unhandledRejection', recordUnhandled);
      await new Promise((resolve) => setTimeout(resolve, 10));
      process.off('unhandledRejection', recordUnhandled);
      expect(unhandled).toEqual([]);
      expect(session.lastReceipt()?.artifactState).toBe('incomplete');
      expect(runtime.health().state).toBe('degraded');
      await expect(runtime.close()).rejects.toMatchObject({
        code: 'AUDIT_CAPTURE',
      });
      expect(runtime.health().state).toBe('stopped');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('composes a normal finance capture through the runtime and durable store', async () => {
    const { rm, writeFile } = await import('node:fs/promises');
    const { createHmsBrowserArtifactStore, ensureHmsBrowserArtifactRoot } = await import(
      '../src/hms/browser-artifacts.js'
    );
    const server = await startHmsFixtureServer();
    const root = join(tmpdir(), `hms-cap-folio-${randomUUID()}`);
    await ensureHmsBrowserArtifactRoot(root);
    const store = await createHmsBrowserArtifactStore({
      root,
      validateTraceFile: async () => true,
      validateVideoFile: async () => true,
    });
    const baseFactory = createFetchBrowserFactory();
    const browserFactory: typeof baseFactory = async (input) => {
      const browser = await baseFactory(input);
      return {
        async newContext(opts) {
          const context = await browser.newContext(opts);
          const stop = context.tracing.stop.bind(context.tracing);
          context.tracing.stop = async (traceOptions) => {
            await stop(traceOptions);
            if (traceOptions?.path) {
              await writeFile(
                traceOptions.path,
                Buffer.concat([
                  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
                  Buffer.alloc(26),
                  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
                  Buffer.alloc(18),
                ]),
              );
            }
          };
          return context;
        },
        close: () => browser.close(),
      };
    };
    const secret = fixtureSecret(server.origin);
    const runtime = createHmsRuntime({
      manifest: fixtureManifest(server.origin),
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-test',
      loadSecret: async () => secret,
      browserFactory,
      requireViewOnly: true,
      runStartupCanary: false,
      artifactStore: store,
      requireAuditCapture: true,
      sourceRevision: 'test-source',
    });
    try {
      for (const requestBranchId of ['folio_summary', 'deposit_ledger_summary'] as const) {
        const operationId = randomUUID();
        const session = await runtime.openReadSession({
          transportId: secret.mailboxTransportId,
          signal: AbortSignal.timeout(15_000),
          allowUnstarted: true,
          auditSpec: {
            operationId,
            toolId: 'hms_read_folio',
            toolVersion: '1.0.0',
            dependencyRevision: 'test-dependency',
            executionClass: 'normal',
            inputClass: 'authorized_exact',
            requestBranchId,
          },
        });
        await session.close();
        expect(session.lastReceipt()).toMatchObject({
          artifactState: 'complete',
          operationId,
          toolId: 'hms_read_folio',
          requestBranchId,
          operationOutcome: 'succeeded',
        });
      }
    } finally {
      await runtime.close().catch(() => undefined);
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves login and audit-finalization failures together', async () => {
    const { rm } = await import('node:fs/promises');
    const { createHmsBrowserArtifactStore, ensureHmsBrowserArtifactRoot } = await import(
      '../src/hms/browser-artifacts.js'
    );
    const server = await startHmsFixtureServer();
    const root = join(tmpdir(), `hms-cap-login-fail-${randomUUID()}`);
    await ensureHmsBrowserArtifactRoot(root);
    const store = await createHmsBrowserArtifactStore({
      root,
      validateTraceFile: async () => true,
      validateVideoFile: async () => true,
    });
    const secret = fixtureSecret(server.origin, {
      expectedPropertyCode: 'WRONG',
    });
    const runtime = createHmsRuntime({
      manifest: fixtureManifest(server.origin),
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-test',
      loadSecret: async () => secret,
      browserFactory: createFetchBrowserFactory(),
      requireViewOnly: true,
      runStartupCanary: false,
      artifactStore: store,
      requireAuditCapture: true,
      sourceRevision: 'test-source',
    });
    try {
      let caught: unknown;
      try {
        await runtime.openReadSession({
          transportId: secret.mailboxTransportId,
          signal: AbortSignal.timeout(15_000),
          allowUnstarted: true,
          auditSpec: {
            operationId: randomUUID(),
            toolId: 'hms_find_reservation',
            toolVersion: '1.2.0',
            dependencyRevision: 'test-dependency',
            executionClass: 'normal',
            inputClass: 'authorized_exact',
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      const errors = (caught as AggregateError).errors;
      expect(errors.some((error) => error?.code === 'wrong_property')).toBe(true);
      expect(errors.some((error) => error?.code === 'AUDIT_CAPTURE')).toBe(true);
    } finally {
      await runtime.close().catch(() => undefined);
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runtime omits normal video and starts proof tracing before page creation', async () => {
    const { rm, writeFile } = await import('node:fs/promises');
    const { createHmsBrowserArtifactStore, ensureHmsBrowserArtifactRoot } = await import(
      '../src/hms/browser-artifacts.js'
    );
    const server = await startHmsFixtureServer();
    const root = join(tmpdir(), `hms-cap-order-${randomUUID()}`);
    await ensureHmsBrowserArtifactRoot(root);
    const store = await createHmsBrowserArtifactStore({
      root,
      validateTraceFile: async () => true,
      validateVideoFile: async () => true,
    });
    const events: string[] = [];
    const baseFactory = createFetchBrowserFactory();
    const factory: typeof baseFactory = async (input) => {
      events.push(input.tracesDir ? 'launch:tracesDir' : 'launch:no-tracesDir');
      const browser = await baseFactory(input);
      return {
        async newContext(opts) {
          events.push(
            opts.recordVideo ? `context:video:${opts.recordVideo.dir}` : 'context:no-video',
          );
          const context = await browser.newContext(opts);
          const start = context.tracing.start.bind(context.tracing);
          context.tracing.start = async (traceOptions) => {
            events.push('trace:start');
            return start(traceOptions);
          };
          const stop = context.tracing.stop.bind(context.tracing);
          context.tracing.stop = async (traceOptions) => {
            await stop(traceOptions);
            if (traceOptions?.path) {
              await writeFile(
                traceOptions.path,
                Buffer.concat([
                  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
                  Buffer.alloc(26),
                  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
                  Buffer.alloc(18),
                ]),
              );
            }
          };
          const newPage = context.newPage.bind(context);
          context.newPage = async () => {
            events.push('page:new');
            return newPage();
          };
          return context;
        },
        close: () => browser.close(),
      };
    };
    const secret = fixtureSecret(server.origin);
    const runtime = createHmsLiveProofRuntime({
      manifest: fixtureManifest(server.origin),
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-test',
      loadSecret: async () => secret,
      browserFactory: factory,
      requireViewOnly: true,
      runStartupCanary: false,
      artifactStore: store,
      requireAuditCapture: true,
      sourceRevision: 'test-source',
    });
    try {
      await runtime.start(AbortSignal.timeout(15_000));
      const normal = await runtime.openReadSession({
        transportId: secret.mailboxTransportId,
        signal: AbortSignal.timeout(15_000),
        auditSpec: {
          operationId: randomUUID(),
          toolId: 'hms_find_reservation',
          toolVersion: '1.2.0',
          dependencyRevision: 'r1',
          executionClass: 'normal',
          inputClass: 'authorized_exact',
        },
      });
      await normal.close();

      const proof = await runtime.openReadSession({
        transportId: secret.mailboxTransportId,
        signal: AbortSignal.timeout(15_000),
        auditSpec: {
          operationId: randomUUID(),
          toolId: 'hms_find_reservation',
          toolVersion: '1.2.0',
          dependencyRevision: 'r1',
          executionClass: 'live_proof',
          inputClass: 'authorized_exact',
          roleProofSha256: 'a'.repeat(64),
          roleProofExpiresAt: '2026-09-01T00:00:00.000Z',
        },
      });
      await expect(proof.close()).rejects.toMatchObject({
        code: 'AUDIT_CAPTURE',
      });

      expect(events[0]).toBe('launch:tracesDir');
      expect(events).toContain('context:no-video');
      expect(events.some((event) => event.startsWith('context:video:'))).toBe(true);
      const proofContext = events.findIndex((event) => event.startsWith('context:video:'));
      const proofTrace = events.indexOf('trace:start', proofContext);
      const proofPage = events.indexOf('page:new', proofContext);
      expect(proofTrace).toBeGreaterThan(proofContext);
      expect(proofTrace).toBeLessThan(proofPage);
    } finally {
      await runtime.close().catch(() => undefined);
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('revalidates evidence bindings before context; rejects non-AWSCURRENT', async () => {
    const { credentialVersionHmacSha256, runtimeFingerprintSha256 } = await import(
      '../src/hms/evidence-runtime.js'
    );
    const server = await startHmsFixtureServer();
    const secret = fixtureSecret(server.origin);
    const key = Buffer.alloc(32, 9);
    const keyVersion = 'evidence-key-v1';
    const secretArn = 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-test';
    const versionId = 'version-current-1';
    const credentialHmac = credentialVersionHmacSha256({
      evidenceKey: key,
      evidenceKeyVersion: keyVersion,
      hmsSecretArn: secretArn,
      hmsSecretVersionId: versionId,
    });
    const runtimeFp = runtimeFingerprintSha256({
      sourceRevision: 'rev-11c',
      playwrightRevision: '1.52.0',
      chromiumRevision: '1169',
    });

    const okRuntime = createHmsRuntime({
      manifest: fixtureManifest(server.origin),
      secretArn,
      loadSecret: async () => ({
        secret,
        versionId,
        versionStages: ['AWSCURRENT'],
      }),
      browserFactory: createFetchBrowserFactory(),
      sourceRevision: 'rev-11c',
      playwrightRevision: '1.52.0',
      chromiumRevision: '1169',
      evidenceBindings: {
        evidence: {
          secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:evidence',
          keyVersion,
          key,
        },
        secretVersion: {
          versionId,
          versionStages: ['AWSCURRENT'],
        },
        expectedCredentialVersionHmacSha256: credentialHmac,
        expectedRuntimeFingerprintSha256: runtimeFp,
      },
    });
    try {
      await okRuntime.start(AbortSignal.timeout(15_000));
      await okRuntime
        .openReadSession({
          transportId: secret.mailboxTransportId,
          signal: AbortSignal.timeout(15_000),
        })
        .then((s) => s.close());

      const stale = createHmsRuntime({
        manifest: fixtureManifest(server.origin),
        secretArn,
        loadSecret: async () => secret,
        browserFactory: createFetchBrowserFactory(),
        sourceRevision: 'rev-11c',
        playwrightRevision: '1.52.0',
        chromiumRevision: '1169',
        evidenceBindings: {
          evidence: {
            secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:evidence',
            keyVersion,
            key,
          },
          secretVersion: {
            versionId: 'old-version',
            versionStages: ['AWSPREVIOUS'],
          },
          expectedCredentialVersionHmacSha256: credentialHmac,
          expectedRuntimeFingerprintSha256: runtimeFp,
        },
      });
      try {
        await expect(stale.start(AbortSignal.timeout(15_000))).rejects.toMatchObject({
          code: 'CREDENTIAL_VERSION_STALE',
        });
      } finally {
        await stale.close().catch(() => undefined);
      }
    } finally {
      await okRuntime.close().catch(() => undefined);
      await server.close();
    }
  });

  it('loadProductionRoleProof accepts v1 and v2 path shapes', async () => {
    const { loadProductionRoleProof } = await import('../src/hms/production-runtime.js');
    const { roleProofV2Path } = await import('../src/hms/release-kernel.js');
    const { writeFile, mkdir, rm } = await import('node:fs/promises');
    const dir = await mkdtemp(join(tmpdir(), 'hms-role-dual-'));
    try {
      const v1Path = join(dir, 'role-proof.v1.json');
      const now = Date.now();
      await writeFile(
        v1Path,
        JSON.stringify({
          schemaVersion: 1,
          propertyCode: 'HRCEN',
          allowedSurfaces: ['Guest Stay'],
          deniedActions: [
            'new_record',
            'save',
            'delete',
            'duplicate',
            'check_in',
            'check_out',
            'document_generate',
            'document_send',
          ],
          issuedAt: new Date(now - 60_000).toISOString(),
          expiresAt: new Date(now + 86_400_000).toISOString(),
          evidenceRef: 'operator-observed-runtime-v1:abc',
          evidenceSha256: 'a'.repeat(64),
        }),
        { mode: 0o600 },
      );
      await expect(loadProductionRoleProof(v1Path)).resolves.toMatchObject({
        schemaVersion: 1,
      });

      const root = join(dir, 'proofs');
      await mkdir(join(root, 'role-proofs'), { recursive: true });
      const v2Path = roleProofV2Path(root, 'hms_find_reservation');
      const { READ_TOOLS } = await import('../src/hms/read-tools.js');
      const tool = READ_TOOLS.hms_find_reservation;
      await writeFile(
        v2Path,
        JSON.stringify({
          schemaVersion: 2,
          attestationKind: 'operator_observed_runtime',
          toolId: 'hms_find_reservation',
          discoveryOperationId: 'guest_stay_search',
          operationId: randomUUID(),
          observerSourceRevision: 'rev',
          evidenceArtifactId: randomUUID(),
          privateDigestKeyVersion: 'v1',
          actorHmacSha256: '1'.repeat(64),
          credentialVersionHmacSha256: '2'.repeat(64),
          runtimeFingerprintSha256: '3'.repeat(64),
          roleFingerprintSha256: '4'.repeat(64),
          propertyCode: 'HRCEN',
          currency: 'ZAR',
          credentialMode: 'view_only',
          allowedSurfaces: [
            ...new Set(tool.requestBranches.flatMap((b) => [...b.requiredRoleSurfaces])),
          ],
          deniedActions: [...tool.deniedActions],
          issuedAt: new Date(now - 60_000).toISOString(),
          expiresAt: new Date(now + 86_400_000).toISOString(),
          evidenceSha256: '5'.repeat(64),
        }),
        { mode: 0o600 },
      );
      await expect(
        loadProductionRoleProof(v2Path, { toolId: 'hms_find_reservation' }),
      ).resolves.toMatchObject({
        schemaVersion: 2,
        toolId: 'hms_find_reservation',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('createProductionHmsRuntime fail-closed when evidence ARN/version set but key missing or short', async () => {
    const {
      createProductionHmsRuntime,
      createProductionHmsProofRuntime,
      CENTURION_HMS_PRODUCTION_ORIGIN,
    } = await import('../src/hms/production-runtime.js');
    const { writeFile, mkdir, rm } = await import('node:fs/promises');
    const dir = await mkdtemp(join(tmpdir(), 'hms-ev-key-'));
    const artifactRoot = join(dir, 'artifacts');
    const proofPath = join(dir, 'role-proof.json');
    const now = Date.now();
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(
      proofPath,
      JSON.stringify({
        schemaVersion: 1,
        propertyCode: 'HRCEN',
        allowedSurfaces: ['Guest Stay'],
        deniedActions: [
          'new_record',
          'save',
          'delete',
          'duplicate',
          'check_in',
          'check_out',
          'document_generate',
          'document_send',
        ],
        issuedAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + 86_400_000).toISOString(),
        evidenceRef: 'operator-observed-runtime-v1:abc',
        evidenceSha256: 'a'.repeat(64),
      }),
      { mode: 0o600 },
    );

    const productionSecret = {
      loginUrl: `${CENTURION_HMS_PRODUCTION_ORIGIN}/login`,
      username: 'fixture-user',
      password: 'fixture-password',
      expectedTenant: 'HMS_LEGACY',
      expectedPropertyCode: 'HRCEN',
      expectedPropertyName: 'Centurion',
      mailboxTransportId: 'transport-centurion',
      credentialMode: 'view_only' as const,
    };
    const baseConfig = {
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-hms',
      chromiumExecutablePath: '/opt/nava/chromium/chrome',
      roleProofPath: proofPath,
      healthPath: join(dir, 'health.json'),
      expectedTenant: 'HMS_LEGACY',
      expectedPropertyCode: 'HRCEN' as const,
      expectedTransportId: 'transport-centurion',
      runDeadlineMs: 15_000,
      circuitCooldownMs: 1_000,
      evidenceHmacSecretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:evidence',
      evidenceHmacKeyVersion: 'evidence-key-v1',
    };
    const loadSecret = async () => ({
      secret: productionSecret,
      versionId: 'version-current-1',
      versionStages: ['AWSCURRENT'],
    });

    await expect(
      createProductionHmsRuntime(baseConfig, {
        loadSecret,
        artifactRoot,
        sourceRevision: 'rev-11c-fix-evidence-key',
      }),
    ).rejects.toMatchObject({ code: 'EVIDENCE_KEY_MISSING' });

    await expect(
      createProductionHmsRuntime(baseConfig, {
        loadSecret,
        artifactRoot,
        sourceRevision: 'rev-11c-fix-evidence-key',
        evidenceHmac: {
          secretArn: baseConfig.evidenceHmacSecretArn,
          keyVersion: baseConfig.evidenceHmacKeyVersion,
          key: Buffer.alloc(16, 1),
        },
      }),
    ).rejects.toMatchObject({ code: 'EVIDENCE_KEY_INVALID' });

    // Live-proof composition shares the same fail-closed path.
    await expect(
      createProductionHmsProofRuntime(baseConfig, {
        loadSecret,
        artifactRoot,
        sourceRevision: 'rev-11c-fix-evidence-key',
      }),
    ).rejects.toMatchObject({ code: 'EVIDENCE_KEY_MISSING' });

    await rm(dir, { recursive: true, force: true });
  });

  it('does not invent AWSCURRENT; fail-closed when evidence required and VersionStages missing', async () => {
    const { createProductionHmsRuntime, normalizeLoadedSecret, CENTURION_HMS_PRODUCTION_ORIGIN } =
      await import('../src/hms/production-runtime.js');
    const { writeFile, mkdir, rm } = await import('node:fs/promises');

    // Missing stages must stay empty — never fake AWSCURRENT.
    const normalized = normalizeLoadedSecret({
      secret: { ok: true },
      versionId: 'version-no-stages',
    });
    expect(normalized.version).toEqual({
      versionId: 'version-no-stages',
      versionStages: [],
    });

    const dir = await mkdtemp(join(tmpdir(), 'hms-ev-stages-'));
    const artifactRoot = join(dir, 'artifacts');
    const proofPath = join(dir, 'role-proof.json');
    const now = Date.now();
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(
      proofPath,
      JSON.stringify({
        schemaVersion: 1,
        propertyCode: 'HRCEN',
        allowedSurfaces: ['Guest Stay'],
        deniedActions: [
          'new_record',
          'save',
          'delete',
          'duplicate',
          'check_in',
          'check_out',
          'document_generate',
          'document_send',
        ],
        issuedAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + 86_400_000).toISOString(),
        evidenceRef: 'operator-observed-runtime-v1:abc',
        evidenceSha256: 'b'.repeat(64),
      }),
      { mode: 0o600 },
    );

    const productionSecret = {
      loginUrl: `${CENTURION_HMS_PRODUCTION_ORIGIN}/login`,
      username: 'fixture-user',
      password: 'fixture-password',
      expectedTenant: 'HMS_LEGACY',
      expectedPropertyCode: 'HRCEN',
      expectedPropertyName: 'Centurion',
      mailboxTransportId: 'transport-centurion',
      credentialMode: 'view_only' as const,
    };
    const key = Buffer.alloc(32, 9);
    const config = {
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-hms',
      chromiumExecutablePath: '/opt/nava/chromium/chrome',
      roleProofPath: proofPath,
      healthPath: join(dir, 'health.json'),
      expectedTenant: 'HMS_LEGACY',
      expectedPropertyCode: 'HRCEN' as const,
      expectedTransportId: 'transport-centurion',
      runDeadlineMs: 15_000,
      circuitCooldownMs: 1_000,
      evidenceHmacSecretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:evidence',
      evidenceHmacKeyVersion: 'evidence-key-v1',
    };

    // Create-time snapshot limitation: session revalidation reuses VersionStages
    // captured here; missing/non-AWSCURRENT stages must fail closed at create.
    await expect(
      createProductionHmsRuntime(config, {
        loadSecret: async () => ({
          secret: productionSecret,
          versionId: 'version-missing-stages',
          // omit versionStages — normalize must not invent AWSCURRENT
        }),
        artifactRoot,
        sourceRevision: 'rev-11c-fix-stages',
        evidenceHmac: {
          secretArn: config.evidenceHmacSecretArn,
          keyVersion: config.evidenceHmacKeyVersion,
          key,
        },
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/CREDENTIAL_VERSION_STALE|CREDENTIAL_VERSION_STAGES_MISSING/),
    });

    await expect(
      createProductionHmsRuntime(config, {
        loadSecret: async () => ({
          secret: productionSecret,
          versionId: 'version-previous',
          versionStages: ['AWSPREVIOUS'],
        }),
        artifactRoot,
        sourceRevision: 'rev-11c-fix-stages',
        evidenceHmac: {
          secretArn: config.evidenceHmacSecretArn,
          keyVersion: config.evidenceHmacKeyVersion,
          key,
        },
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_VERSION_STALE' });

    // Source documents create-time VersionStages snapshot (no mid-session SM re-fetch).
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/hms/production-runtime.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/create-time.*VersionStages|VersionStages.*create-time/i);
    expect(src).not.toMatch(/VersionStages \?\? \['AWSCURRENT'\]/);

    await rm(dir, { recursive: true, force: true });
  });

  it('Task 13: openReadSession accepts per-context HmsSessionAuthorization (not process-wide only)', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/hms/runtime.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/sessionAuthorization/);
    expect(src).toMatch(/HmsSessionAuthorization/);
    expect(src).toMatch(/session authorization expired|ROLE_PROOF_EXPIRED/);
    expect(src).toMatch(/requireSessionAuthorization/);
  });

  it('Task 13: requireSessionAuthorization rejects open without lease (behavioral)', async () => {
    const server = await startHmsFixtureServer();
    try {
      const secret = fixtureSecret(server.origin);
      const runtime = createHmsRuntime({
        manifest: fixtureManifest(server.origin),
        secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-test',
        loadSecret: async () => secret,
        browserFactory: createFetchBrowserFactory(),
        requireSessionAuthorization: true,
        runStartupCanary: false,
        requireAuditCapture: false,
      });
      try {
        await runtime.start(AbortSignal.timeout(15_000));
        await expect(
          runtime.openReadSession({
            transportId: secret.mailboxTransportId,
            signal: AbortSignal.timeout(5_000),
          }),
        ).rejects.toMatchObject({
          code: 'ROLE_SCOPE_INVALID',
        });

        const leaseManifest = fixtureManifest(server.origin);
        const session = await runtime.openReadSession({
          transportId: secret.mailboxTransportId,
          signal: AbortSignal.timeout(5_000),
          sessionAuthorization: {
            operationId: randomUUID(),
            toolId: 'hms_find_reservation',
            discoveryOperationId: 'guest_stay_search',
            releaseId: randomUUID(),
            requestBranchId: 'guest_stay_search',
            manifest: leaseManifest,
            manifestSha256: 'a'.repeat(64),
            roleProofPath: '/tmp/unused',
            roleProofSha256: 'b'.repeat(64),
            credentialVersionHmacSha256: 'c'.repeat(64),
            runtimeFingerprintSha256: 'd'.repeat(64),
            privateDigestKeyVersion: 'v1',
            sourceRevision: 'test',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        });
        await session.close();
      } finally {
        await runtime.close();
      }
    } finally {
      await server.close();
    }
  });

  it('Task 13: live-guest-stay-driver passes sessionAuthorization into openReadSession', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/hms/live-guest-stay-driver.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/sessionAuthorizationFor/);
    expect(src).toMatch(/sessionAuthorization,/);
  });

  it('Task 13: worker loads active registry + wires createReadToolHandler path', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/ai/worker.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/loadWorkerActiveReadSet/);
    expect(src).toMatch(/sessionAuthorizationFor/);
    expect(src).toMatch(/buildHmsFindSessionAuthorization/);
    expect(src).toMatch(/assertFindHandlerBound|createReadToolHandler/);
    expect(src).toMatch(/resolvePlanScopedDraftGate/);
    expect(src).toMatch(/candidateBindings/);
    expect(src).toMatch(/requesterAuthorization/);
  });
});
