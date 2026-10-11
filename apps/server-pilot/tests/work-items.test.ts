import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import type { AttachmentRead } from '../src/ai/extraction/extract.js';
import { EXTRACTION_VERSION, runInboundExtraction } from '../src/ai/extraction/inbound-run.js';
import type { MailExtractionPayload } from '../src/ai/extraction/schema.js';
import {
  aiValueAt,
  correctionsCarryTo,
  dismissWorkItem,
  ensureWorkItem,
  ensureWorkItemForMessage,
  formStays,
  listWorkItems,
  openStoredWork,
  parseFieldPath,
  recordFieldEvent,
  storedTranslation,
  storedWorkFor,
  validFieldValue,
  workItemIdForMail,
} from '../src/ai/work-items.js';
import { maskStaffNote, recordStaffNote } from '../src/ai/work-events.js';
import { HMS_JOB_PROMPT_VERSION, NOT_APPLICABLE_MODEL_ID } from '../src/ai/run-ledger.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import * as schema from '../src/db/schema/index.js';
import { aiWorkflowRun, mailboxTransport, mailDraft, mailThread, message } from '../src/db/schema/mail.js';
import { mailExtraction, workEvent, workItem } from '../src/db/schema/work.js';
import { user } from '../src/db/schema/auth.js';
import { NAVA_USER_EMAIL, NAVA_USER_ID } from '../src/db/seed.js';
import { appRouter } from '../src/trpc/router.js';
import { AE1_OUTPUT, AE1_TEXT, fakeModel, selectionFor } from './fixtures/inbound-extraction.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';

const CENTURION = 'transport-centurion';
const OTHER = 'transport-other';
const USER = 'user-ropperman';
const STAY_ONE = 's_aaaa1111';
const STAY_TWO = 's_cccc2222';
const ROW_SINGLE = 'r_bbbb1111';
const ROW_TWIN = 'r_bbbb2222';
const ROW_STAY_TWO = 'r_dddd1111';

/** Two stays, the first with two room rows and the second with one. Dates are the AI's first read. */
function payload(dates: { stayOneArrival?: string; stayTwoArrival?: string } = {}): MailExtractionPayload {
  return {
    contact: { name: null, email: null, phone: null },
    agency: 'Horizon Trail Tours',
    endClient: null,
    confirmationNumbers: [],
    stays: [
      {
        id: STAY_ONE,
        hotel: 'Grand Hotel',
        requested: { arrival: dates.stayOneArrival ?? '2027-10-26', departure: '2027-10-28' },
        booked: null,
        totalRooms: null,
        rows: [
          { id: ROW_SINGLE, roomType: 'Single', rooms: 2, adultsPerRoom: 1, childAges: [], board: null },
          { id: ROW_TWIN, roomType: 'Double/Twin', rooms: 3, adultsPerRoom: 2, childAges: [], board: 'bb' },
        ],
      },
      {
        id: STAY_TWO,
        hotel: 'Grand Hotel',
        requested: { arrival: dates.stayTwoArrival ?? '2027-11-17', departure: '2027-11-19' },
        booked: null,
        totalRooms: null,
        rows: [{ id: ROW_STAY_TWO, roomType: 'Double/Twin', rooms: 4, adultsPerRoom: 2, childAges: [], board: null }],
      },
    ],
    missing: [{ field: 'rooms', question: 'How many single rooms?' }],
  };
}

/** Runs one test against a fresh database with the test transport seeded and the work-item pane DB injected. */
function withDb(run: (db: DB) => Promise<void>) {
  return withIngestionDb(async ({ db, sql }) => {
    __setDbForTests({ db, conn: sql });
    try {
      await run(db);
    } finally {
      __setDbForTests(null);
    }
  });
}

async function addOtherTransport(db: DB) {
  await db.insert(mailboxTransport).values({
    id: OTHER,
    email: 'other@legacyhotels.co.za',
    ownerHeaderValue: 'other@legacyhotels.co.za',
    mailboxType: 'personal',
    sendFromConfig: { aliases: [] },
  });
}

/** One inbound mail with a Message-ID of `<id>@example.com`. Returns the message id. */
async function seedMail(db: DB, id: string, transportId = CENTURION): Promise<string> {
  await seedInboxThread(db, {
    threadId: `thread-${id}`,
    transportId,
    transportEmail: 'centurion@legacyhotels.co.za',
    messageId: `msg-${id}`,
    fromAddress: 'sender@example.com',
    subject: 'Rooms request',
    textBody: 'Please quote.',
    messageIdHeader: `${id}@example.com`,
  });
  return `msg-${id}`;
}

/** Inserts one read for a message, as the inbound run would store it. */
async function insertRead(
  db: DB,
  messageId: string,
  read: {
    version: string;
    status?: 'succeeded' | 'failed';
    kind?: 'quote' | 'amendment' | 'cancellation' | 'other' | 'spam';
    payload?: MailExtractionPayload | null;
    attachments?: AttachmentRead[] | null;
    usage?: Record<string, unknown> | null;
    language?: string | null;
    translation?: Record<string, unknown> | null;
  },
): Promise<string> {
  const [row] = await db
    .insert(mailExtraction)
    .values({
      messageId,
      extractorVersion: read.version,
      status: read.status ?? 'succeeded',
      kind: read.kind ?? 'quote',
      payload: read.payload ?? null,
      attachments: read.attachments ?? null,
      usage: read.usage ?? null,
      language: read.language ?? null,
      translation: read.translation ?? null,
    })
    .returning({ id: mailExtraction.id });
  return row!.id;
}

/** The pane's open of a mail with a stored read: the work item is made or moved to the read (openStoredWork). */
async function readyWork(db: DB, id: string) {
  const work = await openStoredWork(db, { transportId: CENTURION, internetMessageId: `<${id}@example.com>` });
  if (work.status !== 'ready' || !work.workItemId) throw new Error(`expected a ready read, got ${work.status}`);
  return { ...work, workItemId: work.workItemId };
}

async function eventsFor(db: DB, workItemId: string) {
  return db.select().from(workEvent).where(eq(workEvent.workItemId, workItemId));
}

function centurionCaller(activeTransportId = CENTURION) {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: { id: USER, email: 'ropperman@legacyhotels.co.za', name: 'R Opperman' },
    activeTransportId,
    transportEmail: 'centurion@legacyhotels.co.za',
    accessRole: 'owner',
  } as never);
}

