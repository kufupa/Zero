import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import type { AttachmentRead } from '../src/ai/extraction/extract.js';
import { EXTRACTION_VERSION, runInboundExtraction } from '../src/ai/extraction/inbound-run.js';
import type { MailExtractionPayload, MailKind } from '../src/ai/extraction/schema.js';
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
  PANE_STAY_ALREADY_BOOKED,
  pickSavedStay,
  recordFieldEvent,
  recordStayActionResult,
  recordStayCommit,
  refreshThreadWork,
  resetWorkSection,
  savedStayPicksOf,
  stayCommitGuard,
  stayCommitOf,
  storedAnalysis,
  withStayActionResult,
  withStayCommit,
  storedTranslation,
  storedWorkFor,
  undoWorkItemRevision,
  redoWorkItemRevision,
  validFieldValue,
  workItemIdForMail,
} from '../src/ai/work-items.js';
import { THREAD_CONFIRMATION_AMBIGUOUS } from '../src/ai/quote-workflow-synced-selection.js';
import { maskStaffNote, recordPaneActions, recordStaffNote } from '../src/ai/work-events.js';
import { parseReplyLinkArgs, runReplyLinkBackfill } from '../scripts/backfill-reply-link.js';
import { HMS_JOB_PROMPT_VERSION, NOT_APPLICABLE_MODEL_ID } from '../src/ai/run-ledger.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import * as schema from '../src/db/schema/index.js';
import { aiWorkflowRun, attachment, mailboxTransport, mailDraft, mailThread, message } from '../src/db/schema/mail.js';
import { mailExtraction, workEvent, workItem } from '../src/db/schema/work.js';
import { user } from '../src/db/schema/auth.js';
import {
  AYANDA_TRANSPORT_EMAIL,
  AYANDA_TRANSPORT_ID,
  DAVINCI_TRANSPORT_EMAIL,
  DAVINCI_TRANSPORT_ID,
  FAITH_TRANSPORT_EMAIL,
  FAITH_TRANSPORT_ID,
  NAVA_USER_EMAIL,
  NAVA_USER_ID,
} from '../src/db/seed.js';
import { appRouter } from '../src/trpc/router.js';
import { AE1_OUTPUT, AE1_TEXT, fakeModel, selectionFor } from './fixtures/inbound-extraction.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';

const CENTURION = 'transport-centurion';
const OTHER = 'transport-other';
const CENTURION_EMAIL = 'centurion@legacyhotels.co.za';
const OTHER_EMAIL = 'other@legacyhotels.co.za';
const DAVINCI = DAVINCI_TRANSPORT_ID;
const FAITH = FAITH_TRANSPORT_ID;
const USER = 'user-ropperman';
const STAY_ONE = 's_aaaa1111';
const STAY_TWO = 's_cccc2222';
const ROW_SINGLE = 'r_bbbb1111';
const ROW_TWIN = 'r_bbbb2222';
const ROW_STAY_TWO = 'r_dddd1111';

async function addDaVinciMailboxes(db: DB) {
  for (const [id, email] of [
    [DAVINCI, DAVINCI_TRANSPORT_EMAIL],
    [FAITH, FAITH_TRANSPORT_EMAIL],
    [AYANDA_TRANSPORT_ID, AYANDA_TRANSPORT_EMAIL],
  ]) {
    await db
      .insert(mailboxTransport)
      .values({ id, email, ownerHeaderValue: email, mailboxType: 'personal', sendFromConfig: { aliases: [] } })
      .onConflictDoNothing({ target: mailboxTransport.id });
  }
}

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
function withDb(run: (db: DB, url: string) => Promise<void>) {
  return withIngestionDb(async ({ db, sql, url }) => {
    __setDbForTests({ db, conn: sql });
    try {
      await run(db, url);
    } finally {
      __setDbForTests(null);
    }
  });
}

async function addOtherTransport(db: DB) {
  await db.insert(mailboxTransport).values({
    id: OTHER,
    email: OTHER_EMAIL,
    ownerHeaderValue: OTHER_EMAIL,
    mailboxType: 'personal',
    sendFromConfig: { aliases: [] },
  });
}

/** One inbound mail with a Message-ID of `<id>@example.com` for an explicit mailbox. */
async function seedMailForTransport(db: DB, id: string, transportId: string, transportEmail: string): Promise<string> {
  await seedInboxThread(db, {
    threadId: `thread-${id}`,
    transportId,
    transportEmail,
    messageId: `msg-${id}`,
    fromAddress: 'sender@example.com',
    subject: 'Rooms request',
    textBody: 'Please quote.',
    messageIdHeader: `${id}@example.com`,
  });
  return `msg-${id}`;
}

/** One inbound mail for the legacy test mailbox. */
async function seedMail(db: DB, id: string): Promise<string> {
  return seedMailForTransport(db, id, CENTURION, CENTURION_EMAIL);
}

/** Inserts one read for a message, as the inbound run would store it. */
async function insertRead(
  db: DB,
  messageId: string,
  read: {
    version: string;
    status?: 'succeeded' | 'failed';
    kind?: MailKind;
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

function callerForTransport(activeTransportId: string, transportEmail: string) {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: { id: USER, email: 'ropperman@legacyhotels.co.za', name: 'R Opperman' },
    activeTransportId,
    transportEmail,
    accessRole: 'owner',
  } as never);
}

function centurionCaller(activeTransportId = CENTURION) {
  return callerForTransport(activeTransportId, CENTURION_EMAIL);
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
        sourcePreference: { roomType: 'Single', board: null },
      });
      expect(work.analysis.groups[0]!.fields).toMatchObject({
        arrivalDate: 'extracted',
        quantity: 'extracted',
        board: 'defaulted',
      });
      expect(work.analysis.groups[2]!.arrivalDate).toBe('2027-11-17');
      expect(work.refs[ROW_TWIN]).toEqual({ stayId: STAY_ONE, rowId: ROW_TWIN });
      expect(work.analysis.groups.map((group) => group.stayId)).toEqual([STAY_ONE, STAY_ONE, STAY_TWO]);
      expect(work.analysis.reviewItems?.map((item) => item.id)).not.toContain('missing:rooms:0');
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

  it('puts a payment_proof to-do card on a stored voucher_pop read, with payment_ack workflow', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'pop1');
      await db.update(message).set({ subject: 'Proof of payment 57291630-1' }).where(eq(message.id, messageId));
      await insertRead(db, messageId, {
        version: 'extract-v1',
        kind: 'voucher_pop',
        payload: { ...payload(), confirmationNumbers: ['57291630-1'], stays: [] },
      });
      const work = await storedWorkFor(db, {
        transportId: CENTURION,
        internetMessageId: '<pop1@example.com>',
      });
      if (work.status !== 'ready') throw new Error(`expected ready, got ${work.status}`);
      expect(work.analysis.luna.workflow).toBe('payment_ack');
      expect(work.analysis.hmsTodoCard).toMatchObject({ kind: 'payment_proof' });
    }));

  it('puts a new_booking to-do card on a stored booking read', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'bk1');
      await insertRead(db, messageId, { version: 'extract-v1', kind: 'booking', payload: payload() });
      const work = await storedWorkFor(db, {
        transportId: CENTURION,
        internetMessageId: '<bk1@example.com>',
      });
      if (work.status !== 'ready') throw new Error(`expected ready, got ${work.status}`);
      expect(work.analysis.hmsTodoCard).toMatchObject({ kind: 'new_booking' });
    }));

  it('keeps the stored amendment roster on the checklist without assigning rooms', () =>
    withDb(async (db) => {
      const extracted = payload();
      const source = extracted.stays[0]!;
      extracted.stays = [{
        ...source,
        action: 'amend',
        totalRooms: 1,
        guests: [{ name: 'Ada Example', confirmationNumber: '57291630-1' }],
        rows: [{ ...source.rows[0]!, rooms: 1 }],
      }];
      extracted.confirmationNumbers = ['57291630-1'];
      const messageId = await seedMail(db, 'amend-checklist-single');
      await insertRead(db, messageId, { version: 'extract-v1', kind: 'amendment', payload: extracted });
      const work = await storedWorkFor(db, {
        transportId: CENTURION, internetMessageId: '<amend-checklist-single@example.com>',
      });
      if (work.status !== 'ready') throw new Error(`expected ready, got ${work.status}`);
      expect(work.analysis.luna.groups[0]?.guestNames).toEqual([]);
      expect(work.analysis.hmsTodoCard?.steps).toContainEqual({ label: 'Guests named in email', value: 'Ada Example', source: 'mail' });

      // A multi-room roster stays visible but is not assigned to the first room.
      extracted.stays[0]!.totalRooms = 2;
      extracted.stays[0]!.rows[0]!.rooms = 2;
      extracted.stays[0]!.guests!.push({ name: 'Bea Example', confirmationNumber: null });
      const otherId = await seedMail(db, 'amend-checklist-multiple');
      await insertRead(db, otherId, { version: 'extract-v1', kind: 'amendment', payload: extracted });
      const multiple = await storedWorkFor(db, {
        transportId: CENTURION, internetMessageId: '<amend-checklist-multiple@example.com>',
      });
      if (multiple.status !== 'ready') throw new Error(`expected ready, got ${multiple.status}`);
      expect(multiple.analysis.hmsTodoCard?.steps).toContainEqual({ label: 'Guests named in email', value: 'Ada Example, Bea Example', source: 'mail' });
      expect(multiple.analysis.hmsTodoCard?.steps.some((step) => step.label === 'Guests' || /^Group \d+ Guests$/.test(step.label))).toBe(false);
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
      expect(await storedWorkFor(db, lookup)).toMatchObject({
        extractionId: first, analysis: { caseActionsUncertain: true },
      });
      const [after] = await db.select().from(workItem).where(eq(workItem.sourceMessageId, messageId));
      expect(after).toEqual(before);
      await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId });
      const relinked = await storedWorkFor(db, lookup);
      expect(relinked).toMatchObject({ extractionId: second });
      expect(relinked.status === 'ready' && relinked.analysis.caseActionsUncertain).toBeFalsy();
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

  it('gives an amendment its amendment fields and a selectable case', () =>
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
      expect(work.analysis.groups).toHaveLength(1);
      expect(work.analysis.groups[0]).toMatchObject({ stayId: STAY_ONE, caseScoped: true });
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

  it('flags multi_date only when stays have distinct date sets', () => {
    const extracted = payload({ stayOneArrival: '2027-10-26', stayTwoArrival: '2027-10-26' });
    extracted.stays[1]!.requested.departure = '2027-10-28';
    expect(storedAnalysis({ kind: 'quote', payload: extracted, attachments: [] }, {}).analysis.luna.flags).not.toContain(
      'multi_date',
    );
    expect(storedAnalysis({ kind: 'quote', payload: payload(), attachments: [] }, {}).analysis.luna.flags).toContain(
      'multi_date',
    );
  });

  it('keeps a guest confirmation on its own stay and leaves an unattributed number unresolved', () => {
    const extracted = payload();
    extracted.confirmationNumbers = ['57291630-1'];
    extracted.stays[0] = {
      ...extracted.stays[0]!,
      booked: { arrival: '2026-11-01', departure: '2026-11-06' },
      requested: { arrival: '2026-10-31', departure: '2026-11-07' },
      guests: [{ name: 'Ada Example', confirmationNumber: null }],
    };
    extracted.stays[1] = {
      ...extracted.stays[1]!,
      booked: { arrival: '2026-12-01', departure: '2026-12-03' },
      requested: { arrival: '2026-12-10', departure: '2026-12-12' },
      guests: [{ name: 'Bea Example', confirmationNumber: '1111111-1' }],
      rows: extracted.stays[1]!.rows.map((row) => ({ ...row, rooms: 1 })),
    };
    const { analysis, refs } = storedAnalysis({ kind: 'quote', payload: extracted, attachments: [] }, {});
    expect(analysis.luna.groups.map((group) => group.guestNames)).toEqual([[], [], []]);
    expect(analysis.groups.map((group) => group.stayGuests)).toEqual([
      [{ name: 'Ada Example', confirmationNumber: null }],
      undefined,
      [{ name: 'Bea Example', confirmationNumber: '1111111-1' }],
    ]);
    expect(analysis.groups.map((group) => group.confirmationNumber)).toEqual([
      undefined,
      undefined,
      '1111111-1',
    ]);
    expect(analysis.luna.confirmationNumber).toBeNull();
    expect(analysis.luna.arrival).toBeNull();
    expect(analysis.luna.departure).toBeNull();
    expect(analysis.luna.requestedArrival).toBeNull();
    expect(analysis.luna.requestedDeparture).toBeNull();
    expect(Object.keys(refs)).toHaveLength(3);
  });

  it('keeps two guests on their stay without guessing a room row for either', () => {
    const extracted = payload();
    extracted.stays = [
      {
        ...extracted.stays[0]!,
        rows: extracted.stays[0]!.rows.map((row) => ({ ...row, rooms: 1 })),
        guests: [
          { name: 'Ada Example', confirmationNumber: null },
          { name: 'Bea Example', confirmationNumber: null },
        ],
      },
    ];
    const analysis = storedAnalysis({ kind: 'quote', payload: extracted, attachments: [] }, {}).analysis;
    expect(analysis.luna.groups.map((group) => group.guestNames)).toEqual([[], []]);
    expect(analysis.groups[0]?.stayGuests).toEqual([
      { name: 'Ada Example', confirmationNumber: null },
      { name: 'Bea Example', confirmationNumber: null },
    ]);
    expect(analysis.groups[1]?.stayGuests).toBeUndefined();
  });

  it('keeps two named guests visible without assigning them to the rooms', () => {
    const extracted = payload();
    const row = extracted.stays[0]!.rows[0]!;
    extracted.stays = [
      {
        ...extracted.stays[0]!,
        totalRooms: 2,
        rows: [{ ...row, rooms: 2 }],
        guests: [
          { name: 'Ada Example', confirmationNumber: null },
          { name: 'Bea Example', confirmationNumber: null },
        ],
      },
    ];
    const analysis = storedAnalysis({ kind: 'quote', payload: extracted, attachments: [] }, {}).analysis;
    expect(analysis.luna.groups.map((group) => group.guestNames)).toEqual([[]]);
    expect(analysis.groups[0]?.stayGuests).toEqual([
      { name: 'Ada Example', confirmationNumber: null },
      { name: 'Bea Example', confirmationNumber: null },
    ]);
  });

  it('keeps one work item for a multi-stay mail', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'ma1');
      const extracted = payload();
      extracted.stays[0] = {
        ...extracted.stays[0]!,
        guests: [{ name: 'Ada Example', confirmationNumber: '1111111-1' }],
      };
      extracted.stays[1] = {
        ...extracted.stays[1]!,
        guests: [{ name: 'Bea Example', confirmationNumber: '2222222-2' }],
      };
      await insertRead(db, messageId, { version: 'extract-v1', payload: extracted });
      const work = await readyWork(db, 'ma1');
      const items = await db.select({ id: workItem.id }).from(workItem).where(eq(workItem.sourceMessageId, messageId));
      expect(items).toHaveLength(1);
      expect(work.workItemId).toBe(items[0]!.id);
      expect(work.analysis.groups.map((group) => group.stayId)).toEqual([STAY_ONE, STAY_ONE, STAY_TWO]);
      expect(work.confirmationNumbers).toEqual(['1111111-1', '2222222-2']);
    }));

  it('fills a stored amendment confirmation from thread PDF evidence when the selected read has none', () => {
    const extracted = payload();
    extracted.confirmationNumbers = [];
    extracted.stays = extracted.stays.slice(0, 1);
    extracted.stays[0]!.rows = [{ ...extracted.stays[0]!.rows[0]!, rooms: 1 }];
    const analysis = storedAnalysis(
      { kind: 'amendment', payload: extracted, attachments: [] },
      {},
      { confirmation: '57291630-1', reason: null },
    ).analysis;
    expect(analysis.amendment?.confirmationNumber).toBe('57291630-1');
    expect(analysis.luna.confirmationNumber).toBe('57291630-1');
  });

  it('fails closed on the stored path when thread PDFs disagree, and never dashes a bare number', () => {
    const extracted = payload();
    extracted.confirmationNumbers = ['47360291'];
    extracted.stays = extracted.stays.slice(0, 1);
    extracted.stays[0]!.rows = [{ ...extracted.stays[0]!.rows[0]!, rooms: 1 }];
    const ambiguous = storedAnalysis(
      { kind: 'amendment', payload: extracted, attachments: [] },
      {},
      { confirmation: null, reason: THREAD_CONFIRMATION_AMBIGUOUS },
    ).analysis;
    expect(ambiguous.amendment?.confirmationNumber).toBeNull();
    expect(ambiguous.reviewItems.some((item) => item.text.includes('more than one booking number'))).toBe(
      true,
    );

    const bare = storedAnalysis(
      { kind: 'amendment', payload: extracted, attachments: [] },
      {},
      { confirmation: null, reason: null },
    ).analysis;
    expect(bare.amendment?.confirmationNumber).toBe('47360291');
    expect(bare.amendment?.confirmationNumber).not.toBe('47360291-1');
  });

  it('uses a later sibling confirmation PDF filename on the stored ready view', () =>
    withDb(async (db) => {
      const guestId = await seedMail(db, 'sib-guest');
      await db.insert(message).values({
        id: 'sib-staff',
        transportId: CENTURION,
        threadId: 'thread-sib-guest',
        direction: 'outbound',
        fromAddress: 'centurion@legacyhotels.co.za',
        toAddresses: ['sender@example.com'],
        ccAddresses: [],
        bccAddresses: [],
        subject: 'Re: Rooms request',
        textBody: 'Confirmation attached.',
        ownerHeaderValue: 'centurion@legacyhotels.co.za',
        messageIdHeader: 'sib-staff@example.com',
        references: [],
        isRead: true,
        isStarred: false,
        receivedAt: new Date('2026-10-06T09:00:00Z'),
      });
      await db.insert(attachment).values({
        id: 'sib-pdf',
        messageId: 'sib-staff',
        filename: '57291630-1.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        s3Key: 'test/sib-pdf.pdf',
        isInline: false,
      });
      const extracted = payload();
      extracted.stays = [{ ...extracted.stays[0]!, rows: [{ ...extracted.stays[0]!.rows[0]!, rooms: 1 }] }];
      await insertRead(db, guestId, {
        version: 'extract-v1',
        kind: 'amendment',
        payload: extracted,
      });
      const work = await storedWorkFor(db, {
        transportId: CENTURION,
        internetMessageId: '<sib-guest@example.com>',
      });
      expect(work.status).toBe('ready');
      if (work.status !== 'ready') throw new Error('expected ready');
      expect(work.analysis.amendment?.confirmationNumber).toBe('57291630-1');
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
      // The edited `other` item keeps its status, but stays outside the Needs-you scope.
      expect(open.map((row) => row.id)).not.toContain(edited!.id);
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

  it('keeps her arrival edit on the same stay when a re-read only swaps stay order', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'up3');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'up3');
      await recordFieldEvent(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        userId: USER,
        type: 'field.edit',
        fieldPath: `stays[${STAY_ONE}].requested.arrival`,
        value: '2027-10-25',
      });
      const swapped = payload();
      swapped.stays = [swapped.stays[1]!, swapped.stays[0]!];
      const second = await insertRead(db, messageId, { version: 'extract-v2', payload: swapped });

      const after = await readyWork(db, 'up3');
      expect(after.extractionId).toBe(second);
      expect(after.analysis.groups.map((group) => [group.roomPreference, group.arrivalDate])).toEqual([
        ['Double/Twin', '2027-11-17'],
        ['Single', '2027-10-25'],
        ['Double/Twin', '2027-10-25'],
      ]);
    }));
});

