import {
  createExistingDocumentService,
  createMetadataOnlyDocumentSource,
  type ExistingDocumentRecord,
} from '../src/mail/artifacts/existing-document-service.js';
import { FakeS3Storage } from '../src/storage/s3.js';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

const NOW = '2026-09-08T12:00:00.000Z';
const SCOPE = 'scope-ref-1';
const BODY = Buffer.from('invoice bytes', 'utf8');
const BODY_SHA256 = createHash('sha256').update(BODY).digest('hex');

function record(overrides: Partial<ExistingDocumentRecord> = {}): ExistingDocumentRecord {
  return {
    sourceRecordId: 'invoice-1',
    scopeRef: SCOPE,
    source: 'mail_attachment',
    kind: 'tax_invoice',
    version: 'v2',
    issuedAt: NOW,
    status: 'final',
    parentRef: 'parent-ref-1',
    payerRef: 'payer-ref-1',
    displayName: 'invoice.pdf',
    mime: 'text/plain',
    sizeBytes: BODY.byteLength,
    sha256: BODY_SHA256,
    priceVisibility: 'hidden',
    propertyRef: 'property-ref-1',
    guestRef: 'guest-ref-1',
    stayStart: '2026-09-10',
    stayEnd: '2026-09-12',
    currentVersion: true,
    attachment: {
      attachmentId: 'attachment-1',
      authorizedAttachmentIds: new Set(['attachment-1']),
      locator: {
        s3Key: 'attachments/message-1/invoice.txt',
        mimeType: 'text/plain',
        sizeBytes: BODY.byteLength,
        messageId: 'message-1',
      },
    },
    ...overrides,
  };
}

function service(
  records: ExistingDocumentRecord[] = [record()],
  options: { s3?: FakeS3Storage } = {},
) {
  const s3 = options.s3 ?? new FakeS3Storage('documents-test');
  return {
    s3,
    service: createExistingDocumentService({
      now: () => new Date(NOW),
      resolveScope: async (scopeRef) =>
        scopeRef === SCOPE
          ? {
              scopeRef: SCOPE,
              propertyRef: 'property-ref-1',
              guestRef: 'guest-ref-1',
              stayStart: '2026-09-10',
              stayEnd: '2026-09-12',
              payerRef: 'payer-ref-1',
              requestedKind: 'tax_invoice',
              requestedPriceVisibility: 'allowed',
            }
          : null,
      sources: {
        mail_attachment: {
          source: 'mail_attachment',
          list: async () => ({ records }),
        },
      },
      readArtifact: async (attachment) => {
        const { readAuthorizedArtifact } = await import('../src/mail/artifacts/read-artifact.js');
        return readAuthorizedArtifact({
          attachmentId: attachment.attachmentId,
          authorizedAttachmentIds: attachment.authorizedAttachmentIds,
          s3,
          signal: AbortSignal.timeout(5_000),
          resolveLocator: async () => attachment.locator,
        });
      },
      readBytes: async (attachment) => {
        const { readAuthorizedArtifactBytes } = await import(
          '../src/mail/artifacts/read-artifact.js'
        );
        return readAuthorizedArtifactBytes({
          attachmentId: attachment.attachmentId,
          authorizedAttachmentIds: attachment.authorizedAttachmentIds,
          s3,
          signal: AbortSignal.timeout(5_000),
          resolveLocator: async () => attachment.locator,
        });
      },
    }),
  };
}

