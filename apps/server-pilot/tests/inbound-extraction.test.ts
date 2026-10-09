import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ModelAdapter } from '../src/ai/bedrock/adapter.js';
import type { DB } from '../src/db/client.js';
import { buildInboundPrompt, extractInboundMail } from '../src/ai/extraction/extract.js';
import {
  __resetInboundExtractionCapForTests,
  EXTRACTION_VERSION,
  enqueueInboundExtraction,
  executeInboundExtractionRun,
  type InboundExtractionDeps,
  inboundExtractionEnabled,
  inboundExtractionMaxPerHour,
  runInboundExtraction,
} from '../src/ai/extraction/inbound-run.js';
import type { MailExtractionPayload } from '../src/ai/extraction/schema.js';
import {
  type InboundTranslation,
  splitSegments,
  TRANSLATE_RULES,
} from '../src/ai/extraction/translate.js';
import type { SyncedQuoteSelection } from '../src/ai/quote-workflow-synced-selection.js';
import { aiWorkflowRun, mailThread, message } from '../src/db/schema/mail.js';
import { mailExtraction } from '../src/db/schema/work.js';
import { toAiRunFence } from '../src/ai/run-ledger.js';
import {
  AE1_OUTPUT,
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

async function seedMail(
  db: DB,
  threadId: string,
  body: string,
  direction: 'inbound' | 'outbound' = 'inbound',
): Promise<string> {
  const messageId = `msg-${threadId}`;
  await seedInboxThread(db, {
    threadId,
    transportId: TRANSPORT,
    transportEmail: 'centurion@legacyhotels.co.za',
    messageId,
    fromAddress: 'sender@example.com',
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
      const messageId = await seedMail(db, 'thread-ae1', AE1_TEXT);
      const model = fakeModel(() => AE1_OUTPUT);
      const selection = selectionFor(AE1_TEXT);

      expect(await readMail(db, messageId, selection, model.adapter)).toBe('stored');
      const row = await rowFor(db, messageId);
      expect(row).toMatchObject({ status: 'succeeded', kind: 'quote', language: 'en', translation: null });
      const payload = row!.payload as MailExtractionPayload;
      expect(payload.agency).toBe('Tailormade Travel');
      expect(payload.endClient).toBe('New Frontiers');
      expect(payload.contact.email).toBe('sam@tailormade.example');
      expect(payload.stays.map((stay) => stay.requested)).toEqual([
        { arrival: '2026-10-26', departure: '2026-10-27' },
        { arrival: '2026-11-17', departure: '2026-11-18' },
      ]);
      expect(payload.stays[0]!.rows.reduce((sum, room) => sum + (room.rooms ?? 0), 0)).toBe(30);
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
            rows: [],
          },
        ],
      }));

      expect(await readMail(db, messageId, selectionFor(body), model.adapter)).toBe('stored');
      const payload = (await rowFor(db, messageId))!.payload as MailExtractionPayload;
      expect(payload.confirmationNumbers).toEqual(['57291630-1']);
      expect(payload.stays[0]!.requested).toEqual({ arrival: '2026-10-31', departure: null });
    }));

  it('an outbound saved-sent copy is not extracted and makes no call', () =>
    withIngestionDb(async ({ db }) => {
      const messageId = await seedMail(db, 'thread-outbound', AE1_TEXT, 'outbound');
      const model = fakeModel(() => AE1_OUTPUT);

      expect(await readMail(db, messageId, selectionFor(AE1_TEXT), model.adapter)).toBe('skipped');
      expect(model.calls).toHaveLength(0);
      expect(await rowFor(db, messageId)).toBeNull();
    }));

  it('kind spam sets spamAt only when the write gate is on and no person has locked the thread', () =>
    withIngestionDb(async ({ db }) => {
      const gateOn = await seedMail(db, 'thread-spam-on', SPAM_TEXT);
      const locked = await seedMail(db, 'thread-spam-locked', SPAM_TEXT);
      const gateOff = await seedMail(db, 'thread-spam-off', SPAM_TEXT);
      await db
        .update(mailThread)
        .set({ spamUserLockedAt: new Date() })
        .where(eq(mailThread.id, 'thread-spam-locked'));
      const model = fakeModel(() => SPAM_OUTPUT);
      const selection = selectionFor(SPAM_TEXT);
      const gateOpen = { ...ON, AI_WRITE_GATE_ENABLED: 'true' } as NodeJS.ProcessEnv;

      await readMail(db, gateOn, selection, model.adapter, { env: gateOpen });
      await readMail(db, locked, selection, model.adapter, { env: gateOpen });
      await readMail(db, gateOff, selection, model.adapter);

      const threads = await db
        .select({ id: mailThread.id, spamAt: mailThread.spamAt })
        .from(mailThread);
      const spamAt = (id: string) => threads.find((thread) => thread.id === id)?.spamAt ?? null;
      expect(spamAt('thread-spam-on')).not.toBeNull();
      expect(spamAt('thread-spam-locked')).toBeNull();
      expect(spamAt('thread-spam-off')).toBeNull();
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
            .select({ state: aiWorkflowRun.state, attempts: aiWorkflowRun.attempts, nextRunAt: aiWorkflowRun.nextRunAt })
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
