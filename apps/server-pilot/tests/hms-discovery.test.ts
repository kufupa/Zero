import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  requestPolicyManifestSchema,
  requestRuleSchema,
} from '../src/hms/contracts.js';
import { createFetchBrowserFactory, type HmsSecret } from '../src/hms/runtime.js';
import {
  discoveryPhaseSchema,
  removeStaleDiscoveryOutput,
  runDiscovery,
  sanitizeDiscoveryObservation,
} from '../scripts/hms-discover-read.js';
import {
  FIXTURE_IDS,
  startHmsFixtureServer,
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

function fixtureSecret(origin: string): HmsSecret {
  return {
    loginUrl: `${origin}/login`,
    username: 'fixture-user',
    password: 'fixture-password-secret',
    expectedTenant: FIXTURE_IDS.tenant,
    expectedPropertyCode: FIXTURE_IDS.propertyCode,
    expectedPropertyName: FIXTURE_IDS.propertyName,
    mailboxTransportId: FIXTURE_IDS.transportId,
    credentialMode: 'view_only',
  };
}

describe('discovery sanitize', () => {
  it('observation contains structure but no values', () => {
    const observation = sanitizeDiscoveryObservation({
      method: 'POST',
      url: 'https://appsrv-1.example.test/search?tenant=THECENTURION_PRD',
      contentType: 'application/x-www-form-urlencoded',
      body: 'operation=search&surname=PrivateGuest',
    });

    expect(observation).toEqual({
      method: 'POST',
      origin: 'https://appsrv-1.example.test',
      path: '/search',
      resourceType: 'document',
      queryKeys: ['tenant'],
      bodyKeys: ['operation', 'surname'],
      bodyBytes: Buffer.byteLength('operation=search&surname=PrivateGuest'),
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(JSON.stringify(observation)).not.toContain('PrivateGuest');
    expect(JSON.stringify(observation)).not.toContain('THECENTURION_PRD');
  });

  it('phase enum excludes write-forms', () => {
    expect(discoveryPhaseSchema.options).toEqual([
      'login',
      'reservation-search',
      'room-availability',
      'display-rates',
    ]);
    expect(() => discoveryPhaseSchema.parse('write-forms')).toThrow();
  });
});

describe('HMS discovery script (fixture)', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()!();
    delete process.env.HMS_DISCOVERY_ALLOW_LIVE;
  });

  it('refuses live without explicit allow flag', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const dir = await mkdtemp(join(tmpdir(), 'hms-disc-'));
    const outputPath = join(dir, 'out.json');

    await expect(
      runDiscovery({
        phase: 'login',
        manifest: fixtureManifest(server.origin),
        secret: fixtureSecret(server.origin),
        outputPath,
        mode: 'live',
        browserFactory: createFetchBrowserFactory(),
      }),
    ).rejects.toThrow(/HMS_DISCOVERY_ALLOW_LIVE/);
  });

  it('blocked unknown probe writes redacted signature atomically', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const dir = await mkdtemp(join(tmpdir(), 'hms-disc-'));
    const outputPath = join(dir, 'out.json');
    await writeFile(outputPath, '{"stale":true}', 'utf8');

    const result = await runDiscovery({
      phase: 'reservation-search',
      manifest: fixtureManifest(server.origin),
      secret: fixtureSecret(server.origin),
      outputPath,
      mode: 'fixture',
      browserFactory: createFetchBrowserFactory(),
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-disc',
      probeUnknown: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected block');
    expect(result.blocked.code).toMatch(/unknown_path/);
    expect(result.blocked.redactedSignature.path).toBe(
      '/unknown/discovery-probe',
    );
    expect(JSON.stringify(result)).not.toContain('fixture-password-secret');
    expect(JSON.stringify(result)).not.toContain('PrivateGuest');

    const onDisk = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(onDisk.stale).toBeUndefined();
    expect(onDisk.ok).toBe(false);
    expect(onDisk.blocked.redactedSignature.queryKeys).toEqual([]);
  });

  it('removes stale output before write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hms-disc-'));
    const outputPath = join(dir, 'stale.json');
    await writeFile(outputPath, 'stale-bytes', 'utf8');
    await removeStaleDiscoveryOutput(outputPath);
    await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('login phase succeeds on fixture without cookies/credentials in output', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const dir = await mkdtemp(join(tmpdir(), 'hms-disc-'));
    const outputPath = join(dir, 'login.json');

    const result = await runDiscovery({
      phase: 'login',
      manifest: fixtureManifest(server.origin),
      secret: fixtureSecret(server.origin),
      outputPath,
      mode: 'fixture',
      browserFactory: createFetchBrowserFactory(),
    });

    expect(result.ok).toBe(true);
    const raw = await readFile(outputPath, 'utf8');
    expect(raw).not.toContain('fixture-password-secret');
    expect(raw).not.toMatch(/set-cookie/i);
    expect(raw).not.toContain('arn:aws:secretsmanager:af-south-1');
  });

  it('room-availability and display-rates phases are allowed', async () => {
    const server = await startHmsFixtureServer();
    cleanup.push(server.close);
    const dir = await mkdtemp(join(tmpdir(), 'hms-disc-'));

    for (const phase of ['room-availability', 'display-rates'] as const) {
      const outputPath = join(dir, `${phase}.json`);
      const result = await runDiscovery({
        phase,
        manifest: fixtureManifest(server.origin),
        secret: fixtureSecret(server.origin),
        outputPath,
        mode: 'fixture',
        browserFactory: createFetchBrowserFactory(),
      });
      expect(result.ok).toBe(true);
    }
  });
});