describe('corrections carry to a re-read', () => {
  it('carries an edit when a re-read only swaps stay order under the same ids', () => {
    const before = payload();
    const after: MailExtractionPayload = { ...payload(), stays: [payload().stays[1]!, payload().stays[0]!] };
    const state = { [`stays[${STAY_ONE}].requested.arrival`]: '2027-10-25' };
    expect(correctionsCarryTo(before, after, state)).toBe(true);
  });

  it('keeps a stay commit attached when a re-read only swaps stay order', () => {
    const before = payload();
    const after: MailExtractionPayload = { ...payload(), stays: [payload().stays[1]!, payload().stays[0]!] };
    const state = withStayCommit({}, `${STAY_ONE}_1`, {
      confirmationNumber: '46184891-1',
      status: 'booked',
      screenshotRef: null,
    });
    expect(correctionsCarryTo(before, after, state)).toBe(true);
  });

  it('does not carry an edit onto a new stay id even when the dates uniquely match', () => {
    const before = payload();
    const [oct, nov] = payload().stays;
    const after: MailExtractionPayload = {
      ...payload(),
      stays: [
        { ...nov!, id: 's_nov_new', rows: nov!.rows.map((row) => ({ ...row, id: 'r_nov_new' })) },
        { ...oct!, id: 's_oct_new', rows: oct!.rows.map((row, index) => ({ ...row, id: `r_oct_new_${index}` })) },
      ],
    };
    const state = { [`stays[${STAY_ONE}].requested.arrival`]: '2027-10-25' };
    expect(correctionsCarryTo(before, after, state)).toBe(false);
  });

  it('does not move an October edit onto a leftover December stay after November still matches', () => {
    const before = payload();
    const nov = payload().stays[1]!;
    const after: MailExtractionPayload = {
      ...payload(),
      stays: [
        nov,
        {
          id: 's_dec_new',
          hotel: 'Grand Hotel',
          requested: { arrival: '2027-12-01', departure: '2027-12-03' },
          booked: null,
          totalRooms: null,
          rows: [{ id: 'r_dec_new', roomType: 'Double/Twin', rooms: 4, adultsPerRoom: 2, childAges: [], board: null }],
        },
      ],
    };
    const state = { [`stays[${STAY_ONE}].requested.arrival`]: '2027-10-25' };
    expect(correctionsCarryTo(before, after, state)).toBe(false);
  });

  it('does not move a Twin-row edit onto a leftover Family row after Single still matches', () => {
    const before = payload();
    const after = payload();
    after.stays[0] = {
      ...after.stays[0]!,
      rows: [
        after.stays[0]!.rows[0]!,
        { id: 'r_family_new', roomType: 'Family', rooms: 1, adultsPerRoom: 3, childAges: [], board: 'bb' },
      ],
    };
    const state = { [`stays[${STAY_ONE}].rows[${ROW_TWIN}].adults`]: 3 };
    expect(correctionsCarryTo(before, after, state)).toBe(false);
  });

  it('does not move an October edit onto a stay that reused the dropped October id', () =>
    withDb(async (db) => {
      const before = payload();
      const after: MailExtractionPayload = {
        ...payload(),
        stays: [
          payload().stays[1]!,
          {
            id: STAY_ONE,
            hotel: 'Grand Hotel',
            requested: { arrival: '2027-12-01', departure: '2027-12-03' },
            booked: null,
            totalRooms: null,
            rows: [
              { id: 'r_dec_reused', roomType: 'Double/Twin', rooms: 4, adultsPerRoom: 2, childAges: [], board: null },
            ],
          },
        ],
      };
      const state = { [`stays[${STAY_ONE}].requested.arrival`]: '2027-10-25' };
      expect(correctionsCarryTo(before, after, state)).toBe(false);

      const messageId = await seedMail(db, 'up4');
      const first = await insertRead(db, messageId, { version: 'extract-v1', payload: before });
      const work = await readyWork(db, 'up4');
      await recordFieldEvent(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        userId: USER,
        type: 'field.edit',
        fieldPath: `stays[${STAY_ONE}].requested.arrival`,
        value: '2027-10-25',
      });
      const second = await insertRead(db, messageId, { version: 'extract-v2', payload: after });
      const moved = await ensureWorkItem(db, {
        transportId: CENTURION,
        threadId: 'thread-up4',
        messageId,
        kind: 'quote',
        extractionId: second,
      });
      expect(moved.extractionId).toBe(first);
      expect(second).not.toBe(first);
      expect(await storedWorkFor(db, {
        transportId: CENTURION, internetMessageId: '<up4@example.com>',
      })).toMatchObject({ extractionId: first, analysis: { caseActionsUncertain: true } });
    }));

  it('keeps a cleared field on its original read when an ambiguous same-date re-read reuses ids', () =>
    withDb(async (db) => {
      const before = payload();
      before.stays[1]!.requested = { ...before.stays[0]!.requested };
      const after = structuredClone(before);
      after.stays = [
        { ...after.stays[1]!, id: STAY_ONE },
        { ...after.stays[0]!, id: STAY_TWO },
      ];
      const messageId = await seedMail(db, 'ambiguous-reread');
      const firstRead = await insertRead(db, messageId, { version: 'extract-v1', payload: before });
      const firstOpen = await readyWork(db, 'ambiguous-reread');
      expect(await recordFieldEvent(db, {
        transportId: CENTURION,
        workItemId: firstOpen.workItemId,
        userId: USER,
        type: 'field.reject',
        fieldPath: `stays[${STAY_ONE}].requested.departure`,
      })).toMatchObject({ status: 'recorded', value: null });
      const laterRead = await insertRead(db, messageId, { version: 'extract-v2', payload: after });
      const linked = await ensureWorkItem(db, {
        transportId: CENTURION,
        threadId: 'thread-ambiguous-reread',
        messageId,
        kind: 'quote',
        extractionId: laterRead,
      });
      expect(linked.extractionId).toBe(firstRead);
      expect(linked.state[`stays[${STAY_ONE}].requested.departure`]).toBeNull();

      const reopened = await readyWork(db, 'ambiguous-reread');
      expect(reopened.extractionId).toBe(firstRead);
      expect(reopened.analysis.groups.find((group) => group.id === ROW_SINGLE)).toMatchObject({
        stayId: STAY_ONE,
        fields: { departureDate: 'staff_corrected' },
      });
      expect(reopened.analysis.groups.find((group) => group.id === ROW_SINGLE)?.departureDate).toBeUndefined();
    }));

  it('keeps a saved edit on its read when the same dates later name another guest', () =>
    withDb(async (db) => {
      const before = payload();
      before.stays = [{
        ...before.stays[0]!,
        rows: [before.stays[0]!.rows[0]!],
        guests: [{ name: 'Ada Example', confirmationNumber: null }],
      }];
      const after = structuredClone(before);
      after.stays[0]!.guests = [{ name: 'Bea Example', confirmationNumber: null }];
      const messageId = await seedMail(db, 'conflicting-reread');
      const firstRead = await insertRead(db, messageId, { version: 'extract-v1', payload: before });
      const firstOpen = await readyWork(db, 'conflicting-reread');
      await recordFieldEvent(db, {
        transportId: CENTURION, workItemId: firstOpen.workItemId, userId: USER,
        type: 'field.edit', fieldPath: `stays[${STAY_ONE}].rows[${ROW_SINGLE}].adults`, value: 3,
      });
      const laterRead = await insertRead(db, messageId, { version: 'extract-v2', payload: after });
      const linked = await ensureWorkItem(db, {
        transportId: CENTURION, threadId: 'thread-conflicting-reread', messageId,
        kind: 'quote', extractionId: laterRead,
      });
      expect(linked.extractionId).toBe(firstRead);
      const reopened = await readyWork(db, 'conflicting-reread');
      expect(reopened.extractionId).toBe(firstRead);
      expect(reopened.analysis.groups[0]?.adults).toBe(3);
      expect(reopened.analysis.groups[0]?.stayGuests).toEqual([{ name: 'Ada Example', confirmationNumber: null }]);
    }));
});

