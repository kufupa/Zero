import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { DB } from '../src/db/client.js';
import { mailboxTransport, mailThread, message } from '../src/db/schema/mail.js';
import { mailExtraction, workEvent, workItem } from '../src/db/schema/work.js';
import { TRANSPORT_EMAIL, TRANSPORT_ID, TRANSPORT_OWNER_HEADER } from '../src/db/seed.js';
import { childOccupancyIsCurrent } from '../src/ai/child-occupancy.js';
import { quotePropertyMatchesOrigin } from '../src/hms/hms-quote-target.js';
import { withQuoteSourceBusyHold } from '../src/hms/quote-source-contention.js';
import { refreshThreadAfterMessageRemoved } from '../src/trpc/routes/mail-helpers.js';
import { openTestDbSession, probeTestDb, TEST_DB_AVAILABLE } from './helpers/test-db.js';

const reachable = await probeTestDb();

async function ensureTransport(db: DB) {
  await db.insert(mailboxTransport).values({ id: TRANSPORT_ID, email: TRANSPORT_EMAIL,
    ownerHeaderValue: TRANSPORT_OWNER_HEADER }).onConflictDoNothing();
}

const groups = [{ id: 'r1', arrivalDate: '2027-10-20', departureDate: '2027-10-21', quantity: 1,
  adults: 2, childrenPerRoom: 0, childrenAges: [] }];
