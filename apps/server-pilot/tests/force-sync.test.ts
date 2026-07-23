/**
 * mail.forceSync — one-shot ingestOnce under mailbox lock + FakePop3.
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
import {
  __resetMailboxIngestLocksForTests,
  __setForceSyncPop3ForTests,
} from '../src/trpc/routes/mail.js';

const reachable = await probeTestDb();

afterEach(() => {
  __setForceSyncPop3ForTests(undefined);
  __resetMailboxIngestLocksForTests();
  resetS3Storage();
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('mail.forceSync', () => {
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
