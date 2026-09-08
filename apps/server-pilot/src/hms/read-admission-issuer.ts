import {
  existingDocumentRefForRecord,
  existingDocumentSha256FromRef,
  existingDocumentScopeRef,
  mailAttachmentRecord,
  type ExistingDocumentRecord,
} from '../mail/artifacts/existing-document-service.js';
import {
  normalizeQuoteRequestFromAuthoredSegment,
  unavailableQuoteReferenceAuthority,
  type QuoteReferenceAuthorityLoader,
} from './quote-request-normalization.js';
import {
  assertPersistedReadAdmissionIssuer,
  issueReadAdmission,
  type IssuedReadAdmission,
  type ReadAdmissionSource,
} from './read-admission.js';
import {
  aiWorkflowRun,
  attachment,
  mailboxAccess,
  mailboxTransport,
  mailThread,
  message,
} from '../db/schema/mail.js';
import type {
  DocumentSource,
  DocumentKind,
  ExistingDocumentScope,
} from '../mail/artifacts/existing-document-contracts.js';
import {
  reservationFindResultSchema,
  type ReservationFindResult,
} from './reservation-context-contract.js';
import { extractLookupCandidates, filterExactReservationCandidates } from '../ai/thread-context.js';
import { DOCUMENT_LIST_MAX_ROWS } from './document-list-contract.js';
import { normalizeMessageText } from '../ai/thread-context.js';
import { and, asc, desc, eq, lte, or } from 'drizzle-orm';
import { readAiRunReceipt } from '../ai/run-ledger.js';
import { readRequestSchema } from './read-service.js';
import type { DB } from '../db/client.js';

export type ReadAdmissionReleaseInput = {
  releaseId: string;
  requestBranchId: string;
};

export type IssueMailboxReadAdmissionInput = ReadAdmissionReleaseInput & {
  db: DB;
  userId: string;
  transportId: string;
  threadId: string;
  toolId:
    | 'hms_find_reservation'
    | 'hms_read_reservation'
    | 'hms_read_folio'
    | 'hms_quote_stay'
    | 'documents_list_existing'
    | 'documents_read_existing';
  now?: Date;
  sections?: readonly string[];
  detail?: 'summary' | 'detail';
  parentReadResultRef?: string;
  source?: DocumentSource;
  kind?: DocumentKind;
  limit?: number;
  cursor?: string;
  requestedPriceVisibility?: 'allowed' | 'forbidden' | 'unknown';
  documentRef?: string;
  format?: 'text' | 'artifact';
  quoteRequestRef?: string;
  captureBindingRef?: string;
};

export type IssuedMailboxReadAdmission = IssuedReadAdmission & {
  accessId: string;
  triggerMessageId: string;
  candidateId: string | null;
  quoteRequestRef: string | null;
};

export type ReadAdmissionDependencies = {
  /** Internal source seam; production composition must provide real current data. */
  quoteReferenceAuthorityLoader?: QuoteReferenceAuthorityLoader;
};

let configuredQuoteReferenceAuthorityLoader: QuoteReferenceAuthorityLoader =
  unavailableQuoteReferenceAuthority;

/** Test-only composition seam; normal route composition remains unavailable until real source wiring. */
export function __setQuoteReferenceAuthorityLoaderForTests(
  loader: QuoteReferenceAuthorityLoader,
): void {
  configuredQuoteReferenceAuthorityLoader = loader;
}

export function __clearQuoteReferenceAuthorityLoaderForTests(): void {
  configuredQuoteReferenceAuthorityLoader = unavailableQuoteReferenceAuthority;
}

function authError(code: string, messageText: string): Error & { code: string } {
  return Object.assign(new Error(messageText), { code });
}

export async function loadReadMailboxGrant(input: { db: DB; userId: string; transportId: string }) {
  const [grant] = await input.db
    .select({
      accessId: mailboxAccess.id,
      userId: mailboxAccess.userId,
      transportId: mailboxAccess.transportId,
      transportActive: mailboxTransport.isActive,
    })
    .from(mailboxAccess)
    .innerJoin(mailboxTransport, eq(mailboxAccess.transportId, mailboxTransport.id))
    .where(
      and(eq(mailboxAccess.userId, input.userId), eq(mailboxAccess.transportId, input.transportId)),
    )
    .limit(1);
  if (!grant || !grant.transportActive) {
    throw authError('READ_MAILBOX_GRANT_MISSING', 'current mailbox grant is not active');
  }
  return grant;
}

