/**
 * Live notes/traces adapter.
 * Guest Stay detail dump proves reservationnote/cancellationnote (2026-09-12).
 * Dedicated Traces tab remains SURFACE_UNPROVEN until a separate dump.
 */
import {
  NOTES_TRACES_READ_MAX_ROWS,
  NOTES_TRACES_READ_SURFACE_BLOCKER,
  type NotesTracesReadData,
} from './notes-traces-read-contract.js';
import {
  filterNotesForAudience,
  type NotesTracesListData,
} from './context-read-contracts.js';
import { projectNotesFromDetailDump } from './notes-detail-projection.js';
import type { ReservationDetailDumpV1 } from './reservation-detail-projection.js';
import {
  NotesInquiryProjectionError,
  projectAllNotesInquiryItems,
  projectNotesInquiryResult,
} from './notes-inquiry-projection.js';
import type { NotesInquiryReadResult } from './notes-inquiry-read-facade.js';
import type {
  NotesTracesParentBinding,
  NotesTracesReadResult,
  NotesTracesSourceItem,
} from './notes-traces-read-facade.js';
import { readRefSchema, readResultSchema } from './read-service-contracts.js';
import { knownFact, unknownFact } from './read-service-contracts.js';
import type { NotesTraceItem } from './context-read-contracts.js';
import type { HmsSessionAuthorization } from './release-kernel.js';
import type { ReadResult } from './read-service-contracts.js';
import { createHash, randomUUID } from 'node:crypto';
import { HmsRuntimeError } from './runtime.js';
import { z } from 'zod';

export const notesTracesReadInputSchema = z
  .object({
    resourceRef: readRefSchema,
    states: z
      .array(z.enum(['open', 'completed']))
      .min(1)
      .max(2),
    limit: z.number().int().min(1).max(NOTES_TRACES_READ_MAX_ROWS),
    cursor: readRefSchema.optional(),
    audience: z.enum(['staff', 'customer']),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.states).size !== value.states.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['states'],
        message: 'note states must be unique',
      });
    }
  });
export type NotesTracesReadInput = z.infer<typeof notesTracesReadInputSchema>;

const trustedParentBindingSchema = z
  .object({
    propertyCode: z.literal('HRCEN'),
    confirmationNumber: z.string().min(1).max(64),
    reservationStayId: z.string().min(1).max(64),
    resourceRef: readRefSchema,
  })
  .strict();

type TrustedParentBinding = z.infer<typeof trustedParentBindingSchema>;

type NotesSessionAuthorization = Omit<
  HmsSessionAuthorization,
  'toolId' | 'discoveryOperationId'
> & {
  toolId: 'hms_read_notes_traces';
  discoveryOperationId: 'notes_traces_list';
};

function assertNotesAuthorization(authorization: NotesSessionAuthorization): void {
  if (authorization.toolId !== 'hms_read_notes_traces') {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'authorization toolId denied for notes reader');
  }
  if (authorization.requestBranchId !== 'notes_traces_list') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization requestBranchId denied for notes reader',
    );
  }
  if (authorization.discoveryOperationId !== 'notes_traces_list') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization discoveryOperationId denied for notes reader',
    );
  }
  if (Date.parse(authorization.expiresAt) <= Date.now()) {
    throw new HmsRuntimeError('ROLE_PROOF_EXPIRED', 'authorization expired');
  }
}

type ProviderParentBinding = Pick<
  NotesTracesParentBinding,
  'propertyCode' | 'confirmationNumber' | 'reservationStayId'
> & { resourceRef?: string };

function isProviderScopeError(error: unknown): boolean {
  const code = error instanceof HmsRuntimeError
    ? error.code
    : error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : null;
  return code === 'SCOPE_DENIED' || code === 'PARENT_MISMATCH';
}

function assertExpectedProviderParent(
  actual: ProviderParentBinding,
  expected: TrustedParentBinding,
  requestedResourceRef: string,
  surface: 'notes inquiry' | 'TRC',
): void {
  if (
    expected.resourceRef !== requestedResourceRef ||
    actual.propertyCode !== expected.propertyCode ||
    actual.confirmationNumber !== expected.confirmationNumber ||
    actual.reservationStayId !== expected.reservationStayId ||
    actual.resourceRef !== expected.resourceRef
  ) {
    throw new HmsRuntimeError('SCOPE_DENIED', `${surface} provider parent binding rejected`);
  }
}

export type LiveNotesTracesReadDriverOptions = {
  /** Internal proof from the already-correlated HDR/LST parent. Never model input. */
  expectedParentBinding?: TrustedParentBinding;
  /** Wave A9: Guest Stay detail dump that includes reservationnote keys. */
  detailDumpFor?: (
    input: NotesTracesReadInput,
    signal: AbortSignal,
  ) => Promise<ReservationDetailDumpV1 | null>;
  /** Proven JSON notes inquiry; provider owns session/request and returns bound result. */
  notesInquiryFor?: (
    input: NotesTracesReadInput,
    signal: AbortSignal,
  ) => Promise<NotesInquiryReadResult | null>;
  /** Bound OSRESV.TRC provider; parent proof is checked again before projection. */
  notesTracesFor?: (
    input: NotesTracesReadInput,
    signal: AbortSignal,
  ) => Promise<NotesTracesReadResult | null>;
};

function notesListData(
  section: NotesTracesReadData['notes'],
): NotesTracesListData | null {
  if (!('state' in section)) return section;
  return section.state === 'available' || section.state === 'partial' ? section.data : null;
}

function unavailableTracesData(
  data: NotesTracesReadData,
  traces: NotesTracesReadData['traces'] = undefined,
): NotesTracesReadData {
  return {
    ...data,
    // No TRC provider is wired in legacy paths. Keep that fact explicit in
    // data; never promote Guest Stay detail notes into traces.
    traces: traces ?? {
      state: 'unavailable',
      data: null,
      reasonCode: 'SURFACE_UNPROVEN',
      issues: [
        {
          code: 'SURFACE_UNPROVEN',
          retryable: false,
          safeNextAction: 'manual_review',
        },
      ],
    },
  };
}

