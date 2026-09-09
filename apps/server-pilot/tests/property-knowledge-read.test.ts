import {
  propertyKnowledgeFixtureSchema,
  propertyKnowledgeSourceRecordSchema,
  type PropertyKnowledgeAudience,
  type PropertyKnowledgeTopic,
  type PropertyKnowledgeReadResult,
} from '../src/ai/property-knowledge-contract.js';
import {
  createExistingDocumentService,
  createMetadataOnlyDocumentSource,
  type ExistingDocumentRecord,
  type ExistingDocumentService,
} from '../src/mail/artifacts/existing-document-service.js';
import {
  createPropertyKnowledgeReader,
  createPropertyKnowledgeFileSource,
  createPropertyKnowledgeSource,
  type PropertyKnowledgeReader,
} from '../src/ai/property-knowledge-read.js';
import { issueCurrentAppAccessProof } from '../src/hms/requester-authorization.js';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createAgentReadTools } from '../src/hms/agent-read-tools.js';
import { execFile as execFileCallback } from 'node:child_process';
import { FakeS3Storage } from '../src/storage/s3.js';
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/property-knowledge.json',
);
const fixture = propertyKnowledgeFixtureSchema.parse(JSON.parse(readFileSync(fixturePath, 'utf8')));
const FILE_PATH = '/srv/centurion/property-knowledge.json';
const DOCUMENT_SCOPE = 'u16-document-scope';
const DOCUMENT_BODY = Buffer.from('native linked source text', 'utf8');
const DOCUMENT_HASH = createHash('sha256').update(DOCUMENT_BODY).digest('hex');
const execFile = promisify(execFileCallback);

function sourceHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function sourceChunks(text: string): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield Buffer.from(text, 'utf8');
  })();
}

function nativeDocumentRecord(
  overrides: Partial<ExistingDocumentRecord> = {},
): ExistingDocumentRecord {
  return {
    sourceRecordId: 'u16-native-document-1',
    scopeRef: DOCUMENT_SCOPE,
    source: 'mail_attachment',
    kind: 'other_existing',
    version: 'v1',
    issuedAt: NOW.toISOString(),
    status: 'final',
    parentRef: 'u16-native-parent',
    payerRef: 'u16-native-payer',
    displayName: 'property-information.txt',
    mime: 'text/plain',
    sizeBytes: DOCUMENT_BODY.byteLength,
    sha256: DOCUMENT_HASH,
    priceVisibility: 'hidden',
    propertyRef: 'HRCEN',
    guestRef: 'u16-native-guest',
    stayStart: '2026-09-10',
    stayEnd: '2026-09-12',
    currentVersion: true,
    attachment: {
      attachmentId: 'u16-native-attachment-1',
      authorizedAttachmentIds: new Set(['u16-native-attachment-1']),
      locator: {
        s3Key: 'attachments/u16-native-message-1/property-information.txt',
        mimeType: 'text/plain',
        sizeBytes: DOCUMENT_BODY.byteLength,
        messageId: 'u16-native-message-1',
      },
    },
    ...overrides,
  };
}

async function nativeDocumentFixture(
  options: {
    record?: ExistingDocumentRecord;
    blocker?: string;
    source?: ExistingDocumentRecord['source'];
    requestedPriceVisibility?: 'allowed' | 'forbidden' | 'unknown';
  } = {},
): Promise<{
  service: ExistingDocumentService;
  record: ExistingDocumentRecord;
  storage: FakeS3Storage;
}> {
  const storage = new FakeS3Storage('u16-native-documents');
  const record =
    options.record ?? nativeDocumentRecord({ source: options.source ?? 'mail_attachment' });
  if (record.attachment) {
    await storage.putObject({
      key: record.attachment.locator.s3Key,
      body: DOCUMENT_BODY,
      contentType: 'text/plain',
    });
  }
  const source = record.source;
  const service = createExistingDocumentService({
    now: () => NOW,
    resolveScope: async (scopeRef) =>
      scopeRef === DOCUMENT_SCOPE
        ? {
            scopeRef: DOCUMENT_SCOPE,
            propertyRef: 'HRCEN',
            guestRef: 'u16-native-guest',
            stayStart: '2026-09-10',
            stayEnd: '2026-09-12',
            payerRef: 'u16-native-payer',
            requestedKind: 'other_existing',
            requestedPriceVisibility: options.requestedPriceVisibility ?? 'allowed',
          }
        : null,
    sources: {
      [source]: options.blocker
        ? createMetadataOnlyDocumentSource({
            source,
            records: [record],
            blocker: options.blocker,
          })
        : {
            source,
            list: async () => ({ records: [record] }),
          },
    },
    readArtifact: async (attachment) => {
      const { readAuthorizedArtifact } = await import('../src/mail/artifacts/read-artifact.js');
      return readAuthorizedArtifact({
        attachmentId: attachment.attachmentId,
        authorizedAttachmentIds: attachment.authorizedAttachmentIds,
        s3: storage,
        signal: AbortSignal.timeout(5_000),
        resolveLocator: async () => attachment.locator,
      });
    },
  });
  return { service, record, storage };
}

