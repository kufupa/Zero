import { reservationWorkflowV2DraftSchema, type ReservationWorkflowV2Draft, type ReservationWorkflowV2Source } from '../../../server-pilot/src/ai/reservation-workflow-v2-contract.js';
import type { RowChange } from './views';
import { inMailbox } from '@/lib/mail/mail-cache-scope';
import {
  paneSurfaceForFailureEvent,
  reservationActionIdForInput,
  type PaneFailureEvent,
} from './failure-reporting-link';
import { NAVA_FAILURE_REPORT_CONTEXT_KEY } from '../workstation/mutations-in-flight';
import type {
  ReservationCommandContext,
  ReservationGuestProfileOptionField,
  ReservationServiceInput,
  ReservationEditCommand,
  ReservationPaneSnapshot,
  ReservationPreparationView,
  ReservationRequestProjection,
  ReservationReviewCommand,
  ReservationSourceContext,
  ReservationWorkflowClient,
  ReservationWorkflowV2Session,
} from './types';
import { ReservationWorkflowStaleRevisionError } from './types';

type ItemInput = {
  workItemId: string;
  source: ReservationWorkflowV2Source;
  expectedRevision: number;
  expectedSeq: number;
};
type StateResult = { status: string; draft?: unknown; revision?: number; revisionHead?: number; seq?: number; preparationViews?: unknown };
type MailboxCallOptions = { context: { activeTransportId: string; navaBackgroundPoll?: true; navaFailureReport?: true } };
type QueryProcedure<I> = { query(input: I, options?: MailboxCallOptions): Promise<unknown> };
type MutationProcedure<I> = { mutate(input: I, options?: MailboxCallOptions): Promise<unknown> };
type RecordActionsMutation = {
  mutate(input: { workItemId: string; events: PaneFailureEvent[] }, options?: MailboxCallOptions): Promise<unknown>;
};

/** Narrow structural type for the published v2 router; no legacy quote/session DTOs cross this boundary. */
export type ReservationWorkflowV2TrpcClient = {
  workItems?: { recordActions?: RecordActionsMutation };
  reservationWorkflowV2: {
    ensure: MutationProcedure<{ internetMessageId?: string | null; source: ReservationWorkflowV2Source; mode?: 'initialize' | 'prefill' }>;
    prefill: MutationProcedure<ItemInput>;
    addAction: MutationProcedure<ItemInput & { kind: 'create' | 'quote' | 'amend' | 'cancel' | 'services' | 'filing' }>;
    changeRows: MutationProcedure<ItemInput & RowChange>;
    selectNative: MutationProcedure<ItemInput & { requestId: string; fieldPath: string; observationRef: string }>;
    verifyNativeLead: MutationProcedure<ItemInput & { requestId: string; fieldPath: string; observationRef: string }>;
    reviewScope: MutationProcedure<ItemInput & { requestId: string; scope: 'request' | 'allocations' | 'targets' | 'services' | 'documents'; ids: string[] }>;
    get: QueryProcedure<ItemInput>;
    reconcileSource: MutationProcedure<ItemInput & { confirmed: true }>;
    edit: MutationProcedure<ItemInput & { fieldPath: string; value: { state: 'set' | 'none' | 'unknown' | 'inherit' | 'clear'; value?: unknown; updatedAt: string } }>;
    review: MutationProcedure<ItemInput & { fieldPath: string; decision: 'accepted' | 'flagged'; note?: string | null }>;
    undo: MutationProcedure<ItemInput>;
    redo: MutationProcedure<ItemInput>;
    lookup: MutationProcedure<ItemInput & { requestId?: string; nativeFieldPath?: string }>;
    guestProfileOptions: MutationProcedure<ItemInput & { requestId: string; allocationId: string; field: ReservationGuestProfileOptionField }>;
    prepareGuestProfile: MutationProcedure<ItemInput & { requestId: string; allocationId: string; confirmDuplicateName?: boolean }>;
    createGuestProfile: MutationProcedure<ItemInput & { requestId: string; allocationId: string; confirmDuplicateName?: boolean;
      go: true; prepareRef: string; idempotencyKey: string }>;
    prepare: MutationProcedure<ItemInput & { requestId: string; allocationId?: string }>;
    execute: MutationProcedure<ItemInput & { requestId: string; allocationId?: string; go: true; idempotencyKey: string }>;
    reconcile: MutationProcedure<ItemInput & { operationId: string }>;
    configureFiling: MutationProcedure<ItemInput & { requestId: string; attachmentId: string; confirmation?: string; allocationTarget?: { requestId: string; allocationId: string };
      kind: 'voucher' | 'payment_proof' }>;
    lookupServices: MutationProcedure<ItemInput & ReservationServiceInput & { requestId: string; serviceId?: string }>;
    prepareServices: MutationProcedure<ItemInput & ReservationServiceInput & { requestId: string; serviceId?: string }>;
    executeServices: MutationProcedure<ItemInput & ReservationServiceInput & { requestId: string; serviceId: string; go: true;
      idempotencyKey: string; reviewedPrepareRef?: string }>;
    reconcileServices: MutationProcedure<ItemInput & { operationId: string }>;
  };
};

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';

function apiSource(source: ReservationSourceContext): ReservationWorkflowV2Source {
  if (!source.threadId || !source.messageId || !source.sourceHash || !source.arrivedAt) {
    throw new Error('The selected email is not resolved to a source-bound Nava message yet.');
  }
  return { threadId: source.threadId, messageId: source.messageId, sourceHash: source.sourceHash, arrivedAt: source.arrivedAt };
}

function itemInput(context: ReservationCommandContext): ItemInput {
  const { draft } = context.snapshot.session;
  return {
    workItemId: draft.workItemId,
    source: apiSource(context.source),
    expectedRevision: context.snapshot.session.revision,
    expectedSeq: context.snapshot.session.seq,
  };
}

function mailboxOptions(source: ReservationSourceContext, backgroundPoll = false): MailboxCallOptions {
  const options = inMailbox(source.mailboxId);
  if (!options) throw new Error('The selected Nava mailbox is unavailable; reopen this email before continuing.');
  return backgroundPoll
    ? { context: { ...options.context, navaBackgroundPoll: true } }
    : options;
}

function errorFor(result: StateResult): Error {
  const detail = result.status.replaceAll('_', ' ');
  const messages: Record<string, string> = {
    invalid_source: 'The selected email changed. Reopen the email before editing this draft.',
    wrong_property: 'This email is not admitted for the connected property.',
    stale_revision: 'The draft changed elsewhere. Reopen this email to load the latest saved values.',
    invalid_path: 'This field is not editable in the reservation draft yet.',
    invalid_value: 'The value was not accepted by the reservation service.',
    history_stale: 'History changed. Reload the current reservation draft.',
    at_boundary: 'There is no further edit to move through.',
    not_found: 'The source-bound reservation draft is no longer available.',
    invalid_state: 'The saved reservation draft is not readable by this version.',
  };
  return new Error(messages[result.status] ?? `Reservation service: ${detail}.`);
}

const RECOGNIZED_NON_OK_RESPONSE_STATUSES = new Set([
  'not_found', 'invalid_source', 'wrong_property', 'invalid_state', 'stale_revision', 'invalid_path', 'invalid_value', 'skipped',
]);

function isResponseContractFailure(value: unknown): boolean {
  if (!isRecord(value) || typeof value.status !== 'string') return true;
  return !RECOGNIZED_NON_OK_RESPONSE_STATUSES.has(value.status);
}

