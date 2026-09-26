import {
  readAdmissionSchema,
  readInputDigest,
  readRefSchema,
  readReasonCodeSchema,
  readResultSchema,
  documentsListReadRequestSchema,
  documentsReadReadRequestSchema,
  hmsListDocumentsReadRequestSchema,
  hmsSentEmailAuditReadRequestSchema,
  folioReadRequestSchema,
  quoteStayReadRequestSchema,
  companyAccountReadRequestSchema,
  groupBlockReadRequestSchema,
  eventReadRequestSchema,
  notesTracesReadRequestSchema,
  type ReadReasonCode,
  type ReadAdmission,
  type ReadResult,
} from './read-service-contracts.js';
import {
  companyAccountContextDataSchema,
  eventContextDataSchema,
  filterNotesForAudience,
  groupBlockContextDataSchema,
  notesTracesContextDataSchema,
} from './context-read-contracts.js';
import {
  reservationContextRequestSchema,
  reservationFindRequestSchema,
  type ReservationContextRequest,
  type ReservationFindRequest,
} from './reservation-context-contract.js';
import {
  createReservationContextFacade,
  type ReservationContextLookup,
  type ReservationLookupResult,
  type ReservationRow,
} from './reservation-context-facade.js';
import {
  mintLinkedContextReference,
  type LinkedContextReference,
  type LinkedContextReferenceKind,
} from './context-read-reference.js';
import {
  assertCurrentAppAccessProof,
  assertReadRequesterScope,
  type CurrentAppAccessProof,
} from './requester-authorization.js';
import type {
  ExistingDocumentListResult,
  ExistingDocumentReadResult,
} from '../mail/artifacts/existing-document-contracts.js';
import {
  isPropertyReadConnectionHeld,
  type PropertyReadConnection,
  type PropertyReadLock,
} from './property-read-lock.js';
import {
  assertReadAdmissionIssuer,
  type IssuedReadAdmission,
} from './read-admission.js';
import {
  canonicalLookupCandidateId,
  type ExactLookupCandidate,
} from '../ai/thread-context.js';
import type { ExistingDocumentService } from '../mail/artifacts/existing-document-service.js';
import type { QuoteStayReadRequest } from './read-service-contracts.js';
import type { QuoteRequest } from './quote-request-normalization.js';
import { z } from 'zod';

export const readRequestSchema = z.union([
  reservationFindRequestSchema,
  reservationContextRequestSchema,
  documentsListReadRequestSchema,
  documentsReadReadRequestSchema,
  hmsListDocumentsReadRequestSchema,
  hmsSentEmailAuditReadRequestSchema,
  folioReadRequestSchema,
  quoteStayReadRequestSchema,
  companyAccountReadRequestSchema,
  groupBlockReadRequestSchema,
  eventReadRequestSchema,
  notesTracesReadRequestSchema,
]);
export type ReadRequest =
  | ReservationFindRequest
  | ReservationContextRequest
  | z.infer<typeof documentsListReadRequestSchema>
  | z.infer<typeof documentsReadReadRequestSchema>
  | z.infer<typeof hmsListDocumentsReadRequestSchema>
  | z.infer<typeof hmsSentEmailAuditReadRequestSchema>
  | z.infer<typeof folioReadRequestSchema>
  | QuoteStayReadRequest
  | z.infer<typeof companyAccountReadRequestSchema>
  | z.infer<typeof groupBlockReadRequestSchema>
  | z.infer<typeof eventReadRequestSchema>
  | z.infer<typeof notesTracesReadRequestSchema>;

export type ReadHandlerResult =
  | ReservationLookupResult
  | {
      status: 'ok' | 'not_found' | 'unverified_negative' | 'ambiguous';
      data: {
        confirmation: string | null;
        label: string | null;
        referenceKind: 'confirmation' | 'external' | 'surname_dates' | null;
        status: string | null;
        arrival: string | null;
        departure: string | null;
        roomType: string | null;
        [key: string]: unknown;
      } | null;
      evidenceRef: string;
      observedAt: string;
      expiresAt: string;
    };

export interface ReadHandlers {
  findReservation?: (input: ReservationContextLookup) => Promise<ReadHandlerResult>;
  readReservation?: (
    input: ReservationContextLookup & {
      reservationRef: string;
      sections: readonly string[];
      detail?: 'summary' | 'detail';
    },
  ) => Promise<unknown>;
  readFolio?: (input: {
    candidateId: string;
    reservationRef: string;
    sections: readonly string[];
  }) => Promise<ReadResult<unknown>>;
  quoteStay?: (input: {
    quoteRequestRef: string;
    quoteRequest: QuoteStayReadRequest['quoteRequest'];
    detail: 'summary' | 'detail';
  }) => Promise<ReadResult<unknown>>;
  readCompanyAccount?: (input: { reservationRef: string }) => Promise<ReadResult<unknown>>;
  readGroupBlock?: (input: {
    groupRef: string;
    sections: readonly string[];
  }) => Promise<ReadResult<unknown>>;
  readEvent?: (input: { eventRef: string }) => Promise<ReadResult<unknown>>;
  readNotesTraces?: (input: {
    resourceRef: string;
    states: readonly string[];
    limit: number;
    cursor: string | undefined;
    audience: 'staff' | 'customer';
  }) => Promise<ReadResult<unknown>>;
  listDocuments?: (input: {
    candidateId: string;
    documentScope: 'sent_email' | 'tax_invoice';
  }) => Promise<ReadResult<unknown>>;
  readSentEmailAudit?: (input: { candidateId: string }) => Promise<ReadResult<unknown>>;
}