function nativeKnowledgeRecord(documentRef: string, overrides: Record<string, unknown> = {}) {
  const content = 'native linked source text';
  return propertyKnowledgeSourceRecordSchema.parse({
    entryRef: 'knowledge-native-document',
    topic: 'check_in_out',
    content,
    sourceKind: 'mail_attachment',
    sourceRef: 'native-source-u16',
    sourceHash: DOCUMENT_HASH,
    version: 'v1',
    ownerRef: 'owner-native-u16',
    approval: {
      status: 'approved',
      approvedAt: '2026-09-01T09:00:00.000Z',
      approvalRef: 'approval-native-u16',
    },
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    effectiveUntil: null,
    propertyRef: 'HRCEN',
    audience: 'customer_disclosable',
    documentRefs: [documentRef],
    ...overrides,
  });
}

async function nativeDocumentRef(service: ExistingDocumentService): Promise<string> {
  const listed = await service.documents_list_existing({
    scopeRef: DOCUMENT_SCOPE,
    source: 'mail_attachment',
  });
  return listed.data!.documents[0]!.documentRef!;
}

function syntheticKnowledgeFileText(): string {
  const fixtureDocument = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    propertyRef: string;
    entries: readonly { propertyRef: string }[];
  };
  return JSON.stringify({
    schemaVersion: 'property-knowledge-file/v1',
    propertyRef: fixtureDocument.propertyRef,
    entries: fixtureDocument.entries.filter(
      (entry) => entry.propertyRef === fixtureDocument.propertyRef,
    ),
  });
}

function makeReader(
  overrides: {
    propertyRef?: string;
    audience?: PropertyKnowledgeAudience;
    authorize?: (input: {
      propertyRef: string;
      topic: string;
      audience: PropertyKnowledgeAudience;
      now: Date;
    }) => Promise<{ granted: boolean; reason?: string }>;
    revalidate?: (input: { documentRef: string; propertyRef: string; now: Date }) => Promise<{
      status: 'current' | 'changed' | 'expired' | 'unauthorized' | 'missing';
      expiresAt?: string | null;
    }>;
  } = {},
): PropertyKnowledgeReader {
  const propertyRef = overrides.propertyRef ?? 'HRCEN';
  const audience = overrides.audience ?? 'customer';
  const authorize =
    overrides.authorize ??
    (async (input: { propertyRef: string }) => ({
      granted: input.propertyRef === 'HRCEN',
    }));
  const revalidate =
    overrides.revalidate ??
    (async () => ({
      status: 'current' as const,
      expiresAt: '2026-09-09T12:00:00.000Z',
    }));

  return createPropertyKnowledgeReader({
    source: createPropertyKnowledgeSource(
      fixture.entries.map((entry) => propertyKnowledgeSourceRecordSchema.parse(entry)),
    ),
    authorize,
    revalidateDocument: revalidate,
    now: () => NOW,
    defaultPropertyRef: propertyRef,
    defaultAudience: audience,
  });
}

function makeFileReader(
  overrides: {
    authorize?: (input: {
      propertyRef: string;
      topic: string;
      audience: PropertyKnowledgeAudience;
      now: Date;
    }) => Promise<{ granted: boolean; reason?: string }>;
  } = {},
): PropertyKnowledgeReader {
  const readFile = async () => sourceChunks(syntheticKnowledgeFileText());
  return createPropertyKnowledgeReader({
    source: createPropertyKnowledgeFileSource({
      filePath: FILE_PATH,
      allowedRoot: '/srv/centurion',
      readFile,
    }),
    authorize: overrides.authorize ?? (async () => ({ granted: true })),
    revalidateDocument: async () => ({
      status: 'current' as const,
      expiresAt: '2026-09-09T12:00:00.000Z',
    }),
    now: () => NOW,
    defaultPropertyRef: 'HRCEN',
    defaultAudience: 'customer',
  });
}

async function read(
  reader: PropertyKnowledgeReader,
  topic: PropertyKnowledgeTopic,
  options: {
    propertyRef?: string;
    audience?: PropertyKnowledgeAudience;
    detail?: 'summary' | 'detail';
  } = {},
): Promise<PropertyKnowledgeReadResult> {
  return reader.read(
    { topic, detail: options.detail ?? 'summary' },
    {
      propertyRef: options.propertyRef ?? 'HRCEN',
      audience: options.audience ?? 'customer',
    },
  );
}

function issueCodes(result: PropertyKnowledgeReadResult): string[] {
  return result.issues.map((issue) => issue.code);
}

