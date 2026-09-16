import { describe, expect, it } from 'vitest';
import {
  documentListReadDataSchema,
  mapDocumentMetadataClaim,
  parseDocumentMetadataFixture,
} from '../src/hms/document-list-contract.js';
import {
  mapSentEmailAuditClaim,
  parseSentEmailAuditFixture,
  sentEmailAuditReadDataSchema,
} from '../src/hms/sent-email-audit-contract.js';
import { claimsFromToolResult } from '../src/ai/candidate-draft-agent.js';
import { renderClaim, type ToolResult } from '../src/ai/draft-evidence.js';
import { READ_TOOLS, capabilityStateFor } from '../src/hms/read-tools.js';
import { issueTrustedRequesterAuthorization } from '../src/hms/requester-authorization.js';

const NOW = '2026-08-06T00:00:00.000Z';
const HASH = 'a'.repeat(64);
const AUTH_KEY = Buffer.alloc(32, 0x41);
const AUTH_KEY_VERSION = 'requester-key-v1';
const AUTH_NOW = new Date(NOW);

function claimAuthorization() {
  const currentState = {
    operationId: 'communications-fixture-operation',
    mailboxGrant: {
      sha256: HASH,
      transportId: 'transport-communications-fixture',
      active: true,
    },
    thread: {
      transportId: 'transport-communications-fixture',
      threadId: 'thread-communications-fixture',
      stateVersion: 'thread-state-v1',
    },
    requester: {
      identity: 'requester-communications-fixture',
      requesterClass: 'reservation_guest',
      inquiryClass: 'labelled_narrow_status',
      allowedClaimKinds: ['document_metadata', 'sent_email_audit'],
      forwarded: false,
      spoofed: false,
    },
  };
  const authorization = issueTrustedRequesterAuthorization(currentState, {
    key: AUTH_KEY,
    keyVersion: AUTH_KEY_VERSION,
    issuedAt: AUTH_NOW,
    expiresAt: new Date(AUTH_NOW.getTime() + 5 * 60_000),
  });
  if (!authorization) throw new Error('fixture authorization issuance failed');
  return {
    authorization,
    currentState,
    key: AUTH_KEY,
    expectedPrivateDigestKeyVersion: AUTH_KEY_VERSION,
    now: AUTH_NOW,
  };
}

function hmsResult<T>(
  toolId: 'hms_sent_email_audit' | 'hms_list_documents',
  data: T,
): ToolResult<T> {
  return {
    status: 'ok',
    draftReady: true,
    data,
    unresolvedFields: [],
    evidence: {
      kind: 'hms',
      id: `${toolId}-evidence`,
      toolId,
      toolVersion: '1.0.0',
      propertyCode: 'HRCEN',
      observedAt: NOW,
      expiresAt: '2026-08-06T01:00:00.000Z',
      claimKeys: [],
      sourceHash: HASH,
      scopeVerified: true,
    },
  };
}

