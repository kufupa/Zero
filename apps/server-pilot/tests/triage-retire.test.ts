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
import {
  CLEANUP_RESERVE_MS,
  DEFAULT_TRIAGE_PROMPT_VERSION,
  enqueueAiRun,
  toAiRunFence,
} from '../src/ai/run-ledger.js';
import { queryMailBaselineProjection } from '../src/metrics/mail-baseline-projection.js';
import { runInboundExtractionBackfill } from '../scripts/backfill-inbound-extraction.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { admitLiveMessage } from '../src/mail/ingest/live-admission.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import { pillSlugForExtractionKind } from '../src/ai/categories.js';
import { ensureWorkItemForMessage } from '../src/ai/work-items.js';
import { upsertSenderPreference } from '../src/mail/sender-preference.js';
import { isInboundTriageClassifierEnabled } from '../src/env.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { executeAiRun, runAiWorkerDrain } from '../src/ai/worker.js';
import { callerFor } from './helpers/trpc-caller.js';
import { TRANSPORT_ID } from '../src/db/seed.js';
import { and, eq } from 'drizzle-orm';

const reachable = await probeTestDb();
/** Classifier retired: off only takes effect with extraction on. */
const RETIRED: NodeJS.ProcessEnv = {
  INBOUND_TRIAGE_CLASSIFIER: 'off',
  INBOUND_EXTRACTION: 'on',
  AI_WRITE_GATE_ENABLED: 'true',
};
/** Today's default: classifier unset, extraction on. */
const DEFAULT_ON: NodeJS.ProcessEnv = { INBOUND_EXTRACTION: 'on', AI_WRITE_GATE_ENABLED: 'true' };