function pageForNotes(data: NotesTracesReadData) {
  const list = notesListData(data.notes);
  if (!list) return { returnedCount: 0, hasMore: false, nextCursor: null };
  return {
    ...list.page,
    returnedCount: list.items.length,
  };
}

function projectedSourceHash(data: NotesTracesReadData): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

function traceStateForFilter(row: NotesTracesSourceItem): 'open' | 'completed' | null {
  // These source booleans are observed in TRC metadata. They support the
  // explicit state filter and the bounded task-state fact; the separate
  // tracestatus/display axes remain unmapped.
  if (row.cancelled === true) return null;
  if (row.completed === true) return 'completed';
  if (row.completed === false && row.cancelled === false) return 'open';
  return null;
}

function traceUnknownFact(input: {
  evidenceRef: string;
  observedAt: Date;
  expiresAt: Date;
}) {
  return unknownFact({
    reasonCode: 'NOT_APPLICABLE',
    evidenceRef: input.evidenceRef,
    observedAt: input.observedAt,
    expiresAt: input.expiresAt,
  });
}

function traceRef(resourceRef: string, traceId: string, sourceHash: string): string {
  const digest = createHash('sha256')
    .update(`${resourceRef}|notes-traces|${traceId}|${sourceHash}`)
    .digest('hex')
    .slice(0, 32);
  return readRefSchema.parse(`trace:${digest}`);
}

function traceText(row: NotesTracesSourceItem): string | null {
  return row.traceDetails ?? row.description ?? row.topic;
}

function projectTraceItem(
  row: NotesTracesSourceItem,
  input: {
    resourceRef: string;
    evidenceRef: string;
    observedAt: Date;
    expiresAt: Date;
    sourceHash: string;
  },
): { item: NotesTraceItem; truncated: boolean } {
  const text = traceText(row);
  const boundedText = text?.slice(0, 2_000) ?? null;
  const taskState = traceStateForFilter(row);
  return {
    item: {
      noteRef: traceRef(input.resourceRef, row.traceId, input.sourceHash),
      resourceRef: input.resourceRef,
      sourceKind: knownFact({
        value: 'trace',
        evidenceRef: input.evidenceRef,
        observedAt: input.observedAt,
        expiresAt: input.expiresAt,
      }),
      permittedText:
        boundedText === null
          ? traceUnknownFact(input)
          : knownFact({
              value: boundedText,
              evidenceRef: input.evidenceRef,
              observedAt: input.observedAt,
              expiresAt: input.expiresAt,
            }),
      // TRC response has no customer disclosure/printability fields in the
      // observed schema. Unknown is withheld by filterNotesForAudience.
      audience: traceUnknownFact(input),
      customerPrintable: traceUnknownFact(input),
      // Keep the verified task-state booleans separate from the observed
      // display/status axes. `Delivered` is not inferred to mean completed.
      status:
        taskState === null
          ? traceUnknownFact(input)
          : knownFact({
              value: taskState,
              evidenceRef: input.evidenceRef,
              observedAt: input.observedAt,
              expiresAt: input.expiresAt,
            }),
      dueAt:
        row.dueDate === null
          ? traceUnknownFact(input)
          : knownFact({
              value: row.dueDate,
              evidenceRef: input.evidenceRef,
              observedAt: input.observedAt,
              expiresAt: input.expiresAt,
            }),
      // `updated` is not claimed to mean delivery; keep deliveredAt unknown.
      deliveredAt: traceUnknownFact(input),
      method:
        row.deliveryMethod === null
          ? traceUnknownFact(input)
          : knownFact({
              value: row.deliveryMethod,
              evidenceRef: input.evidenceRef,
              observedAt: input.observedAt,
              expiresAt: input.expiresAt,
            }),
      authorLabel:
        row.createdBy === null
          ? traceUnknownFact(input)
          : knownFact({
              value: row.createdBy,
              evidenceRef: input.evidenceRef,
              observedAt: input.observedAt,
              expiresAt: input.expiresAt,
            }),
      createdAt:
        row.created === null
          ? traceUnknownFact(input)
          : knownFact({
              value: row.created,
              evidenceRef: input.evidenceRef,
              observedAt: input.observedAt,
              expiresAt: input.expiresAt,
            }),
    },
    truncated: text !== null && text.length > 2_000,
  };
}

type ProjectedTraces = {
  section: NonNullable<NotesTracesReadData['traces']>;
  page: { returnedCount: number; hasMore: boolean | null; nextCursor: null };
  allItems: NotesTraceItem[];
  sourceComplete: boolean;
  issues: Array<{
    code: 'PARTIAL_WINDOW' | 'TRUNCATED';
    retryable: false;
    safeNextAction: 'manual_review';
  }>;
};

type CursorState = { digest: string; offset: number };
const cursorPattern = /^ntc1:([a-f0-9]{64}):(0|[1-9][0-9]{0,3})$/;

function stableCursorHash(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (!input || typeof input !== 'object') return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  };
  return createHash('sha256')
    .update(JSON.stringify(normalize(value)), 'utf8')
    .digest('hex');
}

function combinedSourceCursorHash(
  notes: NotesInquiryReadResult | null,
  traces: NotesTracesReadResult | null,
): string {
  return stableCursorHash({
    notes: notes
      ? {
          available: true,
          cursorHash: notes.cursorHash ?? stableCursorHash(notes.allItems ?? notes.items),
        }
      : { available: false },
    traces: traces
      ? {
          available: true,
          cursorHash: traces.cursorHash ?? stableCursorHash(traces.allItems ?? traces.items),
        }
      : { available: false },
  });
}

function cursorDigest(
  input: Pick<NotesTracesReadInput, 'resourceRef' | 'audience' | 'states'>,
  sourceHash: string,
): string {
  return stableCursorHash({
    resourceRef: input.resourceRef,
    audience: input.audience,
    states: [...input.states].sort(),
    sourceHash,
  });
}

/** Cursor is a scope/content digest, not an authorization token or secret. */
function makeCursor(
  input: Pick<NotesTracesReadInput, 'resourceRef' | 'audience' | 'states'>,
  sourceHash: string,
  offset: number,
): string {
  return `ntc1:${cursorDigest(input, sourceHash)}:${offset}`;
}