describe('hms_sent_email_audit fixture kernel', () => {
  it('matches exact scope and recipient server-side without leaking address or subject', () => {
    const parsed = parseSentEmailAuditFixture({
      scope: { class: 'reservation', exactScopeHash: HASH },
      expectedRecipient: 'Guest.Name@example.com',
      observedAt: NOW,
      durationMs: 12,
      bytesObserved: 800,
      rows: [
        {
          scopeClass: 'reservation',
          scopeHash: HASH,
          recipient: 'guest.name@example.com',
          sentAt: '2026-08-05T12:30:00.000Z',
          emailType: 'transactional',
          subject: 'Reservation confirmation 12345',
          attachmentPresent: true,
          reportCode: 'CONFIRMATION',
          errorClass: null,
        },
      ],
    });

    expect(parsed.status).toBe('ok');
    const data = sentEmailAuditReadDataSchema.parse(parsed.data);
    expect(data.scopeClass).toBe('reservation');
    expect(data.recipientMatch).toBe('exact_redacted');
    expect(data.rows).toEqual([
      expect.objectContaining({
        subjectClass: 'reservation_confirmation',
        attachmentPresent: true,
        reportCode: 'CONFIRMATION',
        errorClass: 'none',
      }),
    ]);
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain('Guest.Name@example.com');
    expect(serialized).not.toContain('guest.name@example.com');
    expect(serialized).not.toContain('Reservation confirmation 12345');
  });

  it.each([
    ['scope mismatch', { scopeHash: 'b'.repeat(64) }],
    ['recipient mismatch', { recipient: 'other@example.com' }],
  ])('fails closed on %s', (_label, override) => {
    const parsed = parseSentEmailAuditFixture({
      scope: { class: 'reservation', exactScopeHash: HASH },
      expectedRecipient: 'guest@example.com',
      observedAt: NOW,
      durationMs: 5,
      bytesObserved: 200,
      rows: [
        {
          scopeClass: 'reservation',
          scopeHash: HASH,
          recipient: 'guest@example.com',
          sentAt: '2026-08-05T12:30:00.000Z',
          emailType: 'transactional',
          subject: 'Invoice sent',
          attachmentPresent: false,
          reportCode: null,
          errorClass: null,
          ...override,
        },
      ],
    });
    expect(parsed.status).toBe('manual_required');
    expect(parsed.data.rows).toEqual([]);
  });

  it('enforces row, time, and byte bounds before returning rows', () => {
    const base = {
      scope: { class: 'account' as const, exactScopeHash: HASH },
      expectedRecipient: 'guest@example.com',
      observedAt: NOW,
      durationMs: 5,
      bytesObserved: 200,
      rows: [],
    };
    expect(
      parseSentEmailAuditFixture({ ...base, durationMs: 5_001 }).status,
    ).toBe('manual_required');
    expect(
      parseSentEmailAuditFixture({ ...base, bytesObserved: 65_537 }).status,
    ).toBe('manual_required');
    expect(
      parseSentEmailAuditFixture({
        ...base,
        rows: Array.from({ length: 51 }, () => ({
          scopeClass: 'account' as const,
          scopeHash: HASH,
          recipient: 'guest@example.com',
          sentAt: '2026-08-05T12:30:00.000Z',
          emailType: 'transactional',
          subject: 'Invoice sent',
          attachmentPresent: false,
          reportCode: null,
          errorClass: null,
        })),
      }).status,
    ).toBe('manual_required');
  });

  it('quarantines recognized empty results', () => {
    const parsed = parseSentEmailAuditFixture({
      scope: { class: 'reservation', exactScopeHash: HASH },
      expectedRecipient: 'guest@example.com',
      observedAt: NOW,
      durationMs: 5,
      bytesObserved: 10,
      rows: [],
    });
    expect(parsed.status).toBe('unverified_negative');
    expect(parsed.data.rows).toEqual([]);
  });

  it('fails closed on unknown errorClass instead of soft-mapping', () => {
    const parsed = parseSentEmailAuditFixture({
      scope: { class: 'reservation', exactScopeHash: HASH },
      expectedRecipient: 'guest@example.com',
      observedAt: NOW,
      durationMs: 5,
      bytesObserved: 200,
      rows: [
        {
          scopeClass: 'reservation',
          scopeHash: HASH,
          recipient: 'guest@example.com',
          sentAt: '2026-08-05T12:30:00.000Z',
          emailType: 'transactional',
          subject: 'Invoice sent',
          attachmentPresent: false,
          reportCode: null,
          errorClass: 'timeout_weird',
        },
      ],
    });
    expect(parsed.status).toBe('manual_required');
    expect(parsed.blocker).toBe('SENT_EMAIL_AUDIT_ROW_SCHEMA_DRIFT');
    expect(parsed.data.rows).toEqual([]);
  });

  it('maps one closed redacted audit claim', () => {
    const parsed = parseSentEmailAuditFixture({
      scope: { class: 'reservation', exactScopeHash: HASH },
      expectedRecipient: 'guest@example.com',
      observedAt: NOW,
      durationMs: 5,
      bytesObserved: 200,
      rows: [
        {
          scopeClass: 'reservation',
          scopeHash: HASH,
          recipient: 'guest@example.com',
          sentAt: '2026-08-05T12:30:00.000Z',
          emailType: 'transactional',
          subject: 'Invoice sent',
          attachmentPresent: true,
          reportCode: 'TAXINV',
          errorClass: null,
        },
      ],
    });
    const mapped = mapSentEmailAuditClaim(parsed.data);
    expect(mapped).toEqual(
      expect.objectContaining({
        scopeClass: 'reservation',
        recipient: 'redacted_exact_match',
      }),
    );
    expect(mapped).not.toHaveProperty('address');
    expect(mapped).not.toHaveProperty('subject');

    const claims = claimsFromToolResult(
      hmsResult('hms_sent_email_audit', parsed.data),
      new Date('2026-08-06T00:01:00.000Z'),
      claimAuthorization(),
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.kind).toBe('sent_email_audit');
    expect(renderClaim(claims[0]!)).toContain('recipient exact-match redacted');
  });
});

