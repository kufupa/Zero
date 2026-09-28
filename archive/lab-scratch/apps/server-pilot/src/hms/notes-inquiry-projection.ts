/** Project bound notes-inquiry source rows into public NotesTraceItem facts. */
import { createHash } from 'node:crypto';
import type {
  NotesInquiryAudience,
  NotesInquiryItem,
  NotesInquiryReadResult,
} from './notes-inquiry-read-facade.js';
import type {
  NotesTraceItem,
  NotesTracesContextData,
  NotesTracesListData,
  NotesTracesSection,
} from '../../../../../../apps/server-pilot/src/hms/context-read-contracts.js';
import {
  knownFact,
  readRefSchema,
  unknownFact,
  type ReadReasonCode,
} from '../../../../../../apps/server-pilot/src/hms/read-service-contracts.js';

export type NotesInquiryProjectionInput = {
  resourceRef: string;
  evidenceRef: string;
  observedAt: Date;
  expiresAt: Date;
  audience: NotesInquiryAudience;
  limit: number;
};

export type ProjectedNotesInquiry = {
  data: NotesTracesContextData;
  claimKeys: string[];
};

export type ProjectedNotesInquiryItems = {
  items: NotesTraceItem[];
  issues: ReturnType<typeof issueFor>[];
  sourceComplete: boolean;
};

export class NotesInquiryProjectionError extends Error {
  readonly code = 'SCOPE_MISMATCH' as const;

  constructor() {
    super('SCOPE_MISMATCH: notes inquiry parent does not match requested resource');
    this.name = 'NotesInquiryProjectionError';
  }
}

function stableNoteRef(
  resourceRef: string,
  sourceId: string,
  sourceHash: string,
): string {
  const digest = createHash('sha256')
    .update(`${resourceRef}|notes-inquiry|${sourceId}|${sourceHash}`)
    .digest('hex')
    .slice(0, 32);
  return readRefSchema.parse(`note:inquiry:${digest}`);
}

function unknownNoteFact(input: NotesInquiryProjectionInput) {
  return unknownFact({
    reasonCode: 'NOT_APPLICABLE',
    evidenceRef: input.evidenceRef,
    observedAt: input.observedAt,
    expiresAt: input.expiresAt,
  });
}

function rowCustomerVisible(row: NotesInquiryItem): boolean {
  return row.private === false && row.printOnConfirmation === true;
}

function projectRow(
  row: NotesInquiryItem,
  input: NotesInquiryProjectionInput,
): NotesTraceItem {
  const customerVisible = rowCustomerVisible(row);
  return {
    noteRef: stableNoteRef(
      input.resourceRef,
      `reservation:${row.id}`,
      createHash('sha256').update(row.note).digest('hex'),
    ),
    resourceRef: input.resourceRef,
    sourceKind: knownFact({
      value: 'note',
      evidenceRef: input.evidenceRef,
      observedAt: input.observedAt,
      expiresAt: input.expiresAt,
    }),
    permittedText: knownFact({
      value: row.note,
      evidenceRef: input.evidenceRef,
      observedAt: input.observedAt,
      expiresAt: input.expiresAt,
    }),
    audience: knownFact({
      value: customerVisible ? 'customer_disclosable' : 'staff_only',
      evidenceRef: input.evidenceRef,
      observedAt: input.observedAt,
      expiresAt: input.expiresAt,
    }),
    customerPrintable: knownFact({
      value: customerVisible,
      evidenceRef: input.evidenceRef,
      observedAt: input.observedAt,
      expiresAt: input.expiresAt,
    }),
    status: unknownNoteFact(input),
    dueAt: unknownNoteFact(input),
    deliveredAt: unknownNoteFact(input),
    method: unknownNoteFact(input),
    // No author field was present in notesInquiry; do not invent one.
    authorLabel: unknownNoteFact(input),
    createdAt: unknownNoteFact(input),
  };
}

