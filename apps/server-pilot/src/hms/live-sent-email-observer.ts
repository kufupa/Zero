/**
 * Minimized Sent Email transport observer (PSSNEL) + document/audit adapters.
 * Adapters never receive recipient addresses, attachment filenames, or raw subjects.
 * Tax Invoice live surface remains blocked until independent discovery proves a fn.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ToolResult } from '../ai/draft-evidence.js';
import type { ReadCandidateChild } from './candidate-graph.js';
import {
  DOCUMENT_LIST_MAX_BYTES,
  DOCUMENT_LIST_MAX_DURATION_MS,
  DOCUMENT_LIST_MAX_ROWS,
  documentListReadDataSchema,
  type DocumentListReadData,
} from './document-list-contract.js';
import { extractOsressPageData } from './live-guest-stay-driver.js';
import {
  LIVE_SENT_EMAIL_LIST_PATH,
  LIVE_SENT_EMAIL_OPEN_PATH,
} from './live-read-manifest.js';
import type { HmsSessionAuthorization } from './release-kernel.js';
import { HRCEN_PROPERTY_CODE } from './property-registry.js';
import {
  HmsRuntimeError,
  type HmsPage,
  type HmsRuntime,
} from './runtime.js';
import {
  isPropertyReadLockHeld,
  type PropertyReadLock,
} from './property-read-lock.js';
import {
  SENT_EMAIL_AUDIT_MAX_BYTES,
  SENT_EMAIL_AUDIT_MAX_DURATION_MS,
  SENT_EMAIL_AUDIT_MAX_ROWS,
  sentEmailAuditReadDataSchema,
  type SentEmailAuditReadData,
} from './sent-email-audit-contract.js';

export { LIVE_SENT_EMAIL_LIST_PATH, LIVE_SENT_EMAIL_OPEN_PATH };
export const LIVE_SENT_EMAIL_ALIAS_KEYS = [
  'emailtype',
  'account',
  'accountname',
  'subject',
  'emailaddress',
  'attachment',
  'userid',
  'error',
  'report',
  'property',
  'created',
  'dbemaildatetime',
] as const;

export type MinimizedSentEmailRow = {
  sentAt: string;
  emailType: 'transactional' | 'report' | 'system';
  subjectClass:
    | 'reservation_confirmation'
    | 'tax_invoice'
    | 'statement'
    | 'other_transactional';
  documentType:
    | 'tax_invoice'
    | 'reservation_confirmation'
    | 'statement'
    | 'other_sent_document';
  attachmentPresent: boolean;
  reportCode: string | null;
  errorClass: 'none' | 'delivery_error';
  observedAt: string;
};

export type MinimizedSentEmailRows = {
  scopeClass: 'reservation' | 'account';
  recipientMatch: 'exact_redacted';
  rows: MinimizedSentEmailRow[];
  rowsScanned: number;
  bytesObserved: number;
  durationMs: number;
  observedAt: string;
};

/** Private transport row — never passed to document/audit adapters. */
type PrivateSentEmailTransportRow = {
  accountToken: string;
  recipient: string;
  sentAtRaw: string;
  emailTypeRaw: string;
  subjectRaw: string;
  attachmentRaw: unknown;
  reportCodeRaw: string | null;
  errorRaw: string | null;
};

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const err = new Error('sent-email observe aborted');
    err.name = 'AbortError';
    throw err;
  }
}

function strOrEmpty(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return '';
}

function classifyEmailType(
  raw: string,
): MinimizedSentEmailRow['emailType'] | null {
  const n = raw.trim().toLowerCase();
  if (!n) return null;
  if (/transact/.test(n)) return 'transactional';
  if (/report/.test(n)) return 'report';
  if (/system/.test(n)) return 'system';
  return 'transactional';
}

function classifySubject(subject: string): MinimizedSentEmailRow['subjectClass'] {
  const normalized = subject.toLowerCase();
  if (/\b(reservation|booking)\b.*\b(confirm|confirmation)\b/.test(normalized)) {
    return 'reservation_confirmation';
  }
  if (/\b(tax\s*)?invoice\b/.test(normalized)) return 'tax_invoice';
  if (/\bstatement\b/.test(normalized)) return 'statement';
  return 'other_transactional';
}

