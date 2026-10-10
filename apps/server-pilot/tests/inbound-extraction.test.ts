import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelAdapter } from '../src/ai/bedrock/adapter.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { buildInboundPrompt, extractInboundMail } from '../src/ai/extraction/extract.js';
import {
  __resetInboundExtractionCapForTests,
  EXTRACTION_VERSION,
  enqueueInboundExtraction,
  executeInboundExtractionRun,
  type InboundExtractionDeps,
  inboundExtractionEnabled,
  inboundExtractionMaxPerHour,
  retryInboundTranslation,
  runInboundExtraction,
} from '../src/ai/extraction/inbound-run.js';
import type { MailExtractionPayload } from '../src/ai/extraction/schema.js';
import {
  type InboundTranslation,
  splitSegments,
  TRANSLATE_RULES,
} from '../src/ai/extraction/translate.js';
import {
  loadSyncedQuoteSelectionFromMailbox,
  type SyncedQuoteSelection,
} from '../src/ai/quote-workflow-synced-selection.js';
import {
  aiWorkflowRun,
  mailSenderPreference,
  mailThread,
  message,
} from '../src/db/schema/mail.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import { toAiRunFence } from '../src/ai/run-ledger.js';
import {
  AE1_FROM,
  AE1_OUTPUT,
  AE1_SUBJECT,
  AE1_TEXT,
  AE2_OUTPUT,
  AE2_TEXT,
  echoTranslation,
  fakeModel,
  hangingResponder,
  SPAM_OUTPUT,
  SPAM_TEXT,
  selectionFor,
  VOUCHER_OUTPUT,
  VOUCHER_TEXT,
} from './fixtures/inbound-extraction.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';

const TRANSPORT = 'transport-centurion';
const ON = { INBOUND_EXTRACTION: 'on' } as NodeJS.ProcessEnv;
const CAPPED = { INBOUND_EXTRACTION: 'on', INBOUND_EXTRACTION_MAX_PER_HOUR: '1' } as NodeJS.ProcessEnv;
const CARD_DIGITS = /4111[ -]?1111[ -]?1111[ -]?1111/;

beforeEach(() => __resetInboundExtractionCapForTests());
afterEach(() => vi.unstubAllEnvs());

async function seedMail(
  db: DB,
  threadId: string,
  body: string,
  direction: 'inbound' | 'outbound' = 'inbound',
  fromAddress = 'sender@example.com',
): Promise<string> {
  const messageId = `msg-${threadId}`;
  await seedInboxThread(db, {
    threadId,
    transportId: TRANSPORT,
    transportEmail: 'centurion@legacyhotels.co.za',
    messageId,
    fromAddress,
    subject: 'Rooms request',
    textBody: body,
    messageIdHeader: `${threadId}@example.com`,
  });
  if (direction === 'outbound') {
    await db.update(message).set({ direction: 'outbound' }).where(eq(message.id, messageId));
  }
  return messageId;
}

function readMail(
  db: DB,
  messageId: string,
  selection: SyncedQuoteSelection,
  adapter: ModelAdapter | null,
  extra: InboundExtractionDeps = {},
) {
  return runInboundExtraction(
    { transportId: TRANSPORT, triggerMessageId: messageId, promptVersion: EXTRACTION_VERSION },
    { db, env: ON, adapter, loadSelection: async () => selection, ...extra },
  );
}

async function rowFor(db: DB, messageId: string) {
  const [row] = await db
    .select()
    .from(mailExtraction)
    .where(
      and(
        eq(mailExtraction.messageId, messageId),
        eq(mailExtraction.extractorVersion, EXTRACTION_VERSION),
      ),
    )
    .limit(1);
  return row ?? null;
}