function retire() {
  vi.stubEnv('INBOUND_TRIAGE_CLASSIFIER', 'off');
  vi.stubEnv('INBOUND_EXTRACTION', 'on');
}
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
async function readWith(
  db: DB,
  messageId: string,
  body: string,
  output: Record<string, unknown>,
  env: NodeJS.ProcessEnv = RETIRED,
) {
  const model = fakeModel(() => output);
  const claimed = await claimExtraction(db, messageId);
  const state = await executeInboundExtractionRun({
    ...claimed,
    signal: new AbortController().signal,
    db,
    env,
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
  it('the classifier retires only on exactly off with extraction exactly on; off alone keeps it and warns once', () => {
    const extraction = { INBOUND_EXTRACTION: 'on' };
    expect(isInboundTriageClassifierEnabled({})).toBe(true);
    expect(isInboundTriageClassifierEnabled(extraction)).toBe(true);
    expect(isInboundTriageClassifierEnabled({ ...extraction, INBOUND_TRIAGE_CLASSIFIER: 'on' })).toBe(true);
    expect(isInboundTriageClassifierEnabled({ ...extraction, INBOUND_TRIAGE_CLASSIFIER: 'OFF' })).toBe(true);
    expect(isInboundTriageClassifierEnabled({ ...extraction, INBOUND_TRIAGE_CLASSIFIER: '0' })).toBe(true);
    expect(isInboundTriageClassifierEnabled({ ...extraction, INBOUND_TRIAGE_CLASSIFIER: 'off' })).toBe(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(isInboundTriageClassifierEnabled({ INBOUND_TRIAGE_CLASSIFIER: 'off' })).toBe(true);
      expect(
        isInboundTriageClassifierEnabled({ INBOUND_TRIAGE_CLASSIFIER: 'off', INBOUND_EXTRACTION: 'off' }),
      ).toBe(true);
      expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('classifier off without extraction: admission still queues the classifier run', () =>
    withSeededTestDb(async (db) => {
      vi.stubEnv('INBOUND_TRIAGE_CLASSIFIER', 'off');
      const { messageId } = await persistOutlookHistory(db, history('u5-failsafe'));
      await admit(db, messageId);
      expect(await runsFor(db, `inbound-triage:${messageId}`)).toHaveLength(1);
      expect(await runsFor(db, extractionKey(messageId))).toHaveLength(0);
    }));

  it('default (classifier unset, extraction on): both runs queue; the read projects no baseline and writes no spam', () =>
    withIngestionDb(async ({ db }) => {
      vi.stubEnv('INBOUND_EXTRACTION', 'on');
      const { messageId, threadId } = await persistOutlookHistory(db, history('u5-default'));
      await db.update(mailThread).set({ spamAt: new Date() }).where(eq(mailThread.id, threadId));
      await admit(db, messageId);
      expect(await runsFor(db, `inbound-triage:${messageId}`)).toHaveLength(1);
      expect(await runsFor(db, extractionKey(messageId))).toHaveLength(1);
      const { state } = await readWith(db, messageId, AE1_TEXT, AE1_OUTPUT, DEFAULT_ON);
      expect(state.state).toBe('succeeded');
      const [run] = await db
        .select({ metrics: aiWorkflowRun.metrics })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.idempotencyKey, extractionKey(messageId)));
      expect(run?.metrics).not.toHaveProperty('mailBaseline');
      const baseline = await queryMailBaselineProjection(db, {
        transportIds: [TRANSPORT_ID],
        threadIds: [threadId],
        observationCutoff: new Date(),
        limit: 20,
      });
      expect(baseline).toEqual([]);
      // The classifier owns spam and un-spam while it is on.
      expect(await spamAtOf(db, messageId)).not.toBeNull();
      const spam = await persistOutlookHistory(db, history('u5-default-spam', { textBody: SPAM_TEXT }));
      await admit(db, spam.messageId);
      await readWith(db, spam.messageId, SPAM_TEXT, SPAM_OUTPUT, DEFAULT_ON);
      expect(await extractionOf(db, spam.messageId)).toMatchObject({ kind: 'spam' });
      expect(await spamAtOf(db, spam.messageId)).toBeNull();
    }));

  it('with the flag off, inbound mail gets an extraction and a baseline row, and no classifier run', () =>
    withIngestionDb(async ({ db }) => {
      retire();
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
      retire();
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

  describe('an inbound read cut off mid model call', () => {
    /**
     * Queues and claims one read, then runs it through the worker with a model that hangs until the run aborts.
     * `cut` gets the worker's shutdown controller and the model call's signal.
     */
    async function cutOff(
      db: DB,
      id: string,
      budgetMs: number,
      cut: (shutdown: AbortController, signal: AbortSignal) => void,
    ) {
      retire();
      const { messageId } = await persistOutlookHistory(db, history(id));
      await admit(db, messageId);
      const [queued] = await db
        .update(aiWorkflowRun)
        .set({
          state: 'claimed',
          claimOwner: 'u5-shutdown-test',
          claimToken: `token-${id}`,
          deadlineAt: new Date(Date.now() + budgetMs),
        })
        .where(eq(aiWorkflowRun.idempotencyKey, extractionKey(messageId)))
        .returning({ id: aiWorkflowRun.id });
      const shutdown = new AbortController();
      const result = await executeAiRun(queued!.id, {
        shutdownSignal: shutdown.signal,
        inboundExtractionAdapter: {
          invoke: ({ signal }) => {
            cut(shutdown, signal!);
            return new Promise<never>(() => undefined);
          },
        },
      });
      const [row] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, queued!.id));
      return { result, row: row! };
    }

    it('by a worker shutdown goes back on the queue with no attempt spent and a fresh deadline', () =>
      withWorkerDb(async (db) => {
        const { result, row } = await cutOff(db, 'u5-shutdown', 120_000, (shutdown) =>
          queueMicrotask(() => shutdown.abort()),
        );
        expect(result.state).toBe('retry_wait');
        expect(row).toMatchObject({
          state: 'retry_wait',
          failureClass: 'WORKER_SHUTDOWN',
          attempts: 0,
          deadlineAt: null,
          claimToken: null,
        });
        expect(row.lastError).toMatch(/^worker shutdown: /);
        expect(row.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now());
      }));

    it('by its own deadline still dead-letters, even if a shutdown follows', () =>
      withWorkerDb(async (db) => {
        // The run's budget runs out first; the shutdown lands while the abort is still settling.
        const { result, row } = await cutOff(db, 'u5-deadline', CLEANUP_RESERVE_MS + 200, (shutdown, signal) =>
          signal.addEventListener('abort', () => shutdown.abort(), { once: true }),
        );
        expect(result.state).toBe('dead_letter');
        expect(row.state).toBe('dead_letter');
        expect(row.failureClass).not.toBe('WORKER_SHUTDOWN');
      }), 30_000);
  });

  it('with the flag off, a spam read still sets spamAt', () =>
    withIngestionDb(async ({ db }) => {
      retire();
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
      retire();
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

  it('retired: the pill, filter, counts, category search and mark-read come from the extraction kind; spam has none', () =>
    withSeededTestDb(async (db) => {
      expect(pillSlugForExtractionKind('quote')).toBe('bookings');
      expect(pillSlugForExtractionKind('spam')).toBeNull();
      expect(pillSlugForExtractionKind('constructor')).toBeNull();

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
      const pillsOf = async () =>
        new Map(
          (await mail.listThreads({ folder: 'all', limit: 20 })).threads.map((thread) => [
            thread.id,
            thread.categoryIds,
          ]),
        );
      const bookingsCount = async () =>
        (await mail.unreadCounts()).categories.find((row) => row.categoryId === bookings!.id);

      // Classifier on (default): rows only, exactly as before.
      vi.stubEnv('INBOUND_EXTRACTION', 'on');
      expect((await pillsOf()).get(quote.threadId) ?? []).toEqual([]);
      const before = await bookingsCount();

      retire();
      const pills = await pillsOf();
      expect(pills.get(quote.threadId)).toEqual([bookings!.id]);
      expect(pills.get(spam.threadId) ?? []).toEqual([]);

      const filtered = await mail.listThreads({
        folder: 'all',
        limit: 20,
        filters: { categoryIds: [bookings!.id] },
      });
      const filteredIds = filtered.threads.map((thread) => thread.id);
      expect(filteredIds).toContain(quote.threadId);
      expect(filteredIds).not.toContain(spam.threadId);

      const searched = await mail.listThreads({ folder: 'all', limit: 20, q: 'category:bookings' });
      expect(searched.threads.map((thread) => thread.id)).toContain(quote.threadId);

      const after = await bookingsCount();
      expect(after?.totalCount).toBe((before?.totalCount ?? 0) + 1);

      // A person's category wins over the read: a thread with rows keeps them.
      const [manage] = await db
        .select({ id: mailCategory.id })
        .from(mailCategory)
        .where(and(eq(mailCategory.transportId, TRANSPORT_ID), eq(mailCategory.slug, 'manage-stay')));
      await db
        .insert(mailThreadCategory)
        .values({ threadId: spam.threadId, categoryId: manage!.id, transportId: TRANSPORT_ID });
      expect((await pillsOf()).get(spam.threadId)).toEqual([manage!.id]);

      await db.update(mailThread).set({ isRead: false }).where(eq(mailThread.id, quote.threadId));
      await mail.markFolderAsRead({ categoryId: bookings!.id });
      const [read] = await db
        .select({ isRead: mailThread.isRead })
        .from(mailThread)
        .where(eq(mailThread.id, quote.threadId));
      expect(read?.isRead).toBe(true);
    }));

  it('the backfill dry run writes nothing, a real run queues each read once, staggered by the hourly cap', () =>
    withIngestionDb(async ({ db }) => {
      const now = new Date('2026-10-10T12:00:00.000Z');
      const older = await persistOutlookHistory(db, history('u5-bf-older'));
      const newer = await persistOutlookHistory(db, history('u5-bf-newer'));
      const stale = await persistOutlookHistory(db, history('u5-bf-stale'));
      // Ambiguous identity: live admission never reads it, so the backfill skips it too.
      const ambiguous = await persistOutlookHistory(db, history('u5-bf-ambiguous'));
      await db
        .update(message)
        .set({ sourceProvenance: { attention: 'AMBIGUOUS_IDENTITY' }, receivedAt: now, createdAt: now })
        .where(eq(message.id, ambiguous.messageId));
      // The window and the order go by the mail's own date. Every row here was imported just now (createdAt), as
      // Outlook history is; the 30-day-old mail must stay out even though its row is new.
      const setMailDate = (messageId: string, receivedAt: Date) =>
        db.update(message).set({ receivedAt, createdAt: now }).where(eq(message.id, messageId));
      await setMailDate(older.messageId, new Date(now.getTime() - 2 * HOUR_MS));
      await setMailDate(newer.messageId, new Date(now.getTime() - HOUR_MS));
      await setMailDate(stale.messageId, new Date(now.getTime() - 30 * 24 * HOUR_MS));
      // The newer mail was imported first, so import order disagrees with mail order.
      await db
        .update(message)
        .set({ createdAt: new Date(now.getTime() - 60_000) })
        .where(eq(message.id, newer.messageId));
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
      expect(due.has(extractionKey(ambiguous.messageId))).toBe(false);

      // A second run finds the same two candidates and adds no rows.
      await runInboundExtractionBackfill({ db, now, dryRun: false, maxPerHour: 1 });
      expect(await extractionRuns()).toHaveLength(2);
    }));

  it('a thread with a later staff reply starts its work item done, and an unanswered one needs you', () =>
    withIngestionDb(async ({ db }) => {
      retire();
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

  it('an imported request POP3 matched later keeps its Outlook arrival, so a reply sent before the import answers it', () =>
    withIngestionDb(async ({ db }) => {
      retire();
      // Delivered 4 Oct (Outlook's time), answered 5 Oct, imported 7 Oct, then matched by POP3, which adds only its uidl.
      const request = await persistOutlookHistory(db, history('u5-pop3-matched'));
      await db
        .update(message)
        .set({ createdAt: new Date('2026-10-07T09:00:00Z'), pop3Uidl: 'uidl-u5-pop3-matched' })
        .where(eq(message.id, request.messageId));
      await admit(db, request.messageId);
      const reply = await persistOutlookHistory(
        db,
        history('u5-pop3-matched-reply', {
          direction: 'outbound',
          fromAddress: 'centurion@legacyhotels.co.za',
          toAddresses: ['guest@example.test'],
          authoredAt: new Date('2026-10-05T09:00:00Z'),
          sentAt: new Date('2026-10-05T09:00:00Z'),
          inReplyTo: 'u5-pop3-matched@example.test',
        }),
      );
      expect(reply.threadId).toBe(request.threadId);
      await readWith(db, request.messageId, AE1_TEXT, AE1_OUTPUT);
      const [item] = await db
        .select({ status: workItem.status })
        .from(workItem)
        .where(eq(workItem.sourceMessageId, request.messageId));
      expect(item?.status).toBe('done');
    }));

  it('a reply counts only once sent, and by mail date: a queued send or an older imported send leaves the item open', () =>
    withIngestionDb(async ({ db }) => {
      retire();
      const queued = await persistOutlookHistory(db, history('u5-queued'));
      const older = await persistOutlookHistory(db, history('u5-older-sent'));
      await admit(db, queued.messageId);
      await admit(db, older.messageId);
      const outbound = {
        transportId: TRANSPORT_ID,
        direction: 'outbound' as const,
        fromAddress: 'centurion@legacyhotels.co.za',
        toAddresses: ['guest@example.test'],
        subject: 'Re: Request',
        textBody: 'Thanks.',
      };
      // mail.send: stored before delivery with sentAt null; a failed send stays that way.
      await db.insert(message).values({
        ...outbound,
        id: 'u5-queued-reply',
        threadId: queued.threadId,
        receivedAt: new Date(),
        sentAt: null,
      });
      // Outlook history imported after the request, but sent the day before it.
      await db.insert(message).values({
        ...outbound,
        id: 'u5-older-sent-reply',
        threadId: older.threadId,
        historyOnly: true,
        receivedAt: new Date('2026-10-03T10:00:00Z'),
        sentAt: new Date('2026-10-03T10:00:00Z'),
      });

      await readWith(db, queued.messageId, AE1_TEXT, AE1_OUTPUT);
      await readWith(db, older.messageId, AE1_TEXT, AE1_OUTPUT);
      for (const messageId of [queued.messageId, older.messageId]) {
        const [row] = await db
          .select({ status: workItem.status })
          .from(workItem)
          .where(eq(workItem.sourceMessageId, messageId));
        expect(row?.status).toBe('needs_you');
      }
    }));

  it('backfill order: an older spam read never puts back in spam a thread a newer mail cleared', () =>
    withIngestionDb(async ({ db }) => {
      retire();
      const spam = await persistOutlookHistory(
        db,
        history('u5-old-spam', { textBody: SPAM_TEXT, authoredAt: new Date('2026-10-03T10:00:00Z') }),
      );
      const quote = await persistOutlookHistory(
        db,
        history('u5-new-quote', { inReplyTo: 'u5-old-spam@example.test' }),
      );
      expect(quote.threadId).toBe(spam.threadId);
      await db.update(mailThread).set({ spamAt: new Date() }).where(eq(mailThread.id, spam.threadId));
      await admit(db, spam.messageId);
      await admit(db, quote.messageId);

      // Newest first, as the backfill queues them.
      await readWith(db, quote.messageId, AE1_TEXT, AE1_OUTPUT);
      expect(await spamAtOf(db, quote.messageId)).toBeNull();
      await readWith(db, spam.messageId, SPAM_TEXT, SPAM_OUTPUT);
      expect(await extractionOf(db, spam.messageId)).toMatchObject({ kind: 'spam' });
      expect(await spamAtOf(db, quote.messageId)).toBeNull();
    }));

  it('retired un-spam: any non-spam read lifts the mark (other included); a spam read keeps it; a blocked sender goes to spam', () =>
    withIngestionDb(async ({ db }) => {
      retire();
      const lifted = await persistOutlookHistory(db, history('u5-unspam-quote'));
      const other = await persistOutlookHistory(db, history('u5-unspam-other'));
      const kept = await persistOutlookHistory(db, history('u5-unspam-spam'));
      const locked = await persistOutlookHistory(db, history('u5-unspam-locked'));
      for (const row of [lifted, other, kept, locked]) {
        await db
          .update(mailThread)
          .set({ spamAt: new Date() })
          .where(eq(mailThread.id, row.threadId));
      }
      await db
        .update(mailThread)
        .set({ spamUserLockedAt: new Date() })
        .where(eq(mailThread.id, locked.threadId));
      for (const row of [lifted, other, kept, locked]) await admit(db, row.messageId);
      expect((await readWith(db, lifted.messageId, AE1_TEXT, AE1_OUTPUT)).state.state).toBe('succeeded');
      expect(
        (await readWith(db, other.messageId, AE1_TEXT, { ...SPAM_OUTPUT, kind: 'other' })).state.state,
      ).toBe('succeeded');
      expect((await readWith(db, kept.messageId, SPAM_TEXT, SPAM_OUTPUT)).state.state).toBe('succeeded');
      expect((await readWith(db, locked.messageId, AE1_TEXT, AE1_OUTPUT)).state.state).toBe('succeeded');
      expect(await spamAtOf(db, lifted.messageId)).toBeNull();
      expect(await spamAtOf(db, other.messageId)).toBeNull();
      expect(await spamAtOf(db, kept.messageId)).not.toBeNull();
      expect(await spamAtOf(db, locked.messageId)).not.toBeNull();

      const blocked = await persistOutlookHistory(
        db,
        history('u5-blocked', { fromAddress: 'blocked-sender@example.test' }),
      );
      await upsertSenderPreference({
        db,
        transportId: TRANSPORT_ID,
        emailRaw: 'blocked-sender@example.test',
        kind: 'block',
      });
      await admit(db, blocked.messageId);
      await readWith(db, blocked.messageId, AE1_TEXT, AE1_OUTPUT);
      expect(await spamAtOf(db, blocked.messageId)).not.toBeNull();
    }));
});
