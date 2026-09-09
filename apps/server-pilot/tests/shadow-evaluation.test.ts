import {
  SHADOW_EVALUATION_MODE,
  createShadowPredictionSeal,
  freezeShadowInput,
  validateShadowPredictionOutput,
} from '../src/ai/shadow-evaluation.js';
import { aiWorkflowRun, mailDraft, mailThread, outboundSendQueue } from '../src/db/schema/mail.js';
import { aiShadowAssessment, aiShadowPrediction } from '../src/db/schema/ai-shadow-evaluation.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { createProductionShadowModelRouteFactory } from '../src/ai/bedrock/factory.js';
import { parseRawMessage } from '../src/mail/ingest/parse-message.js';
import { persistInboundMessage } from '../src/mail/ingest/store.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { runAiWorkerDrain } from '../src/ai/worker.js';
import { FakeS3Storage } from '../src/storage/s3.js';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';

const asOfAt = new Date('2026-09-01T10:00:00.000Z');

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

async function withAiWriteGate<T>(callback: () => Promise<T>): Promise<T> {
  const previous = process.env.AI_WRITE_GATE_ENABLED;
  process.env.AI_WRITE_GATE_ENABLED = 'true';
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.AI_WRITE_GATE_ENABLED;
    else process.env.AI_WRITE_GATE_ENABLED = previous;
  }
}

const configuredShadowFixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'u13-approved-local-shadow.cjs',
);
const configuredShadowDescriptor = JSON.stringify({
  module: configuredShadowFixturePath,
  route: {
    routeId: 'u13-configured-shadow-route',
    purpose: 'shadow',
    protocol: 'in_process',
    access: 'current_app',
    egress: 'none',
    retention: 'bounded',
    usage: 'reported',
    modelId: 'u13-configured-shadow-model',
  },
});
const configuredShadowFixture = createRequire(import.meta.url)(configuredShadowFixturePath) as {
  getTransportCalls: () => number;
  resetTransportCalls: () => void;
};

async function withConfiguredShadowRoute<T>(callback: () => Promise<T>): Promise<T> {
  const previousRoute = process.env.AI_MODEL_ROUTE;
  const previousConfig = process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG;
  process.env.AI_MODEL_ROUTE = 'approved-local';
  process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG = configuredShadowDescriptor;
  try {
    return await callback();
  } finally {
    if (previousRoute === undefined) delete process.env.AI_MODEL_ROUTE;
    else process.env.AI_MODEL_ROUTE = previousRoute;
    if (previousConfig === undefined) delete process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG;
    else process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG = previousConfig;
  }
}

async function withNoConfiguredShadowRoute<T>(callback: () => Promise<T>): Promise<T> {
  const previousRoute = process.env.AI_MODEL_ROUTE;
  const previousConfig = process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG;
  delete process.env.AI_MODEL_ROUTE;
  delete process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG;
  try {
    return await callback();
  } finally {
    if (previousRoute === undefined) delete process.env.AI_MODEL_ROUTE;
    else process.env.AI_MODEL_ROUTE = previousRoute;
    if (previousConfig === undefined) delete process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG;
    else process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG = previousConfig;
  }
}

function inboundRaw(input: { messageId: string; body: string; date: string }): Buffer {
  return Buffer.from(
    [
      'From: Guest <guest@example.test>',
      'To: centurion@legacyhotel.com',
      'X-Zero-Mailbox: centurion@legacyhotel.com',
      `Date: ${input.date}`,
      `Message-ID: <${input.messageId}@example.test>`,
      'Subject: Reservation request',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      input.body,
    ].join('\r\n'),
    'utf8',
  );
}

function outboundRaw(input: { messageId: string; inReplyTo: string; date: string }): Buffer {
  return Buffer.from(
    [
      'From: Centurion Reservations <centurion@legacyhotel.com>',
      'To: guest@example.test',
      'X-Zero-Mailbox: centurion@legacyhotel.com',
      `Date: ${input.date}`,
      `Message-ID: <${input.messageId}@legacyhotel.com>`,
      `In-Reply-To: <${input.inReplyTo}>`,
      `References: <${input.inReplyTo}>`,
      'Subject: Re: Reservation request',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'We can confirm the reservation request is being reviewed.',
    ].join('\r\n'),
    'utf8',
  );
}

