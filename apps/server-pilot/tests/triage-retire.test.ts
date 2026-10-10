import {
  AE1_OUTPUT,
  AE1_TEXT,
  SPAM_OUTPUT,
  SPAM_TEXT,
  fakeModel,
  selectionFor,
} from './fixtures/inbound-extraction.js';
import {
  aiWorkflowRun,
  mailCategory,
  mailThread,
  mailThreadCategory,
  message,
} from '../src/db/schema/mail.js';
import {
  persistOutlookHistory,
  type OutlookHistoryInput,
} from '../src/mail/ingest/outlook-history.js';
import {
  EXTRACTION_VERSION,
  executeInboundExtractionRun,
} from '../src/ai/extraction/inbound-run.js';
import { DEFAULT_TRIAGE_PROMPT_VERSION, enqueueAiRun, toAiRunFence } from '../src/ai/run-ledger.js';
import { queryMailBaselineProjection } from '../src/metrics/mail-baseline-projection.js';
import { runInboundExtractionBackfill } from '../scripts/backfill-inbound-extraction.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { admitLiveMessage } from '../src/mail/ingest/live-admission.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import { pillSlugForExtractionKind } from '../src/ai/categories.js';
import { ensureWorkItemForMessage } from '../src/ai/work-items.js';
import { isInboundTriageClassifierEnabled } from '../src/env.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { runAiWorkerDrain } from '../src/ai/worker.js';
import { callerFor } from './helpers/trpc-caller.js';
import { TRANSPORT_ID } from '../src/db/seed.js';
import { and, eq } from 'drizzle-orm';

const reachable = await probeTestDb();
const ON: NodeJS.ProcessEnv = { INBOUND_EXTRACTION: 'on', AI_WRITE_GATE_ENABLED: 'true' };
const HOUR_MS = 60 * 60 * 1000;

afterEach(() => {
  vi.unstubAllEnvs();
});

const extractionKey = (messageId: string) =>
  `inbound-extraction:${messageId}:${EXTRACTION_VERSION}`;

/** Same outlook history shape as outlook-sync-live-admission.test.ts. */
function history(id: string, overrides: Partial<OutlookHistoryInput> = {}): OutlookHistoryInput {
  return {
    transportId: TRANSPORT_ID,
    sourceId: 'source-one',
    sourceObservationId: id,
    semanticVersion: '1',
    direction: 'inbound',
    internetMessageId: `${id}@example.test`,
    fromAddress: 'guest@example.test',
    toAddresses: ['centurion@legacyhotels.co.za'],
    ccAddresses: [],
    bccAddresses: [],
    authoredAt: new Date('2026-10-04T10:00:00Z'),
    sentAt: null,
    textBody: `Body ${id}`,
    htmlBody: null,
    subject: 'Request',
    inReplyTo: null,
    references: [],
    originalMsgKey: `outlook-sync-originals/v1/source/${id}`,
    attachments: [],
    sourceProvenance: {},
    ...overrides,
  };
}

/** Admits one message the way the live POP3 path does. Inbound admission queues its read when the flag is on. */
function admit(db: DB, messageId: string) {
  return db.transaction((tx) =>
    admitLiveMessage(tx as typeof db, {
      transportId: TRANSPORT_ID,
      canonicalMessageId: messageId,
      evidence: { kind: 'verified-pop3', sourceReceiptId: `uidl-${messageId}` },
    }),
  );
}

/**
 * The worker reads its queue through the cached getDb(), so point it at the rolled-back transaction for the callback.
 * The mail-baseline worker suite does the same.
 */
function withWorkerDb<T>(cb: (db: DB) => Promise<T>): Promise<T> {
  // The worker's parseEnv needs the server's required keys. The rest of the lane config stays unset.
  vi.stubEnv('PORT', '3000');
  vi.stubEnv('BETTER_AUTH_URL', 'https://nava.legacy.local');
  vi.stubEnv('BETTER_AUTH_SECRET', 'x'.repeat(32));
  vi.stubEnv('AWS_REGION', 'synthetic-region-1');
  vi.stubEnv('S3_BUCKET', 'u5-synthetic-bucket');
  return withSeededTestDb(async (db) => {
    __setDbForTests({ db, conn: null as never });
    try {
      return await cb(db);
    } finally {
      __setDbForTests(null);
    }
  });
}