async function loadTrigger(
  input: IssueMailboxReadAdmissionInput,
  db: DB,
  dependencies: ReadAdmissionDependencies,
) {
  const [thread] = await db
    .select({ id: mailThread.id, transportId: mailThread.transportId })
    .from(mailThread)
    .where(and(eq(mailThread.id, input.threadId), eq(mailThread.transportId, input.transportId)))
    .limit(1);
  if (!thread) throw authError('READ_THREAD_SCOPE_MISMATCH', 'thread is not in the active mailbox');

  const rows = await db
    .select({
      id: message.id,
      direction: message.direction,
      textBody: message.textBody,
      htmlBody: message.htmlBody,
      subject: message.subject,
      receivedAt: message.receivedAt,
      createdAt: message.createdAt,
    })
    .from(message)
    .where(and(eq(message.threadId, input.threadId), eq(message.transportId, input.transportId)))
    .orderBy(desc(message.receivedAt), desc(message.id));
  const trigger = rows.find((row) => row.direction === 'inbound');
  if (!trigger) throw authError('READ_TRIGGER_MISSING', 'thread has no inbound trigger');

  const triggerText = [
    trigger.subject?.trim() ?? '',
    normalizeMessageText({ textBody: trigger.textBody, htmlBody: trigger.htmlBody }),
  ]
    .filter(Boolean)
    .join('\n');
  if (input.toolId === 'hms_quote_stay') {
    const authorityResult = await (
      dependencies.quoteReferenceAuthorityLoader ?? configuredQuoteReferenceAuthorityLoader
    )({
      now: input.now ?? new Date(),
      transportId: input.transportId,
      threadId: input.threadId,
      triggerMessageId: trigger.id,
    });
    if (authorityResult.status !== 'ready') {
      throw authError(
        'READ_QUOTE_AUTHORITY_UNAVAILABLE',
        `quote reference authority is ${authorityResult.reason}`,
      );
    }
    const normalized = normalizeQuoteRequestFromAuthoredSegment(triggerText, {
      referenceAuthority: authorityResult.authority,
      now: input.now ?? new Date(),
    });
    if (normalized.status !== 'ready') {
      throw authError(
        'READ_QUOTE_INPUT_CLARIFICATION',
        `quote request needs clarification: ${normalized.unresolvedInputs.join(', ')}`,
      );
    }
    return {
      triggerMessageId: trigger.id,
      candidateId: null,
      quoteRequest: normalized.request,
      text: triggerText,
      observedAt: trigger.receivedAt ?? trigger.createdAt,
    };
  }
  const exact = filterExactReservationCandidates(extractLookupCandidates(triggerText));
  if (
    exact.length !== 1 &&
    input.toolId !== 'documents_list_existing' &&
    input.toolId !== 'documents_read_existing'
  ) {
    throw authError(
      'READ_CANDIDATE_NOT_EXACT',
      'read admission requires one exact trigger candidate',
    );
  }
  return {
    triggerMessageId: trigger.id,
    candidateId: exact.length === 1 ? exact[0]!.id : null,
    text: triggerText,
    observedAt: trigger.receivedAt ?? trigger.createdAt,
    quoteRequest: null,
  };
}

type DocumentScopeAuthority = {
  scope: ExistingDocumentScope;
  records: ExistingDocumentRecord[];
  recordsComplete: boolean;
};

