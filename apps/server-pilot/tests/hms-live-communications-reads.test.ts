import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createLiveDocumentListDriver,
  observeTaxInvoiceMetadata,
  TAX_INVOICE_SURFACE_BLOCKER,
} from '../src/hms/live-document-list-driver.js';
import {
  createLiveSentEmailObserver,
  minimizeCorrelatedSentEmailRows,
  parsePssnelHdrTransportRows,
  toSentDocumentMetadata,
  toSentEmailAudit,
  type MinimizedSentEmailRows,
} from '../src/hms/live-sent-email-observer.js';
import {
  buildLiveSentEmailListManifest,
  LIVE_SENT_EMAIL_LIST_PATH,
} from '../src/hms/live-read-manifest.js';
import type { ReadCandidateChild } from '../src/hms/candidate-graph.js';
import type { HmsSessionAuthorization } from '../src/hms/release-kernel.js';
import { HmsRuntimeError, type HmsPage, type HmsRuntime } from '../src/hms/runtime.js';
import { READ_TOOLS } from '../src/hms/read-tools.js';
import {
  DOCUMENT_LIST_MAX_BYTES,
  DOCUMENT_LIST_MAX_DURATION_MS,
  DOCUMENT_LIST_MAX_ROWS,
} from '../src/hms/document-list-contract.js';
import {
  SENT_EMAIL_AUDIT_MAX_BYTES,
  SENT_EMAIL_AUDIT_MAX_DURATION_MS,
  SENT_EMAIL_AUDIT_MAX_ROWS,
} from '../src/hms/sent-email-audit-contract.js';

const ORIGIN = 'https://appsrv-1.legacyhotels.co.za';
const NOW = '2026-08-06T12:00:00.000Z';
const SCOPE = 'a'.repeat(64);
const ACCOUNT = '12345';
const RECIPIENT = 'guest.name@example.com';

function pssnelEnvelope(
  rows: Array<Record<string, unknown>>,
): string {
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

function auth(
  overrides: Partial<HmsSessionAuthorization> = {},
): HmsSessionAuthorization {
  const manifest = buildLiveSentEmailListManifest(ORIGIN);
  return {
    operationId: randomUUID(),
    toolId: 'hms_sent_email_audit',
    discoveryOperationId: 'sent_email_list',
    releaseId: randomUUID(),
    requestBranchId: 'sent_email_audit',
    manifest,
    manifestSha256: createHash('sha256')
      .update(JSON.stringify(manifest))
      .digest('hex'),
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

function child(
  overrides: Partial<ReadCandidateChild> = {},
): ReadCandidateChild {
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

describe('PSSNEL transport parser', () => {
  it('parses GRIDRESULT rows and rejects fixture HTML', () => {
    const parsed = samplePrivateRows();
    expect(parsed.envelopeRecognized).toBe(true);
    expect(parsed.rows).toHaveLength(3);
    expect(() =>
      parsePssnelHdrTransportRows('<div data-testid="sent-email-row"></div>'),
    ).toThrow(HmsRuntimeError);
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
    expect(docs.data.rows.every((r) => r.attachmentPresent === true)).toBe(
      true,
    );
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
    expect(posts.every((p) => !/print|resend|export|generate|send/i.test(p.path))).toBe(
      true,
    );
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
      observer.observeSentEmailRows(
        auth(),
        child({ propertyCode: 'OTHER' }),
        signal,
      ),
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
    });
    const a = auth({
      toolId: 'hms_list_documents',
      requestBranchId: 'sent_email_documents',
    });
    const c = child({
      toolId: 'hms_list_documents',
      requestBranchId: 'sent_email_documents',
    });
    const docs = await driver.observeSentDocumentMetadata(
      a,
      c,
      new AbortController().signal,
    );
    expect(docs.status).toBe('ok');
    expect(docs.data.sourceClass).toBe('sent_email_attachment');

    const taxAuth = auth({
      toolId: 'hms_list_documents',
      discoveryOperationId: 'tax_invoice_list',
      requestBranchId: 'tax_invoice_documents',
    });
    const taxChild = child({
      toolId: 'hms_list_documents',
      requestBranchId: 'tax_invoice_documents',
    });
    const tax = await observeTaxInvoiceMetadata(
      taxAuth,
      taxChild,
      new AbortController().signal,
    );
    expect(tax.status).toBe('manual_required');
    expect(tax.unresolvedFields).toContain(TAX_INVOICE_SURFACE_BLOCKER);
  });
});

describe('registry denied actions + shared manifest digest', () => {
  it('keeps attachment/preview/resend/generate/print/export denied', () => {
    for (const action of [
      'open_attachment',
      'preview',
      'resend',
      'print',
      'export',
      'generate',
    ]) {
      expect(READ_TOOLS.hms_list_documents.deniedActions).toContain(action);
    }
    expect(READ_TOOLS.hms_sent_email_audit.deniedActions).toContain(
      'open_attachment',
    );
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