describe('field events', () => {
  it('guards competing recovery writes with the reopened revision and extraction', () =>
    withDb(async (db, url) => {
      const messageId = await seedMail(db, 'cas-1');
      const firstRead = await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const opened = await readyWork(db, 'cas-1');
      expect(opened.revisionSeq).toBe(0);
      expect(opened.stateDigest).toMatch(/^[a-f0-9]{64}$/);
      const path = `stays[${STAY_ONE}].rows[${ROW_SINGLE}].count`;
      const base = {
        transportId: CENTURION, workItemId: opened.workItemId, userId: USER,
        type: 'field.edit' as const, fieldPath: path,
        expected: { extractionId: firstRead, seq: 0, stateDigest: opened.stateDigest! },
      };
      // Separate PostgreSQL connections contend for the same row lock; only one expected revision can win.
      const otherConn = postgres(url, { max: 1, connect_timeout: 5, ssl: false, onnotice: () => undefined });
      try {
        const otherDb = drizzle(otherConn, { schema });
        const attempts = await Promise.all([
          recordFieldEvent(db, { ...base, value: 8 }),
          recordFieldEvent(otherDb, { ...base, value: 9 }),
        ]);
        expect(attempts.map((result) => result.status).sort()).toEqual(['recorded', 'stale']);
        const winner = attempts.find((result) => result.status === 'recorded');
        if (!winner || winner.status !== 'recorded') throw new Error('missing winning write');
        expect(winner.cursor).toMatchObject({ extractionId: firstRead, seq: 1, stateDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
        if (!winner.cursor) throw new Error('missing winning cursor');
        const [saved] = await db.select().from(workItem).where(eq(workItem.id, opened.workItemId));
        expect(saved?.state[path]).toBe(winner.value);
        expect(saved?.revisionSeq).toBe(1);
        expect(await eventsFor(db, opened.workItemId)).toHaveLength(1);

        const caller = centurionCaller().workItems;
        const event = { workItemId: opened.workItemId, type: 'field.edit' as const, fieldPath: path, value: 3 };
        await expect(caller.recordEvent({ ...event, expected: { extractionId: firstRead, seq: 0, stateDigest: winner.cursor.stateDigest } }))
          .rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(caller.recordEvent({ ...event, expected: { extractionId: randomUUID(), seq: 1, stateDigest: winner.cursor.stateDigest } }))
          .rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(caller.recordEvent({ ...event, expected: { extractionId: firstRead, stateDigest: winner.cursor.stateDigest } as never }))
          .rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect((await db.select().from(workItem).where(eq(workItem.id, opened.workItemId)))[0]).toEqual(saved);
        expect(await eventsFor(db, opened.workItemId)).toHaveLength(1);

        const next = await caller.recordEvent({
          ...event, fieldPath: 'contact.name', value: 'Sample',
          expected: { extractionId: firstRead, seq: 1, stateDigest: winner.cursor.stateDigest },
        });
        expect(next).toMatchObject({ value: 'Sample', cursor: {
          extractionId: firstRead, seq: 2, stateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        } });
        const legacy = await caller.recordEvent({ ...event, fieldPath: 'contact.phone', value: '123' });
        expect(legacy).toEqual({ aiValue: null, value: '123' });
        const snapshot = await readyWork(db, 'cas-1');
        expect(snapshot.revisionSeq).toBe(3);
        expect(snapshot.contact.name).toBe('Sample');

        // A booking commit updates state without changing the pane-edit revision.
        expect(await recordStayCommit(db, {
          transportId: CENTURION, workItemId: opened.workItemId, stayId: STAY_ONE,
          record: { confirmationNumber: 'LAB-1', status: 'booked', screenshotRef: null },
        })).toEqual({ status: 'recorded' });
        const afterBooking = await readyWork(db, 'cas-1');
        expect(afterBooking.revisionSeq).toBe(snapshot.revisionSeq);
        expect(afterBooking.stateDigest).not.toBe(snapshot.stateDigest);
        const beforeBookingConflict = await eventsFor(db, opened.workItemId);
        await expect(caller.recordEvent({ ...event, expected: {
          extractionId: firstRead, seq: 3, stateDigest: snapshot.stateDigest!,
        } })).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await eventsFor(db, opened.workItemId)).toHaveLength(beforeBookingConflict.length);
        expect((await db.select().from(workItem).where(eq(workItem.id, opened.workItemId)))[0]?.state[path]).toBe(winner.value);

        // Equal timestamps can otherwise permit A→B→A. Each relink must invalidate an older token.
        const secondRead = await insertRead(db, messageId, { version: 'extract-v2', payload: payload() });
        await db.update(mailExtraction).set({ createdAt: new Date('2026-01-01T00:00:00Z') })
          .where(eq(mailExtraction.id, firstRead));
        await db.update(mailExtraction).set({ createdAt: new Date('2026-01-01T00:00:00Z') })
          .where(eq(mailExtraction.id, secondRead));
        const link = { transportId: CENTURION, threadId: 'thread-cas-1', messageId, kind: 'quote' as const };
        const [raceWrite, forward] = await Promise.all([
          recordFieldEvent(db, { ...base, value: 6, expected: {
            extractionId: firstRead, seq: 3, stateDigest: afterBooking.stateDigest!,
          } }),
          ensureWorkItem(otherDb, { ...link, extractionId: secondRead }),
        ]);
        expect(['recorded', 'stale']).toContain(raceWrite.status);
        expect(forward.extractionId).toBe(secondRead);
        expect(forward.revisionSeq).toBe(raceWrite.status === 'recorded' ? 5 : 4);
        const currentCount = raceWrite.status === 'recorded' ? 6 : winner.value;
        const back = await ensureWorkItem(db, { ...link, extractionId: firstRead });
        expect(back).toMatchObject({ extractionId: firstRead, revisionSeq: forward.revisionSeq + 1 });
        const beforeConflict = await eventsFor(db, opened.workItemId);
        await expect(caller.recordEvent({ ...event, expected: {
          extractionId: firstRead, seq: 3, stateDigest: afterBooking.stateDigest!,
        } }))
          .rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await eventsFor(db, opened.workItemId)).toHaveLength(beforeConflict.length);
        expect((await db.select().from(workItem).where(eq(workItem.id, opened.workItemId)))[0]?.state[path]).toBe(currentCount);

        const beforeDismissal = await storedWorkFor(db, { transportId: CENTURION, internetMessageId: '<cas-1@example.com>' });
        if (beforeDismissal.status !== 'ready') throw new Error('missing current read');
        expect(await dismissWorkItem(db, { transportId: CENTURION, workItemId: opened.workItemId, userId: USER }))
          .toEqual({ status: 'dismissed' });
        const afterDismissal = await storedWorkFor(db, { transportId: CENTURION, internetMessageId: '<cas-1@example.com>' });
        if (afterDismissal.status !== 'ready') throw new Error('missing dismissed read');
        expect(afterDismissal.revisionSeq).toBe(beforeDismissal.revisionSeq);
        expect(afterDismissal.stateDigest).not.toBe(beforeDismissal.stateDigest);
        const beforeDismissConflict = await eventsFor(db, opened.workItemId);
        await expect(caller.recordEvent({ ...event, expected: {
          extractionId: beforeDismissal.extractionId, seq: beforeDismissal.revisionSeq!, stateDigest: beforeDismissal.stateDigest!,
        } })).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await eventsFor(db, opened.workItemId)).toHaveLength(beforeDismissConflict.length);
      } finally {
        await otherConn.end();
      }
    }));

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
      expect(after.analysis.groups[0]!.fields.departureDate).toBe('staff_corrected');
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
        payload: payload(),
      });
      const after = await readyWork(db, 'add1');
      expect(after.workItemId).toBe(work.workItemId);
      expect(after.analysis.groups.map((group) => group.id)).toEqual([ROW_TWIN, ROW_STAY_TWO, 'r_user01', 'r_user02']);
      expect(after.analysis.groups[0]).toMatchObject({ quantity: 5, arrivalDate: '2027-10-26' });
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

  it('uses totalRooms for a single row when its count is missing', () => {
    const extracted = payload();
    extracted.stays[1]!.totalRooms = 6;
    extracted.stays[1]!.rows[0]!.rooms = null;

    expect(formStays(extracted, {})[1]!.rows[0]!.rooms).toBe(6);
    const analysis = storedAnalysis({ kind: 'quote', payload: extracted, attachments: [] }, {}).analysis;
    const projected = analysis.groups.find((group) => group.stayId === STAY_TWO)!;
    expect(projected.quantity).toBe(6);
    expect(projected.fields.quantity).toBe('defaulted');
    expect(analysis.requestedRoomsByStay).toEqual({ [STAY_TWO]: 6 });
  });

  it('preserves a one-room total when extraction contains no room row', () => {
    const extracted = payload();
    extracted.stays = [extracted.stays[0]!];
    extracted.stays[0]!.totalRooms = 1;
    extracted.stays[0]!.rows = [];
    const { analysis } = storedAnalysis({ kind: 'quote', payload: extracted, attachments: [] }, {});
    expect(analysis.groups[0]).toMatchObject({ quantity: 1, childrenPerRoom: null, childrenAges: [] });
    expect(analysis.groups[0]).toMatchObject({ stayHotel: 'Grand Hotel' });
  });

  it('keeps staff child-count and age corrections distinct, including a cleared age list', () => {
    const extracted = payload();
    const base = `stays[${STAY_ONE}].rows[${ROW_SINGLE}]`;
    const read = { kind: 'quote' as const, payload: extracted, attachments: [] };
    const incomplete = storedAnalysis(read, { [`${base}.childrenPerRoom`]: 2, [`${base}.childAges`]: [7] });
    expect(incomplete.analysis.groups[0]).toMatchObject({ childrenPerRoom: 2, childrenAges: [7] });
    const noChildren = storedAnalysis(read, { [`${base}.childrenPerRoom`]: 0, [`${base}.childAges`]: [] });
    expect(noChildren.analysis.groups[0]).toMatchObject({ childrenPerRoom: 0, childrenAges: [] });
    const cleared = storedAnalysis(read, { [`${base}.childrenPerRoom`]: 0, [`${base}.childAges`]: null });
    expect(cleared.analysis.groups[0]).toMatchObject({ childrenPerRoom: null, childrenAges: [] });
    expect(validFieldValue('childrenPerRoom', 0)).toBe(true);
    expect(validFieldValue('childrenPerRoom', -1)).toBe(false);
  });

  it('projects raw room and board source fields independently of quote defaults', () => {
    const extracted = payload();
    const base = `stays[${STAY_ONE}].rows[${ROW_SINGLE}]`;
    const read = { kind: 'quote' as const, payload: extracted, attachments: [] };
    const original = storedAnalysis(read, {}).analysis.groups[0]!;
    expect(original.board).toBe('bb');
    expect(original.sourcePreference).toEqual({ roomType: 'Single', board: null });
    const edited = storedAnalysis(read, { [`${base}.roomType`]: null, [`${base}.board`]: 'dbb' }).analysis.groups[0]!;
    expect(edited.sourcePreference).toEqual({ roomType: null, board: 'dbb' });
  });

  it('keeps totalRooms at stay level when a second row makes the projected stay multi-row', () => {
    const extracted = payload();
    extracted.stays[1]!.totalRooms = 6;
    extracted.stays[1]!.rows[0]!.rooms = null;
    const state = { [`stays[${STAY_TWO}].rows[r_user02].roomType`]: 'Family' };

    const stay = formStays(extracted, state).find((item) => item.id === STAY_TWO)!;
    expect(stay.rows.map((row) => row.rooms)).toEqual([null, null]);
    const analysis = storedAnalysis({ kind: 'quote', payload: extracted, attachments: [] }, state).analysis;
    expect(analysis.requestedRoomsByStay).toEqual({ [STAY_TWO]: 6 });
  });

  it('keeps a multi-row total at stay level instead of allocating it to rows', () => {
    const extracted = payload();
    extracted.stays[0]!.totalRooms = 30;
    extracted.stays[0]!.rows = extracted.stays[0]!.rows.map((row) => ({ ...row, rooms: null }));

    const stays = formStays(extracted, {});
    expect(stays[0]!.rows.map((row) => row.rooms)).toEqual([null, null]);
    expect(stays[0]!.totalRooms).toBe(30);
    expect(
      storedAnalysis({ kind: 'quote', payload: extracted, attachments: [] }, {}).analysis
        .requestedRoomsByStay,
    ).toEqual({ [STAY_ONE]: 30 });
  });

  it('preserves an explicit room-row count when a stay total is also present', () => {
    const extracted = payload();
    extracted.stays[1]!.totalRooms = 6;
    extracted.stays[1]!.rows[0]!.rooms = 4;

    expect(formStays(extracted, {})[1]!.rows[0]!.rooms).toBe(4);
  });

  it('reopens the stay total on the one row left after a removal, with no count saved for it', () => {
    // The pane saves no count for a total that moves with the rows. These are the paths it saves for add, remove, add.
    const extracted = payload();
    extracted.stays[1]!.totalRooms = 6;
    extracted.stays[1]!.rows[0]!.rooms = null;
    const added = { [`stays[${STAY_TWO}].rows[r_user01].removed`]: null, [`stays[${STAY_TWO}].rows[r_user01].childAges`]: [] };
    const removed = { ...added, [`stays[${STAY_TWO}].rows[r_user01].removed`]: true };
    const addedAgain = {
      ...removed,
      [`stays[${STAY_TWO}].rows[r_user02].removed`]: null,
      [`stays[${STAY_TWO}].rows[r_user02].childAges`]: [],
    };
    const roomsOf = (state: Record<string, unknown>) =>
      formStays(extracted, state).find((stay) => stay.id === STAY_TWO)!.rows.map((row) => row.rooms);
    const analysisOf = (state: Record<string, unknown>) =>
      storedAnalysis({ kind: 'quote', payload: extracted, attachments: [] }, state).analysis;

    // Two rows: the total stays at stay level and neither row takes it.
    expect(roomsOf(added)).toEqual([null, null]);
    expect(analysisOf(added).requestedRoomsByStay).toEqual({ [STAY_TWO]: 6 });
    // One row left: the total is that row's count again, and the read still marks it as the default.
    expect(roomsOf(removed)).toEqual([6]);
    expect(analysisOf(removed).groups.find((group) => group.stayId === STAY_TWO)).toMatchObject({
      quantity: 6,
      fields: { quantity: 'defaulted' },
    });
    // Added again: two rows, so the total moves back to the stay.
    expect(roomsOf(addedAgain)).toEqual([null, null]);
    expect(analysisOf(addedAgain).requestedRoomsByStay).toEqual({ [STAY_TWO]: 6 });
  });

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

