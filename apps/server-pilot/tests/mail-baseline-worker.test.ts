import {
  aiWorkflowRun,
  mailDraft,
  mailIngestMailbox,
  mailboxTransport,
  mailThread,
  message,
  outboundSendQueue,
} from '../src/db/schema/mail.js';
import {
  queryMailBaselineProjection,
  reduceProjectedMailBaseline,
} from '../src/metrics/mail-baseline-repository.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { parseAndPersist } from '../src/mail/ingest/store.js';
import { enqueueAiRun } from '../src/ai/run-ledger.js';
import { runAiWorkerDrain } from '../src/ai/worker.js';
import { FakeS3Storage } from '../src/storage/s3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';

const require = createRequire(import.meta.url);
const configuredExtractionFixture = require(
  join(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'u2-second-approved-local-extraction.cjs',
  ),
) as {
  getTransportCalls: () => number;
  resetTransportCalls: () => void;
};
const configuredExtractionFixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'u2-second-approved-local-extraction.cjs',
);
const configuredExtractionDescriptor = JSON.stringify({
  module: configuredExtractionFixturePath,
  route: {
    routeId: 'u2-configured-extraction-route',
    purpose: 'extraction',
    protocol: 'in_process',
    access: 'current_app',
    egress: 'none',
    retention: 'bounded',
    usage: 'reported',
    modelId: 'u2-configured-extraction-model',
  },
});

const reachable = await probeTestDb();

afterEach(() => {
  vi.unstubAllEnvs();
});