describe('stored read for the pane', () => {
  it('shows the stored read as ready, with its groups keyed by row id', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'q1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });

      const work = await readyWork(db, 'q1');
      expect(work.analysis.intent).toBe('quote');
      expect(work.analysis.groups.map((group) => group.id)).toEqual([ROW_SINGLE, ROW_TWIN, ROW_STAY_TWO]);
      expect(work.analysis.groups[0]).toMatchObject({
        arrivalDate: '2027-10-26',
        departureDate: '2027-10-28',
        quantity: 2,
        adults: 1,
        roomPreference: 'Single',
        organisation: 'Horizon Trail Tours',
        board: 'bb',
      });
      expect(work.analysis.groups[0]!.fields).toMatchObject({
        arrivalDate: 'extracted',
        quantity: 'extracted',
        board: 'defaulted',
      });
      expect(work.analysis.groups[2]!.arrivalDate).toBe('2027-11-17');
      expect(work.refs[ROW_TWIN]).toEqual({ stayId: STAY_ONE, rowId: ROW_TWIN });
      expect(work.analysis.groups.map((group) => group.stayId)).toEqual([STAY_ONE, STAY_ONE, STAY_TWO]);
      expect(work.analysis.reviewItems?.map((item) => item.id)).toContain('missing:rooms:0');
      expect(work.workItemStatus).toBe('needs_you');
    }));

  it('marks a do-not-reply sender on the stored read, as the live read does, so the pane hides its reply controls', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'nr1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const lookup = { transportId: CENTURION, internetMessageId: '<nr1@example.com>' };
      expect(await storedWorkFor(db, lookup)).toMatchObject({ status: 'ready', analysis: { noReplySender: false } });

      await db.update(message).set({ fromAddress: 'notifications@vouchers.example' }).where(eq(message.id, messageId));
      expect(await storedWorkFor(db, lookup)).toMatchObject({ status: 'ready', analysis: { noReplySender: true } });
      expect(await openStoredWork(db, lookup)).toMatchObject({ status: 'ready', analysis: { noReplySender: true } });
    }));

  it('reads a stored read without writing: no work item is made or moved until the pane opens one', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'ro1');
      const first = await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const lookup = { transportId: CENTURION, internetMessageId: '<ro1@example.com>' };

      const unopened = await storedWorkFor(db, lookup);
      expect(unopened).toMatchObject({ status: 'ready', workItemId: null, workItemStatus: null, extractionId: first });
      expect(unopened.status === 'ready' && unopened.analysis.groups).toHaveLength(3);
      expect(await db.select().from(workItem).where(eq(workItem.sourceMessageId, messageId))).toHaveLength(0);

      const opened = await openStoredWork(db, lookup);
      expect(opened).toMatchObject({ status: 'ready', workItemId: expect.any(String), workItemStatus: 'needs_you' });
      expect(await storedWorkFor(db, lookup)).toEqual(opened);

      // A newer read is linked by the inbound run, not by the lookup.
      const [before] = await db.select().from(workItem).where(eq(workItem.sourceMessageId, messageId));
      const second = await insertRead(db, messageId, { version: 'extract-v2', payload: payload() });
      expect(await storedWorkFor(db, lookup)).toMatchObject({ extractionId: first });
      const [after] = await db.select().from(workItem).where(eq(workItem.sourceMessageId, messageId));
      expect(after).toEqual(before);
      await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId });
      expect(await storedWorkFor(db, lookup)).toMatchObject({ extractionId: second });
    }));

  it('the open route makes the work item, and the lookup route only reads', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'ro2');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const caller = centurionCaller();
      expect(await caller.workItems.getByMessage({ internetMessageId: '<ro2@example.com>' })).toMatchObject({
        workItemId: null,
      });
      const opened = await caller.workItems.open({ internetMessageId: '<ro2@example.com>' });
      expect(opened).toMatchObject({ status: 'ready', workItemId: expect.any(String) });
      expect(await db.select().from(workItem).where(eq(workItem.sourceMessageId, messageId))).toHaveLength(1);
      expect(await caller.workItems.getByMessage({ internetMessageId: '<ro2@example.com>' })).toEqual(opened);
    }));

  it('returns none for an unknown mail and for a mail with no read', () =>
    withDb(async (db) => {
      await seedMail(db, 'q2');
      expect(await storedWorkFor(db, { transportId: CENTURION, internetMessageId: 'q2@example.com' })).toEqual({
        status: 'none',
      });
      expect(
        await storedWorkFor(db, { transportId: CENTURION, internetMessageId: 'unknown@example.com' }),
      ).toEqual({ status: 'none' });
    }));

  it('returns the stored failure reason when the latest read failed', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'q3');
      await insertRead(db, messageId, {
        version: 'extract-v1',
        status: 'failed',
        payload: null,
        usage: { failureReason: 'timeout' },
      });
      expect(await storedWorkFor(db, { transportId: CENTURION, internetMessageId: 'q3@example.com' })).toEqual({
        status: 'failed',
        reason: 'Nava ran out of time reading this email.',
      });
    }));

  it('gives an amendment its amendment fields and no groups', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'q4');
      await insertRead(db, messageId, {
        version: 'extract-v1',
        kind: 'amendment',
        payload: {
          ...payload(),
          confirmationNumbers: ['57291630-1'],
          stays: [
            {
              id: STAY_ONE,
              hotel: null,
              requested: { arrival: '2026-10-31', departure: '2026-11-07' },
              booked: { arrival: '2026-11-01', departure: '2026-11-06' },
              totalRooms: null,
              rows: [],
            },
          ],
        },
      });
      const work = await readyWork(db, 'q4');
      expect(work.analysis.intent).toBe('other');
      expect(work.analysis.groups).toEqual([]);
      expect(work.analysis.amendment).toEqual({
        kind: 'amend',
        confirmationNumber: '57291630-1',
        guestLastName: null,
        arrival: '2026-11-01',
        departure: '2026-11-06',
        // AE2: the guest's requested stay rides beside the booked one.
        requestedArrival: '2026-10-31',
        requestedDeparture: '2026-11-07',
        requestedChange: null,
      });
      expect(work.analysis.luna.flags).toContain('amendment_or_cancel');
    }));

  it('gives an amendment with no booked dates in mail no booked dates, never the requested stay (AE2)', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'q4b');
      await insertRead(db, messageId, {
        version: 'extract-v1',
        kind: 'amendment',
        payload: {
          ...payload(),
          confirmationNumbers: ['57291630-1'],
          stays: [
            {
              id: STAY_ONE,
              hotel: null,
              requested: { arrival: '2026-10-31', departure: '2026-11-07' },
              booked: null,
              totalRooms: null,
              rows: [],
            },
          ],
        },
      });
      const work = await readyWork(db, 'q4b');
      expect(work.analysis.amendment).toEqual({
        kind: 'amend',
        confirmationNumber: '57291630-1',
        guestLastName: null,
        // The lookup gets no booked dates, and not the requested 31 Oct to 7 Nov standing in for them.
        arrival: null,
        departure: null,
        requestedArrival: '2026-10-31',
        requestedDeparture: '2026-11-07',
        requestedChange: null,
      });
    }));

  it('flags an unread attachment and lists it as a review item', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'q5');
      await insertRead(db, messageId, {
        version: 'extract-v1',
        payload: payload(),
        attachments: [
          {
            id: 'att-1',
            filename: 'booking-form.pdf',
            mimeType: 'application/pdf',
            byteSize: 90_000,
            status: 'not_read',
            reason: 'scanned PDF: no text layer, not sent to the model',
          },
        ],
      });
      const work = await readyWork(db, 'q5');
      expect(work.analysis.luna.flags).toContain('attachment_unread');
      expect(work.analysis.reviewItems?.map((item) => item.id)).toContain('unread:att-1');
    }));

  it('keeps a stay with dates and no rows as one group on its stay id', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'q6');
      await insertRead(db, messageId, {
        version: 'extract-v1',
        payload: {
          ...payload(),
          stays: [
            {
              id: STAY_ONE,
              hotel: null,
              requested: { arrival: '2027-12-01', departure: '2027-12-03' },
              booked: null,
              totalRooms: null,
              rows: [],
            },
          ],
        },
      });
      const work = await readyWork(db, 'q6');
      expect(work.analysis.groups).toHaveLength(1);
      expect(work.analysis.groups[0]).toMatchObject({ id: STAY_ONE, arrivalDate: '2027-12-01' });
      expect(work.refs[STAY_ONE]).toEqual({ stayId: STAY_ONE, rowId: null });
    }));
});

describe('stored read for the pane: contact and translation', () => {
  it('carries the contact block, with the company as the sender agency and the end client as named', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'c1');
      await insertRead(db, messageId, {
        version: 'extract-v1',
        payload: {
          ...payload(),
          contact: { name: 'Priya Naidoo', email: 'priya@example.com', phone: null },
          endClient: 'Tailormade Africa',
        },
      });

      const work = await readyWork(db, 'c1');
      expect(work.contact).toEqual({
        name: 'Priya Naidoo',
        company: 'Horizon Trail Tours',
        endClient: 'Tailormade Africa',
        email: 'priya@example.com',
        phone: null,
      });
      expect(work.language).toBeNull();
      expect(work.translation).toBeNull();
    }));

  it('shows a non-English read with its translation, and a failed translation as failed', () =>
    withDb(async (db) => {
      const french = await seedMail(db, 'c2');
      await insertRead(db, french, {
        version: 'extract-v1',
        payload: payload(),
        language: 'fr',
        translation: {
          status: 'succeeded',
          sourceLanguage: 'fr',
          truncated: false,
          segments: [{ clean: 'Hello.', literal: 'Good day.' }],
        },
      });
      const failed = await seedMail(db, 'c3');
      await insertRead(db, failed, {
        version: 'extract-v1',
        payload: payload(),
        language: 'fr',
        translation: { status: 'failed', sourceLanguage: 'fr', reason: 'timeout' },
      });

      expect(await readyWork(db, 'c2')).toMatchObject({
        language: 'fr',
        translation: { status: 'succeeded', segments: [{ clean: 'Hello.', literal: 'Good day.' }], truncated: false },
      });
      expect(await readyWork(db, 'c3')).toMatchObject({ language: 'fr', translation: { status: 'failed' } });
    }));

  it('reads a stored translation as succeeded, failed, or none, and drops a segment with no text', () => {
    expect(storedTranslation(null)).toBeNull();
    expect(storedTranslation({ status: 'pending' })).toBeNull();
    expect(storedTranslation({ status: 'failed', reason: 'misaligned' })).toEqual({ status: 'failed' });
    expect(
      storedTranslation({
        status: 'succeeded',
        sourceLanguage: 'fr',
        truncated: true,
        segments: [{ clean: 'A', literal: 'B' }, { clean: 3 }],
      }),
    ).toEqual({ status: 'succeeded', segments: [{ clean: 'A', literal: 'B' }], truncated: true });
  });
});