function parseCursor(value: string): CursorState | null {
  const match = cursorPattern.exec(value);
  if (!match) return null;
  const offset = Number(match[2]);
  return Number.isSafeInteger(offset) && offset >= 0 ? { digest: match[1]!, offset } : null;
}

function isKnownFactValue<T>(fact: unknown, value: T): boolean {
  return !!fact && typeof fact === 'object' &&
    (fact as { state?: unknown }).state === 'known' &&
    (fact as { value?: unknown }).value === value;
}

function customerTraceVisible(item: NotesTraceItem): boolean {
  return isKnownFactValue(item.audience, 'customer_disclosable') &&
    isKnownFactValue(item.customerPrintable, true);
}

type CombinedSourceItem = { kind: 'notes' | 'traces'; item: NotesTraceItem };

function combinedFailureResult(input: {
  authorization: NotesSessionAuthorization;
  resourceRef: string;
  evidenceRef: string;
  observedAt: Date;
  expiresAt: Date;
  reasonCode:
    | 'SCOPE_DENIED'
    | 'SOURCE_UNAVAILABLE'
    | 'STALE_EVIDENCE'
    | 'UNSUPPORTED_FORMAT'
    | 'SIZE_LIMIT';
  sourceSurface?: string;
}): ReadResult<NotesTracesReadData> {
  const issue = {
    code: input.reasonCode,
    retryable: false,
    safeNextAction: 'manual_review' as const,
  };
  const data = {
    notes: {
      state: 'unavailable' as const,
      data: null,
      reasonCode: input.reasonCode,
      issues: [issue],
    },
    traces: {
      state: 'unavailable' as const,
      data: null,
      reasonCode: input.reasonCode,
      issues: [issue],
    },
  } satisfies NotesTracesReadData;
  return readResultSchema.parse({
    toolId: 'hms_read_notes_traces',
    schemaVersion: 'hms-notes/1',
    status: input.reasonCode === 'SIZE_LIMIT' ? 'partial' : 'manual_required',
    data,
    completeness: input.reasonCode === 'SIZE_LIMIT' ? 'partial' : 'unknown',
    unavailableSections: [
      { section: 'notes', reasonCode: input.reasonCode },
      { section: 'traces', reasonCode: input.reasonCode },
    ],
    scopeRef: input.resourceRef,
    evidence: [{
      evidenceRef: input.evidenceRef,
      sourceSystem: 'hms' as const,
      sourceSurface: input.sourceSurface ?? 'notes-traces',
      requestBranchId: input.authorization.requestBranchId,
      observedAt: input.observedAt.toISOString(),
      sourceUpdatedAt: null,
      expiresAt: input.expiresAt.toISOString(),
      scopeVerified: input.reasonCode !== 'SCOPE_DENIED',
      artifactRef: null,
      sourceHash: projectedSourceHash(data),
    }],
    page: { returnedCount: 0, hasMore: false, nextCursor: null },
    issues: [issue],
  }) as ReadResult<NotesTracesReadData>;
}

function projectNotesTracesResult(
  result: NotesTracesReadResult,
  input: NotesTracesReadInput,
  context: { evidenceRef: string; observedAt: Date; expiresAt: Date },
): ProjectedTraces {
  if (
    result.parentBinding.propertyCode !== 'HRCEN' ||
    result.parentBinding.resourceRef !== input.resourceRef
  ) {
    throw new HmsRuntimeError(
      'SCOPE_DENIED',
      'TRC provider parent does not match requested resource',
    );
  }

  const issues: ProjectedTraces['issues'] = [];
  const projected: NotesTraceItem[] = [];
  let truncatedText = 0;
  let unknownStateRows = 0;
  const sourceRows = result.allItems ?? result.items;
  for (const row of sourceRows) {
    const state = traceStateForFilter(row);
    if (state !== null && !input.states.includes(state)) continue;
    // A row with no proven state is not silently labelled open/completed and
    // cannot satisfy an explicit state filter.
    if (state === null) {
      unknownStateRows += 1;
      continue;
    }
    const item = projectTraceItem(row, {
      resourceRef: input.resourceRef,
      evidenceRef: context.evidenceRef,
      observedAt: context.observedAt,
      expiresAt: context.expiresAt,
      sourceHash: result.sourceHash,
    });
    projected.push(item.item);
    if (item.truncated) truncatedText += 1;
  }

  if (truncatedText > 0) issues.push({
    code: 'TRUNCATED',
    retryable: false,
    safeNextAction: 'manual_review',
  });
  const sourceIssues = result.sourceIssues ?? result.issues;
  for (const sourceIssue of sourceIssues) {
    if (sourceIssue.code === 'TRUNCATED') issues.push({
      code: 'TRUNCATED',
      retryable: false,
      safeNextAction: 'manual_review',
    });
  }
  if (unknownStateRows > 0) issues.push({
    code: 'PARTIAL_WINDOW',
    retryable: false,
    safeNextAction: 'manual_review',
  });
  if ((result.sourceCompleteness ?? result.completeness) === 'partial') issues.push({
    code: 'PARTIAL_WINDOW',
    retryable: false,
    safeNextAction: 'manual_review',
  });

  const items = projected.slice(0, input.limit);
  const page = {
    returnedCount: items.length,
    hasMore: items.length < projected.length ? null : result.page.hasMore,
    nextCursor: null,
  } as const;
  const list: NotesTracesListData = { items, page };
  const uniqueIssues = issues.filter(
    (issue, index, all) => all.findIndex((candidate) => candidate.code === issue.code) === index,
  );
  const section: NonNullable<NotesTracesReadData['traces']> =
    uniqueIssues.length > 0 || (result.sourceCompleteness ?? result.completeness) === 'partial'
      ? {
          state: 'partial',
          data: list,
          completeness: 'partial',
          issues: uniqueIssues,
        }
      : {
          state: 'available',
          data: list,
          completeness: 'complete',
          issues: [],
        };
  return {
    section,
    page,
    allItems: projected,
    sourceComplete: uniqueIssues.length === 0 &&
      (result.sourceCompleteness ?? result.completeness) === 'complete',
    issues: uniqueIssues,
  };
}

