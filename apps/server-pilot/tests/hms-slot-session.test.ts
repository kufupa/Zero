import { createExclusivePageLease } from '../tooling/playwright-quote/hms-slot-lease.mjs';
import {
  createPropertyReadLock,
  type PropertyReadConnection,
} from '../src/hms/property-read-lock.js';
import { createSlotSession, SlotSessionClosedError } from '../src/hms/slot-session.js';
import { describe, expect, it, vi } from 'vitest';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('createSlotSession', () => {
  it('starts down, recover success → ready', async () => {
    const owner = {
      login: async () => {},
      wipeProfile: async () => {
        throw new Error('wipe must not run on recover');
      },
    };
    const session = createSlotSession({ owner });
    expect(session.phase).toBe('down');
    await session.recover();
    expect(session.phase).toBe('ready');
  });

  it('recover failure → down, never fake ready', async () => {
    const owner = {
      login: async () => {
        throw new Error('NAVAAI login failed');
      },
      wipeProfile: async () => {},
    };
    const session = createSlotSession({ owner });
    await expect(session.recover()).rejects.toThrow(/login failed/);
    expect(session.phase).toBe('down');
  });

  it('reset from ready wipes the profile then recovers to ready', async () => {
    const seen: string[] = [];
    const owner = {
      login: async () => {
        seen.push('login');
      },
      wipeProfile: async () => {
        seen.push('wipe');
      },
    };
    const session = createSlotSession({ owner });
    await session.recover();
    expect(session.phase).toBe('ready');
    await session.reset();
    expect(session.phase).toBe('ready');
    expect(seen).toEqual(['login', 'wipe', 'login']);
  });

  it('recover during an in-flight read fails the read closed with no success payload', async () => {
    const hold = deferred();
    const entered = deferred();
    const owner = {
      login: async () => {},
      wipeProfile: async () => {},
    };
    const session = createSlotSession({ owner });
    await session.recover();

    const read = session.withRead(async () => {
      entered.resolve();
      await hold.promise;
      return { payload: 'stale-quote' };
    });
    await entered.promise;
    await session.recover();
    hold.resolve();
    await expect(read).rejects.toBeInstanceOf(SlotSessionClosedError);
    await expect(read).rejects.toMatchObject({ payload: undefined });
    expect(session.phase).toBe('ready');
  });
});

const GENERIC_PROPERTY = 'HTLAA';
const LOCK_TENANT = 'tenant-generic';

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

function readySession() {
  const session = createSlotSession({
    owner: { login: async () => {}, wipeProfile: async () => {} },
  });
  return session;
}

