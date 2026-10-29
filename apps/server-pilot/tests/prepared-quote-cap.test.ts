import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countPrefetchReservations } from '../src/ai/prefetch-capacity.js';
import { evaluateQuoteReadyForMessage, executeHmsJob, prefetchQuoteReadyForExtraction } from '../src/ai/hms-jobs.js';
import { claimNextAiRun, HMS_JOB_PROMPT_VERSION, markAiRunRunning } from '../src/ai/run-ledger.js';
import {
  CENTURION_HMS_READ_TARGET,
  DAVINCI_HMS_READ_TARGET,
  staffQuoteInstallationEnvName,
} from '../src/hms/hms-read-target.js';
import { mailboxHmsOriginBindLoaders } from '../src/hms/mailbox-hms-origin-bind.js';
import { quotePaneConfigForProperty } from '../src/hms/rate-catalogue.js';
import { aiWorkflowRun, mailThread, message } from '../src/db/schema/mail.js';
import { mailExtraction } from '../src/db/schema/work.js';
import type { DB } from '../src/db/client.js';
import {
  DAVINCI_TRANSPORT_EMAIL,
  DAVINCI_TRANSPORT_ID,
  TRANSPORT_ID,
} from '../src/db/seed.js';
import { probeTestDb, TEST_DB_AVAILABLE, withSeededTestDb } from './helpers/test-db.js';

const reachable = await probeTestDb();

const staffQuoteRunner = vi.hoisted(() => vi.fn());
vi.mock('../src/ai/staff-quote-run.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ai/staff-quote-run.js')>()),
  runStaffQuote: staffQuoteRunner,
}));

afterEach(() => {
  mailboxHmsOriginBindLoaders.loadThreadOrigin = null;
  mailboxHmsOriginBindLoaders.loadThreadOriginScan = null;
  staffQuoteRunner.mockReset();
  vi.unstubAllEnvs();
});

const QUOTE_ON = {
  HMS_JOB_QUEUE: 'on',
  HMS_QUOTE_PREPARE: 'true',
  HMS_DAVINCI_MAKE_QUOTE: 'on',
};

const PROPERTY_TARGETS: Array<{ transportId: string; propertyCode: string; expectedCount?: number }> = [
  { transportId: TRANSPORT_ID, propertyCode: CENTURION_HMS_READ_TARGET.propertyCode },
  { transportId: DAVINCI_TRANSPORT_ID, propertyCode: DAVINCI_HMS_READ_TARGET.propertyCode, expectedCount: 9 },
];

function quotePayload(explicitChildren = true) {
  return {
    origin: 'person',
    contact: { name: 'Example Guest', email: 'guest@example.test', phone: null },
    agency: 'Example Agency',
    endClient: 'Example Client',
    confirmationNumbers: [],
    stays: [
      {
        id: 's_12345678',
        hotel: null,
        requested: { arrival: '2099-11-12', departure: '2099-11-14' },
        booked: null,
        totalRooms: 1,
        rows: [
          {
            id: 'r_12345678',
            roomType: 'Standard King',
            rooms: 1,
            adultsPerRoom: 2,
            ...(explicitChildren ? { childrenPerRoom: 0 } : {}),
            childAges: [],
            board: null,
          },
        ],
      },
    ],
    missing: [],
  };
}

async function seedExtraction(db: DB, transportId: string, explicitChildren = true) {
  const threadId = `thread-${randomUUID()}`;
  const messageId = `message-${randomUUID()}`;
  await db.insert(mailThread).values({ id: threadId, transportId, threadRootId: threadId });
  await db.insert(message).values({
    id: messageId,
    transportId,
    threadId,
    direction: 'inbound',
    fromAddress: 'guest@example.test',
    toAddresses: transportId === DAVINCI_TRANSPORT_ID ? [DAVINCI_TRANSPORT_EMAIL] : [],
    subject: 'Quote request',
    textBody: 'Please quote a future stay.',
    receivedAt: new Date(),
  });
  await db.insert(mailExtraction).values({
    id: randomUUID(),
    messageId,
    extractorVersion: `prepared-quote-cap-${randomUUID()}`,
    status: 'succeeded',
    kind: 'quote',
    payload: quotePayload(explicitChildren),
  });
  const [source] = await db
    .insert(aiWorkflowRun)
    .values({
      id: randomUUID(),
      transportId,
      threadId,
      triggerMessageId: messageId,
      runKind: 'inbound_extraction',
      idempotencyKey: `inbound-extraction:${messageId}`,
      modelId: 'not_applicable',
      promptVersion: 'triage-v6',
      admissionSnapshotId: `snapshot-${randomUUID()}`,
      state: 'succeeded',
      executorLane: 'default',
      priority: 0,
      metrics: { keep: true },
    })
    .returning();
  if (!source) throw new Error('inbound extraction seed failed');
  return {
    messageId,
    run: {
      runKind: 'inbound_extraction' as const,
      transportId,
      triggerMessageId: messageId,
      admissionSnapshotId: source.admissionSnapshotId,
    },
  };
}

