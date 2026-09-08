import {
  propertyKnowledgeFixtureSchema,
  propertyKnowledgeSourceRecordSchema,
  type PropertyKnowledgeAudience,
  type PropertyKnowledgeTopic,
  type PropertyKnowledgeReadResult,
} from '../src/ai/property-knowledge-contract.js';
import {
  createPropertyKnowledgeReader,
  createPropertyKnowledgeFileSource,
  createPropertyKnowledgeSource,
  type PropertyKnowledgeReader,
} from '../src/ai/property-knowledge-read.js';
import type { ExistingDocumentService } from '../src/mail/artifacts/existing-document-service.js';
import { issueCurrentAppAccessProof } from '../src/hms/requester-authorization.js';
import { createAgentReadTools } from '../src/hms/agent-read-tools.js';
import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/property-knowledge.json',
);
const fixture = propertyKnowledgeFixtureSchema.parse(JSON.parse(readFileSync(fixturePath, 'utf8')));
const FILE_PATH = '/srv/centurion/property-knowledge.json';

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
  const readFile = async () => syntheticKnowledgeFileText();
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
      async ({ filePath, signal }: { filePath: string; signal: AbortSignal }) => {
        expect(filePath).toBe(FILE_PATH);
        expect(signal).toBeInstanceOf(AbortSignal);
        return syntheticKnowledgeFileText();
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
        readFile: async () => '{"schemaVersion":"wrong"}',
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

  it('can revalidate a linked ref through the existing authorized document service', async () => {
    const sourceRecord = fixture.entries.find((entry) => entry.topic === 'check_in_out')!;
    const documents = {
      documents_read_existing: vi.fn(async () => ({
        status: 'ok',
        data: {
          document: { propertyRef: 'HRCEN', currentVersion: true },
          validation: { version: 'current' },
          artifactExpiresAt: '2026-09-09T12:00:00.000Z',
        },
        blocker: null,
        issues: [],
      })),
    } as unknown as Pick<ExistingDocumentService, 'documents_read_existing'>;
    const reader = createPropertyKnowledgeReader({
      source: createPropertyKnowledgeSource([sourceRecord]),
      authorize: async () => ({ granted: true }),
      existingDocumentService: documents,
      now: () => NOW,
      defaultPropertyRef: 'HRCEN',
      defaultAudience: 'customer',
    });
    const result = await read(reader, 'check_in_out');

    expect(result.status).toBe('ok');
    expect(documents.documents_read_existing).toHaveBeenCalledWith({
      documentRef: 'doc-checkin-current',
      format: 'text',
    });
  });

  it('requires an authorized local source and performs no model or external call', async () => {
    const readFile = vi.fn(async () => syntheticKnowledgeFileText());
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
    const unavailableTools = createAgentReadTools(context);
    const unavailable = await unavailableTools.property_read_knowledge!.execute({
      topic: 'check_in_out',
    });
    expect((unavailable as PropertyKnowledgeReadResult).status).toBe('unavailable');
    expect((unavailable as PropertyKnowledgeReadResult).issues[0]?.code).toBe('SOURCE_UNAVAILABLE');

    const tools = createAgentReadTools(context, {
      propertyKnowledgeReader: reader,
      propertyKnowledgeAudience: 'customer',
    });

    expect(tools.property_read_knowledge).toBeDefined();
    const result = await tools.property_read_knowledge!.execute({ topic: 'check_in_out' });
    expect((result as PropertyKnowledgeReadResult).status).toBe('ok');
    expect((result as PropertyKnowledgeReadResult).data?.scope).toBe('property_generic');
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
