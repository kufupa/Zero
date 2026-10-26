import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPropertyReadLock,
  propertyReadLockKey,
  type PropertyReadConnection,
} from '../src/hms/property-read-lock.js';
import { spawnEnvWithHeldLock } from '../src/ai/staff-quote-installation.js';
import { staffQuoteChildEnv } from '../src/ai/staff-quote-run.js';
import { createSlotSession } from '../src/hms/slot-session.js';
import { runDeeplinkProbe } from '../tooling/playwright-quote/hms-deeplink-probe.mjs';
import { partyLookupPropertyCode } from '../tooling/playwright-quote/party-lookup.mjs';
import { parseStayProperty } from '../tooling/playwright-quote/property-profile.mjs';
import {
  lookupActiveProperty,
  prepareReadCliInput,
  resetSharedReadCliLease,
  sharedReadCliLease,
  withReadCliPage,
} from '../tooling/playwright-quote/read-cli-lease.mjs';
import { main as stayLookupMain } from '../tooling/playwright-quote/stay-lookup.mjs';
import { describe, expect, it, vi } from 'vitest';

const GENERIC_PROPERTY = 'HTLAA';
const LOCK_TENANT = 'tenant-generic';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLING = join(ROOT, 'tooling/playwright-quote');
const SRC = join(ROOT, 'src/ai');

const ARGV_CLIS = ['stay-lookup', 'create-preflight', 'hms-deeplink-probe'] as const;

const OMITTED_ARGV: Record<(typeof ARGV_CLIS)[number], string[]> = {
  'stay-lookup': ['--mode', 'find', '--confirmation', '1-1', '--out', '/tmp'],
  'create-preflight': ['--request', 'x.json'],
  'hms-deeplink-probe': ['--conf', '1-1'],
};

function sourceOf(dir: string, name: string) {
  return readFileSync(join(dir, name), 'utf8');
}

function secretFor(propertyCode: string) {
  return {
    loginUrl: 'https://example.invalid/login',
    username: 'user',
    password: 'secret',
    expectedTenant: `tenant-${propertyCode}`,
    expectedPropertyCode: propertyCode,
    expectedPropertyName: `Hotel ${propertyCode}`,
  };
}

function lockConnection(): PropertyReadConnection {
  return {
    query: vi.fn(async (sql: string) =>
      sql.includes('pg_try_advisory_lock') ? [{ pg_try_advisory_lock: true }] : undefined,
    ),
    close: vi.fn(async () => undefined),
  };
}