describe('section reset', () => {
  it('restores only each selected section and logs fields with extraction values', () =>
    withDb(async (db) => {
      await addOtherTransport(db);
      const messageId = await seedMail(db, 'reset1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'reset1');
      const arrival = `stays[${STAY_ONE}].requested.arrival`;
      const count = `stays[${STAY_ONE}].rows[${ROW_SINGLE}].count`;
      const noAiValue = `stays[${STAY_ONE}].rows[${ROW_SINGLE}].board`;
      const otherStay = `stays[${STAY_TWO}].requested.arrival`;
      const addedRow = `stays[${STAY_ONE}].rows[r_user01].count`;
      const company = 'contact.company';
      const edits: Array<[string, string | number]> = [
        [arrival, '2027-10-25'],
        [count, 5],
        [noAiValue, 'bb'],
        [otherStay, '2027-11-16'],
        [addedRow, 4],
        [company, 'Edited company'],
      ];
      for (const [fieldPath, value] of edits) {
        expect(
          await recordFieldEvent(db, {
            transportId: CENTURION,
            workItemId: work.workItemId,
            userId: USER,
            type: 'field.edit',
            fieldPath,
            value,
          }),
        ).toMatchObject({ status: 'recorded' });
      }

      expect(
        await centurionCaller().workItems.resetSection({
          workItemId: work.workItemId,
          section: { type: 'contact' },
        }),
      ).toEqual({ reset: 1 });
      const [afterContactReset] = await db
        .select({ state: workItem.state })
        .from(workItem)
        .where(eq(workItem.id, work.workItemId));
      expect(afterContactReset?.state).toEqual({
        [arrival]: '2027-10-25',
        [count]: 5,
        [noAiValue]: 'bb',
        [otherStay]: '2027-11-16',
        [addedRow]: 4,
      });

      await expect(
        callerForTransport(OTHER, OTHER_EMAIL).workItems.resetSection({
          workItemId: work.workItemId,
          section: { type: 'stay', stayId: STAY_ONE },
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      expect(
        await centurionCaller().workItems.resetSection({
          workItemId: work.workItemId,
          section: { type: 'stay', stayId: STAY_ONE },
        }),
      ).toEqual({ reset: 2 });

      const [stored] = await db.select({ state: workItem.state }).from(workItem).where(eq(workItem.id, work.workItemId));
      expect(stored?.state).toEqual({
        [noAiValue]: 'bb',
        [otherStay]: '2027-11-16',
        [addedRow]: 4,
      });
      const resetEvents = (await eventsFor(db, work.workItemId)).filter((event) => event.type === 'field.reset');
      expect(resetEvents).toHaveLength(3);
      expect(resetEvents.map((event) => event.fieldPath).sort()).toEqual([arrival, count, company].sort());
      expect(resetEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actorKind: 'user',
            actorUserId: USER,
            fieldPath: company,
            aiValue: 'Horizon Trail Tours',
            value: 'Horizon Trail Tours',
            aiSource: 'extract-v1',
          }),
          expect.objectContaining({
            actorKind: 'user',
            actorUserId: USER,
            fieldPath: arrival,
            aiValue: '2027-10-26',
            value: '2027-10-26',
            aiSource: 'extract-v1',
          }),
          expect.objectContaining({
            actorKind: 'user',
            actorUserId: USER,
            fieldPath: count,
            aiValue: 2,
            value: 2,
            aiSource: 'extract-v1',
          }),
        ]),
      );

      const after = await centurionCaller().workItems.getByMessage({ internetMessageId: '<reset1@example.com>' });
      if (after.status !== 'ready') throw new Error('expected a ready work item');
      expect(after.analysis.groups.find((group) => group.id === ROW_SINGLE)).toMatchObject({
        arrivalDate: '2027-10-26',
        quantity: 2,
      });
      expect(after.analysis.groups.find((group) => group.id === ROW_STAY_TWO)?.arrivalDate).toBe('2027-11-16');
      expect(after.fieldProvenance[company]).toEqual({ source: 'ai', value: 'Horizon Trail Tours' });
      expect(after.fieldProvenance[arrival]).toEqual({ source: 'ai', value: '2027-10-26' });
      expect(after.fieldProvenance[otherStay]).toEqual({ source: 'staff', value: '2027-11-16' });
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

  it('returns the latest event source and value per field for the active mailbox', () =>
    withDb(async (db) => {
      await addOtherTransport(db);
      const messageId = await seedMailForTransport(db, 'provenance1', OTHER, OTHER_EMAIL);
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const opened = await openStoredWork(db, {
        transportId: OTHER,
        internetMessageId: '<provenance1@example.com>',
      });
      if (opened.status !== 'ready' || !opened.workItemId) throw new Error('expected a ready work item');

      const arrival = `stays[${STAY_ONE}].requested.arrival`;
      const departure = `stays[${STAY_ONE}].requested.departure`;
      const count = `stays[${STAY_ONE}].rows[${ROW_SINGLE}].count`;
      await db.insert(workEvent).values([
        {
          id: '00000000-0000-4000-8000-000000000001',
          workItemId: opened.workItemId,
          actorKind: 'user',
          actorUserId: USER,
          type: 'field.accept',
          fieldPath: arrival,
          aiValue: '2027-11-01',
          value: '2027-11-01',
          aiSource: 'extract-v1',
          at: new Date('2026-10-01T10:00:00Z'),
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          workItemId: opened.workItemId,
          actorKind: 'user',
          actorUserId: USER,
          type: 'field.edit',
          fieldPath: arrival,
          aiValue: '2027-11-01',
          value: '2027-11-03',
          aiSource: 'extract-v1',
          at: new Date('2026-10-01T10:00:00Z'),
        },
        {
          workItemId: opened.workItemId,
          actorKind: 'user',
          actorUserId: USER,
          type: 'field.accept',
          fieldPath: departure,
          aiValue: '2027-11-05',
          value: '2027-11-05',
          aiSource: 'extract-v2',
          at: new Date('2026-10-01T10:02:00Z'),
        },
        {
          workItemId: opened.workItemId,
          actorKind: 'system',
          type: 'field.seed',
          fieldPath: count,
          aiValue: 4,
          value: 7,
          at: new Date('2026-10-01T10:03:00Z'),
        },
      ]);
      await db.update(workItem).set({ state: { [count]: 9 } }).where(eq(workItem.id, opened.workItemId));

      const work = await callerForTransport(OTHER, OTHER_EMAIL).workItems.getByMessage({
        internetMessageId: '<provenance1@example.com>',
      });
      expect(work.status).toBe('ready');
      expect(work).toHaveProperty('fieldProvenance', {
        [arrival]: { source: 'staff', value: '2027-11-03' },
        [departure]: { source: 'ai', value: '2027-11-05' },
        [count]: { source: 'unknown', value: 7 },
      });
      expect(
        await callerForTransport(CENTURION, CENTURION_EMAIL).workItems.getByMessage({
          internetMessageId: '<provenance1@example.com>',
        }),
      ).toEqual({ status: 'none' });
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

  it('returns Outlook EntryID and canonical source ID separately; missing locator is null', () =>
    withDb(async (db) => {
      const outlookItemId = await openItem(db, 'outlook-source', '2026-10-05T09:00:00Z');
      const legacyItemId = await openItem(db, 'legacy-source', '2026-10-04T09:00:00Z');
      const exactEntryId = 'outlook-entry-id-exact';
      await db
        .update(message)
        .set({ sourceProvenance: { evidence: { locator: { entryId: exactEntryId } } } })
        .where(eq(message.id, 'msg-outlook-source'));
      await db
        .update(message)
        .set({ sourceProvenance: { deliveredAt: '2026-10-04T09:00:00.000Z' } })
        .where(eq(message.id, 'msg-legacy-source'));

      const rows = await openList(db);
      const outlook = rows.find((row) => row.id === outlookItemId);
      const legacy = rows.find((row) => row.id === legacyItemId);

      expect(outlook).toMatchObject({
        sourceMessageId: 'msg-outlook-source',
        outlookEntryId: exactEntryId,
      });
      expect(outlook?.sourceMessageId).not.toBe(outlook?.outlookEntryId);
      expect(outlook).not.toHaveProperty('sourceProvenance');
      expect(legacy).toMatchObject({
        sourceMessageId: 'msg-legacy-source',
        outlookEntryId: null,
      });
    }));

  it('filters the Needs-you route by source-mail received time, inclusively, when the pilot cutoff is set', () =>
    withDb(async (db) => {
      const before = await openItem(db, 'nys-before', '2026-10-07T23:59:59.999Z');
      const boundary = await openItem(db, 'nys-boundary', '2026-10-08T00:00:00.000Z');
      const after = await openItem(db, 'nys-after', '2026-10-09T08:00:00.000Z');

      try {
        vi.stubEnv('NEEDS_YOU_SINCE', '');
        expect((await centurionCaller().workItems.list({})).map((row) => row.id)).toEqual([
          before,
          boundary,
          after,
        ]);

        vi.stubEnv('NEEDS_YOU_SINCE', '2026-10-08T00:00:00.000Z');
        expect((await centurionCaller().workItems.list({})).map((row) => row.id)).toEqual([boundary, after]);
      } finally {
        vi.unstubAllEnvs();
      }
    }));

  it('lists five human-written kinds, excludes automated/other, and includes missing origins', () =>
    withDb(async (db) => {
      const addItem = async (id: string, kind: MailKind, origin?: 'person' | 'system_notice') => {
        const messageId = await seedMail(db, id);
        const readPayload = origin === undefined ? payload() : { ...payload(), origin };
        await insertRead(db, messageId, { version: 'extract-v1', kind, payload: readPayload });
        const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId });
        if (!item) throw new Error(`no work item for ${id}`);
        return item.id;
      };

      const humanQuote = await addItem('allow-human-quote', 'quote', 'person');
      const humanBooking = await addItem('allow-human-booking', 'booking', 'person');
      const humanAmendment = await addItem('allow-human-amendment', 'amendment', 'person');
      const humanCancellation = await addItem('allow-human-cancellation', 'cancellation', 'person');
      const humanVoucherPop = await addItem('allow-human-voucher-pop', 'voucher_pop', 'person');
      const missingOriginQuote = await addItem('allow-missing-origin-quote', 'quote');
      const missingOriginBooking = await addItem('allow-missing-origin-booking', 'booking');
      const unlinkedMessage = await seedMail(db, 'allow-null-extraction-booking');
      const [unlinkedBooking] = await db
        .insert(workItem)
        .values({
          transportId: CENTURION,
          threadId: 'thread-allow-null-extraction-booking',
          sourceMessageId: unlinkedMessage,
          kind: 'booking',
        })
        .returning({ id: workItem.id });

      await addItem('omit-automated-quote', 'quote', 'system_notice');
      await addItem('omit-automated-voucher-pop', 'voucher_pop', 'system_notice');
      await addItem('omit-other', 'other', 'person');

      const rows = await openList(db);
      expect(rows).toHaveLength(8);
      expect(rows.map((row) => row.id)).toEqual(
        expect.arrayContaining([
          humanQuote,
          humanBooking,
          humanAmendment,
          humanCancellation,
          humanVoucherPop,
          missingOriginQuote,
          missingOriginBooking,
          unlinkedBooking!.id,
        ]),
      );
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
            { type: 'copy.link', surface: 'web' },
            { type: 'copy.contact', field: 'email', surface: 'web' },
          ],
        }),
      ).toEqual({ recorded: 5 });

      const logged = await eventsFor(db, work.workItemId);
      expect(logged).toHaveLength(before + 5);
      const actions = logged.filter((event) =>
        ['pane.opened', 'hms.lookup.finished', 'copy.hms_line', 'copy.link', 'copy.contact'].includes(event.type),
      );
      expect(actions.map((event) => event.type).sort()).toEqual([
        'copy.contact',
        'copy.hms_line',
        'copy.link',
        'hms.lookup.finished',
        'pane.opened',
      ]);
      expect(actions.every((event) => event.actorKind === 'user' && event.actorUserId === USER)).toBe(true);
      expect(actions.find((event) => event.type === 'hms.lookup.finished')!.value).toEqual({ ms: 4200 });
      expect(actions.find((event) => event.type === 'copy.hms_line')!.value).toEqual({ kind: 'comment' });
      expect(actions.find((event) => event.type === 'copy.link')!.value).toEqual({ surface: 'web' });
      expect(actions.find((event) => event.type === 'copy.contact')!.value).toEqual({ field: 'email', surface: 'web' });
      expect(actions.find((event) => event.type === 'pane.opened')!.value).toEqual({ surface: 'outlook' });
    }));

  it('stores the HMS notes copy with its block name, and refuses a block name it does not know', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'tm4');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'tm4');
      const route = centurionCaller().workItems;

      expect(
        await route.recordActions({ workItemId: work.workItemId, events: [{ type: 'copy.hms_line', block: 'notes' }] }),
      ).toEqual({ recorded: 1 });
      const copied = (await eventsFor(db, work.workItemId)).filter((event) => event.type === 'copy.hms_line');
      expect(copied.map((event) => event.value)).toEqual([{ block: 'notes' }]);
      await expect(
        route.recordActions({ workItemId: work.workItemId, events: [{ type: 'copy.hms_line', block: 'bank' } as never] }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
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
        route.recordActions({ workItemId: work.workItemId, events: [{ type: 'copy.contact' } as never] }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        route.recordActions({ workItemId: work.workItemId, events: [{ type: 'copy.contact', field: 'message' } as never] }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
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

// Thread rules: reply link (C2), same-thread collapse (C3) and staff-sent other. Each mail has its own time, so the rules
// see the order the mail arrived or was sent in.
const MAILBOX = 'centurion@legacyhotels.co.za';
const GUEST = 'sender@example.com';
const STAFF = 'ops@legacyhotels.co.za';
// A hotel-domain address the transport has never sent from: a forged From is the same shape as a copy.
const FORGED = 'intruder@legacyhotels.co.za';

/** A guest mail on a thread, received at `at`. Returns its message id. */
async function guestMail(db: DB, id: string, threadId: string, at: string, from = GUEST): Promise<string> {
  const messageId = `msg-${id}`;
  await seedInboxThread(db, {
    threadId,
    transportId: CENTURION,
    transportEmail: MAILBOX,
    messageId,
    fromAddress: from,
    subject: 'Rooms request',
    textBody: 'Please quote.',
    messageIdHeader: `${id}@example.com`,
  });
  await db.update(message).set({ receivedAt: new Date(at) }).where(eq(message.id, messageId));
  return messageId;
}

/** A hotel mail on a thread, sent at `at`. A queued send has no sent time yet. */
async function hotelMail(db: DB, id: string, threadId: string, at: string, queued = false): Promise<string> {
  const messageId = `msg-${id}`;
  await db.insert(message).values({
    id: messageId,
    transportId: CENTURION,
    threadId,
    direction: 'outbound',
    fromAddress: MAILBOX,
    toAddresses: [GUEST],
    subject: 'Re: Rooms request',
    textBody: 'Quoted.',
    ownerHeaderValue: MAILBOX,
    messageIdHeader: `${id}@example.com`,
    sentAt: queued ? null : new Date(at),
  });
  return messageId;
}

/**
 * A hotel mail that reached the mailbox as inbound: a sent-item copy or a CC, from the hotel's own address. POP3 stored
 * its Date header as the sent time; Nava fetched it at `arrivedAt`, the time that orders it against guest mail.
 */
async function staffCopy(
  db: DB,
  id: string,
  threadId: string,
  sentAt: string,
  arrivedAt: string,
  from = STAFF,
): Promise<string> {
  const messageId = `msg-${id}`;
  await db.insert(message).values({
    id: messageId,
    transportId: CENTURION,
    threadId,
    direction: 'inbound',
    fromAddress: from,
    toAddresses: [MAILBOX],
    subject: 'Re: Rooms request',
    textBody: 'Quoted.',
    ownerHeaderValue: MAILBOX,
    messageIdHeader: `${id}@example.com`,
    pop3Uidl: `uidl-${id}`,
    receivedAt: new Date(sentAt),
    sentAt: new Date(sentAt),
    createdAt: new Date(arrivedAt),
  });
  return messageId;
}

/**
 * The transport has sent from this exact address before: an outbound on a thread of its own, dated before the tests'
 * mail. Nothing stores an authentication result, so a sent-from address is the only evidence a copy is the hotel's.
 */
async function sentFromBefore(db: DB, id: string, from: string): Promise<void> {
  const threadId = `thread-sent-${id}`;
  await seedInboxThread(db, {
    threadId,
    transportId: CENTURION,
    transportEmail: MAILBOX,
    messageId: `msg-sent-${id}-in`,
    fromAddress: GUEST,
    subject: 'Rooms request',
    textBody: 'Earlier.',
    messageIdHeader: `sent-${id}-in@example.com`,
  });
  await db.insert(message).values({
    id: `msg-sent-${id}`,
    transportId: CENTURION,
    threadId,
    direction: 'outbound',
    fromAddress: from,
    toAddresses: [GUEST],
    subject: 'Earlier',
    textBody: 'Earlier.',
    ownerHeaderValue: MAILBOX,
    messageIdHeader: `sent-${id}@example.com`,
    sentAt: new Date('2027-09-01T08:00:00Z'),
  });
}

async function daVinciGuestMail(db: DB, id: string, threadId: string, at: string): Promise<string> {
  const messageId = `msg-${id}`;
  await seedInboxThread(db, {
    threadId,
    transportId: DAVINCI,
    transportEmail: DAVINCI_TRANSPORT_EMAIL,
    messageId,
    fromAddress: GUEST,
    subject: 'Rooms request',
    textBody: 'Please quote.',
    messageIdHeader: `${id}@example.com`,
  });
  await db.update(message).set({ receivedAt: new Date(at) }).where(eq(message.id, messageId));
  return messageId;
}

async function propertyOutbound(
  db: DB,
  id: string,
  transportId: string,
  transportEmail: string,
  from: string,
  at: string,
): Promise<void> {
  const threadId = `thread-property-sent-${id}`;
  await seedInboxThread(db, {
    threadId,
    transportId,
    transportEmail,
    messageId: `msg-property-sent-${id}-in`,
    fromAddress: GUEST,
    subject: 'Earlier request',
    textBody: 'Earlier.',
  });
  await db.insert(message).values({
    id: `msg-property-sent-${id}`,
    transportId,
    threadId,
    direction: 'outbound',
    fromAddress: from,
    toAddresses: [GUEST],
    subject: 'Earlier reply',
    textBody: 'Earlier reply.',
    ownerHeaderValue: transportEmail,
    messageIdHeader: `${id}@example.com`,
    sentAt: new Date(at),
  });
}

async function daVinciReplyCopy(
  db: DB,
  id: string,
  threadId: string,
  from: string,
  sentAt: string,
  arrivedAt: string,
): Promise<string> {
  const messageId = `msg-${id}`;
  await db.insert(message).values({
    id: messageId,
    transportId: DAVINCI,
    threadId,
    direction: 'inbound',
    fromAddress: from,
    toAddresses: [DAVINCI_TRANSPORT_EMAIL],
    subject: 'Re: Rooms request',
    textBody: 'Quoted.',
    ownerHeaderValue: DAVINCI_TRANSPORT_EMAIL,
    messageIdHeader: `${id}@example.com`,
    pop3Uidl: `uidl-${id}`,
    receivedAt: new Date(arrivedAt),
    sentAt: new Date(sentAt),
    createdAt: new Date(arrivedAt),
  });
  return messageId;
}

async function daVinciTodo(db: DB, id: string, at: string) {
  const messageId = await daVinciGuestMail(db, id, `thread-${id}`, at);
  await insertRead(db, messageId, { version: `dv-${id}`, kind: 'quote', payload: payload() });
  return ensureWorkItemForMessage(db, { transportId: DAVINCI, messageId });
}

/** A guest mail's read, as the inbound run stores it. */
function readOf(db: DB, messageId: string, kind: 'quote' | 'other', version = 'extract-v1') {
  return insertRead(db, messageId, { version, kind, payload: payload() });
}

/** The thread rules, run the way live admission runs them when a mail lands on the thread. */
function refreshThread(db: DB, threadId: string) {
  return refreshThreadWork(db, { transportId: CENTURION, threadId });
}

async function replyStatus(db: DB, workItemId: string) {
  const [row] = await db.select({ status: workItem.status }).from(workItem).where(eq(workItem.id, workItemId));
  return row!.status;
}

describe('thread work: reply link, same-thread collapse, staff-sent other (C2, C3)', () => {
  it('uses Faith sent-mail evidence to close a Da Vinci copy and reopens it for later guest mail', () =>
    withDb(async (db) => {
      await addDaVinciMailboxes(db);
      const item = await daVinciTodo(db, 'faith-reply-request', '2027-10-01T08:00:00Z');
      await propertyOutbound(
        db,
        'faith-reply-source',
        FAITH,
        FAITH_TRANSPORT_EMAIL,
        FAITH_TRANSPORT_EMAIL,
        '2027-10-01T09:00:00Z',
      );
      const replyCopy = await daVinciReplyCopy(
        db,
        'faith-reply-copy',
        'thread-faith-reply-request',
        FAITH_TRANSPORT_EMAIL,
        '2027-10-01T09:00:00Z',
        '2027-10-01T09:05:00Z',
      );

      expect(await refreshThreadWork(db, { transportId: DAVINCI, threadId: 'thread-faith-reply-request' })).toEqual([
        expect.objectContaining({ to: 'done', reason: 'hotel_replied', sentMessageId: replyCopy }),
      ]);
      expect(await replyStatus(db, item!.id)).toBe('done');

      await daVinciGuestMail(db, 'faith-reply-followup', 'thread-faith-reply-request', '2027-10-01T10:00:00Z');
      expect(await refreshThreadWork(db, { transportId: DAVINCI, threadId: 'thread-faith-reply-request' })).toEqual([
        expect.objectContaining({ to: 'needs_you', reason: 'new_inbound', previousSentMessageId: replyCopy }),
      ]);
      expect(await replyStatus(db, item!.id)).toBe('needs_you');
    }));

  it.each([
    {
      name: 'a forged own-domain From without any matching sent mail',
      outbound: null,
      copyFrom: FORGED,
    },
    {
      name: 'notfaith@ as evidence for a faith@ copy',
      outbound: {
        transportId: FAITH,
        transportEmail: FAITH_TRANSPORT_EMAIL,
        from: 'notfaith@legacyhotels.co.za',
      },
      copyFrom: 'faith@legacyhotels.co.za',
    },
    {
      name: 'a Centurion reply copied into Da Vinci',
      outbound: { transportId: CENTURION, transportEmail: MAILBOX, from: MAILBOX },
      copyFrom: MAILBOX,
    },
  ])('$name does not close a Da Vinci to-do', ({ name: _name, outbound, copyFrom }) =>
    withDb(async (db) => {
      await addDaVinciMailboxes(db);
      const item = await daVinciTodo(db, `negative-${copyFrom.split('@')[0]}`, '2027-10-01T08:00:00Z');
      if (outbound) {
        await propertyOutbound(
          db,
          `negative-source-${copyFrom.split('@')[0]}`,
          outbound.transportId,
          outbound.transportEmail,
          outbound.from,
          '2027-10-01T09:00:00Z',
        );
      }
      await daVinciReplyCopy(
        db,
        `negative-copy-${copyFrom.split('@')[0]}`,
        `thread-negative-${copyFrom.split('@')[0]}`,
        copyFrom,
        '2027-10-01T09:00:00Z',
        '2027-10-01T09:05:00Z',
      );

      expect(
        await refreshThreadWork(db, {
          transportId: DAVINCI,
          threadId: `thread-negative-${copyFrom.split('@')[0]}`,
        }),
      ).toEqual([]);
      expect(await replyStatus(db, item!.id)).toBe('needs_you');
    }));

  it('dismisses an older untouched request when a newer one lands on the thread', () =>
    withDb(async (db) => {
      const older = await guestMail(db, 'col-1', 'thread-col-1', '2027-10-01T08:00:00Z');
      await readOf(db, older, 'quote');
      const first = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: older });
      const newer = await guestMail(db, 'col-2', 'thread-col-1', '2027-10-01T09:00:00Z');
      await readOf(db, newer, 'quote');
      const second = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: newer });

      expect(await replyStatus(db, first!.id)).toBe('dismissed');
      expect(await eventsFor(db, first!.id)).toEqual([
        expect.objectContaining({
          actorKind: 'system',
          type: 'status.changed',
          value: expect.objectContaining({
            from: 'needs_you',
            to: 'dismissed',
            reason: 'superseded_by_thread',
            supersededBy: second!.id,
          }),
        }),
      ]);
      expect(await replyStatus(db, second!.id)).toBe('needs_you');
    }));

  it('keeps an older request she has edited when a newer one lands on the thread', () =>
    withDb(async (db) => {
      const older = await guestMail(db, 'col-3', 'thread-col-3', '2027-10-01T08:00:00Z');
      await readOf(db, older, 'quote');
      const first = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: older });
      expect(
        await recordFieldEvent(db, {
          transportId: CENTURION,
          workItemId: first!.id,
          userId: USER,
          type: 'field.edit',
          fieldPath: 'contact.phone',
          value: '+27 11 555 0100',
        }),
      ).toMatchObject({ status: 'recorded' });
      const newer = await guestMail(db, 'col-4', 'thread-col-3', '2027-10-01T09:00:00Z');
      await readOf(db, newer, 'quote');
      await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: newer });
      expect(await replyStatus(db, first!.id)).toBe('needs_you');
    }));

  it('a newer other mail never supersedes a request', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'col-5', 'thread-col-5', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const first = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      const aside = await guestMail(db, 'col-6', 'thread-col-5', '2027-10-01T09:00:00Z');
      await readOf(db, aside, 'other');
      await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: aside });
      expect(await replyStatus(db, first!.id)).toBe('needs_you');
    }));

  it('an automated booking does not supersede an untouched human-written request', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'auto-1', 'thread-auto-1', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const first = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      const notice = await guestMail(db, 'auto-2', 'thread-auto-1', '2027-10-01T09:00:00Z');
      await insertRead(db, notice, {
        version: 'extract-v1',
        kind: 'booking',
        payload: { ...payload(), origin: 'system_notice' },
      });
      const second = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: notice });

      expect(await replyStatus(db, first!.id)).toBe('needs_you');
      expect(await replyStatus(db, second!.id)).toBe('needs_you');
      const listed = await listWorkItems(db, { transportId: CENTURION, statuses: ['needs_you', 'review'], limit: 50 });
      expect(listed.map((item) => item.id)).toContain(first!.id);
      expect(listed.map((item) => item.id)).not.toContain(second!.id);
    }));

  it('a human-written booking supersedes an untouched human-written request', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'human-1', 'thread-human-1', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const first = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      const booking = await guestMail(db, 'human-2', 'thread-human-1', '2027-10-01T09:00:00Z');
      await insertRead(db, booking, {
        version: 'extract-v1',
        kind: 'booking',
        payload: { ...payload(), origin: 'person' },
      });
      const second = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: booking });

      expect(await replyStatus(db, first!.id)).toBe('dismissed');
      expect(await replyStatus(db, second!.id)).toBe('needs_you');
      const listed = await listWorkItems(db, { transportId: CENTURION, statuses: ['needs_you', 'review'], limit: 50 });
      expect(listed.map((item) => item.id)).toContain(second!.id);
      expect(listed.map((item) => item.id)).not.toContain(first!.id);
    }));

  it('a staff-sent other is done; guest other keeps needs-you status but is not listed', () =>
    withDb(async (db) => {
      await sentFromBefore(db, 'staff', STAFF);
      const staff = await guestMail(db, 'staff-1', 'thread-staff-1', '2027-10-01T08:00:00Z', STAFF);
      await readOf(db, staff, 'other');
      const staffItem = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: staff });
      expect(staffItem).toMatchObject({ status: 'done' });
      expect(await eventsFor(db, staffItem!.id)).toEqual([
        expect.objectContaining({
          actorKind: 'system',
          value: expect.objectContaining({ from: 'needs_you', to: 'done', reason: 'staff_sent_other' }),
        }),
      ]);

      const guest = await guestMail(db, 'staff-2', 'thread-staff-2', '2027-10-01T08:00:00Z');
      await readOf(db, guest, 'other');
      const guestItem = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: guest });
      expect(guestItem).toMatchObject({ status: 'needs_you' });
      const listed = await listWorkItems(db, { transportId: CENTURION, statuses: ['needs_you', 'review'], limit: 50 });
      expect(listed.map((item) => item.id)).not.toContain(guestItem!.id);
    }));

  it('a hotel reply after the request closes it, with its sent time and message', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'rp-1', 'thread-rp-1', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      const reply = await hotelMail(db, 'rp-1-out', 'thread-rp-1', '2027-10-01T09:00:00Z');

      expect(await refreshThread(db, 'thread-rp-1')).toEqual([
        expect.objectContaining({ to: 'done', reason: 'hotel_replied', sentMessageId: reply }),
      ]);
      const [closed] = await db.select().from(workItem).where(eq(workItem.id, item!.id));
      const [sent] = await db.select({ sentAt: message.sentAt }).from(message).where(eq(message.id, reply));
      expect(closed).toMatchObject({ status: 'done', sentMessageId: reply });
      expect(closed!.sentAt).toEqual(sent!.sentAt);
      expect(await eventsFor(db, item!.id)).toEqual([
        expect.objectContaining({
          actorKind: 'system',
          value: expect.objectContaining({
            from: 'needs_you',
            to: 'done',
            reason: 'hotel_replied',
            sentMessageId: reply,
          }),
        }),
      ]);

      // A request that arrives after its reply starts done.
      const late = await guestMail(db, 'rp-2', 'thread-rp-2', '2027-10-01T08:00:00Z');
      await hotelMail(db, 'rp-2-out', 'thread-rp-2', '2027-10-01T09:00:00Z');
      await readOf(db, late, 'quote');
      expect(await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: late })).toMatchObject({
        status: 'done',
      });
    }));

  it('a hotel mail sent before the request does not close it', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'early-1', 'thread-early-1', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      await hotelMail(db, 'early-1-out', 'thread-early-1', '2027-10-01T07:00:00Z');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      expect(await refreshThread(db, 'thread-early-1')).toEqual([]);
      const [row] = await db.select().from(workItem).where(eq(workItem.id, item!.id));
      expect(row).toMatchObject({ status: 'needs_you', sentMessageId: null, sentAt: null });
    }));

  it('a queued send with no sent time is not a reply', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'queued-1', 'thread-queued-1', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await hotelMail(db, 'queued-1-out', 'thread-queued-1', '2027-10-01T09:00:00Z', true);
      expect(await refreshThread(db, 'thread-queued-1')).toEqual([]);
      expect(await replyStatus(db, item!.id)).toBe('needs_you');
    }));

  it('a new guest mail reopens a closed request, and the link moves to the next hotel reply', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'reopen-1', 'thread-reopen-1', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      const first = await hotelMail(db, 'reopen-1-a', 'thread-reopen-1', '2027-10-01T09:00:00Z');
      await refreshThread(db, 'thread-reopen-1');

      // The new guest mail has no read yet; live admission still runs the thread rules on it.
      await guestMail(db, 'reopen-1-b', 'thread-reopen-1', '2027-10-01T10:00:00Z');
      expect(await refreshThread(db, 'thread-reopen-1')).toEqual([
        expect.objectContaining({ to: 'needs_you', reason: 'new_inbound', previousSentMessageId: first }),
      ]);
      expect(await replyStatus(db, item!.id)).toBe('needs_you');

      const second = await hotelMail(db, 'reopen-1-c', 'thread-reopen-1', '2027-10-01T11:00:00Z');
      await refreshThread(db, 'thread-reopen-1');
      const [row] = await db.select().from(workItem).where(eq(workItem.id, item!.id));
      expect(row).toMatchObject({ status: 'done', sentMessageId: second });
    }));

  it('a later hotel reply moves the link to it, with no new status change', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'repoint-1', 'thread-repoint-1', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await hotelMail(db, 'repoint-1-a', 'thread-repoint-1', '2027-10-01T09:00:00Z');
      await refreshThread(db, 'thread-repoint-1');
      const later = await hotelMail(db, 'repoint-1-b', 'thread-repoint-1', '2027-10-01T10:00:00Z');

      expect(await refreshThread(db, 'thread-repoint-1')).toEqual([
        expect.objectContaining({ repoint: expect.objectContaining({ sentMessageId: later }) }),
      ]);
      const [row] = await db.select().from(workItem).where(eq(workItem.id, item!.id));
      expect(row).toMatchObject({ status: 'done', sentMessageId: later });
      expect(await eventsFor(db, item!.id)).toHaveLength(1);
    }));

  it('a request she dismissed stays dismissed through a hotel reply and a newer request', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'dismiss-1', 'thread-dismiss-1', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      expect(
        await dismissWorkItem(db, { transportId: CENTURION, workItemId: item!.id, userId: USER }),
      ).toEqual({ status: 'dismissed' });

      await hotelMail(db, 'dismiss-1-out', 'thread-dismiss-1', '2027-10-01T09:00:00Z');
      expect(await refreshThread(db, 'thread-dismiss-1')).toEqual([]);
      const newer = await guestMail(db, 'dismiss-2', 'thread-dismiss-1', '2027-10-01T10:00:00Z');
      await readOf(db, newer, 'quote');
      await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: newer });
      expect(await replyStatus(db, item!.id)).toBe('dismissed');
      expect(await eventsFor(db, item!.id)).toHaveLength(1);
    }));

  it('brings a superseded request back when its read lands again and no newer request is open', () =>
    withDb(async (db) => {
      const older = await guestMail(db, 'restore-1', 'thread-restore-1', '2027-10-01T08:00:00Z');
      await readOf(db, older, 'quote');
      const first = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: older });
      const newer = await guestMail(db, 'restore-2', 'thread-restore-1', '2027-10-01T09:00:00Z');
      await readOf(db, newer, 'quote');
      const second = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: newer });
      expect(await replyStatus(db, first!.id)).toBe('dismissed');

      // She dismisses the newer request, then the older mail's read lands again with nothing newer open.
      await dismissWorkItem(db, { transportId: CENTURION, workItemId: second!.id, userId: USER });
      await readOf(db, older, 'quote', 'extract-v2');
      expect(await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: older })).toMatchObject({
        id: first!.id,
        status: 'needs_you',
      });
      expect(await replyStatus(db, second!.id)).toBe('dismissed');
      const open = await listWorkItems(db, { transportId: CENTURION, statuses: ['needs_you', 'review'], limit: 50 });
      expect(open.map((row) => row.id)).toEqual([first!.id]);
    }));
  it('a legacy done request, closed before the reply link existed, is linked to the hotel answer and reopens on a later guest mail', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'legacy-1', 'thread-legacy-1', '2027-10-01T08:00:00Z');
      // Marked done by the rules before the reply link: done, with no link and no status event.
      const [legacy] = await db
        .insert(workItem)
        .values({ transportId: CENTURION, threadId: 'thread-legacy-1', sourceMessageId: request, kind: 'quote', status: 'done' })
        .returning({ id: workItem.id });
      const answer = await hotelMail(db, 'legacy-1-out', 'thread-legacy-1', '2027-10-01T09:00:00Z');

      expect(await refreshThread(db, 'thread-legacy-1')).toEqual([
        expect.objectContaining({ repoint: expect.objectContaining({ sentMessageId: answer }) }),
      ]);
      expect(await db.select().from(workItem).where(eq(workItem.id, legacy!.id))).toMatchObject([
        { status: 'done', sentMessageId: answer, sentAt: new Date('2027-10-01T09:00:00Z') },
      ]);
      // The link records the close the rules made, the same event a hotel reply close writes, so the quote clock can use it.
      expect(await eventsFor(db, legacy!.id)).toMatchObject([
        {
          actorKind: 'system',
          type: 'status.changed',
          value: { from: 'done', to: 'done', reason: 'hotel_replied', sentMessageId: answer },
        },
      ]);

      await guestMail(db, 'legacy-2', 'thread-legacy-1', '2027-10-01T10:00:00Z');
      expect(await refreshThread(db, 'thread-legacy-1')).toEqual([
        expect.objectContaining({ to: 'needs_you', reason: 'new_inbound', previousSentMessageId: answer }),
      ]);
      expect(await replyStatus(db, legacy!.id)).toBe('needs_you');
    }));

  it('the backfill links a legacy done request to the hotel answer the rules never reached', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'legacy-bf-1', 'thread-legacy-bf-1', '2027-10-01T08:00:00Z');
      const [legacy] = await db
        .insert(workItem)
        .values({ transportId: CENTURION, threadId: 'thread-legacy-bf-1', sourceMessageId: request, kind: 'quote', status: 'done' })
        .returning({ id: workItem.id });
      const answer = await hotelMail(db, 'legacy-bf-1-out', 'thread-legacy-bf-1', '2027-10-01T09:00:00Z');

      expect(await runReplyLinkBackfill({ db, apply: true })).toMatchObject({
        threads: 1,
        changes: 1,
        byReason: { repoint: 1 },
      });
      expect(
        await db.select({ sentMessageId: workItem.sentMessageId }).from(workItem).where(eq(workItem.id, legacy!.id)),
      ).toEqual([{ sentMessageId: answer }]);
    }));

  it('a done request a person closed is never reopened or linked by a later mail', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'legacy-user-1', 'thread-legacy-user-1', '2027-10-01T08:00:00Z');
      const [closed] = await db
        .insert(workItem)
        .values({ transportId: CENTURION, threadId: 'thread-legacy-user-1', sourceMessageId: request, kind: 'quote', status: 'done' })
        .returning({ id: workItem.id });
      await db.insert(workEvent).values({
        workItemId: closed!.id,
        actorKind: 'user',
        actorUserId: USER,
        type: 'status.changed',
        value: { from: 'needs_you', to: 'done' },
      });
      await hotelMail(db, 'legacy-user-1-out', 'thread-legacy-user-1', '2027-10-01T09:00:00Z');
      await guestMail(db, 'legacy-user-2', 'thread-legacy-user-1', '2027-10-01T10:00:00Z');

      expect(await refreshThread(db, 'thread-legacy-user-1')).toEqual([]);
      expect(
        await db
          .select({ status: workItem.status, sentMessageId: workItem.sentMessageId })
          .from(workItem)
          .where(eq(workItem.id, closed!.id)),
      ).toEqual([{ status: 'done', sentMessageId: null }]);
    }));

  it('on a public mail provider only the exact mailbox address is staff; another sender on that domain is a guest', () =>
    withDb(async (db) => {
      await db.update(mailboxTransport).set({ email: 'desk@gmail.com' }).where(eq(mailboxTransport.id, CENTURION));
      await sentFromBefore(db, 'public', 'desk@gmail.com');
      const own = await guestMail(db, 'public-1', 'thread-public-1', '2027-10-01T08:00:00Z', 'desk@gmail.com');
      await readOf(db, own, 'other');
      expect(await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: own })).toMatchObject({
        status: 'done',
      });

      const stranger = await guestMail(db, 'public-2', 'thread-public-2', '2027-10-01T08:00:00Z', 'pat@gmail.com');
      await readOf(db, stranger, 'other');
      expect(await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: stranger })).toMatchObject({
        status: 'needs_you',
      });
    }));

  it('a refresh that moves a reply link waits for a live admission that reopens the item, then plans on the mail it committed', () =>
    withIngestionDb(async ({ db, url }) => {
      const request = await guestMail(db, 'race-1', 'thread-race-1', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await hotelMail(db, 'race-1-a', 'thread-race-1', '2027-10-01T09:00:00Z');
      await refreshThread(db, 'thread-race-1');
      // A newer hotel answer that the link has not moved to yet, so the refresh has a change to make.
      await hotelMail(db, 'race-1-b', 'thread-race-1', '2027-10-01T10:00:00Z');

      const connection = postgres(url, { max: 1, ssl: false, onnotice: () => undefined });
      const admission = drizzle(connection) as unknown as DB;
      let locked!: () => void;
      let release!: () => void;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      const hold = new Promise<void>((resolve) => (release = resolve));
      try {
        // Live admission: it locks the item, lands a newer guest mail, reopens the item on it, and commits.
        const landed = admission.transaction(async (tx) => {
          await tx.select({ id: workItem.id }).from(workItem).where(eq(workItem.id, item!.id)).for('update');
          locked();
          await hold;
          await guestMail(tx as unknown as DB, 'race-2', 'thread-race-1', '2027-10-01T11:00:00Z');
          await refreshThreadWork(tx as unknown as DB, { transportId: CENTURION, threadId: 'thread-race-1' });
        });
        await lockTaken;
        // The refresh starts while the item is locked. It must wait, then plan on the mail admission committed.
        const refresh = refreshThread(db, 'thread-race-1');
        await new Promise((resolve) => setTimeout(resolve, 300));
        release();
        await landed;

        expect(await refresh).toEqual([]);
        expect(await replyStatus(db, item!.id)).toBe('needs_you');
      } finally {
        await connection.end();
      }
    }));

  it('a hotel reply closes an untouched request when the copy of that reply from the hotel address lands after it', () =>
    withDb(async (db) => {
      await sentFromBefore(db, 'copy-1', STAFF);
      const request = await guestMail(db, 'copy-1', 'thread-copy-1', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      const reply = await hotelMail(db, 'copy-1-out', 'thread-copy-1', '2027-10-01T09:00:00Z');
      await staffCopy(db, 'copy-1-cc', 'thread-copy-1', '2027-10-01T09:00:00Z', '2027-10-01T09:04:00Z');

      expect(await refreshThread(db, 'thread-copy-1')).toEqual([
        expect.objectContaining({ to: 'done', reason: 'hotel_replied', sentMessageId: reply }),
      ]);
      expect(await replyStatus(db, item!.id)).toBe('done');
    }));

  it('holds HMS-touched work until the latest write has review.ok, then closes on the hotel reply', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'hms-gate-1', 'thread-hms-gate-1', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      const reply = await hotelMail(db, 'hms-gate-1-out', 'thread-hms-gate-1', '2027-10-01T09:00:00Z');
      const createdAt = new Date('2027-10-01T08:30:00Z');
      const olderRunId = 'hms-gate-run-a';
      const latestRunId = 'hms-gate-run-z';

      await db.insert(aiWorkflowRun).values(
        [olderRunId, latestRunId].map((id) => ({
          id,
          transportId: CENTURION,
          threadId: 'thread-hms-gate-1',
          triggerMessageId: request,
          runKind: 'hms_write' as const,
          idempotencyKey: `test-run:${id}`,
          modelId: NOT_APPLICABLE_MODEL_ID,
          promptVersion: HMS_JOB_PROMPT_VERSION,
          state: 'succeeded' as const,
          executorLane: 'hms' as const,
          workItemId: item!.id,
          createdAt,
          updatedAt: createdAt,
        })),
      );
      // An older review cannot clear the hold for the latest write (same created_at, higher id).
      await db.insert(workEvent).values({
        workItemId: item!.id,
        actorKind: 'user',
        actorUserId: USER,
        type: 'review.ok',
        value: { runId: olderRunId },
      });

      expect(await refreshThread(db, 'thread-hms-gate-1')).toEqual([]);
      expect(await replyStatus(db, item!.id)).toBe('needs_you');

      await db.insert(workEvent).values({
        workItemId: item!.id,
        actorKind: 'user',
        actorUserId: USER,
        type: 'review.ok',
        value: { runId: latestRunId },
      });
      expect(await refreshThread(db, 'thread-hms-gate-1')).toEqual([
        expect.objectContaining({ to: 'done', reason: 'hotel_replied', sentMessageId: reply }),
      ]);
      expect(await replyStatus(db, item!.id)).toBe('done');
    }));

  it('an ok review then a flag on the latest write keeps the hold; a later ok closes it', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'hms-gate-2', 'thread-hms-gate-2', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await hotelMail(db, 'hms-gate-2-out', 'thread-hms-gate-2', '2027-10-01T09:00:00Z');
      const createdAt = new Date('2027-10-01T08:30:00Z');
      await db.insert(aiWorkflowRun).values({
        id: 'hms-gate-run-f',
        transportId: CENTURION,
        threadId: 'thread-hms-gate-2',
        triggerMessageId: request,
        runKind: 'hms_write',
        idempotencyKey: 'test-run:hms-gate-run-f',
        modelId: NOT_APPLICABLE_MODEL_ID,
        promptVersion: HMS_JOB_PROMPT_VERSION,
        state: 'succeeded',
        executorLane: 'hms',
        workItemId: item!.id,
        createdAt,
        updatedAt: createdAt,
      });
      const review = (type: 'review.ok' | 'review.flag', at: string) =>
        db.insert(workEvent).values({
          workItemId: item!.id,
          at: new Date(at),
          actorKind: 'user',
          actorUserId: USER,
          type,
          value: { runId: 'hms-gate-run-f' },
        });
      await review('review.ok', '2027-10-01T08:40:00Z');
      await review('review.flag', '2027-10-01T08:50:00Z');

      expect(await refreshThread(db, 'thread-hms-gate-2')).toEqual([]);
      expect(await replyStatus(db, item!.id)).toBe('needs_you');

      await review('review.ok', '2027-10-01T09:05:00Z');
      expect(await refreshThread(db, 'thread-hms-gate-2')).toEqual([
        expect.objectContaining({ to: 'done', reason: 'hotel_replied' }),
      ]);
      expect(await replyStatus(db, item!.id)).toBe('done');
    }));

  it('a copy of the hotel reply from its own address is a hotel reply by itself, with its sent time', () =>
    withDb(async (db) => {
      await sentFromBefore(db, 'own-1', STAFF);
      const request = await guestMail(db, 'own-1', 'thread-own-1', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      const copy = await staffCopy(db, 'own-1-cc', 'thread-own-1', '2027-10-01T09:00:00Z', '2027-10-01T09:02:00Z');

      expect(await refreshThread(db, 'thread-own-1')).toEqual([
        expect.objectContaining({ to: 'done', reason: 'hotel_replied', sentMessageId: copy }),
      ]);
      const [closed] = await db.select().from(workItem).where(eq(workItem.id, item!.id));
      expect(closed).toMatchObject({ status: 'done', sentMessageId: copy });
      expect(closed!.sentAt).toEqual(new Date('2027-10-01T09:00:00Z'));
    }));

  it('a hotel copy that lands after the reply never reopens the request; a guest mail after it still does', () =>
    withDb(async (db) => {
      await sentFromBefore(db, 'own-2', STAFF);
      const request = await guestMail(db, 'own-2', 'thread-own-2', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      const reply = await hotelMail(db, 'own-2-out', 'thread-own-2', '2027-10-01T09:00:00Z');
      expect(await refreshThread(db, 'thread-own-2')).toEqual([expect.objectContaining({ reason: 'hotel_replied' })]);

      await staffCopy(db, 'own-2-cc', 'thread-own-2', '2027-10-01T09:00:00Z', '2027-10-01T09:04:00Z');
      expect(await refreshThread(db, 'thread-own-2')).toEqual([]);
      expect(await replyStatus(db, item!.id)).toBe('done');

      await guestMail(db, 'own-2-guest', 'thread-own-2', '2027-10-01T10:00:00Z');
      expect(await refreshThread(db, 'thread-own-2')).toEqual([
        expect.objectContaining({ to: 'needs_you', reason: 'new_inbound', previousSentMessageId: reply }),
      ]);
      expect(await replyStatus(db, item!.id)).toBe('needs_you');
    }));

  it('a history reply with no sent time closes the request by its received time', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'hist-1', 'thread-hist-1', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await db.insert(message).values({
        id: 'msg-hist-1-out',
        transportId: CENTURION,
        threadId: 'thread-hist-1',
        direction: 'outbound',
        historyOnly: true,
        fromAddress: MAILBOX,
        toAddresses: [GUEST],
        subject: 'Re: Rooms request',
        textBody: 'Quoted.',
        ownerHeaderValue: MAILBOX,
        messageIdHeader: 'hist-1-out@example.com',
        receivedAt: new Date('2027-10-01T09:00:00Z'),
        sentAt: null,
      });
      expect(await refreshThread(db, 'thread-hist-1')).toEqual([
        expect.objectContaining({ to: 'done', reason: 'hotel_replied', sentMessageId: 'msg-hist-1-out' }),
      ]);
      expect(await replyStatus(db, item!.id)).toBe('done');
    }));

  it('on a public mail provider the exact mailbox address is the hotel; another sender on that domain is still a guest', () =>
    withDb(async (db) => {
      await db.update(mailboxTransport).set({ email: 'desk@gmail.com' }).where(eq(mailboxTransport.id, CENTURION));
      await sentFromBefore(db, 'pub-1', 'desk@gmail.com');
      const request = await guestMail(db, 'pub-1', 'thread-pub-1', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await guestMail(db, 'pub-1-stranger', 'thread-pub-1', '2027-10-01T09:00:00Z', 'pat@gmail.com');
      expect(await refreshThread(db, 'thread-pub-1')).toEqual([]);

      const copy = await staffCopy(
        db,
        'pub-1-desk',
        'thread-pub-1',
        '2027-10-01T09:30:00Z',
        '2027-10-01T09:31:00Z',
        'desk@gmail.com',
      );
      expect(await refreshThread(db, 'thread-pub-1')).toEqual([
        expect.objectContaining({ to: 'done', reason: 'hotel_replied', sentMessageId: copy }),
      ]);
      expect(await replyStatus(db, item!.id)).toBe('done');
    }));

  it('an item with only pane telemetry from a person is still closed by a hotel reply', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'tel-1', 'thread-tel-1', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      expect(
        await recordPaneActions(db, {
          transportId: CENTURION,
          workItemId: item!.id,
          userId: USER,
          events: [{ type: 'pane.opened', surface: 'outlook' }],
        }),
      ).toBe('recorded');
      const reply = await hotelMail(db, 'tel-1-out', 'thread-tel-1', '2027-10-01T09:00:00Z');

      expect(await refreshThread(db, 'thread-tel-1')).toEqual([
        expect.objectContaining({ to: 'done', reason: 'hotel_replied', sentMessageId: reply }),
      ]);
      expect(await replyStatus(db, item!.id)).toBe('done');
    }));

  it('a field-edited needs-you item is closed by a hotel reply', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'tel-2', 'thread-tel-2', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      // The event alone, with no saved value, so only the event type decides whether a person touched the item.
      await db.insert(workEvent).values({
        workItemId: item!.id,
        actorKind: 'user',
        actorUserId: USER,
        type: 'field.edit',
        value: { path: 'contact.phone' },
      });
      const reply = await hotelMail(db, 'tel-2-out', 'thread-tel-2', '2027-10-01T09:00:00Z');

      expect(await refreshThread(db, 'thread-tel-2')).toEqual([
        expect.objectContaining({
          to: 'done',
          reason: 'hotel_replied',
          sentAt: expect.any(Date),
          sentMessageId: reply,
        }),
      ]);
      const [closed] = await db.select().from(workItem).where(eq(workItem.id, item!.id));
      const [sent] = await db.select({ sentAt: message.sentAt }).from(message).where(eq(message.id, reply));
      expect(closed).toMatchObject({ status: 'done', sentMessageId: reply });
      expect(closed!.sentAt).toEqual(sent!.sentAt);
      const listed = await listWorkItems(db, { transportId: CENTURION, statuses: ['needs_you', 'review'], limit: 50 });
      expect(listed.map((row) => row.id)).not.toContain(item!.id);
    }));

  it('a later guest mail reopens a field-edited item that a hotel reply closed', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'tel-6', 'thread-tel-6', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await db.insert(workEvent).values({
        workItemId: item!.id,
        actorKind: 'user',
        actorUserId: USER,
        type: 'field.edit',
        value: { path: 'contact.phone' },
      });
      const reply = await hotelMail(db, 'tel-6-out', 'thread-tel-6', '2027-10-01T09:00:00Z');
      await refreshThread(db, 'thread-tel-6');
      await guestMail(db, 'tel-6-guest', 'thread-tel-6', '2027-10-01T10:00:00Z');

      expect(await refreshThread(db, 'thread-tel-6')).toEqual([
        expect.objectContaining({ to: 'needs_you', reason: 'new_inbound', previousSentMessageId: reply }),
      ]);
      expect(await replyStatus(db, item!.id)).toBe('needs_you');
      const listed = await listWorkItems(db, { transportId: CENTURION, statuses: ['needs_you', 'review'], limit: 50 });
      expect(listed.map((row) => row.id)).toContain(item!.id);
    }));

  it('a field-edited needs-you item stays open when there is no hotel reply', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'tel-4', 'thread-tel-4', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await db.insert(workEvent).values({
        workItemId: item!.id,
        actorKind: 'user',
        actorUserId: USER,
        type: 'field.edit',
        value: { path: 'contact.phone' },
      });

      expect(await refreshThread(db, 'thread-tel-4')).toEqual([]);
      expect(await replyStatus(db, item!.id)).toBe('needs_you');
      expect(await eventsFor(db, item!.id)).toHaveLength(1);
    }));

  it('a later guest mail keeps a field-edited needs-you item open despite an earlier hotel reply', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'tel-5', 'thread-tel-5', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await db.insert(workEvent).values({
        workItemId: item!.id,
        actorKind: 'user',
        actorUserId: USER,
        type: 'field.edit',
        value: { path: 'contact.phone' },
      });
      await hotelMail(db, 'tel-5-out', 'thread-tel-5', '2027-10-01T09:00:00Z');
      await guestMail(db, 'tel-5-guest', 'thread-tel-5', '2027-10-01T10:00:00Z');

      expect(await refreshThread(db, 'thread-tel-5')).toEqual([]);
      expect(await replyStatus(db, item!.id)).toBe('needs_you');
    }));

  it('a hotel reply does not close a touched review item', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'tel-3', 'thread-tel-3', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await db.update(workItem).set({ status: 'review' }).where(eq(workItem.id, item!.id));
      await db.insert(workEvent).values({
        workItemId: item!.id,
        actorKind: 'user',
        actorUserId: USER,
        type: 'field.edit',
        value: { path: 'contact.phone' },
      });
      await hotelMail(db, 'tel-3-out', 'thread-tel-3', '2027-10-01T09:00:00Z');

      expect(await refreshThread(db, 'thread-tel-3')).toEqual([]);
      expect(await replyStatus(db, item!.id)).toBe('review');
    }));

  it('a forged mail from the hotel domain is neither a hotel reply nor a staff-sent other', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'forge-1', 'thread-forge-1', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await staffCopy(db, 'forge-1-fake', 'thread-forge-1', '2027-10-01T09:00:00Z', '2027-10-01T09:02:00Z', FORGED);
      expect(await refreshThread(db, 'thread-forge-1')).toEqual([]);
      expect(await replyStatus(db, item!.id)).toBe('needs_you');

      const forgedOther = await guestMail(db, 'forge-2', 'thread-forge-2', '2027-10-01T08:00:00Z', FORGED);
      await readOf(db, forgedOther, 'other');
      expect(await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: forgedOther })).toMatchObject({
        status: 'needs_you',
      });
    }));

  it('a copy from a hotel address the transport has sent from is a hotel reply', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'known-1', 'thread-known-1', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await sentFromBefore(db, 'known-1', STAFF);
      const copy = await staffCopy(db, 'known-1-cc', 'thread-known-1', '2027-10-01T09:00:00Z', '2027-10-01T09:02:00Z');
      expect(await refreshThread(db, 'thread-known-1')).toEqual([
        expect.objectContaining({ to: 'done', reason: 'hotel_replied', sentMessageId: copy }),
      ]);
      expect(await replyStatus(db, item!.id)).toBe('done');
    }));

  it('a sent-from address stored with a display name still matches its bare copy (C2b)', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'named-1', 'thread-named-1', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await sentFromBefore(db, 'named-1', `Ops Team <${STAFF}>`);
      const copy = await staffCopy(db, 'named-1-cc', 'thread-named-1', '2027-10-01T09:00:00Z', '2027-10-01T09:02:00Z');
      expect(await refreshThread(db, 'thread-named-1')).toEqual([
        expect.objectContaining({ to: 'done', reason: 'hotel_replied', sentMessageId: copy }),
      ]);
      expect(await replyStatus(db, item!.id)).toBe('done');
    }));

  it('a sent-from address stored with a display name matches a copy that carries one too (C2b)', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'named-2', 'thread-named-2', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await sentFromBefore(db, 'named-2', `Ops Team <${STAFF}>`);
      const copy = await staffCopy(
        db,
        'named-2-cc',
        'thread-named-2',
        '2027-10-01T09:00:00Z',
        '2027-10-01T09:02:00Z',
        `Ops Team <${STAFF}>`,
      );
      expect(await refreshThread(db, 'thread-named-2')).toEqual([
        expect.objectContaining({ to: 'done', reason: 'hotel_replied', sentMessageId: copy }),
      ]);
      expect(await replyStatus(db, item!.id)).toBe('done');
    }));

  it('an other mail from the mailbox domain, never sent from, stays closed when a guest writes (C2b)', () =>
    withDb(async (db) => {
      // #172 closed this item as staff_sent_other on the domain alone, so no outbound from its sender exists.
      // The thread's first mail is a guest's, before the copy, so the thread row exists.
      await guestMail(db, 'frozen-1-first', 'thread-frozen-1', '2027-10-01T07:00:00Z');
      const source = await staffCopy(
        db,
        'frozen-1',
        'thread-frozen-1',
        '2027-10-01T08:00:00Z',
        '2027-10-01T08:02:00Z',
        FORGED,
      );
      await readOf(db, source, 'other');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: source });
      await db.update(workItem).set({ status: 'done' }).where(eq(workItem.id, item!.id));
      await sentOnThread(db, 'frozen-1-hotel', 'thread-frozen-1', '2027-10-01T09:00:00Z');
      await guestMail(db, 'frozen-1-guest', 'thread-frozen-1', '2027-10-01T10:00:00Z');
      expect(await refreshThread(db, 'thread-frozen-1')).toEqual([]);
      expect(await replyStatus(db, item!.id)).toBe('done');
    }));

  it('a newer request on the thread does not dismiss such an other mail (C2b)', () =>
    withDb(async (db) => {
      // The thread's first mail is a guest's, before the copy, so the thread row exists.
      await guestMail(db, 'frozen-2-first', 'thread-frozen-2', '2027-10-01T07:00:00Z');
      const source = await staffCopy(
        db,
        'frozen-2',
        'thread-frozen-2',
        '2027-10-01T08:00:00Z',
        '2027-10-01T08:02:00Z',
        FORGED,
      );
      await readOf(db, source, 'other');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: source });
      await db.update(workItem).set({ status: 'done' }).where(eq(workItem.id, item!.id));
      await sentOnThread(db, 'frozen-2-hotel', 'thread-frozen-2', '2027-10-01T09:00:00Z');
      const request = await guestMail(db, 'frozen-2-request', 'thread-frozen-2', '2027-10-01T10:00:00Z');
      await readOf(db, request, 'quote');
      await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      expect(await refreshThread(db, 'thread-frozen-2')).toEqual([]);
      expect(await replyStatus(db, item!.id)).toBe('done');
    }));

  it('a hotel answer does not re-link such an other mail (C2b)', () =>
    withDb(async (db) => {
      // The thread's first mail is a guest's, before the copy, so the thread row exists.
      await guestMail(db, 'frozen-3-first', 'thread-frozen-3', '2027-10-01T07:00:00Z');
      const source = await staffCopy(
        db,
        'frozen-3',
        'thread-frozen-3',
        '2027-10-01T08:00:00Z',
        '2027-10-01T08:02:00Z',
        FORGED,
      );
      await readOf(db, source, 'other');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: source });
      await db.update(workItem).set({ status: 'done' }).where(eq(workItem.id, item!.id));
      await sentOnThread(db, 'frozen-3-hotel', 'thread-frozen-3', '2027-10-01T09:00:00Z');
      expect(await refreshThread(db, 'thread-frozen-3')).toEqual([]);
      const [row] = await db
        .select({ sentMessageId: workItem.sentMessageId })
        .from(workItem)
        .where(eq(workItem.id, item!.id));
      expect(row?.sentMessageId).toBeNull();
    }));
});