describe('work item upsert', () => {
  it('stores the read through the inbound run, and a re-run keeps the same single work item', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'ae1');
      const model = fakeModel(() => AE1_OUTPUT);
      const run = { transportId: CENTURION, triggerMessageId: messageId, promptVersion: EXTRACTION_VERSION };
      const deps = {
        db,
        env: { INBOUND_EXTRACTION: 'on' } as NodeJS.ProcessEnv,
        adapter: model.adapter,
        loadSelection: async () => selectionFor(AE1_TEXT),
      };
      expect(await runInboundExtraction(run, deps)).toBe('stored');

      const [item] = await db.select().from(workItem).where(eq(workItem.sourceMessageId, messageId));
      const [read] = await db
        .select({ id: mailExtraction.id })
        .from(mailExtraction)
        .where(eq(mailExtraction.messageId, messageId));
      expect(item).toMatchObject({ kind: 'quote', status: 'needs_you', transportId: CENTURION });
      expect(item!.extractionId).toBe(read!.id);

      expect(await runInboundExtraction(run, deps)).toBe('exists');
      expect(await db.select().from(workItem).where(eq(workItem.sourceMessageId, messageId))).toHaveLength(1);
    }));

  it('moves the work item to a newer read and keeps its id', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'up1');
      const first = await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const a = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId });
      const second = await insertRead(db, messageId, { version: 'extract-v2', payload: payload() });
      const b = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId });
      expect(first).not.toBe(second);
      expect(b?.id).toBe(a?.id);
      const [item] = await db.select().from(workItem).where(eq(workItem.sourceMessageId, messageId));
      expect(item!.extractionId).toBe(second);
    }));

  it('a new-version read that changes the kind (an internal forward read again as a quote) is what the pane shows', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'fw1');
      const lookup = { transportId: CENTURION, internetMessageId: '<fw1@example.com>' };
      const old = await insertRead(db, messageId, {
        version: 'extract-v1',
        kind: 'other',
        payload: { ...payload(), agency: 'Grand Hotel Group' },
      });
      await db
        .update(mailExtraction)
        .set({ createdAt: new Date(Date.now() - 60_000) })
        .where(eq(mailExtraction.id, old));
      const before = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId });
      expect((await storedWorkFor(db, lookup)) as { analysis: { intent: string } }).toMatchObject({
        extractionId: old,
        analysis: { intent: 'other' },
      });

      // The re-read the extractor change queues (same message, new version) lands as the latest succeeded read.
      const next = await insertRead(db, messageId, { version: 'extract-v2', kind: 'quote', payload: payload() });
      const after = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId });
      expect(after?.id).not.toBe(before?.id);
      expect(after?.extractionId).toBe(next);
      const work = await storedWorkFor(db, lookup);
      if (work.status !== 'ready') throw new Error(`expected ready, got ${work.status}`);
      expect(work.extractionId).toBe(next);
      expect(work.workItemId).toBe(after?.id);
      expect(work.analysis.intent).toBe('quote');
      expect(work.analysis.groups[0]!.organisation).toBe('Horizon Trail Tours');

      // Nobody touched the item from the older read, so it is dismissed with a system event and leaves Needs you.
      const [stale] = await db.select().from(workItem).where(eq(workItem.id, before!.id));
      expect(stale).toMatchObject({ kind: 'other', status: 'dismissed' });
      expect(await eventsFor(db, before!.id)).toEqual([
        expect.objectContaining({
          actorKind: 'system',
          type: 'status.changed',
          value: expect.objectContaining({ from: 'needs_you', to: 'dismissed', extractionId: next }),
        }),
      ]);
      const open = await listWorkItems(db, { transportId: CENTURION, statuses: ['needs_you', 'review'], limit: 50 });
      expect(open.map((row) => row.id)).toEqual([after!.id]);
      // A repeat changes nothing.
      await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId });
      expect(await eventsFor(db, before!.id)).toHaveLength(1);
    }));

  it('a read that returns to an earlier kind brings its item back, unless she dismissed it herself', () =>
    withDb(async (db) => {
      const ago = (ms: number) => new Date(Date.now() - ms);
      const read = async (messageId: string, version: string, kind: 'quote' | 'other', age: number) => {
        const id = await insertRead(db, messageId, { version, kind, payload: payload() });
        await db.update(mailExtraction).set({ createdAt: ago(age) }).where(eq(mailExtraction.id, id));
        return id;
      };
      const status = async (id: string) =>
        (await db.select({ status: workItem.status }).from(workItem).where(eq(workItem.id, id)))[0]!.status;

      // quote, then other, then quote again: the quote item comes back on the newest read, the other item goes.
      const messageId = await seedMail(db, 'fw4');
      await read(messageId, 'extract-v1', 'quote', 30_000);
      const quote = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId });
      await read(messageId, 'extract-v2', 'other', 20_000);
      const other = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId });
      expect(await status(quote!.id)).toBe('dismissed');
      const third = await read(messageId, 'extract-v3', 'quote', 10_000);
      const back = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId });
      expect(back).toMatchObject({ id: quote!.id, status: 'needs_you', extractionId: third });
      expect(await status(other!.id)).toBe('dismissed');
      const open = await listWorkItems(db, { transportId: CENTURION, statuses: ['needs_you', 'review'], limit: 50 });
      expect(open.map((row) => row.id)).toEqual([quote!.id]);

      // Her own dismissal stands when the kind comes back.
      const mine = await seedMail(db, 'fw5');
      await read(mine, 'extract-v1', 'quote', 30_000);
      const kept = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: mine });
      expect(await dismissWorkItem(db, { transportId: CENTURION, workItemId: kept!.id, userId: USER })).toEqual({
        status: 'dismissed',
      });
      await read(mine, 'extract-v2', 'other', 20_000);
      await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: mine });
      await read(mine, 'extract-v3', 'quote', 10_000);
      const again = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: mine });
      expect(again?.id).toBe(kept!.id);
      expect(await status(kept!.id)).toBe('dismissed');
    }));

  it('a kind-changing re-read never dismisses an older item she has edited, or one already done', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'fw2');
      const old = await insertRead(db, messageId, { version: 'extract-v1', kind: 'other', payload: payload() });
      await db
        .update(mailExtraction)
        .set({ createdAt: new Date(Date.now() - 60_000) })
        .where(eq(mailExtraction.id, old));
      const edited = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId });
      expect(
        await recordFieldEvent(db, {
          transportId: CENTURION,
          workItemId: edited!.id,
          userId: USER,
          type: 'field.edit',
          fieldPath: 'contact.phone',
          value: '+27 11 555 0100',
        }),
      ).toMatchObject({ status: 'recorded' });
      // A second untouched item from the older read, already marked done: done items are never dismissed.
      const messageTwo = await seedMail(db, 'fw3');
      const oldTwo = await insertRead(db, messageTwo, { version: 'extract-v1', kind: 'other', payload: payload() });
      await db
        .update(mailExtraction)
        .set({ createdAt: new Date(Date.now() - 60_000) })
        .where(eq(mailExtraction.id, oldTwo));
      const done = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: messageTwo });
      await db.update(workItem).set({ status: 'done' }).where(eq(workItem.id, done!.id));

      await insertRead(db, messageId, { version: 'extract-v2', kind: 'quote', payload: payload() });
      await insertRead(db, messageTwo, { version: 'extract-v2', kind: 'quote', payload: payload() });
      await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId });
      await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: messageTwo });

      const [keptEdited] = await db.select().from(workItem).where(eq(workItem.id, edited!.id));
      expect(keptEdited!.status).toBe('needs_you');
      const [keptDone] = await db.select().from(workItem).where(eq(workItem.id, done!.id));
      expect(keptDone!.status).toBe('done');
      const open = await listWorkItems(db, { transportId: CENTURION, statuses: ['needs_you', 'review'], limit: 50 });
      expect(open.map((row) => row.id)).toContain(edited!.id);
    }));

  it('never moves the work item back to an older read a slow caller still holds', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'up2');
      const older = await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      await db
        .update(mailExtraction)
        .set({ createdAt: new Date(Date.now() - 60_000) })
        .where(eq(mailExtraction.id, older));
      const newer = await insertRead(db, messageId, { version: 'extract-v2', payload: payload() });
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId });
      expect(item?.extractionId).toBe(newer);
      const late = await ensureWorkItem(db, {
        transportId: CENTURION,
        threadId: 'thread-up2',
        messageId,
        kind: 'quote',
        extractionId: older,
      });
      expect(late.extractionId).toBe(newer);
      const [row] = await db.select().from(workItem).where(eq(workItem.id, item!.id));
      expect(row!.extractionId).toBe(newer);
    }));

  it('keeps the item on the read she corrected when a re-read puts the stays in another order', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'up3');
      const first = await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'up3');
      await recordFieldEvent(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        userId: USER,
        type: 'field.edit',
        fieldPath: `stays[${STAY_ONE}].requested.arrival`,
        value: '2027-10-25',
      });
      // Same mail read again with the stays swapped: positional ids now name the other stay.
      const swapped = payload();
      const [one, two] = swapped.stays;
      swapped.stays = [
        { ...two!, id: STAY_ONE, rows: two!.rows.map((row) => ({ ...row, id: ROW_SINGLE })) },
        { ...one!, id: STAY_TWO, rows: one!.rows.map((row, index) => ({ ...row, id: [ROW_STAY_TWO, 'r_eeee1111'][index]! })) },
      ];
      await insertRead(db, messageId, { version: 'extract-v2', payload: swapped });

      const after = await readyWork(db, 'up3');
      expect(after.extractionId).toBe(first);
      expect(after.analysis.groups.map((group) => [group.roomPreference, group.arrivalDate])).toEqual([
        ['Single', '2027-10-25'],
        ['Double/Twin', '2027-10-25'],
        ['Double/Twin', '2027-11-17'],
      ]);
    }));
});

