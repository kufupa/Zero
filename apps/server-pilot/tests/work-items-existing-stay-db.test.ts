import { mailboxTransport, mailThread, message } from '../src/db/schema/mail.js';
import { ensureWorkItemForMessage, listWorkItems, storedWorkFor, openStoredWork } from '../src/ai/work-items.js';
import { TEST_DB_AVAILABLE, withTestDb } from './helpers/test-db.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import type { DB } from '../src/db/client.js';
import { describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';

const TRANSPORT_ID = 'work-items-existing-stay-db-transport';
const THREAD_ID = 'work-items-existing-stay-db-thread';
const MESSAGE_ID = 'work-items-existing-stay-db-message';
const INTERNET_MESSAGE_ID = '<work-items-existing-stay-db@example.invalid>';
const MAILBOX_ADDRESS = 'work-items-existing-stay-db@example.invalid';

async function seedExistingStayMail(db: DB) {
  await db.insert(mailboxTransport).values({
    id: TRANSPORT_ID,
    email: MAILBOX_ADDRESS,
    ownerHeaderValue: MAILBOX_ADDRESS,
    mailboxType: 'personal',
  });
  await db.insert(mailThread).values({
    id: THREAD_ID,
    transportId: TRANSPORT_ID,
    threadRootId: THREAD_ID,
    subject: 'Pre-arrival information for a confirmed stay',
  });
  await db.insert(message).values({
    id: MESSAGE_ID,
    transportId: TRANSPORT_ID,
    threadId: THREAD_ID,
    direction: 'inbound',
    fromAddress: MAILBOX_ADDRESS,
    toAddresses: [MAILBOX_ADDRESS],
    subject: 'Pre-arrival information for a confirmed stay',
    textBody: 'Synthetic pre-arrival information.',
    ownerHeaderValue: MAILBOX_ADDRESS,
    // Ingest stores the canonical id (no angle brackets, lower case); lookups canonicalize the header.
    messageIdHeader: 'work-items-existing-stay-db@example.invalid',
  });
  await db.insert(mailExtraction).values({
    messageId: MESSAGE_ID,
    extractorVersion: 'existing-stay-db-test-v1',
    status: 'succeeded',
    kind: 'booking',
    payload: {
      origin: 'person',
      contact: { name: null, email: null, phone: null },
      agency: null,
      endClient: null,
      confirmationNumbers: ['57291630-1'],
      stays: [],
      missing: [],
    },
  });
}

describe.skipIf(!TEST_DB_AVAILABLE)(
  'stored existing-stay information (disposable PostgreSQL)',
  () => {
    it('maps an old booking extraction to other and does not create a booking work item', async () => {
      await withTestDb(async (db) => {
        await seedExistingStayMail(db);
        const input = { transportId: TRANSPORT_ID, internetMessageId: INTERNET_MESSAGE_ID };

        const stored = await storedWorkFor(db, input);
        expect(stored).toMatchObject({
          status: 'ready',
          kind: 'other',
          existingStayInformation: true,
          confirmationNumbers: ['57291630-1'],
          workItemId: null,
        });

        const opened = await openStoredWork(db, input);
        expect(opened).toMatchObject({
          status: 'ready',
          kind: 'other',
          existingStayInformation: true,
          workItemId: null,
        });
        const items = await db
          .select({ id: workItem.id })
          .from(workItem)
          .where(
            and(eq(workItem.transportId, TRANSPORT_ID), eq(workItem.sourceMessageId, MESSAGE_ID)),
          );
        expect(items).toHaveLength(0);
      });
    });

    it.each(['text', 'html'] as const)('opens and lists only the grounded separate %s work item', async (format) => {
      await withTestDb(async (db) => {
        await seedExistingStayMail(db);
        const ask = 'Please send the conference catering menu.';
        await db.update(message).set({
          textBody: format === 'text' ? `Arrival details. ${ask}` : null,
          htmlBody: format === 'html' ? `<p>Arrival details.</p><p>${ask}</p>` : null,
        }).where(eq(message.id, MESSAGE_ID));
        await db.update(mailExtraction).set({
          kind: 'other',
          payload: {
            origin: 'system_notice', needsAction: true, action: 'group_event', separateAsk: ask,
            contact: { name: null, email: null, phone: null }, agency: null, endClient: null,
            confirmationNumbers: ['57291630-1'], stays: [], missing: [],
          },
        }).where(eq(mailExtraction.messageId, MESSAGE_ID));
        const input = { transportId: TRANSPORT_ID, internetMessageId: INTERNET_MESSAGE_ID };
        expect(await storedWorkFor(db, input)).toMatchObject({
          status: 'ready', kind: 'other', existingStayInformation: true, separateAsk: ask, workItemId: null,
        });
        const opened = await openStoredWork(db, input);
        expect(opened).toMatchObject({ status: 'ready', kind: 'other', separateAsk: ask });
        expect(opened.status === 'ready' && opened.workItemId).toBeTruthy();
        expect(await storedWorkFor(db, input)).toMatchObject({ status: 'ready', separateAsk: ask,
          workItemId: opened.status === 'ready' ? opened.workItemId : null });
        const listed = await listWorkItems(db, { transportId: TRANSPORT_ID, statuses: ['needs_you'], limit: 10 });
        expect(listed).toMatchObject([{ sourceMessageId: MESSAGE_ID, kind: 'other_actionable' }]);
        const [item] = await db.select({ kind: workItem.kind }).from(workItem)
          .where(eq(workItem.sourceMessageId, MESSAGE_ID));
        expect(item?.kind).toBe('other');
      });
    });

    it('fills the limit after rejecting invalid pre-stay candidates across ordered pages', async () => {
      await withTestDb(async (db) => {
        await seedExistingStayMail(db);
        const ask = 'Please send the conference catering menu.';
        const candidates: Array<{
          name: string; from?: string; body?: string; needsAction?: boolean; action?: string;
          subject?: string; confirmations?: string[]; kind?: string; excerpt?: string;
          receivedAt?: string; status?: string;
        }> = [
          { name: 'not-self', from: 'guest@example.invalid' },
          { name: 'ungrounded', body: 'No separate request here.' },
          { name: 'not-actionable', needsAction: false },
          { name: 'wrong-action', action: 'booking' },
          { name: 'no-confirmation', subject: 'Pre Stay information', confirmations: [] },
          { name: 'old-booking', kind: 'booking' },
          { name: 'blank', excerpt: '   ' },
          ...Array.from({ length: 92 }, (_, index) => ({
            name: `invalid-${index}`, body: 'No separate request here.',
          })),
          { name: 'separate', receivedAt: '2027-01-01 00:00:10.000001' },
          { name: 'booking', kind: 'booking', from: 'guest@example.invalid', receivedAt: '2027-01-01 00:00:10.000002' },
          { name: 'tie-before', kind: 'booking', from: 'guest@example.invalid', receivedAt: '2027-01-01 00:00:10.000002' },
          { name: 'review', status: 'review', receivedAt: '2026-01-01 00:00:00' },
        ];
        for (const [index, candidate] of candidates.entries()) {
          const id = `pagination-${candidate.name}`;
          await db.insert(message).values({
            id, transportId: TRANSPORT_ID, threadId: THREAD_ID, direction: 'inbound',
            fromAddress: candidate.from ?? MAILBOX_ADDRESS, toAddresses: [MAILBOX_ADDRESS],
            subject: candidate.subject ?? 'Pre Stay : Property Confirmation No 57291630-1',
            textBody: candidate.body ?? `Arrival details. ${ask}`,
            receivedAt: sql`${candidate.receivedAt ?? `2026-12-31 23:59:59.${String(index).padStart(6, '0')}`}::timestamp`,
          });
          const [extraction] = await db.insert(mailExtraction).values({
            messageId: id, extractorVersion: 'pagination-v1', status: 'succeeded',
            kind: candidate.kind ?? 'other',
            payload: {
              origin: 'person', needsAction: candidate.needsAction ?? true,
              action: candidate.action ?? 'group_event', separateAsk: candidate.excerpt ?? ask,
              confirmationNumbers: candidate.confirmations ?? ['57291630-1'],
            },
          }).returning({ id: mailExtraction.id });
          await db.insert(workItem).values({
            // Descending UUIDs ensure microsecond precision, not ID, controls the two adjacent rows.
            id: `00000000-0000-0000-0000-${String(1000 - index).padStart(12, '0')}`,
            transportId: TRANSPORT_ID, threadId: THREAD_ID, sourceMessageId: id,
            extractionId: extraction!.id, kind: candidate.kind ?? 'other',
            status: candidate.status ?? 'needs_you',
          });
        }
        const list = (limit: number) => listWorkItems(db, {
          transportId: TRANSPORT_ID, statuses: ['needs_you', 'review'], limit,
        });
        expect((await list(1)).map((row) => row.sourceMessageId)).toEqual(['pagination-separate']);
        expect((await list(2)).map((row) => row.sourceMessageId)).toEqual([
          'pagination-separate', 'pagination-tie-before',
        ]);
        expect((await list(10)).map((row) => [row.sourceMessageId, row.kind, row.chip])).toEqual([
          ['pagination-separate', 'other_actionable', 'needs_you'],
          ['pagination-tie-before', 'booking', 'needs_you'],
          ['pagination-booking', 'booking', 'needs_you'],
          ['pagination-review', 'other_actionable', 'review'],
        ]);
        expect((await listWorkItems(db, {
          transportId: TRANSPORT_ID, statuses: ['needs_you', 'review'], limit: 10,
          receivedSince: new Date('2027-01-01T00:00:10.000Z'),
        })).map((row) => row.sourceMessageId)).toEqual([
          'pagination-separate', 'pagination-tie-before', 'pagination-booking',
        ]);
        await db.update(workItem).set({ status: 'done' }).where(inArray(workItem.sourceMessageId, [
          'pagination-separate', 'pagination-tie-before', 'pagination-booking', 'pagination-review',
        ]));
        expect(await list(2)).toEqual([]);
      });
    });

    it('reopens only an automatically closed self-mail item when a reread finds a separate ask', async () => {
      await withTestDb(async (db) => {
        await seedExistingStayMail(db);
        await db.update(message).set({ direction: 'outbound' }).where(eq(message.id, MESSAGE_ID));
        await db.update(mailExtraction).set({ kind: 'other' }).where(eq(mailExtraction.messageId, MESSAGE_ID));
        const input = { transportId: TRANSPORT_ID, messageId: MESSAGE_ID };
        const pure = await ensureWorkItemForMessage(db, input);
        expect(pure?.status).toBe('done');
        const ask = 'Please send the conference catering menu.';
        await db.update(message).set({ textBody: `Arrival details. ${ask}` }).where(eq(message.id, MESSAGE_ID));
        await db.update(mailExtraction).set({ payload: {
          origin: 'person', needsAction: true, action: 'group_event', separateAsk: ask,
          contact: { name: null, email: null, phone: null }, agency: null, endClient: null,
          confirmationNumbers: ['57291630-1'], stays: [], missing: [],
        } }).where(eq(mailExtraction.messageId, MESSAGE_ID));
        const mixed = await ensureWorkItemForMessage(db, input);
        expect(mixed?.id).toBe(pure?.id);
        expect(mixed?.status).toBe('needs_you');
        expect(await listWorkItems(db, { transportId: TRANSPORT_ID, statuses: ['needs_you'], limit: 10 }))
          .toMatchObject([{ sourceMessageId: MESSAGE_ID, kind: 'other_actionable' }]);
      });
    });

    it('keeps a booking item opened before the rule out of Needs You, but not real booking work', async () => {
      await withTestDb(async (db) => {
        await seedExistingStayMail(db);
        const [extraction] = await db
          .select({ id: mailExtraction.id })
          .from(mailExtraction)
          .where(eq(mailExtraction.messageId, MESSAGE_ID));
        await db.insert(workItem).values({
          transportId: TRANSPORT_ID,
          threadId: THREAD_ID,
          sourceMessageId: MESSAGE_ID,
          extractionId: extraction!.id,
          kind: 'booking',
          status: 'needs_you',
        });
        await db.insert(message).values({
          id: 'work-items-existing-stay-db-guest-message',
          transportId: TRANSPORT_ID,
          threadId: THREAD_ID,
          direction: 'inbound',
          fromAddress: 'guest@example.invalid',
          toAddresses: [MAILBOX_ADDRESS],
          subject: 'Pre Stay booking request Confirmation No 57291630-2',
          textBody: 'Synthetic guest request.',
          ownerHeaderValue: MAILBOX_ADDRESS,
          messageIdHeader: 'work-items-existing-stay-db-guest@example.invalid',
        });
        await db.insert(workItem).values({
          transportId: TRANSPORT_ID,
          threadId: THREAD_ID,
          sourceMessageId: 'work-items-existing-stay-db-guest-message',
          kind: 'booking',
          status: 'needs_you',
        });

        const listed = await listWorkItems(db, {
          transportId: TRANSPORT_ID,
          statuses: ['needs_you'],
          limit: 10,
        });

        expect(listed.map((row) => row.sourceMessageId)).toEqual([
          'work-items-existing-stay-db-guest-message',
        ]);
      });
    });
  },
);