export interface ReadExecutionContext {
  transportId: string;
  mailboxId: string;
  threadId: string;
  triggerMessageId: string;
  propertyCode: string;
  parentRef: string;
  branchId: string;
  releaseId: string;
  requester: {
    authorizationId: string;
    transportId: string;
    threadId: string;
    triggerMessageId: string;
    allowedClaimKinds: readonly string[];
    expiresAt: string;
  };
  signal: AbortSignal;
  budget: { total: number; limit: number };
  now: () => Date;
  handlers?: ReadHandlers;
  reservationFacade?: ReturnType<typeof createReservationContextFacade>;
  /** Mail-first existing-document source; no PMS session is implied. */
  existingDocumentService?: ExistingDocumentService;
  /** Optional property lock; live worker/proof callers must provide it. */
  propertyReadLock?: PropertyReadLock;
  /** Internal connection proof while the owning lock callback is active. */
  propertyReadLockConnection?: PropertyReadConnection;
  /** Production worker paths must carry a trusted release/input/capture bind. */
  requireAdmissionBinding?: boolean;
  /** Private durable result scope used by capture-required admitted reads. */
  readResultRef?: string;
  /** Production worker paths must carry server-authenticated current app access. */
  requireCurrentAppAccess?: boolean;
  currentAppAccessProof?: CurrentAppAccessProof;
  /** Trusted source-row seam used only while minting parent-linked context refs. */
  linkedContextReferenceSink?: (input: {
    kind: LinkedContextReferenceKind;
    sourceRef: string;
    observedAt: Date | string;
    expiresAt: Date | string;
  }) => void;
  /** Exact source revision joined to any parent-linked context refs. */
  sourceRevision?: string;
  /** Trusted producer requests available to the opaque quote tool facade. */
  quoteRequests?: ReadonlyMap<string, QuoteRequest>;
}

/**
 * The trusted synchronous edge used by the current application/proof runner.
 * Its source must already have crossed the server-owned admission issuer; the
 * edge does not accept a workflow row, claim token, or caller-authored user.
 */
export type TrustedSynchronousHmsFindSession = {
  findReservation: NonNullable<ReadHandlers['findReservation']>;
  propertyReadLock?: PropertyReadLock;
  close?: () => Promise<void>;
};

export type TrustedSynchronousHmsFindSessionFactory = (input: {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  propertyCode: string;
  lookupCandidates: readonly ExactLookupCandidate[];
  signal: AbortSignal;
  runId: string;
  readResultRef: string;
  readAdmission: ReadAdmission;
}) => Promise<TrustedSynchronousHmsFindSession>;

export type TrustedSynchronousHmsFindInput = {
  issued: IssuedReadAdmission;
  candidate: ExactLookupCandidate;
  currentAppAccessProof: CurrentAppAccessProof;
  operationId: string;
  readResultRef: string;
  sourceRevision: string;
  propertyCode: string;
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  deadlineAt: Date;
  now?: Date;
  /** Optional live clock; omit to keep lower-edge fixtures deterministic. */
  clock?: () => Date;
  signal: AbortSignal;
  sessionFactory: TrustedSynchronousHmsFindSessionFactory;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

const executionKeys = new Set([
  'transportId',
  'mailboxId',
  'threadId',
  'triggerMessageId',
  'propertyCode',
  'parentRef',
  'branchId',
  'releaseId',
  'requester',
  'signal',
  'budget',
  'now',
  'handlers',
  'reservationFacade',
  'existingDocumentService',
  'propertyReadLock',
  'propertyReadLockConnection',
  'requireAdmissionBinding',
  'readResultRef',
  'requireCurrentAppAccess',
  'currentAppAccessProof',
  'linkedContextReferenceSink',
  'sourceRevision',
  'quoteRequests',
]);

function validExecutionContext(value: unknown): value is ReadExecutionContext {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) if (!executionKeys.has(key)) return false;
  return (
    [
      'transportId',
      'mailboxId',
      'threadId',
      'triggerMessageId',
      'propertyCode',
      'parentRef',
      'branchId',
      'releaseId',
    ].every((key) => typeof value[key] === 'string' && value[key] !== '') &&
    isRecord(value.requester) &&
    typeof value.requester.authorizationId === 'string' &&
    typeof value.requester.transportId === 'string' &&
    typeof value.requester.threadId === 'string' &&
    typeof value.requester.triggerMessageId === 'string' &&
    Array.isArray(value.requester.allowedClaimKinds) &&
    typeof value.requester.expiresAt === 'string' &&
    isRecord(value.budget) &&
    typeof value.budget.total === 'number' &&
    typeof value.budget.limit === 'number' &&
    !!value.signal &&
    typeof (value.signal as AbortSignal).aborted === 'boolean' &&
    typeof value.now === 'function' &&
    (value.requireAdmissionBinding === undefined ||
      typeof value.requireAdmissionBinding === 'boolean') &&
    (value.readResultRef === undefined || typeof value.readResultRef === 'string') &&
    (value.requireCurrentAppAccess === undefined ||
      typeof value.requireCurrentAppAccess === 'boolean') &&
    (value.existingDocumentService === undefined ||
      (isRecord(value.existingDocumentService) &&
        typeof value.existingDocumentService.documents_list_existing === 'function' &&
        typeof value.existingDocumentService.documents_read_existing === 'function')) &&
    (value.propertyReadLockConnection === undefined ||
      (isRecord(value.propertyReadLockConnection) &&
        typeof value.propertyReadLockConnection.query === 'function' &&
        typeof value.propertyReadLockConnection.close === 'function'))
  );
}

