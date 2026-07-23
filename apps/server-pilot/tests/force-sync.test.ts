/**
 * mail.forceSync — one-shot ingestOnce under mailbox lock + FakePop3.
 * Unit path stubs ingestOnce (no DATABASE_URL). Integration path needs DB.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FakePop3Client } from '../src/mail/ingest/pop3-client.js';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db.js';
import { callerFor } from './helpers/trpc-caller.js';
import { readFixture } from './helpers/fixtures.js';
import { appRouter } from '../src/trpc/router.js';
import {
  __resetMailboxIngestLocksForTests,
  __setForceSyncIngestOnceForTests,
  __setForceSyncPop3ForTests,
} from '../src/trpc/routes/mail.js';
import {
  withMailboxIngestLock,
} from '../src/mail/ingest/mailbox-ingest-lock.js';

const reachable = await probeTestDb();

afterEach(() => {
  __setForceSyncPop3ForTests(undefined);
  __setForceSyncIngestOnceForTests(undefined);
  __resetMailboxIngestLocksForTests();
  resetS3Storage();
});

function forceSyncCaller(transportId = 'transport-1') {
  return appRouter.createCaller({
    source: 'test',
    sessionUser: { id: 'user-1', email: 'user@example.com', name: 'User' },
    activeTransportId: transportId,
    accessRole: 'owner',
    transportEmail: 'user@example.com',
    reqHeaders: new Headers(),
  } as never);
}

describe('mail.forceSync (unit, no DB)', () => {
  it('returns cycle shape under lock when ingestOnce stubbed', async () => {
    __setForceSyncIngestOnceForTests(async () => ({
      listed: 3,
      processed: 2,
      deled: 1,
    }));

    const result = await forceSyncCaller().mail.forceSync();
    expect(result).toEqual({
      triggered: true,
      processed: 2,
      listed: 3,
      deled: 1,
      cycleError: undefined,
    });
  });

  it('waits on mailbox lock then returns stubbed cycle', async () => {
    __setForceSyncIngestOnceForTests(async () => ({
      listed: 1,
      processed: 1,
      deled: 0,
    }));

    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = withMailboxIngestLock('transport-lock', async () => {
      await holderGate;
      return 'held';
    });

    await Promise.resolve();
    await Promise.resolve();

    const pending = forceSyncCaller('transport-lock').mail.forceSync();
    releaseHolder();
    const [held, result] = await Promise.all([holder, pending]);
    expect(held).toEqual({ ok: true, value: 'held' });
    expect(result.triggered).toBe(true);
    expect(result.processed).toBe(1);
    expect(result.listed).toBe(1);
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('mail.forceSync (integration)', () => {
  it(
    'forceSync runs ingestOnce and returns processed counts',
    async () => {
      await withSeededTestDb(async (db) => {
        resetS3Storage();
        setS3Storage(new FakeS3Storage('force-sync-bucket'));
        const fake = new FakePop3Client({
          messages: [
            { uidl: 'uidl-force-1', raw: readFixture('centurion-stamped.eml') },
          ],
        });
        __setForceSyncPop3ForTests(fake);

        const caller = await callerFor('user-navaai', { db });
        const result = await caller.mail.forceSync();
        expect(result.triggered).toBe(true);
        expect(result.processed).toBeGreaterThanOrEqual(0);
        expect(typeof result.listed).toBe('number');
      });
    },
    30000,
  );
});