/** A reply the transport sent from its own address on a thread: the hotel's mail to the planner. */
async function sentOnThread(db: DB, id: string, threadId: string, sentAt: string): Promise<void> {
  await db.insert(message).values({
    id: `msg-${id}`,
    transportId: CENTURION,
    threadId,
    direction: 'outbound',
    fromAddress: STAFF,
    toAddresses: [GUEST],
    subject: 'Re: Rooms request',
    textBody: 'Our reply.',
    ownerHeaderValue: MAILBOX,
    messageIdHeader: `${id}@example.com`,
    sentAt: new Date(sentAt),
  });
}

describe('reply link backfill (C2, C3)', () => {
  it('is a dry run unless --apply is passed', () => {
    expect(parseReplyLinkArgs([])).toEqual({ apply: false, help: false });
    expect(parseReplyLinkArgs(['--apply', '--transport-id', CENTURION])).toEqual({
      apply: true,
      help: false,
      transportId: CENTURION,
    });
    expect(() => parseReplyLinkArgs(['--write'])).toThrow();
  });

  it('a dry run counts the changes and writes nothing; apply writes them once', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'backfill-1', 'thread-backfill-1', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      // The reply is stored without the rules running on it, as a row from before the change would be.
      await hotelMail(db, 'backfill-1-out', 'thread-backfill-1', '2027-10-01T09:00:00Z');

      expect(await runReplyLinkBackfill({ db, apply: false })).toEqual({
        apply: false,
        threads: 1,
        changes: 1,
        byKind: { quote: 1 },
        byReason: { hotel_replied: 1 },
      });
      expect(await replyStatus(db, item!.id)).toBe('needs_you');
      expect(await eventsFor(db, item!.id)).toEqual([]);

      expect(await runReplyLinkBackfill({ db, apply: true })).toEqual({
        apply: true,
        threads: 1,
        changes: 1,
        byKind: { quote: 1 },
        byReason: { hotel_replied: 1 },
      });
      expect(await replyStatus(db, item!.id)).toBe('done');
      expect(await eventsFor(db, item!.id)).toHaveLength(1);

      // A second apply still lists the thread, with nothing left to change.
      expect(await runReplyLinkBackfill({ db, apply: true })).toEqual({
        apply: true,
        threads: 1,
        changes: 0,
        byKind: {},
        byReason: {},
      });
      expect(await eventsFor(db, item!.id)).toHaveLength(1);
    }));
});