describe('inbound extraction stored read', () => {
  it('AE1: two date sets make two stays with stable ids, and the agency is the sender, not the end client', () =>
    withIngestionDb(async ({ db }) => {
      const messageId = await seedMail(db, 'thread-ae1', AE1_TEXT, 'inbound', AE1_FROM);
      const model = fakeModel(() => AE1_OUTPUT);
      const selection = selectionFor(AE1_TEXT, AE1_SUBJECT);

      expect(await readMail(db, messageId, selection, model.adapter)).toBe('stored');
      // The model sees the From address, so the agency can come from the sender domain.
      expect(model.calls[0]?.userPrompt).toContain(`From: ${AE1_FROM}`);
      expect(model.calls[0]?.systemPrompt).toMatch(/agency is the organisation of the sender/);
      const row = await rowFor(db, messageId);
      expect(row).toMatchObject({ status: 'succeeded', kind: 'quote', language: 'en', translation: null });
      const payload = row!.payload as MailExtractionPayload;
      // The sender's organisation is the agency. The client named in the subject is the end client.
      expect(payload.agency).toBe('Horizon Trail Tours');
      expect(payload.endClient).toBe('Summit Africa');
      expect(payload.contact.email).toBe('priya@horizontrailtours.example');
      expect(payload.stays.map((stay) => stay.requested)).toEqual([
        { arrival: '2027-10-26', departure: '2027-10-28' },
        { arrival: '2027-11-17', departure: '2027-11-19' },
      ]);
      // 30 rooms is a stay total with no split: the total is kept, the rows keep their types, rooms is asked for.
      expect(payload.stays.map((stay) => stay.totalRooms)).toEqual([30, 30]);
      expect(payload.stays[0]!.rows.map((room) => [room.roomType, room.rooms])).toEqual([
        ['Single', null],
        ['Double/Twin', null],
      ]);
      expect(payload.missing.map((item) => item.field)).toContain('rooms');
      expect(payload.stays[0]!.id).toMatch(/^s_[0-9a-f]{8}$/);
      expect(new Set(payload.stays.map((stay) => stay.id)).size).toBe(2);
      // English makes no second call.
      expect(model.calls).toHaveLength(1);

      // A fresh read of the same mail keeps the stay and row ids.
      const again = await extractInboundMail({ adapter: model.adapter, selection, messageId });
      expect(again.ok ? again.payload.stays.map((stay) => stay.id) : null).toEqual(
        payload.stays.map((stay) => stay.id),
      );
      expect(again.ok ? again.payload.stays[1]!.rows.map((row) => row.id) : null).toEqual(
        payload.stays[1]!.rows.map((row) => row.id),
      );
    }));

  it('AE2: an amendment keeps requested and booked pairs, and a French body gets an aligned translation', () =>
    withIngestionDb(async ({ db }) => {
      const messageId = await seedMail(db, 'thread-ae2', AE2_TEXT);
      const model = fakeModel((input) =>
        input.systemPrompt === TRANSLATE_RULES ? echoTranslation(input) : AE2_OUTPUT,
      );

      expect(await readMail(db, messageId, selectionFor(AE2_TEXT), model.adapter)).toBe('stored');
      const row = await rowFor(db, messageId);
      expect(row).toMatchObject({ kind: 'amendment', language: 'fr' });
      const payload = row!.payload as MailExtractionPayload;
      expect(payload.stays[0]!.requested).toEqual({ arrival: '2026-10-31', departure: '2026-11-07' });
      expect(payload.stays[0]!.booked).toEqual({ arrival: '2026-11-01', departure: '2026-11-06' });
      expect(payload.confirmationNumbers).toEqual(['57291630-1']);

      const translation = row!.translation as unknown as Extract<
        InboundTranslation,
        { status: 'succeeded' }
      >;
      expect(translation).toMatchObject({ status: 'succeeded', sourceLanguage: 'fr', truncated: false });
      expect(translation.segments).toHaveLength(splitSegments(AE2_TEXT).segments.length);
      expect(model.calls).toHaveLength(2);
      expect(Object.keys(row!.usage as Record<string, unknown>).sort()).toEqual([
        'extraction',
        'translation',
      ]);
    }));

  it('a voucher with a Luhn-valid card reaches the model masked, and nothing stored carries the digits', () =>
    withIngestionDb(async ({ db }) => {
      const messageId = await seedMail(db, 'thread-voucher', VOUCHER_TEXT);
      // The fake repeats the raw digits in an output field, to show the stored payload is masked anyway.
      const model = fakeModel(() => ({
        ...VOUCHER_OUTPUT,
        missing: [{ field: 'card', question: 'Was card 4111111111111111 charged?' }],
      }));

      expect(await readMail(db, messageId, selectionFor(VOUCHER_TEXT), model.adapter)).toBe('stored');
      expect(model.calls[0]?.userPrompt).not.toMatch(CARD_DIGITS);
      expect(model.calls[0]?.userPrompt).toContain('[card ••••1111]');
      const row = await rowFor(db, messageId);
      expect(JSON.stringify(row)).not.toMatch(CARD_DIGITS);
      expect(row?.kind).toBe('voucher_pop');
    }));

  it('invalid confirmation numbers and impossible dates are dropped, and valid ones are kept', () =>
    withIngestionDb(async ({ db }) => {
      const body = 'Booking 57291630-1, arriving 2026-10-31 and leaving 2026-02-30. Thanks.';
      const messageId = await seedMail(db, 'thread-invalid', body);
      const model = fakeModel(() => ({
        ...AE2_OUTPUT,
        sourceLanguage: 'en',
        kind: 'booking',
        contact: { name: null, email: null, phone: null },
        confirmationNumbers: ['ABC-12', '57291630-1', '57291630-1'],
        stays: [
          {
            hotel: null,
            requested: { arrival: '2026-10-31', departure: '2026-02-30' },
            booked: null,
            totalRooms: 1000,
            rows: [],
          },
        ],
      }));

      expect(await readMail(db, messageId, selectionFor(body), model.adapter)).toBe('stored');
      const payload = (await rowFor(db, messageId))!.payload as MailExtractionPayload;
      expect(payload.confirmationNumbers).toEqual(['57291630-1']);
      expect(payload.stays[0]!.requested).toEqual({ arrival: '2026-10-31', departure: null });
      expect(payload.stays[0]!.totalRooms).toBeNull();
    }));

  it('an outbound saved-sent copy is not extracted and makes no call', () =>
    withIngestionDb(async ({ db }) => {
      const messageId = await seedMail(db, 'thread-outbound', AE1_TEXT, 'outbound');
      const model = fakeModel(() => AE1_OUTPUT);

      expect(await readMail(db, messageId, selectionFor(AE1_TEXT), model.adapter)).toBe('skipped');
      expect(model.calls).toHaveLength(0);
      expect(await rowFor(db, messageId)).toBeNull();
    }));

  it('kind spam sets spamAt only with the classifier retired, the write gate on and none of the triage not-spam guards', () =>
    withIngestionDb(async ({ db }) => {
      const gateOn = await seedMail(db, 'thread-spam-on', SPAM_TEXT);
      // While the classifier is on it is the only spam writer; the read records its kind only.
      const classifierOn = await seedMail(db, 'thread-spam-classifier-on', SPAM_TEXT);
      const locked = await seedMail(db, 'thread-spam-locked', SPAM_TEXT);
      const gateOff = await seedMail(db, 'thread-spam-off', SPAM_TEXT);
      // Triage keeps these out of spam, so the model must too: an allowed sender and a thread staff replied on.
      const allowed = await seedMail(db, 'thread-spam-allowed', SPAM_TEXT, 'inbound', 'friend@example.org');
      const replied = await seedMail(db, 'thread-spam-replied', SPAM_TEXT);
      await db
        .update(mailThread)
        .set({ spamUserLockedAt: new Date() })
        .where(eq(mailThread.id, 'thread-spam-locked'));
      await db.insert(mailSenderPreference).values({
        id: 'pref-allow',
        transportId: TRANSPORT,
        email: 'friend@example.org',
        kind: 'allow',
      });
      await db.insert(message).values({
        id: 'msg-thread-spam-replied-staff',
        transportId: TRANSPORT,
        threadId: 'thread-spam-replied',
        direction: 'outbound',
        fromAddress: 'centurion@legacyhotels.co.za',
        toAddresses: ['sender@example.com'],
        ccAddresses: [],
        bccAddresses: [],
        subject: 'Re: Rooms request',
        textBody: 'Thanks, we will check.',
        ownerHeaderValue: 'centurion@legacyhotels.co.za',
        messageIdHeader: 'staff-reply@example.com',
        references: [],
        isRead: true,
        isStarred: false,
      });
      const model = fakeModel(() => SPAM_OUTPUT);
      const selection = selectionFor(SPAM_TEXT);
      const gateOpen = {
        ...ON,
        AI_WRITE_GATE_ENABLED: 'true',
        INBOUND_TRIAGE_CLASSIFIER: 'off',
      } as NodeJS.ProcessEnv;

      await readMail(db, gateOn, selection, model.adapter, { env: gateOpen });
      await readMail(db, classifierOn, selection, model.adapter, {
        env: { ...ON, AI_WRITE_GATE_ENABLED: 'true' } as NodeJS.ProcessEnv,
      });
      await readMail(db, locked, selection, model.adapter, { env: gateOpen });
      await readMail(db, gateOff, selection, model.adapter);
      await readMail(db, allowed, selection, model.adapter, { env: gateOpen });
      await readMail(db, replied, selection, model.adapter, { env: gateOpen });

      const threads = await db
        .select({ id: mailThread.id, spamAt: mailThread.spamAt })
        .from(mailThread);
      const spamAt = (id: string) => threads.find((thread) => thread.id === id)?.spamAt ?? null;
      expect(spamAt('thread-spam-on')).not.toBeNull();
      expect(spamAt('thread-spam-classifier-on')).toBeNull();
      expect(await rowFor(db, classifierOn)).toMatchObject({ kind: 'spam' });
      expect(spamAt('thread-spam-locked')).toBeNull();
      expect(spamAt('thread-spam-off')).toBeNull();
      expect(spamAt('thread-spam-allowed')).toBeNull();
      expect(spamAt('thread-spam-replied')).toBeNull();
    }));

  it('loads the mail by its row id, so a missing or shared Message-ID header still gets a read', () =>
    withIngestionDb(async ({ db }) => {
      const headerless = await seedMail(db, 'thread-no-header', AE1_TEXT);
      await db.update(message).set({ messageIdHeader: null }).where(eq(message.id, headerless));
      const loads: unknown[] = [];
      const model = fakeModel(() => AE1_OUTPUT);
      expect(
        await readMail(db, headerless, selectionFor(AE1_TEXT), model.adapter, {
          loadSelection: async (input) => {
            loads.push(input);
            return selectionFor(AE1_TEXT);
          },
        }),
      ).toBe('stored');
      expect(loads).toEqual([expect.objectContaining({ transportId: TRANSPORT, messageId: headerless })]);
      expect(await rowFor(db, headerless)).toMatchObject({ status: 'succeeded' });

      // Two rows ingest kept apart share one header; the loader still finds the exact row by id.
      const first = await seedMail(db, 'thread-shared-header-1', AE1_TEXT);
      const second = await seedMail(db, 'thread-shared-header-2', AE2_TEXT);
      await db
        .update(message)
        .set({ messageIdHeader: 'shared@example.com' })
        .where(inArray(message.id, [first, second]));
      __setDbForTests({ db, conn: null as never });
      try {
        const loaded = await loadSyncedQuoteSelectionFromMailbox({ transportId: TRANSPORT, messageId: second });
        expect(loaded).toMatchObject({ messageId: second, bodyText: AE2_TEXT });
      } finally {
        __setDbForTests(null);
      }
    }));

  it('arrival, not the Date header, orders mail: a reply sent before the request arrived does not answer it, and a late-delivered mail decides spam', () =>
    withIngestionDb(async ({ db }) => {
      const at = (hhmm: string) => new Date(`2026-10-08T${hhmm}:00Z`);
      const model = fakeModel(() => AE1_OUTPUT);
      const staffReply = (id: string, threadId: string, sentAt: Date) =>
        db.insert(message).values({
          id,
          transportId: TRANSPORT,
          threadId,
          direction: 'outbound',
          fromAddress: 'centurion@legacyhotels.co.za',
          toAddresses: ['sender@example.com'],
          subject: 'Re: Rooms request',
          textBody: 'Thanks.',
          receivedAt: sentAt,
          sentAt,
        });
      // POP3 mail whose Date header says 08:00, fetched at 10:00. A reply sent at 09:00 predates its arrival; one
      // at 11:00 answers it.
      const early = await seedMail(db, 'thread-arrival-early', AE1_TEXT);
      const late = await seedMail(db, 'thread-arrival-late', AE1_TEXT);
      await db
        .update(message)
        .set({ receivedAt: at('08:00'), createdAt: at('10:00'), pop3Uidl: sql`'uidl-' || ${message.id}` })
        .where(inArray(message.id, [early, late]));
      await staffReply('reply-before-arrival', 'thread-arrival-early', at('09:00'));
      await staffReply('reply-after-arrival', 'thread-arrival-late', at('11:00'));
      await readMail(db, early, selectionFor(AE1_TEXT), model.adapter);
      await readMail(db, late, selectionFor(AE1_TEXT), model.adapter);
      const statusOf = async (messageId: string) =>
        (await db.select().from(workItem).where(eq(workItem.sourceMessageId, messageId)))[0]?.status;
      expect(await statusOf(early)).toBe('needs_you');
      expect(await statusOf(late)).toBe('done');

      // POP3: spam dated 09:00 fetched 09:01; a real request dated 08:00 fetched at 10:00, after it. The request is
      // the newest mail, so its read lifts the mark.
      const legit = await seedMail(db, 'thread-arrival-spam', AE1_TEXT);
      await db
        .update(message)
        .set({ receivedAt: at('08:00'), createdAt: at('10:00'), pop3Uidl: 'uidl-legit' })
        .where(eq(message.id, legit));
      await db.insert(message).values({
        id: 'spam-before-legit',
        transportId: TRANSPORT,
        threadId: 'thread-arrival-spam',
        direction: 'inbound',
        fromAddress: 'promo@example.net',
        subject: 'Prize',
        textBody: SPAM_TEXT,
        receivedAt: at('09:00'),
        createdAt: at('09:01'),
        pop3Uidl: 'uidl-spam',
      });
      await db.update(mailThread).set({ spamAt: at('09:02') }).where(eq(mailThread.id, 'thread-arrival-spam'));
      const gateOpen = {
        ...ON,
        AI_WRITE_GATE_ENABLED: 'true',
        INBOUND_TRIAGE_CLASSIFIER: 'off',
      } as NodeJS.ProcessEnv;
      expect(await readMail(db, legit, selectionFor(AE1_TEXT), model.adapter, { env: gateOpen })).toBe('stored');
      const [thread] = await db
        .select({ spamAt: mailThread.spamAt })
        .from(mailThread)
        .where(eq(mailThread.id, 'thread-arrival-spam'));
      expect(thread?.spamAt).toBeNull();
    }));

  it('a timeout stores a failed read with a reason, and a rerun with the same key is a no-op', () =>
    withIngestionDb(async ({ db }) => {
      const messageId = await seedMail(db, 'thread-timeout', AE1_TEXT);
      const model = fakeModel(hangingResponder);
      const extra = { extractionDeadlineMs: 25 };

      expect(await readMail(db, messageId, selectionFor(AE1_TEXT), model.adapter, extra)).toBe(
        'failed',
      );
      const row = await rowFor(db, messageId);
      expect(row).toMatchObject({ status: 'failed', kind: null, payload: null });
      expect((row!.usage as { failureReason?: string }).failureReason).toBe('timeout');

      expect(await readMail(db, messageId, selectionFor(AE1_TEXT), model.adapter, extra)).toBe(
        'exists',
      );
      expect(model.calls).toHaveLength(1);

      // The same idempotency key queued twice is one run.
      await enqueueInboundExtraction({ transportId: TRANSPORT, threadId: 'thread-timeout', messageId }, db);
      await enqueueInboundExtraction({ transportId: TRANSPORT, threadId: 'thread-timeout', messageId }, db);
      const runs = await db
        .select({ id: aiWorkflowRun.id })
        .from(aiWorkflowRun)
        .where(
          eq(aiWorkflowRun.idempotencyKey, `inbound-extraction:${messageId}:${EXTRACTION_VERSION}`),
        );
      expect(runs).toHaveLength(1);
    }));

  it('the hourly cap defers a read before any call, and a French read is not stored with a capped translation', () =>
    withIngestionDb(async ({ db }) => {
      const first = await seedMail(db, 'thread-cap-1', AE1_TEXT);
      const second = await seedMail(db, 'thread-cap-2', AE1_TEXT);
      const model = fakeModel(() => AE1_OUTPUT);

      expect(await readMail(db, first, selectionFor(AE1_TEXT), model.adapter, { env: CAPPED })).toBe(
        'stored',
      );
      expect(await readMail(db, second, selectionFor(AE1_TEXT), model.adapter, { env: CAPPED })).toBe(
        'capped',
      );
      expect(model.calls).toHaveLength(1);
      expect(await rowFor(db, second)).toBeNull();

      // A French read needs a second slot for its translation. With none left it is deferred, not stored half-done.
      __resetInboundExtractionCapForTests();
      const french = await seedMail(db, 'thread-cap-fr', AE2_TEXT);
      const frenchModel = fakeModel((input) =>
        input.systemPrompt === TRANSLATE_RULES ? echoTranslation(input) : AE2_OUTPUT,
      );
      expect(
        await readMail(db, french, selectionFor(AE2_TEXT), frenchModel.adapter, { env: CAPPED }),
      ).toBe('capped');
      expect(frenchModel.calls).toHaveLength(1);
      expect(await rowFor(db, french)).toBeNull();
    }));

  it('the worker maps outcomes onto run states: stored, deferred, dead-lettered', () =>
    withIngestionDb(async ({ db }) => {
      const signal = new AbortController().signal;
      // Marks the queued run as claimed the way claimNextAiRun does. The claim helper itself reads the whole server
      // env, which this suite does not set.
      const claimOne = async (threadId: string) => {
        const messageId = await seedMail(db, threadId, AE1_TEXT);
        await enqueueInboundExtraction({ transportId: TRANSPORT, threadId, messageId }, db);
        const [run] = await db
          .update(aiWorkflowRun)
          .set({
            state: 'running',
            claimOwner: 'w4-test',
            claimToken: `token-${threadId}`,
            deadlineAt: new Date(Date.now() + 60_000),
          })
          .where(
            eq(
              aiWorkflowRun.idempotencyKey,
              `inbound-extraction:${messageId}:${EXTRACTION_VERSION}`,
            ),
          )
          .returning();
        if (!run) throw new Error('no inbound_extraction run to claim');
        return { run, fence: toAiRunFence(run)! };
      };
      const loadSelection = async () => selectionFor(AE1_TEXT);
      const model = fakeModel(() => AE1_OUTPUT);
      const stateOf = async (runId: string) =>
        (
          await db
            .select({
              state: aiWorkflowRun.state,
              attempts: aiWorkflowRun.attempts,
              nextRunAt: aiWorkflowRun.nextRunAt,
              deadlineAt: aiWorkflowRun.deadlineAt,
            })
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.id, runId))
            .limit(1)
        )[0]!;

      const stored = await claimOne('thread-run-stored');
      expect(
        await executeInboundExtractionRun({
          ...stored,
          signal,
          db,
          env: ON,
          adapter: model.adapter,
          loadSelection,
        }),
      ).toEqual({ runId: stored.run.id, state: 'succeeded' });
      expect((await stateOf(stored.run.id)).state).toBe('succeeded');

      const deferred = await claimOne('thread-run-deferred');
      expect(
        await executeInboundExtractionRun({
          ...deferred,
          signal,
          db,
          env: {} as NodeJS.ProcessEnv,
          adapter: model.adapter,
          loadSelection,
        }),
      ).toEqual({ runId: deferred.run.id, state: 'retry_wait' });
      const deferredRow = await stateOf(deferred.run.id);
      expect(deferredRow.state).toBe('retry_wait');
      expect(deferredRow.attempts).toBe(deferred.run.attempts);
      expect(deferredRow.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
      // The wait outlasts the run's deadline, so the next claim must set a fresh one rather than dead-letter it.
      expect(deferredRow.deadlineAt).toBeNull();

      // A worker whose claim was taken over while it read writes nothing; the new owner makes the read.
      const lost = await claimOne('thread-run-lost');
      await db
        .update(aiWorkflowRun)
        .set({ claimToken: 'token-other-worker' })
        .where(eq(aiWorkflowRun.id, lost.run.id));
      expect(
        await executeInboundExtractionRun({
          ...lost,
          signal,
          db,
          env: ON,
          adapter: model.adapter,
          loadSelection,
        }),
      ).toEqual({ runId: lost.run.id, state: 'retry_wait' });
      expect(await rowFor(db, lost.run.triggerMessageId)).toBeNull();
      expect(
        await db.select().from(workItem).where(eq(workItem.sourceMessageId, lost.run.triggerMessageId)),
      ).toHaveLength(0);

      const unconfigured = await claimOne('thread-run-unconfigured');
      expect(
        await executeInboundExtractionRun({
          ...unconfigured,
          signal,
          db,
          env: ON,
          adapter: null,
        }),
      ).toEqual({ runId: unconfigured.run.id, state: 'dead_letter' });
      expect((await stateOf(unconfigured.run.id)).state).toBe('dead_letter');

      const stale = await claimOne('thread-run-stale');
      expect(
        await executeInboundExtractionRun({
          ...stale,
          run: { ...stale.run, promptVersion: 'extract-retired' },
          signal,
          db,
          env: ON,
          adapter: model.adapter,
          loadSelection,
        }),
      ).toEqual({ runId: stale.run.id, state: 'dead_letter' });
      expect((await stateOf(stale.run.id)).state).toBe('dead_letter');
    }));
});