function subjectToDocumentType(
  subjectClass: MinimizedSentEmailRow['subjectClass'],
): MinimizedSentEmailRow['documentType'] {
  if (subjectClass === 'reservation_confirmation') {
    return 'reservation_confirmation';
  }
  if (subjectClass === 'tax_invoice') return 'tax_invoice';
  if (subjectClass === 'statement') return 'statement';
  return 'other_sent_document';
}

function attachmentPresent(raw: unknown): boolean {
  if (raw === true) return true;
  if (raw === false || raw == null) return false;
  if (typeof raw === 'number') return raw > 0;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t || /^n(o)?$/i.test(t) || t === '0' || /^false$/i.test(t)) {
      return false;
    }
    return true;
  }
  return false;
}

function parseSentAt(raw: string, fallbackIso: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) {
    const d = Date.parse(t);
    return Number.isFinite(d) ? new Date(d).toISOString() : null;
  }
  const m = /^(\d{2})-([A-Z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/i.exec(
    t,
  );
  if (!m) {
    const d = Date.parse(t);
    return Number.isFinite(d) ? new Date(d).toISOString() : null;
  }
  const months: Record<string, string> = {
    JAN: '01',
    FEB: '02',
    MAR: '03',
    APR: '04',
    MAY: '05',
    JUN: '06',
    JUL: '07',
    AUG: '08',
    SEP: '09',
    OCT: '10',
    NOV: '11',
    DEC: '12',
  };
  const mm = months[m[2]!.toUpperCase()];
  if (!mm) return null;
  const hh = m[4] ?? '00';
  const mi = m[5] ?? '00';
  const ss = m[6] ?? '00';
  const iso = `${m[3]}-${mm}-${m[1]}T${hh}:${mi}:${ss}.000Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : fallbackIso;
}

function reportCodeOrNull(raw: string | null): string | null {
  if (raw == null) return null;
  const t = raw.trim().toUpperCase();
  if (!t) return null;
  if (!/^[A-Z0-9_-]{1,32}$/.test(t)) return null;
  return t;
}

function errorClassOf(raw: string | null): 'none' | 'delivery_error' {
  if (raw == null || raw.trim().length === 0) return 'none';
  return 'delivery_error';
}

/** Parse PSSNEL.HDR pageData/GRIDRESULT into private transport rows. */
export function parsePssnelHdrTransportRows(text: string): {
  envelopeRecognized: boolean;
  rows: PrivateSentEmailTransportRow[];
  bytesObserved: number;
} {
  const bytesObserved = Math.min(
    Buffer.byteLength(text),
    SENT_EMAIL_AUDIT_MAX_BYTES,
  );
  if (/data-testid\s*=\s*["']sent-email-row["']/i.test(text)) {
    throw new HmsRuntimeError(
      'SCHEMA_DRIFT',
      'fixture HTML sent-email fallback rejected in live observer',
    );
  }
  const pageData = extractOsressPageData(text) ?? (() => {
    try {
      const parsed = JSON.parse(text.trim()) as Record<string, unknown>;
      if (parsed.pageData && typeof parsed.pageData === 'object') {
        return parsed.pageData as Record<string, unknown>;
      }
      return parsed;
    } catch {
      return null;
    }
  })();
  if (!pageData) {
    return { envelopeRecognized: false, rows: [], bytesObserved };
  }

  const gridWrap = pageData.grid;
  if (gridWrap == null || typeof gridWrap !== 'object') {
    return { envelopeRecognized: false, rows: [], bytesObserved };
  }
  const gridResult = (gridWrap as Record<string, unknown>).GRIDRESULT;
  if (gridResult == null || typeof gridResult !== 'object') {
    return { envelopeRecognized: false, rows: [], bytesObserved };
  }
  const inner = (gridResult as Record<string, unknown>).GRID;
  if (inner == null || typeof inner !== 'object') {
    return { envelopeRecognized: true, rows: [], bytesObserved };
  }
  const data = (inner as Record<string, unknown>).DATA;
  if (!Array.isArray(data)) {
    return { envelopeRecognized: true, rows: [], bytesObserved };
  }

  const rows: PrivateSentEmailTransportRow[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    rows.push({
      accountToken: strOrEmpty(row.account),
      recipient: strOrEmpty(row.emailaddress),
      sentAtRaw:
        strOrEmpty(row.dbemaildatetime) ||
        strOrEmpty(row.created) ||
        strOrEmpty(row.emaildatetime),
      emailTypeRaw: strOrEmpty(row.emailtype),
      subjectRaw: strOrEmpty(row.subject),
      attachmentRaw: row.attachment,
      reportCodeRaw: strOrEmpty(row.report) || null,
      errorRaw: strOrEmpty(row.error) || null,
    });
  }
  return { envelopeRecognized: true, rows, bytesObserved };
}

/**
 * Correlate private rows → minimized rows. Drops non-matching recipients/scopes.
 * Never returns addresses/subjects/filenames.
 */
export function minimizeCorrelatedSentEmailRows(input: {
  privateRows: PrivateSentEmailTransportRow[];
  scopeClass: 'reservation' | 'account';
  scopeHash: string;
  expectedRecipient: string;
  /** Opaque account/confirmation token bound to parent scope. */
  expectedAccountToken: string;
  observedAt: string;
  durationMs: number;
  bytesObserved: number;
}): MinimizedSentEmailRows {
  const expectedRecipient = input.expectedRecipient.trim().toLowerCase();
  const expectedAccount = input.expectedAccountToken.trim().toLowerCase();
  if (!expectedRecipient.includes('@') || !expectedAccount) {
    return {
      scopeClass: input.scopeClass,
      recipientMatch: 'exact_redacted',
      rows: [],
      rowsScanned: 0,
      bytesObserved: 0,
      durationMs: 0,
      observedAt: input.observedAt,
    };
  }

  const rows: MinimizedSentEmailRow[] = [];
  let scanned = 0;
  for (const raw of input.privateRows) {
    scanned += 1;
    if (scanned > SENT_EMAIL_AUDIT_MAX_ROWS) break;
    if (raw.accountToken.trim().toLowerCase() !== expectedAccount) continue;
    if (raw.recipient.trim().toLowerCase() !== expectedRecipient) continue;
    const emailType = classifyEmailType(raw.emailTypeRaw);
    if (!emailType) continue;
    const sentAt = parseSentAt(raw.sentAtRaw, input.observedAt);
    if (!sentAt) continue;
    const subjectClass = classifySubject(raw.subjectRaw);
    rows.push({
      sentAt,
      emailType,
      subjectClass,
      documentType: subjectToDocumentType(subjectClass),
      attachmentPresent: attachmentPresent(raw.attachmentRaw),
      reportCode: reportCodeOrNull(raw.reportCodeRaw),
      errorClass: errorClassOf(raw.errorRaw),
      observedAt: input.observedAt,
    });
    if (rows.length >= SENT_EMAIL_AUDIT_MAX_ROWS) break;
  }

  return {
    scopeClass: input.scopeClass,
    recipientMatch: 'exact_redacted',
    rows,
    rowsScanned: Math.min(scanned, SENT_EMAIL_AUDIT_MAX_ROWS),
    bytesObserved: Math.min(
      Math.max(0, input.bytesObserved),
      SENT_EMAIL_AUDIT_MAX_BYTES,
    ),
    durationMs: Math.min(
      Math.max(0, input.durationMs),
      SENT_EMAIL_AUDIT_MAX_DURATION_MS,
    ),
    observedAt: input.observedAt,
  };
}

/** Map minimized rows → document metadata (sent attachment source class). */
export function toSentDocumentMetadata(
  rows: MinimizedSentEmailRows,
  propertyCode = HRCEN_PROPERTY_CODE,
): ToolResult<DocumentListReadData> {
  const start = Date.now();
  const observedAt = rows.observedAt;
  const attachmentRows = rows.rows.filter((r) => r.attachmentPresent);
  if (
    rows.durationMs > DOCUMENT_LIST_MAX_DURATION_MS ||
    rows.bytesObserved > DOCUMENT_LIST_MAX_BYTES ||
    attachmentRows.length > DOCUMENT_LIST_MAX_ROWS
  ) {
    return documentToolResult({
      status: 'manual_required',
      data: emptyDocumentData(observedAt),
      unresolvedFields: ['document_list_bounds'],
      observedAt,
      sourceSeed: 'doc-bounds',
      propertyCode,
    });
  }

  const data = documentListReadDataSchema.parse({
    sourceClass: 'sent_email_attachment',
    rows: attachmentRows.slice(0, DOCUMENT_LIST_MAX_ROWS).map((r) => ({
      documentType: r.documentType,
      status: 'sent' as const,
      generatedAt: null,
      sentAt: r.sentAt,
      sourceClass: 'sent_email_attachment' as const,
      attachmentPresent: true as const,
      retrievable: false as const,
    })),
    inventoryComplete: false as const,
    rowsScanned: Math.min(attachmentRows.length, DOCUMENT_LIST_MAX_ROWS),
    bytesObserved: Math.min(rows.bytesObserved, DOCUMENT_LIST_MAX_BYTES),
    durationMs: Math.min(
      rows.durationMs || Date.now() - start,
      DOCUMENT_LIST_MAX_DURATION_MS,
    ),
    observedAt,
  });

  const serialized = JSON.stringify(data);
  void serialized;

  return documentToolResult({
    status: data.rows.length === 0 ? 'unverified_negative' : 'ok',
    data,
    unresolvedFields: data.rows.length === 0 ? ['documents'] : [],
    observedAt,
    sourceSeed: `doc-sent:${data.rows.length}`,
    propertyCode,
    draftReady: data.rows.length > 0,
  });
}

/** Map minimized rows → sent-email audit claim data. */
export function toSentEmailAudit(
  rows: MinimizedSentEmailRows,
  propertyCode = HRCEN_PROPERTY_CODE,
): ToolResult<SentEmailAuditReadData> {
  if (
    rows.durationMs > SENT_EMAIL_AUDIT_MAX_DURATION_MS ||
    rows.bytesObserved > SENT_EMAIL_AUDIT_MAX_BYTES ||
    rows.rows.length > SENT_EMAIL_AUDIT_MAX_ROWS
  ) {
    return auditToolResult({
      status: 'manual_required',
      data: emptyAuditData(rows.scopeClass, rows.observedAt),
      unresolvedFields: ['sent_email_bounds'],
      observedAt: rows.observedAt,
      sourceSeed: 'audit-bounds',
      propertyCode,
    });
  }

  const data = sentEmailAuditReadDataSchema.parse({
    scopeClass: rows.scopeClass,
    recipientMatch: 'exact_redacted',
    rows: rows.rows.map((r) => ({
      sentAt: r.sentAt,
      emailType: r.emailType,
      subjectClass: r.subjectClass,
      attachmentPresent: r.attachmentPresent,
      reportCode: r.reportCode,
      errorClass: r.errorClass,
      observedAt: r.observedAt,
    })),
    rowsScanned: rows.rowsScanned,
    bytesObserved: rows.bytesObserved,
    durationMs: rows.durationMs,
    observedAt: rows.observedAt,
  });

  return auditToolResult({
    status: data.rows.length === 0 ? 'unverified_negative' : 'ok',
    data,
    unresolvedFields: data.rows.length === 0 ? ['sent_email'] : [],
    observedAt: rows.observedAt,
    sourceSeed: `audit-sent:${data.rows.length}`,
    propertyCode,
    draftReady: data.rows.length > 0,
  });
}

function emptyDocumentData(observedAt: string): DocumentListReadData {
  return documentListReadDataSchema.parse({
    sourceClass: 'sent_email_attachment',
    rows: [],
    inventoryComplete: false,
    rowsScanned: 0,
    bytesObserved: 0,
    durationMs: 0,
    observedAt,
  });
}

function emptyAuditData(
  scopeClass: 'reservation' | 'account',
  observedAt: string,
): SentEmailAuditReadData {
  return sentEmailAuditReadDataSchema.parse({
    scopeClass,
    recipientMatch: 'exact_redacted',
    rows: [],
    rowsScanned: 0,
    bytesObserved: 0,
    durationMs: 0,
    observedAt,
  });
}

function documentToolResult(input: {
  status: ToolResult<DocumentListReadData>['status'];
  data: DocumentListReadData;
  unresolvedFields: string[];
  observedAt: string;
  sourceSeed: string;
  propertyCode: string;
  draftReady?: boolean;
}): ToolResult<DocumentListReadData> {
  return {
    status: input.status,
    draftReady: input.draftReady ?? input.status === 'ok',
    data: input.data,
    unresolvedFields: input.unresolvedFields,
    evidence: {
      kind: 'hms',
      id: randomUUID(),
      toolId: 'hms_list_documents',
      toolVersion: '1.0.0',
      propertyCode: input.propertyCode,
      observedAt: input.observedAt,
      expiresAt: new Date(
        Date.parse(input.observedAt) + 60 * 60 * 1000,
      ).toISOString(),
      claimKeys: [],
      sourceHash: sha256Hex(input.sourceSeed),
    },
  };
}

function auditToolResult(input: {
  status: ToolResult<SentEmailAuditReadData>['status'];
  data: SentEmailAuditReadData;
  unresolvedFields: string[];
  observedAt: string;
  sourceSeed: string;
  propertyCode: string;
  draftReady?: boolean;
}): ToolResult<SentEmailAuditReadData> {
  return {
    status: input.status,
    draftReady: input.draftReady ?? input.status === 'ok',
    data: input.data,
    unresolvedFields: input.unresolvedFields,
    evidence: {
      kind: 'hms',
      id: randomUUID(),
      toolId: 'hms_sent_email_audit',
      toolVersion: '1.0.0',
      propertyCode: input.propertyCode,
      observedAt: input.observedAt,
      expiresAt: new Date(
        Date.parse(input.observedAt) + 60 * 60 * 1000,
      ).toISOString(),
      claimKeys: [],
      sourceHash: sha256Hex(input.sourceSeed),
    },
  };
}

export type LiveSentEmailObserver = {
  observeSentEmailRows(
    authorization: HmsSessionAuthorization,
    child: ReadCandidateChild,
    signal: AbortSignal,
  ): Promise<MinimizedSentEmailRows>;
};

export type LiveSentEmailObserverInput = {
  runtime: HmsRuntime;
  transportId: string;
  propertyCode?: string;
  /** Exact recipient for server-side correlation; never returned. */
  expectedRecipient: string;
  /** Account/confirmation token bound to parent scopeHash. */
  expectedAccountToken: string;
  /** Cross-process credential lock held through login, reads, and context close. */
  propertyReadLock?: PropertyReadLock;
  scopeClass?: 'reservation' | 'account';
};

function assertSentEmailAuth(
  authorization: HmsSessionAuthorization,
  child: ReadCandidateChild,
  allowedToolIds: ReadonlySet<string>,
  allowedBranches: ReadonlySet<string>,
  propertyCode: string,
): void {
  if (!allowedToolIds.has(authorization.toolId)) {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization toolId denied for sent-email observer',
    );
  }
  if (authorization.discoveryOperationId !== 'sent_email_list') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization discoveryOperationId mismatch',
    );
  }
  if (!allowedBranches.has(authorization.requestBranchId)) {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization requestBranchId denied for sent-email observer',
    );
  }
  if (Date.parse(authorization.expiresAt) <= Date.now()) {
    throw new HmsRuntimeError('ROLE_PROOF_EXPIRED', 'authorization expired');
  }
  if (child.toolId !== authorization.toolId) {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'child toolId does not match authorization',
    );
  }
  if (child.requestBranchId !== authorization.requestBranchId) {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'child requestBranchId does not match authorization',
    );
  }
  if (Date.parse(child.expiresAt) <= Date.now()) {
    throw new HmsRuntimeError('ROLE_PROOF_EXPIRED', 'candidate child expired');
  }
  if (child.propertyCode !== propertyCode) {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'child propertyCode denied',
    );
  }
}

export function createLiveSentEmailObserver(
  input: LiveSentEmailObserverInput,
): LiveSentEmailObserver {
  const {
    runtime,
    transportId,
    expectedRecipient,
    expectedAccountToken,
    propertyCode = HRCEN_PROPERTY_CODE,
    scopeClass = 'reservation',
  } = input;

  return {
    async observeSentEmailRows(authorization, child, signal) {
      if (input.propertyReadLock && !isPropertyReadLockHeld(input.propertyReadLock.key)) {
        return input.propertyReadLock.withLock(
          () =>
            createLiveSentEmailObserver({
              ...input,
              propertyReadLock: undefined,
            }).observeSentEmailRows(authorization, child, signal),
          { signal },
        );
      }
      assertNotAborted(signal);
      assertSentEmailAuth(
        authorization,
        child,
        new Set(['hms_sent_email_audit', 'hms_list_documents']),
        new Set(['sent_email_audit', 'sent_email_documents']),
        propertyCode,
      );

      const observedAt = new Date();
      const started = observedAt.getTime();
      const session = await runtime.openReadSession({
        transportId,
        signal,
        allowUnstarted: true,
        sessionAuthorization: authorization,
      });

      try {
        assertNotAborted(signal);
        await navigatePssnel(session.page, session.origin);
        const correlation = session.page.waitForCorrelatedResponse
          ? session.page.waitForCorrelatedResponse(LIVE_SENT_EMAIL_LIST_PATH)
          : Promise.resolve();
        const [post, correlated] = await Promise.allSettled([
          session.page.postForm(`${session.origin}${LIVE_SENT_EMAIL_LIST_PATH}`, {
            SYSTEM_FUNCTION_NAME: 'PSSNEL',
            USER_FUNCTION_NAME: 'PSSNEL',
            CURRENT_TAB_NAME: 'HDR',
          }),
          correlation,
        ]);
        if (post.status === 'rejected') throw post.reason;
        if (correlated.status === 'rejected') {
          throw new HmsRuntimeError(
            'SCHEMA_DRIFT',
            'sent-email list correlation failed',
          );
        }
        if (session.terminal() || session.violation()) {
          return {
            scopeClass,
            recipientMatch: 'exact_redacted',
            rows: [],
            rowsScanned: 0,
            bytesObserved: 0,
            durationMs: 0,
            observedAt: observedAt.toISOString(),
          };
        }

        const text = post.value || (await session.page.content());
        assertNotAborted(signal);
        const parsed = parsePssnelHdrTransportRows(text);
        const durationMs = Math.min(
          Date.now() - started,
          SENT_EMAIL_AUDIT_MAX_DURATION_MS,
        );
        if (!parsed.envelopeRecognized) {
          return {
            scopeClass,
            recipientMatch: 'exact_redacted',
            rows: [],
            rowsScanned: 0,
            bytesObserved: parsed.bytesObserved,
            durationMs,
            observedAt: observedAt.toISOString(),
          };
        }

        return minimizeCorrelatedSentEmailRows({
          privateRows: parsed.rows,
          scopeClass,
          scopeHash: child.scopeHash,
          expectedRecipient,
          expectedAccountToken,
          observedAt: observedAt.toISOString(),
          durationMs,
          bytesObserved: parsed.bytesObserved,
        });
      } finally {
        await session.close();
      }
    },
  };
}

async function navigatePssnel(page: HmsPage, origin: string): Promise<void> {
  await page
    .postForm(`${origin}${LIVE_SENT_EMAIL_OPEN_PATH}?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=PSSNEL`, {
      SYSTEM_FUNCTION_NAME: 'PSSNEL',
      USER_FUNCTION_NAME: 'PSSNEL',
      CURRENT_TAB_NAME: '',
      MENU_MODULE_KEY: '0',
      FUNCTION_CLASS: 'WEBL',
      removescreenflows: 'yes',
    })
    .catch(() => undefined);
}

/** Brief interface — requires factory binding. */
export function observeSentEmailRows(
  this: LiveSentEmailObserver | void,
  authorization: HmsSessionAuthorization,
  child: ReadCandidateChild,
  signal: AbortSignal,
): Promise<MinimizedSentEmailRows> {
  if (!this || typeof this.observeSentEmailRows !== 'function') {
    throw new Error(
      'observeSentEmailRows requires createLiveSentEmailObserver(...).observeSentEmailRows binding',
    );
  }
  return this.observeSentEmailRows(authorization, child, signal);
}

void LIVE_SENT_EMAIL_ALIAS_KEYS;