describe('corrections carry to a re-read', () => {
  it('keeps her row value off a same-type row that a re-read swapped in', () => {
    const before = payload();
    before.stays[0]!.rows.push({ id: 'r_bbbb3333', roomType: 'Double/Twin', rooms: 1, adultsPerRoom: 1, childAges: [], board: 'bb' });
    const after = payload();
    const [single, twin] = after.stays[0]!.rows;
    after.stays[0]!.rows = [
      single!,
      { ...twin!, rooms: 1, adultsPerRoom: 1 },
      { ...twin!, id: 'r_bbbb3333' },
    ];
    const state = { [`stays[${STAY_ONE}].rows[${ROW_TWIN}].adults`]: 3 };
    expect(correctionsCarryTo(before, after, state)).toBe(false);
    expect(correctionsCarryTo(before, before, state)).toBe(true);
    const reRead = payload();
    reRead.stays[0]!.rows[1] = { ...reRead.stays[0]!.rows[1]!, adultsPerRoom: 3 };
    expect(correctionsCarryTo(payload(), reRead, state)).toBe(true);
  });
});

describe('field events', () => {
  it('logs one edit with the AI value, the value, and the extractor version, and sets the field', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'e1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'e1');

      const result = await recordFieldEvent(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        userId: USER,
        type: 'field.edit',
        fieldPath: `stays[${STAY_ONE}].requested.arrival`,
        value: '2027-10-25',
        msSinceOpen: 1200,
      });
      expect(result).toEqual({ status: 'recorded', aiValue: '2027-10-26', value: '2027-10-25' });

      const events = await eventsFor(db, work.workItemId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'field.edit',
        actorKind: 'user',
        actorUserId: USER,
        fieldPath: `stays[${STAY_ONE}].requested.arrival`,
        aiValue: '2027-10-26',
        value: '2027-10-25',
        aiSource: 'extract-v1',
        msSinceOpen: 1200,
      });

      const after = await readyWork(db, 'e1');
      expect(after.analysis.groups[0]!.arrivalDate).toBe('2027-10-25');
      expect(after.analysis.groups[0]!.fields.arrivalDate).toBe('staff_corrected');
      expect(after.analysis.groups[2]!.arrivalDate).toBe('2027-11-17');
    }));

  it('accept stores the AI value, reject stores null, and a user-made row logs a null AI value', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'e2');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'e2');
      const base = { transportId: CENTURION, workItemId: work.workItemId, userId: USER };

      expect(
        await recordFieldEvent(db, {
          ...base,
          type: 'field.accept',
          fieldPath: `stays[${STAY_ONE}].rows[${ROW_SINGLE}].count`,
        }),
      ).toEqual({ status: 'recorded', aiValue: 2, value: 2 });
      expect(
        await recordFieldEvent(db, {
          ...base,
          type: 'field.reject',
          fieldPath: `stays[${STAY_ONE}].requested.departure`,
        }),
      ).toEqual({ status: 'recorded', aiValue: '2027-10-28', value: null });
      expect(
        await recordFieldEvent(db, {
          ...base,
          type: 'field.edit',
          fieldPath: `stays[${STAY_ONE}].rows[r_user01].count`,
          value: 5,
        }),
      ).toEqual({ status: 'recorded', aiValue: null, value: 5 });

      const after = await readyWork(db, 'e2');
      expect(after.analysis.groups[0]).toMatchObject({ quantity: 2 });
      expect(after.analysis.groups[0]!.departureDate).toBeUndefined();
      expect(await eventsFor(db, work.workItemId)).toHaveLength(3);
    }));

  it('pairs an edit on stay two with its own AI value after stay one is removed from the view', () => {
    const withoutStayOne = { ...payload(), stays: payload().stays.slice(1) };
    expect(aiValueAt(withoutStayOne, `stays[${STAY_TWO}].requested.arrival`)).toBe('2027-11-17');
    expect(aiValueAt(withoutStayOne, `stays[${STAY_TWO}].rows[${ROW_STAY_TWO}].count`)).toBe(4);
    expect(aiValueAt(withoutStayOne, `stays[${STAY_ONE}].requested.arrival`)).toBeNull();
  });

  it('pairs an edit on stay two with its own AI value after she deletes stay one', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'del1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'del1');
      const base = { transportId: CENTURION, workItemId: work.workItemId, userId: USER, type: 'field.edit' as const };

      expect(await recordFieldEvent(db, { ...base, fieldPath: `stays[${STAY_ONE}].removed`, value: true })).toEqual({
        status: 'recorded',
        aiValue: false,
        value: true,
      });
      expect(
        await recordFieldEvent(db, { ...base, fieldPath: `stays[${STAY_TWO}].requested.arrival`, value: '2027-11-16' }),
      ).toEqual({ status: 'recorded', aiValue: '2027-11-17', value: '2027-11-16' });

      const after = await readyWork(db, 'del1');
      expect(after.analysis.groups.map((group) => group.id)).toEqual([ROW_STAY_TWO]);
      expect(after.analysis.groups[0]!.arrivalDate).toBe('2027-11-16');
      expect(after.refs[ROW_STAY_TWO]).toEqual({ stayId: STAY_TWO, rowId: ROW_STAY_TWO });
    }));

  it('brings back the stay and row she added and her edits on reopen, through a re-extraction', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'add1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'add1');
      const base = { transportId: CENTURION, workItemId: work.workItemId, userId: USER, type: 'field.edit' as const };
      const edits: Array<[string, unknown]> = [
        [`stays[${STAY_ONE}].rows[${ROW_TWIN}].count`, 5],
        [`stays[${STAY_ONE}].rows[${ROW_SINGLE}].removed`, true],
        [`stays[${STAY_TWO}].rows[r_user01].roomType`, 'Family'],
        [`stays[${STAY_TWO}].rows[r_user01].count`, 1],
        ['stays[s_user01].requested.arrival', '2027-12-01'],
        ['stays[s_user01].requested.departure', '2027-12-04'],
        ['stays[s_user01].rows[r_user02].adults', 2],
      ];
      for (const [fieldPath, value] of edits) {
        expect(await recordFieldEvent(db, { ...base, fieldPath, value })).toMatchObject({ status: 'recorded' });
      }
      const events = await eventsFor(db, work.workItemId);
      expect(events.find((event) => event.fieldPath === 'stays[s_user01].requested.arrival')!.aiValue).toBeNull();

      await insertRead(db, messageId, {
        version: 'extract-v2',
        payload: payload({ stayOneArrival: '2027-10-30' }),
      });
      const after = await readyWork(db, 'add1');
      expect(after.workItemId).toBe(work.workItemId);
      expect(after.analysis.groups.map((group) => group.id)).toEqual([ROW_TWIN, ROW_STAY_TWO, 'r_user01', 'r_user02']);
      expect(after.analysis.groups[0]).toMatchObject({ quantity: 5, arrivalDate: '2027-10-30' });
      expect(after.analysis.groups[2]).toMatchObject({ quantity: 1, roomPreference: 'Family', arrivalDate: '2027-11-17' });
      expect(after.analysis.groups[3]).toMatchObject({ adults: 2, arrivalDate: '2027-12-01', departureDate: '2027-12-04' });
      expect(after.refs.r_user02).toEqual({ stayId: 's_user01', rowId: 'r_user02' });
      expect(after.analysis.luna.flags).toContain('multi_date');
    }));

  it('drops a stay once she has removed every row of it', () => {
    const stays = formStays(payload(), { [`stays[${STAY_TWO}].rows[${ROW_STAY_TWO}].removed`]: true });
    expect(stays.map((stay) => stay.id)).toEqual([STAY_ONE]);
    const undone = formStays(payload(), { [`stays[${STAY_TWO}].rows[${ROW_STAY_TWO}].removed`]: null });
    expect(undone.map((stay) => stay.id)).toEqual([STAY_ONE, STAY_TWO]);
  });

  it('keeps a person value through a re-extraction, and the work item stays the same', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'r1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const before = await readyWork(db, 'r1');
      await recordFieldEvent(db, {
        transportId: CENTURION,
        workItemId: before.workItemId,
        userId: USER,
        type: 'field.edit',
        fieldPath: `stays[${STAY_ONE}].requested.arrival`,
        value: '2027-10-25',
      });
      const v2 = await insertRead(db, messageId, {
        version: 'extract-v2',
        payload: payload({ stayOneArrival: '2027-10-30', stayTwoArrival: '2027-11-18' }),
      });

      const after = await readyWork(db, 'r1');
      expect(after.workItemId).toBe(before.workItemId);
      expect(after.extractionId).toBe(v2);
      expect(after.analysis.groups[0]!.arrivalDate).toBe('2027-10-25');
      expect(after.analysis.groups[2]!.arrivalDate).toBe('2027-11-18');
      expect(await db.select().from(workItem).where(eq(workItem.sourceMessageId, messageId))).toHaveLength(1);
    }));

  it('refuses a path that is not a field, a value that does not fit it, and another transport', () =>
    withDb(async (db) => {
      await addOtherTransport(db);
      const messageId = await seedMail(db, 'e3');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'e3');
      const base = { workItemId: work.workItemId, userId: USER, type: 'field.edit' as const };

      expect(
        await recordFieldEvent(db, { ...base, transportId: CENTURION, fieldPath: 'approve', value: 'x' }),
      ).toEqual({ status: 'invalid_path' });
      expect(
        await recordFieldEvent(db, {
          ...base,
          transportId: CENTURION,
          fieldPath: `stays[${STAY_ONE}].rows[${ROW_SINGLE}].count`,
          value: 0,
        }),
      ).toEqual({ status: 'invalid_value' });
      expect(
        await recordFieldEvent(db, {
          ...base,
          transportId: CENTURION,
          fieldPath: `stays[${STAY_ONE}].requested.arrival`,
          value: 'tomorrow',
        }),
      ).toEqual({ status: 'invalid_value' });
      expect(
        await recordFieldEvent(db, {
          ...base,
          transportId: OTHER,
          fieldPath: `stays[${STAY_ONE}].requested.arrival`,
          value: '2027-10-25',
        }),
      ).toEqual({ status: 'not_found' });
      expect(await eventsFor(db, work.workItemId)).toHaveLength(0);
    }));
});