async function loadDocumentScopeAuthority(input: {
  db: DB;
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  requestedKind?: DocumentKind;
  requestedPriceVisibility?: 'allowed' | 'forbidden' | 'unknown';
  includeRecords?: boolean;
}): Promise<DocumentScopeAuthority> {
  const [trigger] = await input.db
    .select({
      id: message.id,
      receivedAt: message.receivedAt,
      createdAt: message.createdAt,
    })
    .from(message)
    .where(
      and(
        eq(message.id, input.triggerMessageId),
        eq(message.threadId, input.threadId),
        eq(message.transportId, input.transportId),
        eq(message.direction, 'inbound'),
      ),
    )
    .limit(1);
  if (!trigger)
    throw authError('READ_TRIGGER_MISSING', 'document trigger is not in the active mailbox');

  const scopeRef = existingDocumentScopeRef({
    transportId: input.transportId,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
  });
  const scope: ExistingDocumentScope = {
    scopeRef,
    // These identity/stay values are server-derived from the authorized
    // trigger context. They are never accepted from the route input.
    propertyRef: 'unknown',
    guestRef: null,
    stayStart: null,
    stayEnd: null,
    payerRef: null,
    requestedKind: input.requestedKind ?? null,
    requestedPriceVisibility: input.requestedPriceVisibility ?? 'allowed',
  };

  // List admission only proves the current trigger/scope. The worker owns the
  // bounded source query; do not materialize every attachment or message body
  // merely to issue a queued list request.
  if (input.includeRecords !== true) return { scope, records: [], recordsComplete: true };

  const rows = await input.db
    .select({
      id: attachment.id,
      messageId: attachment.messageId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      s3Key: attachment.s3Key,
      messageDirection: message.direction,
      receivedAt: message.receivedAt,
      createdAt: message.createdAt,
    })
    .from(attachment)
    .innerJoin(message, eq(message.id, attachment.messageId))
    .where(
      and(
        eq(message.threadId, input.threadId),
        eq(message.transportId, input.transportId),
        trigger.receivedAt
          ? or(
              and(eq(message.direction, 'inbound'), lte(message.receivedAt, trigger.receivedAt)),
              and(eq(message.direction, 'outbound'), lte(message.createdAt, trigger.receivedAt)),
            )
          : eq(message.id, trigger.id),
      ),
    )
    .orderBy(asc(message.receivedAt), asc(message.createdAt), asc(attachment.id))
    .limit(DOCUMENT_LIST_MAX_ROWS + 1);
  const recordsComplete = rows.length <= DOCUMENT_LIST_MAX_ROWS;
  const boundedRows = rows.slice(0, DOCUMENT_LIST_MAX_ROWS);
  const authorizedAttachmentIds = new Set(boundedRows.map((row) => row.id));
  const records = boundedRows.map((row) =>
    mailAttachmentRecord({
      scope,
      source: row.messageDirection === 'outbound' ? 'hms_sent_attachment' : 'mail_attachment',
      attachmentId: row.id,
      authorizedAttachmentIds,
      messageId: row.messageId,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      s3Key: row.s3Key,
      text: row.filename,
      observedAt:
        (row.messageDirection === 'inbound' ? row.receivedAt : row.createdAt)?.toISOString() ??
        null,
    }),
  );
  return { scope, records, recordsComplete };
}

async function assertDocumentRefInCurrentScope(input: {
  db: DB;
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  documentRef: string;
}): Promise<void> {
  const authority = await loadDocumentScopeAuthority({
    db: input.db,
    transportId: input.transportId,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
    requestedPriceVisibility: 'allowed',
    includeRecords: true,
  });
  const expectedSha256 = existingDocumentSha256FromRef(input.documentRef);
  const found = authority.records.some((record) => {
    const candidate = expectedSha256
      ? {
          ...record,
          sha256: expectedSha256,
        }
      : record;
    return existingDocumentRefForRecord(candidate) === input.documentRef;
  });
  if (!found) {
    throw authError(
      authority.recordsComplete ? 'DOCUMENT_REF_SCOPE_DENIED' : 'DOCUMENT_REF_SCOPE_UNRESOLVED',
      authority.recordsComplete
        ? 'document reference is not current and authorized for this mailbox thread'
        : 'document reference could not be resolved within the bounded current mailbox scope',
    );
  }
}