function preparedRows(db: DB, messageId: string) {
  return db
    .select({
      readRequest: aiWorkflowRun.readRequest,
      nextRunAt: aiWorkflowRun.nextRunAt,
      metrics: aiWorkflowRun.metrics,
    })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.triggerMessageId, messageId),
        sql`${aiWorkflowRun.metrics}->>'quotePrepared' = 'true'`,
      ),
    );
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('prepared quote profile cap', { timeout: 60_000 }, () => {
  beforeEach(() => {
    mailboxHmsOriginBindLoaders.loadThreadOriginScan = null;
    mailboxHmsOriginBindLoaders.loadThreadOrigin = async () => ({
      fromAddress: 'guest@example.test',
      toAddresses: [],
    });
  });

  it('evaluates a Da Vinci-origin message in the Centurion transport using its resolved property', async () =>
    withSeededTestDb(async (db) => {
      mailboxHmsOriginBindLoaders.loadThreadOrigin = async () => ({
        fromAddress: 'guest@example.test', toAddresses: [DAVINCI_TRANSPORT_EMAIL],
      });
      const source = await seedExtraction(db, TRANSPORT_ID, false);
      const result = await evaluateQuoteReadyForMessage({ messageId: source.messageId, transportId: TRANSPORT_ID }, db, QUOTE_ON);
      expect(result.plan?.inputs.length).toBeGreaterThan(0);
      expect(result.plan?.inputs[0]?.groups[0]).not.toHaveProperty('childrenPerRoom');
    }));

  it('reserves a fresh, capped Centurion strategy batch for a newer extraction of the same message', async () =>
    withSeededTestDb(async (db) => {
      const source = await seedExtraction(db, TRANSPORT_ID);
      await db.update(message).set({ messageIdHeader: `${randomUUID()}@example.test` })
        .where(eq(message.id, source.messageId));
      const config = await quotePaneConfigForProperty('HRCEN', TRANSPORT_ID);
      const count = config?.salesStrategies.length ?? 0;
      expect(count).toBeGreaterThan(0);
      const env = { ...QUOTE_ON, RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRCEN: '/tmp/centurion-quote.json',
        HMS_QUOTE_PREPARE_PER_HOUR: String(Math.max(1, count - 1)) };

      expect(await prefetchQuoteReadyForExtraction(source.run, db, env)).toBe(count);
      expect(await prefetchQuoteReadyForExtraction(source.run, db, env)).toBe(0);
      const first = await preparedRows(db, source.messageId);
      expect(first).toHaveLength(count);
      const originalId = (first[0]!.readRequest as { input: { sourceExtractionId: string } }).input.sourceExtractionId;
      expect(originalId).toBeTruthy();

      const nextId = randomUUID();
      await db.insert(mailExtraction).values({
        id: nextId, messageId: source.messageId, extractorVersion: `prepared-quote-reread-${randomUUID()}`,
        status: 'succeeded', kind: 'quote', payload: quotePayload(), createdAt: new Date(Date.now() + 1000),
      });
      expect(await prefetchQuoteReadyForExtraction(source.run, db, env)).toBe(count);
      const all = await preparedRows(db, source.messageId);
      const fresh = all.filter((row) =>
        (row.readRequest as { input: { sourceExtractionId?: string } }).input.sourceExtractionId === nextId);
      expect(all).toHaveLength(count * 2);
      expect(fresh).toHaveLength(count);
      expect(fresh.every((row) => (row.metrics as { prefetchDeferred?: boolean }).prefetchDeferred === true &&
        row.nextRunAt !== null && row.nextRunAt.getTime() > Date.now())).toBe(true);
      expect(await countPrefetchReservations(db, { transportId: TRANSPORT_ID, kind: 'staff_quote',
        since: new Date(Date.now() - 60 * 60_000) })).toMatchObject({ used: count * 2 });
    }));

  it('keeps a deferred reread behind the older extraction when the worker wakes', async () =>
    withSeededTestDb(async (db) => {
      const source = await seedExtraction(db, TRANSPORT_ID);
      await db.update(message).set({ messageIdHeader: `${randomUUID()}@example.test` })
        .where(eq(message.id, source.messageId));
      const config = await quotePaneConfigForProperty('HRCEN', TRANSPORT_ID);
      const count = config?.salesStrategies.length ?? 0;
      expect(count).toBeGreaterThan(0);
      const env = { ...QUOTE_ON, RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRCEN: '/tmp/centurion-quote.json',
        HMS_QUOTE_PREPARE_PER_HOUR: String(Math.max(1, count - 1)) };
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      vi.stubEnv('PORT', '3000');
      vi.stubEnv('BETTER_AUTH_URL', 'https://nava.legacy.local');
      vi.stubEnv('BETTER_AUTH_SECRET', 'x'.repeat(32));
      vi.stubEnv('AWS_REGION', 'synthetic-region-1');
      vi.stubEnv('S3_BUCKET', 'prepared-quote-synthetic');

      expect(await prefetchQuoteReadyForExtraction(source.run, db, env)).toBe(count);
      await db.update(aiWorkflowRun).set({ state: 'succeeded', finishedAt: new Date() })
        .where(and(eq(aiWorkflowRun.triggerMessageId, source.messageId), sql`${aiWorkflowRun.metrics}->>'quotePrepared' = 'true'`));

      const nextId = randomUUID();
      await db.insert(mailExtraction).values({ id: nextId, messageId: source.messageId,
        extractorVersion: `prepared-quote-wake-${randomUUID()}`, status: 'succeeded', kind: 'quote',
        payload: quotePayload(), createdAt: new Date(Date.now() + 1000) });
      expect(await prefetchQuoteReadyForExtraction(source.run, db, env)).toBe(count);
      const freshScope = and(eq(aiWorkflowRun.triggerMessageId, source.messageId),
        sql`${aiWorkflowRun.readRequest}->'input'->>'sourceExtractionId' = ${nextId}`);
      const fresh = await db.select().from(aiWorkflowRun).where(freshScope);
      expect(fresh).toHaveLength(count);
      expect(fresh.every((row) => (row.metrics as { prefetchDeferred?: boolean }).prefetchDeferred === true)).toBe(true);
      expect(await countPrefetchReservations(db, { transportId: TRANSPORT_ID, kind: 'staff_quote',
        since: new Date(Date.now() - 60 * 60_000),
        excludeQuoteBatch: { triggerMessageId: source.messageId, sourceExtractionId: nextId } })).toMatchObject({ used: count });

      await db.update(aiWorkflowRun).set({ nextRunAt: new Date() }).where(eq(aiWorkflowRun.id, fresh[0]!.id));
      const claimed = await claimNextAiRun({ ownerId: 'test-reread-worker', lane: 'hms', runKind: 'read_tool',
        promptVersion: HMS_JOB_PROMPT_VERSION, db });
      expect(claimed?.id).toBe(fresh[0]!.id);
      if (!claimed) throw new Error('expected deferred quote claim');
      const fence = { runId: claimed.id, claimOwner: claimed.claimOwner!, claimToken: claimed.claimToken!, deadlineAt: claimed.deadlineAt! };
      expect(await markAiRunRunning(fence, db)).toBeTruthy();
      expect(await executeHmsJob({ run: claimed, fence, db })).toBe('retry_wait');
      expect(staffQuoteRunner).not.toHaveBeenCalled();
      const after = await db.select().from(aiWorkflowRun).where(freshScope);
      expect(after.every((row) => (row.metrics as { prefetchDeferred?: boolean; prefetchBatchSize?: number }).prefetchDeferred === true &&
        (row.metrics as { prefetchBatchSize?: number }).prefetchBatchSize === count)).toBe(true);
    }));

  it.each(PROPERTY_TARGETS)('admits a complete profile strategy set as one batch for $transportId', async (target) =>
    withSeededTestDb(async (db) => {
      const config = await quotePaneConfigForProperty(target.propertyCode, target.transportId);
      expect(config).not.toBeNull();
      const strategies = config?.salesStrategies ?? [];
      expect(strategies.length).toBeGreaterThan(0);
      if (target.expectedCount !== undefined) expect(strategies).toHaveLength(target.expectedCount);
      const expected = strategies.map((strategy) => strategy.requestValue).sort();
      const cap = Math.max(1, strategies.length - 1);
      const env = {
        ...QUOTE_ON,
        [staffQuoteInstallationEnvName(target.propertyCode)]: '/tmp/prepared-quote-config.json',
        HMS_QUOTE_PREPARE_PER_HOUR: String(cap),
      };

      const first = await seedExtraction(db, target.transportId);
      expect(await prefetchQuoteReadyForExtraction(first.run, db, env)).toBe(strategies.length);
      const firstRows = await preparedRows(db, first.messageId);
      expect(firstRows).toHaveLength(strategies.length);
      expect(
        firstRows
          .map((row) => (row.readRequest as { input?: { salesStrategy?: string } } | null)?.input?.salesStrategy)
          .sort(),
      ).toEqual(expected);
      expect(
        firstRows.every(
          (row) => (row.metrics as { prefetchDeferred?: boolean } | null)?.prefetchDeferred !== true,
        ),
      ).toBe(true);
      expect(
        firstRows.every(
          (row) =>
            (row.metrics as { prefetchBatchSize?: number } | null)?.prefetchBatchSize === strategies.length,
        ),
      ).toBe(true);
      expect(
        await countPrefetchReservations(db, {
          transportId: target.transportId,
          kind: 'staff_quote',
          since: new Date(Date.now() - 60 * 60_000),
        }),
      ).toMatchObject({ used: strategies.length });

      const second = await seedExtraction(db, target.transportId);
      expect(await prefetchQuoteReadyForExtraction(second.run, db, env)).toBe(strategies.length);
      const secondRows = await preparedRows(db, second.messageId);
      expect(secondRows).toHaveLength(strategies.length);
      expect(
        secondRows.every(
          (row) =>
            (row.metrics as { prefetchDeferred?: boolean } | null)?.prefetchDeferred === true &&
            row.nextRunAt !== null &&
            row.nextRunAt.getTime() > Date.now(),
        ),
      ).toBe(true);
    }));
});