function projectScalar(
  result: NotesInquiryReadResult,
  input: NotesInquiryProjectionInput,
): NotesTraceItem | null {
  if (
    input.audience !== 'staff' ||
    result.reservationNote.audience !== 'staff' ||
    result.reservationNote.state !== 'known' ||
    !result.reservationNote.text
  ) {
    return null;
  }
  return {
    noteRef: stableNoteRef(
      input.resourceRef,
      'reservationNote',
      result.reservationNote.sourceHash,
    ),
    resourceRef: input.resourceRef,
    sourceKind: knownFact({
      value: 'reservation_note',
      evidenceRef: input.evidenceRef,
      observedAt: input.observedAt,
      expiresAt: input.expiresAt,
    }),
    permittedText: knownFact({
      value: result.reservationNote.text,
      evidenceRef: input.evidenceRef,
      expiresAt: input.expiresAt,
      observedAt: input.observedAt,
    }),
    // Scalar has no printability/audience flag. Keep both unknown.
    audience: unknownNoteFact(input),
    customerPrintable: unknownNoteFact(input),
    status: unknownNoteFact(input),
    dueAt: unknownNoteFact(input),
    deliveredAt: unknownNoteFact(input),
    method: unknownNoteFact(input),
    authorLabel: unknownNoteFact(input),
    createdAt: unknownNoteFact(input),
  };
}

function issueFor(code: string) {
  const reasonCode: ReadReasonCode =
    code === 'MASKED_NOTE'
      ? 'POLICY_UNAPPROVED'
      : code === 'TRUNCATED'
        ? 'TRUNCATED'
        : 'PARTIAL_WINDOW';
  return {
    code: reasonCode,
    retryable: false,
    safeNextAction: 'manual_review' as const,
  };
}

/** Project all already-validated rows before applying the public page slice. */
export function projectAllNotesInquiryItems(
  result: NotesInquiryReadResult,
  input: NotesInquiryProjectionInput,
): ProjectedNotesInquiryItems {
  if (
    result.parentBinding.propertyCode !== 'HRCEN' ||
    result.parentBinding.resourceRef !== input.resourceRef ||
    result.audience !== input.audience
  ) {
    throw new NotesInquiryProjectionError();
  }
  const sourceRows = (result.allItems ?? result.items).filter(
    (row) => input.audience === 'staff' || rowCustomerVisible(row),
  );
  const scalar = projectScalar(result, input);
  const allItems = [
    ...sourceRows.map((row) => projectRow(row, input)),
    ...(scalar ? [scalar] : []),
  ];
  const sourceIssues = (result.sourceIssues ?? result.issues).map((issue) => issueFor(issue.code));
  return {
    items: allItems,
    issues: sourceIssues,
    sourceComplete: (result.sourceCompleteness ?? result.completeness) === 'complete' && sourceIssues.length === 0,
  };
}

/** Convert one already-bound inquiry result. No provider/network calls here. */
export function projectNotesInquiryResult(
  result: NotesInquiryReadResult,
  input: NotesInquiryProjectionInput,
): ProjectedNotesInquiry {
  if (
    result.parentBinding.propertyCode !== 'HRCEN' ||
    result.parentBinding.resourceRef !== input.resourceRef ||
    result.audience !== input.audience
  ) {
    throw new NotesInquiryProjectionError();
  }
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
    throw new NotesInquiryProjectionError();
  }

  const projected = projectAllNotesInquiryItems(result, input);
  const allItems = projected.items;
  const pageCut = allItems.length > input.limit;
  const items = pageCut ? allItems.slice(0, input.limit) : allItems;
  const issues = pageCut ? [...projected.issues, issueFor('TRUNCATED')] : projected.issues;
  const page = {
    returnedCount: items.length,
    hasMore: pageCut ? null : result.page.hasMore,
    nextCursor: null,
  } as const;
  const listData: NotesTracesListData = { items, page };
  const notes: NotesTracesSection =
    issues.length > 0 || !projected.sourceComplete
      ? {
          state: 'partial',
          data: listData,
          completeness: 'partial',
          issues,
        }
      : listData;
  const claimKeys = items.map((item) => `notes.${item.noteRef}`);
  return {
    data: { notes },
    claimKeys,
  };
}