describe('live admission enqueue', () => {
  const observed = (id: string, direction: 'inbound' | 'outbound') => ({
    transportId: TRANSPORT,
    sourceId: 'source-one',
    sourceObservationId: id,
    semanticVersion: '1',
    direction,
    internetMessageId: `${id}@example.test`,
    fromAddress: direction === 'inbound' ? 'guest@example.test' : 'centurion@legacyhotels.co.za',
    toAddresses: [direction === 'inbound' ? 'centurion@legacyhotels.co.za' : 'guest@example.test'],
    ccAddresses: [],
    bccAddresses: [],
    authoredAt: new Date('2026-10-09T10:00:00Z'),
    sentAt: null,
    textBody: `Body ${id}`,
    htmlBody: null,
    subject: 'Request',
    inReplyTo: null,
    references: [],
    originalMsgKey: `outlook-sync-originals/v1/source/${id}`,
    attachments: [],
    sourceProvenance: {},
  });

  it('queues one versioned read for admitted inbound mail only, and none while the flag is off', () =>
    withIngestionDb(async ({ db }) => {
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const { admitLiveMessage } = await import('../src/mail/ingest/live-admission.js');
      const admit = (messageId: string, receipt: string) =>
        db.transaction((tx) =>
          admitLiveMessage(tx as typeof db, {
            transportId: TRANSPORT,
            canonicalMessageId: messageId,
            evidence: { kind: 'verified-pop3', sourceReceiptId: receipt },
          }),
        );
      const extractionRuns = () =>
        db
          .select({
            key: aiWorkflowRun.idempotencyKey,
            trigger: aiWorkflowRun.triggerMessageId,
            promptVersion: aiWorkflowRun.promptVersion,
          })
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.runKind, 'inbound_extraction'));

      const flagOff = await persistOutlookHistory(db, observed('flag-off', 'inbound'));
      expect((await admit(flagOff.messageId, 'flag-off')).admitted).toBe(true);
      expect(await extractionRuns()).toHaveLength(0);

      vi.stubEnv('INBOUND_EXTRACTION', 'on');
      const inbound = await persistOutlookHistory(db, observed('inbound', 'inbound'));
      const outbound = await persistOutlookHistory(db, observed('outbound', 'outbound'));
      expect((await admit(inbound.messageId, 'inbound')).admitted).toBe(true);
      expect((await admit(outbound.messageId, 'outbound')).admitted).toBe(true);
      expect(await extractionRuns()).toEqual([
        {
          key: `inbound-extraction:${inbound.messageId}:${EXTRACTION_VERSION}`,
          trigger: inbound.messageId,
          promptVersion: EXTRACTION_VERSION,
        },
      ]);
    }));
});

