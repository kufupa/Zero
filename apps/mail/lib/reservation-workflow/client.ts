import { reservationWorkflowV2DraftSchema, type ReservationWorkflowV2Draft, type ReservationWorkflowV2Source } from '../../../server-pilot/src/ai/reservation-workflow-v2-contract.js';
import { inMailbox } from '@/lib/mail/mail-cache-scope';
import type {
  ReservationCommandContext,
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
type MailboxCallOptions = NonNullable<ReturnType<typeof inMailbox>>;
type QueryProcedure<I> = { query(input: I, options?: MailboxCallOptions): Promise<unknown> };
type MutationProcedure<I> = { mutate(input: I, options?: MailboxCallOptions): Promise<unknown> };

/** Narrow structural type for the published v2 router; no legacy quote/session DTOs cross this boundary. */
export type ReservationWorkflowV2TrpcClient = {
  reservationWorkflowV2: {
    ensure: MutationProcedure<{ internetMessageId?: string | null; source: ReservationWorkflowV2Source }>;
    get: QueryProcedure<ItemInput>;
    edit: MutationProcedure<ItemInput & { fieldPath: string; value: { state: 'set' | 'none' | 'unknown' | 'inherit' | 'clear'; value?: unknown; updatedAt: string } }>;
    review: MutationProcedure<ItemInput & { fieldPath: string; decision: 'accepted' | 'flagged'; note?: string | null }>;
    undo: MutationProcedure<ItemInput>;
    redo: MutationProcedure<ItemInput>;
    lookup: MutationProcedure<ItemInput & { requestId?: string }>;
    prepare: MutationProcedure<ItemInput & { requestId: string; allocationId?: string }>;
    execute: MutationProcedure<ItemInput & { requestId: string; allocationId?: string; go: true; idempotencyKey: string }>;
    reconcile: MutationProcedure<ItemInput & { operationId: string }>;
    configureFiling: MutationProcedure<ItemInput & { requestId: string; attachmentId: string; confirmation: string;
      kind: 'voucher' | 'payment_proof' }>;
    lookupServices: MutationProcedure<ItemInput & { requestId: string; allocationId: string; serviceId?: string }>;
    prepareServices: MutationProcedure<ItemInput & { requestId: string; allocationId: string; serviceId?: string }>;
    executeServices: MutationProcedure<ItemInput & { requestId: string; allocationId: string; serviceId: string; go: true;
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

function mailboxOptions(source: ReservationSourceContext): MailboxCallOptions {
  const options = inMailbox(source.mailboxId);
  if (!options) throw new Error('The selected Nava mailbox is unavailable; reopen this email before continuing.');
  return options;
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
        ...(isString(value.issue) ? { issue: value.issue } : {}), ...(price ? { price } : {}) }];
    }) : [];
  return { draft: draft as unknown as ReservationWorkflowV2Draft, revision, revisionHead, seq, preparationViews };
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

const reviewedAggregateArrays = new Set(['childAges', 'roomCodes', 'artifacts']);
const nonReviewMetadata = new Set(['requestText', 'title', 'dateSectionId', 'requestedRooms', 'unassignedGuestNames',
  'requestedTotals', 'scope', 'profileIntent', 'candidateRefs', 'suggestedRef', 'sourceRefs', 'serviceRefs', 'documentRefs', 'targetRefs',
  'priceObservationRefs', 'lookupResultRefs', 'evidenceRefs', 'ownerRequestId', 'uploadArtifactRef', 'id', 'kind']);
const nonReviewSubtrees = new Set(['requestedTotals', 'unassignedGuestNames']);
const partyFieldNames = new Set(['bookingAgency', 'organization', 'arAccount', 'agency', 'company']);

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
      && ['agency', 'company'].includes(parts[6] ?? '')) {
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

  // Candidate-bearing values are human review units themselves (payer/company
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

function requiredForPath(draft: ReservationWorkflowV2Draft, path: string, value: unknown): boolean {
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

function project(session: ReservationWorkflowV2Session): ReservationPaneSnapshot {
  const { draft } = session;
  const fields: ReservationPaneSnapshot['fields'] = {};
  const requests: ReservationRequestProjection[] = [];
  for (const request of draft.proposal.content.requests) {
    const root = pointer('proposal', 'content', 'requests', request.id);
    flattenFields(request, root, fields, draft);
    requests.push({ id: request.id, kind: request.kind, text: request.requestText,
      fieldPaths: Object.keys(fields).filter((path) => path.startsWith(`${root}/`)),
      supported: (request.kind === 'create' || request.kind === 'quote' || request.kind === 'amend'
        || request.kind === 'cancel' || request.kind === 'filing') && draft.propertyCode === 'HRCEN' });
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
      return { ...result, ...(receipt ? { confirmation: receipt.confirmation, confirmationObservationRef: receipt.ref } : {}) };
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
    issues: [...draft.proposal.issues.map((issue) => ({ path: issue.path, kind: issue.kind, explanation: issue.explanation, evidenceRefs: issue.evidenceRefs })), ...apiErrors],
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

function operationNotice(result: unknown, success: string[]): string | undefined {
  if (!isRecord(result)) return 'The reservation service returned an unreadable native-tool result.';
  if (success.includes(String(result.status))) return undefined;
  const status = isString(result.status) ? result.status.replaceAll('_', ' ') : 'unknown outcome';
  const issue = nativeIssueText(result.issue);
  return issue ? `Infor check: ${status} — ${issue}.` : `Infor check: ${status}.`;
}

function nativeIssueText(issue: unknown): string | null {
  if (!isString(issue)) return null;
  if (issue === 'amend_automatic_recovery_unavailable_operator_must_verify_writer_closed') {
    return 'The save outcome is uncertain. Contact Nava support before making another change to this stay.';
  }
  return issue.replaceAll('_', ' ');
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
  return fields.size ? `${notice} Review: ${[...fields].join(', ')}.` : notice;
}

function quoteLookupNotice(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.quotes)) return undefined;
  const issues = result.quotes.flatMap((value) => {
    if (!isRecord(value) || value.status === 'priced') return [];
    const status = isString(value.status) ? value.status.replaceAll('_', ' ') : 'unknown outcome';
    const issue = isString(value.issue) ? value.issue.replaceAll('_', ' ') : null;
    const fields = Array.isArray(value.fields) ? value.fields.filter(isString).join(', ') : '';
    return [`Quote check: ${status}${issue ? ` — ${issue}` : ''}${fields ? `; review ${fields}` : ''}.`];
  });
  return issues.length ? issues.join(' ') : undefined;
}

function filingLookupNotice(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.lookups)) return undefined;
  const issues = result.lookups.flatMap((value) => {
    if (!isRecord(value) || value.status === 'candidate' || value.status === 'ready') return [];
    const status = isString(value.status) ? value.status.replaceAll('_', ' ') : 'unknown outcome';
    const issue = isString(value.issue) ? value.issue.replaceAll('_', ' ') : null;
    return [`Filing lookup: ${issue ?? status}.`];
  });
  return issues.length ? issues.join(' ') : undefined;
}

