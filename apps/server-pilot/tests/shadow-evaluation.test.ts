import {
  SHADOW_EVALUATION_MODE,
  createShadowPredictionSeal,
  enqueueShadowPrediction,
  freezeShadowInput,
  shadowAdmissionReleaseId,
  shouldAdmitShadowPrediction,
  shadowPredictionKey,
  validateShadowPredictionOutput,
} from '../src/ai/shadow-evaluation.js';
import {
  aiShadowAdmission,
  aiShadowAssessment,
  aiShadowPrediction,
} from '../src/db/schema/ai-shadow-evaluation.js';
import {
  aiWorkflowRun,
  mailDraft,
  mailThread,
  message,
  outboundSendQueue,
} from '../src/db/schema/mail.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { createProductionShadowModelRouteFactory } from '../src/ai/bedrock/factory.js';
import { runAiWorkerDrain, runAiWorkerOnce } from '../src/ai/worker.js';
import { parseRawMessage } from '../src/mail/ingest/parse-message.js';
import { persistInboundMessage } from '../src/mail/ingest/store.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { FakeS3Storage } from '../src/storage/s3.js';
import { appRouter } from '../src/trpc/router.js';
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
const shadowTestCap = '100';
const shadowTestCapScope = 'u13-test-property';
const shadowTestTokenCap = '100000';
const shadowTestSpendCapUsd = '100';
const shadowTestBrowserCap = '1';
const shadowTestExecutionMode = 'local_synthetic';

async function withConfiguredShadowRoute<T>(callback: () => Promise<T>): Promise<T> {
  const previousRoute = process.env.AI_MODEL_ROUTE;
  const previousConfig = process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG;
  const previousCap = process.env.AI_SHADOW_ADMISSION_CAP_PER_DAY;
  const previousCapScope = process.env.AI_SHADOW_CAP_SCOPE;
  const previousTokenCap = process.env.AI_SHADOW_TOKEN_CAP_PER_DAY;
  const previousSpendCapUsd = process.env.AI_SHADOW_SPEND_CAP_USD_PER_DAY;
  const previousBrowserCap = process.env.AI_SHADOW_BROWSER_CAP_PER_DAY;
  const previousExecutionMode = process.env.AI_SHADOW_EXECUTION_MODE;
  process.env.AI_MODEL_ROUTE = 'approved-local';
  process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG = configuredShadowDescriptor;
  process.env.AI_SHADOW_ADMISSION_CAP_PER_DAY = shadowTestCap;
  process.env.AI_SHADOW_CAP_SCOPE = shadowTestCapScope;
  process.env.AI_SHADOW_TOKEN_CAP_PER_DAY = shadowTestTokenCap;
  process.env.AI_SHADOW_SPEND_CAP_USD_PER_DAY = shadowTestSpendCapUsd;
  process.env.AI_SHADOW_BROWSER_CAP_PER_DAY = shadowTestBrowserCap;
  process.env.AI_SHADOW_EXECUTION_MODE = shadowTestExecutionMode;
  try {
    return await callback();
  } finally {
    if (previousRoute === undefined) delete process.env.AI_MODEL_ROUTE;
    else process.env.AI_MODEL_ROUTE = previousRoute;
    if (previousConfig === undefined) delete process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG;
    else process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG = previousConfig;
    if (previousCap === undefined) delete process.env.AI_SHADOW_ADMISSION_CAP_PER_DAY;
    else process.env.AI_SHADOW_ADMISSION_CAP_PER_DAY = previousCap;
    if (previousCapScope === undefined) delete process.env.AI_SHADOW_CAP_SCOPE;
    else process.env.AI_SHADOW_CAP_SCOPE = previousCapScope;
    if (previousTokenCap === undefined) delete process.env.AI_SHADOW_TOKEN_CAP_PER_DAY;
    else process.env.AI_SHADOW_TOKEN_CAP_PER_DAY = previousTokenCap;
    if (previousSpendCapUsd === undefined) delete process.env.AI_SHADOW_SPEND_CAP_USD_PER_DAY;
    else process.env.AI_SHADOW_SPEND_CAP_USD_PER_DAY = previousSpendCapUsd;
    if (previousBrowserCap === undefined) delete process.env.AI_SHADOW_BROWSER_CAP_PER_DAY;
    else process.env.AI_SHADOW_BROWSER_CAP_PER_DAY = previousBrowserCap;
    if (previousExecutionMode === undefined) delete process.env.AI_SHADOW_EXECUTION_MODE;
    else process.env.AI_SHADOW_EXECUTION_MODE = previousExecutionMode;
  }
}

