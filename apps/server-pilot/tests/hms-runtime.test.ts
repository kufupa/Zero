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
  it('skips when chromium unavailable; documents injectable factory path', async () => {
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
  });
});