function decodeDraft(result: unknown): ReservationWorkflowV2Session {
  if (!isRecord(result) || result.status !== 'ok' || !isRecord(result.draft)) throw errorFor((isRecord(result) ? result : { status: 'invalid_state' }) as StateResult);
  const parsedDraft = reservationWorkflowV2DraftSchema.safeParse(result.draft);
  if (!parsedDraft.success) throw new Error('The reservation service returned a draft that does not match the v2 wire contract.');
  const draft = parsedDraft.data;
  const proposal = isRecord(draft.proposal) ? draft.proposal : null;
  const content = proposal && isRecord(proposal.content) ? proposal.content : null;
  if (draft.contractVersion !== 2 || !isString(draft.workItemId) || !isRecord(draft.source)
      || !isString(draft.source.messageId) || !isString(draft.source.threadId) || !isString(draft.source.sourceHash)
      || !isString(draft.source.arrivedAt) || !Array.isArray(draft.observations)
      || !Array.isArray(content?.requests) || !Array.isArray(content?.services) || !Array.isArray(content?.documents)) {
    throw new Error('The reservation service returned a draft with an unsupported v2 shape.');
  }
  const revision = typeof result.revision === 'number' ? result.revision : typeof draft.revision === 'number' ? draft.revision : null;
  const revisionHead = typeof result.revisionHead === 'number' ? result.revisionHead : revision;
  const seq = typeof result.seq === 'number' ? result.seq : null;
  if (revision === null || revisionHead === null || seq === null) {
    throw new Error('The reservation service did not return a revision and sequence for this draft.');
  }
  const preparationViews: ReservationPreparationView[] = Array.isArray(result.preparationViews)
    ? result.preparationViews.flatMap((value): ReservationPreparationView[] => {
      if (!isRecord(value) || !isString(value.requestId) || !isString(value.allocationId) || typeof value.current !== 'boolean') return [];
      const price = isRecord(value.price) ? value.price : undefined;
      return [{ requestId: value.requestId, allocationId: value.allocationId, current: value.current,
        ...(isString(value.issue) ? { issue: value.issue } : {}),
        fields: Array.isArray(value.fields) ? value.fields.filter(isString) : [],
        details: Array.isArray(value.details) ? value.details.flatMap(item => isRecord(item) && isString(item.path) && isString(item.code) ? [{ path: item.path, code: item.code, ...(typeof item.expected === 'number' ? { expected: item.expected } : {}), ...(typeof item.actual === 'number' ? { actual: item.actual } : {}) }] : []) : [],
        ...(price ? { price } : {}),
        ...(isRecord(value.priceComparison) ? { priceComparison: value.priceComparison } : {}),
        ...(isString(value.observedAt) ? { observedAt: value.observedAt } : {}) }];
    }) : [];
  return { draft: draft as unknown as ReservationWorkflowV2Draft, revision, revisionHead, seq, preparationViews,
    ...(result.sourceChanged === true ? { sourceChanged: true } : {}) };
}

function pointerPart(value: string | number): string {
  // Keep the server's RFC6901-style path segments (URI escaped stable IDs).
  return encodeURIComponent(String(value));
}

function pointer(...parts: Array<string | number>): string {
  return `/${parts.map(pointerPart).join('/')}`;
}

function wireValueAtPath(draft: ReservationWorkflowV2Draft, path: string): unknown {
  const parts = path.split('/').slice(1).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  let value: unknown = draft;
  for (const part of parts) {
    if (Array.isArray(value)) {
      const index = Number(part);
      value = Number.isInteger(index) && index >= 0 && String(index) === part
        ? value[index] : value.find((item) => isRecord(item) && item.id === part);
    } else if (isRecord(value)) value = value[part];
    else return undefined;
  }
  return value;
}

const reviewedAggregateArrays = new Set(['childAges', 'roomCodes', 'artifacts', 'guestNames']);
const nonReviewMetadata = new Set(['requestText', 'title', 'dateSectionId', 'requestedRooms', 'unassignedGuestNames',
  'requestedTotals', 'scope', 'profileIntent', 'candidateRefs', 'suggestedRef', 'sourceRefs', 'serviceRefs', 'documentRefs', 'targetRefs',
  'priceObservationRefs', 'lookupResultRefs', 'evidenceRefs', 'ownerRequestId', 'uploadArtifactRef', 'id', 'kind']);
const nonReviewSubtrees = new Set(['requestedTotals', 'unassignedGuestNames']);
const partyFieldNames = new Set(['bookingAgency', 'organization', 'arAccount']);

function isFilingDocumentKindPath(path: string): boolean {
  const parts = path.split('/').slice(1).map((part) => {
    try { return decodeURIComponent(part); } catch { return ''; }
  });
  return parts[0] === 'proposal' && parts[1] === 'content' && parts[2] === 'documents'
    && parts.length === 5 && parts[4] === 'kind';
}

function isFilingTargetSelectionPath(draft: ReservationWorkflowV2Draft, path: string): boolean {
  const parts = path.split('/').slice(1).map((part) => {
    try { return decodeURIComponent(part); } catch { return ''; }
  });
  if (parts[0] !== 'proposal' || parts[1] !== 'content' || parts[2] !== 'requests' || parts.length !== 9
      || parts[4] !== 'body' || parts[5] !== 'targets' || parts[6] !== 'include' || parts[8] !== 'suggestedRef') return false;
  const request = draft.proposal.content.requests.find((entry) => entry.id === parts[3] && entry.kind === 'filing');
  if (request?.kind !== 'filing') return false;
  const targetsPath = pointer('proposal', 'content', 'requests', request.id, 'body', 'targets');
  const rawTargets = effectiveValue(wireValueAtPath(draft, targetsPath), draft.fieldOverrides[targetsPath]);
  return Boolean(isRecord(rawTargets) && rawTargets.mode === 'explicit' && Array.isArray(rawTargets.include)
    && rawTargets.include.some((hint) => isRecord(hint) && hint.id === parts[7]));
}

function shouldReviewPath(draft: ReservationWorkflowV2Draft, path: string, value: unknown): boolean {
  const parts = path.split('/').slice(1).map((part) => {
    try { return decodeURIComponent(part); } catch { return ''; }
  });
  const leaf = parts.at(-1) ?? '';
  for (let length = parts.length - 1; length > 0; length -= 1) {
    const override = draft.fieldOverrides[`/${parts.slice(0, length).map(encodeURIComponent).join('/')}`];
    if (override && ['none', 'clear', 'unknown'].includes(override.state)) return false;
  }
  if (leaf === 'name' && parts[2] === 'requests' && parts[4] === 'body' && parts[5] === 'parties'
      && ['bookingAgency', 'organization'].includes(parts[6] ?? '')) {
    const request = draft.proposal.content.requests.find((item, index) => item.id === parts[3] || String(index) === parts[3]);
    if (request?.kind === 'quote') return true;
  }
  const documentKind = isFilingDocumentKindPath(path);
  const filingTarget = isFilingTargetSelectionPath(draft, path);
  if (nonReviewMetadata.has(leaf) && !(documentKind || (leaf === 'suggestedRef' && filingTarget))
      || parts.some((part) => nonReviewSubtrees.has(part))) return false;
  if (parts.length > 1 && Array.isArray(wireValueAtPath(draft, `/${parts.slice(0, -1).map(encodeURIComponent).join('/')}`))) return false;
  if (Array.isArray(value)) return reviewedAggregateArrays.has(leaf);
  if (isRecord(value) && Array.isArray(value.candidateRefs)) return partyFieldNames.has(leaf);

  // Candidate-bearing values are human review units themselves (payer/organization
  // selections), but their display-only source members are not separate inputs.
  for (let length = parts.length - 1; length >= 0; length -= 1) {
    const ancestorPath = `/${parts.slice(0, length).map(encodeURIComponent).join('/')}`;
    const ancestor = wireValueAtPath(draft, ancestorPath);
    if (!isRecord(ancestor) || !Array.isArray(ancestor.candidateRefs)) continue;
    const composite = parts[length - 1] ?? '';
    if (leaf === 'nativeSelectionRef') return true;
    if (length === parts.length && partyFieldNames.has(composite)) return true;
    if (composite === 'guest' && ['firstName', 'lastName'].includes(leaf)) return true;
    return false;
  }
  return value === null || typeof value !== 'object';
}