function positiveFindEvidence(input: { result: ReservationFindResult; now: Date }): string {
  if (
    input.result.status !== 'ok' ||
    input.result.completeness !== 'complete' ||
    !input.result.data ||
    input.result.data.matchCount !== 1 ||
    input.result.data.matches.length !== 1
  ) {
    throw authError('READ_EVIDENCE_NOT_POSITIVE', 'parent read is not one exact positive result');
  }
  const evidence = input.result.evidence.filter((entry) => entry.scopeVerified);
  if (evidence.length === 0) {
    throw authError('READ_EVIDENCE_SCOPE_UNVERIFIED', 'parent read evidence is not scope verified');
  }
  const expiresAtMs = Math.min(...evidence.map((entry) => Date.parse(entry.expiresAt)));
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= input.now.getTime()) {
    throw authError('READ_EVIDENCE_EXPIRED', 'parent read evidence is expired');
  }
  const match = input.result.data.matches[0]!;
  if (!match.matchEvidenceRefs.some((ref) => evidence.some((entry) => entry.evidenceRef === ref))) {
    throw authError('READ_EVIDENCE_MISMATCH', 'positive match is not bound to scoped evidence');
  }
  return new Date(expiresAtMs).toISOString();
}

async function loadParentFind(input: {
  source: ReadAdmissionSource;
  parentReadResultRef: string;
  candidateId: string;
  now: Date;
  db: DB;
}): Promise<string> {
  const [parent] = await input.db
    .select()
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.readResultRef, input.parentReadResultRef),
        eq(aiWorkflowRun.runKind, 'read_tool'),
        eq(aiWorkflowRun.transportId, input.source.transportId),
        eq(aiWorkflowRun.threadId, input.source.threadId),
        eq(aiWorkflowRun.triggerMessageId, input.source.triggerMessageId),
      ),
    )
    .limit(1);
  if (!parent)
    throw authError(
      'READ_PARENT_RECEIPT_MISSING',
      'parent typed receipt is not in this mail scope',
    );
  const parsedRequest = readRequestSchema.safeParse(parent.readRequest);
  if (!parsedRequest.success || parsedRequest.data.toolId !== 'hms_find_reservation') {
    throw authError(
      'READ_PARENT_RECEIPT_TOOL_MISMATCH',
      'parent receipt is not an exact reservation find',
    );
  }
  if (parsedRequest.data.candidateId !== input.candidateId) {
    throw authError(
      'READ_PARENT_CANDIDATE_MISMATCH',
      'parent receipt candidate is not the current trigger candidate',
    );
  }
  const parentMetrics =
    parent.metrics && typeof parent.metrics === 'object'
      ? (parent.metrics as Record<string, unknown>)
      : null;
  try {
    assertPersistedReadAdmissionIssuer({
      issuer: parentMetrics?.readAdmissionIssuer,
      request: parsedRequest.data as unknown as Record<string, unknown>,
      run: parent,
      expectedUserId: input.source.userId,
      expectedMailboxAccessId: input.source.mailboxAccessId,
      expectedToolId: 'hms_find_reservation',
    });
  } catch (error) {
    throw authError(
      'READ_PARENT_ISSUER_INVALID',
      error instanceof Error ? error.message : 'parent issuer provenance is invalid',
    );
  }
  const receipt = await readAiRunReceipt(
    {
      readResultRef: input.parentReadResultRef,
      transportId: input.source.transportId,
      threadId: input.source.threadId,
      triggerMessageId: input.source.triggerMessageId,
      requesterAuthorizationId: input.source.mailboxAccessId,
      now: input.now,
    },
    input.db,
  );
  if (!receipt)
    throw authError('READ_PARENT_RECEIPT_INVALID', 'parent typed receipt is not readable');
  const parsedResult = reservationFindResultSchema.safeParse(receipt.result);
  if (!parsedResult.success)
    throw authError('READ_PARENT_RESULT_INVALID', 'parent result is not reservation find data');
  return positiveFindEvidence({ result: parsedResult.data, now: input.now });
}

/**
 * The sole production admission entrypoint for normal callers. It derives the
 * trigger/candidate and current grant from DB state, and for context reads it
 * validates the succeeded positive parent receipt before minting a ref.
 */