describe('existing document service', () => {
  it('lists mailbox metadata with an opaque ref and explicit pagination', async () => {
    const { service: documents } = service();
    const result = await documents.documents_list_existing({
      scopeRef: SCOPE,
      source: 'mail_attachment',
      limit: 20,
    });

    expect(result.status).toBe('ok');
    expect(result.data?.documents).toHaveLength(1);
    expect(result.data?.documents[0]).toMatchObject({
      source: 'mail_attachment',
      kind: 'tax_invoice',
      retrievable: true,
      sha256: BODY_SHA256,
      priceVisibility: 'hidden',
    });
    expect(result.data?.documents[0]?.documentRef).not.toBe('invoice-1');
    expect(result.data?.page).toEqual({ returnedCount: 1, hasMore: false, nextCursor: null });
    expect(JSON.stringify(result)).not.toContain('attachments/message-1');
  });

  it('reads validated mailbox text through the existing bounded artifact path', async () => {
    const s3 = new FakeS3Storage('documents-test');
    await s3.putObject({
      key: 'attachments/message-1/invoice.txt',
      body: BODY,
      contentType: 'text/plain',
    });
    const { service: documents } = service([record()], { s3 });
    const listed = await documents.documents_list_existing({
      scopeRef: SCOPE,
      source: 'mail_attachment',
    });
    const ref = listed.data?.documents[0]?.documentRef;
    expect(ref).toEqual(expect.any(String));

    const result = await documents.documents_read_existing({
      documentRef: ref!,
      format: 'text',
    });

    expect(result.status).toBe('ok');
    expect(result.data).toMatchObject({
      text: 'invoice bytes',
      artifactRef: null,
      extractionState: 'complete',
      validation: {
        identity: 'match',
        stayDates: 'match',
        payer: 'match',
        kind: 'match',
        version: 'current',
        priceVisibility: 'allowed',
      },
    });
    expect(result.data?.document.sha256).toBe(BODY_SHA256);
  });

  it('denies artifact mode without a scoped private artifact resolver', async () => {
    const s3 = new FakeS3Storage('documents-test');
    await s3.putObject({
      key: 'attachments/message-1/invoice.txt',
      body: BODY,
      contentType: 'text/plain',
    });
    const { service: documents } = service([record()], { s3 });
    const listed = await documents.documents_list_existing({
      scopeRef: SCOPE,
      source: 'mail_attachment',
    });
    const result = await documents.documents_read_existing({
      documentRef: listed.data!.documents[0]!.documentRef!,
      format: 'artifact',
    });

    expect(result.status).toBe('manual_required');
    expect(result.data?.text).toBeNull();
    expect(result.data?.artifactRef).toBeNull();
    expect(result.blocker).toBe('UNSUPPORTED_FORMAT');
  });

  it('denies cross-scope reads and changed locator/hash before bytes become usable', async () => {
    const s3 = new FakeS3Storage('documents-test');
    await s3.putObject({
      key: 'attachments/message-1/invoice.txt',
      body: BODY,
      contentType: 'text/plain',
    });
    const { service: documents } = service([record()], { s3 });

    // The service keeps the source record behind its opaque ref. A source-side
    // hash change must therefore be caught on the same service instance.
    const listedRecord = record();
    const changed = service([listedRecord], { s3 });
    const changedListing = await changed.service.documents_list_existing({
      scopeRef: SCOPE,
      source: 'mail_attachment',
    });
    const changedRef = changedListing.data!.documents[0]!.documentRef!;
    listedRecord.sha256 = 'c'.repeat(64);
    await expect(
      changed.service.documents_read_existing({ documentRef: changedRef, format: 'text' }),
    ).resolves.toMatchObject({
      status: 'manual_required',
      blocker: 'DOCUMENT_CHANGED',
    });

    await expect(
      documents.documents_read_existing({ documentRef: 'foreign-ref', format: 'text' }),
    ).resolves.toMatchObject({
      status: 'manual_required',
      blocker: 'SCOPE_DENIED',
    });
  });

  it('keeps metadata-only PMS and sent-log outcomes non-retrievable', async () => {
    const documents = createExistingDocumentService({
      now: () => new Date(NOW),
      resolveScope: async () => ({
        scopeRef: SCOPE,
        propertyRef: 'property-ref-1',
        requestedPriceVisibility: 'allowed',
      }),
      sources: {
        hms_finalized_document: createMetadataOnlyDocumentSource({
          source: 'hms_finalized_document',
          records: [record({ source: 'hms_finalized_document', attachment: undefined })],
          blocker: 'SURFACE_UNPROVEN',
        }),
        hms_sent_attachment: createMetadataOnlyDocumentSource({
          source: 'hms_sent_attachment',
          records: [record({ source: 'hms_sent_attachment', attachment: undefined })],
          blocker: 'METADATA_ONLY',
        }),
      },
    });

    for (const source of ['hms_finalized_document', 'hms_sent_attachment'] as const) {
      const listed = await documents.documents_list_existing({ scopeRef: SCOPE, source });
      expect(listed.status).toBe('ok');
      expect(listed.data?.documents[0]?.retrievable).toBe(false);
      expect(listed.data?.documents[0]?.artifactRef).toBeUndefined();
      expect(listed.data?.documents[0]?.retrievalBlocker).toBeTruthy();
    }
  });

  it('retains partial/manual extraction outcomes for unsupported or scan-only files', async () => {
    const s3 = new FakeS3Storage('documents-test');
    await s3.putObject({
      key: 'attachments/message-1/invoice.txt',
      body: BODY,
      contentType: 'application/octet-stream',
    });
    const { service: documents } = service([record()], { s3 });
    const listed = await documents.documents_list_existing({
      scopeRef: SCOPE,
      source: 'mail_attachment',
    });
    const result = await documents.documents_read_existing({
      documentRef: listed.data!.documents[0]!.documentRef!,
      format: 'text',
    });

    expect(result.status).toBe('manual_required');
    expect(result.data?.text).toBeNull();
    expect(result.data?.artifactRef).toBeNull();
    expect(result.data?.extractionState).toBe('unsupported');
    expect(result.blocker).toBe('UNSUPPORTED_FORMAT');
  });
});