describe('U16 approved property knowledge reader', () => {
  it('returns only a current approved fact with source/version/owner and document binding', async () => {
    const result = await read(makeReader(), 'check_in_out');

    expect(result.status).toBe('ok');
    expect(result.data).toMatchObject({
      scope: 'property_generic',
      propertyRef: 'HRCEN',
      audience: 'customer',
      topic: 'check_in_out',
    });
    expect(result.data?.entries).toHaveLength(1);
    expect(result.data?.entries[0]).toMatchObject({
      content: 'Synthetic fixture: approved current check-in/out content.',
      sourceRef: 'doc-checkin-current',
      sourceHash: 'bfd0f353890b39a50f2e5176e2037a3139d8efa87770012745f4320b80ab4fb0',
      version: 'v3',
      ownerRef: 'owner-property-ops',
      approval: {
        status: 'approved',
        approvalRef: 'approval-checkin-v3',
      },
      approvedAt: '2026-09-01T09:00:00.000Z',
      propertyRef: 'HRCEN',
      audience: 'customer_disclosable',
      documentRefs: ['doc-checkin-current'],
    });
    expect(result.data?.entries[0]?.effectiveUntil).toBeNull();
    expect(result.data?.entries[0]?.content).not.toContain('Future');
  });

  it('loads a versioned local source file before applying approval and scope checks', async () => {
    const readFile = vi.fn(
      async ({
        filePath,
        signal,
        maxBytes,
      }: {
        filePath: string;
        signal: AbortSignal;
        maxBytes: number;
      }) => {
        expect(filePath).toBe(FILE_PATH);
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(maxBytes).toBeGreaterThan(0);
        return sourceChunks(syntheticKnowledgeFileText());
      },
    );
    const reader = createPropertyKnowledgeReader({
      source: createPropertyKnowledgeFileSource({
        filePath: FILE_PATH,
        allowedRoot: '/srv/centurion',
        readFile,
      }),
      authorize: async () => ({ granted: true }),
      revalidateDocument: async () => ({ status: 'current' as const }),
      now: () => NOW,
      defaultPropertyRef: 'HRCEN',
      defaultAudience: 'customer',
    });

    const result = await read(reader, 'check_in_out');

    expect(result.status).toBe('ok');
    expect(result.data?.entries[0]).toMatchObject({
      sourceRef: 'doc-checkin-current',
      sourceHash: 'bfd0f353890b39a50f2e5176e2037a3139d8efa87770012745f4320b80ab4fb0',
      version: 'v3',
      ownerRef: 'owner-property-ops',
      propertyRef: 'HRCEN',
      audience: 'customer_disclosable',
      documentRefs: ['doc-checkin-current'],
    });
    expect(readFile).toHaveBeenCalledOnce();
  });

  it('rejects an unbounded local source path during server composition', () => {
    expect(() =>
      createPropertyKnowledgeFileSource({ filePath: 'relative/property-knowledge.json' }),
    ).toThrow('absolute server path');
    expect(() =>
      createPropertyKnowledgeFileSource({
        filePath: '/etc/property-knowledge.json',
        allowedRoot: '/srv/centurion',
      }),
    ).toThrow('outside its server-owned root');
  });

  it('returns an unavailable result for a malformed local source file', async () => {
    const reader = createPropertyKnowledgeReader({
      source: createPropertyKnowledgeFileSource({
        filePath: FILE_PATH,
        allowedRoot: '/srv/centurion',
        readFile: async () => sourceChunks('{"schemaVersion":"wrong"}'),
      }),
      authorize: async () => ({ granted: true }),
      now: () => NOW,
      defaultPropertyRef: 'HRCEN',
      defaultAudience: 'customer',
    });

    const result = await read(reader, 'check_in_out');

    expect(result.status).toBe('unavailable');
    expect(issueCodes(result)).toContain('SOURCE_UNAVAILABLE');
    expect(result.data).toBeNull();
  });

  it('rejects a source whose content hash no longer matches its approved record', async () => {
    const sourceRecord = fixture.entries.find((entry) => entry.topic === 'check_in_out')!;
    const reader = createPropertyKnowledgeReader({
      source: createPropertyKnowledgeSource([
        propertyKnowledgeSourceRecordSchema.parse({
          ...sourceRecord,
          sourceHash: '0'.repeat(64),
        }),
      ]),
      authorize: async () => ({ granted: true }),
      now: () => NOW,
      defaultPropertyRef: 'HRCEN',
      defaultAudience: 'customer',
    });

    const result = await read(reader, 'check_in_out');

    expect(result.status).toBe('unavailable');
    expect(issueCodes(result)).toContain('SOURCE_HASH_MISMATCH');
    expect(result.data).toBeNull();
  });

  it('does not treat future or expired versions as current knowledge', async () => {
    const future = await read(makeReader(), 'room_types');
    expect(future.status).toBe('unavailable');
    expect(issueCodes(future)).toContain('KNOWLEDGE_NOT_YET_EFFECTIVE');
    expect(future.data).toBeNull();

    const expiredReader = makeReader({
      revalidate: async () => ({ status: 'current' as const }),
    });
    const expired = await expiredReader.read(
      { topic: 'check_in_out', detail: 'summary' },
      { propertyRef: 'HRCEN', audience: 'customer', now: new Date('2026-08-15T12:00:00.000Z') },
    );
    expect(expired.status).toBe('unavailable');
    expect(issueCodes(expired)).toContain('KNOWLEDGE_NOT_YET_EFFECTIVE');
    expect(expired.data).toBeNull();
  });

  it('fails closed on conflicting current approved sources', async () => {
    const result = await read(makeReader(), 'cancellation');

    expect(result.status).toBe('ambiguous');
    expect(result.data?.entries).toEqual([]);
    expect(result.data?.conflicts[0]).toMatchObject({
      topic: 'cancellation',
      entryRefs: ['knowledge-cancel-a', 'knowledge-cancel-b'],
    });
    expect(issueCodes(result)).toContain('CONFLICTING_APPROVED_SOURCES');
    expect(JSON.stringify(result)).not.toContain('Cancellation version A');
    expect(JSON.stringify(result)).not.toContain('Cancellation version B');
  });

  it('does not expose an unapproved bank instruction or treat a request as approval', async () => {
    const result = await read(makeReader(), 'deposits_payment');

    expect(result.status).toBe('unavailable');
    expect(issueCodes(result)).toContain('POLICY_UNAPPROVED');
    expect(JSON.stringify(result)).not.toContain('1234567890');
  });

  it('keeps material with a missing approval unavailable', async () => {
    const pending = fixture.entries.find((entry) => entry.topic === 'deposits_payment')!;
    const reader = createPropertyKnowledgeReader({
      source: createPropertyKnowledgeSource([
        propertyKnowledgeSourceRecordSchema.parse({
          ...pending,
          entryRef: 'knowledge-deposit-missing-approval',
          approval: { status: 'missing', approvedAt: null, approvalRef: null },
        }),
      ]),
      authorize: async () => ({ granted: true }),
      now: () => NOW,
      defaultPropertyRef: 'HRCEN',
      defaultAudience: 'customer',
    });

    const result = await read(reader, 'deposits_payment');

    expect(result.status).toBe('unavailable');
    expect(issueCodes(result)).toContain('POLICY_UNAPPROVED');
    expect(result.data).toBeNull();
  });

  it('accepts a bank instruction only when its source has explicit current approval', async () => {
    const pending = fixture.entries.find((entry) => entry.topic === 'deposits_payment')!;
    const approved = propertyKnowledgeSourceRecordSchema.parse({
      ...pending,
      entryRef: 'knowledge-deposit-approved',
      content: 'Synthetic fixture: approved bank instruction with an explicitly approved source.',
      sourceKind: 'approved_property_document',
      sourceRef: 'doc-deposit-approved',
      sourceHash: '5b771ed16b57eee34d0bef10b014fb642cf989ed37b65836a4150bc9abab0c27',
      version: 'v1',
      approval: {
        status: 'approved',
        approvedAt: '2026-09-01T09:00:00.000Z',
        approvalRef: 'approval-deposit-v1',
      },
      documentRefs: ['doc-deposit-approved'],
    });
    const reader = createPropertyKnowledgeReader({
      source: createPropertyKnowledgeSource([approved]),
      authorize: async () => ({ granted: true }),
      revalidateDocument: async () => ({ status: 'current' as const }),
      now: () => NOW,
      defaultPropertyRef: 'HRCEN',
      defaultAudience: 'customer',
    });
    const result = await read(reader, 'deposits_payment');

    expect(result.status).toBe('ok');
    expect(result.data?.entries[0]?.sourceKind).toBe('approved_property_document');
    expect(result.data?.entries[0]?.approval.status).toBe('approved');
  });

  it('redacts raw payment secrets even when the enclosing document is approved', async () => {
    const result = await read(makeReader(), 'compliance_documents');

    expect(result.status).toBe('unavailable');
    expect(issueCodes(result)).toContain('PAYMENT_SECRET_REDACTED');
    expect(JSON.stringify(result)).not.toContain('4111 1111 1111 1111');
  });

  it('fails closed on an unlabeled Luhn-valid PAN in an approved source', async () => {
    const sourceRecord = fixture.entries.find((entry) => entry.topic === 'compliance_documents')!;
    const content = '4111 1111 1111 1111';
    const reader = createPropertyKnowledgeReader({
      source: createPropertyKnowledgeSource([
        propertyKnowledgeSourceRecordSchema.parse({
          ...sourceRecord,
          content,
          sourceHash: sourceHash(content),
        }),
      ]),
      authorize: async () => ({ granted: true }),
      revalidateDocument: async () => ({ status: 'current' as const }),
      now: () => NOW,
      defaultPropertyRef: 'HRCEN',
      defaultAudience: 'customer',
    });

    const result = await read(reader, 'compliance_documents');

    expect(result.status).toBe('unavailable');
    expect(issueCodes(result)).toContain('PAYMENT_SECRET_REDACTED');
    expect(JSON.stringify(result)).not.toContain(content);
  });

  it('fails closed on common raw credential forms before disclosure', async () => {
    const sourceRecord = fixture.entries.find((entry) => entry.topic === 'compliance_documents')!;
    for (const [index, content] of [
      'Bearer eyJhbGciOiJIUzI1NiJ9.synthetic-token-value',
      '-----BEGIN PRIVATE KEY----- synthetic-key -----END PRIVATE KEY-----',
    ].entries()) {
      const reader = createPropertyKnowledgeReader({
        source: createPropertyKnowledgeSource([
          propertyKnowledgeSourceRecordSchema.parse({
            ...sourceRecord,
            entryRef: `knowledge-credential-${index}`,
            content,
            sourceHash: sourceHash(content),
          }),
        ]),
        authorize: async () => ({ granted: true }),
        revalidateDocument: async () => ({ status: 'current' as const }),
        now: () => NOW,
        defaultPropertyRef: 'HRCEN',
        defaultAudience: 'customer',
      });

      const result = await read(reader, 'compliance_documents');

      expect(result.status).toBe('unavailable');
      expect(issueCodes(result)).toContain('PAYMENT_SECRET_REDACTED');
      expect(JSON.stringify(result)).not.toContain(content);
    }
  });

  it('rejects wrong-property records and never guesses a missing topic', async () => {
    const wrongProperty = await read(makeReader(), 'amenities', { propertyRef: 'HRCEN' });
    expect(wrongProperty.status).toBe('unavailable');
    expect(issueCodes(wrongProperty)).toContain('PROPERTY_SCOPE_MISMATCH');

    const missing = await read(makeReader(), 'groups_events');
    expect(missing.status).toBe('unavailable');
    expect(issueCodes(missing)).toContain('TOPIC_UNAVAILABLE');
    expect(missing.data).toBeNull();

    const missingConditions = await read(makeReader(), 'meals_children');
    expect(missingConditions.status).toBe('unavailable');
    expect(issueCodes(missingConditions)).toContain('TOPIC_UNAVAILABLE');
    expect(missingConditions.data).toBeNull();
  });

  it('treats audience as disclosure and does not return staff-only content to a customer', async () => {
    const customer = await read(makeReader(), 'room_types', { audience: 'customer' });
    expect(customer.status).toBe('unavailable');
    expect(issueCodes(customer)).toContain('AUDIENCE_NOT_AUTHORIZED');
    expect(JSON.stringify(customer)).not.toContain('Internal room inventory');

    const staff = await read(makeReader({ audience: 'staff' }), 'room_types', {
      audience: 'staff',
    });
    expect(staff.status).toBe('ok');
    expect(staff.data?.entries[0]?.audience).toBe('staff_only');
  });

  it('revalidates linked documents before returning a fact', async () => {
    const revalidate = vi.fn(async ({ documentRef }: { documentRef: string }) => ({
      status: documentRef === 'doc-transport-changed' ? ('changed' as const) : ('current' as const),
      expiresAt: '2026-09-09T12:00:00.000Z',
    }));
    const result = await read(makeReader({ revalidate }), 'parking_transport');

    expect(revalidate).toHaveBeenCalledWith(
      expect.objectContaining({ documentRef: 'doc-transport-changed', propertyRef: 'HRCEN' }),
    );
    expect(result.status).toBe('unavailable');
    expect(issueCodes(result)).toContain('DOCUMENT_CHANGED');
    expect(result.data).toBeNull();
  });

  it('revalidates a linked ref through the native authorized document service and bytes path', async () => {
    const native = await nativeDocumentFixture();
    const documentRef = await nativeDocumentRef(native.service);
    const sourceRecord = nativeKnowledgeRecord(documentRef);
    const reader = createPropertyKnowledgeReader({
      source: createPropertyKnowledgeSource([sourceRecord]),
      authorize: async () => ({ granted: true }),
      existingDocumentService: native.service,
      now: () => NOW,
      defaultPropertyRef: 'HRCEN',
      defaultAudience: 'customer',
    });
    const result = await read(reader, 'check_in_out');

    expect(result.status).toBe('ok');
    expect(result.data?.entries[0]).toMatchObject({
      sourceHash: DOCUMENT_HASH,
      documentRefs: [documentRef],
    });
    expect(native.storage.calls).toContainEqual({
      op: 'GET_BOUNDED',
      key: 'attachments/u16-native-message-1/property-information.txt',
    });
  });

  it('fails closed for native blocked, changed, foreign-ref, source, hash, identity, and disclosure results', async () => {
    const blocked = await nativeDocumentFixture({ blocker: 'METADATA_ONLY' });
    const blockedRef = await nativeDocumentRef(blocked.service);
    const blockedReader = createPropertyKnowledgeReader({
      source: createPropertyKnowledgeSource([nativeKnowledgeRecord(blockedRef)]),
      authorize: async () => ({ granted: true }),
      existingDocumentService: blocked.service,
      now: () => NOW,
      defaultPropertyRef: 'HRCEN',
      defaultAudience: 'customer',
    });
    const blockedResult = await read(blockedReader, 'check_in_out');
    expect(blockedResult.status).toBe('unavailable');
    expect(issueCodes(blockedResult)).toContain('DOCUMENT_REVALIDATION_UNAVAILABLE');
    expect(blockedResult.data).toBeNull();

    const changed = await nativeDocumentFixture();
    const changedRef = await nativeDocumentRef(changed.service);
    changed.record.sha256 = 'c'.repeat(64);
    const changedReader = createPropertyKnowledgeReader({
      source: createPropertyKnowledgeSource([nativeKnowledgeRecord(changedRef)]),
      authorize: async () => ({ granted: true }),
      existingDocumentService: changed.service,
      now: () => NOW,
      defaultPropertyRef: 'HRCEN',
      defaultAudience: 'customer',
    });
    const changedResult = await read(changedReader, 'check_in_out');
    expect(changedResult.status).toBe('unavailable');
    expect(issueCodes(changedResult)).toContain('DOCUMENT_CHANGED');

    const foreignRefReader = createPropertyKnowledgeReader({
      source: createPropertyKnowledgeSource([nativeKnowledgeRecord('foreign-ref')]),
      authorize: async () => ({ granted: true }),
      existingDocumentService: changed.service,
      now: () => NOW,
      defaultPropertyRef: 'HRCEN',
      defaultAudience: 'customer',
    });
    const foreignRefResult = await read(foreignRefReader, 'check_in_out');
    expect(foreignRefResult.status).toBe('unavailable');
    expect(issueCodes(foreignRefResult)).toContain('DOCUMENT_UNAUTHORIZED');

    const sourceMismatch = await nativeDocumentFixture({ source: 'approved_property_document' });
    const sourceMismatchListing = await sourceMismatch.service.documents_list_existing({
      scopeRef: DOCUMENT_SCOPE,
      source: 'approved_property_document',
    });
    const sourceMismatchRef = sourceMismatchListing.data!.documents[0]!.documentRef!;
    const sourceMismatchRecord = propertyKnowledgeSourceRecordSchema.parse({
      ...nativeKnowledgeRecord(sourceMismatchRef),
      sourceKind: 'mail_attachment',
      entryRef: 'knowledge-native-source-mismatch',
    });
    const sourceMismatchReader = createPropertyKnowledgeReader({
      source: createPropertyKnowledgeSource([sourceMismatchRecord]),
      authorize: async () => ({ granted: true }),
      existingDocumentService: sourceMismatch.service,
      now: () => NOW,
      defaultPropertyRef: 'HRCEN',
      defaultAudience: 'customer',
    });
    const sourceMismatchResult = await read(sourceMismatchReader, 'check_in_out');
    expect(sourceMismatchResult.status).toBe('unavailable');
    expect(issueCodes(sourceMismatchResult)).toContain('DOCUMENT_UNAUTHORIZED');

    const hashMismatchRecord = propertyKnowledgeSourceRecordSchema.parse({
      ...nativeKnowledgeRecord(changedRef),
      entryRef: 'knowledge-native-hash-mismatch',
      content: 'native linked source changed',
      sourceHash: sourceHash('native linked source changed'),
    });
    const hashMismatchReader = createPropertyKnowledgeReader({
      source: createPropertyKnowledgeSource([hashMismatchRecord]),
      authorize: async () => ({ granted: true }),
      existingDocumentService: changed.service,
      now: () => NOW,
      defaultPropertyRef: 'HRCEN',
      defaultAudience: 'customer',
    });
    const hashMismatchResult = await read(hashMismatchReader, 'check_in_out');
    expect(hashMismatchResult.status).toBe('unavailable');
    expect(issueCodes(hashMismatchResult)).toContain('DOCUMENT_CHANGED');

    const identityMismatch = await nativeDocumentFixture({
      record: nativeDocumentRecord({ propertyRef: 'OTHER' }),
    });
    const identityRef = await nativeDocumentRef(identityMismatch.service);
    const identityReader = createPropertyKnowledgeReader({
      source: createPropertyKnowledgeSource([nativeKnowledgeRecord(identityRef)]),
      authorize: async () => ({ granted: true }),
      existingDocumentService: identityMismatch.service,
      now: () => NOW,
      defaultPropertyRef: 'HRCEN',
      defaultAudience: 'customer',
    });
    const identityResult = await read(identityReader, 'check_in_out');
    expect(identityResult.status).toBe('unavailable');
    expect(issueCodes(identityResult)).toContain('DOCUMENT_UNAUTHORIZED');

    const disclosureMismatch = await nativeDocumentFixture({
      record: nativeDocumentRecord({ priceVisibility: 'visible' }),
      requestedPriceVisibility: 'forbidden',
    });
    const disclosureRef = await nativeDocumentRef(disclosureMismatch.service);
    const disclosureReader = createPropertyKnowledgeReader({
      source: createPropertyKnowledgeSource([nativeKnowledgeRecord(disclosureRef)]),
      authorize: async () => ({ granted: true }),
      existingDocumentService: disclosureMismatch.service,
      now: () => NOW,
      defaultPropertyRef: 'HRCEN',
      defaultAudience: 'customer',
    });
    const disclosureResult = await read(disclosureReader, 'check_in_out');
    expect(disclosureResult.status).toBe('unavailable');
    expect(issueCodes(disclosureResult)).toContain('DOCUMENT_REVALIDATION_UNAVAILABLE');
    expect(disclosureResult.data).toBeNull();
  });

  it('does not promote a current-looking native document with a non-ok status', async () => {
    const native = await nativeDocumentFixture();
    const documentRef = await nativeDocumentRef(native.service);
    const service = {
      ...native.service,
      documents_read_existing: async () => {
        const result = await native.service.documents_read_existing({
          documentRef,
          format: 'text',
        });
        return { ...result, status: 'manual_required' as const, blocker: 'METADATA_ONLY' };
      },
    } as ExistingDocumentService;
    const reader = createPropertyKnowledgeReader({
      source: createPropertyKnowledgeSource([nativeKnowledgeRecord(documentRef)]),
      authorize: async () => ({ granted: true }),
      existingDocumentService: service,
      now: () => NOW,
      defaultPropertyRef: 'HRCEN',
      defaultAudience: 'customer',
    });
    const result = await read(reader, 'check_in_out');

    expect(result.status).toBe('unavailable');
    expect(issueCodes(result)).toContain('DOCUMENT_REVALIDATION_UNAVAILABLE');
    expect(result.data).toBeNull();
  });

  it('requires an authorized local source and performs no model or external call', async () => {
    const readFile = vi.fn(async () => sourceChunks(syntheticKnowledgeFileText()));
    const result = await read(
      createPropertyKnowledgeReader({
        source: createPropertyKnowledgeFileSource({
          filePath: FILE_PATH,
          allowedRoot: '/srv/centurion',
          readFile,
        }),
        authorize: async () => ({ granted: false, reason: 'current app access unavailable' }),
        now: () => NOW,
        defaultPropertyRef: 'HRCEN',
        defaultAudience: 'customer',
      }),
      'check_in_out',
    );

    expect(result.status).toBe('unavailable');
    expect(issueCodes(result)).toContain('AUTHORIZATION_DENIED');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('uses bounded native file reads that reject symlinks and non-regular files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'u16-property-'));
    try {
      const target = path.join(root, 'target.json');
      const linked = path.join(root, 'linked.json');
      const directory = path.join(root, 'directory');
      const fifo = path.join(root, 'property.pipe');
      await writeFile(target, syntheticKnowledgeFileText(), 'utf8');
      await symlink(target, linked);
      await mkdir(directory);
      await execFile('mkfifo', [fifo]);

      for (const filePath of [linked, directory, fifo]) {
        const reader = createPropertyKnowledgeReader({
          source: createPropertyKnowledgeFileSource({ filePath, allowedRoot: root }),
          authorize: async () => ({ granted: true }),
          revalidateDocument: async () => ({ status: 'current' as const }),
          now: () => NOW,
          defaultPropertyRef: 'HRCEN',
          defaultAudience: 'customer',
        });
        const result = await read(reader, 'check_in_out');
        expect(result.status).toBe('unavailable');
        expect(issueCodes(result)).toContain('SOURCE_UNAVAILABLE');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounds streaming source bytes during I/O and observes abort before parsing', async () => {
    const oversized = createPropertyKnowledgeReader({
      source: createPropertyKnowledgeFileSource({
        filePath: FILE_PATH,
        allowedRoot: '/srv/centurion',
        readFile: async () =>
          (async function* () {
            yield Buffer.alloc(512 * 1024 + 1, 0x61);
          })(),
      }),
      authorize: async () => ({ granted: true }),
      now: () => NOW,
      defaultPropertyRef: 'HRCEN',
      defaultAudience: 'customer',
    });
    const oversizedResult = await read(oversized, 'check_in_out');
    expect(oversizedResult.status).toBe('unavailable');
    expect(issueCodes(oversizedResult)).toContain('SOURCE_UNAVAILABLE');

    const controller = new AbortController();
    const aborted = createPropertyKnowledgeReader({
      source: createPropertyKnowledgeFileSource({
        filePath: FILE_PATH,
        allowedRoot: '/srv/centurion',
        readFile: async () =>
          (async function* () {
            yield Buffer.from('{', 'utf8');
            controller.abort();
            yield Buffer.from('"schemaVersion":"property-knowledge-file/v1"', 'utf8');
          })(),
      }),
      authorize: async () => ({ granted: true }),
      now: () => NOW,
      defaultPropertyRef: 'HRCEN',
      defaultAudience: 'customer',
    });
    const abortedResult = await aborted.read(
      { topic: 'check_in_out', detail: 'summary' },
      { propertyRef: 'HRCEN', audience: 'customer', signal: controller.signal },
    );
    expect(abortedResult.status).toBe('unavailable');
    expect(issueCodes(abortedResult)).toContain('READ_ABORTED');
  });

  it('caps conflict and issue cardinality without throwing the closed result schema', async () => {
    const base = fixture.entries.find((entry) => entry.topic === 'check_in_out')!;
    const conflicts = Array.from({ length: 21 }, (_, index) => {
      const content = `Approved conflict fact ${index}`;
      return propertyKnowledgeSourceRecordSchema.parse({
        ...base,
        entryRef: `knowledge-conflict-${index}`,
        sourceRef: `source-conflict-${index}`,
        content,
        sourceHash: sourceHash(content),
        documentRefs: [],
      });
    });
    const conflictResult = await read(
      createPropertyKnowledgeReader({
        source: createPropertyKnowledgeSource(conflicts),
        authorize: async () => ({ granted: true }),
        now: () => NOW,
        defaultPropertyRef: 'HRCEN',
        defaultAudience: 'customer',
      }),
      'check_in_out',
    );
    expect(conflictResult.status).toBe('ambiguous');
    expect(conflictResult.data?.conflicts[0]?.entryRefs).toHaveLength(20);
    expect(conflictResult.issues.length).toBeLessThanOrEqual(32);
    expect(issueCodes(conflictResult)).toContain('RESULT_TRUNCATED');

    const pending = Array.from({ length: 33 }, (_, index) => {
      const content = `Pending policy fact ${index}`;
      return propertyKnowledgeSourceRecordSchema.parse({
        ...base,
        entryRef: `knowledge-pending-${index}`,
        sourceRef: `source-pending-${index}`,
        content,
        sourceHash: sourceHash(content),
        documentRefs: [],
        approval: { status: 'pending', approvedAt: null, approvalRef: null },
      });
    });
    const pendingResult = await read(
      createPropertyKnowledgeReader({
        source: createPropertyKnowledgeSource(pending),
        authorize: async () => ({ granted: true }),
        now: () => NOW,
        defaultPropertyRef: 'HRCEN',
        defaultAudience: 'customer',
      }),
      'check_in_out',
    );
    expect(pendingResult.status).toBe('unavailable');
    expect(pendingResult.issues.length).toBeLessThanOrEqual(32);
    expect(issueCodes(pendingResult)).toContain('RESULT_TRUNCATED');
  });

  it('exposes the reader through the existing model-free agent facade', async () => {
    const reader = makeFileReader();
    const context = {
      transportId: 'transport-centurion',
      mailboxId: 'mailbox-centurion',
      threadId: 'thread-1',
      triggerMessageId: 'message-1',
      propertyCode: 'HRCEN',
      parentRef: 'parent-1',
      branchId: 'guest_stay_search',
      releaseId: 'release-1',
      requester: {
        authorizationId: 'auth-1',
        transportId: 'transport-centurion',
        threadId: 'thread-1',
        triggerMessageId: 'message-1',
        allowedClaimKinds: ['reservation_summary'],
        expiresAt: '2026-09-09T12:00:00.000Z',
      },
      signal: new AbortController().signal,
      budget: { total: 0, limit: 3 },
      now: () => NOW,
    };
    const proof = issueCurrentAppAccessProof({
      userId: 'user-1',
      mailboxAccessId: 'auth-1',
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      triggerMessageId: 'message-1',
      expiresAt: '2026-09-09T12:00:00.000Z',
      now: NOW,
    });
    const authorizedContext = { ...context, currentAppAccessProof: proof };
    const unavailableTools = createAgentReadTools(authorizedContext);
    const unavailable = await unavailableTools.property_read_knowledge!.execute({
      topic: 'check_in_out',
    });
    expect((unavailable as PropertyKnowledgeReadResult).status).toBe('unavailable');
    expect((unavailable as PropertyKnowledgeReadResult).issues[0]?.code).toBe('SOURCE_UNAVAILABLE');

    const tools = createAgentReadTools(authorizedContext, {
      propertyKnowledgeReader: reader,
      propertyKnowledgeAudience: 'customer',
    });

    expect(tools.property_read_knowledge).toBeDefined();
    const result = await tools.property_read_knowledge!.execute({ topic: 'check_in_out' });
    expect((result as PropertyKnowledgeReadResult).status).toBe('ok');
    expect((result as PropertyKnowledgeReadResult).data?.scope).toBe('property_generic');
  });

  it('cannot disable normal requester and current-app scope checks with an omitted or false flag', async () => {
    const expiredContext = {
      transportId: 'transport-centurion',
      mailboxId: 'mailbox-centurion',
      threadId: 'thread-1',
      triggerMessageId: 'message-1',
      propertyCode: 'HRCEN',
      parentRef: 'parent-1',
      branchId: 'guest_stay_search',
      releaseId: 'release-1',
      requester: {
        authorizationId: 'auth-1',
        transportId: 'transport-centurion',
        threadId: 'thread-1',
        triggerMessageId: 'message-1',
        allowedClaimKinds: ['reservation_summary'],
        expiresAt: '2020-01-01T00:00:00.000Z',
      },
      signal: new AbortController().signal,
      budget: { total: 0, limit: 3 },
      now: () => NOW,
      requireCurrentAppAccess: false,
    };

    const tools = createAgentReadTools(expiredContext, { propertyKnowledgeReader: makeReader() });

    await expect(
      tools.property_read_knowledge!.execute({ topic: 'check_in_out' }),
    ).rejects.toMatchObject({ code: 'READ_AUTHORIZATION_EXPIRED' });
  });

  it('does not let a factory audience option disclose staff-only material', async () => {
    const context = {
      transportId: 'transport-centurion',
      mailboxId: 'mailbox-centurion',
      threadId: 'thread-1',
      triggerMessageId: 'message-1',
      propertyCode: 'HRCEN',
      parentRef: 'parent-1',
      branchId: 'guest_stay_search',
      releaseId: 'release-1',
      requester: {
        authorizationId: 'auth-1',
        transportId: 'transport-centurion',
        threadId: 'thread-1',
        triggerMessageId: 'message-1',
        allowedClaimKinds: ['reservation_summary'],
        expiresAt: '2026-09-09T12:00:00.000Z',
      },
      signal: new AbortController().signal,
      budget: { total: 0, limit: 3 },
      now: () => NOW,
      currentAppAccessProof: issueCurrentAppAccessProof({
        userId: 'user-1',
        mailboxAccessId: 'auth-1',
        transportId: 'transport-centurion',
        threadId: 'thread-1',
        triggerMessageId: 'message-1',
        expiresAt: '2026-09-09T12:00:00.000Z',
        now: NOW,
      }),
    };
    const tools = createAgentReadTools(context, {
      propertyKnowledgeReader: makeReader({ audience: 'staff' }),
      propertyKnowledgeAudience: 'staff',
    });

    const result = await tools.property_read_knowledge!.execute({ topic: 'room_types' });

    expect((result as PropertyKnowledgeReadResult).status).toBe('unavailable');
    expect((result as PropertyKnowledgeReadResult).issues.map((entry) => entry.code)).toContain(
      'AUDIENCE_NOT_AUTHORIZED',
    );
  });

  it('requires the existing server-owned current app access proof when the normal path requires it', async () => {
    const reader = makeReader();
    const context = {
      transportId: 'transport-centurion',
      mailboxId: 'mailbox-centurion',
      threadId: 'thread-1',
      triggerMessageId: 'message-1',
      propertyCode: 'HRCEN',
      parentRef: 'parent-1',
      branchId: 'guest_stay_search',
      releaseId: 'release-1',
      requester: {
        authorizationId: 'auth-1',
        transportId: 'transport-centurion',
        threadId: 'thread-1',
        triggerMessageId: 'message-1',
        allowedClaimKinds: ['reservation_summary'],
        expiresAt: '2026-09-09T12:00:00.000Z',
      },
      signal: new AbortController().signal,
      budget: { total: 0, limit: 3 },
      now: () => NOW,
      requireCurrentAppAccess: true,
    };

    const tools = createAgentReadTools(context, { propertyKnowledgeReader: reader });
    await expect(
      tools.property_read_knowledge!.execute({ topic: 'check_in_out' }),
    ).rejects.toMatchObject({ code: 'READ_CURRENT_APP_ACCESS_REQUIRED' });

    const proof = issueCurrentAppAccessProof({
      userId: 'user-1',
      mailboxAccessId: 'auth-1',
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      triggerMessageId: 'message-1',
      expiresAt: '2026-09-09T12:00:00.000Z',
      now: NOW,
    });
    const authorizedTools = createAgentReadTools(
      { ...context, currentAppAccessProof: proof },
      { propertyKnowledgeReader: reader },
    );
    const result = await authorizedTools.property_read_knowledge!.execute({
      topic: 'check_in_out',
    });
    expect((result as PropertyKnowledgeReadResult).status).toBe('ok');
  });

  it('keeps generic property knowledge separate from reservation-specific booked policy', async () => {
    const result = await read(makeReader(), 'check_in_out');

    expect(result.data?.scope).toBe('property_generic');
    expect(result.data).not.toHaveProperty('bookedPolicy');
    expect(result.data?.entries[0]).not.toHaveProperty('reservationRef');
  });
});
