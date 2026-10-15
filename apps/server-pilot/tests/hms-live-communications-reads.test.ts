import {
  createLiveSentEmailObserver,
  minimizeCorrelatedSentEmailRows,
  parsePssnelHdrTransportRows,
  toSentDocumentMetadata,
  toSentEmailAudit,
  type MinimizedSentEmailRows,
} from '../src/hms/live-sent-email-observer.js';
import {
  SENT_EMAIL_AUDIT_MAX_BYTES,
  SENT_EMAIL_AUDIT_MAX_DURATION_MS,
  SENT_EMAIL_AUDIT_MAX_ROWS,
} from '../src/hms/sent-email-audit-contract.js';
import {
  createLiveDocumentListDriver,
  TAX_INVOICE_SURFACE_BLOCKER,
} from '../src/hms/live-document-list-driver.js';
import {
  DOCUMENT_LIST_MAX_BYTES,
  DOCUMENT_LIST_MAX_DURATION_MS,
  DOCUMENT_LIST_MAX_ROWS,
} from '../src/hms/document-list-contract.js';
import {
  createExistingDocumentService,
  type ExistingDocumentRecord,
} from '../src/mail/artifacts/existing-document-service.js';
import {
  readAuthorizedArtifact,
  readAuthorizedArtifactBytes,
} from '../src/mail/artifacts/read-artifact.js';
import {
  buildLiveSentEmailListManifest,
  LIVE_SENT_EMAIL_LIST_PATH,
} from '../src/hms/live-read-manifest.js';
import { readAdmissionSchema, readResultSchema } from '../src/hms/read-service-contracts.js';
import { executeReadToolRun, type ReadExecutionContext } from '../src/hms/read-service.js';
import { HmsRuntimeError, type HmsPage, type HmsRuntime } from '../src/hms/runtime.js';
import type { HmsSessionAuthorization } from '../src/hms/release-kernel.js';
import type { ReadCandidateChild } from '../src/hms/candidate-graph.js';
import { issueReadAdmission } from '../src/hms/read-admission.js';
import { READ_TOOLS } from '../src/hms/read-tools.js';
import { FakeS3Storage } from '../src/storage/s3.js';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://appsrv-1.legacyhotels.co.za';
const NOW = '2026-08-06T12:00:00.000Z';
const SCOPE = 'a'.repeat(64);
const ACCOUNT = '12345';
const RECIPIENT = 'guest.name@example.com';
const DOCUMENT_SCOPE = 'document-scope-1';
const DOCUMENT_PROPERTY = 'property-document-1';
const DOCUMENT_GUEST = 'guest-document-1';
const DOCUMENT_PAYER = 'payer-document-1';
const DOCUMENT_BODY = Buffer.from('normal document bytes', 'utf8');
const DOCUMENT_SHA256 = createHash('sha256').update(DOCUMENT_BODY).digest('hex');

function pssnelEnvelope(rows: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    pageData: {
      success: true,
      fromCome: true,
      grid: {
        GRIDRESULT: {
          type: 'LIST.DATA_ONLY.STORED',
          GRID: {
            DATA: rows,
          },
        },
      },
    },
  });
}