function tracesUnavailableSection(
  reasonCode: 'SOURCE_UNAVAILABLE' | 'SCOPE_DENIED',
): NonNullable<NotesTracesReadData['traces']> {
  return {
    state: 'unavailable',
    data: null,
    reasonCode,
    issues: [{ code: reasonCode, retryable: false, safeNextAction: 'manual_review' }],
  };
}

function notesUnavailableSection(
  reasonCode: 'SOURCE_UNAVAILABLE' | 'SCOPE_DENIED',
): NotesTracesReadData['notes'] {
  return {
    state: 'unavailable',
    data: null,
    reasonCode,
    issues: [{ code: reasonCode, retryable: false, safeNextAction: 'manual_review' }],
  };
}

function tracesOnlyResult(input: {
  authorization: NotesSessionAuthorization;
  resourceRef: string;
  evidenceRef: string;
  observedAt: Date;
  expiresAt: Date;
  traceResult: NotesTracesReadResult | null;
  traceProviderFailed: boolean;
  traceProviderScopeDenied: boolean;
  states: NotesTracesReadInput['states'];
  audience: NotesTracesReadInput['audience'];
  limit: number;
}): ReadResult<NotesTracesReadData> | null {
  if (!input.traceResult && !input.traceProviderFailed && !input.traceProviderScopeDenied) return null;
  let section: NonNullable<NotesTracesReadData['traces']>;
  let sourceHash: string;
  let projectionIssues: ProjectedTraces['issues'] = [];
  if (input.traceProviderScopeDenied) {
    section = tracesUnavailableSection('SCOPE_DENIED');
    sourceHash = projectedSourceHash({ notes: notesUnavailableSection('SOURCE_UNAVAILABLE'), traces: section });
  } else if (input.traceResult) {
    const projected = projectNotesTracesResult(input.traceResult, {
      resourceRef: input.resourceRef,
      states: input.states,
      limit: input.limit,
      audience: input.audience,
    }, {
      evidenceRef: input.evidenceRef,
      observedAt: input.observedAt,
      expiresAt: input.expiresAt,
    });
    section = projected.section;
    sourceHash = input.traceResult.sourceHash;
    projectionIssues = projected.issues;
  } else {
    section = tracesUnavailableSection('SOURCE_UNAVAILABLE');
    sourceHash = projectedSourceHash({ notes: notesUnavailableSection('SOURCE_UNAVAILABLE'), traces: section });
  }
  const filteredData = filterNotesForAudience({
    notes: notesUnavailableSection('SOURCE_UNAVAILABLE'),
    traces: section,
  }, input.audience);
  // Keep the explicit availability/completeness wrapper for every audience;
  // read-service validates traces against the new wrapped contract.
  const data = filteredData;
  const unavailableSections = section.state === 'unavailable'
    ? [
        { section: 'notes', reasonCode: 'SOURCE_UNAVAILABLE' as const },
        { section: 'traces', reasonCode: section.reasonCode },
      ]
    : [{ section: 'notes', reasonCode: 'SOURCE_UNAVAILABLE' as const }];
  return readResultSchema.parse({
    toolId: 'hms_read_notes_traces',
    schemaVersion: 'hms-notes/1',
    status: section.state === 'unavailable' ? 'manual_required' : 'partial',
    data,
    completeness: section.state === 'unavailable' ? 'unknown' : 'partial',
    unavailableSections,
    scopeRef: input.resourceRef,
    evidence: [{
      evidenceRef: input.evidenceRef,
      sourceSystem: 'hms' as const,
      sourceSurface: 'notes-traces',
      requestBranchId: input.authorization.requestBranchId,
      observedAt: input.observedAt.toISOString(),
      sourceUpdatedAt: null,
      expiresAt: input.expiresAt.toISOString(),
      scopeVerified: section.state !== 'unavailable',
      artifactRef: null,
      sourceHash,
    }],
    page: section.state === 'available' || section.state === 'partial'
      ? section.data.page
      : { returnedCount: 0, hasMore: false, nextCursor: null },
    issues: input.traceProviderScopeDenied
      ? [{ code: 'SCOPE_DENIED' as const, retryable: false, safeNextAction: 'manual_review' as const }]
      : projectionIssues.length > 0
      ? projectionIssues
      : [{ code: 'PARTIAL_WINDOW' as const, retryable: false, safeNextAction: 'manual_review' as const }],
  }) as ReadResult<NotesTracesReadData>;
}

function dedupeReadIssues(
  issues: Array<{
    code: string;
    retryable: boolean;
    safeNextAction: 'manual_review';
  }>,
) {
  return issues.filter(
    (issue, index, all) => all.findIndex((candidate) => candidate.code === issue.code) === index,
  );
}

/**
 * Read both proven providers again and page one combined, already-authorized
 * window. The cursor is only a digest + offset; it grants no authority and
 * therefore needs no HMAC. Offset is applied after audience/state filtering.
 */