describe('reply link backfill: hotel copies, guest reopens, person touches (C2b)', () => {
  it('the dry run counts each seeded thread outcome, including an answer to a person-touched item; a second apply plans nothing', () =>
    withDb(async (db) => {
      await sentFromBefore(db, 'bf', STAFF);
      // The hotel's copy alone answers the request.
      const copyOnly = await guestMail(db, 'bf-copy', 'thread-bf-copy', '2027-10-01T08:00:00Z');
      await readOf(db, copyOnly, 'quote');
      const copyItem = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: copyOnly });
      await staffCopy(db, 'bf-copy-cc', 'thread-bf-copy', '2027-10-01T09:00:00Z', '2027-10-01T09:04:00Z');

      // The reply and its copy close the request once, on the reply.
      const both = await guestMail(db, 'bf-both', 'thread-bf-both', '2027-10-01T08:00:00Z');
      await readOf(db, both, 'quote');
      const bothItem = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: both });
      await hotelMail(db, 'bf-both-out', 'thread-bf-both', '2027-10-01T09:00:00Z');
      await staffCopy(db, 'bf-both-cc', 'thread-bf-both', '2027-10-01T09:00:00Z', '2027-10-01T09:04:00Z');

      // A legacy done request, closed by the copy, and a guest mail after it reopens it.
      const reopen = await guestMail(db, 'bf-reopen', 'thread-bf-reopen', '2027-10-01T08:00:00Z');
      const [reopenItem] = await db
        .insert(workItem)
        .values({
          transportId: CENTURION,
          threadId: 'thread-bf-reopen',
          sourceMessageId: reopen,
          kind: 'quote',
          status: 'done',
        })
        .returning({ id: workItem.id });
      await staffCopy(db, 'bf-reopen-cc', 'thread-bf-reopen', '2027-10-01T09:00:00Z', '2027-10-01T09:04:00Z');
      await guestMail(db, 'bf-reopen-guest', 'thread-bf-reopen', '2027-10-01T10:00:00Z');

      // A person edited the request, but the hotel's later answer still closes it.
      const touched = await guestMail(db, 'bf-touched', 'thread-bf-touched', '2027-10-01T08:00:00Z');
      await readOf(db, touched, 'quote');
      const touchedItem = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: touched });
      expect(
        await recordFieldEvent(db, {
          transportId: CENTURION,
          workItemId: touchedItem!.id,
          userId: USER,
          type: 'field.edit',
          fieldPath: 'contact.phone',
          value: '+27 11 555 0100',
        }),
      ).toMatchObject({ status: 'recorded' });
      await staffCopy(db, 'bf-touched-cc', 'thread-bf-touched', '2027-10-01T09:00:00Z', '2027-10-01T09:04:00Z');

      const counted = {
        threads: 4,
        changes: 4,
        byKind: { quote: 4 },
        byReason: { hotel_replied: 3, new_inbound: 1 },
      };
      expect(await runReplyLinkBackfill({ db, apply: false })).toEqual({ apply: false, ...counted });
      expect(await replyStatus(db, copyItem!.id)).toBe('needs_you');
      expect(await replyStatus(db, touchedItem!.id)).toBe('needs_you');

      expect(await runReplyLinkBackfill({ db, apply: true })).toEqual({ apply: true, ...counted });
      expect(
        await db
          .select({ status: workItem.status, sentMessageId: workItem.sentMessageId })
          .from(workItem)
          .where(eq(workItem.id, copyItem!.id)),
      ).toEqual([{ status: 'done', sentMessageId: 'msg-bf-copy-cc' }]);
      expect(
        await db
          .select({ status: workItem.status, sentMessageId: workItem.sentMessageId })
          .from(workItem)
          .where(eq(workItem.id, bothItem!.id)),
      ).toEqual([{ status: 'done', sentMessageId: 'msg-bf-both-out' }]);
      expect(
        await db
          .select({ status: workItem.status, sentMessageId: workItem.sentMessageId })
          .from(workItem)
          .where(eq(workItem.id, reopenItem!.id)),
      ).toEqual([{ status: 'needs_you', sentMessageId: null }]);
      expect(
        await db
          .select({ status: workItem.status, sentAt: workItem.sentAt, sentMessageId: workItem.sentMessageId })
          .from(workItem)
          .where(eq(workItem.id, touchedItem!.id)),
      ).toEqual([
        {
          status: 'done',
          sentAt: new Date('2027-10-01T09:00:00Z'),
          sentMessageId: 'msg-bf-touched-cc',
        },
      ]);
      expect(await eventsFor(db, touchedItem!.id)).toHaveLength(2);

      // A second apply still lists the four threads, with nothing left to change.
      expect(await runReplyLinkBackfill({ db, apply: true })).toEqual({
        apply: true,
        threads: 4,
        changes: 0,
        byKind: {},
        byReason: {},
      });
    }));
});

