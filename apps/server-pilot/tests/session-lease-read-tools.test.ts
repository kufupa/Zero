import {
  createPropertyReadLock,
  propertyReadLockKey,
  type PropertyReadConnection,
} from '../src/hms/property-read-lock.js';
import { staffQuoteChildEnv } from '../src/ai/staff-quote-run.js';
import { createSlotSession } from '../src/hms/slot-session.js';
import { withLeasedReadPage as createPreflightPage } from '../tooling/playwright-quote/create-preflight.mjs';
import { withLeasedReadPage as fetchQuotePage } from '../tooling/playwright-quote/fetch-quote.mjs';
import { withLeasedReadPage as findBatchPage } from '../tooling/playwright-quote/find-batch.mjs';
import { withLeasedReadPage as deeplinkPage } from '../tooling/playwright-quote/hms-deeplink-probe.mjs';
import { withLeasedReadPage as partyLookupPage } from '../tooling/playwright-quote/party-lookup.mjs';
import { withLeasedReadPage as profilePage } from '../tooling/playwright-quote/property-profile.mjs';
import {
  prepareReadCliInput,
  READ_CLI_TOOLS,
  resetSharedReadCliLease,
  sharedReadCliLease,
} from '../tooling/playwright-quote/read-cli-lease.mjs';
import { withLeasedReadPage as readCodesPage } from '../tooling/playwright-quote/read-reservation-codes.mjs';
import { withLeasedReadPage as readFieldsPage } from '../tooling/playwright-quote/read-reservation-fields.mjs';
import { withLeasedReadPage as stayLookupPage } from '../tooling/playwright-quote/stay-lookup.mjs';
import { describe, expect, it, vi } from 'vitest';

const GENERIC_PROPERTY = 'HTLAA';
const LOCK_TENANT = 'tenant-generic';

const CALLERS = {
  'fetch-quote': fetchQuotePage,
  'party-lookup': partyLookupPage,
  'property-profile': profilePage,
  'find-batch': findBatchPage,
  'stay-lookup': stayLookupPage,
  'read-reservation-codes': readCodesPage,
  'read-reservation-fields': readFieldsPage,
  'create-preflight': createPreflightPage,
  'hms-deeplink-probe': deeplinkPage,
} as const;

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
    expect(Object.keys(CALLERS).sort()).toEqual([...READ_CLI_TOOLS].sort());

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

    for (const caller of Object.values(CALLERS)) {
      await expect(caller({ ...omitted, propertyCode: '' }, run)).rejects.toMatchObject({
        name: 'SlotLeaseRefusedError',
        code: 'property_unknown',
        payload: undefined,
      });
      await expect(caller({ ...omitted }, run)).rejects.toMatchObject({
        code: 'property_unknown',
        payload: undefined,
      });
    }
    expect(newPage).not.toHaveBeenCalled();
    expect(loginPage).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();

    const pages = await lock.withLock(async (connection) => {
      const seen: unknown[] = [];
      for (const caller of Object.values(CALLERS)) {
        seen.push(
          await caller(
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
    const prepare = (env: NodeJS.ProcessEnv) =>
      prepareReadCliInput({
        propertyCode: GENERIC_PROPERTY,
        tenantId: LOCK_TENANT,
        lookupProperty,
        env,
      });

    const matched = await prepareReadCliInput({
      propertyCode: GENERIC_PROPERTY,
      lookupProperty,
      env: staffQuoteChildEnv(LOCK_TENANT, GENERIC_PROPERTY, { DATABASE_URL: databaseUrl }),
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