describe('cleared values on reopen', () => {
  it('keeps a meal plan she cleared to "Not stated yet" as not stated, not the default', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'b1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'b1');
      expect(work.analysis.groups[1]!.board).toBe('bb');
      await recordFieldEvent(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        userId: USER,
        type: 'field.edit',
        fieldPath: `stays[${STAY_ONE}].rows[${ROW_TWIN}].board`,
        value: null,
      });
      const after = await readyWork(db, 'b1');
      expect(after.analysis.groups[1]!.board).toBe('unknown');
      expect(after.analysis.groups[1]!.fields.board).toBe('staff_corrected');
    }));
});

describe('contact edits', () => {
  it('logs a phone edit with no AI value, and shows her value on reopen', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'k1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'k1');
      expect(work.contact.phone).toBeNull();

      const result = await recordFieldEvent(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        userId: USER,
        type: 'field.edit',
        fieldPath: 'contact.phone',
        value: '+27 82 555 0100',
        msSinceOpen: 700,
      });
      expect(result).toEqual({ status: 'recorded', aiValue: null, value: '+27 82 555 0100' });
      const [logged] = await eventsFor(db, work.workItemId);
      expect(logged).toMatchObject({
        type: 'field.edit',
        fieldPath: 'contact.phone',
        aiValue: null,
        value: '+27 82 555 0100',
        aiSource: 'extract-v1',
        msSinceOpen: 700,
      });
      expect((await readyWork(db, 'k1')).contact.phone).toBe('+27 82 555 0100');
    }));

  it('pairs a company edit with the agency the read named, and clears a field to null', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'k2');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'k2');

      expect(
        await recordFieldEvent(db, {
          transportId: CENTURION,
          workItemId: work.workItemId,
          userId: USER,
          type: 'field.edit',
          fieldPath: 'contact.company',
          value: 'New Frontiers Tours',
        }),
      ).toEqual({ status: 'recorded', aiValue: 'Horizon Trail Tours', value: 'New Frontiers Tours' });
      expect(
        await recordFieldEvent(db, {
          transportId: CENTURION,
          workItemId: work.workItemId,
          userId: USER,
          type: 'field.edit',
          fieldPath: 'contact.company',
          value: null,
        }),
      ).toEqual({ status: 'recorded', aiValue: 'Horizon Trail Tours', value: null });
      expect((await readyWork(db, 'k2')).contact.company).toBeNull();
    }));

  it('keeps her contact value through a re-extraction, and takes the read value for a field she did not edit', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'k3');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const before = await readyWork(db, 'k3');
      await recordFieldEvent(db, {
        transportId: CENTURION,
        workItemId: before.workItemId,
        userId: USER,
        type: 'field.edit',
        fieldPath: 'contact.email',
        value: 'buyer@example.com',
      });
      await insertRead(db, messageId, {
        version: 'extract-v2',
        payload: { ...payload(), contact: { name: 'Priya Naidoo', email: 'priya@example.com', phone: '+27 11 000 0000' } },
      });

      const after = await readyWork(db, 'k3');
      expect(after.workItemId).toBe(before.workItemId);
      expect(after.contact).toEqual({
        name: 'Priya Naidoo',
        company: 'Horizon Trail Tours',
        endClient: null,
        email: 'buyer@example.com',
        phone: '+27 11 000 0000',
      });
    }));

  it('refuses a contact path that is not a field, and a value that is not short text', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'k4');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'k4');
      const edit = (fieldPath: string, value: unknown) =>
        recordFieldEvent(db, {
          transportId: CENTURION,
          workItemId: work.workItemId,
          userId: USER,
          type: 'field.edit',
          fieldPath,
          value: value as string,
        });

      expect(await edit('contact.passport', 'AB123')).toEqual({ status: 'invalid_path' });
      expect(await edit('contact.phone; drop', '1')).toEqual({ status: 'invalid_path' });
      expect(await edit('contact.phone', 'x'.repeat(201))).toEqual({ status: 'invalid_value' });
      expect(await edit('contact.phone', 42)).toEqual({ status: 'invalid_value' });
      expect(await edit('contact.phone', true)).toEqual({ status: 'invalid_value' });
      expect(await eventsFor(db, work.workItemId)).toHaveLength(0);
    }));
});

describe('field paths and values', () => {
  it('parses stay and row paths and refuses anything else', () => {
    expect(parseFieldPath(`stays[${STAY_ONE}].requested.arrival`)).toEqual({
      stayId: STAY_ONE,
      rowId: null,
      field: 'arrival',
    });
    expect(parseFieldPath(`stays[${STAY_ONE}].rows[${ROW_TWIN}].board`)).toEqual({
      stayId: STAY_ONE,
      rowId: ROW_TWIN,
      field: 'board',
    });
    expect(parseFieldPath(`stays[${STAY_ONE}].removed`)).toEqual({ stayId: STAY_ONE, rowId: null, field: 'removed' });
    expect(parseFieldPath(`stays[${STAY_ONE}].rows[${ROW_TWIN}].removed`)).toEqual({
      stayId: STAY_ONE,
      rowId: ROW_TWIN,
      field: 'removed',
    });
    for (const path of [
      'approve',
      `stays[${STAY_ONE}].requested.removed`,
      'stays[].requested.arrival',
      `stays[${STAY_ONE}].requested.checkout`,
      `stays[${STAY_ONE}].rows[${ROW_TWIN}].approve`,
      `stays[${STAY_ONE}].requested.arrival; drop`,
    ]) {
      expect(parseFieldPath(path), path).toBeNull();
    }
  });

  it('checks a value against its field', () => {
    expect(validFieldValue('count', 3)).toBe(true);
    expect(validFieldValue('count', 0)).toBe(false);
    expect(validFieldValue('adults', 10)).toBe(false);
    expect(validFieldValue('childAges', [3, 17])).toBe(true);
    expect(validFieldValue('childAges', [18])).toBe(false);
    expect(validFieldValue('board', 'dbb')).toBe(true);
    expect(validFieldValue('board', 'dinner_bb')).toBe(false);
    expect(validFieldValue('arrival', '2027-02-30')).toBe(false);
    expect(validFieldValue('arrival', '2027-02-28')).toBe(true);
    expect(validFieldValue('departure', null)).toBe(true);
    expect(validFieldValue('removed', true)).toBe(true);
    expect(validFieldValue('removed', false)).toBe(false);
  });
});