describe('flags, cap parsing and the rules', () => {
  it('the flag is on only for the exact value on', () => {
    expect(inboundExtractionEnabled({ INBOUND_EXTRACTION: 'on' } as NodeJS.ProcessEnv)).toBe(true);
    for (const value of ['true', '1', 'ON', 'off']) {
      expect(inboundExtractionEnabled({ INBOUND_EXTRACTION: value } as NodeJS.ProcessEnv)).toBe(false);
    }
    expect(inboundExtractionEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('the hourly cap defaults to 60 and falls back to 60 on an invalid value', () => {
    expect(inboundExtractionMaxPerHour({} as NodeJS.ProcessEnv)).toBe(60);
    expect(
      inboundExtractionMaxPerHour({ INBOUND_EXTRACTION_MAX_PER_HOUR: '5' } as NodeJS.ProcessEnv),
    ).toBe(5);
    for (const value of ['-1', '2.5', 'abc']) {
      expect(
        inboundExtractionMaxPerHour({ INBOUND_EXTRACTION_MAX_PER_HOUR: value } as NodeJS.ProcessEnv),
      ).toBe(60);
    }
  });

  it('the rules no longer send 10+ rooms to other, and a 30-room rooms-only group is a quote', () => {
    const { system } = buildInboundPrompt(selectionFor(AE1_TEXT));
    expect(system).not.toMatch(/10\+ rooms\/delegates or events are other/);
    expect(system).toMatch(/quote at any size, 10\+ rooms included/);
  });
});

describe('translation retry', () => {
  async function workItemFor(db: DB, messageId: string): Promise<string> {
    const [item] = await db
      .select({ id: workItem.id })
      .from(workItem)
      .where(eq(workItem.sourceMessageId, messageId))
      .limit(1);
    return item!.id;
  }

  /** A French read whose translation came back misaligned, so the stored translation is failed. */
  async function frenchReadWithFailedTranslation(db: DB) {
    const messageId = await seedMail(db, 'thread-retry-fr', AE2_TEXT);
    const model = fakeModel((input) =>
      input.systemPrompt === TRANSLATE_RULES ? { segments: [] } : AE2_OUTPUT,
    );
    expect(await readMail(db, messageId, selectionFor(AE2_TEXT), model.adapter)).toBe('stored');
    expect((await rowFor(db, messageId))!.translation).toMatchObject({ status: 'failed', reason: 'misaligned' });
    return { messageId, workItemId: await workItemFor(db, messageId) };
  }

  it('makes one translation call, replaces the failed translation in place, and keeps the read', () =>
    withIngestionDb(async ({ db }) => {
      const { messageId, workItemId } = await frenchReadWithFailedTranslation(db);
      const before = await rowFor(db, messageId);
      const retry = fakeModel(echoTranslation);

      const result = await retryInboundTranslation(
        { transportId: TRANSPORT, workItemId },
        { db, env: ON, adapter: retry.adapter },
      );
      expect(retry.calls).toHaveLength(1);
      expect(retry.calls[0]!.systemPrompt).toBe(TRANSLATE_RULES);
      expect(result).toMatchObject({
        status: 'done',
        translation: { status: 'succeeded', sourceLanguage: 'fr' },
      });
      const after = await rowFor(db, messageId);
      expect(after!.id).toBe(before!.id);
      expect(after!.payload).toEqual(before!.payload);
      expect(after!.translation).toMatchObject({ status: 'succeeded' });
      expect(Object.keys(after!.usage as Record<string, unknown>).sort()).toEqual(['extraction', 'translation']);
    }));

  it('stores a failed retry as failed, with the reason the call ended', () =>
    withIngestionDb(async ({ db }) => {
      const { messageId, workItemId } = await frenchReadWithFailedTranslation(db);
      const hanging = fakeModel(() => hangingResponder());

      const result = await retryInboundTranslation(
        { transportId: TRANSPORT, workItemId },
        { db, env: ON, adapter: hanging.adapter, translationDeadlineMs: 50 },
      );
      expect(result).toEqual({
        status: 'done',
        translation: expect.objectContaining({ status: 'failed', reason: 'timeout' }),
      });
      expect((await rowFor(db, messageId))!.translation).toMatchObject({ status: 'failed', reason: 'timeout' });
    }));

  it('makes no call for an English read', () =>
    withIngestionDb(async ({ db }) => {
      const messageId = await seedMail(db, 'thread-retry-en', AE1_TEXT);
      expect(await readMail(db, messageId, selectionFor(AE1_TEXT), fakeModel(() => AE1_OUTPUT).adapter)).toBe(
        'stored',
      );
      const retry = fakeModel(echoTranslation);
      expect(
        await retryInboundTranslation(
          { transportId: TRANSPORT, workItemId: await workItemFor(db, messageId) },
          { db, env: ON, adapter: retry.adapter },
        ),
      ).toEqual({ status: 'not_needed' });
      expect(retry.calls).toHaveLength(0);
    }));

  it('is refused with the flag off, a spent hour, no model, or another transport, and changes nothing', () =>
    withIngestionDb(async ({ db }) => {
      const { messageId, workItemId } = await frenchReadWithFailedTranslation(db);
      const retry = fakeModel(echoTranslation);
      const item = { transportId: TRANSPORT, workItemId };

      expect(await retryInboundTranslation(item, { db, env: {} as NodeJS.ProcessEnv, adapter: retry.adapter })).toEqual({
        status: 'disabled',
      });
      expect(
        await retryInboundTranslation(item, {
          db,
          env: { ...ON, INBOUND_EXTRACTION_MAX_PER_HOUR: '0' },
          adapter: retry.adapter,
        }),
      ).toEqual({ status: 'capped' });
      expect(await retryInboundTranslation(item, { db, env: ON, adapter: null })).toEqual({ status: 'unconfigured' });
      expect(
        await retryInboundTranslation(
          { transportId: 'transport-other', workItemId },
          { db, env: ON, adapter: retry.adapter },
        ),
      ).toEqual({ status: 'not_found' });
      expect(retry.calls).toHaveLength(0);
      expect((await rowFor(db, messageId))!.translation).toMatchObject({ status: 'failed', reason: 'misaligned' });
    }));
});