describe('hms_list_documents fixture kernel', () => {
  it('returns finalized Tax Invoice metadata only', () => {
    const parsed = parseDocumentMetadataFixture({
      sourceClass: 'finalized_tax_invoice',
      exactScopeHash: HASH,
      observedAt: NOW,
      durationMs: 8,
      bytesObserved: 300,
      rows: [
        {
          scopeHash: HASH,
          status: 'finalized',
          generatedAt: '2026-08-05T10:00:00.000Z',
        },
      ],
    });
    expect(parsed.status).toBe('ok');
    expect(documentListReadDataSchema.parse(parsed.data)).toEqual(parsed.data);
    expect(parsed.data.rows).toEqual([
      {
        documentType: 'tax_invoice',
        status: 'finalized',
        generatedAt: '2026-08-05T10:00:00.000Z',
        sentAt: null,
        sourceClass: 'finalized_tax_invoice',
        attachmentPresent: false,
        retrievable: false,
      },
    ]);
  });

  it('returns sent-attachment metadata without filename or retrieval inference', () => {
    const parsed = parseDocumentMetadataFixture({
      sourceClass: 'sent_email_attachment',
      exactScopeHash: HASH,
      observedAt: NOW,
      durationMs: 8,
      bytesObserved: 300,
      rows: [
        {
          scopeHash: HASH,
          attachmentName: 'Tax Invoice Guest Name.pdf',
          documentType: 'tax_invoice',
          sentAt: '2026-08-05T10:00:00.000Z',
          attachmentPresent: true,
        },
      ],
    });
    expect(parsed.status).toBe('ok');
    expect(parsed.data.rows[0]).toEqual({
      documentType: 'tax_invoice',
      status: 'sent',
      generatedAt: null,
      sentAt: '2026-08-05T10:00:00.000Z',
      sourceClass: 'sent_email_attachment',
      attachmentPresent: true,
      retrievable: false,
    });
    expect(JSON.stringify(parsed)).not.toContain('Tax Invoice Guest Name.pdf');
    expect(parsed.data.inventoryComplete).toBe(false);
  });

  it.each([
    [
      'non-final invoice',
      {
        sourceClass: 'finalized_tax_invoice' as const,
        rows: [{ scopeHash: HASH, status: 'draft', generatedAt: NOW }],
      },
    ],
    [
      'unsent attachment',
      {
        sourceClass: 'sent_email_attachment' as const,
        rows: [
          {
            scopeHash: HASH,
            attachmentName: 'invoice.pdf',
            documentType: 'tax_invoice',
            sentAt: null,
            attachmentPresent: true,
          },
        ],
      },
    ],
    [
      'attachment absent',
      {
        sourceClass: 'sent_email_attachment' as const,
        rows: [
          {
            scopeHash: HASH,
            attachmentName: 'invoice.pdf',
            documentType: 'tax_invoice',
            sentAt: NOW,
            attachmentPresent: false,
          },
        ],
      },
    ],
  ])('rejects %s rather than inferring current documents', (_label, branch) => {
    const parsed = parseDocumentMetadataFixture({
      exactScopeHash: HASH,
      observedAt: NOW,
      durationMs: 8,
      bytesObserved: 300,
      ...branch,
    });
    expect(parsed.status).toBe('manual_required');
    expect(parsed.data.rows).toEqual([]);
  });

  it('maps metadata-only claim with explicit Partial delivery credit', () => {
    const parsed = parseDocumentMetadataFixture({
      sourceClass: 'finalized_tax_invoice',
      exactScopeHash: HASH,
      observedAt: NOW,
      durationMs: 8,
      bytesObserved: 300,
      rows: [{ scopeHash: HASH, status: 'finalized', generatedAt: NOW }],
    });
    const mapped = mapDocumentMetadataClaim(parsed.data);
    expect(mapped.deliveryCredit).toBe('partial_metadata_only');
    expect(mapped.inventoryComplete).toBe(false);
    expect(mapped.rows[0]?.retrievable).toBe(false);

    const claims = claimsFromToolResult(
      hmsResult('hms_list_documents', parsed.data),
      new Date('2026-08-06T00:01:00.000Z'),
      claimAuthorization(),
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.kind).toBe('document_metadata');
    expect(renderClaim(claims[0]!)).toContain('metadata only');
  });

  it('quarantines recognized empty document metadata results', () => {
    const parsed = parseDocumentMetadataFixture({
      sourceClass: 'finalized_tax_invoice',
      exactScopeHash: HASH,
      observedAt: NOW,
      durationMs: 8,
      bytesObserved: 10,
      rows: [],
    });
    expect(parsed.status).toBe('unverified_negative');
    expect(parsed.data.rows).toEqual([]);
    expect(parsed.data.inventoryComplete).toBe(false);
  });

  it('rejects mismatched row sourceClass against parent', () => {
    expect(() =>
      documentListReadDataSchema.parse({
        sourceClass: 'finalized_tax_invoice',
        rows: [
          {
            documentType: 'tax_invoice',
            status: 'sent',
            generatedAt: null,
            sentAt: NOW,
            sourceClass: 'sent_email_attachment',
            attachmentPresent: true,
            retrievable: false,
          },
        ],
        inventoryComplete: false,
        rowsScanned: 1,
        bytesObserved: 10,
        durationMs: 1,
        observedAt: NOW,
      }),
    ).toThrow(/sourceClass/);
  });
});

