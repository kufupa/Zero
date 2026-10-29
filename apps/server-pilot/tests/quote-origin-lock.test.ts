import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { DB } from '../src/db/client.js';
import { mailboxTransport, mailThread, message } from '../src/db/schema/mail.js';
import { TRANSPORT_EMAIL, TRANSPORT_ID, TRANSPORT_OWNER_HEADER } from '../src/db/seed.js';
import { quotePropertyMatchesOrigin } from '../src/hms/hms-quote-target.js';
import { openTestDbSession, probeTestDb, TEST_DB_AVAILABLE } from './helpers/test-db.js';

const reachable = await probeTestDb();

async function ensureTransport(db: DB) {
  await db.insert(mailboxTransport).values({ id: TRANSPORT_ID, email: TRANSPORT_EMAIL,
    ownerHeaderValue: TRANSPORT_OWNER_HEADER }).onConflictDoNothing();
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('quote origin transaction fence (disposable DB)', () => {
  it('excludes inbound inserts and changes until the checked transaction commits', async () => {
    const setup = openTestDbSession(), locker = openTestDbSession(), writer = openTestDbSession();
    const threadId = randomUUID(), selectedId = randomUUID(), newMessageId = randomUUID();
    let release!: () => void, signalReady!: (current: boolean) => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<boolean>((resolve) => { signalReady = resolve; });
    let holding: Promise<unknown> | undefined;
    try {
      await ensureTransport(setup.db);
      await setup.db.insert(mailThread).values({ id: threadId, transportId: TRANSPORT_ID, threadRootId: threadId });
      await setup.db.insert(message).values({ id: selectedId, transportId: TRANSPORT_ID, threadId,
        direction: 'inbound', fromAddress: 'guest@example.invalid', toAddresses: ['centurion@legacyhotels.co.za'] });
      const scope = { transportId: TRANSPORT_ID, threadId, messageId: selectedId, propertyCode: 'HRCEN' };
      holding = locker.db.transaction(async (tx) => {
        const current = await quotePropertyMatchesOrigin({ ...scope, db: tx as unknown as DB, lock: true });
        signalReady(current);
        await gate;
      });
      void holding.catch(() => signalReady(false));
      expect(await ready).toBe(true);
      const blocked = async (action: (db: DB) => Promise<unknown>) => {
        try {
          await writer.db.transaction(async (tx) => {
            await tx.execute(sql`set local lock_timeout = '250ms'`);
            await action(tx as unknown as DB);
          });
          return null;
        } catch (error) {
          const nested = error as { code?: string; cause?: { code?: string } };
          return nested.cause?.code ?? nested.code ?? null;
        }
      };
      expect(await blocked(async (db) => { await db.insert(message).values({ id: newMessageId, transportId: TRANSPORT_ID,
        threadId, direction: 'inbound', fromAddress: 'davinci@legacyhotels.co.za' }); })).toBe('55P03');
      expect(await blocked(async (db) => { await db.update(message).set({ toAddresses: ['davinci@legacyhotels.co.za'] })
        .where(eq(message.id, selectedId)); })).toBe('55P03');
      release();
      await holding;
      await writer.db.insert(message).values({ id: newMessageId, transportId: TRANSPORT_ID,
        threadId, direction: 'inbound', fromAddress: 'davinci@legacyhotels.co.za' });
      expect(await quotePropertyMatchesOrigin({ ...scope, db: setup.db })).toBe(false);
    } finally {
      release();
      await holding?.catch(() => undefined);
      await setup.db.delete(mailThread).where(eq(mailThread.id, threadId)).catch(() => undefined);
      await Promise.all([setup.close(), locker.close(), writer.close()]);
    }
  }, 20_000);

  it('holds and offers retry when Outlook updates a message before its thread', async () => {
    const setup = openTestDbSession(), quote = openTestDbSession(), outlook = openTestDbSession();
    const threadId = randomUUID(), selectedId = randomUUID();
    let signalMessageLocked!: () => void, startThreadUpdate!: () => void, signalThreadUpdate!: () => void;
    const messageLocked = new Promise<void>((resolve) => { signalMessageLocked = resolve; });
    const updateThread = new Promise<void>((resolve) => { startThreadUpdate = resolve; });
    const threadUpdateStarted = new Promise<void>((resolve) => { signalThreadUpdate = resolve; });
    let writer: Promise<unknown> | undefined;
    try {
      await ensureTransport(setup.db);
      await setup.db.insert(mailThread).values({ id: threadId, transportId: TRANSPORT_ID, threadRootId: threadId });
      await setup.db.insert(message).values({ id: selectedId, transportId: TRANSPORT_ID, threadId,
        direction: 'inbound', fromAddress: 'guest@example.invalid', toAddresses: ['centurion@legacyhotels.co.za'] });
      const scope = { transportId: TRANSPORT_ID, threadId, messageId: selectedId, propertyCode: 'HRCEN' };
      writer = outlook.db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '3s'`);
        await tx.update(message).set({ textBody: 'Outlook history update' }).where(eq(message.id, selectedId));
        signalMessageLocked();
        await updateThread;
        signalThreadUpdate();
        await tx.update(mailThread).set({ snippet: 'Outlook history refresh' }).where(eq(mailThread.id, threadId));
      });
      await messageLocked;
      const quoteAttempt = quote.db.transaction(async (tx) => {
        // The actual quote fence takes the thread before reading its messages.
        await tx.execute(sql`set local lock_timeout = '600ms'`);
        await tx.select({ id: mailThread.id }).from(mailThread).where(eq(mailThread.id, threadId)).for('update');
        startThreadUpdate();
        await threadUpdateStarted;
        if (!(await quotePropertyMatchesOrigin({ ...scope, db: tx as unknown as DB, lock: true }))) {
          throw new Error('The hotel for this email changed.');
        }
      });
      await expect(quoteAttempt).rejects.toThrow('The email is being updated. Wait a moment, then try again.');
      await writer;
      expect(await quotePropertyMatchesOrigin({ ...scope, db: setup.db })).toBe(true);
    } finally {
      startThreadUpdate();
      await writer?.catch(() => undefined);
      await setup.db.delete(mailThread).where(eq(mailThread.id, threadId)).catch(() => undefined);
      await Promise.all([setup.close(), quote.close(), outlook.close()]);
    }
  }, 20_000);
});
