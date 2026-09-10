import {
  createShadowPredictionSeal,
  freezeShadowInput,
  validateShadowPredictionOutput,
} from '../src/ai/shadow-evaluation.js';
import {
  createExistingDocumentService,
  type ExistingDocumentRecord,
} from '../src/mail/artifacts/existing-document-service.js';
import {
  readAuthorizedArtifact,
  readAuthorizedArtifactBytes,
} from '../src/mail/artifacts/read-artifact.js';
import {
  buildShadowAdmissionPopulation,
  buildShadowScorecard,
} from '../src/metrics/shadow-scorecard.js';
import { executeReadToolRun, type ReadExecutionContext } from '../src/hms/read-service.js';
import { FakeSmtpTransport, __setSmtpTransportForTests } from '../src/mail/send/smtp.js';
import { mailThread, message, outboundSendQueue } from '../src/db/schema/mail.js';
import { matchShadowReference } from '../src/ai/shadow-reference-matcher.js';
import { readResultSchema } from '../src/hms/read-service-contracts.js';
import { issueReadAdmission } from '../src/hms/read-admission.js';
import { withSeededTestDb } from './helpers/test-db.js';
import { callerFor } from './helpers/trpc-caller.js';
import { FakeS3Storage } from '../src/storage/s3.js';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';

const NOW = '2026-09-10T12:00:00.000Z';
const DOCUMENT_SCOPE = 'scope:reservation-tools-integration';
const DOCUMENT_PROPERTY = 'property:fixture';
const DOCUMENT_GUEST = 'guest:fixture';
const DOCUMENT_PAYER = 'payer:fixture';
const DOCUMENT_BODY = Buffer.from('fixture document bytes', 'utf8');
const DOCUMENT_SHA256 = createHash('sha256').update(DOCUMENT_BODY).digest('hex');

function documentRecord(overrides: Partial<ExistingDocumentRecord> = {}): ExistingDocumentRecord {
  return {
    sourceRecordId: 'integration-document-1',
    scopeRef: DOCUMENT_SCOPE,
    source: 'mail_attachment',
    kind: 'tax_invoice',
    version: 'v1',
    issuedAt: NOW,
    status: 'final',
    parentRef: 'parent:fixture',
    payerRef: DOCUMENT_PAYER,
    displayName: 'invoice.txt',
    mime: 'text/plain',
    sizeBytes: DOCUMENT_BODY.byteLength,
    sha256: DOCUMENT_SHA256,
    priceVisibility: 'hidden',
    propertyRef: DOCUMENT_PROPERTY,
    guestRef: DOCUMENT_GUEST,
    stayStart: '2026-09-10',
    stayEnd: '2026-09-12',
    currentVersion: true,
    attachment: {
      attachmentId: 'integration-attachment-1',
      authorizedAttachmentIds: new Set(['integration-attachment-1']),
      locator: {
        s3Key: 'attachments/integration-message-1/invoice.txt',
        mimeType: 'text/plain',
        sizeBytes: DOCUMENT_BODY.byteLength,
        messageId: 'integration-message-1',
      },
    },
    ...overrides,
  };
}

function documentService(
  s3: FakeS3Storage,
  records: readonly ExistingDocumentRecord[] = [documentRecord()],
) {
  return createExistingDocumentService({
    now: () => new Date(NOW),
    resolveScope: async (scopeRef) =>
      scopeRef === DOCUMENT_SCOPE
        ? {
            scopeRef: DOCUMENT_SCOPE,
            propertyRef: DOCUMENT_PROPERTY,
            guestRef: DOCUMENT_GUEST,
            stayStart: '2026-09-10',
            stayEnd: '2026-09-12',
            payerRef: DOCUMENT_PAYER,
            requestedKind: 'tax_invoice' as const,
            requestedPriceVisibility: 'allowed' as const,
          }
        : null,
    sources: {
      mail_attachment: {
        source: 'mail_attachment',
        list: async () => ({ records }),
      },
    },
    readArtifact: async (attachment) =>
      readAuthorizedArtifact({
        attachmentId: attachment.attachmentId,
        authorizedAttachmentIds: attachment.authorizedAttachmentIds,
        s3,
        signal: AbortSignal.timeout(5_000),
        resolveLocator: async () => attachment.locator,
      }),
    readBytes: async (attachment) =>
      readAuthorizedArtifactBytes({
        attachmentId: attachment.attachmentId,
        authorizedAttachmentIds: attachment.authorizedAttachmentIds,
        s3,
        signal: AbortSignal.timeout(5_000),
        resolveLocator: async () => attachment.locator,
      }),
  });
}

