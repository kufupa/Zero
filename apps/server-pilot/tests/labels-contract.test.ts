/**
 * Labels contract: duplicate name → CONFLICT; other PG errors rethrow.
 */
import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'labels contract (seeded, transaction-rollback)',
  () => {
    it(
      'labels.create duplicate name → CONFLICT',
      async () => {
        await withSeededTestDb(async (db) => {
          const caller = await callerFor('user-navaai', { db });
          const name = `dup-create-${Date.now()}`;

          await caller.labels.create({ name });

          await expect(caller.labels.create({ name })).rejects.toMatchObject({
            code: 'CONFLICT',
            message: 'label name already exists on this mailbox',
          });
        });
      },
      30000,
    );

    it(
      'labels.update rename to existing name → CONFLICT',
      async () => {
        await withSeededTestDb(async (db) => {
          const caller = await callerFor('user-navaai', { db });
          const stamp = Date.now();
          const first = `first-${stamp}`;
          const second = `second-${stamp}`;

          const a = await caller.labels.create({ name: first });
          await caller.labels.create({ name: second });

          await expect(
            caller.labels.update({ id: a.id, name: second }),
          ).rejects.toMatchObject({
            code: 'CONFLICT',
            message: 'label name already exists on this mailbox',
          });
        });
      },
      30000,
    );

    it(
      'labels.create non-unique PG error not mapped to CONFLICT',
      async () => {
        await withSeededTestDb(async (db) => {
          const caller = await callerFor('user-navaai', { db });
          const pgErr = Object.assign(new Error('disk full'), { code: '53100' });

          const insertSpy = vi
            .spyOn(db, 'insert')
            .mockImplementationOnce(
              () =>
                ({
                  values: vi.fn().mockRejectedValue(pgErr),
                }) as never,
            );

          const rejection = caller.labels.create({ name: `io-${Date.now()}` });
          await expect(rejection).rejects.toSatisfy((err: unknown) => {
            if (err instanceof TRPCError && err.code === 'CONFLICT') return false;
            const text =
              err instanceof Error
                ? `${err.message}${err.cause instanceof Error ? err.cause.message : ''}`
                : String(err);
            return text.includes('disk full');
          });
          insertSpy.mockRestore();
        });
      },
      30000,
    );

    it(
      'labels.create rejects reserved system folder and label names',
      async () => {
        await withSeededTestDb(async (db) => {
          const caller = await callerFor('user-navaai', { db });
          for (const name of ['Inbox', 'ARCHIVE', 'starred', 'IMPORTANT', 'Spam', 'drafts']) {
            await expect(caller.labels.create({ name })).rejects.toSatisfy((err: unknown) => {
              if (!(err instanceof TRPCError)) return false;
              return err.code === 'BAD_REQUEST' || err.code === 'CONFLICT';
            });
          }
        });
      },
      30000,
    );
  },
);