export async function issueReadAdmissionFromMailbox(
  input: IssueMailboxReadAdmissionInput,
  dependencies: ReadAdmissionDependencies = {},
): Promise<IssuedMailboxReadAdmission> {
  const now = input.now ?? new Date();
  const db = input.db;
  const grant = await loadReadMailboxGrant({
    db,
    userId: input.userId,
    transportId: input.transportId,
  });
  const trigger = await loadTrigger(input, db, dependencies);
  const source: ReadAdmissionSource = {
    userId: grant.userId,
    mailboxAccessId: grant.accessId,
    transportId: grant.transportId,
    threadId: input.threadId,
    triggerMessageId: trigger.triggerMessageId,
    releaseId: input.releaseId,
    requestBranchId: input.requestBranchId,
    ...(input.captureBindingRef ? { captureBindingRef: input.captureBindingRef } : {}),
  };
  let issued: IssuedReadAdmission;
  if (input.toolId === 'documents_list_existing') {
    const documentSource = input.source ?? 'mail_attachment';
    const authority = await loadDocumentScopeAuthority({
      db,
      transportId: input.transportId,
      threadId: input.threadId,
      triggerMessageId: trigger.triggerMessageId,
      requestedKind: input.kind,
      requestedPriceVisibility: input.requestedPriceVisibility,
      includeRecords: false,
    });
    issued = issueReadAdmission({
      source,
      now,
      toolId: 'documents_list_existing',
      request: {
        scopeRef: authority.scope.scopeRef,
        source: documentSource,
        ...(input.kind ? { kinds: [input.kind] } : {}),
        limit: input.limit ?? 20,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        requestedPriceVisibility: input.requestedPriceVisibility ?? 'allowed',
      },
    });
  } else if (input.toolId === 'documents_read_existing') {
    if (!input.documentRef || !input.format) {
      throw authError('DOCUMENT_REQUEST_INVALID', 'document read requires ref and format');
    }
    await assertDocumentRefInCurrentScope({
      db,
      transportId: input.transportId,
      threadId: input.threadId,
      triggerMessageId: trigger.triggerMessageId,
      documentRef: input.documentRef,
    });
    issued = issueReadAdmission({
      source,
      now,
      toolId: 'documents_read_existing',
      request: {
        documentRef: input.documentRef,
        format: input.format,
      },
    });
  } else if (input.toolId === 'hms_quote_stay') {
    if (!trigger.quoteRequest) {
      throw authError('READ_QUOTE_INPUT_CLARIFICATION', 'quote request needs clarification');
    }
    if (
      input.quoteRequestRef !== undefined &&
      input.quoteRequestRef !== trigger.quoteRequest.quoteRequestRef
    ) {
      throw authError('READ_QUOTE_SCOPE_MISMATCH', 'quote request reference is not current');
    }
    issued = issueReadAdmission({
      source,
      now,
      toolId: 'hms_quote_stay',
      quoteRequest: trigger.quoteRequest,
      detail: input.detail,
    });
  } else {
    if (!trigger.candidateId) {
      throw authError(
        'READ_CANDIDATE_NOT_EXACT',
        'read admission requires one exact trigger candidate',
      );
    }
    let evidenceExpiresAt: Date | string | undefined;
    if (input.toolId === 'hms_read_reservation' || input.toolId === 'hms_read_folio') {
      if (!input.parentReadResultRef) {
        throw authError(
          'READ_PARENT_RECEIPT_REQUIRED',
          'context read requires a succeeded find receipt',
        );
      }
      evidenceExpiresAt = await loadParentFind({
        source,
        parentReadResultRef: input.parentReadResultRef,
        candidateId: trigger.candidateId,
        now,
        db,
      });
    }
    issued = issueReadAdmission({
      source,
      now,
      candidateId: trigger.candidateId,
      toolId: input.toolId,
      sections: input.sections,
      detail: input.detail,
      parentReadResultRef: input.parentReadResultRef,
      evidenceExpiresAt,
    });
  }
  return {
    ...issued,
    accessId: grant.accessId,
    triggerMessageId: trigger.triggerMessageId,
    candidateId: trigger.candidateId,
    quoteRequestRef: trigger.quoteRequest?.quoteRequestRef ?? null,
  };
}

export { positiveFindEvidence };
