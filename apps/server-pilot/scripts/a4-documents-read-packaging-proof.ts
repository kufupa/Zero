/**
 * Wave A4 packaging-class byte digest proof for documents_read_existing.
 * Uses in-memory S3 + fixture bytes — no live PII, no Vitest DATABASE_URL.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeS3Storage } from '../src/storage/s3.js';
import {
  createExistingDocumentService,
  type ExistingDocumentRecord,
} from '../src/mail/artifacts/existing-document-service.js';

const NOW = '2026-09-12T13:00:00.000Z';
const SCOPE = 'a4-packaging-scope-ref';
const BODY = Buffer.from(
  'Centurion packaging-class tax invoice fixture bytes — synthetic, no live guest PII.\n',
  'utf8',
);
const BODY_SHA256 = createHash('sha256').update(BODY).digest('hex');

async function main(): Promise<void> {
  const outDir =
    process.env.A4_PACKAGING_OUT_DIR?.trim() ||
    join(process.cwd(), '../../.private/wave-a-20260912/a4-packaging');
  await mkdir(outDir, { recursive: true, mode: 0o700 });

  const s3 = new FakeS3Storage('a4-documents-packaging');
  await s3.putObject({
    key: 'attachments/message-a4/invoice.txt',
    body: BODY,
    contentType: 'text/plain',
  });

  const record: ExistingDocumentRecord = {
    sourceRecordId: 'invoice-a4-packaging',
    scopeRef: SCOPE,
    source: 'mail_attachment',
    kind: 'tax_invoice',
    version: 'v1',
    issuedAt: NOW,
    status: 'final',
    parentRef: 'parent-ref-a4',
    payerRef: 'payer-ref-a4',
    displayName: 'invoice-packaging.txt',
    mime: 'text/plain',
    sizeBytes: BODY.byteLength,
    sha256: BODY_SHA256,
    priceVisibility: 'hidden',
    propertyRef: 'property-ref-packaging',
    guestRef: 'guest-ref-a4',
    stayStart: '2026-09-10',
    stayEnd: '2026-09-12',
    currentVersion: true,
    attachment: {
      attachmentId: 'attachment-a4',
      authorizedAttachmentIds: new Set(['attachment-a4']),
      locator: {
        s3Key: 'attachments/message-a4/invoice.txt',
        mimeType: 'text/plain',
        sizeBytes: BODY.byteLength,
        messageId: 'message-a4',
      },
    },
  };

  const documents = createExistingDocumentService({
    now: () => new Date(NOW),
    resolveScope: async (scopeRef) =>
      scopeRef === SCOPE
        ? {
            scopeRef: SCOPE,
            propertyRef: 'property-ref-packaging',
            guestRef: 'guest-ref-a4',
            stayStart: '2026-09-10',
            stayEnd: '2026-09-12',
            payerRef: 'payer-ref-a4',
            requestedKind: 'tax_invoice',
            requestedPriceVisibility: 'allowed',
          }
        : null,
    sources: {
      mail_attachment: {
        source: 'mail_attachment',
        list: async () => ({ records: [record], inventoryComplete: true }),
      },
    },
    readArtifact: async (attachment) => {
      const { readAuthorizedArtifact } = await import(
        '../src/mail/artifacts/read-artifact.js'
      );
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
  });

  const listed = await documents.documents_list_existing({
    scopeRef: SCOPE,
    source: 'mail_attachment',
    kinds: ['tax_invoice'],
    limit: 10,
  });
  if (listed.status !== 'ok' || !listed.data?.documents?.[0]) {
    throw new Error(
      `list failed: ${listed.status} blocker=${(listed as { blocker?: string }).blocker ?? ''}`,
    );
  }
  const documentRef = listed.data.documents[0]!.documentRef;

  const read = await documents.documents_read_existing({
    documentRef,
    format: 'text',
  });
  if (read.status !== 'ok' || !read.data) {
    throw new Error(`read failed: ${read.status}`);
  }

  const actualSha = read.data.document.sha256;
  const pass = actualSha === BODY_SHA256 && read.data.document.sizeBytes === BODY.byteLength;

  const oracle = {
    schemaVersion: 1,
    toolId: 'documents_read_existing',
    expectedSha256: BODY_SHA256,
    expectedBytes: BODY.byteLength,
    kind: 'tax_invoice',
    source: 'mail_attachment',
  };
  const result = {
    schemaVersion: 1,
    toolId: 'documents_read_existing',
    status: read.status,
    documentRef,
    sha256: actualSha,
    sizeBytes: read.data.document.sizeBytes,
    kind: read.data.document.kind,
    source: read.data.document.source,
  };
  const mailProof = {
    schemaVersion: 1,
    toolId: 'documents_read_existing',
    proofClass: 'packaging_byte_digest',
    finishedAt: new Date().toISOString(),
    fixtureBytes: BODY.byteLength,
    fixtureSha256: BODY_SHA256,
    actualSha256: actualSha,
    integrity: { bytesMatch: pass },
    notes:
      'Packaging-class byte digest proof via authorized mail_attachment path. Synthetic fixture; no live guest PII.',
  };
  const compare = {
    schemaVersion: 1,
    toolId: 'documents_read_existing',
    finishedAt: new Date().toISOString(),
    allRequiredPass: pass,
    verdict: pass ? 'PASS_DOCUMENTS_READ_BYTE_DIGEST' : 'FAIL_DIGEST_MISMATCH',
    rows: [
      {
        field: 'document.sha256',
        expected: BODY_SHA256,
        actual: actualSha,
        required: true,
        pass: actualSha === BODY_SHA256,
      },
      {
        field: 'document.sizeBytes',
        expected: BODY.byteLength,
        actual: read.data.document.sizeBytes,
        required: true,
        pass: read.data.document.sizeBytes === BODY.byteLength,
      },
      {
        field: 'document.kind',
        expected: 'tax_invoice',
        actual: read.data.document.kind,
        required: true,
        pass: read.data.document.kind === 'tax_invoice',
      },
    ],
    packaging: {
      video: 'n/a_non_pms',
      mailProof: pass ? 'present' : 'failed',
      mailProofPath: join(outDir, 'mailProof.v1.json'),
      fixtureSha256: BODY_SHA256,
    },
  };

  await writeFile(join(outDir, 'oracle.v1.json'), `${JSON.stringify(oracle, null, 2)}\n`, {
    mode: 0o600,
  });
  await writeFile(join(outDir, 'result.v1.json'), `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
  await writeFile(join(outDir, 'mailProof.v1.json'), `${JSON.stringify(mailProof, null, 2)}\n`, {
    mode: 0o600,
  });
  await writeFile(join(outDir, 'compare.v1.json'), `${JSON.stringify(compare, null, 2)}\n`, {
    mode: 0o600,
  });

  process.stdout.write(
    JSON.stringify({
      ok: pass,
      outDir,
      fixtureSha256: BODY_SHA256,
      actualSha256: actualSha,
      verdict: compare.verdict,
    }) + '\n',
  );
  if (!pass) process.exit(1);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : 'a4_packaging_failed';
  process.stderr.write(`${msg.slice(0, 200)}\n`);
  process.exit(1);
});