function runsFor(db: DB, idempotencyKey: string) {
  return db
    .select({ id: aiWorkflowRun.id, state: aiWorkflowRun.state })
    .from(aiWorkflowRun)
    .where(eq(aiWorkflowRun.idempotencyKey, idempotencyKey));
}

/** Claims a queued read the way the worker does, so executeInboundExtractionRun can run directly. */
async function claimExtraction(db: DB, messageId: string) {
  const [run] = await db
    .update(aiWorkflowRun)
    .set({
      state: 'running',
      claimOwner: 'u5-test',
      claimToken: `token-${messageId}`,
      deadlineAt: new Date(Date.now() + 60_000),
    })
    .where(eq(aiWorkflowRun.idempotencyKey, extractionKey(messageId)))
    .returning();
  if (!run) throw new Error('no inbound_extraction run to claim');
  const fence = toAiRunFence(run);
  if (!fence) throw new Error('claimed run has no fence');
  return { run, fence };
}

/** Runs the read with a fake model. The model is returned so its calls can be counted. */
async function readWith(db: DB, messageId: string, body: string, output: Record<string, unknown>) {
  const model = fakeModel(() => output);
  const claimed = await claimExtraction(db, messageId);
  const state = await executeInboundExtractionRun({
    ...claimed,
    signal: new AbortController().signal,
    db,
    env: ON,
    adapter: model.adapter,
    loadSelection: async () => selectionFor(body),
  });
  return { state, model };
}

async function threadOf(db: DB, messageId: string): Promise<string> {
  const [row] = await db
    .select({ threadId: message.threadId })
    .from(message)
    .where(eq(message.id, messageId))
    .limit(1);
  if (!row) throw new Error('message missing');
  return row.threadId;
}

async function extractionOf(db: DB, messageId: string) {
  const [row] = await db
    .select({ status: mailExtraction.status, kind: mailExtraction.kind })
    .from(mailExtraction)
    .where(eq(mailExtraction.messageId, messageId));
  return row;
}

async function spamAtOf(db: DB, messageId: string) {
  const [row] = await db
    .select({ spamAt: mailThread.spamAt })
    .from(mailThread)
    .where(eq(mailThread.id, await threadOf(db, messageId)));
  return row?.spamAt ?? null;
}

