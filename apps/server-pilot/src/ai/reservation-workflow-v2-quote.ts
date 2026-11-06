import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { user } from '../db/schema/auth.js';
import {
  getReservationWorkflowV2Draft,
  appendReservationWorkflowV2Observation,
  recordReservationWorkflowV2Result,
} from './reservation-workflow-v2-state.js';
import type {
  ReservationWorkflowV2Draft,
  ReservationWorkflowV2Observation,
  ReservationWorkflowV2Source,
} from './reservation-workflow-v2-contract.js';
import { findParty } from './pane-party-lookup.js';
import { resolveHmsQuoteJobTarget } from '../hms/hms-quote-target.js';
import { staffQuoteInput } from './staff-quote-workflow.js';
import { runStaffQuote } from './staff-quote-run.js';
import { buildStaysProposalPdf } from '../quote-proposal/proposal-pdf.js';
import {
  quoteWorkbookFileName,
  quoteWorkbookForStays,
  type WorkbookStay,
} from '../quote-proposal/quote-workbook.js';
import type { AuthorizedProposalFacts, RowPrice } from '../quote-proposal/quote-lines.js';
import { quoteDigest, type QuoteRevision } from '../quote-proposal/quote-revision.js';

/** Kept structurally aligned with reservationWorkflowV2ServerContext in the native tools module. */
export type ReservationWorkflowV2QuoteContext = {
  db: DB;
  transport: { id: string };
  user: { id: string };
  property: { propertyCode: string };
};

type QuoteBaseInput = {
  workItemId: string;
  source: ReservationWorkflowV2Source;
  expectedRevision: number;
  expectedSeq: number;
};
export type ReservationWorkflowV2QuoteLookupInput = QuoteBaseInput & { requestId?: string };
export type ReservationWorkflowV2QuotePrepareInput = QuoteBaseInput & { requestId: string };
export type ReservationWorkflowV2QuoteExecuteInput = QuoteBaseInput & {
  requestId: string;
  go: true;
  idempotencyKey: string;
};
export type ReservationWorkflowV2QuoteReconcileInput = QuoteBaseInput & { operationId: string };

type QuoteRequest = Extract<ReservationWorkflowV2Draft['proposal']['content']['requests'][number], { kind: 'quote' }>;
type QuoteOperationResult = {
  id: string;
  generationId: string;
  requestId: string;
  allocationId: null;
  workflow: 'quote';
  status: 'prepared' | 'succeeded' | 'failed' | 'unknown';
  draftRevision: number;
  observationRefs: string[];
  updatedAt: string;
  summary: string | null;
};
type Outcome = { status: string; issue?: string; [key: string]: unknown };
type QuoteRunResult = Record<string, unknown>;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const cleanText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;
const isNone = (value: unknown): boolean =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as { kind?: unknown }).kind === 'none');
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
});
const providerCode = z.string().regex(/^[A-Z0-9_-]{1,16}$/);
const hash = (value: unknown) => quoteDigest(value);

function stateContext(ctx: ReservationWorkflowV2QuoteContext) {
  return {
    db: ctx.db,
    transportId: ctx.transport.id,
    userId: ctx.user.id,
    propertyCode: ctx.property.propertyCode,
  };
}

function ptr(...parts: Array<string | number>): string {
  return `/${parts.map((part) => encodeURIComponent(String(part))).join('/')}`;
}

function quoteBodyPath(requestId: string): string {
  return ptr('proposal', 'content', 'requests', requestId, 'body');
}

function quoteInputOverrides(draft: ReservationWorkflowV2Draft, requestId: string) {
  const index = draft.proposal.content.requests.findIndex((request) => request.id === requestId);
  const prefixes = [ptr('proposal', 'content', 'requests', requestId), ptr('proposal', 'content', 'requests', index)];
  return Object.fromEntries(Object.entries(draft.fieldOverrides)
    .filter(([path]) => prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, override]) => [path, { state: override.state,
      ...(override.state === 'set' ? { value: override.value } : {}) }]));
}

function quoteRequests(draft: ReservationWorkflowV2Draft, requestId?: string): QuoteRequest[] {
  return draft.proposal.content.requests.filter((request): request is QuoteRequest =>
    request.kind === 'quote' && (!requestId || request.id === requestId));
}

async function loadCurrent(ctx: ReservationWorkflowV2QuoteContext, input: QuoteBaseInput) {
  const loaded = await getReservationWorkflowV2Draft(stateContext(ctx), {
    workItemId: input.workItemId,
    source: input.source,
  });
  if (loaded.status !== 'ok') return { result: loaded, draft: null } as const;
  if (loaded.revision !== input.expectedRevision || loaded.seq !== input.expectedSeq ||
      loaded.draft.revision !== input.expectedRevision) {
    return { result: { status: 'stale_revision' as const }, draft: null } as const;
  }
  return { result: loaded, draft: loaded.draft } as const;
}

function resolvedLeaf(draft: ReservationWorkflowV2Draft, path: string, sourceValue: unknown):
  { value: unknown; path: string; unset?: boolean; overridden?: boolean } | { issue: string } {
  const override = draft.fieldOverrides[path];
  if (override) {
    if (override.state === 'unknown') return { issue: 'unknown_staff_value' };
    if (override.state === 'set') return { value: override.value, path, overridden: true };
    if (override.state === 'none' || override.state === 'clear') return { value: undefined, path, unset: true, overridden: true };
    if (override.state === 'inherit') return { value: sourceValue, path };
  }
  if (isNone(sourceValue)) return { value: undefined, path, unset: true };
  return { value: sourceValue, path };
}

function reviewAccepted(draft: ReservationWorkflowV2Draft, path: string): boolean {
  return draft.fieldReviewRequirements[path]?.required === false || draft.staffReviews[path]?.status === 'accepted';
}

function boardCode(value: unknown): 'room_only' | 'bb' | 'dinner_bb' | null {
  if (typeof value !== 'string') return null;
  const board = value.trim().toLocaleLowerCase().replace(/[\s&-]+/gu, '_');
  if (['room_only', 'roomonly', 'ro'].includes(board)) return 'room_only';
  if (['bb', 'b_b', 'breakfast', 'bed_and_breakfast'].includes(board)) return 'bb';
  if (['dinner_bb', 'dinner_b_b', 'dinner_bed_breakfast', 'dinner_and_breakfast'].includes(board)) return 'dinner_bb';
  return null;
}

