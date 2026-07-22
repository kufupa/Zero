import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { userSettings } from '../src/db/schema/app.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerForPrivate } from './helpers/trpc-caller';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'settings save (seeded, transaction-rollback)',
  () => {
    it(
      'concurrent first saves upsert without PK violation',
      async () => {
        await withSeededTestDb(async (db) => {
          const caller = await callerForPrivate('user-navaai', { db });
          await Promise.all([
            caller.settings.save({ locale: 'en' }),
            caller.settings.save({ colorTheme: 'dark' }),
          ]);
          const rows = await db
            .select()
            .from(userSettings)
            .where(eq(userSettings.userId, 'user-navaai'));
          expect(rows).toHaveLength(1);
        });
      },
      30000,
    );

    it(
      'long customPrompt save succeeds',
      async () => {
        await withSeededTestDb(async (db) => {
          const caller = await callerForPrivate('user-navaai', { db });
          const longPrompt = 'x'.repeat(20_000);
          await caller.settings.save({ customPrompt: longPrompt });
          const got = await caller.settings.get();
          expect(got.settings.customPrompt).toBe(longPrompt);
        });
      },
      30000,
    );
  },
);