function quoteOperationNotice(result: unknown, success: string[], action: string): string | undefined {
  if (!isRecord(result)) return `${action}: unreadable native quote response.`;
  if (success.includes(String(result.status))) return undefined;
  const status = isString(result.status) ? result.status.replaceAll('_', ' ') : 'unknown outcome';
  const issue = isString(result.issue) ? result.issue.replaceAll('_', ' ') : null;
  const fields = Array.isArray(result.fields) ? result.fields.filter(isString) : [];
  return `${action}: ${status}${issue ? ` — ${issue}` : ''}${fields.length ? `; review ${fields.join(', ')}` : ''}.`;
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
  const requests = snapshot.session.draft.proposal.content.requests.filter((request) => request.kind === 'create');
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

/** Typed adapter to reservationWorkflowV2. All mutations refresh the single canonical server draft. */
export function createTrpcReservationWorkflowClient<T extends ReservationWorkflowV2TrpcClient>(trpcClient: T): ReservationWorkflowClient {
  const api = trpcClient.reservationWorkflowV2;
  const load = async (input: ItemInput, source: ReservationSourceContext) => project(decodeDraft(await api.get.query({
    workItemId: input.workItemId, source: input.source, expectedRevision: input.expectedRevision, expectedSeq: input.expectedSeq,
  }, mailboxOptions(source))));
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
    if (result.status === 'ok' && result.draft) return project(decodeDraft(result));
    return load({ workItemId: input.workItemId, source: input.source,
      expectedRevision: typeof result.revision === 'number' ? result.revision : input.expectedRevision,
      expectedSeq: typeof result.seq === 'number' ? result.seq : input.expectedSeq }, source);
  };
  return {
    async ensure({ source }) {
      const wire = apiSource(source);
      return project(decodeDraft(await api.ensure.mutate({
        ...(source.internetMessageId ? { internetMessageId: source.internetMessageId } : {}), source: wire,
      }, mailboxOptions(source))));
    },
    get(command) { return load(itemInput(command), command.source); },
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
      const input = { ...itemInput(command), ...(command.requestId ? { requestId: command.requestId } : {}) };
      const raw = await api.lookup.mutate(input, mailboxOptions(command.source));
      await refreshAfterStale(input, command.source, raw);
      const result = okResult(raw);
      const notice = operationNotice(result, ['ok']) ?? quoteLookupNotice(result) ?? filingLookupNotice(result);
      return { ...await load(input, command.source), ...(notice ? { serviceNotice: notice } : {}), ...(isRecord(result) ? { workflowReply: result } : {}) };
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
        confirmation: command.confirmation, kind: command.kind };
      return refreshAfter(api.configureFiling, input, command.source);
    },
    async lookupServices(command) {
      const input = { ...itemInput(command), requestId: command.requestId, allocationId: command.allocationId,
        ...(command.serviceId ? { serviceId: command.serviceId } : {}) };
      const result = await api.lookupServices.mutate(input, mailboxOptions(command.source));
      await refreshAfterStale(input, command.source, result);
      const snapshot = await load(input, command.source);
      const notice = serviceOperationNotice(result, ['ok']);
      return { ...snapshot, ...(notice ? { serviceNotice: `Add-On catalogue: ${notice}` } : {}),
        ...(isRecord(result) ? { workflowReply: result } : {}) };
    },
    async previewServices(command) {
      const input = { ...itemInput(command), requestId: command.requestId, allocationId: command.allocationId,
        ...(command.serviceId ? { serviceId: command.serviceId } : {}) };
      const result = await api.prepareServices.mutate(input, mailboxOptions(command.source));
      await refreshAfterStale(input, command.source, result);
      const snapshot = await load(input, command.source);
      const notice = serviceOperationNotice(result, ['prepared']);
      return { ...snapshot, ...(notice ? { serviceNotice: `Add-On preview only; nothing saved: ${notice}` } : {}),
        ...(isRecord(result) ? { workflowReply: result } : {}) };
    },
    async executeServices(command) {
      const input = { ...itemInput(command), requestId: command.requestId, allocationId: command.allocationId,
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
