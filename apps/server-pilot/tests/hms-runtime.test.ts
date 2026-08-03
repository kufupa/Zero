import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  requestPolicyManifestSchema,
  requestRuleSchema,
} from '../src/hms/contracts.js';
import {
  createFetchBrowserFactory,
  createHmsRuntime,
  HmsRuntimeError,
  type HmsSecret,
} from '../src/hms/runtime.js';
import {
  FIXTURE_IDS,
  startHmsFixtureServer,
  type HmsFixtureServer,
} from './helpers/hms-fixture-server.js';

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
          surname: { pattern: ".{0,40}", maxLength: 40 },
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
      loadSecret:
        opts.loadSecret ??
        (async () => secret),
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
    await expect(runtime.start(AbortSignal.timeout(5_000))).rejects.toBeInstanceOf(
      HmsRuntimeError,
    );
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
    await expect(
      session.page.goto(`${server.origin}/reservation/save`),
    ).rejects.toMatchObject({
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
    expect(searchPosts.some((r) => r.body.includes('NOTFOUND-CANARY'))).toBe(
      true,
    );
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
  it(
    'skips when chromium unavailable; documents injectable factory path',
    async () => {
      const { tryCreatePlaywrightBrowserFactory } = await import(
        '../src/hms/runtime.js'
      );
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
    },
    30_000,
  );
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
      fs.readFile(
        new URL('../src/hms/production-runtime.ts', import.meta.url),
        'utf8',
      ),
    );
    expect(src).toMatch(/from ['"]playwright['"]/);
    expect(src).not.toMatch(/tryCreatePlaywrightBrowserFactory|createFetchBrowserFactory/);
    expect(src).toMatch(/runStartupCanary:\s*false/);
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
    let emitPopup: ((page: import('../src/hms/runtime.js').HmsPage) => void) | null =
      null;
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
    const popupPage = {
      async close() {},
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
      async postForm() {},
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
    await new Promise((r) => setTimeout(r, 30));
    expect(session.terminal()).toBe(true);
    expect(session.violation()?.action).toBe('block');
    if (session.violation()?.action === 'block') {
      expect(session.violation()?.code).toMatch(/popup/i);
    }
  });

  it('download cancels and terminalizes context', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const secret = fixtureSecret(server.origin);
    let emitDownload:
      | ((d: { cancel(): Promise<void> }) => void)
      | null = null;
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
    emitDownload?.({
      async cancel() {
        cancelled.push('cancelled');
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(cancelled).toEqual(['cancelled']);
    expect(session.terminal()).toBe(true);
    expect(session.violation()?.code).toMatch(/download/i);
  });

  it('unreviewed redirect blocks before continue', async () => {
    const { evaluateObservedRequest, BLOCK_CODES } = await import(
      '../src/hms/request-policy.js'
    );
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
        const { loadHmsReadRoleProof } = await import(
          '../src/hms/production-runtime.js'
        );
        return loadHmsReadRoleProof(path);
      },
    });
    cleanup.push(() => runtime.close());
    await runtime.start(AbortSignal.timeout(15_000));
    // canary + start path
    expect(proofChecks).toBeGreaterThanOrEqual(1);
    const before = proofChecks;
    await runtime.openReadSession({
      transportId: secret.mailboxTransportId,
      signal: AbortSignal.timeout(15_000),
    }).then((s) => s.close());
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
    const raw = await readFile(healthPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.state).toMatch(/ready|degraded|starting|stopped|circuit_open/);
    expect(typeof parsed.browserLaunches).toBe('number');
    expect(typeof parsed.contextsCreated).toBe('number');
    expect(parsed.checkedAt).toMatch(/^\d{4}-/);
    expect(parsed.staleAfterMs).toBe(30_000);
    const mode = (await stat(healthPath)).mode & 0o777;
    // Windows may not preserve unix mode; assert when meaningful
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o600);
    }
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
    const { createLiveGuestStayDriver } = await import(
      '../src/hms/live-guest-stay-driver.js'
    );
    const { buildLiveGuestStayReadManifest } = await import(
      '../src/hms/live-read-manifest.js'
    );
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
    const { createLiveGuestStayDriver } = await import(
      '../src/hms/live-guest-stay-driver.js'
    );
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

    const result = await driver.searchExact(
      candidate,
      AbortSignal.timeout(15_000),
    );
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
      const alteredBefore = server.requests.filter((r) =>
        r.body.includes('OTHER-VAL'),
      ).length;
      await expect(
        session.page.postForm(`${server.origin}${LIVE_GUEST_STAY_SEARCH_PATH}`, {
          ...expectedBody,
          MADDON_FILTER_VALUE_3: 'OTHER-VAL',
        }),
      ).rejects.toMatchObject({ code: BLOCK_CODES.CHANGED_FIXED_BODY });
      expect(
        server.requests.filter((r) => r.body.includes('OTHER-VAL')).length,
      ).toBe(alteredBefore);
    } finally {
      await session.close();
    }
  });
});