function selectedParty(
  draft: ReservationWorkflowV2Draft,
  request: QuoteRequest,
  role: 'company' | 'agency',
  execute: boolean,
): { party?: { kind: 'company' | 'agency'; nativeId: string; name: string }; issue?: string; reviewPaths: string[]; observationRef?: string } {
  const raw = request.body.parties[role];
  const basePath = ptr('proposal', 'content', 'requests', request.id, 'body', 'parties', role);
  const namePath = ptr('proposal', 'content', 'requests', request.id, 'body', 'parties', role, 'name');
  const selectionPath = ptr('proposal', 'content', 'requests', request.id, 'body', 'parties', role, 'nativeSelectionRef');
  const partyLeaf = resolvedLeaf(draft, basePath, raw);
  if ('issue' in partyLeaf) return { reviewPaths: [], issue: `${role}_${partyLeaf.issue}` };
  const value = isNone(partyLeaf.value) ? null : record(partyLeaf.value);
  // Child name edits can create a party even when extraction supplied null or no party object.
  // An explicit parent clear still wins over stale child overrides.
  const allowChildName = !partyLeaf.overridden;
  const named = !value && !allowChildName
    ? { value: undefined, path: namePath }
    : resolvedLeaf(draft, namePath, value?.name);
  if ('issue' in named) return { reviewPaths: [], issue: `${role}_${named.issue}` };
  const name = cleanText(named.value);
  if (!name) {
    if (partyLeaf.value === undefined || isNone(partyLeaf.value)) {
      const explicitlyUnset = raw !== undefined || partyLeaf.overridden;
      const reviewPaths = execute && explicitlyUnset && !reviewAccepted(draft, basePath) ? [basePath] : [];
      return { reviewPaths };
    }
    return { reviewPaths: [], issue: `${role}_name_unresolved` };
  }
  const selected = resolvedLeaf(draft, selectionPath, value?.suggestedRef ?? null);
  if ('issue' in selected) return { reviewPaths: [], issue: `${role}_${selected.issue}` };
  const ref = typeof selected.value === 'string' ? selected.value : null;
  if (!ref) {
    const optionalByStaff = selected.unset && reviewAccepted(draft, basePath);
    return { reviewPaths: execute && !optionalByStaff ? [basePath] : [], issue: optionalByStaff ? undefined : `${role}_selection_required` };
  }
  const observation = draft.observations.find((entry) => entry.ref === ref && entry.kind === 'party_candidate');
  const criteria = record(observation?.criteria);
  const candidate = record(observation?.result);
  if (!observation || observation.status !== 'complete' || !observation.coverage.complete ||
      observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode ||
      observation.sourceMessageId !== draft.source.messageId || criteria?.workflow !== 'quote' ||
      criteria.requestId !== request.id || criteria.role !== role ||
      !sameName(criteria.searchName, name) || !candidate || !cleanText(candidate.nativeId) || !cleanText(candidate.name)) {
    return { reviewPaths: [], issue: `${role}_candidate_unverified` };
  }
  const reviewPaths = execute
    ? [basePath, namePath, selectionPath].filter((path) => !reviewAccepted(draft, path))
    : [];
  if (execute && reviewPaths.length) return { reviewPaths, issue: `${role}_requires_staff_acceptance` };
  return {
    party: { kind: role, nativeId: String(candidate.nativeId), name: String(candidate.name) },
    reviewPaths,
    observationRef: observation.ref,
  };
}