// A custom schema is used because an execution context intentionally carries
// a live AbortSignal and function callbacks; this still rejects arbitrary
// selector/URL fields before dispatch.
export const readExecutionContextSchema = z.custom<ReadExecutionContext>(validExecutionContext, {
  message: 'invalid closed read execution context',
});

export const READ_CONTRACT_VERSION = 'hms-read/1';
export const NOT_APPLICABLE_MODEL_ID = 'not_applicable';

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function assertSynchronousReadActive(input: {
  signal: AbortSignal;
  deadlineAt: Date;
  now: Date;
}): void {
  const nowMs = input.now.getTime();
  const deadlineMs = input.deadlineAt.getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(deadlineMs) || nowMs >= deadlineMs) {
    throw codedError('READ_SYNC_DEADLINE', 'synchronous read deadline is expired');
  }
  if (input.signal.aborted) throw codedError('READ_ABORTED', 'read was aborted');
}

/**
 * Bound session setup itself. If an uncancellable lower edge resolves after
 * the caller has left, close the late session so browser work cannot survive
 * a cancellation race.
 */
function awaitSynchronousReadSetup<T>(input: {
  operation: () => Promise<T>;
  signal: AbortSignal;
  deadlineAt: Date;
  onLateResolution?: (value: T) => void | Promise<void>;
}): Promise<T> {
  const assertActive = () =>
    assertSynchronousReadActive({
      signal: input.signal,
      deadlineAt: input.deadlineAt,
      now: new Date(),
    });
  assertActive();
  let pending: Promise<T>;
  try {
    pending = input.operation();
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
    };
    const rejectForCurrentState = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        assertActive();
        reject(codedError('READ_ABORTED', 'read was aborted'));
      } catch (error) {
        reject(error);
      }
    };
    const onAbort = () => rejectForCurrentState();
    const remaining = input.deadlineAt.getTime() - Date.now();
    if (remaining <= 0) {
      rejectForCurrentState();
      return;
    }
    timer = setTimeout(rejectForCurrentState, remaining);
    timer.unref?.();
    input.signal.addEventListener('abort', onAbort, { once: true });
    if (input.signal.aborted) onAbort();
    pending.then(
      (value) => {
        if (settled) {
          if (input.onLateResolution) {
            void Promise.resolve(input.onLateResolution(value)).catch(() => undefined);
          }
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function toLookup(context: ReadExecutionContext, candidateId: string): ReservationContextLookup {
  return {
    transportId: context.transportId,
    mailboxId: context.mailboxId,
    threadId: context.threadId,
    triggerMessageId: context.triggerMessageId,
    parentRef: context.parentRef,
    branchId: context.branchId,
    propertyCode: context.propertyCode,
    candidateId,
    referenceKind: 'confirmation',
    value: candidateId,
    observedAt: context.now(),
    expiresAt: new Date(context.now().getTime() + 5 * 60_000),
  };
}

function normalizeHandlerResult(result: ReadHandlerResult): ReservationLookupResult {
  if ('row' in result || 'rows' in result) return result as ReservationLookupResult;
  if (result.status === 'not_found' || result.status === 'unverified_negative' || !result.data) {
    return {
      status: result.status === 'unverified_negative' ? 'unverified_negative' : 'not_found',
      evidenceRef: result.evidenceRef,
      observedAt: result.observedAt,
      expiresAt: result.expiresAt,
    };
  }
  const row: ReservationRow = {
    confirmationNumber: result.data.confirmation,
    externalReference: result.data.referenceKind === 'external' ? result.data.confirmation : null,
    guestName: null,
    arrivalDate: result.data.arrival,
    departureDate: result.data.departure,
    reservationStatus: result.data.status,
    roomType: result.data.roomType,
    ratePlan: null,
  };
  return {
    status: result.status === 'ambiguous' ? 'ambiguous' : 'matched',
    ...(result.status === 'ambiguous' ? { rows: [row, row] } : { row }),
    evidenceRef: result.evidenceRef,
    observedAt: result.observedAt,
    expiresAt: result.expiresAt,
  } as ReservationLookupResult;
}

type ExistingDocumentReadRequest =
  | z.infer<typeof documentsListReadRequestSchema>
  | z.infer<typeof documentsReadReadRequestSchema>;
type ExistingDocumentOperationResult = ExistingDocumentListResult | ExistingDocumentReadResult;

function isExistingDocumentRequest(request: ReadRequest): request is ExistingDocumentReadRequest {
  return (
    request.toolId === 'documents_list_existing' || request.toolId === 'documents_read_existing'
  );
}

type HmsCommunicationReadRequest =
  | z.infer<typeof hmsListDocumentsReadRequestSchema>
  | z.infer<typeof hmsSentEmailAuditReadRequestSchema>;

function isHmsCommunicationRequest(
  request: ReadRequest,
): request is HmsCommunicationReadRequest {
  return request.toolId === 'hms_list_documents' || request.toolId === 'hms_sent_email_audit';
}

function assertDocumentRequesterScope(context: ReadExecutionContext): void {
  const expiry = Date.parse(context.requester.expiresAt);
  if (
    !context.requester.authorizationId ||
    !Number.isFinite(expiry) ||
    context.now().getTime() >= expiry
  ) {
    throw codedError('READ_AUTHORIZATION_EXPIRED', 'read authorization is expired');
  }
  if (
    context.requester.transportId !== context.transportId ||
    context.requester.threadId !== context.threadId ||
    context.requester.triggerMessageId !== context.triggerMessageId
  ) {
    throw codedError(
      'READ_AUTHORIZATION_SCOPE_MISMATCH',
      'read authorization scope does not match request',
    );
  }
  if (context.requireCurrentAppAccess) {
    assertCurrentAppAccessProof({
      proof: context.currentAppAccessProof,
      requesterAuthorizationId: context.requester.authorizationId,
      context,
      now: context.now(),
    });
    return;
  }
  if (!context.requester.allowedClaimKinds.includes('document_metadata')) {
    throw codedError('READ_CLAIM_NOT_ALLOWED', 'requester is not entitled to document reads');
  }
}

const DOCUMENT_REASON_CODES: Record<string, ReadReasonCode> = {
  INVALID_DOCUMENT_REQUEST: 'INVALID_INPUT',
  SCOPE_DENIED: 'SCOPE_DENIED',
  SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
  INVENTORY_INCOMPLETE: 'UNVERIFIED_NEGATIVE',
  CURSOR_INVALID: 'INVALID_INPUT',
  SURFACE_UNPROVEN: 'SURFACE_UNPROVEN',
  METADATA_ONLY: 'SURFACE_UNPROVEN',
  MISSING_AUTHORIZED_BYTES: 'SOURCE_UNAVAILABLE',
  DOCUMENT_NOT_RETRIEVABLE: 'SOURCE_UNAVAILABLE',
  DOCUMENT_CHANGED: 'DOCUMENT_CHANGED',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  ENCRYPTED_ARTIFACT: 'UNSUPPORTED_FORMAT',
  NO_EMBEDDED_TEXT: 'SOURCE_UNAVAILABLE',
  ARTIFACT_TOO_LARGE: 'SIZE_LIMIT',
  ARTIFACT_TOO_MANY_PAGES: 'SIZE_LIMIT',
  ARTIFACT_READ_TIMEOUT: 'TIMEOUT',
  MALFORMED_ARTIFACT: 'UNSUPPORTED_FORMAT',
  ARTIFACT_READ_FAILED: 'SOURCE_UNAVAILABLE',
  DOCUMENT_IDENTITY_MISMATCH: 'AMBIGUOUS_IDENTITY',
  DOCUMENT_STAY_DATES_MISMATCH: 'PARTIAL_WINDOW',
  DOCUMENT_PAYER_MISMATCH: 'AMBIGUOUS_IDENTITY',
  DOCUMENT_KIND_MISMATCH: 'INVALID_INPUT',
  DOCUMENT_VERSION_SUPERSEDED: 'STALE_EVIDENCE',
  PRICE_VISIBILITY_FORBIDDEN: 'POLICY_UNAPPROVED',
  DOCUMENT_VALIDATION_INCOMPLETE: 'INPUT_MISSING',
};

function documentReasonCode(value: string | null | undefined): ReadReasonCode {
  const mapped = value ? DOCUMENT_REASON_CODES[value] : undefined;
  if (mapped) return mapped;
  return readReasonCodeSchema.safeParse(value).success
    ? (value as ReadReasonCode)
    : 'SOURCE_UNAVAILABLE';
}

function documentSourceSystem(
  source: string | undefined,
): 'hms' | 'mail' | 'approved_property_document' {
  if (source === 'approved_property_document') return source;
  if (source?.startsWith('hms_')) return 'hms';
  return 'mail';
}

function documentSourceUpdatedAt(value: string | null | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function toExistingDocumentReadResult(input: {
  toolId: ExistingDocumentReadRequest['toolId'];
  scopeRef: string;
  requestBranchId: string;
  now: Date;
  result: ExistingDocumentOperationResult;
}): ReadResult<unknown> {
  const data = input.result.data;
  const listData =
    data && 'documents' in data
      ? (data as {
          documents: Array<{ documentRef: string; source: string; issuedAt: string | null }>;
          page: ReadResult<unknown>['page'];
        })
      : null;
  const readData =
    data && 'document' in data
      ? (data as {
          document: { documentRef: string | null; source: string; issuedAt: string | null };
          artifactRef: string | null;
        })
      : null;
  const evidenceRef =
    listData?.documents[0]?.documentRef ??
    readData?.document.documentRef ??
    `document-observation:${readInputDigest({ toolId: input.toolId, scopeRef: input.scopeRef })}`;
  const source = listData?.documents[0]?.source ?? readData?.document.source;
  const now = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + 5 * 60_000).toISOString();
  const reasonCode = documentReasonCode(input.result.blocker ?? input.result.issues[0]?.code);
  const issues = input.result.issues.map((item) => {
    const code = documentReasonCode(item.code);
    return {
      code,
      retryable: code === 'TIMEOUT' || code === 'SOURCE_UNAVAILABLE',
      safeNextAction:
        code === 'INVALID_INPUT' || code === 'SCOPE_DENIED'
          ? ('request_input' as const)
          : code === 'TIMEOUT'
            ? ('retry_same_read' as const)
            : ('manual_review' as const),
    };
  });
  if (issues.length === 0 && input.result.blocker) {
    issues.push({
      code: reasonCode,
      retryable: reasonCode === 'TIMEOUT' || reasonCode === 'SOURCE_UNAVAILABLE',
      safeNextAction:
        reasonCode === 'SCOPE_DENIED' ? ('request_input' as const) : ('manual_review' as const),
    });
  }
  return readResultSchema.parse({
    toolId: input.toolId,
    schemaVersion: 'existing-documents/1',
    status: input.result.status,
    data,
    completeness:
      input.result.status === 'ok'
        ? 'complete'
        : input.result.status === 'partial'
          ? 'partial'
          : 'unknown',
    unavailableSections: issues.length > 0 ? [{ section: 'documents', reasonCode }] : [],
    scopeRef: input.scopeRef,
    evidence: [
      {
        evidenceRef,
        sourceSystem: documentSourceSystem(source),
        sourceSurface: source ?? 'existing_document',
        requestBranchId: input.requestBranchId,
        observedAt: now,
        sourceUpdatedAt: documentSourceUpdatedAt(
          listData?.documents[0]?.issuedAt ?? readData?.document.issuedAt,
        ),
        expiresAt,
        scopeVerified: reasonCode !== 'SCOPE_DENIED',
        artifactRef: readData?.artifactRef ?? null,
      },
    ],
    page: listData?.page ?? null,
    issues,
  }) as ReadResult<unknown>;
}

function assertContext(context: ReadExecutionContext, request: ReadRequest) {
  readExecutionContextSchema.parse(context);
  const now = context.now();
  if (isExistingDocumentRequest(request)) {
    assertDocumentRequesterScope(context);
  } else {
    assertReadRequesterScope({
      requester: context.requester,
      context,
      now,
      requiredClaimKind:
        request.toolId === 'hms_list_documents'
          ? 'document_metadata'
          : request.toolId === 'hms_sent_email_audit'
            ? 'sent_email_audit'
            : request.toolId === 'hms_read_folio'
              ? 'folio_deposit_summary'
              : request.toolId === 'hms_quote_stay'
                ? 'quote_stay_summary'
                : request.toolId === 'hms_company_account_read'
                  ? 'company_billing_summary'
                  : request.toolId === 'hms_group_block_read'
                    ? 'group_status'
                    : request.toolId === 'hms_event_read'
                      ? 'event_status'
                      : request.toolId === 'hms_read_notes_traces'
                        ? 'notes_trace_observation'
                        : 'reservation_summary',
      currentAppAccessProof: context.currentAppAccessProof,
      requireCurrentAppAccess: context.requireCurrentAppAccess,
    });
  }
  if (context.signal.aborted) throw codedError('READ_ABORTED', 'read was aborted');
  if (context.budget.total >= context.budget.limit)
    throw codedError('READ_BUDGET_EXCEEDED', 'read budget exhausted');
  if (context.requireAdmissionBinding) {
    if (!context.propertyReadLock) {
      throw codedError(
        'READ_PROPERTY_LOCK_REQUIRED',
        'property read lock is required for admitted dispatch',
      );
    }
    const admission = 'admission' in request ? request.admission : undefined;
    if (!admission)
      throw codedError('READ_ADMISSION_MISSING', 'trusted read admission is required');
    const parsed = readAdmissionSchema.parse(admission);
    const { admission: _ignored, ...closedRequest } = request as typeof request & {
      admission?: unknown;
    };
    if (parsed.releaseId !== context.releaseId) {
      throw codedError('READ_RELEASE_BINDING_MISMATCH', 'read release binding mismatch');
    }
    if (parsed.requesterAuthorizationId !== context.requester.authorizationId) {
      throw codedError('READ_REQUESTER_BINDING_MISMATCH', 'read requester binding mismatch');
    }
    if (parsed.requestBranchId !== context.branchId) {
      throw codedError('READ_BRANCH_BINDING_MISMATCH', 'read branch binding mismatch');
    }
    if (parsed.inputDigest !== readInputDigest(closedRequest)) {
      throw codedError('READ_INPUT_BINDING_MISMATCH', 'read input binding mismatch');
    }
    if (
      parsed.captureRequired &&
      (!context.readResultRef || parsed.captureBindingRef !== context.readResultRef)
    ) {
      throw codedError('READ_CAPTURE_BINDING_MISMATCH', 'read capture binding mismatch');
    }
    const expectedReservationRef =
      request.toolId === 'hms_read_reservation' || request.toolId === 'hms_read_folio'
        ? request.reservationRef
        : request.toolId === 'hms_company_account_read'
          ? request.reservationRef
          : request.toolId === 'hms_group_block_read'
            ? request.groupRef
            : request.toolId === 'hms_event_read'
              ? request.eventRef
              : request.toolId === 'hms_read_notes_traces'
                ? request.resourceRef
                : null;
    if (parsed.reservationRef !== expectedReservationRef) {
      throw codedError(
        'READ_RESERVATION_REF_BINDING_MISMATCH',
        'read reservation reference binding mismatch',
      );
    }
  }
  context.budget.total += 1;
}

async function dispatchRead(
  context: ReadExecutionContext,
  request: ReadRequest,
): Promise<ReadResult<unknown>> {
  const parsed = readRequestSchema.parse(request);

  if (isExistingDocumentRequest(parsed)) {
    const service = context.existingDocumentService;
    if (!service) {
      throw codedError('READ_HANDLER_UNAVAILABLE', 'existing-document service is unavailable');
    }
    if (parsed.toolId === 'documents_list_existing') {
      const { toolId: _toolId, admission: _admission, ...listRequest } = parsed;
      const result = await service.documents_list_existing(listRequest);
      return toExistingDocumentReadResult({
        toolId: parsed.toolId,
        scopeRef: parsed.scopeRef,
        requestBranchId: context.branchId,
        now: context.now(),
        result,
      });
    }
    const { toolId: _toolId, admission: _admission, ...readRequest } = parsed;
    const result = await service.documents_read_existing(readRequest);
    return toExistingDocumentReadResult({
      toolId: parsed.toolId,
      scopeRef: service.scopeRefFor(parsed.documentRef) ?? context.parentRef,
      requestBranchId: context.branchId,
      now: context.now(),
      result,
    });
  }

  if (isHmsCommunicationRequest(parsed)) {
    const unavailable = (reasonCode: 'SOURCE_UNAVAILABLE' | 'POLICY_UNAPPROVED') =>
      readResultSchema.parse({
        toolId: parsed.toolId,
        schemaVersion: 'hms-communications/1',
        status: 'manual_required',
        data: null,
        completeness: 'unknown',
        unavailableSections: [
          {
            section:
              parsed.toolId === 'hms_list_documents' ? parsed.documentScope : 'sent_email',
            reasonCode,
          },
        ],
        scopeRef: parsed.candidateId,
        evidence: [],
        page: null,
        issues: [
          {
            code: reasonCode,
            retryable: false,
            safeNextAction: 'manual_review',
          },
        ],
      }) as ReadResult<unknown>;
    if (parsed.toolId === 'hms_list_documents') {
      const handler = context.handlers?.listDocuments;
      return handler
        ? handler({ candidateId: parsed.candidateId, documentScope: parsed.documentScope })
        : Promise.resolve(
            unavailable(
              parsed.documentScope === 'tax_invoice'
                ? 'POLICY_UNAPPROVED'
                : 'SOURCE_UNAVAILABLE',
            ),
          );
    }
    const handler = context.handlers?.readSentEmailAudit;
    return handler
      ? handler({ candidateId: parsed.candidateId })
      : Promise.resolve(unavailable('SOURCE_UNAVAILABLE'));
  }

  if (parsed.toolId === 'hms_find_reservation') {
    const handler = context.handlers?.findReservation;
    if (!handler)
      throw codedError('READ_HANDLER_UNAVAILABLE', 'typed reservation lookup is unavailable');
    const lookupInput = toLookup(context, parsed.candidateId);
    const facade = createReservationContextFacade({
      now: context.now,
      lookup: async (input) => normalizeHandlerResult(await handler(input)),
      linkedContextReferenceSink: context.linkedContextReferenceSink,
      readContext: async (input, row) => {
        if (!context.handlers?.readReservation)
          return {
            core: { status: 'available', confirmation: row.confirmationNumber },
            stay: { status: 'available', arrival: row.arrivalDate, departure: row.departureDate },
          };
        const value = await context.handlers.readReservation(input);
        return (isRecord(value) ? value : {}) as Partial<
          Record<'core' | 'stay' | 'rates' | 'policies' | 'operations', unknown>
        >;
      },
    });
    return (await facade.findReservation(lookupInput)) as ReadResult<unknown>;
  }

  if (parsed.toolId === 'hms_read_folio') {
    const handler = context.handlers?.readFolio;
    if (!handler) {
      throw codedError('READ_HANDLER_UNAVAILABLE', 'typed folio finance handler is unavailable');
    }
    return readResultSchema.parse(
      await handler({
        candidateId: parsed.candidateId,
        reservationRef: parsed.reservationRef,
        sections: parsed.sections,
      }),
    ) as ReadResult<unknown>;
  }

  if (parsed.toolId === 'hms_quote_stay') {
    const handler = context.handlers?.quoteStay;
    if (!handler) {
      throw codedError('READ_HANDLER_UNAVAILABLE', 'typed quote stay handler is unavailable');
    }
    return readResultSchema.parse(
      await handler({
        quoteRequestRef: parsed.quoteRequestRef,
        quoteRequest: parsed.quoteRequest,
        detail: parsed.detail,
      }),
    ) as ReadResult<unknown>;
  }

  if (parsed.toolId === 'hms_company_account_read') {
    const handler = context.handlers?.readCompanyAccount;
    if (!handler) {
      throw codedError(
        'READ_HANDLER_UNAVAILABLE',
        'typed company account context handler is unavailable',
      );
    }
    const result = readResultSchema.parse(await handler({ reservationRef: parsed.reservationRef }));
    if (result.data !== null) companyAccountContextDataSchema.parse(result.data);
    return result as ReadResult<unknown>;
  }

  if (parsed.toolId === 'hms_group_block_read') {
    const handler = context.handlers?.readGroupBlock;
    if (!handler) {
      throw codedError(
        'READ_HANDLER_UNAVAILABLE',
        'typed group block context handler is unavailable',
      );
    }
    const result = readResultSchema.parse(
      await handler({ groupRef: parsed.groupRef, sections: parsed.sections }),
    );
    if (result.data !== null) groupBlockContextDataSchema.parse(result.data);
    return result as ReadResult<unknown>;
  }

  if (parsed.toolId === 'hms_event_read') {
    const handler = context.handlers?.readEvent;
    if (!handler) {
      throw codedError('READ_HANDLER_UNAVAILABLE', 'typed event context handler is unavailable');
    }
    const result = readResultSchema.parse(await handler({ eventRef: parsed.eventRef }));
    if (result.data !== null) eventContextDataSchema.parse(result.data);
    return result as ReadResult<unknown>;
  }

  if (parsed.toolId === 'hms_read_notes_traces') {
    const handler = context.handlers?.readNotesTraces;
    if (!handler) {
      throw codedError('READ_HANDLER_UNAVAILABLE', 'typed notes trace handler is unavailable');
    }
    const result = readResultSchema.parse(
      await handler({
        resourceRef: parsed.resourceRef,
        states: parsed.states,
        limit: parsed.limit,
        cursor: parsed.cursor,
        audience: parsed.audience,
      }),
    );
    if (result.data !== null) {
      const data = notesTracesContextDataSchema.parse(result.data);
      result.data = filterNotesForAudience(data, parsed.audience);
    }
    return result as ReadResult<unknown>;
  }

  const facade = context.reservationFacade;
  if (!facade) throw codedError('READ_HANDLER_UNAVAILABLE', 'reservation context is unavailable');
  const lookupInput = toLookup(context, parsed.reservationRef);
  const result = await facade.readReservation({
    ...lookupInput,
    reservationRef: parsed.reservationRef,
    sections: parsed.sections,
    detail: parsed.detail,
  });
  return result as ReadResult<unknown>;
}

export async function executeRead(
  context: ReadExecutionContext,
  request: ReadRequest,
): Promise<ReadResult<unknown>> {
  const parsed = readRequestSchema.parse(request);
  assertContext(context, parsed);
  // A lock is held around the complete typed dispatch, including any driver
  // admission.  PropertyReadLock itself owns a dedicated connection and
  // closes it on both success and failure.
  const lockHeld =
    !!context.propertyReadLock &&
    !!context.propertyReadLockConnection &&
    isPropertyReadConnectionHeld(context.propertyReadLockConnection, context.propertyReadLock.key);
  if (context.propertyReadLock && !lockHeld) {
    return context.propertyReadLock.withLock(
      (connection) => dispatchRead({ ...context, propertyReadLockConnection: connection }, parsed),
      { signal: context.signal },
    );
  }
  return dispatchRead(context, parsed);
}

export interface ReadToolRunInput {
  runKind: string;
  executorLane: string;
  draftingEnabled: boolean;
  modelFactory?: (...args: never[]) => unknown;
  request: ReadRequest;
  context: ReadExecutionContext;
  resultRef: string;
}

export async function executeReadToolRun(input: ReadToolRunInput): Promise<{
  modelId: typeof NOT_APPLICABLE_MODEL_ID;
  promptVersion: typeof READ_CONTRACT_VERSION;
  readResultRef: string;
  result: ReadResult<unknown>;
  linkedContextReferences: LinkedContextReference[];
}> {
  if (input.runKind !== 'read_tool')
    throw codedError('READ_RUN_KIND_INVALID', 'run is not a read_tool run');
  if (input.executorLane !== 'hms')
    throw codedError('READ_EXECUTOR_LANE_INVALID', 'read_tool must run on the HMS lane');
  if (input.draftingEnabled)
    throw codedError('READ_DRAFTING_DEPENDENCY', 'read_tool cannot depend on drafting');
  const linkedContextReferences: LinkedContextReference[] = [];
  const existingSink = input.context.linkedContextReferenceSink;
  const context: ReadExecutionContext = {
    ...input.context,
    linkedContextReferenceSink: (linked) => {
      existingSink?.(linked);
      try {
        linkedContextReferences.push(
          mintLinkedContextReference({
            ...linked,
            parentReadResultRef: input.resultRef,
            propertyCode: input.context.propertyCode,
            requestBranchId: input.context.branchId,
            sourceRevision: input.context.sourceRevision ?? 'unknown',
            issuedAt: input.context.now(),
            expiresAt: linked.expiresAt,
          }),
        );
      } catch {
        // Invalid or unreviewed source refs never become context authority.
      }
    },
  };
  const result = await executeRead(context, input.request);
  return {
    modelId: NOT_APPLICABLE_MODEL_ID,
    promptVersion: READ_CONTRACT_VERSION,
    readResultRef: readRefSchema.parse(input.resultRef),
    result: readResultSchema.parse(result) as ReadResult<unknown>,
    linkedContextReferences,
  };
}

/**
 * Execute one exact reservation find from a server-issued current-application
 * source without manufacturing an ai_workflow_run. The normal worker can
 * reuse this same guarded dispatch after it has loaded its durable source;
 * queue-free callers must first obtain the issuer ticket and current-app proof
 * from the real mailbox/application boundary.
 */
export async function executeTrustedSynchronousHmsFindReservation(
  input: TrustedSynchronousHmsFindInput,
): Promise<{
  modelId: typeof NOT_APPLICABLE_MODEL_ID;
  promptVersion: typeof READ_CONTRACT_VERSION;
  readResultRef: string;
  result: ReadResult<unknown>;
  linkedContextReferences: LinkedContextReference[];
}> {
  const request = readRequestSchema.parse(input.issued.readRequest);
  if (request.toolId !== 'hms_find_reservation' || !request.admission) {
    throw codedError(
      'READ_SYNC_REQUEST_INVALID',
      'synchronous entry requires an admitted reservation find request',
    );
  }
  if (request.candidateId !== input.candidate.id) {
    throw codedError(
      'READ_SYNC_CANDIDATE_MISMATCH',
      'synchronous entry candidate is not the server-issued exact candidate',
    );
  }
  const admission = request.admission;
  if (
    canonicalLookupCandidateId(input.candidate.kind, input.candidate.value) !== input.candidate.id
  ) {
    throw codedError(
      'READ_SYNC_CANDIDATE_MISMATCH',
      'synchronous entry candidate value is not bound to its canonical id',
    );
  }
  const readResultRef = readRefSchema.parse(input.readResultRef);
  if (
    admission.captureBindingRef !== readResultRef ||
    input.issued.admission.inputDigest !== admission.inputDigest
  ) {
    throw codedError(
      'READ_SYNC_CAPTURE_BINDING_MISMATCH',
      'synchronous entry capture binding is not the issued result scope',
    );
  }
  const issuer = assertReadAdmissionIssuer({
    issuer: input.issued.issuer,
    admission,
    request: request as unknown as Record<string, unknown>,
    transportId: input.transportId,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
  });
  const readNow = () => input.clock?.() ?? (input.now ? new Date(input.now.getTime()) : new Date());
  const now = readNow();
  assertSynchronousReadActive({
    signal: input.signal,
    deadlineAt: input.deadlineAt,
    now,
  });
  assertCurrentAppAccessProof({
    proof: input.currentAppAccessProof,
    requesterAuthorizationId: issuer.mailboxAccessId,
    context: {
      transportId: input.transportId,
      threadId: input.threadId,
      triggerMessageId: input.triggerMessageId,
    },
    now,
  });
  if (
    issuer.userId !== input.currentAppAccessProof.userId ||
    issuer.mailboxAccessId !== input.currentAppAccessProof.mailboxAccessId
  ) {
    throw codedError(
      'READ_SYNC_CURRENT_APP_SCOPE_MISMATCH',
      'synchronous entry issuer is not bound to current application access',
    );
  }

  const session = await awaitSynchronousReadSetup({
    operation: () =>
      input.sessionFactory({
        transportId: input.transportId,
        threadId: input.threadId,
        triggerMessageId: input.triggerMessageId,
        propertyCode: input.propertyCode,
        lookupCandidates: [input.candidate],
        signal: input.signal,
        runId: input.operationId,
        readResultRef,
        readAdmission: admission,
      }),
    signal: input.signal,
    deadlineAt: input.deadlineAt,
    onLateResolution: (lateSession) => lateSession.close?.(),
  });
  try {
    const dispatchNow = readNow();
    assertSynchronousReadActive({
      signal: input.signal,
      deadlineAt: input.deadlineAt,
      now: dispatchNow,
    });
    assertCurrentAppAccessProof({
      proof: input.currentAppAccessProof,
      requesterAuthorizationId: issuer.mailboxAccessId,
      context: {
        transportId: input.transportId,
        threadId: input.threadId,
        triggerMessageId: input.triggerMessageId,
      },
      now: dispatchNow,
    });
    const propertyReadLock = session.propertyReadLock;
    if (!propertyReadLock) {
      throw codedError(
        'READ_PROPERTY_LOCK_REQUIRED',
        'synchronous entry requires the shared property read lock',
      );
    }
    const readContext: ReadExecutionContext = {
      transportId: input.transportId,
      mailboxId: input.transportId,
      threadId: input.threadId,
      triggerMessageId: input.triggerMessageId,
      propertyCode: input.propertyCode,
      sourceRevision: input.sourceRevision,
      parentRef: input.operationId,
      branchId: admission.requestBranchId,
      releaseId: admission.releaseId,
      requester: {
        authorizationId: admission.requesterAuthorizationId,
        transportId: input.transportId,
        threadId: input.threadId,
        triggerMessageId: input.triggerMessageId,
        allowedClaimKinds: ['reservation_summary'],
        expiresAt: input.deadlineAt.toISOString(),
      },
      signal: input.signal,
      budget: { total: 0, limit: 3 },
      now: readNow,
      requireAdmissionBinding: true,
      readResultRef,
      requireCurrentAppAccess: true,
      currentAppAccessProof: input.currentAppAccessProof,
      propertyReadLock,
      handlers: {
        findReservation: session.findReservation,
      },
    };
    assertSynchronousReadActive({
      signal: input.signal,
      deadlineAt: input.deadlineAt,
      now: readContext.now(),
    });
    return await propertyReadLock.withLock(
      async (propertyReadLockConnection) =>
        executeReadToolRun({
          runKind: 'read_tool',
          executorLane: 'hms',
          draftingEnabled: false,
          request,
          context: { ...readContext, propertyReadLockConnection },
          resultRef: readResultRef,
        }),
      {
        signal: input.signal,
        deadlineAt: input.deadlineAt.getTime(),
      },
    );
  } finally {
    await session.close?.();
  }
}