async function observeCombinedProviders(
  authorization: NotesSessionAuthorization,
  input: NotesTracesReadInput,
  signal: AbortSignal,
  options: LiveNotesTracesReadDriverOptions,
  context: {
    evidenceRef: string;
    observedAt: Date;
    expiresAt: Date;
    expectedParentBinding: TrustedParentBinding;
  },
): Promise<ReadResult<NotesTracesReadData>> {
  const cursor = input.cursor ? parseCursor(input.cursor) : null;
  if (input.cursor && cursor === null) {
    return combinedFailureResult({
      authorization,
      resourceRef: input.resourceRef,
      evidenceRef: context.evidenceRef,
      observedAt: context.observedAt,
      expiresAt: context.expiresAt,
      reasonCode: 'UNSUPPORTED_FORMAT',
    });
  }

  // Providers receive a fresh source read on every continuation. The cursor
  // is intentionally not forwarded as a server/PMS query parameter.
  const sourceInput = { ...input, cursor: undefined };
  const [notesSettled, tracesSettled] = await Promise.all([
    options.notesInquiryFor!(sourceInput, signal).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    ),
    options.notesTracesFor!(sourceInput, signal).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    ),
  ]);
  if (!notesSettled.ok || !tracesSettled.ok) {
    const error = !notesSettled.ok
      ? notesSettled.error
      : !tracesSettled.ok
        ? tracesSettled.error
        : new Error('provider settlement mismatch');
    const errorCode = error instanceof HmsRuntimeError
      ? error.code
      : error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : null;
    if (isProviderScopeError(error)) {
      return combinedFailureResult({
        authorization,
        resourceRef: input.resourceRef,
        evidenceRef: context.evidenceRef,
        observedAt: context.observedAt,
        expiresAt: context.expiresAt,
        reasonCode: 'SCOPE_DENIED',
      });
    }
    if (errorCode === 'SIZE_LIMIT' || errorCode === 'OVERSIZED_BODY') {
      return combinedFailureResult({
        authorization,
        resourceRef: input.resourceRef,
        evidenceRef: context.evidenceRef,
        observedAt: context.observedAt,
        expiresAt: context.expiresAt,
        reasonCode: 'SIZE_LIMIT',
      });
    }
    return combinedFailureResult({
      authorization,
      resourceRef: input.resourceRef,
      evidenceRef: context.evidenceRef,
      observedAt: context.observedAt,
      expiresAt: context.expiresAt,
      reasonCode: 'SOURCE_UNAVAILABLE',
    });
  }
  const notesResult = notesSettled.value;
  const tracesResult = tracesSettled.value;

  let notesProjection: ReturnType<typeof projectAllNotesInquiryItems> | null = null;
  let tracesProjection: ProjectedTraces | null = null;
  try {
    if (notesResult) {
      assertExpectedProviderParent(
        notesResult.parentBinding,
        context.expectedParentBinding,
        input.resourceRef,
        'notes inquiry',
      );
      notesProjection = projectAllNotesInquiryItems(notesResult, {
        resourceRef: input.resourceRef,
        evidenceRef: context.evidenceRef,
        observedAt: context.observedAt,
        expiresAt: context.expiresAt,
        audience: input.audience,
        limit: NOTES_TRACES_READ_MAX_ROWS,
      });
    }
    if (tracesResult) {
      assertExpectedProviderParent(
        tracesResult.parentBinding,
        context.expectedParentBinding,
        input.resourceRef,
        'TRC',
      );
      tracesProjection = projectNotesTracesResult(
        tracesResult,
        { ...input, limit: NOTES_TRACES_READ_MAX_ROWS },
        context,
      );
    }
  } catch (error) {
    if (
      error instanceof NotesInquiryProjectionError ||
      (error instanceof HmsRuntimeError && error.code === 'SCOPE_DENIED')
    ) {
      return combinedFailureResult({
        authorization,
        resourceRef: input.resourceRef,
        evidenceRef: context.evidenceRef,
        observedAt: context.observedAt,
        expiresAt: context.expiresAt,
        reasonCode: 'SCOPE_DENIED',
      });
    }
    return combinedFailureResult({
      authorization,
      resourceRef: input.resourceRef,
      evidenceRef: context.evidenceRef,
      observedAt: context.observedAt,
      expiresAt: context.expiresAt,
      reasonCode: 'SOURCE_UNAVAILABLE',
    });
  }

  const sourceHash = combinedSourceCursorHash(notesResult, tracesResult);
  if (cursor && cursor.digest !== cursorDigest(input, sourceHash)) {
    return combinedFailureResult({
      authorization,
      resourceRef: input.resourceRef,
      evidenceRef: context.evidenceRef,
      observedAt: context.observedAt,
      expiresAt: context.expiresAt,
      reasonCode: 'STALE_EVIDENCE',
    });
  }

  const notesItems: CombinedSourceItem[] = (notesProjection?.items ?? []).map((item) => ({
    kind: 'notes',
    item,
  }));
  const tracesItems: CombinedSourceItem[] = (tracesProjection?.allItems ?? [])
    .filter((entry) => input.audience === 'staff' || customerTraceVisible(entry))
    .map((item) => ({ kind: 'traces', item }));
  const combinedItems = [...notesItems, ...tracesItems];
  const offset = cursor?.offset ?? 0;
  if (offset > combinedItems.length) {
    return combinedFailureResult({
      authorization,
      resourceRef: input.resourceRef,
      evidenceRef: context.evidenceRef,
      observedAt: context.observedAt,
      expiresAt: context.expiresAt,
      reasonCode: 'STALE_EVIDENCE',
    });
  }

  const noteSourceComplete = notesResult !== null && notesProjection?.sourceComplete === true;
  const traceSourceComplete = tracesResult !== null && tracesProjection?.sourceComplete === true;
  const sourcesComplete = noteSourceComplete && traceSourceComplete;
  const pageItems = combinedItems.slice(offset, offset + input.limit);
  const hasMore = sourcesComplete
    ? offset + pageItems.length < combinedItems.length
    : null;
  const nextCursor = hasMore === true
    ? makeCursor(input, sourceHash, offset + pageItems.length)
    : null;

  const notesPageItems = pageItems.filter((entry) => entry.kind === 'notes').map((entry) => entry.item);
  const tracesPageItems = pageItems.filter((entry) => entry.kind === 'traces').map((entry) => entry.item);
  const sectionPage = (items: NotesTraceItem[]) => ({
    items,
    page: { returnedCount: items.length, hasMore, nextCursor },
  });
  const noteIssues = notesProjection?.issues ?? [];
  const traceIssues = tracesProjection?.issues ?? [];
  const combinedIssues = dedupeReadIssues([
    ...noteIssues,
    ...traceIssues,
    ...(!notesResult || !tracesResult
      ? [{ code: 'SOURCE_UNAVAILABLE' as const, retryable: false as const, safeNextAction: 'manual_review' as const }]
      : []),
    ...(hasMore === true || (!sourcesComplete && combinedItems.length === 0)
      ? [{ code: 'PARTIAL_WINDOW' as const, retryable: false as const, safeNextAction: 'manual_review' as const }]
      : []),
  ]);

  const notesData: NotesTracesReadData['notes'] = notesResult === null
    ? {
        state: 'unavailable',
        data: null,
        reasonCode: 'SOURCE_UNAVAILABLE',
        issues: [{ code: 'SOURCE_UNAVAILABLE', retryable: false, safeNextAction: 'manual_review' }],
      }
    : noteIssues.length > 0 || !noteSourceComplete
      ? {
          state: 'partial',
          data: sectionPage(notesPageItems),
          completeness: 'partial',
          issues: noteIssues.length > 0
            ? noteIssues
            : [{ code: 'PARTIAL_WINDOW', retryable: false, safeNextAction: 'manual_review' }],
        }
      : sectionPage(notesPageItems);
  const tracesData: NonNullable<NotesTracesReadData['traces']> = tracesResult === null
    ? tracesUnavailableSection('SOURCE_UNAVAILABLE')
    : traceIssues.length > 0 || !traceSourceComplete
      ? {
          state: 'partial',
          data: sectionPage(tracesPageItems),
          completeness: 'partial',
          issues: traceIssues.length > 0
            ? traceIssues
            : [{ code: 'PARTIAL_WINDOW', retryable: false, safeNextAction: 'manual_review' }],
        }
      : {
          state: 'available',
          data: sectionPage(tracesPageItems),
          completeness: 'complete',
          issues: [],
        };
  const data = filterNotesForAudience({ notes: notesData, traces: tracesData }, input.audience);
  const unavailableSections = [
    ...(notesResult === null ? [{ section: 'notes', reasonCode: 'SOURCE_UNAVAILABLE' as const }] : []),
    ...(tracesResult === null ? [{ section: 'traces', reasonCode: 'SOURCE_UNAVAILABLE' as const }] : []),
  ];
  const receiptHash = stableCursorHash({
    notes: notesResult?.sourceHash ?? null,
    traces: tracesResult?.sourceHash ?? null,
  });
  const complete = sourcesComplete && hasMore === false && combinedIssues.length === 0;
  const status = complete ? 'ok' : notesResult || tracesResult ? 'partial' : 'manual_required';
  return readResultSchema.parse({
    toolId: 'hms_read_notes_traces',
    schemaVersion: 'hms-notes/1',
    status,
    data,
    completeness: complete ? 'complete' : status === 'manual_required' ? 'unknown' : 'partial',
    unavailableSections,
    scopeRef: input.resourceRef,
    evidence: [{
      evidenceRef: context.evidenceRef,
      sourceSystem: 'hms' as const,
      sourceSurface: 'notes-traces',
      requestBranchId: authorization.requestBranchId,
      observedAt: context.observedAt.toISOString(),
      sourceUpdatedAt: null,
      expiresAt: context.expiresAt.toISOString(),
      scopeVerified: notesResult !== null && tracesResult !== null,
      artifactRef: null,
      sourceHash: receiptHash,
    }],
    page: { returnedCount: pageItems.length, hasMore, nextCursor },
    issues: combinedIssues.length > 0
      ? combinedIssues
      : hasMore === true
        ? [{ code: 'PARTIAL_WINDOW' as const, retryable: false, safeNextAction: 'manual_review' as const }]
        : [],
  }) as ReadResult<NotesTracesReadData>;
}