async function withNoConfiguredShadowRoute<T>(callback: () => Promise<T>): Promise<T> {
  const previousRoute = process.env.AI_MODEL_ROUTE;
  const previousConfig = process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG;
  const previousCap = process.env.AI_SHADOW_ADMISSION_CAP_PER_DAY;
  const previousCapScope = process.env.AI_SHADOW_CAP_SCOPE;
  const previousTokenCap = process.env.AI_SHADOW_TOKEN_CAP_PER_DAY;
  const previousSpendCapUsd = process.env.AI_SHADOW_SPEND_CAP_USD_PER_DAY;
  const previousBrowserCap = process.env.AI_SHADOW_BROWSER_CAP_PER_DAY;
  const previousExecutionMode = process.env.AI_SHADOW_EXECUTION_MODE;
  delete process.env.AI_MODEL_ROUTE;
  delete process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG;
  process.env.AI_SHADOW_ADMISSION_CAP_PER_DAY = shadowTestCap;
  process.env.AI_SHADOW_CAP_SCOPE = shadowTestCapScope;
  process.env.AI_SHADOW_TOKEN_CAP_PER_DAY = shadowTestTokenCap;
  process.env.AI_SHADOW_SPEND_CAP_USD_PER_DAY = shadowTestSpendCapUsd;
  process.env.AI_SHADOW_BROWSER_CAP_PER_DAY = shadowTestBrowserCap;
  process.env.AI_SHADOW_EXECUTION_MODE = shadowTestExecutionMode;
  try {
    return await callback();
  } finally {
    if (previousRoute === undefined) delete process.env.AI_MODEL_ROUTE;
    else process.env.AI_MODEL_ROUTE = previousRoute;
    if (previousConfig === undefined) delete process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG;
    else process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG = previousConfig;
    if (previousCap === undefined) delete process.env.AI_SHADOW_ADMISSION_CAP_PER_DAY;
    else process.env.AI_SHADOW_ADMISSION_CAP_PER_DAY = previousCap;
    if (previousCapScope === undefined) delete process.env.AI_SHADOW_CAP_SCOPE;
    else process.env.AI_SHADOW_CAP_SCOPE = previousCapScope;
    if (previousTokenCap === undefined) delete process.env.AI_SHADOW_TOKEN_CAP_PER_DAY;
    else process.env.AI_SHADOW_TOKEN_CAP_PER_DAY = previousTokenCap;
    if (previousSpendCapUsd === undefined) delete process.env.AI_SHADOW_SPEND_CAP_USD_PER_DAY;
    else process.env.AI_SHADOW_SPEND_CAP_USD_PER_DAY = previousSpendCapUsd;
    if (previousBrowserCap === undefined) delete process.env.AI_SHADOW_BROWSER_CAP_PER_DAY;
    else process.env.AI_SHADOW_BROWSER_CAP_PER_DAY = previousBrowserCap;
    if (previousExecutionMode === undefined) delete process.env.AI_SHADOW_EXECUTION_MODE;
    else process.env.AI_SHADOW_EXECUTION_MODE = previousExecutionMode;
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

function nonIdentityReplyRaw(input: {
  messageId: string;
  inReplyTo: string;
  date: string;
}): Buffer {
  return Buffer.from(
    [
      'From: Guest <guest@example.test>',
      'To: centurion@legacyhotel.com',
      'X-Zero-Mailbox: centurion@legacyhotel.com',
      `Date: ${input.date}`,
      `Message-ID: <${input.messageId}@example.test>`,
      `In-Reply-To: <${input.inReplyTo}>`,
      `References: <${input.inReplyTo}>`,
      'Subject: Re: Reservation request',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'This is a guest-side copy, not an external hotel Sent observation.',
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

  it('uses observed availability rather than an old RFC822 event clock for freeze exclusion', () => {
    const observedCutoff = new Date('2026-09-01T10:00:00.000Z');
    const frozen = freezeShadowInput({
      transportId: 'transport-1',
      threadId: 'thread-1',
      triggerMessageId: 'inbound-available',
      asOfAt: observedCutoff,
      messages: [
        {
          id: 'inbound-available',
          direction: 'inbound',
          subject: 'Reservation',
          textBody: 'The message available at the freeze boundary.',
          htmlBody: null,
          receivedAt: new Date('2026-09-01T09:59:00.000Z'),
          sentAt: null,
          createdAt: observedCutoff,
          attachmentIds: [],
        },
        {
          id: 'late-imported-old-event',
          direction: 'outbound',
          subject: 'Old copied Sent message',
          textBody: 'This body was only available after the freeze.',
          htmlBody: null,
          receivedAt: new Date('2026-09-01T09:59:30.000Z'),
          sentAt: null,
          createdAt: new Date('2026-09-01T10:01:00.000Z'),
          attachmentIds: ['late-attachment'],
        },
      ],
    });

    expect(frozen.messageIds).toEqual(['inbound-available']);
    expect(frozen.excludedFutureMessageIds).toEqual(['late-imported-old-event']);
    expect(frozen.attachmentIds).toEqual([]);
    expect(JSON.stringify(frozen.modelMessages)).not.toContain('only available after');
  });

  it('binds retry identity to release, context, and request generation', () => {
    const base = {
      transportId: 'transport-1',
      threadId: 'thread-1',
      triggerMessageId: 'inbound-1',
      releaseId: 'release-a',
      contextDigest: 'context-a',
      requestGeneration: 'request-a',
    };
    const sameGeneration = shadowPredictionKey(base as never);
    expect(shadowPredictionKey(base as never)).toBe(sameGeneration);
    expect(shadowPredictionKey({ ...base, releaseId: 'release-b' } as never)).not.toBe(
      sameGeneration,
    );
    expect(shadowPredictionKey({ ...base, contextDigest: 'context-b' } as never)).not.toBe(
      sameGeneration,
    );
    expect(shadowPredictionKey({ ...base, requestGeneration: 'request-b' } as never)).not.toBe(
      sameGeneration,
    );
  });

  it('closes the bounded admission cap before queue/model work', () => {
    expect(shouldAdmitShadowPrediction({ admittedCount: 99 })).toBe(true);
    expect(shouldAdmitShadowPrediction({ admittedCount: 100 })).toBe(false);
    expect(shouldAdmitShadowPrediction({ admittedCount: -1 })).toBe(false);
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
    it('runs bounded due assessment through the normal worker without route/model initialization', async () => {
      await withNoConfiguredShadowRoute(() =>
        withWorkerDb(async (db) => {
          const token = randomUUID();
          const threadId = `u13-due-thread-${token}`;
          const messageId = `u13-due-message-${token}`;
          const predictionId = `u13-due-prediction-${token}`;
          const predictionKey = `shadow-prediction:${predictionId}`;
          const eventAt = new Date('2026-09-01T09:00:00.000Z');
          await db.insert(mailThread).values({
            id: threadId,
            transportId: 'transport-centurion',
            threadRootId: `${threadId}-root`,
            subject: 'U13 due assessment',
            snippet: 'U13 due assessment',
            createdAt: eventAt,
            updatedAt: eventAt,
            latestMessageAt: eventAt,
          });
          await db.insert(message).values({
            id: messageId,
            transportId: 'transport-centurion',
            threadId,
            direction: 'inbound',
            messageIdHeader: `<${messageId}@example.test>`,
            fromAddress: 'due-guest@example.test',
            toAddresses: ['centurion@legacyhotels.co.za'],
            ccAddresses: [],
            bccAddresses: [],
            receivedAt: eventAt,
            createdAt: eventAt,
            updatedAt: eventAt,
          });
          await db.insert(aiShadowPrediction).values({
            id: predictionId,
            predictionKey,
            evaluationMode: SHADOW_EVALUATION_MODE,
            evaluationVersion: 'shadow-evaluation-v1',
            admissionStatus: 'admitted',
            predictionStatus: 'sealed',
            transportId: 'transport-centurion',
            threadId,
            triggerMessageId: messageId,
            observedAt: eventAt,
            asOfAt: eventAt,
            sealedAt: eventAt,
            observationEndsAt: new Date('2026-09-02T09:00:00.000Z'),
            retentionExpiresAt: new Date('2026-10-01T09:00:00.000Z'),
            sourceVintage: eventAt.toISOString(),
            inputDigest: 'd'.repeat(64),
            messageIds: [messageId],
            attachmentIds: [],
            excludedFutureMessageIds: [],
            modelId: 'u13-due-model',
            promptVersion: 'shadow-mail/v1',
            route: null,
            modelUsage: null,
            prediction: { outcome: 'partial' },
          });
          await db.insert(aiShadowAssessment).values({
            id: `u13-due-assessment-${token}`,
            predictionId,
            revision: 1,
            revisionKey: `${predictionKey}:pending`,
            evaluationMode: SHADOW_EVALUATION_MODE,
            status: 'pending',
            referenceMessageId: null,
            linkStrength: 'unknown',
            reason: 'awaiting_outbound_observation',
            labelProvenance: null,
            verdict: null,
            assessment: {},
          });

          const worked = await runAiWorkerOnce({
            transportId: 'transport-centurion',
            runKind: 'shadow_prediction',
          });
          expect(worked).toBe(true);
          const assessments = await db
            .select()
            .from(aiShadowAssessment)
            .where(eq(aiShadowAssessment.predictionId, predictionId))
            .orderBy(aiShadowAssessment.revision);
          expect(assessments.at(-1)).toMatchObject({
            revision: 2,
            status: 'unobserved',
            reason: 'observation_window_ended_without_verified_reference',
          });

          const storage = new FakeS3Storage(`u13-postwindow-${token}`);
          const outboundId = `u13-postwindow-outbound-${token}`;
          const outboundRawMessage = outboundRaw({
            messageId: outboundId,
            inReplyTo: `${messageId}@example.test`,
            date: 'Tue, 01 Sep 2026 08:00:00 +0000',
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
              pop3Uidl: `u13-postwindow-${token}`,
              messageId: outboundId,
            },
            { db, storage },
          );
          expect(storedOutbound.kind).toBe('stored');
          if (storedOutbound.kind !== 'stored') return;
          const [outboundRow] = await db
            .select({ direction: message.direction })
            .from(message)
            .where(eq(message.id, storedOutbound.messageId));
          expect(outboundRow?.direction).toBe('outbound');
          const postWindowAssessments = await db
            .select()
            .from(aiShadowAssessment)
            .where(eq(aiShadowAssessment.predictionId, predictionId))
            .orderBy(aiShadowAssessment.revision);
          expect(postWindowAssessments).toHaveLength(2);
          expect(postWindowAssessments.at(-1)).toMatchObject({
            revision: 2,
            status: 'unobserved',
            referenceMessageId: null,
          });
        }),
      );
    }, 30_000);

    it('purges expired private derivatives through the normal worker maintenance lane', async () => {
      await withNoConfiguredShadowRoute(() =>
        withWorkerDb(async (db) => {
          const token = randomUUID();
          const threadId = `u13-retention-thread-${token}`;
          const messageId = `u13-retention-message-${token}`;
          const predictionId = `u13-retention-prediction-${token}`;
          const predictionKey = `shadow-prediction:${predictionId}`;
          const expiredAt = new Date('2026-08-01T00:00:00.000Z');
          const eventAt = new Date('2026-07-31T09:00:00.000Z');
          await db.insert(mailThread).values({
            id: threadId,
            transportId: 'transport-centurion',
            threadRootId: `${threadId}-root`,
            subject: 'U13 expired shadow derivative',
            snippet: 'U13 expired shadow derivative',
            createdAt: eventAt,
            updatedAt: eventAt,
            latestMessageAt: eventAt,
          });
          await db.insert(message).values({
            id: messageId,
            transportId: 'transport-centurion',
            threadId,
            direction: 'inbound',
            messageIdHeader: `<${messageId}@example.test>`,
            fromAddress: 'retention-guest@example.test',
            toAddresses: ['centurion@legacyhotels.co.za'],
            ccAddresses: [],
            bccAddresses: [],
            receivedAt: eventAt,
            createdAt: eventAt,
            updatedAt: eventAt,
          });
          await db.insert(aiShadowAdmission).values({
            id: `u13-retention-admission-${token}`,
            admissionKey: predictionKey,
            evaluationMode: SHADOW_EVALUATION_MODE,
            evaluationVersion: 'shadow-evaluation-v1',
            eligible: true,
            admissionStatus: 'admitted',
            reason: 'admitted_within_daily_cap',
            transportId: 'transport-centurion',
            threadId,
            triggerMessageId: messageId,
            releaseId: 'shadow-evaluation-v1:test-retention',
            contextDigest: 'e'.repeat(64),
            requestGeneration: 'shadow-request-v1',
            capBucketAt: eventAt,
            retentionExpiresAt: expiredAt,
          });
          await db.insert(aiShadowPrediction).values({
            id: predictionId,
            predictionKey,
            evaluationMode: SHADOW_EVALUATION_MODE,
            evaluationVersion: 'shadow-evaluation-v1',
            admissionStatus: 'admitted',
            predictionStatus: 'sealed',
            transportId: 'transport-centurion',
            threadId,
            triggerMessageId: messageId,
            observedAt: eventAt,
            asOfAt: eventAt,
            sealedAt: eventAt,
            observationEndsAt: new Date('2026-08-01T09:00:00.000Z'),
            retentionExpiresAt: expiredAt,
            sourceVintage: eventAt.toISOString(),
            inputDigest: 'f'.repeat(64),
            messageIds: [messageId],
            attachmentIds: [],
            excludedFutureMessageIds: [],
            modelId: 'u13-retention-model',
            promptVersion: 'shadow-mail/v1',
            route: null,
            modelUsage: null,
            prediction: { outcome: 'partial' },
          });
          await db.insert(aiShadowAssessment).values({
            id: `u13-retention-assessment-${token}`,
            predictionId,
            revision: 1,
            revisionKey: `${predictionKey}:pending`,
            evaluationMode: SHADOW_EVALUATION_MODE,
            status: 'pending',
            referenceMessageId: null,
            linkStrength: 'unknown',
            reason: 'awaiting_outbound_observation',
            labelProvenance: null,
            verdict: null,
            assessment: {},
          });

          const worked = await runAiWorkerOnce({
            transportId: 'transport-centurion',
            runKind: 'shadow_prediction',
          });
          expect(worked).toBe(true);
          expect(
            await db
              .select()
              .from(aiShadowPrediction)
              .where(eq(aiShadowPrediction.id, predictionId)),
          ).toHaveLength(0);
          expect(
            await db
              .select()
              .from(aiShadowAssessment)
              .where(eq(aiShadowAssessment.predictionId, predictionId)),
          ).toHaveLength(0);
          expect(
            await db
              .select()
              .from(aiShadowAdmission)
              .where(eq(aiShadowAdmission.admissionKey, predictionKey)),
          ).toHaveLength(0);
        }),
      );
    }, 30_000);

    it('purges expired skipped and dead-letter admission receipts through normal producer and worker maintenance', async () => {
      await withConfiguredShadowRoute(() =>
        withAiWriteGate(async () => {
          const previousTokenCap = process.env.AI_SHADOW_TOKEN_CAP_PER_DAY;
          const storage = new FakeS3Storage(`u13-orphan-retention-${randomUUID()}`);
          const persistNormalInbound = async (db: DB, label: string, date: string) => {
            const token = randomUUID();
            const messageId = `u13-${label}-message-${token}`;
            const raw = inboundRaw({
              messageId,
              body: `U13 ${label} retention receipt.`,
              date,
            });
            const parsed = await parseRawMessage(raw, { messageId, storage });
            const stored = await persistInboundMessage(
              parsed,
              raw,
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: `u13-${label}-${token}`,
                messageId,
              },
              { db, storage },
            );
            return { messageId, stored };
          };
          try {
            await withWorkerDb(async (db) => {
              const expiredAt = new Date('2026-08-01T00:00:00.000Z');
              const unexpiredAt = new Date('2026-10-01T00:00:00.000Z');

              // The normal producer records an admission-only skipped receipt.
              delete process.env.AI_SHADOW_TOKEN_CAP_PER_DAY;
              const skipped = await persistNormalInbound(
                db,
                'skipped-orphan',
                'Tue, 01 Sep 2026 12:40:00 +0000',
              );
              expect(skipped.stored.kind).toBe('stored');
              if (skipped.stored.kind !== 'stored') return;
              const [skippedAdmission] = await db
                .select()
                .from(aiShadowAdmission)
                .where(eq(aiShadowAdmission.triggerMessageId, skipped.stored.messageId));
              expect(skippedAdmission).toMatchObject({
                admissionStatus: 'skipped',
                reason: 'admission_cap_unconfigured',
              });
              await db
                .update(aiShadowAdmission)
                .set({ retentionExpiresAt: expiredAt })
                .where(eq(aiShadowAdmission.id, skippedAdmission!.id));

              // No queue row exists, so this is the worker's normal maintenance pass.
              expect(
                await runAiWorkerOnce({
                  transportId: skipped.stored.transportId,
                  runKind: 'shadow_prediction',
                }),
              ).toBe(true);

              // Admit through the same producer, then remove the policy before the
              // worker claims it. This creates an admitted-but-dead-lettered receipt
              // without a prediction body.
              process.env.AI_SHADOW_TOKEN_CAP_PER_DAY = shadowTestTokenCap;
              const deadLetter = await persistNormalInbound(
                db,
                'dead-letter-orphan',
                'Tue, 01 Sep 2026 12:45:00 +0000',
              );
              expect(deadLetter.stored.kind).toBe('stored');
              if (deadLetter.stored.kind !== 'stored') return;
              const [deadLetterAdmission] = await db
                .select()
                .from(aiShadowAdmission)
                .where(eq(aiShadowAdmission.triggerMessageId, deadLetter.stored.messageId));
              expect(deadLetterAdmission).toMatchObject({
                admissionStatus: 'admitted',
                reason: 'admitted_within_daily_cap',
              });
              await db
                .update(aiShadowAdmission)
                .set({ retentionExpiresAt: expiredAt })
                .where(eq(aiShadowAdmission.id, deadLetterAdmission!.id));
              delete process.env.AI_SHADOW_TOKEN_CAP_PER_DAY;

              // A second skipped receipt remains as an explicit unexpired control.
              const retained = await persistNormalInbound(
                db,
                'retained-skipped',
                'Tue, 01 Sep 2026 12:50:00 +0000',
              );
              expect(retained.stored.kind).toBe('stored');
              if (retained.stored.kind !== 'stored') return;
              const [retainedAdmission] = await db
                .select()
                .from(aiShadowAdmission)
                .where(eq(aiShadowAdmission.triggerMessageId, retained.stored.messageId));
              expect(retainedAdmission).toMatchObject({ admissionStatus: 'skipped' });
              await db
                .update(aiShadowAdmission)
                .set({ retentionExpiresAt: unexpiredAt })
                .where(eq(aiShadowAdmission.id, retainedAdmission!.id));

              await runAiWorkerOnce({
                transportId: deadLetter.stored.transportId,
                runKind: 'shadow_prediction',
              });
              const [run] = await db
                .select()
                .from(aiWorkflowRun)
                .where(
                  and(
                    eq(aiWorkflowRun.triggerMessageId, deadLetter.stored.messageId),
                    eq(aiWorkflowRun.runKind, 'shadow_prediction'),
                  ),
                );
              expect(run?.state).toBe('dead_letter');

              // A linked prediction remains retained even if its receipt's
              // expiry is older. This exercises the orphan predicate's
              // unexpired-evidence fence through the normal producer/worker.
              process.env.AI_SHADOW_TOKEN_CAP_PER_DAY = shadowTestTokenCap;
              const linked = await persistNormalInbound(
                db,
                'linked-unexpired',
                'Tue, 01 Sep 2026 12:55:00 +0000',
              );
              expect(linked.stored.kind).toBe('stored');
              if (linked.stored.kind !== 'stored') return;
              configuredShadowFixture.resetTransportCalls();
              const linkedDrain = await runAiWorkerDrain({
                transportId: linked.stored.transportId,
                threadId: linked.stored.threadId,
                triggerMessageId: linked.stored.messageId,
                runKind: 'shadow_prediction',
                timeoutMs: 5_000,
                pollIntervalMs: 10,
              });
              expect(linkedDrain).toMatchObject({ ok: true, reason: 'drained', processed: 1 });
              expect(configuredShadowFixture.getTransportCalls()).toBe(1);
              const [linkedAdmission] = await db
                .select()
                .from(aiShadowAdmission)
                .where(eq(aiShadowAdmission.triggerMessageId, linked.stored.messageId));
              const [linkedPrediction] = await db
                .select()
                .from(aiShadowPrediction)
                .where(eq(aiShadowPrediction.triggerMessageId, linked.stored.messageId));
              expect(linkedAdmission).toMatchObject({ admissionStatus: 'admitted' });
              expect(linkedPrediction).toMatchObject({ predictionStatus: 'sealed' });
              if (!linkedAdmission || !linkedPrediction) return;
              await db
                .update(aiShadowAdmission)
                .set({ retentionExpiresAt: expiredAt })
                .where(eq(aiShadowAdmission.id, linkedAdmission.id));
              delete process.env.AI_SHADOW_TOKEN_CAP_PER_DAY;

              // The next normal worker pass has no claim and must purge both
              // expired orphan receipts while retaining both unexpired controls
              // (one admission-only and one linked prediction).
              await runAiWorkerOnce({
                transportId: deadLetter.stored.transportId,
                runKind: 'shadow_prediction',
              });
              expect(
                await db
                  .select()
                  .from(aiShadowAdmission)
                  .where(eq(aiShadowAdmission.id, skippedAdmission!.id)),
              ).toHaveLength(0);
              expect(
                await db
                  .select()
                  .from(aiShadowAdmission)
                  .where(eq(aiShadowAdmission.id, deadLetterAdmission!.id)),
              ).toHaveLength(0);
              expect(
                await db
                  .select()
                  .from(aiShadowAdmission)
                  .where(eq(aiShadowAdmission.id, retainedAdmission!.id)),
              ).toHaveLength(1);
              expect(
                await db
                  .select()
                  .from(aiShadowAdmission)
                  .where(eq(aiShadowAdmission.id, linkedAdmission.id)),
              ).toHaveLength(1);
              expect(
                await db
                  .select()
                  .from(aiShadowPrediction)
                  .where(eq(aiShadowPrediction.id, linkedPrediction.id)),
              ).toHaveLength(1);
            });
          } finally {
            if (previousTokenCap === undefined) delete process.env.AI_SHADOW_TOKEN_CAP_PER_DAY;
            else process.env.AI_SHADOW_TOKEN_CAP_PER_DAY = previousTokenCap;
          }
        }),
      );
    }, 30_000);

    it('persists a skipped admission when the real daily cap is exhausted before queueing', async () => {
      await withNoConfiguredShadowRoute(() =>
        withWorkerDb(async (db) => {
          const token = randomUUID();
          const threadId = `u13-cap-thread-${token}`;
          const messageId = `u13-cap-message-${token}`;
          const siblingThreadId = `u13-cap-sibling-thread-${token}`;
          const siblingMessageId = `u13-cap-sibling-message-${token}`;
          const now = new Date();
          const capBucketAt = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
          );
          await db.insert(mailThread).values({
            id: threadId,
            transportId: 'transport-centurion',
            threadRootId: `${threadId}-root`,
            subject: 'U13 admission cap',
            snippet: 'U13 admission cap',
            createdAt: now,
            updatedAt: now,
            latestMessageAt: now,
          });
          await db.insert(message).values({
            id: messageId,
            transportId: 'transport-centurion',
            threadId,
            direction: 'inbound',
            messageIdHeader: `<${messageId}@example.test>`,
            fromAddress: 'cap-guest@example.test',
            toAddresses: ['centurion@legacyhotels.co.za'],
            ccAddresses: [],
            bccAddresses: [],
            receivedAt: now,
            createdAt: now,
            updatedAt: now,
          });
          await db.insert(mailThread).values({
            id: siblingThreadId,
            transportId: 'transport-nava',
            threadRootId: `${siblingThreadId}-root`,
            subject: 'U13 sibling admission cap',
            snippet: 'U13 sibling admission cap',
            createdAt: now,
            updatedAt: now,
            latestMessageAt: now,
          });
          await db.insert(message).values({
            id: siblingMessageId,
            transportId: 'transport-nava',
            threadId: siblingThreadId,
            direction: 'inbound',
            messageIdHeader: `<${siblingMessageId}@example.test>`,
            fromAddress: 'sibling-cap-guest@example.test',
            toAddresses: ['nava@legacyhotels.co.za'],
            ccAddresses: [],
            bccAddresses: [],
            receivedAt: now,
            createdAt: now,
            updatedAt: now,
          });
          await db.insert(aiShadowAdmission).values(
            Array.from({ length: 100 }, (_, index) => ({
              id: `u13-cap-admission-${index}-${token}`,
              admissionKey: `shadow-cap-existing:${index}:${token}`,
              evaluationMode: SHADOW_EVALUATION_MODE,
              evaluationVersion: 'shadow-evaluation-v1',
              eligible: true,
              admissionStatus: 'admitted',
              reason: 'admitted_within_daily_cap',
              transportId: index === 99 ? 'transport-nava' : 'transport-centurion',
              threadId: index === 99 ? siblingThreadId : threadId,
              triggerMessageId: index === 99 ? siblingMessageId : messageId,
              releaseId:
                index === 0 ? shadowAdmissionReleaseId() : `shadow-cap-other-release:${token}`,
              contextDigest: 'c'.repeat(64),
              requestGeneration: 'shadow-request-v1',
              capBucketAt,
              retentionExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
            })),
          );
          const admittedRows = await db
            .select({
              transportId: aiShadowAdmission.transportId,
              releaseId: aiShadowAdmission.releaseId,
            })
            .from(aiShadowAdmission)
            .where(
              and(
                eq(aiShadowAdmission.capBucketAt, capBucketAt),
                eq(aiShadowAdmission.admissionStatus, 'admitted'),
              ),
            );
          expect(admittedRows).toHaveLength(100);
          expect(new Set(admittedRows.map((row) => row.transportId))).toEqual(
            new Set(['transport-centurion', 'transport-nava']),
          );
          expect(new Set(admittedRows.map((row) => row.releaseId))).toEqual(
            new Set([shadowAdmissionReleaseId(), `shadow-cap-other-release:${token}`]),
          );

          const skippedRun = await enqueueShadowPrediction({
            transportId: 'transport-centurion',
            threadId,
            triggerMessageId: messageId,
            db,
          });
          expect(skippedRun).toBeNull();
          const [skipped] = await db
            .select()
            .from(aiShadowAdmission)
            .where(
              and(
                eq(aiShadowAdmission.transportId, 'transport-centurion'),
                eq(aiShadowAdmission.threadId, threadId),
                eq(aiShadowAdmission.admissionStatus, 'skipped'),
              ),
            );
          expect(skipped).toMatchObject({
            eligible: true,
            admissionStatus: 'skipped',
            reason: 'daily_admission_cap_exhausted',
            releaseId: shadowAdmissionReleaseId(),
            requestGeneration: 'shadow-request-v1',
          });

          // Exercise the same admission through the normal inbound producer,
          // then read it through the authorized scorecard route. The seeded
          // rows above only establish the lower-edge cap fixture.
          const storage = new FakeS3Storage(`u13-cap-route-${token}`);
          const producedMessageId = `u13-cap-produced-${token}`;
          const producedRaw = inboundRaw({
            messageId: producedMessageId,
            body: 'Please confirm the capped reservation through normal ingest.',
            date: 'Tue, 01 Sep 2026 13:00:00 +0000',
          });
          const producedParsed = await parseRawMessage(producedRaw, {
            messageId: producedMessageId,
            storage,
          });
          const produced = await persistInboundMessage(
            producedParsed,
            producedRaw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: `u13-cap-produced-${token}`,
              messageId: producedMessageId,
            },
            { db, storage },
          );
          expect(produced.kind).toBe('stored');
          if (produced.kind !== 'stored') return;
          const [normalSkipped] = await db
            .select()
            .from(aiShadowAdmission)
            .where(eq(aiShadowAdmission.triggerMessageId, produced.messageId));
          expect(normalSkipped).toMatchObject({
            eligible: true,
            admissionStatus: 'skipped',
            reason: 'daily_admission_cap_exhausted',
          });
          const cutoff = new Date();
          const authorizedCaller = appRouter.createCaller({
            auth: null as never,
            reqHeaders: new Headers(),
            sessionUser: {
              id: `u13-cap-scorecard-user-${token}`,
              email: 'ropperman@legacyhotels.co.za',
              name: null,
            },
          });
          const authorizedScorecard = await authorizedCaller.adminDashboard.getMetrics({
            cohortId: 'centurion',
            windowStart: new Date(cutoff.getTime() - 24 * 60 * 60 * 1000).toISOString(),
            windowEnd: cutoff.toISOString(),
            observationCutoff: cutoff.toISOString(),
            operation: 'aggregate',
          });
          expect(authorizedScorecard.shadowScorecard).toMatchObject({
            admissionPopulation: expect.objectContaining({
              availability: 'available',
              counts: expect.objectContaining({ skipped: expect.any(Number) }),
              provenance: expect.objectContaining({ selectionClock: 'admission_created_at' }),
            }),
          });
          expect(
            authorizedScorecard.shadowScorecard?.admissionPopulation.counts.skipped,
          ).toBeGreaterThan(0);
          expect(
            await db
              .select()
              .from(aiWorkflowRun)
              .where(eq(aiWorkflowRun.idempotencyKey, skipped?.admissionKey ?? 'missing')),
          ).toHaveLength(0);
        }),
      );
    }, 30_000);

    it('fails closed before a model call when the live cap policy is unset', async () => {
      await withConfiguredShadowRoute(() =>
        withAiWriteGate(async () => {
          const previousTokenCap = process.env.AI_SHADOW_TOKEN_CAP_PER_DAY;
          delete process.env.AI_SHADOW_TOKEN_CAP_PER_DAY;
          try {
            await withWorkerDb(async (db) => {
              const storage = new FakeS3Storage(`u13-cap-unset-${randomUUID()}`);
              const token = randomUUID();
              const inboundId = `u13-cap-unset-inbound-${token}`;
              const raw = inboundRaw({
                messageId: inboundId,
                body: 'Please confirm reservation with no live cap.',
                date: 'Tue, 01 Sep 2026 12:00:00 +0000',
              });
              const parsed = await parseRawMessage(raw, { messageId: inboundId, storage });
              const stored = await persistInboundMessage(
                parsed,
                raw,
                {
                  ingestMailboxId: 'ingest-nava-legacy',
                  pop3Uidl: `u13-cap-unset-${token}`,
                  messageId: inboundId,
                },
                { db, storage },
              );
              expect(stored.kind).toBe('stored');
              if (stored.kind !== 'stored') return;
              const [admission] = await db
                .select()
                .from(aiShadowAdmission)
                .where(eq(aiShadowAdmission.triggerMessageId, stored.messageId));
              expect(admission).toMatchObject({
                eligible: true,
                admissionStatus: 'skipped',
                reason: 'admission_cap_unconfigured',
              });
              expect(
                await db
                  .select()
                  .from(aiWorkflowRun)
                  .where(
                    and(
                      eq(aiWorkflowRun.triggerMessageId, stored.messageId),
                      eq(aiWorkflowRun.runKind, 'shadow_prediction'),
                    ),
                  ),
              ).toHaveLength(0);
              configuredShadowFixture.resetTransportCalls();
              const drain = await runAiWorkerDrain({
                transportId: stored.transportId,
                threadId: stored.threadId,
                triggerMessageId: stored.messageId,
                runKind: 'shadow_prediction',
                timeoutMs: 200,
                pollIntervalMs: 10,
              });
              expect(drain).toMatchObject({ ok: true, reason: 'drained', processed: 0 });
              expect(configuredShadowFixture.getTransportCalls()).toBe(0);
            });
          } finally {
            if (previousTokenCap === undefined) delete process.env.AI_SHADOW_TOKEN_CAP_PER_DAY;
            else process.env.AI_SHADOW_TOKEN_CAP_PER_DAY = previousTokenCap;
          }
        }),
      );
    }, 30_000);

    it('does not admit a costly/live mode even when declarations are complete', async () => {
      await withConfiguredShadowRoute(() =>
        withAiWriteGate(async () => {
          const previousExecutionMode = process.env.AI_SHADOW_EXECUTION_MODE;
          process.env.AI_SHADOW_EXECUTION_MODE = 'live';
          try {
            await withWorkerDb(async (db) => {
              const storage = new FakeS3Storage(`u13-live-disabled-${randomUUID()}`);
              const token = randomUUID();
              const inboundId = `u13-live-disabled-inbound-${token}`;
              const raw = inboundRaw({
                messageId: inboundId,
                body: 'Please confirm reservation without a local synthetic budget lane.',
                date: 'Tue, 01 Sep 2026 12:30:00 +0000',
              });
              const parsed = await parseRawMessage(raw, { messageId: inboundId, storage });
              const stored = await persistInboundMessage(
                parsed,
                raw,
                {
                  ingestMailboxId: 'ingest-nava-legacy',
                  pop3Uidl: `u13-live-disabled-${token}`,
                  messageId: inboundId,
                },
                { db, storage },
              );
              expect(stored.kind).toBe('stored');
              if (stored.kind !== 'stored') return;
              const [admission] = await db
                .select()
                .from(aiShadowAdmission)
                .where(eq(aiShadowAdmission.triggerMessageId, stored.messageId));
              expect(admission).toMatchObject({
                eligible: true,
                admissionStatus: 'skipped',
                reason: 'admission_live_disabled',
              });
              expect(
                await db
                  .select()
                  .from(aiWorkflowRun)
                  .where(
                    and(
                      eq(aiWorkflowRun.triggerMessageId, stored.messageId),
                      eq(aiWorkflowRun.runKind, 'shadow_prediction'),
                    ),
                  ),
              ).toHaveLength(0);
              configuredShadowFixture.resetTransportCalls();
              const drain = await runAiWorkerDrain({
                transportId: stored.transportId,
                threadId: stored.threadId,
                triggerMessageId: stored.messageId,
                runKind: 'shadow_prediction',
                timeoutMs: 200,
                pollIntervalMs: 10,
              });
              expect(drain).toMatchObject({ ok: true, reason: 'drained', processed: 0 });
              expect(configuredShadowFixture.getTransportCalls()).toBe(0);
            });
          } finally {
            if (previousExecutionMode === undefined) delete process.env.AI_SHADOW_EXECUTION_MODE;
            else process.env.AI_SHADOW_EXECUTION_MODE = previousExecutionMode;
          }
        }),
      );
    }, 30_000);

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

            // The normal producer has admitted and queued the receipt, but
            // before the worker claims it the authorized scorecard must expose
            // operational pending-seal coverage separately from assessment
            // pending.
            const pendingCutoff = new Date();
            const pendingCaller = appRouter.createCaller({
              auth: null as never,
              reqHeaders: new Headers(),
              sessionUser: {
                id: `u13-pending-scorecard-user-${token}`,
                email: 'ropperman@legacyhotels.co.za',
                name: null,
              },
            });
            const pendingScorecard = await pendingCaller.adminDashboard.getMetrics({
              cohortId: 'centurion',
              windowStart: new Date(pendingCutoff.getTime() - 24 * 60 * 60 * 1000).toISOString(),
              windowEnd: pendingCutoff.toISOString(),
              observationCutoff: pendingCutoff.toISOString(),
              operation: 'aggregate',
            });
            expect(pendingScorecard.shadowScorecard).toMatchObject({
              counts: expect.objectContaining({ pending: 0 }),
              admissionPopulation: expect.objectContaining({
                availability: 'available',
                counts: expect.objectContaining({ admitted: 1, pending: 1 }),
                provenance: expect.objectContaining({ selectionClock: 'admission_created_at' }),
              }),
            });

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
            const [admission] = await db
              .select()
              .from(aiShadowAdmission)
              .where(eq(aiShadowAdmission.triggerMessageId, storedInbound.messageId));
            expect(admission).toMatchObject({
              admissionStatus: 'admitted',
              eligible: true,
              reason: 'admitted_within_daily_cap',
              releaseId: expect.stringMatching(/^shadow-evaluation-v1:/),
              contextDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
              requestGeneration: 'shadow-request-v1',
            });
            expect(admission?.admissionKey).toBe(run?.idempotencyKey);
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
              date: 'Tue, 01 Sep 2026 08:00:00 +0000',
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
              { db, storage },
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
              status: 'late',
              referenceMessageId: storedOutbound.messageId,
              linkStrength: 'header',
            });

            const scorecardCutoff = new Date();
            const authorizedCaller = appRouter.createCaller({
              auth: null as never,
              reqHeaders: new Headers(),
              sessionUser: {
                id: `u13-scorecard-user-${token}`,
                email: 'ropperman@legacyhotels.co.za',
                name: null,
              },
            });
            const authorizedScorecard = await authorizedCaller.adminDashboard.getMetrics({
              cohortId: 'centurion',
              window: '28d',
              windowStart: new Date(
                scorecardCutoff.getTime() - 28 * 24 * 60 * 60 * 1000,
              ).toISOString(),
              windowEnd: scorecardCutoff.toISOString(),
              observationCutoff: scorecardCutoff.toISOString(),
              operation: 'aggregate',
            });
            expect(authorizedScorecard.shadowScorecard).toMatchObject({
              evaluationMode: SHADOW_EVALUATION_MODE,
              counts: expect.objectContaining({ admitted: 1, sealed: 1, late: 1 }),
              admissionPopulation: expect.objectContaining({
                availability: 'available',
                reason: null,
                counts: expect.objectContaining({
                  eligible: 1,
                  admitted: 1,
                  skipped: 0,
                  denied: 0,
                  pending: 0,
                }),
                provenance: expect.objectContaining({
                  selectionClock: 'admission_created_at',
                }),
              }),
              quality: expect.objectContaining({ availability: 'unavailable', denominator: null }),
              provenance: expect.objectContaining({
                source: 'private_shadow_store',
                selectionClock: 'sealed_at',
              }),
            });

            const nonIdentityId = `u13-nonidentity-${token}`;
            const nonIdentityRaw = nonIdentityReplyRaw({
              messageId: nonIdentityId,
              inReplyTo: inboundHeader,
              date: 'Tue, 01 Sep 2026 10:30:00 +0000',
            });
            const nonIdentityParsed = await parseRawMessage(nonIdentityRaw, {
              messageId: nonIdentityId,
              storage,
            });
            const nonIdentityStored = await persistInboundMessage(
              nonIdentityParsed,
              nonIdentityRaw,
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: `u13-nonidentity-${token}`,
                messageId: nonIdentityId,
              },
              { db, storage },
            );
            expect(nonIdentityStored.kind).toBe('stored');
            if (nonIdentityStored.kind !== 'stored') return;
            const [nonIdentityRow] = await db
              .select({ direction: message.direction })
              .from(message)
              .where(eq(message.id, nonIdentityStored.messageId));
            expect(nonIdentityRow?.direction).toBe('inbound');
            const [nonIdentityAdmission] = await db
              .select()
              .from(aiShadowAdmission)
              .where(eq(aiShadowAdmission.triggerMessageId, nonIdentityStored.messageId));
            expect(nonIdentityAdmission).toMatchObject({
              admissionStatus: 'admitted',
              eligible: true,
              releaseId: admission?.releaseId,
              requestGeneration: 'shadow-request-v1',
            });
            expect(nonIdentityAdmission?.contextDigest).not.toBe(admission?.contextDigest);
            expect(nonIdentityAdmission?.admissionKey).not.toBe(admission?.admissionKey);
            const [nonIdentityRun] = await db
              .select()
              .from(aiWorkflowRun)
              .where(
                and(
                  eq(aiWorkflowRun.triggerMessageId, nonIdentityStored.messageId),
                  eq(aiWorkflowRun.runKind, 'shadow_prediction'),
                ),
              );
            expect(nonIdentityRun?.state).toBe('queued');
            expect(nonIdentityRun?.idempotencyKey).toBe(nonIdentityAdmission?.admissionKey);
            expect(
              await db
                .select()
                .from(aiShadowAssessment)
                .where(eq(aiShadowAssessment.predictionId, predictions[0]!.id)),
            ).toHaveLength(2);

            const originalRun = (
              await db
                .select()
                .from(aiWorkflowRun)
                .where(
                  and(
                    eq(aiWorkflowRun.triggerMessageId, storedInbound.messageId),
                    eq(aiWorkflowRun.runKind, 'shadow_prediction'),
                  ),
                )
            )[0];
            const sameGenerationRetry = await enqueueShadowPrediction({
              transportId: storedInbound.transportId,
              threadId: storedInbound.threadId,
              triggerMessageId: storedInbound.messageId,
              db,
            });
            expect(sameGenerationRetry?.id).toBe(originalRun?.id);

            const previousReleaseConfig = process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG;
            process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG = JSON.stringify({
              module: configuredShadowFixturePath,
              route: {
                routeId: 'u13-configured-shadow-route-changed-release',
                purpose: 'shadow',
                protocol: 'in_process',
                access: 'current_app',
                egress: 'none',
                retention: 'bounded',
                usage: 'reported',
                modelId: 'u13-configured-shadow-model-v2',
              },
            });
            try {
              const changedReleaseRetry = await enqueueShadowPrediction({
                transportId: storedInbound.transportId,
                threadId: storedInbound.threadId,
                triggerMessageId: storedInbound.messageId,
                db,
              });
              expect(changedReleaseRetry?.id).toBeTruthy();
              expect(changedReleaseRetry?.id).not.toBe(originalRun?.id);
            } finally {
              if (previousReleaseConfig === undefined)
                delete process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG;
              else process.env.AI_APPROVED_LOCAL_SHADOW_CONFIG = previousReleaseConfig;
            }

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
              { db, storage },
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
            const cutoff = new Date();
            const caller = appRouter.createCaller({
              auth: null as never,
              reqHeaders: new Headers(),
              sessionUser: {
                id: `u13-unavailable-scorecard-user-${token}`,
                email: 'ropperman@legacyhotels.co.za',
                name: null,
              },
            });
            const scorecard = await caller.adminDashboard.getMetrics({
              cohortId: 'centurion',
              windowStart: new Date(cutoff.getTime() - 24 * 60 * 60 * 1000).toISOString(),
              windowEnd: cutoff.toISOString(),
              observationCutoff: cutoff.toISOString(),
              operation: 'aggregate',
            });
            expect(scorecard.shadowScorecard).toMatchObject({
              counts: expect.objectContaining({ unavailable: 1, pending: 1 }),
            });
            expect(scorecard.shadowScorecard.admissionPopulation.counts.admitted).toBe(1);
            expect(scorecard.shadowScorecard.admissionPopulation.counts.pending).toBe(1);
            expect(scorecard.shadowScorecard.admissionPopulation.provenance).toMatchObject({
              selectionClock: 'admission_created_at',
            });
          }),
        ),
      );
    }, 30_000);

    it('keeps a failed terminal prediction admission-pending through the authorized scorecard', async () => {
      await withConfiguredShadowRoute(() =>
        withAiWriteGate(() =>
          withWorkerDb(async (db) => {
            const storage = new FakeS3Storage(`u13-shadow-failed-${randomUUID()}`);
            const token = randomUUID();
            const inboundId = `u13-failed-inbound-${token}`;
            const raw = inboundRaw({
              messageId: inboundId,
              body: 'Please confirm reservation U13-failed.',
              date: 'Tue, 01 Sep 2026 11:30:00 +0000',
            });
            const parsed = await parseRawMessage(raw, { messageId: inboundId, storage });
            const stored = await persistInboundMessage(
              parsed,
              raw,
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: `u13-failed-${token}`,
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
              shadowModelTransport: async () => {
                throw new Error('u13 bounded synthetic shadow transport failure');
              },
            });
            expect(drain).toMatchObject({ ok: true, reason: 'drained', processed: 1 });
            expect(configuredShadowFixture.getTransportCalls()).toBe(0);

            const [prediction] = await db
              .select()
              .from(aiShadowPrediction)
              .where(eq(aiShadowPrediction.triggerMessageId, stored.messageId));
            expect(prediction).toMatchObject({
              admissionStatus: 'admitted',
              predictionStatus: 'failed',
              unavailableReason: 'shadow_prediction_failed',
            });
            expect(prediction?.sealedAt).toBeInstanceOf(Date);

            const cutoff = new Date();
            const caller = appRouter.createCaller({
              auth: null as never,
              reqHeaders: new Headers(),
              sessionUser: {
                id: `u13-failed-scorecard-user-${token}`,
                email: 'ropperman@legacyhotels.co.za',
                name: null,
              },
            });
            const scorecard = await caller.adminDashboard.getMetrics({
              cohortId: 'centurion',
              windowStart: new Date(cutoff.getTime() - 24 * 60 * 60 * 1000).toISOString(),
              windowEnd: cutoff.toISOString(),
              observationCutoff: cutoff.toISOString(),
              operation: 'aggregate',
            });
            expect(scorecard.shadowScorecard).toMatchObject({
              counts: expect.objectContaining({ failed: 1, pending: 1 }),
            });
            expect(scorecard.shadowScorecard.admissionPopulation.counts.admitted).toBe(1);
            expect(scorecard.shadowScorecard.admissionPopulation.counts.pending).toBe(1);
            expect(scorecard.shadowScorecard.admissionPopulation.provenance).toMatchObject({
              selectionClock: 'admission_created_at',
            });
          }),
        ),
      );
    }, 30_000);
  });
