import { reservationWorkflowV2DraftSchema, type ReservationWorkflowV2Draft, type ReservationWorkflowV2Source } from '../../../server-pilot/src/ai/reservation-workflow-v2-contract.js';
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

type ItemInput = {
  workItemId: string;
  source: ReservationWorkflowV2Source;
  expectedRevision: number;
  expectedSeq: number;
};
type StateResult = { status: string; draft?: unknown; revision?: number; revisionHead?: number; seq?: number; preparationViews?: unknown };
type QueryProcedure<I> = { query(input: I): Promise<unknown> };
type MutationProcedure<I> = { mutate(input: I): Promise<unknown> };

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

function errorFor(result: StateResult): Error {
  const detail = result.status.replaceAll('_', ' ');
  const messages: Record<string, string> = {
    invalid_source: 'The selected email changed. Reopen the email before editing this draft.',
    wrong_property: 'This email is not admitted for the connected property.',
    stale_revision: 'The draft changed elsewhere. Reloading the current saved values.',
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
    const requirement = draft.fieldReviewRequirements[path];
    const review = draft.staffReviews[path];
    out[path] = { path, value: effectiveValue(value, override), ...(override ? { override } : {}),
      required: requirement?.required ?? false, review: review?.status ?? 'pending',
      provenance: override?.state === 'set' ? 'manual' : annotation?.basis ?? 'unknown',
      evidenceRefs: annotation?.evidenceRefs ?? [] };
    value.forEach((item, index) => flattenFields(item, `${path}/${index}`, out, draft));
    return;
  }
  if (isRecord(value) && (value.kind === 'none' || Array.isArray(value.candidateRefs))) {
    const override = draft.fieldOverrides[path];
    const annotation = draft.proposal.annotations.find((entry) => entry.path === path);
    const claim = draft.proposal.sourceClaims.find((entry) => entry.path === path);
    const requirement = draft.fieldReviewRequirements[path];
    const review = draft.staffReviews[path];
    out[path] = {
      path, value: effectiveValue(value, override), ...(override ? { override } : {}),
      required: requirement?.required ?? false, review: review?.status ?? 'pending',
      provenance: override?.state === 'set' ? 'manual' : annotation?.basis ?? (claim ? 'source' : 'unknown'),
      evidenceRefs: annotation?.evidenceRefs ?? claim?.sourceRefs ?? [],
      ...(review?.status === 'flagged' && review.note ? { issue: review.note } : {}),
    };
    return;
  }
  if (isRecord(value) && value.kind !== 'none') {
    for (const [key, child] of Object.entries(value)) {
      if (['id', 'kind', 'sourceRefs', 'candidateRefs', 'serviceRefs', 'documentRefs', 'priceObservationRefs', 'lookupResultRefs', 'evidenceRefs'].includes(key)) continue;
      flattenFields(child, `${path}/${pointerPart(key)}`, out, draft);
    }
    return;
  }
  if (path.split('/').some((segment) => ['id', 'kind', 'sourceRefs', 'candidateRefs'].includes(decodeURIComponent(segment)))) return;
  const override = draft.fieldOverrides[path];
  const annotation = draft.proposal.annotations.find((entry) => entry.path === path);
  const claim = draft.proposal.sourceClaims.find((entry) => entry.path === path);
  const reviewRequirement = draft.fieldReviewRequirements[path];
  const review = draft.staffReviews[path];
  out[path] = {
    path,
    value: effectiveValue(value, override),
    ...(override ? { override } : {}),
    required: reviewRequirement?.required ?? false,
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
      supported: request.kind === 'create' && draft.propertyCode === 'HRCEN' });
  }
  for (const row of draft.proposal.content.services) flattenFields(row, pointer('proposal', 'content', 'services', row.id), fields, draft);
  for (const row of draft.proposal.content.documents) flattenFields(row, pointer('proposal', 'content', 'documents', row.id), fields, draft);
  for (const path of Object.keys(draft.fieldOverrides)) {
    if (fields[path]) continue;
    const override = draft.fieldOverrides[path];
    const requirement = draft.fieldReviewRequirements[path];
    const review = draft.staffReviews[path];
    const annotation = draft.proposal.annotations.find((entry) => entry.path === path);
    const claim = draft.proposal.sourceClaims.find((entry) => entry.path === path);
    fields[path] = { path, value: effectiveValue(wireValueAtPath(draft, path), override), override,
      required: requirement?.required ?? false, review: review?.status ?? 'pending',
      provenance: override.state === 'set' ? 'manual' : annotation?.basis ?? (claim ? 'source' : 'unknown'),
      evidenceRefs: annotation?.evidenceRefs ?? claim?.sourceRefs ?? [],
      ...(review?.status === 'flagged' && review.note ? { issue: review.note } : {}) };
  }
  for (const request of requests) request.fieldPaths = Object.keys(fields).filter((path) =>
    path.startsWith(`${pointer('proposal', 'content', 'requests', request.id)}/`));
  const runtimeDraft = draft as unknown as { operationResults?: unknown; errors?: Array<{ stage: string; code: string; message: string }> };
  const operationResults = Array.isArray(runtimeDraft.operationResults)
    ? runtimeDraft.operationResults.filter(isRecord) : [];
  const createRequests = draft.proposal.content.requests.filter((request) => request.kind === 'create');
  const allocations = createRequests.flatMap((request) => request.body.allocations.map((allocation) => ({ requestId: request.id, allocationId: allocation.id })));
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
  const issue = isString(result.issue) ? result.issue.replaceAll('_', ' ') : null;
  return issue ? `Infor check: ${status} — ${issue}.` : `Infor check: ${status}.`;
}

