/**
 * Mail router isolation tests (negative).
 *
 * Strategy:
 *   - Use `withSeededTestDb` so the seed rows (transport-centurion, three
 *     mailboxAccess rows) are visible inside the rollback transaction.
 *   - Inside the test transaction, insert a second transport
 *     `transport-frontdesk` + a `user-frontdesk` user + a mailboxAccess row
 *     giving user-frontdesk access to transport-frontdesk ONLY (not centurion).
 *   - Insert a `thread-centurion-1` thread on transport-centurion and a
 *     `thread-frontdesk-1` thread on transport-frontdesk.
 *   - Build callers for `user-frontdesk` (active transport = frontdesk) and
 *     `user-navaai` (active transport = centurion, owner).
 *   - Assert user-frontdesk cannot list/get/mutate centurion threads.
 *
 * `callerFor` patches `getDb()` to return the transaction-scoped db so route
 * code that calls `getDb()` sees the same transaction.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  mailboxTransport,
  mailboxAccess,
  mailThread,
  message,
} from '../src/db/schema/mail.js';
import { user as userAuthTable } from '../src/db/schema/auth.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';
import { seedInboxThread } from './helpers/seed-inbox-thread';
import { refreshThreadSearchVector } from '../src/mail/search/search-vector.js';

const reachable = await probeTestDb();

/**
 * Seed the extra frontdesk transport + user + access + sample threads inside
 * the test transaction. The global seed (transport-centurion + 3 accesses)
 * is already present via `withSeededTestDb`.
 */