describe('trusted POP3 delivery clock (KTD-1)', () => {
  async function setPop3Clock(
    db: DB,
    id: string,
    clock: {
      receivedAt: string | null;
      createdAt: string;
      deliveredAt?: string;
      outlookSynced?: boolean;
    },
  ): Promise<void> {
    const sourceProvenance = {
      ...(clock.outlookSynced ? { canonicalContentVersion: 'fixture-v1' } : {}),
      ...(clock.deliveredAt ? { deliveredAt: new Date(clock.deliveredAt).toISOString() } : {}),
    };
    await db
      .update(message)
      .set({
        pop3Uidl: `uidl-${id}`,
        receivedAt: clock.receivedAt ? new Date(clock.receivedAt) : null,
        createdAt: new Date(clock.createdAt),
        sourceProvenance: Object.keys(sourceProvenance).length > 0 ? sourceProvenance : null,
      })
      .where(eq(message.id, `msg-${id}`));
  }

  it('persists the parsed top Received date in sourceProvenance during POP3 ingest', () =>
    withDb(async (db) => {
      const { parseRawMessage } = await import('../src/mail/ingest/parse-message.js');
      const { persistInboundMessage } = await import('../src/mail/ingest/store.js');
      const { FakeS3Storage } = await import('../src/storage/s3.js');
      const raw = Buffer.from(
        [
          'Received: from first-hop.example by mailbox.example; Tue, 06 Oct 2026 10:00:00 +0000',
          'Received: from earlier-hop.example by first-hop.example; Tue, 06 Oct 2026 08:00:00 +0000',
          `X-Zero-Mailbox: ${MAILBOX}`,
          'From: guest@example.test',
          `To: ${MAILBOX}`,
          'Date: Tue, 06 Oct 2026 07:00:00 +0000',
          'Message-ID: delivered-at-store@example.test',
          'Subject: delivery timestamp persistence',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'Please quote.',
        ].join('\r\n'),
      );
      const storage = new FakeS3Storage('work-items-delivered-at-test');
      const messageId = 'msg-delivered-at-store';
      const parsed = await parseRawMessage(raw, { messageId, storage });
      const stored = await persistInboundMessage(
        parsed,
        raw,
        { ingestMailboxId: 'ingest-nava-legacy', pop3Uidl: 'uidl-delivered-at-store', messageId },
        { db, storage, skipAiEnqueue: true },
      );
      if (stored.kind !== 'stored') throw new Error(`expected stored, got ${stored.kind}`);
      const [row] = await db.select().from(message).where(eq(message.id, messageId));

      expect(row?.sourceProvenance).toEqual({
        deliveredAt: '2026-10-06T10:00:00.000Z',
        stampRoute: 'stamp_corroborated',
      });
      expect(row?.receivedAt).toEqual(new Date('2026-10-06T07:00:00.000Z'));
    }));

  it('closes a POP3 request on a valid top Received time before the reply, despite later import', () =>
    withDb(async (db) => {
      const threadId = 'thread-delivered-before-reply';
      const request = await guestMail(db, 'delivered-before-reply', threadId, '2027-10-01T09:30:00Z');
      await setPop3Clock(db, 'delivered-before-reply', {
        receivedAt: '2027-10-01T09:30:00Z',
        createdAt: '2027-10-01T10:00:00Z',
        deliveredAt: '2027-10-01T08:00:00Z',
      });
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      const reply = await hotelMail(db, 'delivered-before-reply-out', threadId, '2027-10-01T09:00:00Z');

      expect(await refreshThread(db, threadId)).toEqual([
        expect.objectContaining({
          workItemId: item!.id,
          to: 'done',
          reason: 'hotel_replied',
          sentMessageId: reply,
        }),
      ]);
    }));

  it('falls back to createdAt when POP3 has no deliveredAt, preserving the #157 guard', () =>
    withDb(async (db) => {
      const threadId = 'thread-no-delivered-at';
      const request = await guestMail(db, 'no-delivered-at', threadId, '2027-10-01T08:00:00Z');
      await setPop3Clock(db, 'no-delivered-at', {
        receivedAt: '2027-10-01T08:00:00Z',
        createdAt: '2027-10-01T10:00:00Z',
      });
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await hotelMail(db, 'no-delivered-at-out', threadId, '2027-10-01T09:00:00Z');

      expect(await refreshThread(db, threadId)).toEqual([]);
      expect(await replyStatus(db, item!.id)).toBe('needs_you');
    }));

  it('does not use the sender Date header when trusted delivery followed the reply', () =>
    withDb(async (db) => {
      const threadId = 'thread-delivered-after-reply';
      const request = await guestMail(db, 'delivered-after-reply', threadId, '2027-10-01T08:00:00Z');
      await setPop3Clock(db, 'delivered-after-reply', {
        receivedAt: '2027-10-01T08:00:00Z',
        createdAt: '2027-10-01T08:58:00Z',
        deliveredAt: '2027-10-01T09:01:00Z',
      });
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await hotelMail(db, 'delivered-after-reply-out', threadId, '2027-10-01T09:00:00Z');

      expect(await refreshThread(db, threadId)).toEqual([]);
      expect(await replyStatus(db, item!.id)).toBe('needs_you');
    }));

  it('ignores a deliveredAt more than five minutes after createdAt', () =>
    withDb(async (db) => {
      const threadId = 'thread-delivered-too-future';
      const request = await guestMail(db, 'delivered-too-future', threadId, '2027-10-01T08:30:00Z');
      await setPop3Clock(db, 'delivered-too-future', {
        receivedAt: '2027-10-01T08:30:00Z',
        createdAt: '2027-10-01T08:00:00Z',
        deliveredAt: '2027-10-01T10:00:00Z',
      });
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await hotelMail(db, 'delivered-too-future-out', threadId, '2027-10-01T09:00:00Z');

      expect(await refreshThread(db, threadId)).toEqual([
        expect.objectContaining({ workItemId: item!.id, to: 'done', reason: 'hotel_replied' }),
      ]);
    }));

  it('ignores a deliveredAt more than thirty days before createdAt', () =>
    withDb(async (db) => {
      const threadId = 'thread-delivered-too-old';
      const request = await guestMail(db, 'delivered-too-old', threadId, '2027-08-22T08:00:00Z');
      await setPop3Clock(db, 'delivered-too-old', {
        receivedAt: '2027-08-22T08:00:00Z',
        createdAt: '2027-10-01T10:00:00Z',
        deliveredAt: '2027-08-22T08:00:00Z',
      });
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await hotelMail(db, 'delivered-too-old-out', threadId, '2027-09-01T09:00:00Z');

      expect(await refreshThread(db, threadId)).toEqual([]);
      expect(await replyStatus(db, item!.id)).toBe('needs_you');
    }));

  it('keeps a request open when its follow-up delivery overtakes the reply', () =>
    withDb(async (db) => {
      const threadId = 'thread-delivered-follow-up';
      const request = await guestMail(db, 'delivered-follow-up-request', threadId, '2027-10-01T07:00:00Z');
      await setPop3Clock(db, 'delivered-follow-up-request', {
        receivedAt: '2027-10-01T07:00:00Z',
        createdAt: '2027-10-01T07:30:00Z',
        deliveredAt: '2027-10-01T08:00:00Z',
      });
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await hotelMail(db, 'delivered-follow-up-out', threadId, '2027-10-01T09:00:00Z');

      const followUp = await guestMail(db, 'delivered-follow-up', threadId, '2027-10-01T08:30:00Z');
      await setPop3Clock(db, 'delivered-follow-up', {
        receivedAt: '2027-10-01T08:30:00Z',
        createdAt: '2027-10-01T08:58:00Z',
        deliveredAt: '2027-10-01T09:01:00Z',
      });

      expect(await refreshThread(db, threadId)).toEqual([]);
      expect(await replyStatus(db, item!.id)).toBe('needs_you');
      expect(followUp).toBe('msg-delivered-follow-up');
    }));

  it('keeps the Outlook-synced receivedAt rule when POP3 later matches the row', () =>
    withDb(async (db) => {
      const threadId = 'thread-outlook-delivered-at';
      const request = await guestMail(db, 'outlook-delivered-at', threadId, '2027-10-01T10:00:00Z');
      await setPop3Clock(db, 'outlook-delivered-at', {
        receivedAt: '2027-10-01T08:00:00Z',
        createdAt: '2027-10-01T10:30:00Z',
        deliveredAt: '2027-10-01T09:30:00Z',
        outlookSynced: true,
      });
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      const reply = await hotelMail(db, 'outlook-delivered-at-out', threadId, '2027-10-01T09:00:00Z');

      expect(await refreshThread(db, threadId)).toEqual([
        expect.objectContaining({
          workItemId: item!.id,
          to: 'done',
          reason: 'hotel_replied',
          sentMessageId: reply,
        }),
      ]);
      expect(await replyStatus(db, item!.id)).toBe('done');
    }));

  it('does not close on a tie and repeats idempotently', () =>
    withDb(async (db) => {
      const threadId = 'thread-delivered-at-tie';
      const request = await guestMail(db, 'delivered-at-tie', threadId, '2027-10-01T08:00:00Z');
      await setPop3Clock(db, 'delivered-at-tie', {
        receivedAt: '2027-10-01T08:00:00Z',
        createdAt: '2027-10-01T10:00:00Z',
        deliveredAt: '2027-10-01T09:00:00Z',
      });
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await hotelMail(db, 'delivered-at-tie-out', threadId, '2027-10-01T09:00:00Z');

      expect(await refreshThread(db, threadId)).toEqual([]);
      expect(await refreshThread(db, threadId)).toEqual([]);
      expect(await replyStatus(db, item!.id)).toBe('needs_you');
    }));
});

describe('thread work: reply re-check enqueue', () => {
  async function replyCheckRuns(db: DB, workItemId: string) {
    return db
      .select({
        idempotencyKey: aiWorkflowRun.idempotencyKey,
        triggerMessageId: aiWorkflowRun.triggerMessageId,
        modelId: aiWorkflowRun.modelId,
        runKind: aiWorkflowRun.runKind,
      })
      .from(aiWorkflowRun)
      .where(and(eq(aiWorkflowRun.workItemId, workItemId), eq(aiWorkflowRun.runKind, 'reply_check')));
  }

  function withRecheck<T>(mode: string, run: () => Promise<T>): Promise<T> {
    const previous = process.env.REPLY_RECHECK;
    process.env.REPLY_RECHECK = mode;
    return run().finally(() => {
      if (previous === undefined) delete process.env.REPLY_RECHECK;
      else process.env.REPLY_RECHECK = previous;
    });
  }

  it('a hotel_replied close enqueues reply_check when REPLY_RECHECK is shadow', () =>
    withRecheck('shadow', () =>
      withDb(async (db) => {
        const request = await guestMail(db, 'rc-1', 'thread-rc-1', '2027-10-01T08:00:00Z');
        await readOf(db, request, 'quote');
        const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
        const reply = await hotelMail(db, 'rc-1-out', 'thread-rc-1', '2027-10-01T09:00:00Z');
        expect(await refreshThread(db, 'thread-rc-1')).toEqual([
          expect.objectContaining({ to: 'done', reason: 'hotel_replied', sentMessageId: reply }),
        ]);
        expect(await replyCheckRuns(db, item!.id)).toEqual([
          expect.objectContaining({
            runKind: 'reply_check',
            triggerMessageId: reply,
            modelId: 'gpt-6-luna',
            idempotencyKey: `reply-check:${item!.id}:${reply}`,
          }),
        ]);
      }),
    ));

  it('off does not enqueue', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'rc-off', 'thread-rc-off', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await hotelMail(db, 'rc-off-out', 'thread-rc-off', '2027-10-01T09:00:00Z');
      await refreshThread(db, 'thread-rc-off');
      expect(await replyCheckRuns(db, item!.id)).toEqual([]);
    }));

  it('a newer hotel reply enqueues a second key', () =>
    withRecheck('shadow', () =>
      withDb(async (db) => {
        const request = await guestMail(db, 'rc-2', 'thread-rc-2', '2027-10-01T08:00:00Z');
        await readOf(db, request, 'quote');
        const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
        const first = await hotelMail(db, 'rc-2-out', 'thread-rc-2', '2027-10-01T09:00:00Z');
        await refreshThread(db, 'thread-rc-2');
        const second = await hotelMail(db, 'rc-2-out-2', 'thread-rc-2', '2027-10-01T10:00:00Z');
        await refreshThread(db, 'thread-rc-2');
        const keys = (await replyCheckRuns(db, item!.id)).map((row) => row.idempotencyKey).sort();
        expect(keys).toEqual([
          `reply-check:${item!.id}:${first}`,
          `reply-check:${item!.id}:${second}`,
        ].sort());
      }),
    ));

  it('a Centurion close never enqueues on a Da Vinci to-do', () =>
    withRecheck('shadow', () =>
      withDb(async (db) => {
        await addDaVinciMailboxes(db);
        const dv = await daVinciTodo(db, 'rc-dv', '2027-10-01T08:00:00Z');
        const request = await guestMail(db, 'rc-cen', 'thread-rc-cen', '2027-10-01T08:00:00Z');
        await readOf(db, request, 'quote');
        await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
        await hotelMail(db, 'rc-cen-out', 'thread-rc-cen', '2027-10-01T09:00:00Z');
        await refreshThread(db, 'thread-rc-cen');
        expect(await replyCheckRuns(db, dv!.id)).toEqual([]);
      }),
    ));

  it('lists the one-line reopen reason on a needs-you row', () =>
    withDb(async (db) => {
      const request = await guestMail(db, 'rc-reason', 'thread-rc-reason', '2027-10-01T08:00:00Z');
      await readOf(db, request, 'quote');
      const item = await ensureWorkItemForMessage(db, { transportId: CENTURION, messageId: request });
      await db.insert(workEvent).values({
        workItemId: item!.id,
        actorKind: 'system',
        type: 'status.changed',
        value: {
          from: 'done',
          to: 'needs_you',
          reason: 'reply_needs_action',
          reasonLine: "said they'd come back with rates",
        },
      });
      const [row] = await listWorkItems(db, {
        transportId: CENTURION,
        statuses: ['needs_you'],
        limit: 10,
      });
      expect(row).toMatchObject({
        id: item!.id,
        reopenReason: "said they'd come back with rates",
      });
    }));
});