function auth(overrides: Partial<HmsSessionAuthorization> = {}): HmsSessionAuthorization {
  const manifest = buildLiveSentEmailListManifest(ORIGIN);
  return {
    operationId: randomUUID(),
    toolId: 'hms_sent_email_audit',
    discoveryOperationId: 'sent_email_list',
    releaseId: randomUUID(),
    requestBranchId: 'sent_email_audit',
    manifest,
    manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    roleProofPath: '/tmp/role-proof-sent.v2.json',
    roleProofSha256: 'b'.repeat(64),
    credentialVersionHmacSha256: 'c'.repeat(64),
    runtimeFingerprintSha256: 'd'.repeat(64),
    privateDigestKeyVersion: 'v1',
    sourceRevision: 'test-rev',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function child(overrides: Partial<ReadCandidateChild> = {}): ReadCandidateChild {
  return {
    id: randomUUID(),
    sessionId: randomUUID(),
    parentEvidenceId: randomUUID(),
    toolId: 'hms_sent_email_audit',
    requestBranchId: 'sent_email_audit',
    propertyCode: 'HRCEN',
    scopeHash: SCOPE,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function mockRuntime(htmlOrBody: string) {
  const posts: Array<{ path: string; fields: Record<string, string> }> = [];
  const page: Partial<HmsPage> = {
    async content() {
      return htmlOrBody;
    },
    async click() {},
    async evaluate() {
      return {};
    },
    async postForm(url: string, fields: Record<string, string>) {
      posts.push({ path: new URL(url).pathname, fields });
      return htmlOrBody;
    },
    waitForCorrelatedResponse: async () => undefined,
  };
  const session = {
    id: 'sent-session',
    origin: ORIGIN,
    page: page as HmsPage,
    violation: () => null,
    terminal: () => false,
    close: vi.fn(async () => undefined),
  };
  const runtime = {
    openReadSession: vi.fn(async () => session),
  } as unknown as HmsRuntime;
  return { runtime, posts, session };
}

function samplePrivateRows() {
  return parsePssnelHdrTransportRows(
    pssnelEnvelope([
      {
        emailtype: 'Transactional',
        account: ACCOUNT,
        accountname: 'Guest',
        subject: 'Reservation confirmation 12345',
        emailaddress: RECIPIENT,
        attachment: 'Y',
        userid: 'clerk1',
        error: '',
        report: 'CONFIRMATION',
        property: 'HRCEN',
        dbemaildatetime: '05-AUG-2026 10:00:00',
      },
      {
        emailtype: 'Report',
        account: ACCOUNT,
        subject: 'Tax Invoice 99',
        emailaddress: RECIPIENT,
        attachment: true,
        error: null,
        report: 'TAXINV',
        dbemaildatetime: '2026-08-05T11:00:00.000Z',
      },
      {
        emailtype: 'Transactional',
        account: 'OTHER',
        subject: 'Other stay',
        emailaddress: 'other@example.com',
        attachment: 'invoice.pdf',
        error: '',
        dbemaildatetime: '2026-08-05T12:00:00.000Z',
      },
    ]),
  );
}

function existingDocumentRecord(
  overrides: Partial<ExistingDocumentRecord> = {},
): ExistingDocumentRecord {
  return {
    sourceRecordId: 'normal-document-1',
    scopeRef: DOCUMENT_SCOPE,
    source: 'mail_attachment',
    kind: 'tax_invoice',
    version: 'v2',
    issuedAt: '2026-08-05T10:00:00.000Z',
    status: 'final',
    parentRef: 'parent-document-1',
    payerRef: DOCUMENT_PAYER,
    displayName: 'invoice.pdf',
    mime: 'text/plain',
    sizeBytes: DOCUMENT_BODY.byteLength,
    sha256: DOCUMENT_SHA256,
    priceVisibility: 'hidden',
    propertyRef: DOCUMENT_PROPERTY,
    guestRef: DOCUMENT_GUEST,
    stayStart: '2026-08-10',
    stayEnd: '2026-08-12',
    currentVersion: true,
    attachment: {
      attachmentId: 'document-attachment-1',
      authorizedAttachmentIds: new Set(['document-attachment-1']),
      locator: {
        s3Key: 'attachments/document-message-1/invoice.txt',
        mimeType: 'text/plain',
        sizeBytes: DOCUMENT_BODY.byteLength,
        messageId: 'document-message-1',
      },
    },
    ...overrides,
  };
}

function normalDocumentService(
  s3: FakeS3Storage,
  records: ExistingDocumentRecord[] = [existingDocumentRecord()],
) {
  return createExistingDocumentService({
    now: () => new Date(NOW),
    resolveScope: async (scopeRef) =>
      scopeRef === DOCUMENT_SCOPE
        ? {
            scopeRef: DOCUMENT_SCOPE,
            propertyRef: DOCUMENT_PROPERTY,
            guestRef: DOCUMENT_GUEST,
            stayStart: '2026-08-10',
            stayEnd: '2026-08-12',
            payerRef: DOCUMENT_PAYER,
            requestedKind: 'tax_invoice',
            requestedPriceVisibility: 'allowed' as const,
          }
        : null,
    sources: {
      mail_attachment: {
        source: 'mail_attachment',
        list: async () => ({ records }),
      },
      hms_sent_attachment: {
        source: 'hms_sent_attachment',
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

function documentReadContext(
  service: ReturnType<typeof normalDocumentService>,
  overrides: Partial<ReadExecutionContext> = {},
): ReadExecutionContext {
  return {
    transportId: 'document-transport',
    mailboxId: 'document-mailbox',
    threadId: 'document-thread',
    triggerMessageId: 'document-trigger',
    propertyCode: 'HRCEN',
    parentRef: 'document-parent',
    branchId: 'existing_documents',
    releaseId: 'document-release',
    requester: {
      authorizationId: 'document-grant',
      transportId: 'document-transport',
      threadId: 'document-thread',
      triggerMessageId: 'document-trigger',
      allowedClaimKinds: ['document_metadata'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
    signal: new AbortController().signal,
    budget: { total: 0, limit: 3 },
    now: () => new Date(NOW),
    requireAdmissionBinding: true,
    propertyReadLock: {
      key: 'document-lock',
      withLock: async (callback) =>
        callback({ query: async () => [], close: async () => undefined }),
    },
    existingDocumentService: service,
    ...overrides,
  } as ReadExecutionContext;
}

function issueDocumentAdmission(input: {
  toolId: 'documents_list_existing' | 'documents_read_existing';
  request: Record<string, unknown>;
}) {
  return issueReadAdmission({
    source: {
      userId: 'document-user',
      mailboxAccessId: 'document-grant',
      transportId: 'document-transport',
      threadId: 'document-thread',
      triggerMessageId: 'document-trigger',
      releaseId: 'document-release',
      requestBranchId: 'existing_documents',
    },
    now: new Date(NOW),
    toolId: input.toolId,
    request: input.request,
  });
}

describe('PSSNEL transport parser', () => {
  it('parses GRIDRESULT rows and rejects fixture HTML', () => {
    const parsed = samplePrivateRows();
    expect(parsed.envelopeRecognized).toBe(true);
    expect(parsed.rows).toHaveLength(3);
    expect(() => parsePssnelHdrTransportRows('<div data-testid="sent-email-row"></div>')).toThrow(
      HmsRuntimeError,
    );
  });
});

describe('minimize + adapters (no PII leakage)', () => {
  it('correlates exact recipient + account server-side and redacts PII', () => {
    const parsed = samplePrivateRows();
    const minimized = minimizeCorrelatedSentEmailRows({
      privateRows: parsed.rows,
      scopeClass: 'reservation',
      scopeHash: SCOPE,
      expectedRecipient: RECIPIENT,
      expectedAccountToken: ACCOUNT,
      observedAt: NOW,
      durationMs: 40,
      bytesObserved: 1200,
    });
    expect(minimized.rows).toHaveLength(2);
    expect(minimized.recipientMatch).toBe('exact_redacted');
    const serialized = JSON.stringify(minimized);
    expect(serialized).not.toContain(RECIPIENT);
    expect(serialized).not.toContain('guest.name');
    expect(serialized).not.toContain('Reservation confirmation 12345');
    expect(serialized).not.toContain('invoice.pdf');
    expect(serialized).not.toContain('other@example.com');

    const audit = toSentEmailAudit(minimized);
    expect(audit.status).toBe('ok');
    expect(audit.data.rows[0]?.subjectClass).toBe('reservation_confirmation');
    expect(JSON.stringify(audit)).not.toContain(RECIPIENT);

    const docs = toSentDocumentMetadata(minimized);
    expect(docs.status).toBe('ok');
    expect(docs.data.sourceClass).toBe('sent_email_attachment');
    expect(docs.data.rows.every((r) => r.retrievable === false)).toBe(true);
    expect(docs.data.rows.every((r) => r.attachmentPresent === true)).toBe(true);
    expect(JSON.stringify(docs)).not.toContain('invoice.pdf');
  });

  it('rejects recipient mismatch and foreign account rows', () => {
    const parsed = samplePrivateRows();
    const minimized = minimizeCorrelatedSentEmailRows({
      privateRows: parsed.rows,
      scopeClass: 'reservation',
      scopeHash: SCOPE,
      expectedRecipient: 'nobody@example.com',
      expectedAccountToken: ACCOUNT,
      observedAt: NOW,
      durationMs: 10,
      bytesObserved: 100,
    });
    expect(minimized.rows).toHaveLength(0);
    expect(toSentEmailAudit(minimized).status).toBe('unverified_negative');
  });

  it('enforces row/time/byte caps in adapters', () => {
    const base: MinimizedSentEmailRows = {
      scopeClass: 'reservation',
      recipientMatch: 'exact_redacted',
      rows: Array.from({ length: SENT_EMAIL_AUDIT_MAX_ROWS }, () => ({
        sentAt: NOW,
        emailType: 'transactional' as const,
        subjectClass: 'other_transactional' as const,
        documentType: 'other_sent_document' as const,
        attachmentPresent: true,
        reportCode: null,
        errorClass: 'none' as const,
        observedAt: NOW,
      })),
      rowsScanned: SENT_EMAIL_AUDIT_MAX_ROWS,
      bytesObserved: SENT_EMAIL_AUDIT_MAX_BYTES,
      durationMs: SENT_EMAIL_AUDIT_MAX_DURATION_MS,
      observedAt: NOW,
    };
    expect(toSentEmailAudit(base).status).toBe('ok');
    expect(
      toSentEmailAudit({
        ...base,
        durationMs: SENT_EMAIL_AUDIT_MAX_DURATION_MS + 1,
      }).status,
    ).toBe('manual_required');
    expect(
      toSentEmailAudit({
        ...base,
        bytesObserved: SENT_EMAIL_AUDIT_MAX_BYTES + 1,
      }).status,
    ).toBe('manual_required');
    expect(
      toSentDocumentMetadata({
        ...base,
        durationMs: DOCUMENT_LIST_MAX_DURATION_MS + 1,
      }).status,
    ).toBe('manual_required');
    expect(DOCUMENT_LIST_MAX_ROWS).toBe(50);
    expect(DOCUMENT_LIST_MAX_BYTES).toBe(64 * 1024);
  });
});

describe('live observer binding + denied actions', () => {
  it('binds parent authorization + child and posts PSSNEL.HDR only', async () => {
    const body = pssnelEnvelope([
      {
        emailtype: 'Transactional',
        account: ACCOUNT,
        subject: 'Reservation confirmation',
        emailaddress: RECIPIENT,
        attachment: 'Y',
        error: '',
        report: 'CONFIRMATION',
        dbemaildatetime: '2026-08-05T10:00:00.000Z',
      },
    ]);
    const { runtime, posts } = mockRuntime(body);
    const observer = createLiveSentEmailObserver({
      runtime,
      transportId: 't1',
      expectedRecipient: RECIPIENT,
      expectedAccountToken: ACCOUNT,
    });
    const a = auth();
    const c = child({
      toolId: a.toolId,
      requestBranchId: a.requestBranchId,
    });
    const rows = await observer.observeSentEmailRows(a, c, new AbortController().signal);
    expect(rows.rows).toHaveLength(1);
    expect(posts.some((p) => p.path === LIVE_SENT_EMAIL_LIST_PATH)).toBe(true);
    expect(posts.every((p) => !/print|resend|export|generate|send/i.test(p.path))).toBe(true);
  });

  it('rejects stale auth, cross-tool child, unknown branch, wrong property', async () => {
    const { runtime } = mockRuntime(pssnelEnvelope([]));
    const observer = createLiveSentEmailObserver({
      runtime,
      transportId: 't1',
      expectedRecipient: RECIPIENT,
      expectedAccountToken: ACCOUNT,
    });
    const signal = new AbortController().signal;

    await expect(
      observer.observeSentEmailRows(
        auth({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
        child(),
        signal,
      ),
    ).rejects.toBeInstanceOf(HmsRuntimeError);

    await expect(
      observer.observeSentEmailRows(
        auth({ requestBranchId: 'tax_invoice_documents' }),
        child({ requestBranchId: 'tax_invoice_documents' }),
        signal,
      ),
    ).rejects.toBeInstanceOf(HmsRuntimeError);

    await expect(
      observer.observeSentEmailRows(
        auth(),
        child({ toolId: 'hms_list_documents', requestBranchId: 'sent_email_documents' }),
        signal,
      ),
    ).rejects.toBeInstanceOf(HmsRuntimeError);

    await expect(
      observer.observeSentEmailRows(auth(), child({ propertyCode: 'OTHER' }), signal),
    ).rejects.toBeInstanceOf(HmsRuntimeError);

    await expect(
      observer.observeSentEmailRows(
        auth(),
        child({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
        signal,
      ),
    ).rejects.toBeInstanceOf(HmsRuntimeError);
  });

  it('document driver maps sent-email branch and blocks tax invoice live', async () => {
    const body = pssnelEnvelope([
      {
        emailtype: 'Transactional',
        account: ACCOUNT,
        subject: 'Tax Invoice copy',
        emailaddress: RECIPIENT,
        attachment: true,
        error: '',
        dbemaildatetime: '2026-08-05T10:00:00.000Z',
      },
    ]);
    const { runtime } = mockRuntime(body);
    const driver = createLiveDocumentListDriver({
      runtime,
      transportId: 't1',
      expectedRecipient: RECIPIENT,
      expectedAccountToken: ACCOUNT,
      propertyCode: 'DVIN',
    });
    const a = auth({
      toolId: 'hms_list_documents',
      requestBranchId: 'sent_email_documents',
    });
    const c = child({
      toolId: 'hms_list_documents',
      requestBranchId: 'sent_email_documents',
      propertyCode: 'DVIN',
    });
    const docs = await driver.observeSentDocumentMetadata(a, c, new AbortController().signal);
    expect(docs.status).toBe('ok');
    expect(docs.evidence?.propertyCode).toBe('DVIN');
    expect(docs.data.sourceClass).toBe('sent_email_attachment');

    const taxAuth = auth({
      toolId: 'hms_list_documents',
      discoveryOperationId: 'tax_invoice_list',
      requestBranchId: 'tax_invoice_documents',
    });
    const taxChild = child({
      toolId: 'hms_list_documents',
      requestBranchId: 'tax_invoice_documents',
      propertyCode: 'DVIN',
    });
    const tax = await driver.observeTaxInvoiceMetadata(taxAuth, taxChild, new AbortController().signal);
    expect(tax.evidence?.propertyCode).toBe('DVIN');
    expect(tax.status).toBe('manual_required');
    expect(tax.unresolvedFields).toContain(TAX_INVOICE_SURFACE_BLOCKER);
  });
});

describe('normal model-free existing-document read path', () => {
  it('keeps non-capture document manifest null while rejecting null for capture-required reads', () => {
    const issued = issueDocumentAdmission({
      toolId: 'documents_list_existing',
      request: { scopeRef: DOCUMENT_SCOPE, source: 'mail_attachment' },
    });

    expect(readAdmissionSchema.parse(issued.admission)).toMatchObject({
      captureRequired: false,
      captureBindingRef: null,
      manifestSha256: null,
    });
    expect(() =>
      readAdmissionSchema.parse({
        ...issued.admission,
        captureRequired: true,
        captureBindingRef: 'capture-required-ref',
      }),
    ).toThrow(/manifest digest/i);
  });

  it('binds issuer → executor → typed receipt for list and validated text read', async () => {
    const s3 = new FakeS3Storage('normal-document-test');
    await s3.putObject({
      key: 'attachments/document-message-1/invoice.txt',
      body: DOCUMENT_BODY,
      contentType: 'text/plain',
    });
    const service = normalDocumentService(s3);
    const context = documentReadContext(service);
    const listIssued = issueDocumentAdmission({
      toolId: 'documents_list_existing',
      request: {
        scopeRef: DOCUMENT_SCOPE,
        source: 'mail_attachment',
        limit: 20,
      },
    });
    const listReceipt = await executeReadToolRun({
      runKind: 'read_tool',
      executorLane: 'hms',
      draftingEnabled: false,
      request: listIssued.readRequest,
      context,
      resultRef: 'document-list-result',
    });
    expect(listReceipt.modelId).toBe('not_applicable');
    expect(listReceipt.result.toolId).toBe('documents_list_existing');
    expect(listReceipt.result.status).toBe('ok');
    const listed = listReceipt.result.data as {
      documents: Array<{ documentRef: string }>;
    };
    const documentRef = listed.documents[0]?.documentRef;
    expect(documentRef).toEqual(expect.any(String));
    expect(readResultSchema.parse(listReceipt.result)).toEqual(listReceipt.result);

    const readIssued = issueDocumentAdmission({
      toolId: 'documents_read_existing',
      request: { documentRef, format: 'text' },
    });
    const readReceipt = await executeReadToolRun({
      runKind: 'read_tool',
      executorLane: 'hms',
      draftingEnabled: false,
      request: readIssued.readRequest,
      context,
      resultRef: 'document-read-result',
    });
    expect(readReceipt.result.toolId).toBe('documents_read_existing');
    expect(readReceipt.result.status).toBe('ok');
    expect(readReceipt.result.data).toMatchObject({
      text: 'normal document bytes',
      artifactRef: null,
      extractionState: 'complete',
    });
    expect(readResultSchema.parse(readReceipt.result)).toEqual(readReceipt.result);
  });

  it('rejects forged admission/request changes before the service is called', async () => {
    const service = normalDocumentService(new FakeS3Storage('normal-document-auth-test'));
    const context = documentReadContext(service);
    const issued = issueDocumentAdmission({
      toolId: 'documents_list_existing',
      request: { scopeRef: DOCUMENT_SCOPE, source: 'mail_attachment' },
    });
    const list = service.documents_list_existing;
    const spy = vi.spyOn(service, 'documents_list_existing');
    await expect(
      executeReadToolRun({
        runKind: 'read_tool',
        executorLane: 'hms',
        draftingEnabled: false,
        request: {
          ...issued.readRequest,
          source: 'hms_sent_attachment',
        },
        context,
        resultRef: 'document-forged-result',
      }),
    ).rejects.toMatchObject({ code: 'READ_INPUT_BINDING_MISMATCH' });
    expect(list).toBeTypeOf('function');
    expect(spy).not.toHaveBeenCalled();
  });

  it('denies an opaque document ref replayed into a new service scope', async () => {
    const first = normalDocumentService(new FakeS3Storage('normal-document-replay-1'));
    const firstList = await first.documents_list_existing({
      scopeRef: DOCUMENT_SCOPE,
      source: 'mail_attachment',
    });
    const documentRef = firstList.data!.documents[0]!.documentRef;
    const replay = normalDocumentService(new FakeS3Storage('normal-document-replay-2'));
    const context = documentReadContext(replay);
    const issued = issueDocumentAdmission({
      toolId: 'documents_read_existing',
      request: { documentRef, format: 'text' },
    });
    const receipt = await executeReadToolRun({
      runKind: 'read_tool',
      executorLane: 'hms',
      draftingEnabled: false,
      request: issued.readRequest,
      context,
      resultRef: 'document-replay-result',
    });
    expect(receipt.result.status).toBe('manual_required');
    expect(receipt.result.issues[0]?.code).toBe('SCOPE_DENIED');
  });

  it('keeps missing bytes and sent-log metadata explicit through the normal path', async () => {
    const missing = normalDocumentService(new FakeS3Storage('normal-document-missing'), [
      existingDocumentRecord({ attachment: undefined }),
    ]);
    const missingContext = documentReadContext(missing);
    const missingList = issueDocumentAdmission({
      toolId: 'documents_list_existing',
      request: { scopeRef: DOCUMENT_SCOPE, source: 'mail_attachment' },
    });
    const listed = await executeReadToolRun({
      runKind: 'read_tool',
      executorLane: 'hms',
      draftingEnabled: false,
      request: missingList.readRequest,
      context: missingContext,
      resultRef: 'document-missing-list',
    });
    const missingRef = (listed.result.data as { documents: Array<{ documentRef: string }> })
      .documents[0]!.documentRef;
    const missingRead = issueDocumentAdmission({
      toolId: 'documents_read_existing',
      request: { documentRef: missingRef, format: 'text' },
    });
    const missingReceipt = await executeReadToolRun({
      runKind: 'read_tool',
      executorLane: 'hms',
      draftingEnabled: false,
      request: missingRead.readRequest,
      context: missingContext,
      resultRef: 'document-missing-read',
    });
    expect(missingReceipt.result.status).toBe('manual_required');
    expect(missingReceipt.result.issues[0]?.code).toBe('SOURCE_UNAVAILABLE');

    const sent = normalDocumentService(new FakeS3Storage('normal-document-sent'), [
      existingDocumentRecord({
        source: 'hms_sent_attachment',
        attachment: undefined,
      }),
    ]);
    const sentContext = documentReadContext(sent);
    const sentList = issueDocumentAdmission({
      toolId: 'documents_list_existing',
      request: { scopeRef: DOCUMENT_SCOPE, source: 'hms_sent_attachment' },
    });
    const sentReceipt = await executeReadToolRun({
      runKind: 'read_tool',
      executorLane: 'hms',
      draftingEnabled: false,
      request: sentList.readRequest,
      context: sentContext,
      resultRef: 'document-sent-list',
    });
    expect(sentReceipt.result.status).toBe('ok');
    expect(
      (
        sentReceipt.result.data as {
          documents: Array<{ retrievable: boolean; retrievalBlocker: string | null }>;
        }
      ).documents[0],
    ).toMatchObject({ retrievable: false, retrievalBlocker: 'METADATA_ONLY' });
  });
});

describe('registry denied actions + shared manifest digest', () => {
  it('keeps attachment/preview/resend/generate/print/export denied', () => {
    for (const action of ['open_attachment', 'preview', 'resend', 'print', 'export', 'generate']) {
      expect(READ_TOOLS.hms_list_documents.deniedActions).toContain(action);
    }
    expect(READ_TOOLS.hms_sent_email_audit.deniedActions).toContain('open_attachment');
    expect(READ_TOOLS.hms_sent_email_audit.deniedActions).toContain('resend');
  });

  it('sent-email branches share discoveryOperationId sent_email_list', () => {
    const docsBranches = READ_TOOLS.hms_list_documents.requestBranches;
    const sentDocs = docsBranches.find((b) => b.id === 'sent_email_documents');
    const taxDocs = docsBranches.find((b) => b.id === 'tax_invoice_documents');
    const audit = READ_TOOLS.hms_sent_email_audit.requestBranches[0];
    expect(sentDocs?.discoveryOperationId).toBe('sent_email_list');
    expect(audit?.discoveryOperationId).toBe('sent_email_list');
    expect(taxDocs?.discoveryOperationId).toBe('tax_invoice_list');
    expect(sentDocs?.id).not.toBe(audit?.id);
  });
});