async function seedFrontdeskFixture(db: import('../src/db/client.js').DB) {
  await db.insert(userAuthTable).values({
    id: 'user-frontdesk',
    name: 'Frontdesk',
    email: 'frontdesk@legacyhotel.com',
    emailVerified: true,
  }).onConflictDoNothing({ target: userAuthTable.email });

  await db.insert(mailboxTransport).values({
    id: 'transport-frontdesk',
    email: 'frontdesk@legacyhotel.com',
    ownerHeaderValue: 'frontdesk@legacyhotel.com',
    mailboxType: 'personal',
    displayName: 'Frontdesk Transport',
    isActive: true,
  }).onConflictDoNothing({ target: mailboxTransport.id });

  await db.insert(mailboxAccess).values({
    id: 'access-frontdesk-frontdesk',
    userId: 'user-frontdesk',
    transportId: 'transport-frontdesk',
    role: 'owner',
  }).onConflictDoNothing({ target: mailboxAccess.id });

  await seedInboxThread(db, {
    threadId: 'thread-centurion-1',
    transportId: 'transport-centurion',
    transportEmail: 'centurion@legacyhotel.com',
    threadRootId: 'centurion-root-1',
    subject: 'Centurion booking #4471',
    snippet: 'Centurion secret thread',
    messageId: 'msg-centurion-iso-1',
    messageIdHeader: 'centurion-iso-1@example.com',
  });
  await seedInboxThread(db, {
    threadId: 'thread-frontdesk-1',
    transportId: 'transport-frontdesk',
    transportEmail: 'frontdesk@legacyhotel.com',
    threadRootId: 'frontdesk-root-1',
    subject: 'Frontdesk shift handover',
    snippet: 'Frontdesk internal thread',
    isRead: true,
    isMessageRead: true,
    fromAddress: 'staff@example.com',
    messageId: 'msg-frontdesk-iso-1',
    messageIdHeader: 'frontdesk-iso-1@example.com',
  });
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'mail router isolation (seeded, transaction-rollback)',
  () => {
    it(
      'user without Centurion access cannot search Centurion threads',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedFrontdeskFixture(db);
          await refreshThreadSearchVector(db, 'thread-centurion-1');
          await refreshThreadSearchVector(db, 'thread-frontdesk-1');
          const caller = await callerFor('user-frontdesk', { db });
          for (const q of ['4471', 'Centurion', 'centurion secret']) {
            const result = await caller.mail.listThreads({ folder: 'inbox', q });
            expect(
              result.threads.every((t) => t.transportId !== 'transport-centurion'),
            ).toBe(true);
            expect(result.threads.some((t) => t.id === 'thread-centurion-1')).toBe(
              false,
            );
          }
        });
      },
      30000,
    );

    it(
      'admin with Centurion and Nava grants lists one transport per active mailbox',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedFrontdeskFixture(db);
          await seedInboxThread(db, {
            threadId: 'thread-nava-iso-1',
            transportId: 'transport-nava',
            transportEmail: 'navaai@legacyhotels.co.za',
            subject: 'Nava ops thread',
            snippet: 'Nava-only inbox row',
            messageId: 'msg-nava-iso-1',
          });
          const centurionCaller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });
          const navaCaller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-nava',
          });
          const centurionList = await centurionCaller.mail.listThreads({
            folder: 'inbox',
          });
          const navaList = await navaCaller.mail.listThreads({ folder: 'inbox' });
          expect(
            centurionList.threads.every((t) => t.transportId === 'transport-centurion'),
          ).toBe(true);
          expect(
            centurionList.threads.some((t) => t.id === 'thread-centurion-1'),
          ).toBe(true);
          expect(centurionList.threads.some((t) => t.transportId === 'transport-nava')).toBe(
            false,
          );
          expect(navaList.threads.every((t) => t.transportId === 'transport-nava')).toBe(true);
          expect(navaList.threads.some((t) => t.id === 'thread-nava-iso-1')).toBe(true);
          expect(navaList.threads.some((t) => t.id === 'thread-centurion-1')).toBe(false);
        });
      },
      30000,
    );

    it(
      'user without Centurion access cannot list Centurion threads',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedFrontdeskFixture(db);
          const caller = await callerFor('user-frontdesk', { db });
          const result = await caller.mail.listThreads({ folder: 'inbox' });
          // user-frontdesk's active transport is transport-frontdesk; no
          // centurion threads may appear.
          expect(
            result.threads.every(
              (t) => t.transportId !== 'transport-centurion',
            ),
          ).toBe(true);
          // And the frontdesk thread IS visible (sanity: caller works).
          expect(
            result.threads.some((t) => t.id === 'thread-frontdesk-1'),
          ).toBe(true);
        });
      },
      30000,
    );

    it(
      'user without Centurion access cannot fetch Centurion thread by id',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedFrontdeskFixture(db);
          const caller = await callerFor('user-frontdesk', { db });
          await expect(
            caller.mail.get({ id: 'thread-centurion-1' }),
          ).rejects.toThrow(/NOT_FOUND/);
        });
      },
      30000,
    );

    it(
      'user without Centurion access cannot mutate Centurion thread by id',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedFrontdeskFixture(db);
          const caller = await callerFor('user-frontdesk', { db });
          await expect(
            caller.mail.markAsRead({ threadIds: ['thread-centurion-1'] }),
          ).rejects.toThrow(/NOT_FOUND/);
        });
      },
      30000,
    );

    it(
      'Centurion owner can list + fetch their own Centurion thread',
      async () => {
        // Sanity: the isolation guard does not lock out legitimate access.
        await withSeededTestDb(async (db) => {
          await seedFrontdeskFixture(db);
          const caller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });
          const result = await caller.mail.listThreads({ folder: 'inbox' });
          expect(
            result.threads.some((t) => t.id === 'thread-centurion-1'),
          ).toBe(true);
          const thread = await caller.mail.get({ id: 'thread-centurion-1' });
          expect(thread.id).toBe('thread-centurion-1');
          expect(thread.transportId).toBe('transport-centurion');
        });
      },
      30000,
    );

    it(
      'user without Centurion access cannot bulk-archive a Centurion thread',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedFrontdeskFixture(db);
          const caller = await callerFor('user-frontdesk', { db });
          // bulkArchive uses requireThreadForTransport which throws NOT_FOUND.
          await expect(
            caller.mail.bulkArchive({ threadIds: ['thread-centurion-1'] }),
          ).rejects.toThrow(/NOT_FOUND/);
        });
      },
      30000,
    );

    it(
      'user without Centurion access cannot snooze a Centurion thread',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedFrontdeskFixture(db);
          const caller = await callerFor('user-frontdesk', { db });
          await expect(
            caller.mail.snoozeThreads({
              threadIds: ['thread-centurion-1'],
              snoozedUntil: new Date(Date.now() + 86400000).toISOString(),
            }),
          ).rejects.toThrow(/NOT_FOUND/);
        });
      },
      30000,
    );

    it(
      'user without Centurion access cannot modify labels on a Centurion thread',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedFrontdeskFixture(db);
          const caller = await callerFor('user-frontdesk', { db });
          await expect(
            caller.mail.modifyLabels({
              threadIds: ['thread-centurion-1'],
              addLabels: ['x'],
              removeLabels: [],
            }),
          ).rejects.toThrow(/NOT_FOUND/);
        });
      },
      30000,
    );

    it(
      'mail.send rejects a spoofed from address',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedFrontdeskFixture(db);
          const caller = await callerFor('user-frontdesk', { db });
          // user-frontdesk's transportEmail is frontdesk@legacyhotel.com.
          // Spoofing centurion@ must be rejected with FORBIDDEN.
          await expect(
            caller.mail.send({
              to: ['guest@example.com'],
              subject: 'hi',
              html: '<p>hi</p>',
              fromEmail: 'centurion@legacyhotel.com',
            }),
          ).rejects.toThrow(/FORBIDDEN/);
        });
      },
      30000,
    );

    it(
      'mail.send from own mailbox stores an outbound row',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedFrontdeskFixture(db);
          const caller = await callerFor('user-frontdesk', { db });
          const result = await caller.mail.send({
            to: ['guest@example.com'],
            subject: 'hello',
            html: '<p>hello</p>',
            text: 'hello',
          });
          // Undo-send queues by default. Check the persisted outbound row;
          // never set undo=0 here (which would contact an SMTP adapter).
          expect(result).toMatchObject({ queued: true });
          expect(result.messageId).toBeTruthy();
          const [outbound] = await db.select({ transportId: message.transportId,
            fromAddress: message.fromAddress, threadId: message.threadId })
            .from(message).where(eq(message.id, result.messageId)).limit(1);
          expect(outbound).toMatchObject({ transportId: 'transport-frontdesk',
            fromAddress: 'frontdesk@legacyhotel.com', threadId: expect.any(String) });
        });
      },
      30000,
    );

    it(
      'drafts are scoped to the caller mailbox',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedFrontdeskFixture(db);
          // user-navaai creates a draft on centurion.
          const centurionCaller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });
          const created = await centurionCaller.drafts.create({
            to: 'guest@example.com',
            subject: 'centurion draft',
            message: 'shh',
            id: null,
          });
          // user-frontdesk lists drafts — must not see the centurion draft.
          const frontdeskCaller = await callerFor('user-frontdesk', { db });
          const list = await frontdeskCaller.drafts.list({});
          expect(
            list.threads.every((t) => t.id !== created.id),
          ).toBe(true);
          // And frontdesk cannot fetch the centurion draft by id.
          await expect(
            frontdeskCaller.drafts.get({ id: created.id }),
          ).rejects.toThrow(/NOT_FOUND/);
        });
      },
      30000,
    );

    it(
      'labels are scoped to the caller mailbox',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedFrontdeskFixture(db);
          const centurionCaller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });
          const created = await centurionCaller.labels.create({
            name: 'centurion-only-label',
          });
          const frontdeskCaller = await callerFor('user-frontdesk', { db });
          const list = await frontdeskCaller.labels.list();
          // User labels returned to frontdesk must not include the centurion
          // label. (System labels are shared and fine.)
          expect(list.every((l) => l.id !== created.id)).toBe(true);
          // And frontdesk cannot delete the centurion label.
          await expect(
            frontdeskCaller.labels.delete({ id: created.id }),
          ).rejects.toThrow(/NOT_FOUND/);
        });
      },
      30000,
    );

    it(
      'returns debug headers only on the Nava transport',
      async () => {
        await withSeededTestDb(async (db) => {
          await db.insert(mailThread).values({
            id: 'thread-nava-debug-1',
            transportId: 'transport-nava',
            threadRootId: 'nava-debug-root-1',
            subject: 'debug',
            snippet: 'debug',
            isArchived: false,
            isStarred: false,
            isRead: false,
            labelIds: [],
            latestMessageAt: new Date(),
          });
          await db.insert(message).values({
            id: 'msg-nava-debug-1',
            transportId: 'transport-nava',
            threadId: 'thread-nava-debug-1',
            direction: 'inbound',
            fromAddress: 'guest@example.com',
            toAddresses: ['navaai@legacyhotels.co.za'],
            ccAddresses: [],
            bccAddresses: [],
            subject: 'debug',
            textBody: 'debug',
            ownerHeaderValue: 'navaai@legacyhotels.co.za',
            messageIdHeader: 'debug-1@example.com',
            receivedAt: new Date(),
          });

          const nava = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-nava',
          });
          const navaThread = await nava.mail.get({ id: 'thread-nava-debug-1' });
          expect(navaThread.messages[0]!.debugHeaders).toContainEqual({
            key: 'x-zero-mailbox',
            line: 'X-Zero-Mailbox: navaai@legacyhotels.co.za',
          });

          await seedFrontdeskFixture(db);
          await db.insert(message).values({
            id: 'msg-centurion-debug-1',
            transportId: 'transport-centurion',
            threadId: 'thread-centurion-1',
            direction: 'inbound',
            fromAddress: 'guest@example.com',
            toAddresses: ['centurion@legacyhotel.com'],
            ccAddresses: [],
            bccAddresses: [],
            subject: 'centurion debug',
            textBody: 'centurion debug',
            ownerHeaderValue: 'centurion@legacyhotel.com',
            messageIdHeader: 'centurion-debug-1@example.com',
            receivedAt: new Date(),
          });
          const centurion = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });
          const centurionThread = await centurion.mail.get({ id: 'thread-centurion-1' });
          expect(centurionThread.messages[0]!.debugHeaders).toBeUndefined();
        });
      },
      30000,
    );

    it(
      'connections.list returns only transports the user can access',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedFrontdeskFixture(db);
          // user-frontdesk should see ONLY transport-frontdesk.
          const { callerForPrivate } = await import('./helpers/trpc-caller');
          const c = await callerForPrivate('user-frontdesk', { db });
          const result = await c.connections.list();
          expect(
            result.connections.every((c) => c.id !== 'transport-centurion'),
          ).toBe(true);
          expect(
            result.connections.some((c) => c.id === 'transport-frontdesk'),
          ).toBe(true);
        });
      },
      30000,
    );
  },
);

// Suppress unused-import lint (kept for ad-hoc assertions if extended).