function requestOwnsPath(snapshot: ReservationPaneSnapshot, path: string): boolean {
  return snapshot.requests.some((request) => path.startsWith(`${pointer('proposal', 'content', 'requests', request.id)}/`));
}

/** Typed adapter to reservationWorkflowV2. All mutations refresh the single canonical server draft. */
export function createTrpcReservationWorkflowClient<T extends ReservationWorkflowV2TrpcClient>(trpcClient: T): ReservationWorkflowClient {
  const api = trpcClient.reservationWorkflowV2;
  const load = async (input: ItemInput) => project(decodeDraft(await api.get.query({
    workItemId: input.workItemId, source: input.source, expectedRevision: input.expectedRevision, expectedSeq: input.expectedSeq,
  })));
  const refreshAfter = async <I extends ItemInput & Record<string, unknown>>(
    procedure: MutationProcedure<I>, input: I,
  ): Promise<ReservationPaneSnapshot> => {
    const result = okResult(await procedure.mutate(input));
    if (result.status === 'ok' && result.draft) return project(decodeDraft(result));
    return load({ workItemId: input.workItemId, source: input.source,
      expectedRevision: typeof result.revision === 'number' ? result.revision : input.expectedRevision,
      expectedSeq: typeof result.seq === 'number' ? result.seq : input.expectedSeq });
  };
  return {
    async ensure({ source }) {
      const wire = apiSource(source);
      return project(decodeDraft(await api.ensure.mutate({
        ...(source.internetMessageId ? { internetMessageId: source.internetMessageId } : {}), source: wire,
      })));
    },
    get(command) { return load(itemInput(command)); },
    async edit(command: ReservationEditCommand) {
      const input = { ...itemInput(command), fieldPath: command.fieldPath,
        value: { state: command.state, ...(command.state === 'set' ? { value: command.value } : {}), updatedAt: new Date().toISOString() } };
      return refreshAfter(api.edit, input);
    },
    async review(command: ReservationReviewCommand) {
      if (!requestOwnsPath(command.snapshot, command.fieldPath)) throw new Error('The field is not part of a source-bound reservation request.');
      return refreshAfter(api.review, { ...itemInput(command), fieldPath: command.fieldPath,
        decision: command.decision, ...(command.note ? { note: command.note } : {}) });
    },
    undo(command) { return refreshAfter(api.undo, itemInput(command)); },
    redo(command) { return refreshAfter(api.redo, itemInput(command)); },
    async lookup(command) {
      const input = { ...itemInput(command), ...(command.requestId ? { requestId: command.requestId } : {}) };
      const result = okResult(await api.lookup.mutate(input));
      return { ...await load(input), ...(operationNotice(result, ['ok']) ? { serviceNotice: operationNotice(result, ['ok']) } : {}) };
    },
    async prepare(command) {
      const input = { ...itemInput(command), requestId: command.requestId, allocationId: command.allocationId };
      const result = await api.prepare.mutate(input);
      const snapshot = await load(input);
      const notice = operationNotice(result, ['prepared']);
      return notice ? { ...snapshot, serviceNotice: notice } : snapshot;
    },
    async execute(command) {
      const input = { ...itemInput(command), requestId: command.requestId, allocationId: command.allocationId,
        go: true as const, idempotencyKey: command.idempotencyKey };
      const result = await api.execute.mutate(input);
      const snapshot = await load(input);
      const notice = operationNotice(result, ['succeeded', 'already_succeeded']);
      return notice ? { ...snapshot, serviceNotice: notice } : snapshot;
    },
    async reconcile(command) {
      const input = { ...itemInput(command), operationId: command.operationId };
      const result = await api.reconcile.mutate(input);
      const snapshot = await load(input);
      const notice = operationNotice(result, ['succeeded', 'failed']);
      return notice ? { ...snapshot, serviceNotice: notice } : snapshot;
    },
  };
}

export function reservationCommandContext(source: ReservationSourceContext, snapshot: ReservationPaneSnapshot) {
  return { source, snapshot };
}
