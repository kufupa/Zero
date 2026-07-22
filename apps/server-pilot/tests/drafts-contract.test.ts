/**
 * Draft body wire contract: create stores content readable on get/list reopen.
 */
import { describe, expect, it } from 'vitest';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'drafts content contract (seeded, transaction-rollback)',
  () => {
    it(
      'drafts.create message reopens non-empty from get and list',
      async () => {
        await withSeededTestDb(async (db) => {
          const caller = await callerFor('user-navaai', { db });
          const body = '<p>Hello draft</p>';

          const { id } = await caller.drafts.create({
            to: '',
            subject: 'Draft contract',
            message: body,
          });

          const got = await caller.drafts.get({ id });
          expect(got.content).toBe(body);

          const listed = await caller.drafts.list({});
          const row = listed.threads.find((t) => t.id === id);
          expect(row?.content).toBe(body);
        });
      },
      30000,
    );
  },
);