describe('private shadow evaluation lifecycle', () => {
  it('freezes only pre-reply messages before context preparation', () => {
    const frozen = freezeShadowInput({
      transportId: 'transport-1',
      threadId: 'thread-1',
      triggerMessageId: 'inbound-1',
      asOfAt,
      messages: [
        {
          id: 'inbound-1',
          direction: 'inbound',
          subject: 'Reservation',
          textBody: 'Please confirm reservation CONF-1234.',
          htmlBody: null,
          receivedAt: new Date('2026-09-01T09:59:00.000Z'),
          sentAt: null,
          createdAt: new Date('2026-09-01T09:59:00.000Z'),
          attachmentIds: ['attachment-before'],
        },
        {
          id: 'future-reply',
          direction: 'outbound',
          subject: 'Confirmed',
          textBody: 'Confirmed.',
          htmlBody: null,
          receivedAt: null,
          sentAt: new Date('2026-09-01T10:01:00.000Z'),
          createdAt: new Date('2026-09-01T10:01:00.000Z'),
          attachmentIds: ['attachment-future'],
        },
      ],
    });

    expect(frozen.messageIds).toEqual(['inbound-1']);
    expect(frozen.excludedFutureMessageIds).toEqual(['future-reply']);
    expect(frozen.attachmentIds).toEqual(['attachment-before']);
    expect(frozen.asOfAt).toBe(asOfAt.toISOString());
    expect(frozen.inputDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('seals an immutable private prediction with route and lineage provenance', () => {
    const frozen = freezeShadowInput({
      transportId: 'transport-1',
      threadId: 'thread-1',
      triggerMessageId: 'inbound-1',
      asOfAt,
      messages: [
        {
          id: 'inbound-1',
          direction: 'inbound',
          subject: 'Reservation',
          textBody: 'Please confirm reservation CONF-1234.',
          htmlBody: null,
          receivedAt: new Date('2026-09-01T09:59:00.000Z'),
          sentAt: null,
          createdAt: new Date('2026-09-01T09:59:00.000Z'),
          attachmentIds: [],
        },
      ],
    });
    const seal = createShadowPredictionSeal({
      predictionKey: 'shadow:key-1',
      transportId: 'transport-1',
      threadId: 'thread-1',
      triggerMessageId: 'inbound-1',
      frozen,
      output: {
        outcome: 'partial',
        textBody: 'I can confirm the request is pending review.',
        asks: ['reservation_status'],
        facts: { reservationRef: 'CONF-1234' },
        limitations: ['reservation source unavailable'],
      },
      route: {
        routeId: 'local-shadow',
        purpose: 'shadow',
        protocol: 'in_process',
        access: 'current_app',
        egress: 'none',
        retention: 'bounded',
        usage: 'reported',
        modelId: 'shadow-model-v1',
      },
      modelUsage: { inputTokens: 10, outputTokens: 7, latencyMs: 4 },
      sealedAt: new Date('2026-09-01T10:00:01.000Z'),
    });

    expect(seal).toMatchObject({
      predictionKey: 'shadow:key-1',
      evaluationMode: SHADOW_EVALUATION_MODE,
      predictionStatus: 'sealed',
      admissionStatus: 'admitted',
      triggerMessageId: 'inbound-1',
      asOfAt: asOfAt.toISOString(),
      lineage: expect.objectContaining({ messageIds: ['inbound-1'], attachmentIds: [] }),
    });
    expect(JSON.stringify(seal)).not.toContain('future-reply');
  });

  it('rejects malformed model output instead of treating it as a successful seal', () => {
    expect(() => validateShadowPredictionOutput({ outcome: 'complete', textBody: 42 })).toThrow();
    expect(() => validateShadowPredictionOutput({ outcome: 'complete', unknown: true })).toThrow();
  });

  it('fails closed before configured shadow transport initialization when the route is absent', () => {
    const previousRoute = process.env.AI_MODEL_ROUTE;
    const previousConfig = process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG;
    delete process.env.AI_MODEL_ROUTE;
    delete process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG;
    try {
      expect(createProductionShadowModelRouteFactory()()).toBeUndefined();
    } finally {
      if (previousRoute === undefined) delete process.env.AI_MODEL_ROUTE;
      else process.env.AI_MODEL_ROUTE = previousRoute;
      if (previousConfig === undefined) delete process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG;
      else process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG = previousConfig;
    }
  });
});

if (TEST_DB_AVAILABLE && reachable)
  describe('private shadow committed lifecycle', () => {
    it('uses the normal ingest producer, claims the private queue, seals once, and rematches a later outbound ingest', async () => {
      await withConfiguredShadowRoute(() =>
        withAiWriteGate(() =>
          withWorkerDb(async (db) => {
            const storage = new FakeS3Storage(`u13-shadow-${randomUUID()}`);
            const token = randomUUID();
            const inboundId = `u13-inbound-${token}`;
            const inboundHeader = `${inboundId}@example.test`;
            const inboundRawMessage = inboundRaw({
              messageId: inboundId,
              body: 'Please confirm reservation U13-1234.',
              date: 'Tue, 01 Sep 2026 09:00:00 +0000',
            });
            const inboundParsed = await parseRawMessage(inboundRawMessage, {
              messageId: inboundId,
              storage,
            });
            const storedInbound = await persistInboundMessage(
              inboundParsed,
              inboundRawMessage,
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: `u13-inbound-${token}`,
                messageId: inboundId,
              },
              { db, storage },
            );
            expect(storedInbound.kind).toBe('stored');
            if (storedInbound.kind !== 'stored') return;

            const [threadBeforeWorker] = await db
              .select({
                id: mailThread.id,
                isRead: mailThread.isRead,
                labelIds: mailThread.labelIds,
              })
              .from(mailThread)
              .where(eq(mailThread.id, storedInbound.threadId));
            expect(threadBeforeWorker?.isRead).toBe(false);
            expect(threadBeforeWorker?.labelIds).toEqual([]);

            configuredShadowFixture.resetTransportCalls();
            const drain = await runAiWorkerDrain({
              transportId: storedInbound.transportId,
              threadId: storedInbound.threadId,
              triggerMessageId: storedInbound.messageId,
              runKind: 'shadow_prediction',
              timeoutMs: 5_000,
              pollIntervalMs: 10,
            });
            expect(drain).toMatchObject({ ok: true, reason: 'drained', processed: 1 });
            expect(configuredShadowFixture.getTransportCalls()).toBe(1);

            const predictions = await db
              .select()
              .from(aiShadowPrediction)
              .where(eq(aiShadowPrediction.triggerMessageId, storedInbound.messageId));
            expect(predictions).toHaveLength(1);
            expect(predictions[0]).toMatchObject({
              evaluationMode: SHADOW_EVALUATION_MODE,
              admissionStatus: 'admitted',
              predictionStatus: 'sealed',
              messageIds: [storedInbound.messageId],
              excludedFutureMessageIds: [],
              modelId: 'u13-configured-shadow-model',
            });
            expect(predictions[0]?.prediction).toMatchObject({ outcome: 'partial' });

            const [pendingAssessment] = await db
              .select()
              .from(aiShadowAssessment)
              .where(eq(aiShadowAssessment.predictionId, predictions[0]!.id))
              .orderBy(aiShadowAssessment.revision);
            expect(pendingAssessment).toMatchObject({ revision: 1, status: 'pending' });

            const [run] = await db
              .select()
              .from(aiWorkflowRun)
              .where(
                and(
                  eq(aiWorkflowRun.triggerMessageId, storedInbound.messageId),
                  eq(aiWorkflowRun.runKind, 'shadow_prediction'),
                ),
              );
            expect(run?.state).toBe('succeeded');
            expect(run?.metrics).toMatchObject({
              shadow: { evaluationMode: SHADOW_EVALUATION_MODE, predictionStatus: 'sealed' },
            });
            expect(run?.metrics).not.toHaveProperty('textBody');

            const [threadAfterWorker] = await db
              .select({ isRead: mailThread.isRead, labelIds: mailThread.labelIds })
              .from(mailThread)
              .where(eq(mailThread.id, storedInbound.threadId));
            expect(threadAfterWorker?.isRead).toBe(false);
            expect(threadAfterWorker?.labelIds).toEqual([]);
            expect(
              await db
                .select()
                .from(mailDraft)
                .where(eq(mailDraft.threadId, storedInbound.threadId)),
            ).toHaveLength(0);
            expect(
              await db
                .select()
                .from(outboundSendQueue)
                .where(eq(outboundSendQueue.messageId, storedInbound.messageId)),
            ).toHaveLength(0);

            // Restart/drain is idempotent: the already-terminal shadow run and
            // immutable prediction do not create a second seal.
            const secondDrain = await runAiWorkerDrain({
              transportId: storedInbound.transportId,
              threadId: storedInbound.threadId,
              triggerMessageId: storedInbound.messageId,
              runKind: 'shadow_prediction',
              timeoutMs: 200,
              pollIntervalMs: 10,
            });
            expect(secondDrain).toMatchObject({ ok: true, reason: 'drained', processed: 0 });
            expect(configuredShadowFixture.getTransportCalls()).toBe(1);

            const outboundId = `u13-outbound-${token}`;
            const outboundRawMessage = outboundRaw({
              messageId: outboundId,
              inReplyTo: inboundHeader,
              date: 'Tue, 01 Sep 2026 10:00:00 +0000',
            });
            const outboundParsed = await parseRawMessage(outboundRawMessage, {
              messageId: outboundId,
              storage,
            });
            const storedOutbound = await persistInboundMessage(
              outboundParsed,
              outboundRawMessage,
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: `u13-outbound-${token}`,
                messageId: outboundId,
              },
              { db, storage, directionOverride: 'outbound' },
            );
            expect(storedOutbound.kind).toBe('stored');
            if (storedOutbound.kind !== 'stored') return;
            expect(storedOutbound.threadId).toBe(storedInbound.threadId);

            const assessmentsAfterOutbound = await db
              .select()
              .from(aiShadowAssessment)
              .where(eq(aiShadowAssessment.predictionId, predictions[0]!.id))
              .orderBy(aiShadowAssessment.revision);
            expect(assessmentsAfterOutbound).toHaveLength(2);
            expect(assessmentsAfterOutbound[1]).toMatchObject({
              revision: 2,
              status: 'matched',
              referenceMessageId: storedOutbound.messageId,
              linkStrength: 'header',
            });

            // Re-delivering the same outbound item is safe: the append-only
            // revision key prevents a duplicate assessment.
            await persistInboundMessage(
              outboundParsed,
              outboundRawMessage,
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: `u13-outbound-${token}`,
                messageId: outboundId,
              },
              { db, storage, directionOverride: 'outbound' },
            );
            expect(
              await db
                .select()
                .from(aiShadowAssessment)
                .where(eq(aiShadowAssessment.predictionId, predictions[0]!.id)),
            ).toHaveLength(2);
          }),
        ),
      );
    }, 30_000);

    it('persists unavailable before model initialization when the approved route is missing', async () => {
      await withNoConfiguredShadowRoute(() =>
        withAiWriteGate(() =>
          withWorkerDb(async (db) => {
            const storage = new FakeS3Storage(`u13-shadow-unavailable-${randomUUID()}`);
            const token = randomUUID();
            const inboundId = `u13-unavailable-inbound-${token}`;
            const raw = inboundRaw({
              messageId: inboundId,
              body: 'Please confirm reservation U13-unavailable.',
              date: 'Tue, 01 Sep 2026 11:00:00 +0000',
            });
            const parsed = await parseRawMessage(raw, { messageId: inboundId, storage });
            const stored = await persistInboundMessage(
              parsed,
              raw,
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: `u13-unavailable-${token}`,
                messageId: inboundId,
              },
              { db, storage },
            );
            expect(stored.kind).toBe('stored');
            if (stored.kind !== 'stored') return;

            configuredShadowFixture.resetTransportCalls();
            const drain = await runAiWorkerDrain({
              transportId: stored.transportId,
              threadId: stored.threadId,
              triggerMessageId: stored.messageId,
              runKind: 'shadow_prediction',
              timeoutMs: 5_000,
              pollIntervalMs: 10,
            });
            expect(drain).toMatchObject({ ok: true, reason: 'drained', processed: 1 });
            expect(configuredShadowFixture.getTransportCalls()).toBe(0);

            const [prediction] = await db
              .select()
              .from(aiShadowPrediction)
              .where(eq(aiShadowPrediction.triggerMessageId, stored.messageId));
            expect(prediction).toMatchObject({
              admissionStatus: 'admitted',
              predictionStatus: 'unavailable',
              modelId: null,
              route: null,
              unavailableReason: 'approved_shadow_route_unavailable',
            });
            const [run] = await db
              .select()
              .from(aiWorkflowRun)
              .where(
                and(
                  eq(aiWorkflowRun.triggerMessageId, stored.messageId),
                  eq(aiWorkflowRun.runKind, 'shadow_prediction'),
                ),
              );
            expect(run?.state).toBe('succeeded');
            expect(run?.metrics).toMatchObject({
              shadow: {
                predictionStatus: 'unavailable',
                routeStatus: 'unavailable',
                reason: 'approved_shadow_route_unavailable',
              },
            });
          }),
        ),
      );
    }, 30_000);
  });