function documentContext(
  service: ReturnType<typeof documentService>,
  overrides: Partial<ReadExecutionContext> = {},
): ReadExecutionContext {
  return {
    transportId: 'transport:fixture',
    mailboxId: 'mailbox:fixture',
    threadId: 'thread:fixture',
    triggerMessageId: 'message:fixture',
    propertyCode: 'HRCEN',
    parentRef: 'parent:fixture',
    branchId: 'existing_documents',
    releaseId: 'release:fixture',
    requester: {
      authorizationId: 'grant:fixture',
      transportId: 'transport:fixture',
      threadId: 'thread:fixture',
      triggerMessageId: 'message:fixture',
      allowedClaimKinds: ['document_metadata'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
    signal: new AbortController().signal,
    budget: { total: 0, limit: 3 },
    now: () => new Date(NOW),
    requireAdmissionBinding: true,
    propertyReadLock: {
      key: 'lock:fixture',
      withLock: async (callback) =>
        callback({ query: async () => [], close: async () => undefined }),
    },
    existingDocumentService: service,
    ...overrides,
  } as ReadExecutionContext;
}

function documentAdmission(
  toolId: 'documents_list_existing' | 'documents_read_existing',
  request: Record<string, unknown>,
) {
  return issueReadAdmission({
    source: {
      userId: 'user:fixture',
      mailboxAccessId: 'grant:fixture',
      transportId: 'transport:fixture',
      threadId: 'thread:fixture',
      triggerMessageId: 'message:fixture',
      releaseId: 'release:fixture',
      requestBranchId: 'existing_documents',
    },
    now: new Date(NOW),
    toolId,
    request,
  });
}

describe('U11 integrated reservation-tools pilot journeys', () => {
  it('composes the normal model-free document read with a typed receipt and manual boundary', async () => {
    const s3 = new FakeS3Storage('u11-integration-documents');
    await s3.putObject({
      key: 'attachments/integration-message-1/invoice.txt',
      body: DOCUMENT_BODY,
      contentType: 'text/plain',
    });
    const service = documentService(s3);
    const context = documentContext(service);
    const list = documentAdmission('documents_list_existing', {
      scopeRef: DOCUMENT_SCOPE,
      source: 'mail_attachment',
      limit: 20,
    });

    const listReceipt = await executeReadToolRun({
      runKind: 'read_tool',
      executorLane: 'hms',
      draftingEnabled: false,
      request: list.readRequest,
      context,
      resultRef: 'receipt:document-list',
    });
    expect(listReceipt.modelId).toBe('not_applicable');
    expect(listReceipt.result.status).toBe('ok');
    expect(readResultSchema.parse(listReceipt.result)).toEqual(listReceipt.result);

    const documentRef = (listReceipt.result.data as { documents: Array<{ documentRef: string }> })
      .documents[0]?.documentRef;
    expect(documentRef).toEqual(expect.any(String));

    const read = documentAdmission('documents_read_existing', {
      documentRef,
      format: 'text',
    });
    const readReceipt = await executeReadToolRun({
      runKind: 'read_tool',
      executorLane: 'hms',
      draftingEnabled: false,
      request: read.readRequest,
      context,
      resultRef: 'receipt:document-read',
    });
    expect(readReceipt.result.status).toBe('ok');
    expect(readReceipt.result.data).toMatchObject({
      text: 'fixture document bytes',
      extractionState: 'complete',
      artifactRef: null,
    });
    expect(readReceipt.linkedContextReferences).toEqual([]);

    const unavailable = documentService(new FakeS3Storage('u11-integration-missing'), [
      documentRecord({ attachment: undefined }),
    ]);
    const unavailableList = await executeReadToolRun({
      runKind: 'read_tool',
      executorLane: 'hms',
      draftingEnabled: false,
      request: documentAdmission('documents_list_existing', {
        scopeRef: DOCUMENT_SCOPE,
        source: 'mail_attachment',
      }).readRequest,
      context: documentContext(unavailable),
      resultRef: 'receipt:document-unavailable',
    });
    const missingRef = (
      unavailableList.result.data as { documents: Array<{ documentRef: string }> }
    ).documents[0]?.documentRef;
    const unavailableRead = await executeReadToolRun({
      runKind: 'read_tool',
      executorLane: 'hms',
      draftingEnabled: false,
      request: documentAdmission('documents_read_existing', {
        documentRef: missingRef,
        format: 'text',
      }).readRequest,
      context: documentContext(unavailable),
      resultRef: 'receipt:document-manual',
    });
    expect(unavailableRead.result.status).toBe('manual_required');
    expect(unavailableRead.result.issues[0]?.code).toBe('SOURCE_UNAVAILABLE');
  });

  it('keeps private shadow input causal, matches only a later reply, and separates modes', () => {
    const frozen = freezeShadowInput({
      transportId: 'transport:fixture',
      threadId: 'thread:private',
      triggerMessageId: 'message:inbound',
      asOfAt: '2026-09-10T10:00:00.000Z',
      messages: [
        {
          id: 'message:inbound',
          direction: 'inbound',
          subject: 'Reservation question',
          textBody: 'Can you confirm breakfast?',
          htmlBody: null,
          receivedAt: '2026-09-10T09:00:00.000Z',
          sentAt: null,
          createdAt: '2026-09-10T09:00:00.000Z',
          attachmentIds: [],
        },
        {
          id: 'message:future-reply',
          direction: 'outbound',
          subject: 'Re: Reservation question',
          textBody: 'Breakfast is included.',
          htmlBody: null,
          receivedAt: null,
          sentAt: '2026-09-10T11:00:00.000Z',
          createdAt: '2026-09-10T11:00:00.000Z',
          attachmentIds: [],
        },
      ],
    });
    expect(frozen.messageIds).toEqual(['message:inbound']);
    expect(frozen.excludedFutureMessageIds).toEqual(['message:future-reply']);
    expect(frozen.modelMessages).toHaveLength(1);
    expect(JSON.stringify(frozen.modelMessages)).not.toContain('Breakfast is included');

    const output = validateShadowPredictionOutput({
      outcome: 'complete',
      facts: { breakfast: 'unknown' },
      limitations: ['private shadow only'],
    });
    const seal = createShadowPredictionSeal({
      predictionKey: 'shadow-prediction:u11-integrated',
      transportId: 'transport:fixture',
      threadId: 'thread:private',
      triggerMessageId: 'message:inbound',
      frozen,
      output,
      route: {
        routeId: 'u11-private-shadow-synthetic',
        purpose: 'shadow',
        protocol: 'in_process',
        access: 'current_app',
        egress: 'none',
        retention: 'bounded',
        usage: 'reported',
        modelId: 'u11-private-shadow-synthetic-model',
      },
      modelUsage: { inputTokens: 0, outputTokens: 0, latencyMs: 0 },
      sealedAt: '2026-09-10T10:00:01.000Z',
      observationEndsAt: '2026-09-17T10:00:00.000Z',
    });
    expect(seal.evaluationMode).toBe('future_shadow');
    expect(seal.predictionStatus).toBe('sealed');

    const match = matchShadowReference(
      {
        id: seal.predictionKey,
        transportId: seal.transportId,
        threadId: seal.threadId,
        triggerMessageId: seal.triggerMessageId,
        asOfAt: seal.asOfAt,
      },
      [
        {
          id: 'message:future-reply',
          transportId: seal.transportId,
          threadId: seal.threadId,
          direction: 'outbound',
          createdAt: '2026-09-10T11:00:00.000Z',
          sentAt: '2026-09-10T11:00:00.000Z',
          messageIdHeader: '<future-reply@example.test>',
          inReplyTo: null,
          references: null,
        },
      ],
    );
    expect(match).toMatchObject({ status: 'matched', linkStrength: 'thread' });

    const population = buildShadowAdmissionPopulation({
      evaluationMode: 'future_shadow',
      admissions: [
        {
          id: 'shadow-prediction:u11-integrated',
          eligible: true,
          admissionStatus: 'admitted',
          hasSealedPrediction: true,
        },
        {
          id: 'shadow-pending:u11-integrated',
          eligible: true,
          admissionStatus: 'admitted',
          hasSealedPrediction: false,
        },
      ],
      windowStart: '2026-09-10T00:00:00.000Z',
      windowEnd: '2026-09-17T00:00:00.000Z',
      observationCutoff: '2026-09-18T00:00:00.000Z',
    });
    const scorecard = buildShadowScorecard({
      evaluationMode: 'future_shadow',
      predictions: [
        {
          id: seal.predictionKey,
          predictionId: seal.predictionKey,
          evaluationMode: 'future_shadow',
          admissionStatus: 'admitted',
          predictionStatus: 'sealed',
        },
      ],
      assessments: [
        {
          predictionId: seal.predictionKey,
          evaluationMode: 'future_shadow',
          status: 'matched',
          labelProvenance: {
            source: 'independent_source',
            labelId: 'label:u11-independent',
            unique: true,
            bound: true,
          },
          verdict: 'partial',
        },
      ],
      admissionPopulation: population,
    });
    expect(scorecard.counts).toMatchObject({
      eligible: 1,
      sealed: 1,
      matched: 1,
      partial: 1,
      pending: 0,
    });
    expect(scorecard.admissionPopulation.counts.pending).toBe(1);
    expect(() =>
      buildShadowScorecard({
        evaluationMode: 'future_shadow',
        predictions: [
          {
            id: 'historical-leak',
            evaluationMode: 'historical_replay',
            admissionStatus: 'admitted',
            predictionStatus: 'sealed',
          },
        ],
        assessments: [],
      }),
    ).toThrow(/evaluation mode/i);
  });

  it('uses the real authenticated manual mail route and queue with only SMTP faked', async () => {
    const priorUndo = process.env.UNDO_SEND_SECONDS;
    process.env.UNDO_SEND_SECONDS = '0';
    try {
      await withSeededTestDb(async (db) => {
        const threadId = 'u11-integration-mail-thread';
        const inboundId = 'u11-integration-mail-inbound';
        await db.insert(mailThread).values({
          id: threadId,
          transportId: 'transport-centurion',
          threadRootId: `<${threadId}@example.test>`,
          subject: 'U11 integration request',
          snippet: 'Please confirm my reservation.',
          latestMessageAt: new Date(NOW),
        });
        await db.insert(message).values({
          id: inboundId,
          transportId: 'transport-centurion',
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.test',
          toAddresses: ['centurion@legacyhotels.co.za'],
          subject: 'U11 integration request',
          textBody: 'Please confirm my reservation.',
          receivedAt: new Date(NOW),
          messageIdHeader: '<u11-inbound@example.test>',
          references: [],
        });

        const fake = new FakeSmtpTransport();
        __setSmtpTransportForTests(fake);
        try {
          const caller = await callerFor('user-navaai', {
            db,
            requestedTransportId: 'transport-centurion',
          });
          const sent = await caller.mail.send({
            threadId,
            to: ['guest@example.test'],
            subject: 'Re: U11 integration request',
            html: '<p>We will follow up shortly.</p>',
            text: 'We will follow up shortly.',
          });
          expect(sent.sent).toBe(true);
          expect(fake.sent).toHaveLength(1);

          const [outbound] = await db
            .select({ direction: message.direction, threadId: message.threadId })
            .from(message)
            .where(eq(message.id, sent.messageId));
          expect(outbound).toEqual({ direction: 'outbound', threadId });
          const [queue] = await db
            .select({ status: outboundSendQueue.status })
            .from(outboundSendQueue)
            .where(eq(outboundSendQueue.messageId, sent.messageId));
          expect(queue?.status).toBe('sent');
        } finally {
          __setSmtpTransportForTests(null);
        }
      });
    } finally {
      if (priorUndo === undefined) delete process.env.UNDO_SEND_SECONDS;
      else process.env.UNDO_SEND_SECONDS = priorUndo;
    }
  });
});