describe('communications registry contracts', () => {
  it('registers separate closed schemas with sent-email discovery proven', () => {
    expect(READ_TOOLS.hms_sent_email_audit.observationSchema).toBe(
      sentEmailAuditReadDataSchema,
    );
    expect(READ_TOOLS.hms_list_documents.observationSchema).toBe(
      documentListReadDataSchema,
    );
    expect(READ_TOOLS.hms_sent_email_audit.promotionEvidence.fixture).toBe(true);
    expect(READ_TOOLS.hms_list_documents.promotionEvidence.fixture).toBe(true);
    expect(capabilityStateFor('hms_sent_email_audit')).toBe(
      'discovery_verified',
    );
    expect(capabilityStateFor('hms_list_documents')).toBe('discovery_verified');
    // Static promotionEvidence.discovery stays false until live promote CAS;
    // discoveryDigest alone advances capabilityState.
    expect(READ_TOOLS.hms_sent_email_audit.promotionEvidence.discovery).toBe(
      false,
    );
    expect(READ_TOOLS.hms_list_documents.promotionEvidence.discovery).toBe(
      false,
    );
    expect(
      READ_TOOLS.hms_sent_email_audit.evidenceRefs.discoveryDigest,
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(
      READ_TOOLS.hms_list_documents.evidenceRefs.discoveryDigest,
    ).toBe(READ_TOOLS.hms_sent_email_audit.evidenceRefs.discoveryDigest);
  });
});