describe('read CLI session lease', () => {
  it('omitted property refuses and read callers share the lease', async () => {
    for (const name of ARGV_CLIS) {
      expect(sourceOf(TOOLING, `${name}.mjs`)).toContain('parseStayProperty');
      expect(parseStayProperty(OMITTED_ARGV[name])).toMatchObject({
        ok: false,
        error: 'PROPERTY_REQUIRED',
        exitCode: 2,
      });
    }
    expect(await stayLookupMain(OMITTED_ARGV['stay-lookup'])).toBe(2);

    expect(sourceOf(SRC, 'pane-stay-lookup.ts')).toContain("'--property'");
    expect(sourceOf(SRC, 'pane-stay-save.ts')).toMatch(/return code \? \['--property', code\] : \[\]/);
    expect(sourceOf(join(ROOT, 'scripts'), 'v8-live-checks.ts')).toContain("'--property'");
    expect(sourceOf(SRC, 'staff-quote-installation.ts')).toContain(
      'propertyCode: configuration.owner.propertyCode',
    );

    expect(partyLookupPropertyCode({})).toBeNull();
    expect(partyLookupPropertyCode({ propertyCode: '' })).toBeNull();
    expect(partyLookupPropertyCode({ propertyCode: 'HTLZZ' })).toBeNull();
    expect(lookupActiveProperty('')).toBeNull();
    expect(lookupActiveProperty('HTLZZ')).toBeNull();
    expect(sourceOf(TOOLING, 'fetch-quote.mjs')).toContain('lookupActiveProperty(request.propertyCode)');

    await expect(
      runDeeplinkProbe({
        env: {
          HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:9222',
          HMS_STAGEHAND_BROWSER_OWNERSHIP: 'borrowed',
        },
        conf: '1-1',
      }),
    ).rejects.toThrow('PROPERTY_REQUIRED');

    const page = { id: 'persistent-page' };
    const newPage = vi.fn(async () => ({ id: 'fresh-page' }));
    const loginPage = vi.fn(async () => {
      throw new Error('login must not run when the shell is already authenticated');
    });
    const run = vi.fn(async () => 'hms-action');
    const lookupProperty = (code: string) =>
      code === GENERIC_PROPERTY ? { propertyCode: GENERIC_PROPERTY } : null;
    const context = { pages: () => [page], newPage };
    const session = createSlotSession({
      owner: { login: async () => {}, wipeProfile: async () => {} },
    });
    await session.recover();
    resetSharedReadCliLease();
    const lease = sharedReadCliLease({
      lookupProperty,
      loginPage,
      authenticatedShell: async (candidate: { id: string }) => candidate === page,
    });
    const lock = createPropertyReadLock({
      tenantId: LOCK_TENANT,
      propertyCode: GENERIC_PROPERTY,
      connectionFactory: async () => lockConnection(),
    });
    const omitted = {
      secret: secretFor(GENERIC_PROPERTY),
      session,
      lease,
      lookupProperty,
      context,
    };

    await expect(withReadCliPage({ ...omitted, propertyCode: '' }, run)).rejects.toMatchObject({
      name: 'SlotLeaseRefusedError',
      code: 'property_unknown',
      payload: undefined,
    });
    await expect(withReadCliPage({ ...omitted }, run)).rejects.toMatchObject({
      code: 'property_unknown',
      payload: undefined,
    });
    expect(newPage).not.toHaveBeenCalled();
    expect(loginPage).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();

    const pages = await lock.withLock(async (connection) => {
      const seen: unknown[] = [];
      for (let i = 0; i < 2; i += 1) {
        seen.push(
          await withReadCliPage(
            {
              propertyCode: GENERIC_PROPERTY,
              tenantId: LOCK_TENANT,
              secret: secretFor(GENERIC_PROPERTY),
              session,
              lease,
              lookupProperty,
              lockConnection: connection,
              lockKey: lock.key,
              context,
            },
            async ({ page: leased }: { page: { id: string } }) => leased,
          ),
        );
      }
      return seen;
    });

    expect(new Set(pages).size).toBe(1);
    expect(pages[0]).toBe(page);
    expect(newPage).not.toHaveBeenCalled();
    expect(loginPage).not.toHaveBeenCalled();
  });

  it('resolves the parent-held lock token before DATABASE_URL', async () => {
    const lookupProperty = (code: string) =>
      code === GENERIC_PROPERTY ? { propertyCode: GENERIC_PROPERTY } : null;
    const otherProperty = propertyReadLockKey(LOCK_TENANT, 'HTLBB');
    const databaseUrl = 'postgres://lock-matrix.invalid/unused';
    const legacyTenant = 'HMS_LEGACY';
    const prepare = (env: NodeJS.ProcessEnv) =>
      prepareReadCliInput({
        propertyCode: GENERIC_PROPERTY,
        tenantId: LOCK_TENANT,
        lookupProperty,
        env,
      });

    const child = staffQuoteChildEnv(LOCK_TENANT, GENERIC_PROPERTY, {
      DATABASE_URL: databaseUrl,
      HMS_EXPECTED_TENANT: legacyTenant,
    });
    const requestEnv = {
      DATABASE_URL: databaseUrl,
      HMS_EXPECTED_TENANT: legacyTenant,
    };
    const lockOnly = spawnEnvWithHeldLock(requestEnv, {
      HMS_PROPERTY_LOCK_HELD: child.HMS_PROPERTY_LOCK_HELD,
    });
    await expect(
      prepareReadCliInput({
        propertyCode: GENERIC_PROPERTY,
        lookupProperty,
        env: lockOnly,
      }),
    ).rejects.toMatchObject({ name: 'SlotLeaseRefusedError', code: 'lock_token_mismatch' });

    const forwarded = spawnEnvWithHeldLock(requestEnv, child);
    const matched = await prepareReadCliInput({
      propertyCode: GENERIC_PROPERTY,
      lookupProperty,
      env: forwarded,
    });
    expect(matched.lockSource).toBe('parent-token');
    expect(matched.tenantId).toBe(LOCK_TENANT);
    await expect(matched.lock.withLock(async (connection) => connection.query('SELECT 1'))).resolves.toEqual([
      { pg_try_advisory_lock: true },
    ]);

    await expect(
      prepare({
        HMS_PROPERTY_LOCK_HELD: otherProperty,
        DATABASE_URL: databaseUrl,
      }),
    ).rejects.toMatchObject({ name: 'SlotLeaseRefusedError', code: 'lock_token_mismatch' });

    const standalone = await prepare({ DATABASE_URL: databaseUrl });
    expect(standalone.lockSource).toBe('postgres');

    const local = await prepare({});
    expect(local.lockSource).toBe('process-local');
    await expect(local.lock.withLock(async (connection) => connection.query('SELECT 1'))).resolves.toEqual([
      { pg_try_advisory_lock: true },
    ]);
  });
});