const extractionPayload = {
  contact: { name: null, email: null, phone: null }, agency: null, endClient: null,
  confirmationNumbers: [], missing: [], stays: [{ id: 's1', hotel: null,
    requested: { arrival: '2027-10-20', departure: '2027-10-21' }, booked: null, totalRooms: 1,
    rows: [{ id: 'r1', roomType: null, rooms: 1, adultsPerRoom: 2, childrenPerRoom: 0, childAges: [], board: null }] }],
};

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('quote origin transaction fence (disposable DB)', () => {
  it('excludes inbound inserts and changes until the checked transaction commits', async () => {
    const setup = openTestDbSession(), locker = openTestDbSession(), writer = openTestDbSession();
    const threadId = randomUUID(), selectedId = randomUUID(), newMessageId = randomUUID(), extractionId = randomUUID();
    let release!: () => void, signalReady!: (current: boolean) => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<boolean>((resolve) => { signalReady = resolve; });
    let holding: Promise<unknown> | undefined;
    try {
      await ensureTransport(setup.db);
      await setup.db.insert(mailThread).values({ id: threadId, transportId: TRANSPORT_ID, threadRootId: threadId });
      await setup.db.insert(message).values({ id: selectedId, transportId: TRANSPORT_ID, threadId,
        direction: 'inbound', fromAddress: 'guest@example.invalid', toAddresses: ['centurion@legacyhotels.co.za'] });
      await setup.db.insert(mailExtraction).values({ id: extractionId, messageId: selectedId, extractorVersion: 'initial',
        status: 'succeeded', kind: 'quote', payload: extractionPayload });
      const scope = { transportId: TRANSPORT_ID, threadId, messageId: selectedId, propertyCode: 'HRCEN' };
      holding = locker.db.transaction(async (tx) => {
        const current = await quotePropertyMatchesOrigin({ ...scope, db: tx as unknown as DB, lock: true }) &&
          await childOccupancyIsCurrent(tx as unknown as DB, groups,
            { ...scope, lock: true, allowMissingWorkItem: true });
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
      expect(await blocked(async (db) => { await db.insert(mailExtraction).values({ messageId: selectedId,
        extractorVersion: 'quote-lock-test', status: 'succeeded', kind: 'quote' }); })).toBe('55P03');
      // This insert has no thread FK: the selected-message lock itself must exclude it.
      expect(await blocked(async (db) => { await db.insert(workItem).values({ transportId: TRANSPORT_ID,
        sourceMessageId: selectedId, kind: 'quote' }); })).toBe('55P03');
      expect(await blocked(async (db) => { await db.update(mailExtraction).set({ kind: 'other' })
        .where(eq(mailExtraction.id, extractionId)); })).toBe('55P03');
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

  it('holds rather than deadlocks when a sibling event precedes the source thread lock', async () => {
    const setup = openTestDbSession(), quote = openTestDbSession(), editor = openTestDbSession();
    const threadId = randomUUID(), selectedId = randomUUID(), siblingId = randomUUID();
    const extractionId = randomUUID(), quoteItemId = randomUUID();
    let signalEventWritten!: () => void, startThreadUpdate!: () => void, signalThreadUpdate!: () => void;
    const eventWritten = new Promise<void>((resolve) => { signalEventWritten = resolve; });
    const updateThread = new Promise<void>((resolve) => { startThreadUpdate = resolve; });
    const threadUpdateStarted = new Promise<void>((resolve) => { signalThreadUpdate = resolve; });
    let writer: Promise<unknown> | undefined;
    try {
      await ensureTransport(setup.db);
      await setup.db.insert(mailThread).values({ id: threadId, transportId: TRANSPORT_ID, threadRootId: threadId });
      await setup.db.insert(message).values({ id: selectedId, transportId: TRANSPORT_ID, threadId,
        direction: 'inbound', fromAddress: 'guest@example.invalid', toAddresses: ['centurion@legacyhotels.co.za'] });
      await setup.db.insert(mailExtraction).values({ id: extractionId, messageId: selectedId, extractorVersion: 'initial',
        status: 'succeeded', kind: 'quote', payload: extractionPayload });
      await setup.db.insert(workItem).values({ id: quoteItemId, transportId: TRANSPORT_ID, threadId,
        sourceMessageId: selectedId, kind: 'quote', extractionId });
      await setup.db.insert(workItem).values({ id: siblingId, transportId: TRANSPORT_ID, threadId,
        sourceMessageId: selectedId, kind: 'other' });
      writer = editor.db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '3s'`);
        await tx.insert(workEvent).values({ workItemId: siblingId, actorKind: 'user', type: 'field.edit',
          fieldPath: 'note', value: 'A saved correction' });
        signalEventWritten();
        await updateThread;
        signalThreadUpdate();
        await tx.update(mailThread).set({ snippet: 'Editor refresh' }).where(eq(mailThread.id, threadId));
        // work_event is append-only; roll the synthetic event back so teardown can remove the fixture.
        throw new Error('rollback synthetic event');
      });
      void writer.catch(() => signalEventWritten());
      await eventWritten;
      const scope = { transportId: TRANSPORT_ID, threadId, messageId: selectedId, propertyCode: 'HRCEN' };
      const quoteAttempt = withQuoteSourceBusyHold(() => quote.db.transaction(async (tx) => {
        expect(await quotePropertyMatchesOrigin({ ...scope, db: tx as unknown as DB, lock: true })).toBe(true);
        startThreadUpdate();
        await threadUpdateStarted;
        await childOccupancyIsCurrent(tx as unknown as DB, groups, { ...scope, lock: true });
      }));
      await expect(quoteAttempt).rejects.toThrow('The email is being updated. Wait a moment, then try again.');
      await expect(writer).rejects.toThrow('rollback synthetic event');
    } finally {
      startThreadUpdate();
      await writer?.catch(() => undefined);
      await setup.db.delete(workItem).where(inArray(workItem.id, [quoteItemId, siblingId])).catch(() => undefined);
      await setup.db.delete(mailThread).where(eq(mailThread.id, threadId)).catch(() => undefined);
      await Promise.all([setup.close(), quote.close(), editor.close()]);
    }
  }, 20_000);

  it.each(['Outlook history', 'Undo Send'])('holds and offers retry when %s changes a message before its thread', async (action) => {
    const setup = openTestDbSession(), quote = openTestDbSession(), outlook = openTestDbSession();
    const threadId = randomUUID(), selectedId = randomUUID(), outboundId = randomUUID();
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
      await setup.db.insert(message).values({ id: outboundId, transportId: TRANSPORT_ID, threadId,
        direction: 'outbound', fromAddress: 'centurion@legacyhotels.co.za', toAddresses: ['guest@example.invalid'] });
      const scope = { transportId: TRANSPORT_ID, threadId, messageId: selectedId, propertyCode: 'HRCEN' };
      writer = outlook.db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '3s'`);
        if (action === 'Outlook history')
          await tx.update(message).set({ textBody: 'Outlook history update' }).where(eq(message.id, selectedId));
        else await tx.delete(message).where(eq(message.id, outboundId));
        signalMessageLocked();
        await updateThread;
        signalThreadUpdate();
        if (action === 'Outlook history')
          await tx.update(mailThread).set({ snippet: 'Outlook history refresh' }).where(eq(mailThread.id, threadId));
        else await refreshThreadAfterMessageRemoved(tx as unknown as DB, threadId, TRANSPORT_ID);
      });
      void writer.catch(() => signalMessageLocked());
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
      if (action === 'Undo Send')
        expect(await setup.db.select({ id: message.id }).from(message).where(eq(message.id, outboundId))).toHaveLength(0);
    } finally {
      startThreadUpdate();
      await writer?.catch(() => undefined);
      await setup.db.delete(mailThread).where(eq(mailThread.id, threadId)).catch(() => undefined);
      await Promise.all([setup.close(), quote.close(), outlook.close()]);
    }
  }, 20_000);

  it('rolls back and offers retry if a later work-item write would invert the thread lock', async () => {
    const setup = openTestDbSession(), quote = openTestDbSession(), editor = openTestDbSession();
    const threadId = randomUUID(), selectedId = randomUUID(), itemId = randomUUID();
    let signalItemLocked!: () => void, startThreadUpdate!: () => void, signalThreadUpdate!: () => void;
    const itemLocked = new Promise<void>((resolve) => { signalItemLocked = resolve; });
    const updateThread = new Promise<void>((resolve) => { startThreadUpdate = resolve; });
    const threadUpdateStarted = new Promise<void>((resolve) => { signalThreadUpdate = resolve; });
    let writer: Promise<unknown> | undefined;
    try {
      await ensureTransport(setup.db);
      await setup.db.insert(mailThread).values({ id: threadId, transportId: TRANSPORT_ID, threadRootId: threadId });
      await setup.db.insert(message).values({ id: selectedId, transportId: TRANSPORT_ID, threadId,
        direction: 'inbound', fromAddress: 'guest@example.invalid', toAddresses: ['centurion@legacyhotels.co.za'] });
      await setup.db.insert(workItem).values({ id: itemId, transportId: TRANSPORT_ID,
        threadId, sourceMessageId: selectedId, kind: 'quote' });
      const scope = { transportId: TRANSPORT_ID, threadId, messageId: selectedId, propertyCode: 'HRCEN' };
      writer = editor.db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '3s'`);
        await tx.update(workItem).set({ status: 'done' }).where(eq(workItem.id, itemId));
        signalItemLocked();
        await updateThread;
        signalThreadUpdate();
        await tx.update(mailThread).set({ snippet: 'Editor refresh' }).where(eq(mailThread.id, threadId));
      });
      void writer.catch(() => signalItemLocked());
      await itemLocked;
      const quoteAttempt = withQuoteSourceBusyHold(() => quote.db.transaction(async (tx) => {
        expect(await quotePropertyMatchesOrigin({ ...scope, db: tx as unknown as DB, lock: true })).toBe(true);
        startThreadUpdate();
        await threadUpdateStarted;
        await tx.update(workItem).set({ status: 'review' }).where(eq(workItem.id, itemId));
      }));
      await expect(quoteAttempt).rejects.toThrow('The email is being updated. Wait a moment, then try again.');
      await writer;
      const [stored] = await setup.db.select({ status: workItem.status }).from(workItem).where(eq(workItem.id, itemId));
      expect(stored?.status).toBe('done');
    } finally {
      startThreadUpdate();
      await writer?.catch(() => undefined);
      await setup.db.delete(workItem).where(eq(workItem.id, itemId)).catch(() => undefined);
      await setup.db.delete(mailThread).where(eq(mailThread.id, threadId)).catch(() => undefined);
      await Promise.all([setup.close(), quote.close(), editor.close()]);
    }
  }, 20_000);
});