function isQuoteBookingIntentPath(draft: ReservationWorkflowV2Draft, path: string): boolean {
  const parts = path.split('/').slice(1).map((part) => {
    try { return decodeURIComponent(part); } catch { return ''; }
  });
  if (parts.length !== 6 || parts[0] !== 'proposal' || parts[1] !== 'content' || parts[2] !== 'requests'
      || parts[4] !== 'body' || parts[5] !== 'provisionalBookingRequested') return false;
  return draft.proposal.content.requests.some((request) => request.id === parts[3] && request.kind === 'quote');
}

function requiredForPath(draft: ReservationWorkflowV2Draft, path: string, value: unknown): boolean {
  // Quote execution always requires a staff decision on this intent, regardless
  // of the model's field-review hint. Keep it reviewable even when unchanged.
  if (isQuoteBookingIntentPath(draft, path)) return true;
  if (!shouldReviewPath(draft, path, value)) return false;
  return draft.fieldReviewRequirements[path]?.required !== false;
}

function effectiveValue(base: unknown, override: unknown): unknown {
  if (!isRecord(override) || !isString(override.state)) return base;
  if (override.state === 'set') return override.value;
  if (override.state === 'none' || override.state === 'clear' || override.state === 'unknown') return null;
  return base;
}

function flattenFields(value: unknown, path: string, out: ReservationPaneSnapshot['fields'], draft: ReservationWorkflowV2Draft): void {
  if (Array.isArray(value)) {
    const override = draft.fieldOverrides[path];
    const annotation = draft.proposal.annotations.find((entry) => entry.path === path);
    const review = draft.staffReviews[path];
    out[path] = { path, value: effectiveValue(value, override), ...(override ? { override } : {}),
      required: requiredForPath(draft, path, value), review: review?.status ?? 'pending',
      provenance: override?.state === 'set' ? 'manual' : annotation?.basis ?? 'unknown',
      evidenceRefs: annotation?.evidenceRefs ?? [] };
    value.forEach((item, index) => flattenFields(item, `${path}/${index}`, out, draft));
    return;
  }
  if (isRecord(value) && (value.kind === 'none' || Array.isArray(value.candidateRefs))) {
    const override = draft.fieldOverrides[path];
    const annotation = draft.proposal.annotations.find((entry) => entry.path === path);
    const claim = draft.proposal.sourceClaims.find((entry) => entry.path === path);
    const review = draft.staffReviews[path];
    out[path] = {
      path, value: effectiveValue(value, override), ...(override ? { override } : {}),
      required: requiredForPath(draft, path, value), review: review?.status ?? 'pending',
      provenance: override?.state === 'set' ? 'manual' : annotation?.basis ?? (claim ? 'source' : 'unknown'),
      evidenceRefs: annotation?.evidenceRefs ?? claim?.sourceRefs ?? [],
      ...(review?.status === 'flagged' && review.note ? { issue: review.note } : {}),
    };
    if (value.kind !== 'none') {
      for (const [key, child] of Object.entries(value)) {
        const childPath = `${path}/${pointerPart(key)}`;
        if (['id', 'kind', 'sourceRefs', 'candidateRefs', 'suggestedRef', 'serviceRefs', 'documentRefs',
          'priceObservationRefs', 'lookupResultRefs', 'evidenceRefs'].includes(key)) {
          if (key === 'suggestedRef' && isFilingTargetSelectionPath(draft, childPath)) flattenFields(child, childPath, out, draft);
          continue;
        }
        flattenFields(child, childPath, out, draft);
      }
    }
    return;
  }
  if (isRecord(value) && value.kind !== 'none') {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}/${pointerPart(key)}`;
      if (['id', 'kind', 'sourceRefs', 'candidateRefs', 'serviceRefs', 'documentRefs', 'priceObservationRefs', 'lookupResultRefs', 'evidenceRefs'].includes(key)) {
        if (key === 'kind' && isFilingDocumentKindPath(childPath)) flattenFields(child, childPath, out, draft);
        continue;
      }
      flattenFields(child, childPath, out, draft);
    }
    return;
  }
  const pathSegments = path.split('/').slice(1).map((part) => {
    try { return decodeURIComponent(part); } catch { return ''; }
  });
  if (pathSegments.some((segment) => ['id', 'sourceRefs', 'candidateRefs'].includes(segment))
      || pathSegments.includes('kind') && !isFilingDocumentKindPath(path)) return;
  const override = draft.fieldOverrides[path];
  const annotation = draft.proposal.annotations.find((entry) => entry.path === path);
  const claim = draft.proposal.sourceClaims.find((entry) => entry.path === path);
  const review = draft.staffReviews[path];
  out[path] = {
    path,
    value: effectiveValue(value, override),
    ...(override ? { override } : {}),
    required: requiredForPath(draft, path, value),
    review: review?.status ?? 'pending',
    provenance: override?.state === 'set' ? 'manual' : annotation?.basis ?? (claim ? 'source' : 'unknown'),
    evidenceRefs: annotation?.evidenceRefs ?? claim?.sourceRefs ?? [],
    ...(review?.status === 'flagged' && review.note ? { issue: review.note } : {}),
  };
}

export function projectReservationSession(session: ReservationWorkflowV2Session): ReservationPaneSnapshot {
  const { draft } = session;
  const fields: ReservationPaneSnapshot['fields'] = {};
  const requests: ReservationRequestProjection[] = [];
  for (const request of draft.proposal.content.requests) {
    const root = pointer('proposal', 'content', 'requests', request.id);
    flattenFields(request, root, fields, draft);
    requests.push({ id: request.id, kind: request.kind, text: request.requestText,
      fieldPaths: Object.keys(fields).filter((path) => path.startsWith(`${root}/`)),
      supported: (request.kind === 'create' || request.kind === 'quote' || request.kind === 'amend'
        || request.kind === 'cancel' || request.kind === 'filing' || request.kind === 'services') && draft.propertyCode === 'HRCEN' });
  }
  for (const [index, row] of draft.proposal.content.services.entries()) {
    flattenFields(row, pointer('proposal', 'content', 'services', index), fields, draft);
  }
  for (const row of draft.proposal.content.documents) flattenFields(row, pointer('proposal', 'content', 'documents', row.id), fields, draft);
  for (const path of new Set([...Object.keys(draft.fieldOverrides), ...Object.keys(draft.fieldReviewRequirements)])) {
    if (fields[path]) continue;
    const override = draft.fieldOverrides[path];
    const review = draft.staffReviews[path];
    const annotation = draft.proposal.annotations.find((entry) => entry.path === path);
    const claim = draft.proposal.sourceClaims.find((entry) => entry.path === path);
    fields[path] = { path, value: effectiveValue(wireValueAtPath(draft, path), override), ...(override ? { override } : {}),
      required: requiredForPath(draft, path, wireValueAtPath(draft, path)), review: review?.status ?? 'pending',
      provenance: override?.state === 'set' ? 'manual' : annotation?.basis ?? (claim ? 'source' : 'unknown'),
      evidenceRefs: annotation?.evidenceRefs ?? claim?.sourceRefs ?? [],
      ...(review?.status === 'flagged' && review.note ? { issue: review.note } : {}) };
  }
  for (const request of requests) request.fieldPaths = Object.keys(fields).filter((path) =>
    path.startsWith(`${pointer('proposal', 'content', 'requests', request.id)}/`));
  const runtimeDraft = draft as unknown as { operationResults?: unknown; errors?: Array<{ stage: string; code: string; message: string }> };
  const operationResults = Array.isArray(runtimeDraft.operationResults)
    ? runtimeDraft.operationResults.filter(isRecord).map((result) => {
      const refs = Array.isArray(result.observationRefs) ? result.observationRefs.filter(isString) : [];
      const linked = refs.flatMap((ref) => {
        const observation = draft.observations.find((entry) => entry.ref === ref);
        const criteria = isRecord(observation?.criteria) ? observation.criteria : null;
        const observedResult = isRecord(observation?.result) ? observation.result : null;
        const nativeReadback = isRecord(observedResult?.nativeReadback) ? observedResult.nativeReadback : null;
        const confirmation = isString(observedResult?.confirmation) ? observedResult.confirmation
          : isString(nativeReadback?.confirmation) ? nativeReadback.confirmation : null;
        if (!observation || !criteria || !observedResult || observation.generationId !== result.generationId
            || criteria.workflow !== result.workflow || criteria.requestId !== result.requestId
            || result.allocationId != null && criteria.allocationId !== result.allocationId
              && criteria.hintId !== result.allocationId
            || !confirmation) return [];
        return [{ ref, confirmation }];
      });
      const receipt = linked.at(-1);
      const guestReceipt = result.workflow === 'guest_profile' ? refs.flatMap((ref) => {
        const observation = draft.observations.find((entry) => entry.ref === ref);
        if (!observation || result.status !== 'succeeded' || observation.kind !== 'guest_candidate'
            || observation.status !== 'complete' || !observation.coverage.complete
            || observation.generationId !== result.generationId || observation.propertyCode !== draft.propertyCode
            || observation.sourceMessageId !== draft.source.messageId || observation.criteria.workflow !== 'guest_profile_create'
            || observation.criteria.attemptId !== result.id || observation.criteria.requestId !== result.requestId
            || observation.criteria.allocationId !== result.allocationId) return [];
        const observed = observation.result;
        if (observed.outcome !== 'created') return [];
        const candidate = Array.isArray(observed.candidates) && isRecord(observed.candidates[0]) ? observed.candidates[0] : null;
        const nativeId = isString(candidate?.nativeId) ? candidate.nativeId : null;
        return nativeId ? [{ ref, nativeId }] : [];
      }).at(-1) : undefined;
      return { ...result, ...(receipt ? { confirmation: receipt.confirmation, confirmationObservationRef: receipt.ref } : {}),
        ...(guestReceipt ? { nativeId: guestReceipt.nativeId, nativeIdObservationRef: guestReceipt.ref } : {}) };
    }) : [];
  const createRequests = draft.proposal.content.requests.filter((request) => request.kind === 'create');
  const allocations = createRequests.flatMap((request) => {
    const path = pointer('proposal', 'content', 'requests', request.id, 'body', 'allocations');
    const effective = fields[path]?.value;
    const rows = Array.isArray(effective) ? effective : request.body.allocations;
    return rows.flatMap((value) => isRecord(value) && isString(value.id) ? [{ requestId: request.id, allocationId: value.id }] : []);
  });
  const preparationViews = session.preparationViews;
  const currentPrepared = allocations.length > 0 && allocations.every(({ requestId, allocationId }) =>
    preparationViews.some((view) => view.requestId === requestId && view.allocationId === allocationId && view.current));
  const apiErrors = (runtimeDraft.errors ?? []).map((entry) => ({ kind: entry.code, explanation: entry.message, evidenceRefs: [] }));
  return {
    session,
    sourceMessageId: draft.source.messageId,
    requests,
    fields,
    issues: [...draft.proposal.issues.map((issue) => ({ path: issue.path, kind: issue.kind, explanation: issue.explanation, evidenceRefs: issue.evidenceRefs })), ...apiErrors,
      ...(session.sourceChanged ? [{ kind: 'source_changed', explanation: 'The email or its attachments changed. Your saved work is intact; review the new evidence before native work.', evidenceRefs: [] }] : [])],
    operationResults,
    preparationViews,
    preparation: {
      state: currentPrepared ? 'current' : allocations.length ? 'stale' : 'idle',
      message: currentPrepared ? 'Native unsaved form, price and availability are current.'
        : allocations.length ? 'Native price and availability are not confirmed current for every room.' : 'No Create reservation is available to prepare.',
    },
  };
}

function okResult(result: unknown): RecordValue {
  if (!isRecord(result) || result.status !== 'ok' && result.status !== 'prepared' && result.status !== 'succeeded'
      && result.status !== 'already_succeeded' && result.status !== 'reconciled') {
    throw errorFor((isRecord(result) ? result : { status: 'invalid_state' }) as StateResult);
  }
  return result;
}

/** Translate compiler pointers into the business fields staff can correct. */
export function inputFieldLabel(value: string): string {
  const key = value.split(':')[0]!.split('/').at(-1) ?? value;
  const labels: Record<string, string> = {
    scope: 'occupancy per room', known_child_count: 'number of children and their ages',
    childCount: 'number of children', childAges: 'children’s ages', adults: 'adults per room',
    agency_selection_required: 'select the Infor agency', company_selection_required: 'select the Infor Organization',
    arrival: 'arrival date', departure: 'departure date', quantity: 'quantity', roomCodes: 'room type',
    roomType: 'room type', ratePlan: 'rate plan', mealPlan: 'meal plan', guaranteeType: 'guarantee',
    sourceOfBusiness: 'source of business', firstName: 'guest first name', lastName: 'guest last name',
    guestOptIn: 'guest opt-in', unitPrice: 'unit price', currency: 'currency', requestedRooms: 'number of rooms',
    requestedTotals: 'requested occupancy totals', nativeSelectionRef: 'confirmed Infor selection',
    staffAllowanceType: 'extra charge handling', cmsRecipient: 'confirmation recipient',
    cmsMessageId: 'confirmation message', targets: 'exact stays',
    artifacts: 'quote outputs', provisionalBookingRequested: 'quote-only choice',
  };
  const suffix = value.split(':').slice(1).join(':');
  if (labels[key]) return labels[key]!;
  if (suffix && labels[suffix]) return labels[suffix]!;
  const plain = key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
  return /^\d+$/.test(plain) ? 'requested details' : plain;
}
function inputFieldLabels(values: unknown): string {
  return Array.isArray(values) ? [...new Set(values.filter(isString).map(inputFieldLabel))].join(', ') : '';
}

function operationNotice(result: unknown, success: string[]): string | undefined {
  if (!isRecord(result)) return 'The reservation service returned an unreadable native-tool result.';
  if (success.includes(String(result.status))) return undefined;
  const status = isString(result.status) ? result.status.replaceAll('_', ' ') : 'unknown outcome';
  const issue = nativeIssueText(result.issue);
  const fields = inputFieldLabels(result.fields);
  const totals = Array.isArray(result.details) ? result.details.flatMap(item => isRecord(item) && typeof item.expected === 'number' ? [`${inputFieldLabel(String(item.path))}: requested ${item.expected}${typeof item.actual === 'number' ? `, allocated ${item.actual}` : ', complete the room allocations'}`] : []).join('; ') : '';
  return `${issue ? `Infor check: ${status} — ${issue}.` : `Infor check: ${status}.`}${fields ? ` Review: ${fields}.` : ''}${totals ? ` ${totals}.` : ''}`;
}

function nativeIssueText(issue: unknown): string | null {
  if (!isString(issue)) return null;
  if (issue === 'create_input_incomplete' || issue === 'native_create_input_incomplete') {
    return 'Complete the missing booking details and select any unresolved Infor matches before checking the booking';
  }
  const dependencyMessages: Record<string, string> = {
    create_dependency_waiting: 'Save the linked room in Create first; Filing will then find its exact confirmation',
    create_dependency_dispatch_receipt_missing: 'The Create confirmation could not be verified. Check the Create result before filing',
    create_dependency_save_proof_invalid: 'The saved Create result needs verification. Check its uncertain result before filing',
    create_dependency_target_invalid: 'Select the intended Create room again',
    create_dependency_failed: 'The linked room was not created. Resolve Create first',
    create_dependency_uncertain: 'Check the uncertain Create result before filing; do not create it again',
  };
  if (dependencyMessages[issue]) return dependencyMessages[issue]!;
  if (issue.startsWith('create_dependency_')) return 'The linked Create result needs verification. Check Create before filing';
  if (issue === 'select_one_document') return 'Choose one PDF from this email to file';
  if (issue === 'source_pdf_not_admitted') return 'Choose an available, supported PDF from this email';
  if (issue === 'select_one_saved_stay') return 'Choose one exact saved stay for this PDF';
  if (issue === 'review_one_source_pdf_and_one_saved_stay') return 'Review and select one source PDF and one exact saved stay before filing';
  if (issue === 'filing_preview_requires_staff_document_review') return 'Review the PDF and its filing details before continuing';
  if (issue === 'filing_stay_lookup_failed') return 'Infor could not complete the stay search. Try Find stay again; contact support if it remains blocked';
  if (issue === 'filing_stay_not_found') return 'Infor did not find this confirmation. Check the confirmation and search again';
  if (issue === 'filing_stay_date_mismatch') return 'Infor returned a different arrival date. Check the original booking dates before filing';
  if (issue === 'filing_stay_unverified') return 'Infor did not verify one complete stay. Check the confirmation and original dates before filing';
  if (issue === 'existing_confirmation_found') return 'Infor already has this booking. Use the existing stay for amendment or filing; do not create it again';
  if (issue === 'existing_confirmation_requires_lookup') return 'A confirmation in this request may identify an existing booking. Find and verify that stay before creating a new reservation';
  if (issue === 'confirmation_claim_capacity_exceeded') return 'This request has too many confirmation references to check safely. Review the original email and PDF, and split it into explicit booking actions before proceeding';
  if (issue === 'create_requested_totals_conflict') return 'The rooms or occupants do not match the requested totals. Review each room and the group totals';
  if (issue === 'amend_room_count_requires_separate_reservations') return 'Choose the rooms to add or cancel as separate reservations';
  if (issue === 'amend_track_target_selection_required') return 'Find and select each saved stay in Infor before loading Track choices';
  if (issue === 'native_meal_plan_mismatch_or_unknown') return 'The Meal Plan does not match Infor. Review the Infor Meal Plan shown for the room and update the choice';
  if (issue === 'native_quote_no_matching_rate') {
    return 'No offer matches the requested room, rate and meal plan. Review available alternatives';
  }
  if (issue === 'native_quote_requested_unavailable') return 'The requested offer is unavailable. Review available alternatives';
  if (issue === 'native_quote_insufficient_inventory') return 'Infor found too few rooms for this request. Review the shortage and alternatives';
  if (issue === 'native_quote_restricted_nights') return 'The requested stay has closed or restricted nights. Review available alternatives';
  if (issue === 'native_quote_price_unavailable') return 'Infor could not complete the price check. Review the recorded result or run the check again';
  if (issue === 'amend_automatic_recovery_unavailable_operator_must_verify_writer_closed') {
    return 'The save outcome is uncertain. Contact Nava support before making another change to this stay.';
  }
  return 'Infor could not complete this action. Review the highlighted inputs and recorded result; contact Nava support if it remains blocked';
}

function serviceOperationNotice(result: unknown, success: string[]): string | undefined {
  const notice = operationNotice(result, success);
  if (!notice || !isRecord(result)) return notice;
  const fields = new Set<string>();
  if (Array.isArray(result.fields)) for (const field of result.fields) if (isString(field)) fields.add(field);
  if (Array.isArray(result.services)) for (const value of result.services) {
    const row = isRecord(value) ? value : null;
    if (Array.isArray(row?.fields)) for (const field of row.fields) if (isString(field)) fields.add(field);
  }
  return fields.size ? `${notice} Review: ${inputFieldLabels([...fields])}.` : notice;
}

function quoteLookupNotice(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.quotes)) return undefined;
  const issues = result.quotes.flatMap((value) => {
    if (!isRecord(value) || value.status === 'priced') return [];
    const status = isString(value.status) ? value.status.replaceAll('_', ' ') : 'unknown outcome';
    const issue = nativeIssueText(value.issue);
    const fields = inputFieldLabels(value.fields);
    return [`Quote check: ${status}${issue ? ` — ${issue}` : ''}${fields ? `; review ${fields}` : ''}.`];
  });
  return issues.length ? issues.join(' ') : undefined;
}

function filingLookupNotice(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.lookups)) return undefined;
  if (Array.isArray(result.requests) && result.requests.some((request) => isRecord(request) &&
    (request.kind === 'amend' || request.kind === 'cancel'))) return undefined;
  const issues = result.lookups.flatMap((value) => {
    if (!isRecord(value) || value.status === 'candidate' || value.status === 'ready') return [];
    const status = isString(value.status) ? value.status.replaceAll('_', ' ') : 'unknown outcome';
    const issue = nativeIssueText(value.issue);
    return [`Filing lookup: ${issue ?? status}.`];
  });
  return issues.length ? issues.join(' ') : undefined;
}

function cancelLookupNotice(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.requests) ||
      !result.requests.some((request) => isRecord(request) && request.kind === 'cancel') || !Array.isArray(result.lookups)) return undefined;
  const issues = result.lookups.flatMap((value) => {
    if (!isRecord(value) || value.status === 'found') return [];
    const message = value.issue === 'cancel_confirmation_target_required' ? 'Choose the stay to cancel before searching.'
      : value.issue === 'exact_confirmation_and_valid_dates_required' ? 'Enter the exact Infor confirmation and valid original dates.'
      : value.issue === 'cancel_target_status_not_reserved' ? 'This stay is not Reserved in Infor. Check the current booking.'
      : value.issue === 'cancel_source_hints_mismatch' ? 'Infor differs from the supplied guest or dates. Review the current stay before selecting it.'
      : value.issue === 'cancel_target_excluded_by_scope' || value.issue === 'cancel_target_exclusion_identity_unresolved'
        ? 'Review the included and excluded stays before searching.'
      : 'Infor could not verify this stay. Check the booking details and find it again.';
    return [`Cancellation lookup: ${message}`];
  });
  return issues.length ? issues.join(' ') : undefined;
}

function amendLookupNotice(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.requests) ||
      !result.requests.some((request) => isRecord(request) && request.kind === 'amend') || !Array.isArray(result.lookups)) return undefined;
  const issues = result.lookups.flatMap((value) => {
    if (!isRecord(value) || value.status === 'matches' || value.status === 'excluded') return [];
    const target = isString(value.hintId) ? `Stay ${value.hintId}` : 'Saved stay';
    const issue = value.issue;
    const message = issue === 'amend_target_scope_unresolved' ? 'Identify the individual stay with its confirmation or original booking details.'
      : issue === 'amend_target_hints_unknown' || issue === 'saved_target_hint_invalid' || issue === 'original_stay_hints_required'
        ? 'Enter the confirmation, or guest name and original booked dates, then find the stay again.'
      : issue === 'confirmation_hint_invalid' ? 'Check the confirmation number, then find the stay again.'
      : issue === 'guest_name_hint_mismatch' || issue === 'booked_arrival_hint_mismatch' || issue === 'booked_departure_hint_mismatch' || issue === 'confirmation_hint_mismatch'
        ? 'Infor differs from the supplied booking details. Check the guest and original booked dates before selecting a stay.'
      : issue === 'stay_search_ambiguous' ? 'Several stays match. Add the confirmation or exact original dates.'
      : issue === 'native_stay_unverified' || issue === 'no_verified_native_stay_matches_original_hints'
        ? 'No matching Reserved stay was verified. Check the confirmation and original booking details.'
      : 'Infor could not verify this stay. Check the booking details and try Find exact stays again.';
    return [`${target}: ${message}`];
  });
  return issues.length ? issues.join(' ') : undefined;
}

function quoteOperationNotice(result: unknown, success: string[], action: string): string | undefined {
  if (!isRecord(result)) return `${action}: Infor returned an unreadable response.`;
  if (success.includes(String(result.status))) return undefined;
  const messages: Record<string, string> = {
    quote_inputs_incomplete: 'Complete the quote details before checking Infor',
    quote_requires_staff_acceptance: 'Review the quote details before continuing',
    quote_native_scope_unsupported: 'Handle the requested details separately before continuing',
  };
  const issue = isString(result.issue) ? messages[result.issue] ?? nativeIssueText(result.issue)
    : result.status === 'needs_reconcile' || result.status === 'unknown'
      ? 'The result is uncertain. Check the recorded result before trying again' : null;
  const labels: Record<string, string> = {
    arrival: 'arrival date', departure: 'departure date', quantity: 'number of rooms', mealPlan: 'meal plan',
    scope: 'occupancy per room', occupancy: 'number of children and their ages', adults: 'adults per room',
    childCount: 'number of children', childAges: 'children’s ages', roomCodes: 'room type', ratePlan: 'rate plan',
    salesStrategy: 'sales strategy', email: 'recipient email', attention: 'contact name', telephone: 'contact number',
    artifacts: 'quote outputs', provisionalBookingRequested: 'quote-only choice', requestedMoney: 'extra charges',
    agency_selection_required: 'Infor agency', company_selection_required: 'Infor Organization',
  };
  const fields = Array.isArray(result.fields) ? [...new Set(result.fields.filter(isString).map((field) => {
    const [path, reason] = field.split(':');
    const group = /\/groups\/(\d+)(?:\/|$)/u.exec(path ?? '');
    const key = path?.split('/').at(-1) ?? '';
    const label = reason === 'separate_quote_runs_required' ? 'separate date ranges'
      : reason === 'date_range_invalid' ? 'date range' : key === 'groups' ? 'room groups' : labels[key] ?? labels[reason ?? ''] ?? 'quote details';
    return group ? `room group ${Number(group[1]) + 1}: ${label}` : label;
  }))] : [];
  return `${action}: ${issue ?? 'Infor could not complete this step. Review the quote and recorded result'}${fields.length ? `. Review: ${fields.join(', ')}` : ''}.`;
}

function serviceOwnerForPath(snapshot: ReservationPaneSnapshot, path: string): string | null {
  const parts = path.split('/').slice(1).map((part) => {
    try { return decodeURIComponent(part); } catch { return ''; }
  });
  if (parts[0] !== 'proposal' || parts[1] !== 'content' || parts[2] !== 'services' || parts.length < 5) return null;
  const rawIndex = parts[3]!;
  const serviceIndex = Number(rawIndex);
  const services = snapshot.session.draft.proposal.content.services;
  const service = Number.isInteger(serviceIndex) && serviceIndex >= 0 && String(serviceIndex) === rawIndex
    ? services[serviceIndex] : services.find((row) => row.id === rawIndex);
  if (!service) return null;
  const requests = snapshot.session.draft.proposal.content.requests.filter((request) => ['create', 'amend', 'services'].includes(request.kind));
  const direct = requests.find((request) => request.id === service.ownerRequestId);
  if (direct) return direct.id;
  return requests.find((request) => request.serviceRefs.includes(service.id) || service.targets.some((target) =>
    target.target.kind === 'allocation' && target.target.requestId === request.id))?.id ?? null;
}

function filingDocumentOwnerForPath(snapshot: ReservationPaneSnapshot, path: string): string | null {
  const parts = path.split('/').slice(1).map((part) => {
    try { return decodeURIComponent(part); } catch { return ''; }
  });
  if (parts[0] !== 'proposal' || parts[1] !== 'content' || parts[2] !== 'documents' || parts.length < 5) return null;
  const document = snapshot.session.draft.proposal.content.documents.find((entry) => entry.id === parts[3]);
  if (!document?.ownerRequestId) return null;
  const request = snapshot.session.draft.proposal.content.requests.find((entry) => entry.id === document.ownerRequestId
    && entry.kind === 'filing');
  if (request?.kind !== 'filing') return null;
  const refsPath = pointer('proposal', 'content', 'requests', request.id, 'documentRefs');
  const refs = snapshot.fields[refsPath]?.value !== undefined ? snapshot.fields[refsPath]?.value : request.documentRefs;
  if (!Array.isArray(refs) || !refs.includes(document.id)) return null;
  return request.id;
}

function requestOwnsPath(snapshot: ReservationPaneSnapshot, path: string): boolean {
  return snapshot.requests.some((request) => path.startsWith(`${pointer('proposal', 'content', 'requests', request.id)}/`))
    || serviceOwnerForPath(snapshot, path) !== null || filingDocumentOwnerForPath(snapshot, path) !== null;
}

function reportClientContractFailure(
  trpcClient: ReservationWorkflowV2TrpcClient,
  procedure: 'ensure' | 'get',
  input: unknown,
  workItemId: string | undefined,
  source: ReservationSourceContext,
): void {
  try {
    const recordActions = trpcClient.workItems?.recordActions;
    const actionId = reservationActionIdForInput(input);
    const mailbox = inMailbox(source.mailboxId);
    if (!recordActions || !actionId || !mailbox || !workItemId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workItemId)) return;
    const sourceInput = isRecord(input) && isRecord(input.source) ? input.source : null;
    const rawSourceMessageId = sourceInput?.messageId;
    const sourceMessageId = typeof rawSourceMessageId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(rawSourceMessageId)
      ? rawSourceMessageId
      : undefined;
    const surface = paneSurfaceForFailureEvent();
    const event: PaneFailureEvent = {
      type: 'pane.error',
      procedure,
      actionId,
      errorClass: 'client',
      metadataParseFailed: !sourceMessageId,
      ...(surface ? { surface } : {}),
      ...(sourceMessageId ? { sourceMessageId } : {}),
    };
    void Promise.resolve(recordActions.mutate({ workItemId, events: [event] }, {
      context: { ...mailbox.context, [NAVA_FAILURE_REPORT_CONTEXT_KEY]: true },
    })).catch(() => undefined);
  } catch {
    // A malformed client response or failed telemetry must not replace the original decode error.
  }
}

/** Typed adapter to reservationWorkflowV2. All mutations refresh the single canonical server draft. */
export function createTrpcReservationWorkflowClient<T extends ReservationWorkflowV2TrpcClient>(trpcClient: T): ReservationWorkflowClient {
  const api = trpcClient.reservationWorkflowV2;
  const load = async (input: ItemInput, source: ReservationSourceContext, backgroundPoll = false) => {
    const queryInput = {
      workItemId: input.workItemId, source: input.source, expectedRevision: input.expectedRevision, expectedSeq: input.expectedSeq,
    };
    const raw = await api.get.query(queryInput, mailboxOptions(source, backgroundPoll));
    try {
      return projectReservationSession(decodeDraft(raw));
    } catch (error) {
      if (isResponseContractFailure(raw)) reportClientContractFailure(trpcClient, 'get', queryInput, input.workItemId, source);
      throw error;
    }
  };
  const refreshAfterStale = async (input: ItemInput, source: ReservationSourceContext, result: unknown) => {
    if (!isRecord(result) || result.status !== 'stale_revision') return;
    throw new ReservationWorkflowStaleRevisionError(await load(input, source));
  };
  const refreshAfter = async <I extends ItemInput & Record<string, unknown>>(
    procedure: MutationProcedure<I>, input: I, source: ReservationSourceContext,
  ): Promise<ReservationPaneSnapshot> => {
    const raw = await procedure.mutate(input, mailboxOptions(source));
    await refreshAfterStale(input, source, raw);
    const result = okResult(raw);
    return load({ workItemId: input.workItemId, source: input.source,
      expectedRevision: typeof result.revision === 'number' ? result.revision : input.expectedRevision,
      expectedSeq: typeof result.seq === 'number' ? result.seq : input.expectedSeq }, source);
  };
  const guestResult = async (command: ReservationCommandContext, input: ItemInput & { idempotencyKey?: string }, raw: unknown, creating: boolean) => {
    const result = isRecord(raw) && isString(raw.status) ? raw : {
      status: creating ? 'needs_reconcile' : 'failed',
      issue: creating ? 'guest_profile_execution_unknown' : 'guest_profile_prepare_failed',
      ...(creating && input.idempotencyKey ? { operationId: input.idempotencyKey } : {}),
    };
    await refreshAfterStale(input, command.source, result);
    const uncertain = creating && ['unknown', 'needs_reconcile'].includes(result.status as string);
    const notice = uncertain
      ? 'Creation outcome is uncertain. Check the saved profile or contact Nava support before creating another profile.'
      : serviceOperationNotice(result, creating ? ['succeeded', 'already_succeeded'] : ['prepared']);
    try {
      const snapshot = await load(input, command.source);
      return { ...snapshot, workflowReply: result, ...(notice ? { serviceNotice: `Guest profile: ${notice}` } : {}) };
    } catch {
      const refreshNotice = creating
        ? 'Guest profile result could not be refreshed. Check the saved profile or contact Nava support before creating another profile.'
        : 'Guest profile preparation could not be refreshed. Reopen the email before continuing.';
      return { ...command.snapshot, workflowReply: result, serviceNotice: refreshNotice, loadError: refreshNotice };
    }
  };
  return {
    async ensure({ source, mode }) {
      const wire = apiSource(source);
      const queryInput = {
        ...(source.internetMessageId ? { internetMessageId: source.internetMessageId } : {}), source: wire, ...(mode ? { mode } : {}),
      };
      const raw = await api.ensure.mutate(queryInput, mailboxOptions(source));
      try {
        return projectReservationSession(decodeDraft(raw));
      } catch (error) {
        const rawWorkItemId = isRecord(raw) && isRecord(raw.draft) && typeof raw.draft.workItemId === 'string'
          ? raw.draft.workItemId
          : undefined;
        if (isResponseContractFailure(raw)) reportClientContractFailure(trpcClient, 'ensure', queryInput, rawWorkItemId, source);
        throw error;
      }
    },
    prefill(command) { return refreshAfter(api.prefill, itemInput(command), command.source); },
    addAction(command) { return refreshAfter(api.addAction, { ...itemInput(command), kind: command.kind }, command.source); },
    async changeRows(command) {
      const { source, snapshot, ...change } = command;
      const input = { ...itemInput({ source, snapshot }), ...change };
      const raw = await api.changeRows.mutate(input, mailboxOptions(source));
      await refreshAfterStale(input, source, raw);
      const result = okResult(raw);
      const next = await load({ workItemId: input.workItemId, source: input.source,
        expectedRevision: typeof result.revision === 'number' ? result.revision : input.expectedRevision,
        expectedSeq: typeof result.seq === 'number' ? result.seq : input.expectedSeq }, source);
      return typeof result.createdId === 'string' ? { ...next, workflowReply: { createdId: result.createdId } } : next;
    },
    selectNative(command) { return refreshAfter(api.selectNative, { ...itemInput(command), requestId: command.requestId, fieldPath: command.fieldPath, observationRef: command.observationRef }, command.source); },
    async verifyNativeLead(command) {
      const input = { ...itemInput(command), requestId: command.requestId, fieldPath: command.fieldPath, observationRef: command.observationRef };
      const raw = await api.verifyNativeLead.mutate(input, mailboxOptions(command.source));
      await refreshAfterStale(input, command.source, raw);
      if (!isRecord(raw) || !isString(raw.status)) throw errorFor({ status: 'invalid_state' });
      if (raw.status === 'needs_input' || raw.status === 'unavailable') {
        const verification = isRecord(raw.verification) ? raw.verification : {};
        const notice = verification.outcome === 'not_found'
          ? 'Infor did not find this ID within the searched field. Try another search.'
          : 'Infor could not verify this lead. Try another search or check Infor.';
        return { ...await load(input, command.source), workflowReply: raw, serviceNotice: notice };
      }
      okResult(raw);
      return load(input, command.source);
    },
    reviewScope(command) { return refreshAfter(api.reviewScope, { ...itemInput(command), requestId: command.requestId, scope: command.scope, ids: command.ids }, command.source); },
    get(command) { return load(itemInput(command), command.source, command.backgroundPoll); },
    reconcileSource(command) { return refreshAfter(api.reconcileSource, { ...itemInput(command), confirmed: true }, command.source); },
    async edit(command: ReservationEditCommand) {
      const input = { ...itemInput(command), fieldPath: command.fieldPath,
        value: { state: command.state, ...(command.state === 'set' ? { value: command.value } : {}), updatedAt: new Date().toISOString() } };
      return refreshAfter(api.edit, input, command.source);
    },
    async review(command: ReservationReviewCommand) {
      if (!requestOwnsPath(command.snapshot, command.fieldPath)) throw new Error('The field is not part of a source-bound reservation request.');
      return refreshAfter(api.review, { ...itemInput(command), fieldPath: command.fieldPath,
        decision: command.decision, ...(command.note ? { note: command.note } : {}) }, command.source);
    },
    undo(command) { return refreshAfter(api.undo, itemInput(command), command.source); },
    redo(command) { return refreshAfter(api.redo, itemInput(command), command.source); },
    async lookup(command) {
      const input = { ...itemInput(command), ...(command.requestId ? { requestId: command.requestId } : {}),
        ...(command.nativeFieldPath ? { nativeFieldPath: command.nativeFieldPath } : {}) };
      const raw = await api.lookup.mutate(input, mailboxOptions(command.source));
      await refreshAfterStale(input, command.source, raw);
      const result = okResult(raw);
      const notice = operationNotice(result, ['ok']) ?? quoteLookupNotice(result) ?? amendLookupNotice(result) ??
        cancelLookupNotice(result) ?? filingLookupNotice(result);
      return { ...await load(input, command.source), ...(notice ? { serviceNotice: notice } : {}), ...(isRecord(result) ? { workflowReply: result } : {}) };
    },
    async guestProfileOptions(command) {
      const input = { ...itemInput(command), requestId: command.requestId, allocationId: command.allocationId, field: command.field };
      const options = mailboxOptions(command.source);
      const raw = await api.guestProfileOptions.mutate(input, options).catch((error: unknown) => ({
        outcome: 'unavailable', issue: error instanceof Error ? error.message : 'guest_profile_options_unavailable',
      }));
      const result: RecordValue = isRecord(raw) ? raw : { outcome: 'unavailable', issue: 'guest_profile_options_unavailable' };
      await refreshAfterStale(input, command.source, result);
      const status = isString(result.status) ? result.status : isString(result.outcome) ? result.outcome : 'unavailable';
      const issue = nativeIssueText(result.issue);
      const notice = status === 'ok' ? undefined : `Guest profile options: ${status.replaceAll('_', ' ')}${issue ? ` — ${issue}` : ''}.`;
      try {
        return { ...await load(input, command.source), workflowReply: result, ...(notice ? { serviceNotice: notice } : {}) };
      } catch {
        const refreshNotice = 'Guest profile options could not be refreshed. Reopen the email before continuing.';
        return { ...command.snapshot, workflowReply: result, serviceNotice: refreshNotice, loadError: refreshNotice };
      }
    },
    async prepareGuestProfile(command) {
      const input = { ...itemInput(command), requestId: command.requestId, allocationId: command.allocationId,
        ...(typeof command.confirmDuplicateName === 'boolean' ? { confirmDuplicateName: command.confirmDuplicateName } : {}) };
      const options = mailboxOptions(command.source);
      const result = await api.prepareGuestProfile.mutate(input, options).catch((error: unknown) => ({
        status: 'failed', issue: error instanceof Error ? error.message : 'guest_profile_prepare_failed',
      }));
      return guestResult(command, input, result, false);
    },
    async createGuestProfile(command) {
      const input = { ...itemInput(command), requestId: command.requestId, allocationId: command.allocationId,
        ...(typeof command.confirmDuplicateName === 'boolean' ? { confirmDuplicateName: command.confirmDuplicateName } : {}),
        go: true as const, prepareRef: command.prepareRef, idempotencyKey: command.idempotencyKey };
      const options = mailboxOptions(command.source);
      const result = await api.createGuestProfile.mutate(input, options).catch(() => ({
        status: 'needs_reconcile', issue: 'guest_profile_execution_unknown', operationId: command.idempotencyKey,
      }));
      return guestResult(command, input, result, true);
    },
    async prepare(command) {
      const input = { ...itemInput(command), requestId: command.requestId,
        ...(command.allocationId ? { allocationId: command.allocationId } : {}) };
      const result = await api.prepare.mutate(input, mailboxOptions(command.source));
      await refreshAfterStale(input, command.source, result);
      const snapshot = await load(input, command.source);
      const isQuote = command.snapshot.requests.some((request) => request.id === command.requestId && request.kind === 'quote');
      const notice = isQuote ? quoteOperationNotice(result, ['prepared'], 'Quote price preparation') : operationNotice(result, ['prepared']);
      return { ...snapshot, ...(notice ? { serviceNotice: notice } : {}), ...(isRecord(result) ? { workflowReply: result } : {}) };
    },
    async execute(command) {
      const input = { ...itemInput(command), requestId: command.requestId,
        ...(command.allocationId ? { allocationId: command.allocationId } : {}),
        go: true as const, idempotencyKey: command.idempotencyKey };
      const result = await api.execute.mutate(input, mailboxOptions(command.source));
      await refreshAfterStale(input, command.source, result);
      const snapshot = await load(input, command.source);
      const isQuote = command.snapshot.requests.some((request) => request.id === command.requestId && request.kind === 'quote');
      const notice = isQuote ? quoteOperationNotice(result, ['succeeded', 'already_succeeded'], 'Unsent quote generation')
        : operationNotice(result, ['succeeded', 'already_succeeded']);
      const displayNotice = notice ? isQuote ? `${notice} No email was sent and no reservation was saved.` : notice : null;
      return { ...snapshot, ...(displayNotice ? { serviceNotice: displayNotice } : {}), ...(isRecord(result) ? { workflowReply: result } : {}) };
    },
    async reconcile(command) {
      const input = { ...itemInput(command), operationId: command.operationId };
      const result = await api.reconcile.mutate(input, mailboxOptions(command.source));
      await refreshAfterStale(input, command.source, result);
      const snapshot = await load(input, command.source);
      const notice = operationNotice(result, ['succeeded', 'failed']);
      return { ...snapshot, ...(notice ? { serviceNotice: notice } : {}),
        ...(isRecord(result) ? { workflowReply: result } : {}) };
    },
    async configureFiling(command) {
      const input = { ...itemInput(command), requestId: command.requestId, attachmentId: command.attachmentId,
        ...(command.confirmation ? { confirmation: command.confirmation } : { allocationTarget: command.allocationTarget }), kind: command.kind };
      return refreshAfter(api.configureFiling, input, command.source);
    },
    async lookupServices(command) {
      const input = { ...itemInput(command), requestId: command.requestId, ...(command.allocationId ? { allocationId: command.allocationId } : { targetRef: command.targetRef }),
        ...(command.serviceId ? { serviceId: command.serviceId } : {}) };
      const result = await api.lookupServices.mutate(input, mailboxOptions(command.source));
      await refreshAfterStale(input, command.source, result);
      const snapshot = await load(input, command.source);
      const notice = serviceOperationNotice(result, ['ok']);
      return { ...snapshot, ...(notice ? { serviceNotice: `Add-On catalogue: ${notice}` } : {}),
        ...(isRecord(result) ? { workflowReply: result } : {}) };
    },
    async previewServices(command) {
      const input = { ...itemInput(command), requestId: command.requestId, ...(command.allocationId ? { allocationId: command.allocationId } : { targetRef: command.targetRef }),
        ...(command.serviceId ? { serviceId: command.serviceId } : {}) };
      const result = await api.prepareServices.mutate(input, mailboxOptions(command.source));
      await refreshAfterStale(input, command.source, result);
      const snapshot = await load(input, command.source);
      const notice = serviceOperationNotice(result, ['prepared']);
      return { ...snapshot, ...(notice ? { serviceNotice: `Add-On preview only; nothing saved: ${notice}` } : {}),
        ...(isRecord(result) ? { workflowReply: result } : {}) };
    },
    async executeServices(command) {
      const input = { ...itemInput(command), requestId: command.requestId, ...(command.allocationId ? { allocationId: command.allocationId } : { targetRef: command.targetRef }),
        serviceId: command.serviceId, go: true as const, idempotencyKey: command.idempotencyKey,
        ...(command.reviewedPrepareRef ? { reviewedPrepareRef: command.reviewedPrepareRef } : {}) };
      const result = await api.executeServices.mutate(input, mailboxOptions(command.source));
      await refreshAfterStale(input, command.source, result);
      const snapshot = await load(input, command.source);
      const notice = serviceOperationNotice(result, ['succeeded', 'already_succeeded']);
      return { ...snapshot, ...(notice ? { serviceNotice: `Add-On save: ${notice}` } : {}),
        ...(isRecord(result) ? { workflowReply: result } : {}) };
    },
    async reconcileServices(command) {
      const input = { ...itemInput(command), operationId: command.operationId };
      const result = await api.reconcileServices.mutate(input, mailboxOptions(command.source));
      await refreshAfterStale(input, command.source, result);
      const snapshot = await load(input, command.source);
      const notice = serviceOperationNotice(result, ['succeeded', 'failed']);
      return { ...snapshot, ...(notice ? { serviceNotice: `Add-On reconciliation: ${notice}` } : {}),
        ...(isRecord(result) ? { workflowReply: result } : {}) };
    },
  };
}

export function reservationCommandContext(source: ReservationSourceContext, snapshot: ReservationPaneSnapshot) {
  return { source, snapshot };
}
