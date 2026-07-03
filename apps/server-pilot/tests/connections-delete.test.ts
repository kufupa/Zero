import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { mailboxAccess, mailboxTransport } from '../src/db/schema/mail.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerForPrivate } from './helpers/trpc-caller';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'connections delete (seeded, transaction-rollback)',
  () => {
    it(
      'deleting default mailbox promotes nextDefaultId',
      async () => {
        await withSeededTestDb(async (db) => {
          const extraTransportId = 'transport-delete-promote-1';
          await db.insert(mailboxTransport).values({
            id: extraTransportId,
            email: 'extra@legacyhotel.com',
            displayName: 'Extra',
            mailboxType: 'personal',
            ownerHeaderValue: 'extra@legacyhotel.com',
            isActive: true,
          });
          await db.insert(mailboxAccess).values({
            userId: 'user-manager',
            transportId: extraTransportId,
            role: 'owner',
            isDefault: false,
          });
          await db
            .update(mailboxAccess)
            .set({ isDefault: true })
            .where(
              and(
                eq(mailboxAccess.userId, 'user-manager'),
                eq(mailboxAccess.transportId, 'transport-centurion'),
              ),
            );

          const caller = await callerForPrivate('user-manager', { db });
          const result = await caller.connections.delete({
            connectionId: 'transport-centurion',
          });
          expect(result.nextDefaultId).toBe(extraTransportId);

          const defaultRow = await db
            .select({ transportId: mailboxAccess.transportId })
            .from(mailboxAccess)
            .where(
              and(
                eq(mailboxAccess.userId, 'user-manager'),
                eq(mailboxAccess.isDefault, true),
              ),
            )
            .limit(1);
          expect(defaultRow[0]?.transportId).toBe(extraTransportId);
        });
      },
      30000,
    );

    it(
      'rejects deleting last mailbox',
      async () => {
        await withSeededTestDb(async (db) => {
          const caller = await callerForPrivate('user-centurion-worker', { db });
          await expect(
            caller.connections.delete({ connectionId: 'transport-centurion' }),
          ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        });
      },
      30000,
    );
  },
);