async function categoryIdsOf(db: DB, threadId: string): Promise<string[]> {
  const rows = await db
    .select({ id: mailThreadCategory.categoryId })
    .from(mailThreadCategory)
    .where(eq(mailThreadCategory.threadId, threadId));
  return rows.map((row) => row.id);
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('U5 retire inbound triage', () => {
  it('the classifier flag is on unless the value is exactly off', () => {
    expect(isInboundTriageClassifierEnabled({})).toBe(true);
    expect(isInboundTriageClassifierEnabled({ INBOUND_TRIAGE_CLASSIFIER: 'on' })).toBe(true);
    expect(isInboundTriageClassifierEnabled({ INBOUND_TRIAGE_CLASSIFIER: 'OFF' })).toBe(true);
    expect(isInboundTriageClassifierEnabled({ INBOUND_TRIAGE_CLASSIFIER: '0' })).toBe(true);
    expect(isInboundTriageClassifierEnabled({ INBOUND_TRIAGE_CLASSIFIER: 'off' })).toBe(false);
  });

  it('with the flag off, inbound mail gets an extraction and a baseline row, and no classifier run', () =>
    withIngestionDb(async ({ db }) => {
      vi.stubEnv('INBOUND_TRIAGE_CLASSIFIER', 'off');
      vi.stubEnv('INBOUND_EXTRACTION', 'on');
      const { messageId, threadId } = await persistOutlookHistory(
        db,
        history('u5-inbound', { subject: 'Summit Africa rugby tour' }),
      );
      await admit(db, messageId);
      expect(await runsFor(db, `inbound-triage:${messageId}`)).toHaveLength(0);
      expect(await runsFor(db, extractionKey(messageId))).toHaveLength(1);

      const { state, model } = await readWith(db, messageId, AE1_TEXT, AE1_OUTPUT);
      expect(state).toMatchObject({ state: 'succeeded' });
      // The read is the only model call. No classifier ran, so the thread has no folder write.
      expect(model.calls).toHaveLength(1);
      expect(await extractionOf(db, messageId)).toMatchObject({
        status: 'succeeded',
        kind: 'quote',
      });
      expect(await categoryIdsOf(db, threadId)).toEqual([]);

      const baseline = await queryMailBaselineProjection(db, {
        transportIds: [TRANSPORT_ID],
        threadIds: [threadId],
        observationCutoff: new Date(),
        limit: 20,
      });
      expect(baseline).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sourceMessageId: messageId, direction: 'inbound' }),
        ]),
      );
    }));

  it('a classifier run queued before the flag flipped ends with no model call and no folder write', () =>
    withWorkerDb(async (db) => {
      vi.stubEnv('INBOUND_TRIAGE_CLASSIFIER', 'off');
      const { messageId, threadId } = await persistOutlookHistory(db, history('u5-leftover'));
      await enqueueAiRun(
        {
          transportId: TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          runKind: 'inbound_triage',
          idempotencyKey: `inbound-triage:${messageId}`,
          modelId: 'amazon.nova-lite-v1:0',
          promptVersion: DEFAULT_TRIAGE_PROMPT_VERSION,
        },
        db,
      );
      expect(
        await runAiWorkerDrain({
          transportId: TRANSPORT_ID,
          runKind: 'inbound_triage',
          promptVersion: DEFAULT_TRIAGE_PROMPT_VERSION,
          timeoutMs: 10_000,
          pollIntervalMs: 10,
        }),
      ).toMatchObject({ ok: true, reason: 'drained', processed: 1 });
      const [run] = await db
        .select({ state: aiWorkflowRun.state, metrics: aiWorkflowRun.metrics })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.idempotencyKey, `inbound-triage:${messageId}`));
      expect(run).toMatchObject({ state: 'succeeded', metrics: { triageRetired: true } });
      expect(await categoryIdsOf(db, threadId)).toEqual([]);
    }));

  it('with the flag off, a spam read still sets spamAt', () =>
    withIngestionDb(async ({ db }) => {
      vi.stubEnv('INBOUND_TRIAGE_CLASSIFIER', 'off');
      vi.stubEnv('INBOUND_EXTRACTION', 'on');
      const { messageId } = await persistOutlookHistory(
        db,
        history('u5-spam', { subject: 'Prize notice', textBody: SPAM_TEXT }),
      );
      await admit(db, messageId);
      const { state } = await readWith(db, messageId, SPAM_TEXT, SPAM_OUTPUT);
      expect(state.state).toBe('succeeded');
      expect(await extractionOf(db, messageId)).toMatchObject({
        status: 'succeeded',
        kind: 'spam',
      });
      expect(await spamAtOf(db, messageId)).not.toBeNull();
    }));

  it('with the flag off, a sent copy still gets its external-sent-baseline run and baseline row', () =>
    withWorkerDb(async (db) => {
      vi.stubEnv('INBOUND_TRIAGE_CLASSIFIER', 'off');
      const { messageId, threadId } = await persistOutlookHistory(
        db,
        history('u5-sent', {
          direction: 'outbound',
          fromAddress: 'centurion@legacyhotels.co.za',
          toAddresses: ['guest@example.test'],
          authoredAt: new Date('2026-10-04T11:00:00Z'),
        }),
      );
      await admit(db, messageId);
      expect(await runsFor(db, `external-sent-baseline:${messageId}`)).toHaveLength(1);
      expect(await runsFor(db, `inbound-triage:${messageId}`)).toHaveLength(0);
      expect(await runsFor(db, extractionKey(messageId))).toHaveLength(0);
      expect(
        await runAiWorkerDrain({
          transportId: TRANSPORT_ID,
          runKind: 'inbound_triage',
          promptVersion: DEFAULT_TRIAGE_PROMPT_VERSION,
          idempotencyPrefix: 'external-sent-baseline:',
          timeoutMs: 10_000,
          pollIntervalMs: 10,
        }),
      ).toMatchObject({ ok: true, reason: 'drained', processed: 1 });
      expect(await runsFor(db, `external-sent-baseline:${messageId}`)).toEqual([
        expect.objectContaining({ state: 'succeeded' }),
      ]);
      const baseline = await queryMailBaselineProjection(db, {
        transportIds: [TRANSPORT_ID],
        threadIds: [threadId],
        observationCutoff: new Date(),
        limit: 20,
      });
      expect(baseline).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sourceMessageId: messageId, direction: 'outbound' }),
        ]),
      );
    }));

  it('the pill comes from the extraction kind, and spam has none', () =>
    withSeededTestDb(async (db) => {
      expect(pillSlugForExtractionKind('quote')).toBe('bookings');
      expect(pillSlugForExtractionKind('spam')).toBeNull();

      const quote = await persistOutlookHistory(db, history('u5-pill-quote'));
      const spam = await persistOutlookHistory(db, history('u5-pill-spam'));
      await admit(db, quote.messageId);
      await admit(db, spam.messageId);
      await db.insert(mailExtraction).values([
        {
          messageId: quote.messageId,
          extractorVersion: EXTRACTION_VERSION,
          status: 'succeeded',
          kind: 'quote',
          language: 'en',
          payload: {},
          usage: {},
        },
        {
          messageId: spam.messageId,
          extractorVersion: EXTRACTION_VERSION,
          status: 'succeeded',
          kind: 'spam',
          language: 'en',
          payload: {},
          usage: {},
        },
      ]);
      const [bookings] = await db
        .select({ id: mailCategory.id })
        .from(mailCategory)
        .where(and(eq(mailCategory.transportId, TRANSPORT_ID), eq(mailCategory.slug, 'bookings')));
      const { mail } = await callerFor('user-navaai', { db, requestedTransportId: TRANSPORT_ID });
      const result = await mail.listThreads({ folder: 'all', limit: 20 });
      const categoriesById = new Map(
        result.threads.map((thread) => [thread.id, thread.categoryIds]),
      );
      expect(categoriesById.get(quote.threadId)).toEqual([bookings!.id]);
      expect(categoriesById.get(spam.threadId) ?? []).toEqual([]);
    }));

  it('the backfill dry run writes nothing, a real run queues each read once, staggered by the hourly cap', () =>
    withIngestionDb(async ({ db }) => {
      const now = new Date('2026-10-10T12:00:00.000Z');
      const older = await persistOutlookHistory(db, history('u5-bf-older'));
      const newer = await persistOutlookHistory(db, history('u5-bf-newer'));
      const stale = await persistOutlookHistory(db, history('u5-bf-stale'));
      const setCreatedAt = (messageId: string, createdAt: Date) =>
        db.update(message).set({ createdAt }).where(eq(message.id, messageId));
      await setCreatedAt(older.messageId, new Date(now.getTime() - 2 * HOUR_MS));
      await setCreatedAt(newer.messageId, new Date(now.getTime() - HOUR_MS));
      await setCreatedAt(stale.messageId, new Date(now.getTime() - 30 * 24 * HOUR_MS));
      const extractionRuns = () =>
        db
          .select({ key: aiWorkflowRun.idempotencyKey, nextRunAt: aiWorkflowRun.nextRunAt })
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.runKind, 'inbound_extraction'));

      expect(await runInboundExtractionBackfill({ db, now, dryRun: true, maxPerHour: 1 })).toEqual({
        dryRun: true,
        candidates: 2,
        queued: 0,
        hours: 2,
        maxPerHour: 1,
      });
      expect(await extractionRuns()).toHaveLength(0);

      expect(await runInboundExtractionBackfill({ db, now, dryRun: false, maxPerHour: 1 })).toEqual(
        {
          dryRun: false,
          candidates: 2,
          queued: 2,
          hours: 2,
          maxPerHour: 1,
        },
      );
      const due = new Map(
        (await extractionRuns()).map((row) => [row.key, row.nextRunAt?.getTime()]),
      );
      // Newest first: the newer mail takes hour 0 and the older one hour 1. The 30-day-old mail is outside the window.
      expect(due.get(extractionKey(newer.messageId))).toBe(now.getTime());
      expect(due.get(extractionKey(older.messageId))).toBe(now.getTime() + HOUR_MS);
      expect(due.has(extractionKey(stale.messageId))).toBe(false);

      // A second run finds the same two candidates and adds no rows.
      await runInboundExtractionBackfill({ db, now, dryRun: false, maxPerHour: 1 });
      expect(await extractionRuns()).toHaveLength(2);
    }));

  it('a thread with a later staff reply starts its work item done, and an unanswered one needs you', () =>
    withIngestionDb(async ({ db }) => {
      vi.stubEnv('INBOUND_TRIAGE_CLASSIFIER', 'off');
      vi.stubEnv('INBOUND_EXTRACTION', 'on');
      const answered = await persistOutlookHistory(db, history('u5-answered'));
      const open = await persistOutlookHistory(db, history('u5-open'));
      await admit(db, answered.messageId);
      await admit(db, open.messageId);
      const reply = await persistOutlookHistory(
        db,
        history('u5-answered-reply', {
          direction: 'outbound',
          fromAddress: 'centurion@legacyhotels.co.za',
          toAddresses: ['guest@example.test'],
          authoredAt: new Date('2026-10-04T12:00:00Z'),
          inReplyTo: 'u5-answered@example.test',
        }),
      );
      expect(reply.threadId).toBe(answered.threadId);

      await readWith(db, answered.messageId, AE1_TEXT, AE1_OUTPUT);
      await readWith(db, open.messageId, AE1_TEXT, AE1_OUTPUT);
      const statusOf = async (messageId: string) => {
        const [row] = await db
          .select({ status: workItem.status })
          .from(workItem)
          .where(eq(workItem.sourceMessageId, messageId));
        return row?.status;
      };
      expect(await statusOf(answered.messageId)).toBe('done');
      expect(await statusOf(open.messageId)).toBe('needs_you');
      const again = await ensureWorkItemForMessage(db, {
        transportId: TRANSPORT_ID,
        messageId: open.messageId,
      });
      expect(again?.status).toBe('needs_you');
    }));

  it('un-spam: a hotel-kind read lifts a spam mark, and an other read does not', () =>
    withIngestionDb(async ({ db }) => {
      vi.stubEnv('INBOUND_TRIAGE_CLASSIFIER', 'off');
      vi.stubEnv('INBOUND_EXTRACTION', 'on');
      const lifted = await persistOutlookHistory(db, history('u5-unspam-quote'));
      const kept = await persistOutlookHistory(db, history('u5-unspam-other'));
      for (const row of [lifted, kept]) {
        await db
          .update(mailThread)
          .set({ spamAt: new Date() })
          .where(eq(mailThread.id, row.threadId));
      }
      await admit(db, lifted.messageId);
      await admit(db, kept.messageId);
      const quoteRead = await readWith(db, lifted.messageId, AE1_TEXT, AE1_OUTPUT);
      const otherRead = await readWith(db, kept.messageId, AE1_TEXT, {
        ...SPAM_OUTPUT,
        kind: 'other',
      });
      expect(quoteRead.state.state).toBe('succeeded');
      expect(otherRead.state.state).toBe('succeeded');
      expect(await extractionOf(db, lifted.messageId)).toMatchObject({ kind: 'quote' });
      expect(await extractionOf(db, kept.messageId)).toMatchObject({ kind: 'other' });
      expect(await spamAtOf(db, lifted.messageId)).toBeNull();
      expect(await spamAtOf(db, kept.messageId)).not.toBeNull();
    }));
});