function unsupportedCursorResult(input: {
  authorization: NotesSessionAuthorization;
  resourceRef: string;
  evidenceRef: string;
  observedAt: Date;
  expiresAt: Date;
}): ReadResult<NotesTracesReadData> {
  const observedAt = input.observedAt.toISOString();
  const expiresAt = input.expiresAt.toISOString();
  const issue = {
    code: 'UNSUPPORTED_FORMAT' as const,
    retryable: false,
    safeNextAction: 'manual_review' as const,
  };
  const data = unavailableTracesData({
    notes: {
      state: 'unavailable',
      data: null,
      reasonCode: 'UNSUPPORTED_FORMAT',
      issues: [issue],
    },
  });
  return readResultSchema.parse({
    toolId: 'hms_read_notes_traces',
    schemaVersion: 'hms-notes/1',
    status: 'manual_required',
    data,
    completeness: 'unknown',
    unavailableSections: [{ section: 'notes', reasonCode: 'UNSUPPORTED_FORMAT' }],
    scopeRef: input.resourceRef,
    evidence: [
      {
        evidenceRef: input.evidenceRef,
        sourceSystem: 'hms' as const,
        sourceSurface: 'notes-traces',
        requestBranchId: input.authorization.requestBranchId,
        observedAt,
        sourceUpdatedAt: null,
        expiresAt,
        scopeVerified: true,
        artifactRef: null,
        sourceHash: projectedSourceHash(data),
      },
    ],
    page: { returnedCount: 0, hasMore: false, nextCursor: null },
    issues: [issue],
  }) as ReadResult<NotesTracesReadData>;
}

function notesInquiryUnavailableResult(input: {
  authorization: NotesSessionAuthorization;
  resourceRef: string;
  evidenceRef: string;
  observedAt: Date;
  expiresAt: Date;
  reasonCode: 'SCOPE_DENIED' | 'SOURCE_UNAVAILABLE';
}): ReadResult<NotesTracesReadData> {
  const issue = {
    code: input.reasonCode,
    retryable: false,
    safeNextAction: 'manual_review' as const,
  };
  const data = unavailableTracesData({
    notes: {
      state: 'unavailable',
      data: null,
      reasonCode: input.reasonCode,
      issues: [issue],
    },
  });
  return readResultSchema.parse({
    toolId: 'hms_read_notes_traces',
    schemaVersion: 'hms-notes/1',
    status: 'manual_required',
    data,
    completeness: 'unknown',
    unavailableSections: [{ section: 'notes', reasonCode: input.reasonCode }],
    scopeRef: input.resourceRef,
    evidence: [
      {
        evidenceRef: input.evidenceRef,
        sourceSystem: 'hms' as const,
        sourceSurface: 'notes-inquiry',
        requestBranchId: input.authorization.requestBranchId,
        observedAt: input.observedAt.toISOString(),
        sourceUpdatedAt: null,
        expiresAt: input.expiresAt.toISOString(),
        scopeVerified: input.reasonCode !== 'SCOPE_DENIED',
        artifactRef: null,
        sourceHash: projectedSourceHash(data),
      },
    ],
    page: { returnedCount: 0, hasMore: false, nextCursor: null },
    issues: [issue],
  }) as ReadResult<NotesTracesReadData>;
}

