import {
  queryMailBaselineProjection,
  reduceProjectedMailBaseline,
} from '../src/metrics/mail-baseline-repository.js';
import { aiWorkflowRun, mailboxTransport, mailThread, message } from '../src/db/schema/mail.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { claimNextAiRun, enqueueAiRun } from '../src/ai/run-ledger.js';
import { aiWorkerOwnerId, executeAiRun } from '../src/ai/worker.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

const reachable = await probeTestDb();

async function withWorkerDb<T>(callback: (db: DB) => Promise<T>): Promise<T> {
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
        const claimed = await claimNextAiRun({
          ownerId: aiWorkerOwnerId('default'),
          lane: 'default',
          transportId,
          runKind: 'inbound_triage',
          promptVersion: 'triage-v6',
          db,
        });
        expect(claimed?.id).toBe(run.id);
        const result = await executeAiRun(run.id);
        expect(result.state).toBe('succeeded');

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
        const semanticClaimed = await claimNextAiRun({
          ownerId: aiWorkerOwnerId('default'),
          lane: 'default',
          transportId: semanticTransportId,
          runKind: 'inbound_triage',
          promptVersion: 'triage-v6',
          db,
        });
        expect(semanticClaimed?.id).toBe(semanticRun.id);
        let transportCalls = 0;
        const semanticRoute = {
          routeId: 'u2-normal-worker-extraction-route',
          purpose: 'extraction' as const,
          protocol: 'in_process' as const,
          access: 'current_app' as const,
          egress: 'none' as const,
          retention: 'bounded' as const,
          usage: 'reported' as const,
          modelId: 'u2-normal-worker-extraction-model',
        };
        const semanticResult = await executeAiRun(semanticRun.id, {
          mailBaselineExtractionRoute: {
            route: semanticRoute,
            transport: async (request) => {
              transportCalls += 1;
              expect(request.modelId).toBe(semanticRoute.modelId);
              expect(request.userPrompt).toContain('Please confirm my reservation');
              return {
                output: {
                  asks: [
                    {
                      askCode: 'reservation',
                      requiresHotelResponse: true,
                      requiresCustomerInformation: false,
                      noReplyRequired: false,
                      workState: 'open',
                    },
                  ],
                  answers: [],
                },
                usage: { inputTokens: 11, outputTokens: 7, latencyMs: 3 },
              };
            },
          },
        });
        expect(semanticResult.state).toBe('succeeded');
        expect(transportCalls).toBe(1);
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
        expect(semanticMetrics.mailBaseline?.routeId).toBe(semanticRoute.routeId);
        expect(semanticMetrics.mailBaseline?.extraction).toBe('approved_local_extraction');
        expect(semanticMetrics.mailBaseline?.modelUsage).toMatchObject({
          inputTokens: 11,
          outputTokens: 7,
          latencyMs: 3,
        });
      });
    }, 30000);
  },
);