describe('exclusive authenticated page lease', () => {
  it('reuses the same authenticated page and skips a second login', async () => {
    const secret = secretFor(GENERIC_PROPERTY);
    const page = { id: 'persistent-page' };
    const newPage = vi.fn(async () => ({ id: 'fresh-page' }));
    const loginPage = vi.fn(async () => {
      throw new Error('login must not run when the shell is already authenticated');
    });
    const context = {
      pages: () => [page],
      newPage,
    };
    const session = readySession();
    await session.recover();
    const lease = createExclusivePageLease({
      lookupProperty: (code: string) =>
        code === GENERIC_PROPERTY ? { propertyCode: GENERIC_PROPERTY } : null,
      loginPage,
      authenticatedShell: async (candidate: { id: string }) => candidate === page,
    });
    const lock = createPropertyReadLock({
      tenantId: LOCK_TENANT,
      propertyCode: GENERIC_PROPERTY,
      connectionFactory: async () => lockConnection(),
    });

    const pages = await lock.withLock(async (connection) => {
      const first = await lease.withPage(
        {
          propertyCode: GENERIC_PROPERTY,
          tenantId: LOCK_TENANT,
          secret,
          session,
          lockConnection: connection,
          lockKey: lock.key,
          context,
        },
        async ({ page: leased, reused }) => {
          expect(leased).toBe(page);
          expect(reused).toBe(true);
          return leased;
        },
      );
      const second = await lease.withPage(
        {
          propertyCode: GENERIC_PROPERTY,
          tenantId: LOCK_TENANT,
          secret,
          session,
          lockConnection: connection,
          lockKey: lock.key,
          context,
        },
        async ({ page: leased, reused }) => {
          expect(leased).toBe(page);
          expect(reused).toBe(true);
          return leased;
        },
      );
      return { first, second };
    });

    expect(pages.first).toBe(page);
    expect(pages.second).toBe(page);
    expect(newPage).not.toHaveBeenCalled();
    expect(loginPage).not.toHaveBeenCalled();
  });

  it('refuses a stale generation before login or a new page', async () => {
    const secret = secretFor(GENERIC_PROPERTY);
    const newPage = vi.fn(async () => ({ id: 'fresh-page' }));
    const loginPage = vi.fn(async () => ({ reused: false }));
    const run = vi.fn(async () => 'hms-action');
    const session = readySession();
    await session.recover();
    const staleGeneration = session.generation;
    await session.recover();
    const lease = createExclusivePageLease({
      lookupProperty: (code: string) =>
        code === GENERIC_PROPERTY ? { propertyCode: GENERIC_PROPERTY } : null,
      loginPage,
    });
    const lock = createPropertyReadLock({
      tenantId: LOCK_TENANT,
      propertyCode: GENERIC_PROPERTY,
      connectionFactory: async () => lockConnection(),
    });

    await lock.withLock(async (connection) => {
      await expect(
        lease.withPage(
          {
            propertyCode: GENERIC_PROPERTY,
            tenantId: LOCK_TENANT,
            secret,
            session,
            generation: staleGeneration,
            lockConnection: connection,
            lockKey: lock.key,
            context: { pages: () => [], newPage },
          },
          run,
        ),
      ).rejects.toMatchObject({
        name: 'SlotLeaseRefusedError',
        code: 'stale_generation',
        payload: undefined,
      });
    });

    expect(newPage).not.toHaveBeenCalled();
    expect(loginPage).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses an unknown property before lock work or a new page', async () => {
    const newPage = vi.fn(async () => ({ id: 'fresh-page' }));
    const loginPage = vi.fn(async () => ({ reused: false }));
    const run = vi.fn(async () => 'hms-action');
    const session = readySession();
    await session.recover();
    const lease = createExclusivePageLease({
      lookupProperty: (code: string) =>
        code === GENERIC_PROPERTY ? { propertyCode: GENERIC_PROPERTY } : null,
      loginPage,
    });

    await expect(
      lease.withPage(
        {
          propertyCode: 'HTLZZ',
          secret: secretFor('HTLZZ'),
          session,
          lockConnection: lockConnection(),
          lockKey: '0',
          context: { pages: () => [], newPage },
        },
        run,
      ),
    ).rejects.toMatchObject({
      name: 'SlotLeaseRefusedError',
      code: 'property_unknown',
      payload: undefined,
    });

    expect(newPage).not.toHaveBeenCalled();
    expect(loginPage).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a mismatched secret or another property lock before a new page', async () => {
    const newPage = vi.fn(async () => ({ id: 'fresh-page' }));
    const loginPage = vi.fn(async () => ({ reused: false }));
    const run = vi.fn(async () => 'hms-action');
    const session = readySession();
    await session.recover();
    const lease = createExclusivePageLease({
      lookupProperty: (code: string) =>
        code === GENERIC_PROPERTY ? { propertyCode: GENERIC_PROPERTY } : null,
      loginPage,
    });
    const lock = createPropertyReadLock({
      tenantId: LOCK_TENANT,
      propertyCode: GENERIC_PROPERTY,
      connectionFactory: async () => lockConnection(),
    });
    const otherLock = createPropertyReadLock({
      tenantId: LOCK_TENANT,
      propertyCode: 'HTLBB',
      connectionFactory: async () => lockConnection(),
    });

    await expect(
      lease.withPage(
        {
          propertyCode: GENERIC_PROPERTY,
          tenantId: LOCK_TENANT,
          secret: secretFor('HTLBB'),
          session,
          lockConnection: lockConnection(),
          lockKey: lock.key,
          context: { pages: () => [], newPage },
        },
        run,
      ),
    ).rejects.toMatchObject({ code: 'property_unknown', payload: undefined });

    await lock.withLock(async (connection) => {
      await expect(
        lease.withPage(
          {
            propertyCode: GENERIC_PROPERTY,
            tenantId: LOCK_TENANT,
            secret: secretFor(GENERIC_PROPERTY),
            session,
            lockConnection: connection,
            lockKey: otherLock.key,
            context: { pages: () => [], newPage },
          },
          run,
        ),
      ).rejects.toMatchObject({ code: 'PROPERTY_READ_LOCK_LOST' });
    });

    expect(newPage).not.toHaveBeenCalled();
    expect(loginPage).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses login when recover starts during page lookup', async () => {
    const hold = deferred();
    const entered = deferred();
    const newPage = vi.fn(async () => ({ id: 'fresh-page' }));
    const loginPage = vi.fn(async () => ({ reused: false }));
    const run = vi.fn(async () => 'hms-action');
    const session = readySession();
    await session.recover();
    const lease = createExclusivePageLease({
      lookupProperty: (code: string) =>
        code === GENERIC_PROPERTY ? { propertyCode: GENERIC_PROPERTY } : null,
      loginPage,
      authenticatedShell: async () => {
        entered.resolve();
        await hold.promise;
        return false;
      },
    });
    const lock = createPropertyReadLock({
      tenantId: LOCK_TENANT,
      propertyCode: GENERIC_PROPERTY,
      connectionFactory: async () => lockConnection(),
    });

    await lock.withLock(async (connection) => {
      const work = lease.withPage(
        {
          propertyCode: GENERIC_PROPERTY,
          tenantId: LOCK_TENANT,
          secret: secretFor(GENERIC_PROPERTY),
          session,
          lockConnection: connection,
          lockKey: lock.key,
          context: { pages: () => [{ id: 'stale' }], newPage },
        },
        run,
      );
      await entered.promise;
      await session.recover();
      hold.resolve();
      await expect(work).rejects.toMatchObject({
        code: 'stale_generation',
        payload: undefined,
      });
    });

    expect(newPage).not.toHaveBeenCalled();
    expect(loginPage).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