function mapNotesInquiryIssue(code: string) {
  if (code === 'MASKED_NOTE' || code === 'POLICY_UNAPPROVED') {
    return 'POLICY_UNAPPROVED' as const;
  }
  if (code === 'TRUNCATED') return 'TRUNCATED' as const;
  return 'PARTIAL_WINDOW' as const;
}

export async function observeNotesTraces(
  authorization: NotesSessionAuthorization,
  rawInput: NotesTracesReadInput,
  signal: AbortSignal,
  options: LiveNotesTracesReadDriverOptions = {},
): Promise<ReadResult<NotesTracesReadData>> {
  if (signal.aborted) {
    const err = new Error('notes trace observe aborted');
    err.name = 'AbortError';
    throw err;
  }
  assertNotesAuthorization(authorization);
  const input = notesTracesReadInputSchema.parse(rawInput);
  const observedAt = new Date();
  const expiresAt = new Date(observedAt.getTime() + 5 * 60_000);
  const evidenceRef = `notes-${randomUUID()}`;
  const providerBranch = Boolean(options.notesInquiryFor || options.notesTracesFor);
  const parsedExpectedParentBinding = providerBranch
    ? trustedParentBindingSchema.safeParse(options.expectedParentBinding)
    : null;
  const expectedParentBinding = parsedExpectedParentBinding?.success
    ? parsedExpectedParentBinding.data
    : null;
  if (
    providerBranch &&
    (!expectedParentBinding || expectedParentBinding.resourceRef !== input.resourceRef)
  ) {
    return combinedFailureResult({
      authorization,
      resourceRef: input.resourceRef,
      evidenceRef,
      observedAt,
      expiresAt,
      reasonCode: 'SCOPE_DENIED',
    });
  }

  if (options.notesInquiryFor && options.notesTracesFor) {
    return observeCombinedProviders(authorization, input, signal, options, {
      evidenceRef,
      observedAt,
      expiresAt,
      expectedParentBinding: expectedParentBinding!,
    });
  }

  if (input.cursor) {
    return unsupportedCursorResult({
      authorization,
      resourceRef: input.resourceRef,
      evidenceRef,
      observedAt,
      expiresAt,
    });
  }

  let traceResult: NotesTracesReadResult | null = null;
  let traceProviderFailed = false;
  let traceProviderScopeDenied = false;
  if (options.notesTracesFor) {
    try {
      traceResult = await options.notesTracesFor(input, signal);
      if (traceResult) {
        assertExpectedProviderParent(
          traceResult.parentBinding,
          expectedParentBinding!,
          input.resourceRef,
          'TRC',
        );
      }
    } catch (error) {
      if (isProviderScopeError(error)) {
        traceResult = null;
        traceProviderScopeDenied = true;
      } else {
        traceProviderFailed = true;
      }
    }
  }

  if (options.notesInquiryFor) {
    let inquiry: NotesInquiryReadResult | null;
    try {
      inquiry = await options.notesInquiryFor(input, signal);
    } catch (error) {
      if (isProviderScopeError(error)) {
        return notesInquiryUnavailableResult({
          authorization,
          resourceRef: input.resourceRef,
          evidenceRef,
          observedAt,
          expiresAt,
          reasonCode: 'SCOPE_DENIED',
        });
      }
      const traceFallback = tracesOnlyResult({
        authorization,
        resourceRef: input.resourceRef,
        evidenceRef,
        observedAt,
        expiresAt,
        traceResult,
        traceProviderFailed,
        traceProviderScopeDenied,
        states: input.states,
        audience: input.audience,
        limit: input.limit,
      });
      if (traceFallback) return traceFallback;
      return notesInquiryUnavailableResult({
        authorization,
        resourceRef: input.resourceRef,
        evidenceRef,
        observedAt,
        expiresAt,
        reasonCode: 'SOURCE_UNAVAILABLE',
      });
    }
    if (inquiry) {
      let projected;
      try {
        assertExpectedProviderParent(
          inquiry.parentBinding,
          expectedParentBinding!,
          input.resourceRef,
          'notes inquiry',
        );
        projected = projectNotesInquiryResult(inquiry, {
          resourceRef: input.resourceRef,
          evidenceRef,
          observedAt,
          expiresAt,
          audience: input.audience,
          limit: input.limit,
        });
      } catch (error) {
        if (error instanceof NotesInquiryProjectionError || isProviderScopeError(error)) {
          return notesInquiryUnavailableResult({
            authorization,
            resourceRef: input.resourceRef,
            evidenceRef,
            observedAt,
            expiresAt,
            reasonCode: 'SCOPE_DENIED',
          });
        }
        throw error;
      }
      let projectedTraces: ProjectedTraces | null = null;
      if (traceResult) {
        projectedTraces = projectNotesTracesResult(traceResult, input, {
          evidenceRef,
          observedAt,
          expiresAt,
        });
      }
      const traceSection = projectedTraces?.section ??
        (traceProviderFailed ? tracesUnavailableSection('SOURCE_UNAVAILABLE') : undefined);
      const data = unavailableTracesData(projected.data, traceSection);
      const noteSection = data.notes;
      const noteIssues =
        'state' in noteSection && noteSection.state === 'partial'
          ? noteSection.issues
              .map((issue) => mapNotesInquiryIssue(issue.code))
              .filter((code, index, all) => all.indexOf(code) === index)
              .map((code) => ({
                code,
                retryable: false,
                safeNextAction: 'manual_review' as const,
              }))
          : [];
      const unavailableSections = traceSection === undefined
        ? [{ section: 'traces', reasonCode: 'SURFACE_UNPROVEN' as const }]
        : traceSection.state === 'unavailable'
          ? [{ section: 'traces', reasonCode: 'SOURCE_UNAVAILABLE' as const }]
          : [];
      const combinedSourceHash = traceResult
        ? createHash('sha256')
            .update(`${inquiry.sourceHash}|${traceResult.sourceHash}`)
            .digest('hex')
        : inquiry.sourceHash;
      return readResultSchema.parse({
        toolId: 'hms_read_notes_traces',
        schemaVersion: 'hms-notes/1',
        status: 'partial',
        data,
        completeness: 'partial',
        unavailableSections,
        scopeRef: input.resourceRef,
        evidence: [
          {
            evidenceRef,
            sourceSystem: 'hms' as const,
            sourceSurface: traceResult || traceProviderFailed ? 'notes-traces' : 'notes-inquiry',
            requestBranchId: authorization.requestBranchId,
            observedAt: observedAt.toISOString(),
            sourceUpdatedAt: null,
            expiresAt: expiresAt.toISOString(),
            scopeVerified: true,
            artifactRef: null,
            sourceHash: combinedSourceHash,
          },
        ],
        page: pageForNotes(data),
        issues: [
          ...noteIssues,
          ...(projectedTraces?.issues ?? []),
          {
            code: 'PARTIAL_WINDOW',
            retryable: false,
            safeNextAction: 'manual_review' as const,
          },
        ],
      }) as ReadResult<NotesTracesReadData>;
    }
  }

  const traceResultOnly = tracesOnlyResult({
    authorization,
    resourceRef: input.resourceRef,
    evidenceRef,
    observedAt,
    expiresAt,
    traceResult,
    traceProviderFailed,
    traceProviderScopeDenied,
    states: input.states,
    audience: input.audience,
    limit: input.limit,
  });
  if (traceResultOnly) return traceResultOnly;

  const dump = options.detailDumpFor ? await options.detailDumpFor(input, signal) : null;
  if (dump) {
    const projected = projectNotesFromDetailDump(dump, {
      resourceRef: input.resourceRef,
      evidenceRef,
      observedAt,
      expiresAt,
      limit: input.limit,
    });
    const data = filterNotesForAudience(
      unavailableTracesData(projected.data),
      input.audience,
    );
    const notesAvailable =
      !('state' in data.notes) || data.notes.state !== 'unavailable';
    if (notesAvailable) {
      const noteIssues =
        'state' in data.notes && data.notes.state === 'partial' ? data.notes.issues : [];
      return readResultSchema.parse({
        toolId: 'hms_read_notes_traces',
        schemaVersion: 'hms-notes/1',
        status: 'partial',
        data,
        completeness: 'partial',
        unavailableSections: [
          { section: 'traces', reasonCode: projected.tracesReasonCode },
        ],
        scopeRef: input.resourceRef,
        evidence: [
          {
            evidenceRef,
            sourceSystem: 'hms' as const,
            sourceSurface: 'guest-stay-detail-notes',
            requestBranchId: authorization.requestBranchId,
            observedAt: observedAt.toISOString(),
            sourceUpdatedAt: null,
            expiresAt: expiresAt.toISOString(),
            scopeVerified: true,
            artifactRef: null,
            sourceHash: projectedSourceHash(data),
          },
        ],
        page: pageForNotes(data),
        issues: [
          ...noteIssues,
          {
            code: 'PARTIAL_WINDOW',
            retryable: false,
            safeNextAction: 'manual_review',
          },
        ],
      }) as ReadResult<NotesTracesReadData>;
    }

    const noteReason = projected.notesReasonCode;
    const unavailableData = filterNotesForAudience(
      unavailableTracesData(projected.data),
      input.audience,
    );
    return readResultSchema.parse({
      toolId: 'hms_read_notes_traces',
      schemaVersion: 'hms-notes/1',
      status: 'manual_required',
      data: unavailableData,
      completeness: 'unknown',
      unavailableSections: [
        { section: 'notes', reasonCode: noteReason },
      ],
      scopeRef: input.resourceRef,
      evidence: [
        {
          evidenceRef,
          sourceSystem: 'hms' as const,
          sourceSurface: 'guest-stay-detail-notes',
          requestBranchId: authorization.requestBranchId,
          observedAt: observedAt.toISOString(),
          sourceUpdatedAt: null,
          expiresAt: expiresAt.toISOString(),
          scopeVerified: true,
          artifactRef: null,
          sourceHash: projectedSourceHash(unavailableData),
        },
      ],
      page: { returnedCount: 0, hasMore: false, nextCursor: null },
      issues: [
        {
          code: noteReason,
          retryable: false,
          safeNextAction: 'manual_review',
        },
      ],
    }) as ReadResult<NotesTracesReadData>;
  }

  const data = {
    notes: {
      state: 'unavailable' as const,
      data: null,
      reasonCode: 'SOURCE_UNAVAILABLE' as const,
      issues: [
        {
          code: 'SOURCE_UNAVAILABLE',
          retryable: false,
          safeNextAction: 'manual_review' as const,
        },
      ],
    },
  } satisfies NotesTracesReadData;
  const dataWithTraces = filterNotesForAudience(
    unavailableTracesData(data),
    input.audience,
  );
  return readResultSchema.parse({
    toolId: 'hms_read_notes_traces',
    schemaVersion: 'hms-notes/1',
    status: 'manual_required',
    data: dataWithTraces,
    completeness: 'unknown',
    unavailableSections: [{ section: 'notes', reasonCode: 'SOURCE_UNAVAILABLE' }],
    scopeRef: input.resourceRef,
    evidence: [
      {
        evidenceRef,
        sourceSystem: 'hms' as const,
        sourceSurface: 'notes-traces',
        requestBranchId: authorization.requestBranchId,
        observedAt: observedAt.toISOString(),
        sourceUpdatedAt: null,
        expiresAt: expiresAt.toISOString(),
        scopeVerified: true,
        artifactRef: null,
        sourceHash: createHash('sha256').update(NOTES_TRACES_READ_SURFACE_BLOCKER).digest('hex'),
      },
    ],
    page: { returnedCount: 0, hasMore: false, nextCursor: null },
    issues: [
      {
        code: 'SOURCE_UNAVAILABLE',
        retryable: false,
        safeNextAction: 'manual_review',
      },
    ],
  }) as ReadResult<NotesTracesReadData>;
}

export function createLiveNotesTracesReadDriver(
  options: LiveNotesTracesReadDriverOptions = {},
): {
  observeNotesTraces: (
    authorization: NotesSessionAuthorization,
    rawInput: NotesTracesReadInput,
    signal: AbortSignal,
  ) => Promise<ReadResult<NotesTracesReadData>>;
} {
  return {
    observeNotesTraces: (authorization, rawInput, signal) =>
      observeNotesTraces(authorization, rawInput, signal, options),
  };
}