describe('stay commit records on the work item', () => {
  const shot = { runId: '11111111-2222-3333-4444-555555555555', name: 'saved.png' };

  it('saves the confirmation into state.stays and reads it back on reopen', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'stay-commit-1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'stay-commit-1');
      expect(work.stays).toEqual({});
      expect(
        await recordStayCommit(db, {
          transportId: CENTURION,
          workItemId: work.workItemId,
          stayId: STAY_ONE,
          record: { confirmationNumber: '46184891-1', status: 'booked', screenshotRef: shot },
        }),
      ).toEqual({ status: 'recorded' });
      const reopened = await readyWork(db, 'stay-commit-1');
      expect(reopened.stays[STAY_ONE]).toEqual({
        confirmationNumber: '46184891-1',
        status: 'booked',
        screenshotRef: shot,
      });
      expect(stayCommitGuard(reopened.stays[STAY_ONE])).toEqual({
        action: 'refuse',
        reason: PANE_STAY_ALREADY_BOOKED,
      });
      const [row] = await db.select({ state: workItem.state }).from(workItem).where(eq(workItem.id, work.workItemId));
      expect((row!.state as { stays?: unknown }).stays).toEqual({
        [STAY_ONE]: { confirmationNumber: '46184891-1', status: 'booked', screenshotRef: shot },
      });
    }));

  it('refuses to replace a stay that already has a confirmation number', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'stay-commit-2');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'stay-commit-2');
      await recordStayCommit(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        stayId: STAY_ONE,
        record: { confirmationNumber: '46184891-1', status: 'booked', screenshotRef: shot },
      });
      expect(
        await recordStayCommit(db, {
          transportId: CENTURION,
          workItemId: work.workItemId,
          stayId: STAY_ONE,
          record: { confirmationNumber: '99999999-1', status: 'booked', screenshotRef: null },
        }),
      ).toEqual({ status: 'already_booked' });
      const reopened = await readyWork(db, 'stay-commit-2');
      expect(reopened.stays[STAY_ONE]?.confirmationNumber).toBe('46184891-1');
    }));

  it('an unknown outcome is stored so the next commit reads HMS first', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'stay-commit-3');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'stay-commit-3');
      await recordStayCommit(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        stayId: STAY_ONE,
        record: { confirmationNumber: null, status: 'unknown', screenshotRef: shot },
      });
      const reopened = await readyWork(db, 'stay-commit-3');
      expect(reopened.stays[STAY_ONE]?.status).toBe('unknown');
      expect(stayCommitGuard(reopened.stays[STAY_ONE])).toEqual({ action: 'read_hms' });
      expect(
        await recordStayCommit(db, {
          transportId: CENTURION,
          workItemId: work.workItemId,
          stayId: STAY_ONE,
          record: { confirmationNumber: '46184891-1', status: 'booked', screenshotRef: shot },
        }),
      ).toEqual({ status: 'recorded' });
      expect((await readyWork(db, 'stay-commit-3')).stays[STAY_ONE]?.confirmationNumber).toBe('46184891-1');
    }));

  it('keeps a field edit when a stay commit is saved next to it', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'stay-commit-4');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'stay-commit-4');
      await recordFieldEvent(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        userId: USER,
        type: 'field.edit',
        fieldPath: `stays[${STAY_ONE}].requested.arrival`,
        value: '2027-10-25',
      });
      await recordStayCommit(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        stayId: STAY_ONE,
        record: { confirmationNumber: '46184891-1', status: 'booked', screenshotRef: shot },
      });
      const reopened = await readyWork(db, 'stay-commit-4');
      expect(reopened.stays[STAY_ONE]?.confirmationNumber).toBe('46184891-1');
      expect(reopened.analysis.groups.find((group) => group.stayId === STAY_ONE)?.arrivalDate).toBe('2027-10-25');
    }));
});

describe('saved stay picks for later amend/cancel', () => {
  const shot = { runId: '11111111-2222-3333-4444-555555555555', name: 'saved.png' };
  const bookedOne = {
    confirmationNumber: '46184891-1',
    status: 'booked' as const,
    screenshotRef: shot,
  };
  const bookedTwo = {
    confirmationNumber: '57291630-1',
    status: 'booked' as const,
    screenshotRef: null,
  };

  it('lists only stays that already have a confirmation number', () => {
    const state = withStayCommit(
      withStayCommit({}, STAY_ONE, bookedOne),
      STAY_TWO,
      { confirmationNumber: null, status: 'unknown', screenshotRef: shot },
    );
    expect(savedStayPicksOf(state)).toEqual([
      { stayId: STAY_ONE, confirmationNumber: '46184891-1', status: 'booked' },
    ]);
  });

  it('picks the named stay, the only saved confirmation, or nothing until staff choose', () => {
    const one = savedStayPicksOf(withStayCommit({}, STAY_ONE, bookedOne));
    const two = savedStayPicksOf(
      withStayCommit(withStayCommit({}, STAY_ONE, bookedOne), STAY_TWO, bookedTwo),
    );
    expect(pickSavedStay(one, null)).toEqual({
      stayId: STAY_ONE,
      confirmationNumber: '46184891-1',
      status: 'booked',
    });
    expect(pickSavedStay(two, null)).toBeNull();
    expect(pickSavedStay(two, STAY_TWO)).toEqual({
      stayId: STAY_TWO,
      confirmationNumber: '57291630-1',
      status: 'booked',
    });
    expect(pickSavedStay(two, 's_missing1')).toBeNull();
    expect(pickSavedStay([], STAY_ONE)).toBeNull();
  });

  it('round-trips stay commit shots and runId next to screenshotRef', () => {
    const record = {
      confirmationNumber: '46184891-1',
      status: 'booked' as const,
      screenshotRef: shot,
      runId: shot.runId,
      shots: [
        {
          name: 'before.png',
          sha256: 'a'.repeat(64),
          at: '2026-10-26T00:00:00.000Z',
        },
        { name: 'saved.png', sha256: 'b'.repeat(64), at: '2026-10-26T00:00:01.000Z' },
      ],
    };
    expect(stayCommitOf(withStayCommit({}, STAY_ONE, record), STAY_ONE)).toEqual(record);
    expect(stayCommitOf(withStayCommit({}, STAY_ONE, bookedOne), STAY_ONE)).toEqual(bookedOne);
  });

  it('stores an amend/cancel result on the chosen stay and leaves the other stay as it is', () => {
    const before = withStayCommit(withStayCommit({}, STAY_ONE, bookedOne), STAY_TWO, bookedTwo);
    const after = withStayActionResult(before, STAY_TWO, {
      confirmationNumber: '57291630-1',
      screenshotRef: shot,
    });
    expect(stayCommitOf(after, STAY_ONE)).toEqual(bookedOne);
    expect(stayCommitOf(after, STAY_TWO)).toEqual({
      confirmationNumber: '57291630-1',
      status: 'booked',
      screenshotRef: shot,
    });
  });

  it('writes the action onto a stay that already has a confirmation, without touching the sibling', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'stay-action-1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'stay-action-1');
      await recordStayCommit(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        stayId: STAY_ONE,
        record: bookedOne,
      });
      await recordStayCommit(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        stayId: STAY_TWO,
        record: bookedTwo,
      });
      expect(
        await recordStayActionResult(db, {
          transportId: CENTURION,
          workItemId: work.workItemId,
          stayId: STAY_TWO,
          confirmationNumber: '57291630-1',
          screenshotRef: shot,
        }),
      ).toEqual({ status: 'recorded' });
      const reopened = await readyWork(db, 'stay-action-1');
      expect(reopened.stays[STAY_ONE]).toEqual(bookedOne);
      expect(reopened.stays[STAY_TWO]).toEqual({
        confirmationNumber: '57291630-1',
        status: 'booked',
        screenshotRef: shot,
      });
    }));
});

describe('pane revision undo/redo', () => {
  it('undo then redo restores values and appends two events', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'rev-undo-1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'rev-undo-1');
      const booked = {
        confirmationNumber: '46184891-1',
        status: 'booked' as const,
        screenshotRef: { runId: '11111111-2222-3333-4444-555555555555', name: 'saved.png' },
      };
      await recordStayCommit(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        stayId: STAY_ONE,
        record: booked,
      });
      const path = `stays[${STAY_ONE}].requested.arrival`;
      await recordFieldEvent(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        userId: USER,
        type: 'field.edit',
        fieldPath: path,
        value: '2027-10-25',
      });
      const before = await eventsFor(db, work.workItemId);
      const edit = before.find((event) => event.type === 'field.edit');
      expect(edit).toMatchObject({ type: 'field.edit', value: '2027-10-25' });

      const snapshot = { digest: 'lab', readAt: '2027-01-01T00:00:00.000Z' };
      const [row] = await db
        .select({ state: workItem.state })
        .from(workItem)
        .where(eq(workItem.id, work.workItemId))
        .limit(1);
      await db
        .update(workItem)
        .set({ state: { ...row!.state, hmsSnapshot: snapshot } })
        .where(eq(workItem.id, work.workItemId));

      const undone = await undoWorkItemRevision(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        userId: USER,
        expectedSeq: 1,
      });
      expect(undone).toMatchObject({ status: 'applied', revision: 0, revisionHead: 1, seq: 2 });
      const afterUndo = await readyWork(db, 'rev-undo-1');
      expect(afterUndo.analysis.groups[0]!.arrivalDate).toBe('2027-10-26');
      expect(afterUndo.stays[STAY_ONE]).toEqual(booked);
      expect(
        (
          await db
            .select({ state: workItem.state })
            .from(workItem)
            .where(eq(workItem.id, work.workItemId))
            .limit(1)
        )[0]?.state.hmsSnapshot,
      ).toEqual(snapshot);

      const redone = await redoWorkItemRevision(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        userId: USER,
        expectedSeq: 2,
      });
      expect(redone).toMatchObject({ status: 'applied', revision: 1, revisionHead: 1, seq: 3 });
      const afterRedo = await readyWork(db, 'rev-undo-1');
      expect(afterRedo.analysis.groups[0]!.arrivalDate).toBe('2027-10-25');
      expect(afterRedo.stays[STAY_ONE]).toEqual(booked);

      const events = await eventsFor(db, work.workItemId);
      expect(events.filter((event) => event.type === 'history.undo')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'history.redo')).toHaveLength(1);
      expect(events.find((event) => event.id === edit!.id)).toMatchObject({
        type: 'field.edit',
        value: '2027-10-25',
        fieldPath: path,
      });

      const stale = await undoWorkItemRevision(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        userId: USER,
        expectedSeq: 0,
      });
      expect(stale).toMatchObject({ status: 'stale', revision: 1, revisionHead: 1, seq: 3 });
      expect(await eventsFor(db, work.workItemId)).toHaveLength(events.length);
    }));

  it('undo then relink then redo rejects history_stale and leaves state unchanged', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'rev-stale-1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'rev-stale-1');
      const path = `stays[${STAY_ONE}].requested.arrival`;
      await recordFieldEvent(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        userId: USER,
        type: 'field.edit',
        fieldPath: path,
        value: '2027-10-25',
      });
      const undone = await undoWorkItemRevision(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        userId: USER,
        expectedSeq: 1,
      });
      expect(undone).toMatchObject({ status: 'applied', revision: 0, revisionHead: 1, seq: 2 });

      const relinked: MailExtractionPayload = {
        ...payload(),
        stays: [
          payload().stays[1]!,
          {
            id: STAY_ONE,
            hotel: 'Grand Hotel',
            requested: { arrival: '2027-12-01', departure: '2027-12-03' },
            booked: null,
            totalRooms: null,
            rows: [
              { id: 'r_dec_reused', roomType: 'Double/Twin', rooms: 4, adultsPerRoom: 2, childAges: [], board: null },
            ],
          },
        ],
      };
      const second = await insertRead(db, messageId, { version: 'extract-v2', payload: relinked });
      const moved = await ensureWorkItem(db, {
        transportId: CENTURION,
        threadId: 'thread-rev-stale-1',
        messageId,
        kind: 'quote',
        extractionId: second,
      });
      expect(moved.extractionId).toBe(second);

      const [beforeRedo] = await db
        .select({
          state: workItem.state,
          revision: workItem.revision,
          revisionHead: workItem.revisionHead,
          revisionSeq: workItem.revisionSeq,
          extractionId: workItem.extractionId,
        })
        .from(workItem)
        .where(eq(workItem.id, work.workItemId))
        .limit(1);
      const eventsBefore = await eventsFor(db, work.workItemId);

      const stale = await redoWorkItemRevision(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        userId: USER,
        expectedSeq: 2,
      });
      expect(stale).toMatchObject({ status: 'stale', revision: 0, revisionHead: 1, seq: 3 });
      const redone = await redoWorkItemRevision(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        userId: USER,
        expectedSeq: 3,
      });
      expect(redone).toMatchObject({ status: 'history_stale', revision: 0, revisionHead: 1, seq: 3 });

      const [afterRedo] = await db
        .select({
          state: workItem.state,
          revision: workItem.revision,
          revisionHead: workItem.revisionHead,
          revisionSeq: workItem.revisionSeq,
          extractionId: workItem.extractionId,
        })
        .from(workItem)
        .where(eq(workItem.id, work.workItemId))
        .limit(1);
      expect(afterRedo).toEqual(beforeRedo);
      expect(await eventsFor(db, work.workItemId)).toHaveLength(eventsBefore.length);
      expect(afterRedo?.state[path]).toBeUndefined();
    }));

  it('undo after a stay edit leaves a prior contact reset in place', () =>
    withDb(async (db) => {
      const messageId = await seedMail(db, 'rev-reset-1');
      await insertRead(db, messageId, { version: 'extract-v1', payload: payload() });
      const work = await readyWork(db, 'rev-reset-1');
      const company = 'contact.company';
      const arrival = `stays[${STAY_ONE}].requested.arrival`;

      expect(
        await recordFieldEvent(db, {
          transportId: CENTURION,
          workItemId: work.workItemId,
          userId: USER,
          type: 'field.edit',
          fieldPath: company,
          value: 'New Frontiers Tours',
        }),
      ).toMatchObject({ status: 'recorded' });

      expect(
        await resetWorkSection(db, {
          transportId: CENTURION,
          workItemId: work.workItemId,
          userId: USER,
          section: { type: 'contact' },
        }),
      ).toEqual({ status: 'recorded', reset: 1 });
      expect((await readyWork(db, 'rev-reset-1')).contact.company).toBe('Horizon Trail Tours');

      expect(
        await recordFieldEvent(db, {
          transportId: CENTURION,
          workItemId: work.workItemId,
          userId: USER,
          type: 'field.edit',
          fieldPath: arrival,
          value: '2027-10-25',
        }),
      ).toMatchObject({ status: 'recorded' });

      const undoneStay = await undoWorkItemRevision(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        userId: USER,
        expectedSeq: 3,
      });
      expect(undoneStay).toMatchObject({ status: 'applied', revision: 2, revisionHead: 3, seq: 4 });
      const afterStayUndo = await readyWork(db, 'rev-reset-1');
      expect(afterStayUndo.analysis.groups[0]!.arrivalDate).toBe('2027-10-26');
      expect(afterStayUndo.contact.company).toBe('Horizon Trail Tours');

      const undoneReset = await undoWorkItemRevision(db, {
        transportId: CENTURION,
        workItemId: work.workItemId,
        userId: USER,
        expectedSeq: 4,
      });
      expect(undoneReset).toMatchObject({ status: 'applied', revision: 1, revisionHead: 3, seq: 5 });
      expect((await readyWork(db, 'rev-reset-1')).contact.company).toBe('New Frontiers Tours');
    }));
});
