import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { AttachmentRead } from '../src/ai/extraction/extract.js';
import { EXTRACTION_VERSION, runInboundExtraction } from '../src/ai/extraction/inbound-run.js';
import type { MailExtractionPayload } from '../src/ai/extraction/schema.js';
import {
  aiValueAt,
  dismissWorkItem,
  ensureWorkItemForMessage,
  formStays,
  listWorkItems,
  parseFieldPath,
  recordFieldEvent,
  storedWorkFor,
  validFieldValue,
} from '../src/ai/work-items.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { mailboxTransport } from '../src/db/schema/mail.js';
import { mailExtraction, workEvent, workItem } from '../src/db/schema/work.js';
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
    kind?: 'quote' | 'amendment' | 'cancellation' | 'other';
    payload?: MailExtractionPayload | null;
    attachments?: AttachmentRead[] | null;
    usage?: Record<string, unknown> | null;
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
    })
    .returning({ id: mailExtraction.id });
  return row!.id;
}

async function readyWork(db: DB, id: string) {
  const work = await storedWorkFor(db, { transportId: CENTURION, internetMessageId: `<${id}@example.com>` });
  if (work.status !== 'ready') throw new Error(`expected a ready read, got ${work.status}`);
  return work;
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
        requestedChange: null,
      });
      expect(work.analysis.luna.flags).toContain('amendment_or_cancel');
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