function sameName(left: unknown, right: unknown): boolean {
  return typeof left === 'string' && typeof right === 'string' &&
    left.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase() ===
      right.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function preparedQuoteMatches(input: z.infer<typeof staffQuoteInput>, value: unknown): boolean {
  const revision = record(value);
  const groups = Array.isArray(revision?.groups) ? revision.groups.map(record) : [];
  if (!revision || revision.propertyCode === undefined || revision.currency !== 'ZAR' ||
      revision.held !== false || groups.length !== input.groups.length ||
      typeof revision.totalMinor !== 'number' || !Number.isSafeInteger(revision.totalMinor) ||
      revision.totalMinor < 0) return false;
  for (const expected of input.groups) {
    const actual = groups.find((group) => group?.id === expected.id);
    const board = expected.board === 'bb' ? 'breakfast'
      : expected.board === 'dinner_bb' ? 'dinner_bed_breakfast' : 'room_only';
    if (!actual || actual.arrivalDate !== expected.arrivalDate || actual.departureDate !== expected.departureDate ||
        actual.quantity !== expected.quantity || actual.adults !== expected.adults ||
        actual.children !== expected.childrenAges.length || actual.board !== board ||
        JSON.stringify(actual.childAges) !== JSON.stringify(expected.childrenAges) ||
        (expected.roomCodes?.length && !expected.roomCodes.includes(String(actual.roomCode))) ||
        (expected.rateCode && actual.rateCode !== expected.rateCode)) return false;
  }
  return true;
}

type CompiledQuote = {
  status: 'ok';
  request: QuoteRequest;
  input: z.infer<typeof staffQuoteInput>;
  inputDigest: string;
  reviewPaths: string[];
  sourceRefs: string[];
  outputKinds: Array<'email_quote' | 'pdf_quote' | 'xlsx_quote'>;
} | {
  status: 'needs_input' | 'needs_review' | 'unsupported';
  issue: string;
  fields: string[];
};

function compileQuote(
  draft: ReservationWorkflowV2Draft,
  request: QuoteRequest,
  execute: boolean,
): CompiledQuote {
  const bodyPath = ['proposal', 'content', 'requests', request.id, 'body'] as const;
  const path = (...parts: Array<string | number>) => ptr(...bodyPath, ...parts);
  const issues: string[] = [];
  const reviewPaths = new Set<string>();
  const resolved = (fieldPath: string, sourceValue: unknown) => {
    const value = resolvedLeaf(draft, fieldPath, sourceValue);
    if ('issue' in value) issues.push(`${fieldPath}:${value.issue}`);
    else if (execute && value.value !== undefined && value.value !== null &&
        !(Array.isArray(value.value) && value.value.length === 0) &&
        !fieldPath.endsWith('/occupancy/scope') && !reviewAccepted(draft, fieldPath)) {
      reviewPaths.add(fieldPath);
    }
    return value;
  };

  if (request.body.provisionalBookingRequested !== false) issues.push(`${path('provisionalBookingRequested')}:separate_create_required`);
  if (!request.body.groups.length) issues.push(`${path('groups')}:group_required`);
  if (request.body.groups.length > 8) issues.push(`${path('groups')}:native_quote_group_limit`);
  if (request.body.requestedMoney.length) issues.push(`${path('requestedMoney')}:staff_priced_allowance_adapter_required`);

  const nativeGroups: Array<{
    id: string; arrivalDate: string; departureDate: string; quantity: number; adults: number;
    childrenAges: number[]; board: 'room_only' | 'bb' | 'dinner_bb'; roomCodes?: string[]; rateCode?: string;
  }> = [];
  const datePairs = new Set<string>();
  for (const [groupIndex, group] of request.body.groups.entries()) {
    const base = path('groups', groupIndex);
    if (group.id.length > 64) issues.push(`${base}/id:native_group_id_limit`);
    const dates = [
      resolved(path('groups', groupIndex, 'arrival'), group.arrival),
      resolved(path('groups', groupIndex, 'departure'), group.departure),
    ];
    const arrival = dates[0] && !('issue' in dates[0]) ? dates[0].value : null;
    const departure = dates[1] && !('issue' in dates[1]) ? dates[1].value : null;
    if (typeof arrival !== 'string' || !dateSchema.safeParse(arrival).success) issues.push(`${base}/arrival:valid_date_required`);
    if (typeof departure !== 'string' || !dateSchema.safeParse(departure).success) issues.push(`${base}/departure:valid_date_required`);
    if (typeof arrival === 'string' && typeof departure === 'string') {
      datePairs.add(`${arrival}/${departure}`);
      if (arrival >= departure) issues.push(`${base}:date_range_invalid`);
    }

    const quantityResult = resolved(path('groups', groupIndex, 'quantity'), group.quantity);
    const quantity = quantityResult && !('issue' in quantityResult) ? quantityResult.value : null;
    if (!Number.isInteger(quantity) || Number(quantity) < 1 || Number(quantity) > 100) issues.push(`${base}/quantity:valid_room_count_required`);

    const boardResult = resolved(path('groups', groupIndex, 'board'), group.board);
    const board = boardResult && !('issue' in boardResult) ? boardCode(boardResult.value) : null;
    if (!board) issues.push(`${base}/board:native_board_code_required`);

    const occupancy = group.occupancy;
    const scopePath = path('groups', groupIndex, 'occupancy', 'scope');
    const scopeResult = resolved(scopePath, occupancy.scope);
    const scope = scopeResult && !('issue' in scopeResult) ? scopeResult.value : null;
    const adultsResult = resolved(path('groups', groupIndex, 'occupancy', 'adults'), occupancy.adults);
    const adults = adultsResult && !('issue' in adultsResult) ? adultsResult.value : null;
    if (scope !== 'per_room') issues.push(`${base}/occupancy/scope:per_room_scenario_required`);
    if (!Number.isInteger(adults) || Number(adults) < 1 || Number(adults) > 6) issues.push(`${base}/occupancy/adults:valid_per_room_adults_required`);
    const countResult = resolved(path('groups', groupIndex, 'occupancy', 'childCount'), occupancy.childCount);
    const count = countResult && !('issue' in countResult) ? countResult.value : null;
    const agesResult = resolved(path('groups', groupIndex, 'occupancy', 'childAges'), occupancy.childAges);
    const ages = agesResult && !('issue' in agesResult) ? agesResult.value : null;
    let childrenAges: number[] | null = null;
    if (count === 0 && (ages === null || (Array.isArray(ages) && ages.length === 0))) childrenAges = [];
    else if (Number.isInteger(count) && Number(count) > 0 && Array.isArray(ages) && ages.length === Number(count) &&
        ages.every((age) => Number.isInteger(age) && Number(age) >= 0 && Number(age) <= 17)) {
      childrenAges = ages as number[];
    }
    if (childrenAges === null) issues.push(`${base}/occupancy:known_child_count_and_ages_required`);

    const roomCodesResult = resolved(path('groups', groupIndex, 'roomCodes'), group.roomCodes);
    const rawRoomCodes = roomCodesResult && !('issue' in roomCodesResult) ? roomCodesResult.value : null;
    let roomCodes: string[] | undefined;
    if (rawRoomCodes !== null && rawRoomCodes !== undefined) {
      if (!Array.isArray(rawRoomCodes) || rawRoomCodes.length > 8 ||
          rawRoomCodes.some((code) => !providerCode.safeParse(code).success)) {
        issues.push(`${base}/roomCodes:native_room_codes_required`);
      } else if (rawRoomCodes.length) roomCodes = rawRoomCodes as string[];
    }
    const rateResult = resolved(path('groups', groupIndex, 'ratePlan'), group.ratePlan);
    const rawRate = rateResult && !('issue' in rateResult) ? rateResult.value : null;
    let rateCode: string | undefined;
    if (rawRate !== null && rawRate !== undefined) {
      if (typeof rawRate !== 'string' || !providerCode.safeParse(rawRate).success) issues.push(`${base}/ratePlan:native_rate_code_required`);
      else rateCode = rawRate;
    }
    if (typeof arrival === 'string' && typeof departure === 'string' && Number.isInteger(quantity) &&
        Number.isInteger(adults) && childrenAges && board) {
      nativeGroups.push({ id: group.id, arrivalDate: arrival, departureDate: departure,
        quantity: Number(quantity), adults: Number(adults), childrenAges, board,
        ...(roomCodes ? { roomCodes } : {}), ...(rateCode ? { rateCode } : {}) });
    }
  }
  if (datePairs.size > 1) issues.push(`${path('groups')}:separate_quote_runs_required`);
  if (new Set(nativeGroups.map((group) => group.id)).size !== nativeGroups.length) {
    issues.push(`${path('groups')}:duplicate_group_id`);
  }

  const company = selectedParty(draft, request, 'company', execute);
  const agency = selectedParty(draft, request, 'agency', execute);
  for (const selected of [company, agency]) {
    if (selected.issue) issues.push(selected.issue);
    selected.reviewPaths.forEach((item) => reviewPaths.add(item));
  }
  const strategyPath = path('salesStrategy');
  const strategyResult = resolved(strategyPath, request.body.salesStrategy);
  const rawStrategy = strategyResult && !('issue' in strategyResult) ? strategyResult.value : null;
  const strategy = typeof rawStrategy === 'string' ? rawStrategy.trim() : '';
  const strategies = new Set(['BAR', 'PROMO', 'PRESET', 'WS', 'NC', 'GOV', 'AIR', 'DOML', 'OTHER', 'Government']);
  if (!strategies.has(strategy)) issues.push(`${strategyPath}:supported_sales_strategy_required`);

  const attentionPath = path('client', 'attention');
  const emailPath = path('client', 'email');
  const phonePath = path('client', 'telephone');
  const attentionResult = resolved(attentionPath, request.body.client.attention);
  const emailResult = resolved(emailPath, request.body.client.email);
  const phoneResult = resolved(phonePath, request.body.client.telephone);
  const attention = attentionResult && !('issue' in attentionResult) ? cleanText(attentionResult.value) ?? '' : '';
  const clientEmail = emailResult && !('issue' in emailResult) ? cleanText(emailResult.value) ?? '' : '';
  const clientTelephone = phoneResult && !('issue' in phoneResult) ? cleanText(phoneResult.value) ?? '' : '';
  const notesPath = path('notes');
  const notesResult = resolved(notesPath, request.body.notes);
  const notes = notesResult && !('issue' in notesResult) ? cleanText(notesResult.value) ?? undefined : undefined;
  if (notes && notes.length > 1000) issues.push(`${notesPath}:native_note_limit`);
  const outputPath = path('outputIntent', 'artifacts');
  const outputResult = resolved(outputPath, request.body.outputIntent.artifacts);
  const rawOutputKinds = outputResult && !('issue' in outputResult) ? outputResult.value : null;
  const outputAllowed = new Set(['email_quote', 'pdf_quote', 'xlsx_quote']);
  const outputKinds = Array.isArray(rawOutputKinds)
    ? [...new Set(rawOutputKinds.filter((kind): kind is 'email_quote' | 'pdf_quote' | 'xlsx_quote' =>
      typeof kind === 'string' && outputAllowed.has(kind)))]
    : [];
  if (Array.isArray(rawOutputKinds) && outputKinds.length !== rawOutputKinds.length) {
    issues.push(`${outputPath}:unsupported_artifact_kind`);
  }
  if (!outputKinds.length) issues.push(`${path('outputIntent', 'artifacts')}:output_required`);
  if (outputKinds.includes('email_quote') && !clientEmail) issues.push(`${emailPath}:recipient_required_for_cover`);
  if (outputKinds.includes('email_quote') && !outputKinds.some((kind) => kind === 'pdf_quote' || kind === 'xlsx_quote')) {
    issues.push(`${outputPath}:email_attachment_required`);
  }

  if (issues.length) {
    const unsupported = issues.some((issue) => /unsupported|separate_create_required|separate_quote_runs_required|staff_priced_allowance_adapter_required/u.test(issue));
    return { status: unsupported ? 'unsupported' : reviewPaths.size ? 'needs_review' : 'needs_input',
      issue: unsupported ? 'quote_native_scope_unsupported' : reviewPaths.size ? 'quote_requires_staff_acceptance' : 'quote_inputs_incomplete',
      fields: [...new Set([...issues, ...reviewPaths])] };
  }
  if (execute && reviewPaths.size) {
    return { status: 'needs_review', issue: 'quote_requires_staff_acceptance', fields: [...reviewPaths] };
  }

  const parties = {
    ...(company.party ? { company: company.party } : {}),
    ...(agency.party ? { agency: agency.party } : {}),
  };
  const nativeInput = {
    messageId: draft.source.messageId,
    sourceHash: draft.source.sourceHash,
    selectionEpoch: draft.revision,
    inputRevision: draft.revision,
    groups: nativeGroups,
    salesStrategy: strategy,
    company: company.party?.name ?? '',
    agency: agency.party?.name ?? '',
    attention,
    clientEmail,
    clientTelephone,
    ...(notes ? { notes } : {}),
    ...(Object.keys(parties).length ? { parties } : {}),
  };
  const parsedInput = staffQuoteInput.safeParse(nativeInput);
  if (!parsedInput.success) {
    return { status: 'needs_input', issue: 'quote_inputs_outside_native_limits',
      fields: parsedInput.error.issues.map((item) => item.path.join('.')) };
  }
  const input = parsedInput.data;
  const sourceRefs = [...new Set([
    ...request.sourceRefs,
    ...request.body.groups.flatMap((group) => group.priceObservationRefs),
    ...request.body.outputIntent.evidenceRefs,
    ...(company.observationRef ? [company.observationRef] : []),
    ...(agency.observationRef ? [agency.observationRef] : []),
  ])].filter((ref) => draft.observations.some((observation) => observation.ref === ref));
  return {
    status: 'ok', request, input,
    // Staff acknowledgement advances pane revisions without changing quote scope.
    inputDigest: hash({ sourceHash: draft.source.sourceHash, requestId: request.id,
      input: { ...input, selectionEpoch: 0, inputRevision: 0 } }),
    reviewPaths: [...reviewPaths], sourceRefs, outputKinds,
  };
}

async function quoteTarget(ctx: ReservationWorkflowV2QuoteContext, input: QuoteBaseInput) {
  try {
    const result = await resolveHmsQuoteJobTarget({
      transportId: ctx.transport.id,
      threadId: input.source.threadId,
      messageId: input.source.messageId,
    });
    if (!result.ok) return { target: null, issue: 'quote_property_not_enabled' };
    if (result.target.propertyCode !== ctx.property.propertyCode) return { target: null, issue: 'quote_property_scope_mismatch' };
    return { target: result.target, issue: null };
  } catch {
    return { target: null, issue: 'quote_property_unavailable' };
  }
}

function quoteObservation(
  draft: ReservationWorkflowV2Draft,
  compiled: Extract<CompiledQuote, { status: 'ok' }>,
  result: QuoteRunResult,
  operationId: string | null,
): ReservationWorkflowV2Observation {
  const prepared = record(result.preparedProposal);
  const revision = record(prepared?.revision);
  const freshUntil = typeof result.freshUntil === 'string' ? Date.parse(result.freshUntil) : Number.NaN;
  const validRevision = revision?.propertyCode === draft.propertyCode &&
    prepared?.sourceHash === draft.source.sourceHash && preparedQuoteMatches(compiled.input, revision) &&
    Number.isFinite(freshUntil) && freshUntil > Date.now();
  const inputDigest = compiled.inputDigest;
  const runResult = {
    workflowRunId: result.workflowRunId ?? null,
    revisionRef: result.revisionRef ?? null,
    inputDigest,
    sourceHash: draft.source.sourceHash,
    nativeInputDigest: result.inputDigest ?? null,
    inputOverrides: quoteInputOverrides(draft, compiled.request.id),
    observedAt: new Date().toISOString(),
    freshUntil: result.freshUntil ?? null,
    totalMinor: result.totalMinor ?? null,
    currency: result.currency ?? null,
    arrivalDate: result.arrivalDate ?? null,
    departureDate: result.departureDate ?? null,
    rowRates: result.rowRates ?? [],
    rateOptions: result.rateOptions ?? [],
    availabilityBoard: result.availabilityBoard ?? [],
    extrasReviewItems: Array.isArray(result.extrasReviewItems)
      ? result.extrasReviewItems.filter((item): item is string => typeof item === 'string') : [],
    revision,
    facts: prepared?.facts ?? null,
    rowPrices: prepared?.rowPrices ?? [],
  };
  return {
    ref: randomUUID(), generationId: draft.generationId, kind: 'rate_availability',
    status: validRevision ? 'complete' : 'partial',
    observedAt: new Date().toISOString(), propertyCode: draft.propertyCode,
    sourceMessageId: draft.source.messageId, sourceRefs: compiled.sourceRefs,
    criteria: { workflow: 'quote', requestId: compiled.request.id, inputDigest, sourceHash: draft.source.sourceHash,
      operationId, nativeRevisionRef: result.revisionRef ?? null },
    coverage: { complete: Boolean(result.status === 'ready' && validRevision),
      notes: validRevision ? [] : [Number.isFinite(freshUntil) && freshUntil <= Date.now()
        ? 'native_quote_price_expired' : 'native_quote_business_fields_did_not_match_request'] },
    result: runResult,
  };
}

function matchingPreparedQuote(
  draft: ReservationWorkflowV2Draft,
  compiled: Extract<CompiledQuote, { status: 'ok' }>,
) {
  const now = Date.now();
  return [...draft.observations].reverse().find((observation) => {
    if (observation.kind !== 'rate_availability' || observation.status !== 'complete' || !observation.coverage.complete ||
        observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode ||
        observation.sourceMessageId !== draft.source.messageId) return false;
    const criteria = record(observation.criteria), result = record(observation.result);
    const revision = record(result?.revision);
    const expires = typeof result?.freshUntil === 'string' ? Date.parse(result.freshUntil) : Number.NaN;
    return criteria?.workflow === 'quote' && criteria.requestId === compiled.request.id &&
      criteria.inputDigest === compiled.inputDigest &&
      criteria.sourceHash === draft.source.sourceHash &&
      Number.isFinite(expires) && expires > now && revision?.propertyCode === draft.propertyCode &&
      preparedQuoteMatches(compiled.input, revision);
  });
}

async function persistObservation(
  ctx: ReservationWorkflowV2QuoteContext,
  input: QuoteBaseInput,
  observation: ReservationWorkflowV2Observation,
  operation?: QuoteOperationResult,
  options: { allowRevisionAdvance?: boolean } = {},
) {
  const current = await getReservationWorkflowV2Draft(stateContext(ctx), { workItemId: input.workItemId, source: input.source });
  if (current.status !== 'ok') return current;
  if (current.draft.generationId !== observation.generationId ||
      (!options.allowRevisionAdvance &&
        (current.revision !== input.expectedRevision || current.seq !== input.expectedSeq))) {
    return { status: 'stale_revision' as const };
  }
  const appended = await appendReservationWorkflowV2Observation(stateContext(ctx), {
    workItemId: input.workItemId, source: input.source, observation,
  });
  if (appended.status !== 'ok' || !operation) return appended;
  return recordReservationWorkflowV2Result(stateContext(ctx), {
    workItemId: input.workItemId, source: input.source, result: operation,
  });
}

async function persistResult(
  ctx: ReservationWorkflowV2QuoteContext,
  input: QuoteBaseInput,
  generationId: string,
  result: QuoteOperationResult,
) {
  const current = await getReservationWorkflowV2Draft(stateContext(ctx), {
    workItemId: input.workItemId, source: input.source,
  });
  if (current.status !== 'ok') return current;
  if (current.revision !== input.expectedRevision || current.seq !== input.expectedSeq ||
      current.draft.generationId !== generationId) return { status: 'stale_revision' as const };
  return recordReservationWorkflowV2Result(stateContext(ctx), {
    workItemId: input.workItemId, source: input.source, result,
  });
}

function operationResults(draft: ReservationWorkflowV2Draft): QuoteOperationResult[] {
  return draft.operationResults.filter((result): result is QuoteOperationResult =>
    result.workflow === 'quote' && result.allocationId === null);
}

function operationObservation(draft: ReservationWorkflowV2Draft, operationId: string) {
  return [...draft.observations].reverse().find((observation) =>
    observation.kind === 'document' && record(observation.criteria)?.operationId === operationId);
}

function operationResult(
  draft: ReservationWorkflowV2Draft,
  requestId: string,
  id: string,
  status: QuoteOperationResult['status'],
  refs: string[],
  summary: string,
): QuoteOperationResult {
  return { id, generationId: draft.generationId, requestId, allocationId: null, workflow: 'quote', status,
    draftRevision: draft.revision, observationRefs: refs, updatedAt: new Date().toISOString(), summary };
}

function pricePayload(observation: ReservationWorkflowV2Observation) {
  const result = record(observation.result) ?? {};
  const extrasReviewItems = Array.isArray(result.extrasReviewItems)
    ? result.extrasReviewItems.filter((item): item is string => typeof item === 'string') : [];
  const requestId = cleanText(record(observation.criteria)?.requestId);
  return {
    observationRef: observation.ref,
    workflowRunId: result.workflowRunId,
    revisionRef: result.revisionRef,
    totalMinor: result.totalMinor,
    currency: result.currency,
    arrivalDate: result.arrivalDate,
    departureDate: result.departureDate,
    freshUntil: result.freshUntil,
    rowRates: result.rowRates,
    rateOptions: result.rateOptions,
    availabilityBoard: result.availabilityBoard,
    extrasReviewItems,
    ...(extrasReviewItems.length && requestId ? { extrasReviewPath: quoteBodyPath(requestId) } : {}),
  };
}

async function priceQuote(
  ctx: ReservationWorkflowV2QuoteContext,
  input: QuoteBaseInput,
  draft: ReservationWorkflowV2Draft,
  compiled: Extract<CompiledQuote, { status: 'ok' }>,
) {
  let quote: QuoteRunResult;
  try {
    quote = await runStaffQuote(compiled.input, { transportId: ctx.transport.id }, ctx.db) as unknown as QuoteRunResult;
  } catch {
    const failure: ReservationWorkflowV2Observation = {
      ref: randomUUID(), generationId: draft.generationId, kind: 'rate_availability', status: 'failed',
      observedAt: new Date().toISOString(), propertyCode: draft.propertyCode, sourceMessageId: draft.source.messageId,
      sourceRefs: compiled.sourceRefs,
      criteria: { workflow: 'quote', requestId: compiled.request.id, inputDigest: compiled.inputDigest,
        sourceHash: draft.source.sourceHash, operationId: null },
      coverage: { complete: false, notes: ['native_quote_price_unavailable'] },
      result: { issue: 'native_quote_price_unavailable', sourceHash: draft.source.sourceHash,
        inputDigest: compiled.inputDigest, observedAt: new Date().toISOString() },
    };
    const saved = await persistObservation(ctx, input, failure);
    return saved.status === 'ok'
      ? { status: 'failed' as const, issue: 'native_quote_price_unavailable', observationRef: failure.ref }
      : saved;
  }
  const observation = quoteObservation(draft, compiled, quote, null);
  const saved = await persistObservation(ctx, input, observation);
  if (saved.status !== 'ok') return saved;
  if (!observation.coverage.complete) return { status: 'failed' as const,
    issue: quote.status !== 'ready' ? 'native_quote_price_unavailable'
      : observation.coverage.notes[0] === 'native_quote_price_expired'
        ? 'native_quote_price_expired' : 'native_quote_business_fields_did_not_match_request',
    observationRef: observation.ref };
  return { status: 'priced' as const, observationRef: observation.ref, observation,
    quote: pricePayload(observation), revision: saved.revision, seq: saved.seq };
}

async function lookupPartyCandidates(
  ctx: ReservationWorkflowV2QuoteContext,
  input: QuoteBaseInput,
  draft: ReservationWorkflowV2Draft,
  request: QuoteRequest,
) {
  const target = await quoteTarget(ctx, input);
  if (!target.target) return { status: 'unsupported', issue: target.issue, candidates: [] as unknown[] };
  const candidates: Array<Record<string, unknown>> = [];
  for (const role of ['company', 'agency'] as const) {
    const basePath = ptr('proposal', 'content', 'requests', request.id, 'body', 'parties', role);
    const partyLeaf = resolvedLeaf(draft, basePath, request.body.parties[role]);
    const party = !('issue' in partyLeaf) ? record(partyLeaf.value) : null;
    const namePath = ptr('proposal', 'content', 'requests', request.id, 'body', 'parties', role, 'name');
    const resolvedName = resolvedLeaf(draft, namePath, party?.name);
    const name = !('issue' in partyLeaf) && !('issue' in resolvedName) ? cleanText(resolvedName.value) : null;
    if (!name) continue;
    const prior = draft.observations.filter((entry) => {
      const criteria = record(entry.criteria);
      return entry.kind === 'party_candidate' && entry.generationId === draft.generationId &&
        entry.propertyCode === draft.propertyCode && entry.sourceMessageId === draft.source.messageId &&
        criteria?.workflow === 'quote' && criteria.requestId === request.id && criteria.role === role &&
        sameName(criteria.searchName, name);
    });
    const reusable = prior.filter((entry) => entry.status === 'complete' && entry.coverage.complete);
    if (reusable.length) {
      candidates.push(...reusable.map((entry) => ({
        ...entry.result, ref: entry.ref,
      })));
      continue;
    }
    let found: Awaited<ReturnType<typeof findParty>>;
    try {
      found = await findParty({ kind: role, name }, { target: target.target });
    } catch {
      const observation: ReservationWorkflowV2Observation = {
        ref: randomUUID(), generationId: draft.generationId, kind: 'party_candidate', status: 'failed',
        observedAt: new Date().toISOString(), propertyCode: draft.propertyCode,
        sourceMessageId: draft.source.messageId,
        sourceRefs: (Array.isArray(party?.candidateRefs) ? party.candidateRefs : [])
          .filter((ref): ref is string => typeof ref === 'string' && draft.observations.some((entry) => entry.ref === ref)),
        criteria: { workflow: 'quote', requestId: request.id, role, searchName: name,
          fieldPath: ptr('proposal', 'content', 'requests', request.id, 'body', 'parties', role, 'nativeSelectionRef') },
        coverage: { complete: false, notes: ['native_party_search_failed'] },
        result: { issue: 'native_party_search_failed', searchedFor: name, candidates: [] },
      };
      const saved = await persistObservation(ctx, input, observation);
      return saved.status === 'ok'
        ? { status: 'failed', issue: 'native_party_search_failed', candidates }
        : { status: saved.status, issue: 'party_lookup_result_not_persisted', candidates };
    }
    const answered = ['resolved', 'ambiguous', 'no_match'].includes(found.outcome) && !found.truncated;
    const rows = found.results.map((row) => ({ ...row, ref: randomUUID() }));
    for (const row of rows) {
      const observation: ReservationWorkflowV2Observation = {
        ref: String(row.ref), generationId: draft.generationId, kind: 'party_candidate',
        status: answered ? 'complete' : 'partial', observedAt: new Date().toISOString(),
        propertyCode: draft.propertyCode, sourceMessageId: draft.source.messageId,
        sourceRefs: (Array.isArray(party?.candidateRefs) ? party.candidateRefs : [])
          .filter((ref): ref is string => typeof ref === 'string' && draft.observations.some((entry) => entry.ref === ref)),
        criteria: { workflow: 'quote', requestId: request.id, role, searchName: name,
          fieldPath: ptr('proposal', 'content', 'requests', request.id, 'body', 'parties', role, 'nativeSelectionRef') },
        coverage: { complete: answered, notes: answered ? [] : ['native_party_search_incomplete'] },
        result: { nativeId: row.nativeId, name: row.name, kind: role, outcome: found.outcome,
          searchedFor: found.searchedFor, truncated: found.truncated },
      };
      const saved = await persistObservation(ctx, input, observation);
      if (saved.status !== 'ok') return { status: saved.status, issue: 'party_lookup_result_not_persisted', candidates };
      candidates.push({ ...row, outcome: found.outcome, searchedFor: found.searchedFor, truncated: found.truncated });
    }
    if (!rows.length) {
      const observation: ReservationWorkflowV2Observation = {
        ref: randomUUID(), generationId: draft.generationId, kind: 'party_candidate',
        status: answered ? 'complete' : 'failed', observedAt: new Date().toISOString(),
        propertyCode: draft.propertyCode, sourceMessageId: draft.source.messageId, sourceRefs: [],
        criteria: { workflow: 'quote', requestId: request.id, role, searchName: name,
          fieldPath: ptr('proposal', 'content', 'requests', request.id, 'body', 'parties', role, 'nativeSelectionRef') },
        coverage: { complete: answered, notes: answered ? [] : ['native_party_search_incomplete'] },
        result: { outcome: found.outcome, searchedFor: found.searchedFor, truncated: found.truncated, candidates: [] },
      };
      const saved = await persistObservation(ctx, input, observation);
      if (saved.status !== 'ok') return { status: saved.status, issue: 'party_lookup_result_not_persisted', candidates };
    }
  }
  return { status: 'ok', candidates };
}

/** Read source-scoped native party choices and, when inputs resolve, current HMS quote availability. */
export async function reservationWorkflowV2QuoteLookup(
  ctx: ReservationWorkflowV2QuoteContext,
  input: ReservationWorkflowV2QuoteLookupInput,
): Promise<Outcome> {
  const loaded = await loadCurrent(ctx, input);
  if (!loaded.draft) return loaded.result;
  const requests = quoteRequests(loaded.draft, input.requestId);
  if (input.requestId && !requests.length) return { status: 'not_found' };
  if (!requests.length) return { status: 'needs_input', issue: 'quote_request_required' };
  const results: Outcome[] = [];
  for (const request of requests) {
    const parties = await lookupPartyCandidates(ctx, input, loaded.draft, request);
    if (parties.status !== 'ok') {
      results.push({ ...parties, requestId: request.id });
      continue;
    }
    const compiled = compileQuote(loaded.draft, request, false);
    if (compiled.status !== 'ok') {
      results.push({ status: compiled.status, requestId: request.id, issue: compiled.issue, fields: compiled.fields,
        partyCandidates: parties.candidates });
      continue;
    }
    const existing = matchingPreparedQuote(loaded.draft, compiled);
    if (existing) {
      results.push({ status: 'priced', requestId: request.id, quote: pricePayload(existing),
        partyCandidates: parties.candidates });
      continue;
    }
    try {
      const priced = await priceQuote(ctx, input, loaded.draft, compiled);
      results.push({ ...priced, requestId: request.id, partyCandidates: parties.candidates });
    } catch {
      results.push({ status: 'failed', requestId: request.id, issue: 'native_quote_price_unavailable',
        partyCandidates: parties.candidates });
    }
  }
  const current = await getReservationWorkflowV2Draft(stateContext(ctx), { workItemId: input.workItemId, source: input.source });
  return current.status === 'ok'
    ? { status: 'ok', revision: current.revision, seq: current.seq, quotes: results,
        observations: current.draft.observations, operationResults: operationResults(current.draft) }
    : current;
}

/** Prepare reuses a still-current native price; otherwise it repeats the existing read-only quote run. */
export async function reservationWorkflowV2QuotePrepare(
  ctx: ReservationWorkflowV2QuoteContext,
  input: ReservationWorkflowV2QuotePrepareInput,
): Promise<Outcome> {
  const loaded = await loadCurrent(ctx, input);
  if (!loaded.draft) return loaded.result;
  const request = quoteRequests(loaded.draft, input.requestId)[0];
  if (!request) return { status: 'not_found' };
  const compiled = compileQuote(loaded.draft, request, false);
  if (compiled.status !== 'ok') return { status: compiled.status, issue: compiled.issue, fields: compiled.fields };
  const existing = matchingPreparedQuote(loaded.draft, compiled);
  if (existing) {
    // Preserve the native capture time/expiry while binding reused pricing to current inputs.
    const refreshed: ReservationWorkflowV2Observation = { ...existing, ref: randomUUID(),
      result: { ...existing.result, inputOverrides: quoteInputOverrides(loaded.draft, request.id) } };
    const result = operationResult(loaded.draft, request.id, randomUUID(), 'prepared', [refreshed.ref],
      'Current HMS quote price and availability prepared; no reservation or email created');
    const saved = await persistObservation(ctx, input, refreshed, result);
    return saved.status === 'ok' ? { status: 'prepared', requestId: request.id, operationId: result.id,
      quote: pricePayload(refreshed), observationRef: refreshed.ref } : saved;
  }
  try {
    const priced = await priceQuote(ctx, input, loaded.draft, compiled);
    if (priced.status !== 'priced') return priced;
    const observation = priced.observation;
    if (!observation) return { status: 'failed', issue: 'quote_price_observation_missing' };
    const result = operationResult(loaded.draft, request.id, randomUUID(), 'prepared', [observation.ref],
      'Current HMS quote price and availability prepared; no reservation or email created');
    const saved = await persistResult(ctx, input, loaded.draft.generationId, result);
    return saved.status === 'ok' ? { status: 'prepared', requestId: request.id, operationId: result.id,
      quote: pricePayload(observation), observationRef: observation.ref } : saved;
  } catch {
    return { status: 'failed', issue: 'native_quote_prepare_failed' };
  }
}

function makeCoverEmail(to: string) {
  return {
    to,
    subject: 'Your quotation',
    body: 'Good day,\n\nPlease find our quotation attached. No reservation has been made. Please reply if you would like to proceed.\n\nKind regards,',
  };
}

async function quoteArtifacts(
  ctx: ReservationWorkflowV2QuoteContext,
  compiled: Extract<CompiledQuote, { status: 'ok' }>,
  preparedObservation: ReservationWorkflowV2Observation,
) {
  const prepared = record(preparedObservation.result);
  const revision = record(prepared?.revision) as unknown as QuoteRevision | null;
  const criteria = record(preparedObservation.criteria);
  if (!revision || revision.propertyCode !== ctx.property.propertyCode ||
      criteria?.workflow !== 'quote' || criteria.inputDigest !== compiled.inputDigest ||
      criteria.sourceHash !== compiled.input.sourceHash || !preparedQuoteMatches(compiled.input, revision)) {
    throw new Error('prepared_quote_revision_invalid');
  }
  const facts = record(prepared?.facts) as unknown as AuthorizedProposalFacts | null;
  const rowPrices = Array.isArray(prepared?.rowPrices) ? prepared!.rowPrices as RowPrice[] : [];
  const stays: WorkbookStay[] = [{ revision, ...(facts ? { facts } : {}), ...(rowPrices.length ? { rowPrices } : {}) }];
  const [actor] = await ctx.db.select({ name: user.name, email: user.email }).from(user)
    .where(eq(user.id, ctx.user.id)).limit(1);
  if (!actor) throw new Error('quote_actor_unavailable');
  const header = {
    attention: compiled.input.attention,
    // HMS party still scopes the native rate; the client company is deliberately omitted from quote covers.
    company: '',
    clientEmail: compiled.input.clientEmail,
    clientTelephone: compiled.input.clientTelephone,
    signerName: actor.name,
    signerEmail: actor.email,
  };
  const artifacts: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  const group = compiled.input.groups[0]!;
  if (compiled.outputKinds.includes('xlsx_quote')) {
    try {
      const workbook = quoteWorkbookForStays({ stays, header, note: compiled.input.notes });
      const bytes = Buffer.from(workbook.bytes);
      artifacts.push({ kind: 'xlsx_quote', fileName: quoteWorkbookFileName(compiled.input.agency || compiled.input.company,
        group.arrivalDate, group.departureDate), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, bytesBase64: bytes.toString('base64'),
        totalMinor: workbook.totalMinor, currency: revision.currency });
    } catch {
      failures.push('xlsx_generation_failed');
    }
  }
  if (compiled.outputKinds.includes('pdf_quote')) {
    const gotenbergUrl = process.env.GOTENBERG_URL?.trim();
    if (!gotenbergUrl) failures.push('pdf_converter_unavailable');
    else {
      try {
        const pdf = await buildStaysProposalPdf(stays, { ...header, agency: compiled.input.agency, notes: compiled.input.notes },
          { url: gotenbergUrl });
        const bytes = Buffer.from(pdf.pdf);
        artifacts.push({ kind: 'pdf_quote', fileName: pdf.fileName, mimeType: 'application/pdf',
          sha256: pdf.pdfHash, sizeBytes: bytes.length, bytesBase64: bytes.toString('base64'),
          totalMinor: pdf.totalMinor, currency: revision.currency });
      } catch {
        failures.push('pdf_generation_failed');
      }
    }
  }
  const coverEmail = compiled.outputKinds.includes('email_quote') ? makeCoverEmail(compiled.input.clientEmail) : null;
  return { artifacts, failures, coverEmail, revisionRef: revision.id,
    sourceHash: compiled.input.sourceHash, nativeInputDigest: prepared?.nativeInputDigest ?? null,
    preparedObservationRef: preparedObservation.ref, workflowRunId: prepared?.workflowRunId ?? null,
    claims: compiled.input.groups.map((entry) => ({ groupId: entry.id, arrivalDate: entry.arrivalDate,
      departureDate: entry.departureDate, quantity: entry.quantity, board: entry.board, adultsPerRoom: entry.adults,
      childAgesPerRoom: entry.childrenAges })),
    companyShownInCover: false as const };
}

/** Go creates only unsent quote artifacts, persisting their bytes and provenance on the WorkItem outside Undo. */
export async function reservationWorkflowV2QuoteExecute(
  ctx: ReservationWorkflowV2QuoteContext,
  input: ReservationWorkflowV2QuoteExecuteInput,
): Promise<Outcome> {
  if (input.go !== true || !z.string().uuid().safeParse(input.idempotencyKey).success) {
    return { status: 'invalid_input', issue: 'explicit_go_and_uuid_required' };
  }
  const loaded = await loadCurrent(ctx, input);
  if (!loaded.draft) return loaded.result;
  const request = quoteRequests(loaded.draft, input.requestId)[0];
  if (!request) return { status: 'not_found' };
  const prior = operationResults(loaded.draft).find((result) => result.id === input.idempotencyKey);
  if (prior && prior.requestId !== request.id) return { status: 'idempotency_conflict' };
  if (prior?.status === 'succeeded' || prior?.status === 'failed') {
    const observation = operationObservation(loaded.draft, prior.id);
    return { status: prior.status, operationId: prior.id, summary: prior.summary,
      observationRef: observation?.ref, artifacts: record(observation?.result)?.artifacts ?? [],
      coverEmail: record(observation?.result)?.coverEmail };
  }
  if (prior?.status === 'unknown') return { status: 'needs_reconcile', operationId: prior.id };
  const compiled = compileQuote(loaded.draft, request, true);
  if (compiled.status !== 'ok') return { status: compiled.status, issue: compiled.issue, fields: compiled.fields };
  const preparedObservation = matchingPreparedQuote(loaded.draft, compiled);
  if (!preparedObservation) return { status: 'needs_prepare', issue: 'current_native_quote_prepare_required' };
  const quoteResult = record(preparedObservation.result);
  const prepared = record(quoteResult?.revision);
  if (!prepared || quoteResult?.sourceHash && quoteResult.sourceHash !== input.source.sourceHash) {
    return { status: 'needs_prepare', issue: 'prepared_quote_source_changed' };
  }
  const rawExtrasReviewItems = quoteResult?.extrasReviewItems;
  const extrasReviewItems = Array.isArray(rawExtrasReviewItems)
    ? rawExtrasReviewItems.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
  const extrasReviewPath = quoteBodyPath(request.id);
  const extrasReview = loaded.draft.staffReviews[extrasReviewPath];
  const extrasAccepted = extrasReview?.status === 'accepted' &&
    Date.parse(extrasReview.at ?? '') >= Date.parse(preparedObservation.observedAt);
  if (extrasReviewItems.length && !extrasAccepted) {
    return { status: 'needs_review', issue: 'quote_extras_require_staff_acceptance',
      fields: [extrasReviewPath], extrasReviewItems, extrasReviewPath };
  }
  const result = operationResult(loaded.draft, request.id, input.idempotencyKey, 'unknown', [],
    'Quote output generation started; no reservation save or email send is performed');
  const marked = await persistResult(ctx, input, loaded.draft.generationId, result);
  if (marked.status !== 'ok') return marked;

  let generated: Awaited<ReturnType<typeof quoteArtifacts>>;
  try {
    generated = await quoteArtifacts(ctx, compiled, preparedObservation);
  } catch {
    const failureObservation: ReservationWorkflowV2Observation = {
      ref: randomUUID(), generationId: loaded.draft.generationId, kind: 'document', status: 'failed',
      observedAt: new Date().toISOString(), propertyCode: loaded.draft.propertyCode,
      sourceMessageId: loaded.draft.source.messageId, sourceRefs: [preparedObservation.ref],
      criteria: { workflow: 'quote', requestId: request.id, inputDigest: compiled.inputDigest,
        operationId: input.idempotencyKey },
      coverage: { complete: false, notes: ['quote_artifact_generation_failed'] },
      result: { artifacts: [], failures: ['quote_artifact_generation_failed'], emailSent: false, reservationSaved: false },
    };
    const failure = operationResult(loaded.draft, request.id, input.idempotencyKey, 'failed', [failureObservation.ref],
      'Quote artifact generation failed; no reservation saved and no email sent');
    const saved = await persistObservation(ctx, input, failureObservation, failure, { allowRevisionAdvance: true });
    return saved.status === 'ok' ? { status: 'failed', operationId: input.idempotencyKey,
      issue: 'quote_artifact_generation_failed', observationRef: failureObservation.ref } : saved;
  }
  const complete = generated.failures.length === 0;
  const observation: ReservationWorkflowV2Observation = {
    ref: randomUUID(), generationId: loaded.draft.generationId, kind: 'document',
    status: complete ? 'complete' : generated.artifacts.length ? 'partial' : 'failed',
    observedAt: new Date().toISOString(), propertyCode: loaded.draft.propertyCode,
    sourceMessageId: loaded.draft.source.messageId,
    sourceRefs: [...new Set([preparedObservation.ref, ...compiled.sourceRefs])],
    criteria: { workflow: 'quote', requestId: request.id, inputDigest: compiled.inputDigest,
      operationId: input.idempotencyKey, actorUserId: ctx.user.id },
    coverage: { complete, notes: generated.failures },
    result: { ...generated, emailSent: false, reservationSaved: false },
  };
  const final = operationResult(loaded.draft, request.id, input.idempotencyKey,
    complete ? 'succeeded' : 'failed', [observation.ref],
    complete ? `Generated ${generated.artifacts.length} unsent quote artifact(s); no reservation saved or email sent`
      : `Generated ${generated.artifacts.length} artifact(s); some requested outputs failed, no reservation saved or email sent`);
  const saved = await persistObservation(ctx, input, observation, final, { allowRevisionAdvance: true });
  return saved.status === 'ok'
    ? { status: complete ? 'succeeded' : generated.artifacts.length ? 'partial' : 'failed',
        operationId: input.idempotencyKey, observationRef: observation.ref, summary: final.summary,
        artifacts: generated.artifacts, coverEmail: generated.coverEmail, failures: generated.failures,
        emailSent: false, reservationSaved: false }
    : saved;
}

/** Positive-only recovery: durable artifact receipts are replayed; absent receipts never trigger a fresh HMS action. */
export async function reservationWorkflowV2QuoteReconcile(
  ctx: ReservationWorkflowV2QuoteContext,
  input: ReservationWorkflowV2QuoteReconcileInput,
): Promise<Outcome> {
  const loaded = await loadCurrent(ctx, input);
  if (!loaded.draft) return loaded.result;
  const result = operationResults(loaded.draft).find((entry) => entry.id === input.operationId);
  if (!result) return { status: 'not_found' };
  if (result.status === 'prepared') return { status: 'prepared', operationId: result.id,
    summary: result.summary, observationRefs: result.observationRefs };
  const observation = operationObservation(loaded.draft, result.id);
  if (observation && result.status === 'unknown') {
    const payload = record(observation.result) ?? {};
    const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
    const hashesValid = artifacts.length > 0 && artifacts.every((raw) => {
      const artifact = record(raw);
      const encoded = typeof artifact?.bytesBase64 === 'string' ? artifact.bytesBase64 : null;
      if (!encoded || !artifact) return false;
      const bytes = Buffer.from(encoded, 'base64');
      return bytes.length > 0 && bytes.toString('base64') === encoded &&
        Number.isSafeInteger(artifact.sizeBytes) && artifact.sizeBytes === bytes.length &&
        artifact.sha256 === createHash('sha256').update(bytes).digest('hex');
    });
    if (observation.status === 'complete' && hashesValid) {
      const recovered = operationResult(loaded.draft, result.requestId, result.id, 'succeeded', [observation.ref],
        `Recovered ${artifacts.length} stored quote artifact(s); no reservation saved or email sent`);
      const saved = await persistResult(ctx, input, loaded.draft.generationId, recovered);
      return saved.status === 'ok' ? { status: 'succeeded', operationId: result.id,
        observationRef: observation.ref, artifacts, coverEmail: payload.coverEmail, emailSent: false, reservationSaved: false } : saved;
    }
  }
  if (result.status === 'succeeded' || result.status === 'failed') {
    return { status: result.status, operationId: result.id, summary: result.summary,
      observationRef: observation?.ref, artifacts: record(observation?.result)?.artifacts ?? [] };
  }
  return { status: 'needs_reconcile', operationId: result.id,
    issue: 'quote_artifact_receipt_not_confirmed; do_not_retry_automatically' };
}