async function withWorkerDb<T>(callback: (db: DB) => Promise<T>): Promise<T> {
  // The worker's parseEnv needs the server's required keys. The rest of the lane config stays unset.
  vi.stubEnv('PORT', '3000');
  vi.stubEnv('BETTER_AUTH_URL', 'https://nava.legacy.local');
  vi.stubEnv('BETTER_AUTH_SECRET', 'x'.repeat(32));
  vi.stubEnv('AWS_REGION', 'synthetic-region-1');
  vi.stubEnv('S3_BUCKET', 'mail-baseline-synthetic-bucket');
  return withSeededTestDb(async (db) => {
    __setDbForTests({ db, conn: null as never });
    try {
      return await callback(db);
    } finally {
      __setDbForTests(null);
    }
  });
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'mail baseline committed inbound producer',
  () => {
    it('persists one worker generation and serves the bounded reduced projection', async () => {
      await withWorkerDb(async (db) => {
        const transportId = `u2-worker-transport-${randomUUID()}`;
        const threadId = `u2-worker-thread-${randomUUID()}`;
        const messageId = `u2-worker-message-${randomUUID()}`;
        const now = new Date(Date.now() - 60_000);
        await db.insert(mailboxTransport).values({
          id: transportId,
          email: `${transportId.slice(0, 18)}@example.test`,
          ownerHeaderValue: `${transportId.slice(0, 18)}@example.test`,
        });
        await db.insert(mailThread).values({
          id: threadId,
          transportId,
          threadRootId: `<${threadId}@example.test>`,
          subject: 'Please confirm my reservation',
          snippet: 'Please confirm my reservation',
          createdAt: now,
          updatedAt: now,
          latestMessageAt: now,
        });
        await db.insert(message).values({
          id: messageId,
          transportId,
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.test',
          toAddresses: ['hotel@example.test'],
          ccAddresses: [],
          bccAddresses: [],
          subject: 'Please confirm my reservation',
          textBody: 'Please confirm my reservation for next week.',
          messageIdHeader: `<${messageId}@example.test>`,
          receivedAt: now,
          createdAt: now,
          updatedAt: now,
        });

        const run = await enqueueAiRun(
          {
            transportId,
            threadId,
            triggerMessageId: messageId,
            runKind: 'inbound_triage',
            idempotencyKey: `u2-worker-generation-${messageId}`,
            modelId: 'not_applicable',
            promptVersion: 'triage-v6',
          },
          db,
        );
        expect(
          await runAiWorkerDrain({
            transportId,
            runKind: 'inbound_triage',
            promptVersion: 'triage-v6',
            timeoutMs: 5_000,
            pollIntervalMs: 10,
          }),
        ).toMatchObject({ ok: true, reason: 'drained', processed: 1 });

        const rows = await queryMailBaselineProjection(db, {
          transportIds: [transportId],
          threadIds: [threadId],
          observationCutoff: new Date(),
          limit: 20,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          sourceMessageId: messageId,
          direction: 'inbound',
          eventKind: 'ask',
        });
        expect(rows[0]).not.toHaveProperty('textBody');
        const reduced = reduceProjectedMailBaseline(rows, {
          transportId,
          threadId,
          observationCutoff: new Date(),
          sourceVintage: rows[0]!.sourceVintage,
          interpretationVersion: rows[0]!.interpretationVersion,
        });
        expect(reduced.primaryBucket).toBe('unknown');

        const [runRow] = await db
          .select({ metrics: aiWorkflowRun.metrics })
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, run.id));
        expect(runRow?.metrics).toMatchObject({
          mailBaseline: expect.objectContaining({
            status: 'persisted_source_observation',
            routeStatus: 'unavailable',
            extraction: 'unavailable_source_observation',
          }),
        });

        const semanticTransportId = `u2-worker-semantic-transport-${randomUUID()}`;
        const semanticThreadId = `u2-worker-semantic-thread-${randomUUID()}`;
        const semanticMessageId = `u2-worker-semantic-message-${randomUUID()}`;
        await db.insert(mailboxTransport).values({
          id: semanticTransportId,
          email: `${semanticTransportId.slice(0, 18)}@example.test`,
          ownerHeaderValue: `${semanticTransportId.slice(0, 18)}@example.test`,
        });
        await db.insert(mailThread).values({
          id: semanticThreadId,
          transportId: semanticTransportId,
          threadRootId: `<${semanticThreadId}@example.test>`,
          subject: 'Please confirm my reservation',
          snippet: 'Please confirm my reservation',
          createdAt: now,
          updatedAt: now,
          latestMessageAt: now,
        });
        await db.insert(message).values({
          id: semanticMessageId,
          transportId: semanticTransportId,
          threadId: semanticThreadId,
          direction: 'inbound',
          fromAddress: 'guest@example.test',
          toAddresses: ['hotel@example.test'],
          ccAddresses: [],
          bccAddresses: [],
          subject: 'Please confirm my reservation',
          textBody: 'Please confirm my reservation for next week.',
          messageIdHeader: `<${semanticMessageId}@example.test>`,
          receivedAt: now,
          createdAt: now,
          updatedAt: now,
        });
        const semanticRun = await enqueueAiRun(
          {
            transportId: semanticTransportId,
            threadId: semanticThreadId,
            triggerMessageId: semanticMessageId,
            runKind: 'inbound_triage',
            idempotencyKey: `u2-worker-semantic-generation-${semanticMessageId}`,
            modelId: 'not_applicable',
            promptVersion: 'triage-v6',
          },
          db,
        );
        const priorRoute = process.env.AI_MODEL_ROUTE;
        const priorModule = process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE;
        const priorConfig = process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG;
        process.env.AI_MODEL_ROUTE = 'approved-local';
        delete process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE;
        process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG = configuredExtractionDescriptor;
        configuredExtractionFixture.resetTransportCalls();
        let semanticDrain;
        try {
          semanticDrain = await runAiWorkerDrain({
            transportId: semanticTransportId,
            runKind: 'inbound_triage',
            promptVersion: 'triage-v6',
            timeoutMs: 5_000,
            pollIntervalMs: 10,
          });
        } finally {
          if (priorRoute === undefined) delete process.env.AI_MODEL_ROUTE;
          else process.env.AI_MODEL_ROUTE = priorRoute;
          if (priorModule === undefined) delete process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE;
          else process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE = priorModule;
          if (priorConfig === undefined) delete process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG;
          else process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG = priorConfig;
        }
        expect(semanticDrain).toMatchObject({ ok: true, reason: 'drained', processed: 1 });
        expect(configuredExtractionFixture.getTransportCalls()).toBe(1);
        const semanticRows = await queryMailBaselineProjection(db, {
          transportIds: [semanticTransportId],
          threadIds: [semanticThreadId],
          observationCutoff: new Date(),
          limit: 20,
        });
        expect(semanticRows).toHaveLength(1);
        const semanticReduced = reduceProjectedMailBaseline(semanticRows, {
          transportId: semanticTransportId,
          threadId: semanticThreadId,
          observationCutoff: new Date(),
          sourceVintage: semanticRows[0]!.sourceVintage,
          interpretationVersion: semanticRows[0]!.interpretationVersion,
        });
        expect(semanticReduced.primaryBucket).toBe('awaiting_hotel_reply');
        const [semanticRunRow] = await db
          .select({ metrics: aiWorkflowRun.metrics })
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, semanticRun.id));
        const semanticMetrics = semanticRunRow?.metrics as {
          mailBaseline?: {
            status?: string;
            routeStatus?: string;
            routeId?: string | null;
            extraction?: string;
            modelUsage?: { inputTokens?: number; outputTokens?: number; latencyMs?: number };
          };
        };
        expect(semanticMetrics.mailBaseline?.status).toBe('persisted_semantic_projection');
        expect(semanticMetrics.mailBaseline?.routeStatus).toBe('available');
        expect(semanticMetrics.mailBaseline?.routeId).toBe('u2-configured-extraction-route');
        expect(semanticMetrics.mailBaseline?.extraction).toBe('approved_local_extraction');
        expect(semanticMetrics.mailBaseline?.modelUsage).toMatchObject({
          inputTokens: 13,
          outputTokens: 9,
          latencyMs: 4,
        });
      });
    }, 30000);
  },
);

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'mail baseline external Sent ingest producer',
  () => {
    it('commits an external Sent copy into one idempotent baseline generation without a Nava outbox row', async () => {
      await withWorkerDb(async (db) => {
        const transportId = `u2-external-sent-transport-${randomUUID()}`;
        const ingestMailboxId = `u2-external-sent-mailbox-${randomUUID()}`;
        const requestPop3Uidl = `u2-external-request-uidl-${randomUUID()}`;
        const sentPop3Uidl = `u2-external-sent-uidl-${randomUUID()}`;
        const requestAt = new Date(Date.now() - 120_000);
        const now = new Date(Date.now() - 60_000);
        const requestMessageIdHeader = `<external-request-${randomUUID()}@example.test>`;
        const messageIdHeader = `<external-sent-${randomUUID()}@example.test>`;
        const requestRaw = Buffer.from(
          [
            'From: guest@example.test',
            'To: hotel@example.test',
            'X-Zero-Mailbox: hotel@example.test',
            `Date: ${requestAt.toUTCString()}`,
            `Message-ID: ${requestMessageIdHeader}`,
            'Subject: Please confirm my reservation',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Please confirm my reservation for next week.',
          ].join('\r\n'),
          'utf8',
        );
        const sentRaw = Buffer.from(
          [
            'From: hotel@example.test',
            'To: guest@example.test',
            'X-Zero-Mailbox: hotel@example.test',
            `Date: ${now.toUTCString()}`,
            `Message-ID: ${messageIdHeader}`,
            `In-Reply-To: ${requestMessageIdHeader}`,
            `References: ${requestMessageIdHeader}`,
            'Subject: Your reservation is confirmed',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Your reservation is confirmed for next week.',
          ].join('\r\n'),
          'utf8',
        );
        const storage = new FakeS3Storage('u2-external-sent-bucket');

        await db.insert(mailIngestMailbox).values({
          id: ingestMailboxId,
          email: `${ingestMailboxId.slice(0, 24)}@example.test`,
        });
        await db.insert(mailboxTransport).values({
          id: transportId,
          email: 'hotel@example.test',
          ownerHeaderValue: 'hotel@example.test',
        });

        const storedRequest = await parseAndPersist(
          requestRaw,
          { ingestMailboxId, pop3Uidl: requestPop3Uidl },
          { db, storage },
        );
        expect(storedRequest.kind).toBe('stored');
        if (storedRequest.kind !== 'stored') return;

        const stored = await parseAndPersist(
          sentRaw,
          { ingestMailboxId, pop3Uidl: sentPop3Uidl },
          { db, storage },
        );
        expect(stored.kind).toBe('stored');
        if (stored.kind !== 'stored') return;

        const [storedMessage] = await db
          .select({ id: message.id, direction: message.direction, receivedAt: message.receivedAt })
          .from(message)
          .where(eq(message.id, stored.messageId));
        expect(storedMessage).toMatchObject({ id: stored.messageId, direction: 'outbound' });
        expect(storedMessage?.receivedAt?.getTime()).toBe(Math.floor(now.getTime() / 1000) * 1000);

        const queuedRuns = await db
          .select({ id: aiWorkflowRun.id, idempotencyKey: aiWorkflowRun.idempotencyKey })
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.triggerMessageId, stored.messageId));
        expect(queuedRuns).toHaveLength(1);
        expect(queuedRuns[0]?.idempotencyKey).toBe(`external-sent-baseline:${stored.messageId}`);
        const [threadBeforeWorker] = await db
          .select({
            labelIds: mailThread.labelIds,
            isRead: mailThread.isRead,
            isStarred: mailThread.isStarred,
            isArchived: mailThread.isArchived,
            spamAt: mailThread.spamAt,
          })
          .from(mailThread)
          .where(eq(mailThread.id, stored.threadId));

        const priorRoute = process.env.AI_MODEL_ROUTE;
        const priorModule = process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE;
        const priorConfig = process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG;
        const priorMeasurementConfig = process.env.MAIL_MEASUREMENT_CONFIG_JSON;
        process.env.AI_MODEL_ROUTE = 'approved-local';
        delete process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE;
        process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG = configuredExtractionDescriptor;
        process.env.MAIL_MEASUREMENT_CONFIG_JSON = JSON.stringify({
          version: 1,
          transportId,
          cohortId: 'centurion',
          measurementStartAt: '2026-09-01T00:00:00.000Z',
          captureAssumptionBasis: 'u2-test-two-way-feed',
          confirmedGapIntervals: [],
        });
        configuredExtractionFixture.resetTransportCalls();
        let drain;
        try {
          drain = await runAiWorkerDrain({
            transportId,
            runKind: 'inbound_triage',
            promptVersion: 'triage-v6',
            idempotencyPrefix: 'external-sent-baseline:',
            timeoutMs: 5_000,
            pollIntervalMs: 10,
          });
        } finally {
          if (priorRoute === undefined) delete process.env.AI_MODEL_ROUTE;
          else process.env.AI_MODEL_ROUTE = priorRoute;
          if (priorModule === undefined) delete process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE;
          else process.env.AI_APPROVED_LOCAL_EXTRACTION_MODULE = priorModule;
          if (priorConfig === undefined) delete process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG;
          else process.env.AI_APPROVED_LOCAL_EXTRACTION_CONFIG = priorConfig;
          if (priorMeasurementConfig === undefined) delete process.env.MAIL_MEASUREMENT_CONFIG_JSON;
          else process.env.MAIL_MEASUREMENT_CONFIG_JSON = priorMeasurementConfig;
        }
        expect(drain).toMatchObject({ ok: true, reason: 'drained', processed: 1 });
        expect(configuredExtractionFixture.getTransportCalls()).toBe(1);
        const [threadAfterWorker] = await db
          .select({
            labelIds: mailThread.labelIds,
            isRead: mailThread.isRead,
            isStarred: mailThread.isStarred,
            isArchived: mailThread.isArchived,
            spamAt: mailThread.spamAt,
          })
          .from(mailThread)
          .where(eq(mailThread.id, stored.threadId));
        expect(threadAfterWorker).toEqual(threadBeforeWorker);
        expect(
          await db
            .select({ id: mailDraft.id })
            .from(mailDraft)
            .where(eq(mailDraft.threadId, stored.threadId)),
        ).toHaveLength(0);
        expect(
          await db
            .select({ id: outboundSendQueue.id })
            .from(outboundSendQueue)
            .where(eq(outboundSendQueue.messageId, stored.messageId)),
        ).toHaveLength(0);
        const [externalRun] = await db
          .select({ metrics: aiWorkflowRun.metrics })
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.triggerMessageId, stored.messageId));
        expect(externalRun?.metrics).toMatchObject({
          applyMode: 'analytics_only_external_sent',
          mailBaseline: expect.objectContaining({
            routeId: 'u2-configured-extraction-route',
            extraction: 'approved_local_extraction',
          }),
        });

        const rows = await queryMailBaselineProjection(db, {
          transportIds: [transportId],
          threadIds: [stored.threadId],
          observationCutoff: new Date(),
          limit: 20,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          sourceMessageId: stored.messageId,
          source: 'external_sent',
          direction: 'outbound',
          measurementStartAt: new Date('2026-09-01T00:00:00.000Z'),
          coverage: expect.objectContaining({
            configVersion: '1',
            basis: 'u2-test-two-way-feed',
          }),
          evidence: expect.objectContaining({ delivery: { status: 'sent' } }),
        });
        const reduced = reduceProjectedMailBaseline(rows, {
          transportId,
          threadId: stored.threadId,
          observationCutoff: new Date(),
          sourceVintage: rows[0]!.sourceVintage,
          interpretationVersion: rows[0]!.interpretationVersion,
        });
        expect(reduced.primaryBucket).toBe('answered');

        const duplicate = await parseAndPersist(
          sentRaw,
          { ingestMailboxId, pop3Uidl: sentPop3Uidl },
          { db, storage },
        );
        expect(duplicate.kind).toBe('duplicate');
        const rerunCount = await db
          .select({ id: aiWorkflowRun.id })
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.triggerMessageId, stored.messageId));
        expect(rerunCount).toHaveLength(1);
      });
    }, 30000);
  },
);