describe('dismiss and list', () => {
  it('dismisses an open item, logs the change, and drops it from the open list', () =>
    withDb(async (db) => {
      await addOtherTransport(db);
      const messageId = await seedMail(db, 'd1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'd1');

      expect(await dismissWorkItem(db, { transportId: OTHER, workItemId: work.workItemId, userId: USER })).toBeNull();
      expect(await dismissWorkItem(db, { transportId: CENTURION, workItemId: work.workItemId, userId: USER })).toEqual({
        status: 'dismissed',
      });

      const events = await eventsFor(db, work.workItemId);
      expect(events.map((event) => event.type)).toEqual(['status.changed']);
      expect(events[0]!.value).toEqual({ from: 'needs_you', to: 'dismissed' });
      const open = await listWorkItems(db, { transportId: CENTURION, statuses: ['needs_you', 'review'], limit: 50 });
      expect(open.map((item) => item.id)).not.toContain(work.workItemId);
    }));
});

describe('work item route', () => {
  it('rejects the approve and review event types', () =>
    withDb(async () => {
      for (const type of ['approve', 'approval.granted', 'review.ok', 'review.flag', 'status.changed']) {
        await expect(
          centurionCaller().workItems.recordEvent({
            workItemId: '00000000-0000-4000-8000-000000000001',
            type: type as never,
            fieldPath: `stays[${STAY_ONE}].requested.arrival`,
          }),
          type,
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      }
    }));

  it('scopes every procedure to the session transport', () =>
    withDb(async (db) => {
      await addOtherTransport(db);
      const messageId = await seedMail(db, 'tx1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'tx1');
      const other = centurionCaller(OTHER).workItems;

      expect(await other.getByMessage({ internetMessageId: '<tx1@example.com>' })).toEqual({ status: 'none' });
      expect(await other.list({})).toEqual([]);
      await expect(other.dismiss({ workItemId: work.workItemId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await eventsFor(db, work.workItemId)).toHaveLength(0);
      expect((await centurionCaller().workItems.list({})).map((item) => item.id)).toEqual([work.workItemId]);
    }));

  it('records a contact edit through the route', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'rc1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'rc1');
      expect(
        await centurionCaller().workItems.recordEvent({
          workItemId: work.workItemId,
          type: 'field.edit',
          fieldPath: 'contact.email',
          value: 'buyer@example.com',
        }),
      ).toEqual({ aiValue: null, value: 'buyer@example.com' });
    }));

  it('retries a translation only for the transport that holds the item, and makes no call while the flag is off', () =>
    withDb(async (db) => {
      await addOtherTransport(db);
      const messageId = await seedMail(db, 'tr1');
      await insertRead(db, messageId, {
        version: 'extract-v1',
        payload: payload(),
        language: 'fr',
        translation: { status: 'failed', sourceLanguage: 'fr', reason: 'timeout' },
      });
      const work = await readyWork(db, 'tr1');
      await expect(
        centurionCaller(OTHER).workItems.retryTranslation({ workItemId: work.workItemId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      vi.stubEnv('INBOUND_EXTRACTION', 'off');
      try {
        expect(await centurionCaller().workItems.retryTranslation({ workItemId: work.workItemId })).toEqual({
          status: 'disabled',
          translation: null,
        });
      } finally {
        vi.unstubAllEnvs();
      }
      expect((await readyWork(db, 'tr1')).translation).toEqual({ status: 'failed' });
    }));

  it('records an edit through the route, and refuses another transport', () =>
    withDb(async (db) => {
      await addOtherTransport(db);
      const messageId = await seedMail(db, 'rt1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'rt1');

      const recorded = await centurionCaller().workItems.recordEvent({
        workItemId: work.workItemId,
        type: 'field.edit',
        fieldPath: `stays[${STAY_TWO}].rows[${ROW_STAY_TWO}].count`,
        value: 5,
        msSinceOpen: 900,
      });
      expect(recorded).toEqual({ aiValue: 4, value: 5 });
      const [logged] = await eventsFor(db, work.workItemId);
      expect(logged).toMatchObject({ actorKind: 'user', actorUserId: USER, aiSource: 'extract-v1', msSinceOpen: 900 });

      await expect(
        centurionCaller(OTHER).workItems.recordEvent({
          workItemId: work.workItemId,
          type: 'field.accept',
          fieldPath: `stays[${STAY_TWO}].requested.arrival`,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const pane = await centurionCaller().workItems.getByMessage({ internetMessageId: '<rt1@example.com>' });
      expect(pane.status).toBe('ready');
    }));
});

describe('needs-you list', () => {
  /** A quote read for a new mail, received at `receivedAt`, with its work item. Returns the work item id. */
  async function openItem(db: DB, id: string, receivedAt: string): Promise<string> {
    const messageId = await seedMail(db, id);
    await db.update(message).set({ receivedAt: new Date(receivedAt) }).where(eq(message.id, messageId));
    await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
    const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId });
    if (!item) throw new Error(`no work item for ${id}`);
    return item.id;
  }

  async function openList(db: DB) {
    return listWorkItems(db, { transportId: CENTURION, statuses: ['needs_you', 'review'], limit: 50 });
  }

  it('lists needs you before review, and the oldest mail first within a chip', () =>
    withDb(async (db) => {
      const newer = await openItem(db, 'o-new', '2026-10-08T09:00:00Z');
      const older = await openItem(db, 'o-old', '2026-10-05T09:00:00Z');
      const reviewed = await openItem(db, 'o-rev', '2026-10-01T09:00:00Z');
      await db.update(workItem).set({ status: 'review' }).where(eq(workItem.id, reviewed));

      const rows = await openList(db);
      expect(rows.map((row) => row.id)).toEqual([older, newer, reviewed]);
      expect(rows[0]).toMatchObject({
        kind: 'quote',
        status: 'needs_you',
        chip: 'needs_you',
        sender: 'sender@example.com',
        subject: 'Rooms request',
      });
      expect(rows[0]!.receivedAt?.toISOString()).toBe('2026-10-05T09:00:00.000Z');
    }));

  it('leaves out spam, trashed and deleted threads, spam reads, and done or dismissed items', () =>
    withDb(async (db) => {
      const kept = await openItem(db, 'k1', '2026-10-05T09:00:00Z');

      await openItem(db, 'sp1', '2026-10-05T09:00:00Z');
      await db.update(mailThread).set({ spamAt: new Date() }).where(eq(mailThread.id, 'thread-sp1'));

      const spamRead = await seedMail(db, 'sp2');
      await insertRead(db, spamRead, { version: 'extract-v1', kind: 'spam', payload: null });
      expect(await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: spamRead })).toBeNull();
      expect(await db.select().from(workItem).where(eq(workItem.threadId, 'thread-sp2'))).toHaveLength(0);

      // A spam item stored before the fix, on a thread nobody marked spam, is still left out by its kind.
      const legacySpam = await seedMail(db, 'sp3');
      await db.insert(workItem).values({
        transportId: CENTURION,
        threadId: 'thread-sp3',
        sourceMessageId: legacySpam,
        kind: 'spam',
      });

      await openItem(db, 'tr1', '2026-10-05T09:00:00Z');
      await db.update(mailThread).set({ trashedAt: new Date() }).where(eq(mailThread.id, 'thread-tr1'));
      // A deleted thread leaves its work item behind with no thread (SET NULL).
      await openItem(db, 'del1', '2026-10-05T09:00:00Z');
      await db.delete(mailThread).where(eq(mailThread.id, 'thread-del1'));

      const done = await openItem(db, 'dn1', '2026-10-05T09:00:00Z');
      await db.update(workItem).set({ status: 'done' }).where(eq(workItem.id, done));
      const dismissed = await openItem(db, 'dm1', '2026-10-05T09:00:00Z');
      await dismissWorkItem(db, { transportId: CENTURION, workItemId: dismissed, userId: USER });

      expect((await openList(db)).map((row) => row.id)).toEqual([kept]);
    }));

  it('derives each chip from the latest run linked to the item', () =>
    withDb(async (db) => {
      const addRun = async (
        workItemId: string,
        id: string,
        state: 'queued' | 'retry_wait' | 'claimed' | 'running' | 'succeeded' | 'dead_letter',
        createdAt = new Date(),
        lane: { runKind: 'read_tool' | 'hms_write' | 'quote_followup'; executorLane: 'hms' | 'default' } = {
          runKind: 'read_tool',
          executorLane: 'hms',
        },
      ) => {
        await db.insert(aiWorkflowRun).values({
          id: randomUUID(),
          transportId: CENTURION,
          threadId: `thread-${id}`,
          triggerMessageId: `msg-${id}`,
          runKind: lane.runKind,
          idempotencyKey: `test-run:${randomUUID()}`,
          modelId: NOT_APPLICABLE_MODEL_ID,
          promptVersion: HMS_JOB_PROMPT_VERSION,
          state,
          executorLane: lane.executorLane,
          workItemId,
          createdAt,
          updatedAt: createdAt,
        });
      };
      const bare = await openItem(db, 'c-none', '2026-10-01T09:00:00Z');
      const queued = await openItem(db, 'c-queued', '2026-10-02T09:00:00Z');
      const retried = await openItem(db, 'c-retry', '2026-10-03T09:00:00Z');
      const running = await openItem(db, 'c-running', '2026-10-04T09:00:00Z');
      const finished = await openItem(db, 'c-done-run', '2026-10-05T09:00:00Z');
      const reviewed = await openItem(db, 'c-review', '2026-10-06T09:00:00Z');
      const reviewedQueued = await openItem(db, 'c-review-queued', '2026-10-07T09:00:00Z');
      const followUp = await openItem(db, 'c-followup', '2026-10-08T09:00:00Z');
      const deadWrite = await openItem(db, 'c-dead-write', '2026-10-09T09:00:00Z');
      const writing = await openItem(db, 'c-writing', '2026-10-10T09:00:00Z');
      await db.update(workItem).set({ status: 'review' }).where(eq(workItem.id, reviewed));
      await db.update(workItem).set({ status: 'review' }).where(eq(workItem.id, reviewedQueued));

      await addRun(queued, 'c-queued', 'queued');
      await addRun(retried, 'c-retry', 'retry_wait');
      await addRun(running, 'c-running', 'running');
      // The older run is still queued, but the latest one has succeeded, so the item shows what that run says.
      await addRun(finished, 'c-done-run', 'queued', new Date(Date.now() - 60_000));
      await addRun(finished, 'c-done-run', 'succeeded');
      await addRun(reviewedQueued, 'c-review-queued', 'queued');
      // Only HMS-lane runs move the chip: a queued follow-up on the default lane is not "Queued".
      await addRun(followUp, 'c-followup', 'queued', new Date(), {
        runKind: 'quote_followup',
        executorLane: 'default',
      });
      // A dead write needs her. A running write is In HMS, even with a newer default-lane run.
      await addRun(deadWrite, 'c-dead-write', 'dead_letter', new Date(), {
        runKind: 'hms_write',
        executorLane: 'hms',
      });
      await addRun(writing, 'c-writing', 'running', new Date(Date.now() - 60_000), {
        runKind: 'hms_write',
        executorLane: 'hms',
      });
      await addRun(writing, 'c-writing', 'queued', new Date(), {
        runKind: 'quote_followup',
        executorLane: 'default',
      });

      const rows = await openList(db);
      expect(Object.fromEntries(rows.map((row) => [row.id, row.chip]))).toEqual({
        [bare]: 'needs_you',
        [queued]: 'queued',
        [retried]: 'queued',
        [running]: 'in_hms',
        [finished]: 'needs_you',
        [reviewed]: 'review',
        [reviewedQueued]: 'queued',
        [followUp]: 'needs_you',
        [deadWrite]: 'needs_you',
        [writing]: 'in_hms',
      });
      // Sorted by chip (Needs you, Review, Queued, In HMS), then the oldest mail first.
      expect(rows.map((row) => row.id)).toEqual([
        bare,
        finished,
        followUp,
        deadWrite,
        reviewed,
        queued,
        retried,
        reviewedQueued,
        running,
        writing,
      ]);

      const routeRows = await centurionCaller().workItems.list({});
      expect(routeRows.find((row) => row.id === queued)).toMatchObject({
        chip: 'queued',
        sender: 'sender@example.com',
        subject: 'Rooms request',
      });
    }));
});

describe('follow-up route', () => {
  it('lists the suggestion, maps a missing or busy one to NOT_FOUND and CONFLICT, and scopes it to the transport', () =>
    withDb(async (db) => {
      await addOtherTransport(db);
      await seedMail(db, 'fu1');
      // The request arrived before the quote went out; a later inbound would overtake the suggestion.
      const requestAt = new Date('2026-10-08T08:00:00Z');
      await db
        .update(message)
        .set({ receivedAt: requestAt, createdAt: requestAt })
        .where(eq(message.id, 'msg-fu1'));
      await db.insert(user).values({ id: NAVA_USER_ID, name: 'Nava AI', email: NAVA_USER_EMAIL, emailVerified: true });
      await db.insert(message).values({
        id: 'out-fu1',
        transportId: CENTURION,
        threadId: 'thread-fu1',
        direction: 'outbound',
        fromAddress: 'centurion@legacyhotels.co.za',
        toAddresses: ['sender@example.com'],
        ccAddresses: [],
        bccAddresses: [],
        subject: 'Re: Rooms request',
        textBody: 'Please find our quote.',
        ownerHeaderValue: 'centurion@legacyhotels.co.za',
        messageIdHeader: 'out-fu1@example.com',
        references: [],
        isRead: true,
        isStarred: false,
        sentAt: new Date('2026-10-09T08:00:00Z'),
      });
      await db.insert(workItem).values({
        transportId: CENTURION,
        threadId: 'thread-fu1',
        sourceMessageId: 'msg-fu1',
        kind: 'quote',
        status: 'needs_you',
        sentMessageId: 'out-fu1',
        sentAt: new Date('2026-10-09T08:00:00Z'),
      });
      await db.insert(mailDraft).values({
        id: 'quote-followup:out-fu1',
        transportId: CENTURION,
        threadId: 'thread-fu1',
        createdByUserId: NAVA_USER_ID,
        subject: 'Re: Rooms request',
        textBody: 'Hello, following up on our quote.',
        htmlBody: '<p>Hello, following up on our quote.</p>',
        status: 'candidate',
        origin: 'manual',
        replyToMessageId: 'out-fu1',
      });
      const route = centurionCaller().workItems;

      expect(await route.followUpByMessage({ internetMessageId: '<fu1@example.com>' })).toMatchObject({
        state: 'suggested',
        id: 'quote-followup:out-fu1',
      });
      expect(await route.followUpByMessage({ internetMessageId: '<nobody@example.com>' })).toBeNull();
      await expect(
        centurionCaller(OTHER).workItems.useFollowUp({ draftId: 'quote-followup:out-fu1' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        centurionCaller().workItems.dismissFollowUp({ draftId: 'quote-followup:missing' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await db.insert(mailDraft).values({
        id: 'reply-in-progress',
        transportId: CENTURION,
        threadId: 'thread-fu1',
        createdByUserId: NAVA_USER_ID,
        subject: 'Re: Rooms request',
        textBody: 'Our reply.',
        status: 'active',
        origin: 'manual',
      });
      await expect(
        route.useFollowUp({ draftId: 'quote-followup:out-fu1' }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'ACTIVE_DRAFT_EXISTS' });
      expect(
        await route.useFollowUp({ draftId: 'quote-followup:out-fu1', replaceActive: true }),
      ).toMatchObject({ state: 'in_reply', id: 'quote-followup:out-fu1' });
      // Once used it is no longer a candidate, so the pane cannot dismiss it.
      await expect(
        route.dismissFollowUp({ draftId: 'quote-followup:out-fu1' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }));
});

describe('pane telemetry and staff notes (v5 B1, B2)', () => {
  it('writes an allowed batch as the session user, with only small enum and number values', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'tm1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'tm1');
      const before = (await eventsFor(db, work.workItemId)).length;

      expect(
        await centurionCaller().workItems.recordActions({
          workItemId: work.workItemId,
          events: [
            { type: 'pane.opened', surface: 'outlook' },
            { type: 'hms.lookup.finished', ms: 4200 },
            { type: 'copy.hms_line', kind: 'comment' },
          ],
        }),
      ).toEqual({ recorded: 3 });

      const logged = await eventsFor(db, work.workItemId);
      expect(logged).toHaveLength(before + 3);
      const actions = logged.filter((event) => ['pane.opened', 'hms.lookup.finished', 'copy.hms_line'].includes(event.type));
      expect(actions.map((event) => event.type).sort()).toEqual(['copy.hms_line', 'hms.lookup.finished', 'pane.opened']);
      expect(actions.every((event) => event.actorKind === 'user' && event.actorUserId === USER)).toBe(true);
      expect(actions.find((event) => event.type === 'hms.lookup.finished')!.value).toEqual({ ms: 4200 });
      expect(actions.find((event) => event.type === 'copy.hms_line')!.value).toEqual({ kind: 'comment' });
      expect(actions.find((event) => event.type === 'pane.opened')!.value).toEqual({ surface: 'outlook' });
    }));

  it('refuses approval, field and unknown types, extra payload keys, and a batch over the cap', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'tm2');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'tm2');
      const before = (await eventsFor(db, work.workItemId)).length;
      const route = centurionCaller().workItems;

      for (const type of ['approval.granted', 'approval.consumed', 'field.edit', 'field.accept', 'note.staff', 'nope']) {
        await expect(
          route.recordActions({ workItemId: work.workItemId, events: [{ type: type as never }] }),
          type,
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      }
      await expect(
        route.recordActions({ workItemId: work.workItemId, events: [{ type: 'pane.opened', text: 'Dear Sir' } as never] }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      const fiftyOne = Array.from({ length: 51 }, () => ({ type: 'pane.opened' as const }));
      await expect(route.recordActions({ workItemId: work.workItemId, events: fiftyOne })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(await eventsFor(db, work.workItemId)).toHaveLength(before);
    }));

  it('refuses a batch for an item in another transport, the same as a missing one', () =>
    withDb(async (db) => {
      await addOtherTransport(db);
      const messageId = await seedMail(db, 'tm3');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'tm3');
      const before = (await eventsFor(db, work.workItemId)).length;

      await expect(
        centurionCaller(OTHER).workItems.recordActions({ workItemId: work.workItemId, events: [{ type: 'pane.opened' }] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await eventsFor(db, work.workItemId)).toHaveLength(before);
    }));

  it('masks emails, phone numbers, card numbers and security codes in a staff note, and caps its length', () => {
    expect(
      maskStaffNote('Mail jane.doe@example.com or call +27 82 555 1234 for the 4111 1111 1111 1111 card, CVV 123'),
    ).toBe('Mail [email] or call [phone] for the [card ••••1111] card, CVV [code masked]');
    // Dates and small counts are not phone numbers.
    expect(maskStaffNote('Arrive 2027-11-13 for 3 rooms, 12-14 Nov')).toBe('Arrive 2027-11-13 for 3 rooms, 12-14 Nov');
    expect(maskStaffNote('x'.repeat(2500))).toHaveLength(2000);
  });

  it('masks a phone number written next to a date, and keeps the date when the number has no spaces', () => {
    expect(maskStaffNote('Call 0825551234 (2027-11-13)')).toBe('Call [phone] (2027-11-13)');
    // A spaced number joined to a bracketed date is masked whole, so none of its digits stay.
    expect(maskStaffNote('Call 082 555 1234 (2027-11-13)')).toBe('Call [phone])');
    expect(maskStaffNote('Call 082 (555) 1234 on 13/11/2027')).toBe('Call [phone] on 13/11/2027');
  });

  it('keeps a masked staff note on the item once per text, and finds the item for the mail', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'tn1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'tn1');
      expect(
        await workItemIdForMail(db, { transportId: CENTURION, internetMessageId: '<tn1@example.com>' }),
      ).toBe(work.workItemId);

      const note = 'Call jane@example.com on +27 82 555 1234. Card 4111 1111 1111 1111';
      await recordStaffNote(db, { workItemId: work.workItemId, userId: USER, note });
      await recordStaffNote(db, { workItemId: work.workItemId, userId: USER, note });
      const notes = (await eventsFor(db, work.workItemId)).filter((event) => event.type === 'note.staff');
      expect(notes).toHaveLength(1);
      expect(notes[0]!.value).toEqual({ text: 'Call [email] on [phone]. Card [card ••••1111]' });
      expect(notes[0]!.actorUserId).toBe(USER);
    }));

  it('keeps one copy of a note when the same note is recorded by calls that overlap', () =>
    withIngestionDb(async ({ db, url }) => {
      const messageId = await seedMail(db, 'tn2');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'tn2');

      // Four connections, so the calls really overlap in the database. The shared test pool holds one connection and
      // runs them one after another, which would pass with the row lock removed.
      const pool = postgres(url, { max: 4, onnotice: () => undefined });
      const pooled = drizzle(pool, { schema });
      try {
        // Opens all four connections before the calls start, so they overlap from their first query.
        await Promise.all([1, 2, 3, 4].map(() => pool`SELECT 1`));
        const note = 'Hold the twin rooms for the 12th';
        await Promise.all(
          [1, 2, 3, 4].map(() => recordStaffNote(pooled, { workItemId: work.workItemId, userId: USER, note })),
        );
      } finally {
        await pool.end();
      }
      const notes = (await eventsFor(db, work.workItemId)).filter((event) => event.type === 'note.staff');
      expect(notes).toHaveLength(1);
    }));

  it('accepts unedited AI fields once, and never an edited, empty or unknown one', () =>
    withDb(async (db) => {
      await addOtherTransport(db);
      const messageId = await seedMail(db, 'ta1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'ta1');
      const arrival = `stays[${STAY_ONE}].requested.arrival`;
      const departure = `stays[${STAY_ONE}].requested.departure`;
      const count = `stays[${STAY_TWO}].rows[${ROW_STAY_TWO}].count`;
      await centurionCaller().workItems.recordEvent({
        workItemId: work.workItemId,
        type: 'field.edit',
        fieldPath: count,
        value: 5,
      });
      const paths = [arrival, departure, count, 'contact.email', `stays[s_missing].requested.arrival`];

      await expect(
        centurionCaller(OTHER).workItems.acceptFields({ workItemId: work.workItemId, fieldPaths: paths }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await centurionCaller().workItems.acceptFields({ workItemId: work.workItemId, fieldPaths: paths })).toEqual({
        accepted: 2,
      });
      expect(await centurionCaller().workItems.acceptFields({ workItemId: work.workItemId, fieldPaths: paths })).toEqual({
        accepted: 0,
      });

      const accepts = (await eventsFor(db, work.workItemId)).filter((event) => event.type === 'field.accept');
      expect(accepts.map((event) => event.fieldPath).sort()).toEqual([arrival, departure].sort());
      expect(accepts.find((event) => event.fieldPath === arrival)).toMatchObject({
        actorUserId: USER,
        aiValue: '2027-10-26',
        value: '2027-10-26',
        aiSource: 'extract-v1',
      });
    }));

  it('an accepted AI value reopens as the read, never as a staff correction', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'ta2');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'ta2');
      const arrival = `stays[${STAY_ONE}].requested.arrival`;
      const count = `stays[${STAY_ONE}].rows[${ROW_SINGLE}].count`;
      expect(
        await centurionCaller().workItems.acceptFields({ workItemId: work.workItemId, fieldPaths: [arrival, count] }),
      ).toEqual({ accepted: 2 });

      const reopened = await readyWork(db, 'ta2');
      expect(reopened.analysis.groups[0]).toMatchObject({ arrivalDate: '2027-10-26', quantity: 2 });
      expect(reopened.analysis.groups[0]!.fields).toMatchObject({ arrivalDate: 'extracted', quantity: 'extracted' });
      const [stored] = await db.select({ state: workItem.state }).from(workItem).where(eq(workItem.id, work.workItemId));
      expect(stored!.state).toEqual({});
    }));

  it('an accept after an edit reopens as the read again, not as her correction', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'ta3');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'ta3');
      const base = { transportId: CENTURION, workItemId: work.workItemId, userId: USER };
      const arrival = `stays[${STAY_ONE}].requested.arrival`;
      await recordFieldEvent(db, { ...base, type: 'field.edit', fieldPath: arrival, value: '2027-10-25' });

      expect(await recordFieldEvent(db, { ...base, type: 'field.accept', fieldPath: arrival })).toEqual({
        status: 'recorded',
        aiValue: '2027-10-26',
        value: '2027-10-26',
      });
      const reopened = await readyWork(db, 'ta3');
      expect(reopened.analysis.groups[0]!.arrivalDate).toBe('2027-10-26');
      expect(reopened.analysis.groups[0]!.fields.arrivalDate).toBe('extracted');
    }));
});
