/**
 * connections.setDefault persists mailbox_access.is_default (Task 14).
 */
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { mailboxAccess, mailboxTransport } from '../src/db/schema/mail.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';

const reachable = await probeTestDb();

const SECOND_TRANSPORT = 'transport-actions-second';

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'connections.setDefault (seeded, transaction-rollback)',
  () => {
    it('persists is_default and getDefault returns chosen transport', async () => {
      await withSeededTestDb(async (db) => {
        await db
          .insert(mailboxTransport)
          .values({
            id: SECOND_TRANSPORT,
            email: 'second@legacyhotel.com',
            ownerHeaderValue: 'second-owner-header',
            mailboxType: 'shared',
            displayName: 'Second mailbox',
            isActive: true,
          })
          .onConflictDoNothing({ target: mailboxTransport.id });

        await db
          .insert(mailboxAccess)
          .values({
            id: `access-user-navaai-${SECOND_TRANSPORT}`,
            userId: 'user-navaai',
            transportId: SECOND_TRANSPORT,
            role: 'member',
            isDefault: false,
          })
          .onConflictDoNothing({ target: [mailboxAccess.userId, mailboxAccess.transportId] });

        const caller = await callerFor('user-navaai', { db });

        await caller.connections.setDefault({ connectionId: SECOND_TRANSPORT });

        const defaults = await db
          .select({
            transportId: mailboxAccess.transportId,
            isDefault: mailboxAccess.isDefault,
          })
          .from(mailboxAccess)
          .where(
            and(
              eq(mailboxAccess.userId, 'user-navaai'),
              eq(mailboxAccess.isDefault, true),
            ),
          );
        expect(defaults).toHaveLength(1);
        expect(defaults[0]?.transportId).toBe(SECOND_TRANSPORT);

        const def = await caller.connections.getDefault();
        expect(def?.id).toBe(SECOND_TRANSPORT);
      });
    });

    it('returns the requested mailbox when the request names one the user can open', async () => {
      await withSeededTestDb(async (db) => {
        await db
          .insert(mailboxTransport)
          .values({
            id: SECOND_TRANSPORT,
            email: 'second@legacyhotel.com',
            ownerHeaderValue: 'second-owner-header',
            mailboxType: 'shared',
            displayName: 'Second mailbox',
            isActive: true,
          })
          .onConflictDoNothing({ target: mailboxTransport.id });
        await db
          .insert(mailboxAccess)
          .values({
            id: `access-user-navaai-${SECOND_TRANSPORT}`,
            userId: 'user-navaai',
            transportId: SECOND_TRANSPORT,
            role: 'member',
            isDefault: false,
          })
          .onConflictDoNothing({ target: [mailboxAccess.userId, mailboxAccess.transportId] });

        const requested = await callerFor('user-navaai', { db, requestedTransportId: SECOND_TRANSPORT });
        const def = await requested.connections.getDefault();
        expect(def?.id).toBe(SECOND_TRANSPORT);
        expect(def?.email).toBe(requested.ctx.transportEmail);

        const plain = await callerFor('user-navaai', { db });
        expect((await plain.connections.getDefault())?.id).not.toBe(SECOND_TRANSPORT);
      });
    });
  },
);
