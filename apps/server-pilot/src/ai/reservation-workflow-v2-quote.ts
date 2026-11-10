import type { ReservationWorkflowV2SystemReadContext } from './reservation-workflow-v2-system-read-context.js';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { user } from '../db/schema/auth.js';
import {
  getReservationWorkflowV2Draft,
  appendReservationWorkflowV2Observation,
  recordReservationWorkflowV2Result,
  type ReservationNativeCheckBatch,
  type ReservationRecoveryScope,
} from './reservation-workflow-v2-state.js';
import type {
  ReservationWorkflowV2Draft,
  ReservationWorkflowV2Observation,
  ReservationWorkflowV2Source,
} from './reservation-workflow-v2-contract.js';
import { findParty } from './pane-party-lookup.js';
import { lookupNativeParty } from './reservation-workflow-v2-native-party.js';
import { resolveHmsQuoteJobTarget } from '../hms/hms-quote-target.js';
import { staffQuoteInput } from './staff-quote-workflow.js';
import { runStaffQuote, staffQuoteCauseSummary } from './staff-quote-run.js';
import { buildStaysProposalPdf } from '../quote-proposal/proposal-pdf.js';
import { quotePropertyIdentity } from '../quote-proposal/filename.js';
import {
  quoteDateLabel,
  quoteWorkbookFileName,
  quoteWorkbookForStays,
  type WorkbookStay,
} from '../quote-proposal/quote-workbook.js';
import { deriveAuthorizedExtraLines, deriveQuoteLines, extraDisplayDescription,
  type AuthorizedProposalFacts, type RowPrice } from '../quote-proposal/quote-lines.js';
import { occupiedDates, quoteDigest, type QuoteRevision } from '../quote-proposal/quote-revision.js';

/** Kept structurally aligned with reservationWorkflowV2ServerContext in the native tools module. */
export type ReservationWorkflowV2QuoteContext = {
  db: DB;
  transport: { id: string };
  user: { id: string };
  property: { propertyCode: string };
  nativeBatch?: ReservationNativeCheckBatch;
  recovery?: ReservationRecoveryScope;
};
type ReadContext = ReservationWorkflowV2QuoteContext | ReservationWorkflowV2SystemReadContext;

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
type QuoteArtifactGeneration = {
  artifacts: Array<Record<string, unknown>>;
  failures: string[];
  coverEmail: { to: string; subject: string; body: string } | null;
  coverEmailDigest?: string;
  outputKinds: Array<'email_quote' | 'pdf_quote' | 'xlsx_quote'>;
  requestedOutputKinds?: Array<'email_quote' | 'pdf_quote' | 'xlsx_quote'>;
  revisionRef: string | null;
  sourceHash: string;
  nativeInputDigest: string | null;
  preparedObservationRef: string;
  workflowRunId: string | null;
  claims: Array<Record<string, unknown>>;
  unavailableInventory?: Record<string, unknown>;
  companyShownInCover: false;
};

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
// Keep the uncertain window beyond the 12-minute quote run so a live generation is not released for retry.
const QUOTE_OPERATION_STALE_AFTER_MS = 15 * 60_000;

function quoteOperationExpired(result: QuoteOperationResult): boolean {
  const updatedAt = Date.parse(result.updatedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt >= QUOTE_OPERATION_STALE_AFTER_MS;
}

function stateContext(ctx: ReadContext) {
  return {
    db: ctx.db,
    transportId: ctx.transport.id,
    userId: 'system' in ctx || ctx.nativeBatch ? null : ctx.user.id,
    propertyCode: ctx.property.propertyCode,
    nativeBatch: ctx.nativeBatch,
    recovery: ctx.recovery,
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

async function loadCurrent(ctx: ReadContext, input: QuoteBaseInput) {
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
    if (partyLeaf.value === null || partyLeaf.value === undefined || isNone(partyLeaf.value)) {
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
      !candidate || !cleanText(candidate.nativeId) || !cleanText(candidate.name) || !sameName(candidate.name, name)) {
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

function pricedDinnerFallbackMatches(
  input: z.infer<typeof staffQuoteInput>,
  expected: z.infer<typeof staffQuoteInput>['groups'][number],
  actual: Record<string, unknown>,
  revision: Record<string, unknown>,
  factsValue: unknown,
  fallbackGroupIdsValue: unknown,
): boolean {
  // The authorized native B&B retry can select a verified company contract as well as public rates.
  const facts = record(factsValue);
  const fallbackGroupIds = Array.isArray(fallbackGroupIdsValue) ? fallbackGroupIdsValue : [];
  if ((input.salesStrategy !== 'BAR' && input.salesStrategy !== 'Government' && input.salesStrategy !== 'GOV') ||
      actual.board !== 'breakfast' || typeof actual.rateCode !== 'string' || !actual.rateCode.trim() ||
      !fallbackGroupIds.includes(expected.id) || !facts || facts.revisionId !== revision.id ||
      facts.authorizationId !== revision.authorizationId || facts.sourceHash !== input.sourceHash) return false;

  const extras = Array.isArray(facts.extras) ? facts.extras.map(record).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
  const dinner = extras.find((extra) => extra.service === 'dinner_add_on' &&
    Array.isArray(extra.groupIds) && extra.groupIds.includes(expected.id) &&
    Number.isSafeInteger(extra.unitMinor) && Number(extra.unitMinor) > 0);
  if (!dinner) return false;
  const dates = Array.isArray(dinner.dates) ? dinner.dates : [];
  const expectedDates = dinner.chargeUnit === 'per_person'
    ? [expected.arrivalDate]
    : dinner.chargeUnit === 'per_person_night' || dinner.chargeUnit === 'per_room_per_night'
      ? occupiedDates(expected.arrivalDate, expected.departureDate) : [];
  const correctBasis = dinner.unitKind === 'person_service'
    ? dinner.chargeUnit === 'per_person' || dinner.chargeUnit === 'per_person_night'
    : dinner.unitKind === 'item' && dinner.chargeUnit === 'per_room_per_night';
  if (!correctBasis || !expectedDates.length || dates.length !== expectedDates.length ||
      dates.some((date, index) => date !== expectedDates[index])) return false;
  try {
    return deriveAuthorizedExtraLines(revision as unknown as QuoteRevision,
      facts as unknown as AuthorizedProposalFacts).some((line) => line.service === 'dinner_add_on' && line.totalMinor > 0);
  } catch {
    return false;
  }
}

function preparedQuoteMatches(
  input: z.infer<typeof staffQuoteInput>,
  value: unknown,
  factsValue?: unknown,
  fallbackGroupIdsValue?: unknown,
): boolean {
  const revision = record(value);
  const groups = Array.isArray(revision?.groups) ? revision.groups.map(record) : [];
  if (!revision || revision.propertyCode === undefined || revision.currency !== 'ZAR' ||
      revision.held !== false || groups.length !== input.groups.length ||
      typeof revision.totalMinor !== 'number' || !Number.isSafeInteger(revision.totalMinor) ||
      revision.totalMinor < 0) return false;
  if (input.dinnerAllowanceMinor !== undefined) {
    const facts = record(factsValue);
    const extras = Array.isArray(facts?.extras) ? facts.extras.map(record) : [];
    const dinner = extras.find((extra) => extra?.service === 'dinner_add_on');
    const expectedIds = input.dinnerAllowanceGroupIds ?? input.groups.map((group) => group.id);
    const actualIds = Array.isArray(dinner?.groupIds) ? dinner.groupIds : [];
    const unit = input.dinnerAllowanceUnit;
    const chargeUnit = unit === 'per_person_per_night' ? 'per_person_night' : unit;
    const applicable = input.groups.filter((group) => expectedIds.includes(group.id));
    const first = applicable[0];
    const dates = first ? unit === 'per_person' ? [first.arrivalDate] : occupiedDates(first.arrivalDate, first.departureDate) : [];
    const rooms = applicable.reduce((total, group) => total + group.quantity, 0);
    const people = applicable.reduce((total, group) => total + group.quantity * (group.adults + group.childrenAges.length), 0);
    if (!facts || facts.revisionId !== revision.id || facts.authorizationId !== revision.authorizationId ||
        facts.sourceHash !== input.sourceHash || !dinner || dinner.unitMinor !== input.dinnerAllowanceMinor ||
        dinner.chargeUnit !== chargeUnit || !dates.length || JSON.stringify(dinner.dates) !== JSON.stringify(dates) ||
        actualIds.length !== expectedIds.length || !expectedIds.every((id) => actualIds.includes(id)) ||
        (unit === 'per_room_per_night'
          ? dinner.unitKind !== 'item' || dinner.quantity !== rooms || dinner.units !== dates.length
          : dinner.unitKind !== 'person_service' || !Array.isArray(dinner.persons) || dinner.persons.length !== people ||
            dinner.units !== people * dates.length)) return false;
    try {
      if (!deriveAuthorizedExtraLines(revision as unknown as QuoteRevision,
        facts as unknown as AuthorizedProposalFacts).some((line) => line.service === 'dinner_add_on' && line.totalMinor > 0)) return false;
    } catch { return false; }
  }
  for (const expected of input.groups) {
    const actual = groups.find((group) => group?.id === expected.id);
    const board = expected.board === 'bb' ? 'breakfast'
      : expected.board === 'dinner_bb' ? 'dinner_bed_breakfast' : 'room_only';
    const boardMatches = actual?.board === board || Boolean(actual && expected.board === 'dinner_bb' &&
      pricedDinnerFallbackMatches(input, expected, actual, revision, factsValue, fallbackGroupIdsValue));
    if (!actual || actual.arrivalDate !== expected.arrivalDate || actual.departureDate !== expected.departureDate ||
        actual.quantity !== expected.quantity || actual.adults !== expected.adults ||
        actual.children !== expected.childrenAges.length || !boardMatches ||
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
  strategyDefaulted: boolean;
} | {
  status: 'needs_input' | 'needs_review' | 'unsupported';
  issue: string;
  fields: string[];
};

type UnavailableInventoryProof = {
  observation: ReservationWorkflowV2Observation;
  group: Extract<CompiledQuote, { status: 'ok' }>['input']['groups'][number];
  roomCode: string;
  roomLabel: string;
  freshUntil: string;
};

/** A decline is safe only for one explicitly selected room/rate with complete, current nightly zero-stock facts. */
function unavailableInventoryProof(
  draft: ReservationWorkflowV2Draft,
  compiled: Extract<CompiledQuote, { status: 'ok' }>,
): UnavailableInventoryProof | null {
  if (compiled.input.groups.length !== 1) return null;
  const group = compiled.input.groups[0];
  const roomCode = group?.roomCodes?.length === 1 ? group.roomCodes[0] : undefined;
  if (!group || !roomCode || !group.rateCode) return null;

  const observation = [...draft.observations].reverse().find((item) => {
    const criteria = record(item.criteria);
    return item.kind === 'rate_availability' && item.status === 'failed' &&
      item.generationId === draft.generationId && item.propertyCode === draft.propertyCode &&
      item.sourceMessageId === draft.source.messageId && criteria?.workflow === 'quote' &&
      criteria.requestId === compiled.request.id && criteria.sourceHash === draft.source.sourceHash &&
      criteria.inputDigest === compiled.inputDigest;
  });
  if (!observation) return null;
  const result = record(observation.result), shortfall = record(result?.shortfall);
  if (result?.failureCode !== 'native_quote_insufficient_inventory' || result.failureKind !== 'proven_shortage' ||
      result.sourceHash !== draft.source.sourceHash || result.inputDigest !== compiled.inputDigest ||
      result.availabilityTruncated !== false || !shortfall || shortfall.roomCode !== roomCode ||
      shortfall.demand !== group.quantity || shortfall.supply !== 0 || typeof shortfall.date !== 'string' ||
      typeof shortfall.roomLabel !== 'string') return null;

  const freshUntil = typeof result.freshUntil === 'string' ? result.freshUntil : '';
  const expires = Date.parse(freshUntil);
  if (!Number.isFinite(expires) || expires <= Date.now()) return null;
  const nights = occupiedDates(group.arrivalDate, group.departureDate);
  if (!nights.length || !nights.includes(shortfall.date)) return null;

  const diagnostics: Record<string, unknown>[] = Array.isArray(result.quoteDiagnostics)
    ? result.quoteDiagnostics.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
  const diagnostic = [...diagnostics].reverse().find((item) => item.kind === 'requested' && item.contextMatchesSelection === true);
  const diagnosticExpiry = Date.parse(String(diagnostic?.freshUntil ?? ''));
  if (!diagnostic || diagnostic.availabilityTruncated !== false || diagnostic.freshUntil !== freshUntil ||
      !Number.isFinite(diagnosticExpiry) || diagnosticExpiry <= Date.now()) return null;
  const board: Record<string, unknown>[] = Array.isArray(diagnostic.availabilityBoard)
    ? diagnostic.availabilityBoard.map(record).filter((row): row is Record<string, unknown> => row !== null) : [];
  const expectedBoard = board.filter((row) => row?.groupId === group.id && row.roomCode === roomCode &&
    row.rateCode === group.rateCode && boardCode(row.boardLabel ?? row.board) === group.board);
  if (expectedBoard.length !== 1) return null;
  const row = expectedBoard[0]!;
  const coverage = record(row.coverage), nightCoverage = record(row.nightCoverage);
  const facts: Record<string, unknown>[] = Array.isArray(row.nightly)
    ? row.nightly.map(record).filter((fact): fact is Record<string, unknown> => fact !== null) : [];
  const byDate = new Map(facts.map((fact) => [fact.date, fact]));
  if (row.availability !== 'unavailable' || row.roomsLeft !== 0 ||
      coverage?.search !== 'complete' || coverage.requiredFacts !== 'complete' ||
      coverage.matchingRowsUnseen === true || coverage.optionsTruncated === true ||
      nightCoverage?.complete !== true || nightCoverage.expected !== nights.length ||
      nightCoverage.observed !== nights.length || facts.length !== nights.length || byDate.size !== nights.length ||
      nights.some((date) => {
        const fact = byDate.get(date);
        return !fact || fact.availableCount !== 0 || fact.requestedCount !== group.quantity || fact.stockStatus !== 'sold';
      })) return null;
  return { observation, group, roomCode, roomLabel: shortfall.roomLabel, freshUntil };
}

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

  const provisional = resolved(path('provisionalBookingRequested'), request.body.provisionalBookingRequested);
  if (execute && draft.staffReviews[path('provisionalBookingRequested')]?.status !== 'accepted') {
    reviewPaths.add(path('provisionalBookingRequested'));
  }
  if (execute && ('issue' in provisional || provisional.value !== false)) {
    issues.push(`${path('provisionalBookingRequested')}:${!('issue' in provisional) && provisional.value === true
      ? 'separate_create_required' : 'quote_only_choice_required'}`);
  }
  if (!request.body.groups.length) issues.push(`${path('groups')}:group_required`);
  if (request.body.groups.length > 8) issues.push(`${path('groups')}:native_quote_group_limit`);

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

    // Occupancy may be edited atomically as a parent object to keep child count and age slots in one revision.
    const occupancyResult = resolvedLeaf(draft, path('groups', groupIndex, 'occupancy'), group.occupancy);
    const occupancy = !('issue' in occupancyResult) ? record(occupancyResult.value) ?? group.occupancy : group.occupancy;
    if ('issue' in occupancyResult) issues.push(`${base}/occupancy:${occupancyResult.issue}`);
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
    const exceedsChildLimit = Number.isInteger(count) && Number(count) > 6;
    if (count === 0 && (ages === null || (Array.isArray(ages) && ages.length === 0))) childrenAges = [];
    else if (Number.isInteger(count) && Number(count) > 0 && Number(count) <= 6 && Array.isArray(ages) && ages.length === Number(count) &&
        ages.every((age) => Number.isInteger(age) && Number(age) >= 0 && Number(age) <= 17)) {
      childrenAges = ages as number[];
    }
    if (exceedsChildLimit) issues.push(`${base}/occupancy/childCount:native_quote_max_six_children_per_room`);
    else if (childrenAges === null) issues.push(`${base}/occupancy:known_child_count_and_ages_required`);

    const roomCodesResult = resolved(path('groups', groupIndex, 'roomCodes'), group.roomCodes);
    const rawRoomCodes = roomCodesResult && !('issue' in roomCodesResult) ? roomCodesResult.value : null;
    let roomCodes: string[] | undefined;
    if (rawRoomCodes !== null && rawRoomCodes !== undefined) {
      if (!Array.isArray(rawRoomCodes) || rawRoomCodes.length > 8 ||
          rawRoomCodes.some((code) => !providerCode.safeParse(code).success)) {
        issues.push(`${base}/roomCodes:native_room_codes_required`);
      } else if (rawRoomCodes.length) roomCodes = rawRoomCodes as string[];
    }
    if (execute && !roomCodes?.length) issues.push(`${base}/roomCodes:native_room_selection_required`);
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

  // A source amount alone never identifies the charge. Staff must classify dinner explicitly, choose
  // its unit and group scope, and review it before it can enter a generated quote.
  let dinner: Pick<z.infer<typeof staffQuoteInput>, 'dinnerAllowanceMinor' | 'dinnerAllowanceUnit' | 'dinnerAllowanceGroupIds'> = {};
  for (const [index, claim] of request.body.requestedMoney.entries()) {
    const base = path('requestedMoney', index);
    const read = (key: string, original: unknown) => resolvedLeaf(draft, `${base}/${key}`, original);
    const kind = read('staffAllowanceType', undefined);
    const amount = read('amount', claim.amount), currency = read('currency', claim.currency),
      unit = read('unit', claim.unit), scope = read('scope', claim.scope), targets = read('targetRefs', claim.targetRefs);
    const values = [kind, amount, currency, unit, scope, targets];
    const selectedKind = !('issue' in kind) ? kind.value : undefined;
    const rawAmount = !('issue' in amount) ? amount.value : undefined;
    const amountText = typeof rawAmount === 'string' ? rawAmount.trim() : '';
    const match = /^(\d{1,8})(?:\.(\d{1,2}))?$/u.exec(amountText);
    const amountMinor = match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : 0;
    const rawUnit = !('issue' in unit) ? unit.value : undefined;
    const unitValue = rawUnit === 'per_person_night' ? 'per_person_per_night' : rawUnit;
    const unitAllowed = unitValue === 'per_person_per_night' || unitValue === 'per_room_per_night' || unitValue === 'per_person';
    const scopeValue = !('issue' in scope) ? scope.value : undefined;
    const targetValues = !('issue' in targets) && Array.isArray(targets.value) ? targets.value : [];
    const allIds = nativeGroups.map((group) => group.id);
    const groupIds = scopeValue === 'overall' && targetValues.length === 0 ? allIds
      : scopeValue === 'per_target' && targetValues.length > 0 && targetValues.every((id) => typeof id === 'string' && allIds.includes(id)) &&
          new Set(targetValues).size === targetValues.length ? targetValues as string[] : [];
    const supported = selectedKind === 'dinner' && !values.some((item) => 'issue' in item) &&
      !('issue' in currency) && typeof currency.value === 'string' && currency.value.trim().toUpperCase() === 'ZAR' &&
      amountMinor > 0 && Number.isSafeInteger(amountMinor) && unitAllowed && groupIds.length > 0 &&
      dinner.dinnerAllowanceMinor === undefined;
    const separatedOther = draft.proposal.content.requests.some((candidate) => {
      if (candidate.kind !== 'other') return false;
      const otherBody = record(candidate.body);
      const separatedFrom = record(otherBody?.separatedFrom);
      return separatedFrom?.requestId === request.id && separatedFrom.moneyId === claim.id;
    });
    const explicitlySeparated = selectedKind === 'unsupported' && separatedOther;
    if (!supported && !explicitlySeparated) {
      // Background HMS room prices remain useful while the unpriced request stays visible.
      // Generation stays blocked until staff choose dinner or save a linked Other task.
      if (execute) issues.push(`${base}:allowance_requires_supported_staff_choice`);
      continue;
    }
    if (supported) {
      dinner = { dinnerAllowanceMinor: amountMinor,
        dinnerAllowanceUnit: unitValue as 'per_person_per_night' | 'per_room_per_night' | 'per_person',
        dinnerAllowanceGroupIds: groupIds };
      if (execute) for (const key of ['staffAllowanceType', 'amount', 'currency', 'unit', 'scope', 'targetRefs']) {
        const fieldPath = `${base}/${key}`;
        if (!reviewAccepted(draft, fieldPath)) reviewPaths.add(fieldPath);
      }
    } else if (execute && explicitlySeparated && !reviewAccepted(draft, `${base}/staffAllowanceType`)) {
      reviewPaths.add(`${base}/staffAllowanceType`);
    }
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
  // An unchosen sales strategy must not prevent read-only discovery. Use the existing
  // public-rate search default without changing the draft or approving quote generation.
  const strategyDefaulted = !execute && !strategy && (rawStrategy === null || rawStrategy === undefined);
  if (!strategyDefaulted && !strategies.has(strategy)) issues.push(`${strategyPath}:supported_sales_strategy_required`);

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
  const outputResult = execute ? resolved(outputPath, request.body.outputIntent.artifacts)
    : resolvedLeaf(draft, outputPath, request.body.outputIntent.artifacts);
  const rawOutputKinds = outputResult && !('issue' in outputResult) ? outputResult.value : null;
  const outputAllowed = new Set(['email_quote', 'pdf_quote', 'xlsx_quote']);
  const outputKinds = Array.isArray(rawOutputKinds)
    ? [...new Set(rawOutputKinds.filter((kind): kind is 'email_quote' | 'pdf_quote' | 'xlsx_quote' =>
      typeof kind === 'string' && outputAllowed.has(kind)))]
    : [];
  if (execute && Array.isArray(rawOutputKinds) && outputKinds.length !== rawOutputKinds.length) {
    issues.push(`${outputPath}:unsupported_artifact_kind`);
  }
  if (execute && !outputKinds.length) issues.push(`${path('outputIntent', 'artifacts')}:output_required`);
  if (execute && outputKinds.includes('email_quote') && !clientEmail) issues.push(`${emailPath}:recipient_required_for_cover`);

  if (issues.length) {
    const unsupported = issues.some((issue) => /unsupported|separate_create_required|separate_quote_runs_required|allowance_requires_supported_staff_choice/u.test(issue));
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
    salesStrategy: strategyDefaulted ? 'BAR' : strategy === 'GOV' ? 'Government' : strategy,
    company: company.party?.name ?? '',
    agency: agency.party?.name ?? '',
    attention,
    clientEmail,
    clientTelephone,
    ...(notes ? { notes } : {}),
    ...(Object.keys(parties).length ? { parties } : {}),
    ...dinner,
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
    reviewPaths: [...reviewPaths], sourceRefs, outputKinds, strategyDefaulted,
  };
}

async function quoteTarget(ctx: ReadContext, input: QuoteBaseInput) {
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
    prepared?.sourceHash === draft.source.sourceHash &&
    preparedQuoteMatches(compiled.input, revision, prepared?.facts, result.dinnerFallbackGroupIds) &&
    Number.isFinite(freshUntil) && freshUntil > Date.now();
  const inputDigest = compiled.inputDigest;
  const runResult = {
    workflowRunId: result.workflowRunId ?? null,
    revisionRef: result.revisionRef ?? null,
    inputDigest,
    sourceHash: draft.source.sourceHash,
    searchContext: { salesStrategy: compiled.input.salesStrategy,
      strategySource: compiled.strategyDefaulted ? 'discovery_default' : 'draft' },
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
    availabilityTruncated: result.availabilityTruncated === true,
    quoteDiagnostics: result.quoteDiagnostics ?? [],
    extrasReviewItems: Array.isArray(result.extrasReviewItems)
      ? result.extrasReviewItems.filter((item): item is string => typeof item === 'string') : [],
    dinnerFallbackGroupIds: Array.isArray(result.dinnerFallbackGroupIds)
      ? result.dinnerFallbackGroupIds.filter((id): id is string => typeof id === 'string') : [],
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
  preparedOnly = false,
) {
  const now = Date.now();
  const preparedOperation = preparedOnly ? [...operationResults(draft)].reverse().find((result) =>
    result.workflow === 'quote' && result.requestId === compiled.request.id && result.status === 'prepared'
    && result.generationId === draft.generationId) : null;
  const preparedRefs = new Set(preparedOperation?.observationRefs ?? []);
  return [...draft.observations].reverse().find((observation) => {
    if (preparedOnly && !preparedRefs.has(observation.ref)) return false;
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
      preparedQuoteMatches(compiled.input, revision, result?.facts, result?.dinnerFallbackGroupIds);
  });
}

async function persistObservation(
  ctx: ReadContext,
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
  ctx: ReadContext,
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

function operationObservation(draft: ReservationWorkflowV2Draft, operationId: string, refs: string[] = []) {
  const linkedRefs = new Set(refs);
  return [...draft.observations].reverse().find((observation) =>
    observation.kind === 'document' && (linkedRefs.size
      ? linkedRefs.has(observation.ref) : record(observation.criteria)?.operationId === operationId));
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
    availabilityTruncated: result.availabilityTruncated,
    extrasReviewItems,
    ...(extrasReviewItems.length && requestId ? { extrasReviewPath: quoteBodyPath(requestId) } : {}),
  };
}

/** A diagnostic may supply selectable offers only for the currently selected native parties. */
export function quoteDiagnosticMatchesParty(
  parties: z.infer<typeof staffQuoteInput>['parties'],
  rateContext: Record<string, unknown> | undefined,
): boolean {
  const expected = {
    ...(parties?.company ? { organization: parties.company.nativeId } : {}),
    ...(parties?.agency ? { agency: parties.agency.nativeId } : {}),
  };
  const context = rateContext ?? {};
  const selected = Object.entries(expected);
  return Object.keys(context).length === selected.length && selected.every(([kind, id]) =>
    record(context[kind])?.nativeId === id);
}

async function priceQuote(
  ctx: ReadContext,
  input: QuoteBaseInput,
  draft: ReservationWorkflowV2Draft,
  compiled: Extract<CompiledQuote, { status: 'ok' }>,
) {
  let quote: QuoteRunResult;
  try {
    quote = await runStaffQuote(compiled.input, { transportId: ctx.transport.id }, ctx.db,
      ctx.nativeBatch ? { persistence: 'return_only', signal: ctx.nativeBatch.signal,
        deadlineAt: ctx.nativeBatch.deadlineAt, preparedRunId: ctx.nativeBatch.jobFence.runId, autoStart: true } : {}) as unknown as QuoteRunResult;
  } catch (error) {
    ctx.nativeBatch?.signal.throwIfAborted();
    const cause = staffQuoteCauseSummary(error);
    const mismatch = cause.code === 'native_quote_no_matching_rate' || cause.code === 'business_selected_price_unavailable';
    const shortage = cause.code === 'native_quote_insufficient_inventory';
    const restricted = cause.code === 'native_quote_restricted_nights';
    const issue = cause.code === 'native_quote_no_matching_rate' ? cause.code
      : mismatch ? 'native_quote_requested_unavailable'
        : shortage || restricted ? cause.code : 'native_quote_price_unavailable';
    const diagnostics = (cause.quoteDiagnostics ?? []).map((diagnostic) => {
      const contextMatchesSelection = quoteDiagnosticMatchesParty(compiled.input.parties, diagnostic.source.request.rateContext);
      return { ...diagnostic, contextMatchesSelection, ...(!contextMatchesSelection
        ? { contextNote: 'This read used a different company or agency context. Change the selected party and search again before choosing its offers.' }
        : {}) };
    });
    const latest = [...diagnostics].reverse().find((diagnostic) => diagnostic.contextMatchesSelection);
    const failureDetails = {
      searchContext: { salesStrategy: compiled.input.salesStrategy,
        strategySource: compiled.strategyDefaulted ? 'discovery_default' : 'draft' },
      failureCode: cause.code,
      failurePhase: cause.phase ?? 'unknown',
      failureKind: cause.code === 'native_quote_no_matching_rate' ? 'requested_mismatch'
        : mismatch ? 'requested_unqualified' : shortage ? 'proven_shortage'
        : restricted ? 'restricted' : cause.phase === 'qualification' ? 'qualification_failure' : 'read_failure',
      quoteDiagnostics: diagnostics,
      inputOverrides: quoteInputOverrides(draft, compiled.request.id),
      requestedGroups: compiled.input.groups,
      freshUntil: latest?.freshUntil ?? null,
      summaryObservedAt: latest?.source.observedAt ?? null,
      rateOptions: latest?.rateOptions ?? [],
      availabilityBoard: latest?.availabilityBoard ?? [],
      availabilityTruncated: latest?.availabilityTruncated ?? false,
      ...(cause.shortfall ? { shortfall: cause.shortfall } : {}),
    };
    const failure: ReservationWorkflowV2Observation = {
      ref: randomUUID(), generationId: draft.generationId, kind: 'rate_availability', status: 'failed',
      observedAt: new Date().toISOString(), propertyCode: draft.propertyCode, sourceMessageId: draft.source.messageId,
      sourceRefs: compiled.sourceRefs,
      criteria: { workflow: 'quote', requestId: compiled.request.id, inputDigest: compiled.inputDigest,
        sourceHash: draft.source.sourceHash, operationId: null },
      coverage: { complete: false, notes: [issue] },
      result: { issue, sourceHash: draft.source.sourceHash,
        inputDigest: compiled.inputDigest, observedAt: new Date().toISOString(), ...failureDetails },
    };
    const saved = await persistObservation(ctx, input, failure);
    return saved.status === 'ok'
      ? { status: mismatch || shortage || restricted ? 'needs_input' as const : 'failed' as const, issue, observationRef: failure.ref,
        quote: { observationRef: failure.ref, ...failureDetails } }
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
  ctx: ReadContext,
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
    if (ctx.nativeBatch) {
      const found = await lookupNativeParty({ role: role === 'company' ? 'organization' : 'agency',
        name, target: target.target, signal: ctx.nativeBatch.signal });
      const rows = Array.isArray(found.result.candidates) ? found.result.candidates : [];
      const rowValues = rows.length ? rows : [null];
      for (const value of rowValues) {
        const row = record(value);
        const observation: ReservationWorkflowV2Observation = { ref: randomUUID(), generationId: draft.generationId,
          kind: 'party_candidate', status: found.status, observedAt: new Date().toISOString(), propertyCode: draft.propertyCode,
          sourceMessageId: draft.source.messageId, sourceRefs: [],
          criteria: { workflow: 'quote', requestId: request.id, role, searchName: name,
            fieldPath: ptr('proposal', 'content', 'requests', request.id, 'body', 'parties', role, 'nativeSelectionRef') },
          coverage: found.coverage, result: row ? { ...row, kind: role, outcome: found.result.outcome,
            searchedFor: name, truncated: found.result.truncated } : { ...found.result, kind: role } };
        const saved = await persistObservation(ctx, input, observation);
        if (saved.status !== 'ok') return { status: saved.status, issue: 'party_lookup_result_not_persisted', candidates };
        if (row) candidates.push({ ...row, ref: observation.ref, kind: role });
      }
      if (found.status !== 'complete') return { status: 'failed', issue: 'native_party_search_incomplete', candidates };
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
  ctx: ReadContext,
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
  ctx: ReadContext,
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

function makeCoverEmail(
  compiled: Extract<CompiledQuote, { status: 'ok' }>,
  revision: QuoteRevision,
  facts: AuthorizedProposalFacts | null,
  rowPrices: RowPrice[],
  preparedTotal: unknown,
) {
  const roomLines = deriveQuoteLines(revision, rowPrices);
  // Validate the full facts together, including duplicate identities and their source binding.
  const extraLines = facts ? deriveAuthorizedExtraLines(revision, facts) : [];
  const total = [...roomLines, ...extraLines].reduce((sum, line) => sum + line.totalMinor, 0);
  if (!Number.isSafeInteger(total) || total !== preparedTotal) throw new Error('quote_email_total_mismatch');
  const money = (minor: number) => `${revision.currency} ${(minor / 100).toFixed(2)}`;
  let hotelName: string | null = null;
  try { hotelName = quotePropertyIdentity(revision.propertyCode).name; } catch { /* Unknown property has no approved display name. */ }
  const boardLabels = { room_only: 'Room only', breakfast: 'Bed & Breakfast',
    dinner_bed_breakfast: 'Dinner, bed & breakfast' } as const;
  const groups = revision.groups;
  const lines = roomLines.map((line) => {
    const groupIndex = groups.findIndex((entry) => entry.id === line.groupId);
    const group = groups[groupIndex];
    if (!group) throw new Error('quote_email_group_missing');
    const ages = group.children ? ` (ages ${group.childAges.join(', ')})` : '';
    return [
      `Room group ${groupIndex + 1} · ${quoteDateLabel(line.arrivalDate, line.departureDate)}: ${group.roomLabel}`,
      `${line.quantity} room${line.quantity === 1 ? '' : 's'}, ${group.adults} adult${group.adults === 1 ? '' : 's'} and ${group.children} ${group.children === 1 ? 'child' : 'children'}${ages} per room · ${boardLabels[group.board]}`,
      `${line.quantity} room${line.quantity === 1 ? '' : 's'} × ${line.nights} night${line.nights === 1 ? '' : 's'} × ${money(line.rateMinor)} per room per night = ${money(line.totalMinor)}`,
    ].join('\n');
  });
  const extras = facts?.extras.flatMap((extra) =>
    deriveAuthorizedExtraLines(revision, { ...facts, extras: [extra] }).map((line) => {
      const scope = extra.groupIds?.length
        ? extra.groupIds.map((id) => `room group ${groups.findIndex((group) => group.id === id) + 1}`).join(', ')
        : '';
      return `${extraDisplayDescription(line)}${scope ? ` (${scope})` : ''}${line.dates.length ? ` · ${line.dates.join(', ')}` : ''}\n` +
        `${line.units} × ${money(line.rateMinor)} = ${money(line.totalMinor)}`;
    })) ?? [];
  return {
    to: compiled.input.clientEmail,
    subject: 'Your quotation',
    body: [
      `Good day${compiled.input.attention ? ` ${compiled.input.attention}` : ''},`,
      `Please find your quotation${hotelName ? ` for ${hotelName}` : ''} below.`,
      ...lines,
      ...extras,
      `Total: ${money(total)}`,
      ...(compiled.input.notes ? [compiled.input.notes] : []),
      'Availability is not held and must be confirmed when booking. This quotation does not create a reservation.',
      'Kind regards,',
    ].join('\n\n'),
  };
}

async function quoteArtifacts(
  ctx: ReservationWorkflowV2QuoteContext,
  compiled: Extract<CompiledQuote, { status: 'ok' }>,
  preparedObservation: ReservationWorkflowV2Observation,
): Promise<QuoteArtifactGeneration> {
  const prepared = record(preparedObservation.result);
  const revision = record(prepared?.revision) as unknown as QuoteRevision | null;
  const criteria = record(preparedObservation.criteria);
  if (!revision || revision.propertyCode !== ctx.property.propertyCode ||
      criteria?.workflow !== 'quote' || criteria.inputDigest !== compiled.inputDigest ||
      criteria.sourceHash !== compiled.input.sourceHash ||
      !preparedQuoteMatches(compiled.input, revision, prepared?.facts, prepared?.dinnerFallbackGroupIds)) {
    throw new Error('prepared_quote_revision_invalid');
  }
  const facts = record(prepared?.facts) as unknown as AuthorizedProposalFacts | null;
  const rowPrices = Array.isArray(prepared?.rowPrices) ? prepared!.rowPrices as RowPrice[] : [];
  const stays: WorkbookStay[] = [{ revision, ...(facts ? { facts } : {}), ...(rowPrices.length ? { rowPrices } : {}) }];
  let actor: { name: string | null; email: string | null } | undefined;
  if (compiled.outputKinds.includes('xlsx_quote') || compiled.outputKinds.includes('pdf_quote')) {
    try {
      [actor] = await ctx.db.select({ name: user.name, email: user.email }).from(user)
        .where(eq(user.id, ctx.user.id)).limit(1);
    } catch { /* Email cover and independently available outputs should survive signer lookup failure. */ }
  }
  const header = {
    attention: compiled.input.attention,
    // HMS party still scopes the native rate; the client company is deliberately omitted from quote covers.
    company: '',
    clientEmail: compiled.input.clientEmail,
    clientTelephone: compiled.input.clientTelephone,
    signerName: actor?.name ?? '',
    signerEmail: actor?.email ?? '',
  };
  const artifacts: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  const group = compiled.input.groups[0]!;
  if (compiled.outputKinds.includes('xlsx_quote')) {
    if (!actor) failures.push('xlsx_signer_unavailable');
    else try {
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
    if (!actor) failures.push('pdf_signer_unavailable');
    else if (!gotenbergUrl) failures.push('pdf_converter_unavailable');
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
  let coverEmail: QuoteArtifactGeneration['coverEmail'] = null;
  if (compiled.outputKinds.includes('email_quote')) {
    try { coverEmail = makeCoverEmail(compiled, revision, facts, rowPrices, prepared?.totalMinor); }
    catch { failures.push('email_generation_failed'); }
  }
  return { artifacts, failures, coverEmail, ...(coverEmail ? { coverEmailDigest: hash(coverEmail) } : {}),
    outputKinds: compiled.outputKinds, revisionRef: revision.id,
    sourceHash: compiled.input.sourceHash, nativeInputDigest: prepared?.nativeInputDigest ?? null,
    preparedObservationRef: preparedObservation.ref, workflowRunId: prepared?.workflowRunId ?? null,
    claims: compiled.input.groups.map((entry) => ({ groupId: entry.id, arrivalDate: entry.arrivalDate,
      departureDate: entry.departureDate, quantity: entry.quantity, board: entry.board, adultsPerRoom: entry.adults,
      childAgesPerRoom: entry.childrenAges })),
    companyShownInCover: false as const };
}

function unavailableQuoteReply(
  compiled: Extract<CompiledQuote, { status: 'ok' }>,
  proof: UnavailableInventoryProof,
): QuoteArtifactGeneration {
  const { group } = proof;
  const coverEmail = {
    to: compiled.input.clientEmail,
    subject: 'Availability for your requested stay',
    body: `Unfortunately, we cannot accommodate the requested ${group.quantity} ${proof.roomLabel} room${group.quantity === 1 ? '' : 's'} for ${quoteDateLabel(group.arrivalDate, group.departureDate)} at the selected rate.`,
  };
  return {
    artifacts: [] as Array<Record<string, unknown>>,
    failures: [] as string[],
    coverEmail,
    coverEmailDigest: hash(coverEmail),
    outputKinds: ['email_quote' as const],
    requestedOutputKinds: compiled.outputKinds,
    revisionRef: null,
    sourceHash: compiled.input.sourceHash,
    nativeInputDigest: null,
    preparedObservationRef: proof.observation.ref,
    workflowRunId: null,
    claims: [{ groupId: group.id, arrivalDate: group.arrivalDate, departureDate: group.departureDate,
      quantity: group.quantity, board: group.board, adultsPerRoom: group.adults,
      childAgesPerRoom: group.childrenAges }],
    unavailableInventory: {
      kind: 'requested_room_unavailable',
      availabilityObservationRef: proof.observation.ref,
      groupId: group.id,
      roomCode: proof.roomCode,
      roomLabel: proof.roomLabel,
      rateCode: group.rateCode,
      board: group.board,
      arrivalDate: group.arrivalDate,
      departureDate: group.departureDate,
      quantity: group.quantity,
      freshUntil: proof.freshUntil,
    },
    companyShownInCover: false as const,
  };
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
    const observation = operationObservation(loaded.draft, prior.id, prior.observationRefs);
    return { status: prior.status, operationId: prior.id, summary: prior.summary,
      observationRef: observation?.ref, artifacts: record(observation?.result)?.artifacts ?? [],
      coverEmail: record(observation?.result)?.coverEmail };
  }
  if (prior?.status === 'unknown' &&
      (operationObservation(loaded.draft, prior.id, prior.observationRefs) || !quoteOperationExpired(prior))) {
    return { status: 'needs_reconcile', operationId: prior.id };
  }
  const compiled = compileQuote(loaded.draft, request, true);
  if (compiled.status !== 'ok') return { status: compiled.status, issue: compiled.issue, fields: compiled.fields };
  const preparedObservation = matchingPreparedQuote(loaded.draft, compiled, true);
  const unavailable = preparedObservation ? null : unavailableInventoryProof(loaded.draft, compiled);
  if (!preparedObservation && !unavailable) return { status: 'needs_prepare', issue: 'current_native_quote_prepare_required' };
  if (unavailable && !compiled.outputKinds.includes('email_quote')) {
    return { status: 'needs_input', issue: 'cover_email_required_for_unavailable_reply',
      fields: [ptr('proposal', 'content', 'requests', request.id, 'body', 'outputIntent', 'artifacts')] };
  }
  if (preparedObservation) {
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
    const preparedOperation = [...operationResults(loaded.draft)].reverse().find(entry => entry.requestId === request.id &&
      entry.status === 'prepared' && entry.observationRefs.includes(preparedObservation.ref));
    const extrasAccepted = extrasReview?.status === 'accepted' &&
      Date.parse(extrasReview.at ?? '') >= Date.parse(preparedObservation.observedAt) &&
      Boolean(preparedOperation && Date.parse(extrasReview.at ?? '') >= Date.parse(preparedOperation.updatedAt));
    if (extrasReviewItems.length && !extrasAccepted) {
      return { status: 'needs_review', issue: 'quote_extras_require_staff_acceptance',
        fields: [extrasReviewPath], extrasReviewItems, extrasReviewPath };
    }
  }
  const result = operationResult(loaded.draft, request.id, input.idempotencyKey, 'unknown', [],
    'Quote output generation started; no reservation save or email send is performed');
  const marked = await persistResult(ctx, input, loaded.draft.generationId, result);
  if (marked.status !== 'ok') return marked;

  let generated: QuoteArtifactGeneration;
  try {
    generated = unavailable
      ? unavailableQuoteReply(compiled, unavailable)
      : await quoteArtifacts(ctx, compiled, preparedObservation!);
  } catch {
    const failureObservation: ReservationWorkflowV2Observation = {
      ref: randomUUID(), generationId: loaded.draft.generationId, kind: 'document', status: 'failed',
      observedAt: new Date().toISOString(), propertyCode: loaded.draft.propertyCode,
      sourceMessageId: loaded.draft.source.messageId, sourceRefs: [preparedObservation?.ref ?? unavailable!.observation.ref],
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
    sourceRefs: [...new Set([preparedObservation?.ref ?? unavailable!.observation.ref, ...compiled.sourceRefs])],
    criteria: { workflow: 'quote', requestId: request.id, inputDigest: compiled.inputDigest,
      operationId: input.idempotencyKey, actorUserId: ctx.user.id },
    coverage: { complete, notes: generated.failures },
    result: { ...generated, emailSent: false, reservationSaved: false },
  };
  const final = operationResult(loaded.draft, request.id, input.idempotencyKey,
    complete ? 'succeeded' : 'failed', [observation.ref],
    complete && generated.unavailableInventory ? 'Generated an unsent decline reply from complete current Infor evidence; no reservation saved or email sent'
      : complete ? generated.artifacts.length
      ? `Generated ${generated.artifacts.length} unsent quote artifact(s); no reservation saved or email sent`
      : 'Generated an unsent quote email draft; no reservation saved or email sent'
      : `Generated ${generated.artifacts.length} artifact(s); some requested outputs failed, no reservation saved or email sent`);
  const saved = await persistObservation(ctx, input, observation, final, { allowRevisionAdvance: true });
  return saved.status === 'ok'
    ? { status: complete ? 'succeeded' : generated.artifacts.length ? 'partial' : 'failed',
        operationId: input.idempotencyKey, observationRef: observation.ref, summary: final.summary,
        artifacts: generated.artifacts, coverEmail: generated.coverEmail, failures: generated.failures,
        unavailableInventory: generated.unavailableInventory,
        emailSent: false, reservationSaved: false }
    : saved;
}

function validUnavailableInventoryReceipt(
  draft: ReservationWorkflowV2Draft,
  result: QuoteOperationResult,
  observation: ReservationWorkflowV2Observation,
  payload: Record<string, unknown>,
): boolean {
  const request = quoteRequests(draft, result.requestId)[0];
  if (!request) return false;
  const compiled = compileQuote(draft, request, true);
  if (compiled.status !== 'ok' || !compiled.outputKinds.includes('email_quote')) return false;
  const proof = unavailableInventoryProof(draft, compiled);
  if (!proof) return false;
  const expected = unavailableQuoteReply(compiled, proof);
  const saved = record(payload.unavailableInventory);
  const actualKinds = Array.isArray(payload.requestedOutputKinds) ? payload.requestedOutputKinds : [];
  const criteria = record(observation.criteria);
  return criteria?.workflow === 'quote' && criteria.requestId === result.requestId &&
    criteria.operationId === result.id && criteria.inputDigest === compiled.inputDigest &&
    payload.revisionRef === null && payload.preparedObservationRef === proof.observation.ref &&
    payload.companyShownInCover === false && actualKinds.length === compiled.outputKinds.length &&
    compiled.outputKinds.every((kind, index) => actualKinds[index] === kind) &&
    Boolean(saved && hash(saved) === hash(expected.unavailableInventory)) &&
    hash(expected.coverEmail) === payload.coverEmailDigest &&
    observation.sourceRefs.includes(proof.observation.ref);
}

/** Text-only receipts must still bind an intact draft to its prepared quote or verified unavailability proof. */
function validTextQuoteReceipt(
  draft: ReservationWorkflowV2Draft,
  result: QuoteOperationResult,
  observation: ReservationWorkflowV2Observation,
  payload: Record<string, unknown>,
): boolean {
  const cover = record(payload.coverEmail);
  const criteria = record(observation.criteria);
  const ref = cleanText(payload.preparedObservationRef);
  const prepared = draft.observations.find((entry) => entry.ref === ref);
  const preparedCriteria = record(prepared?.criteria);
  const preparedResult = record(prepared?.result);
  const revision = record(preparedResult?.revision);
  const boundCover = Array.isArray(payload.outputKinds) && payload.outputKinds.length === 1 && payload.outputKinds[0] === 'email_quote' &&
    Array.isArray(payload.artifacts) && payload.artifacts.length === 0 &&
    Array.isArray(payload.failures) && payload.failures.length === 0 &&
    Boolean(cover && cleanText(cover.to) && cleanText(cover.subject) && cleanText(cover.body) &&
      payload.coverEmailDigest === hash(cover)) &&
    payload.emailSent === false && payload.reservationSaved === false &&
    payload.sourceHash === draft.source.sourceHash && observation.generationId === draft.generationId &&
    observation.propertyCode === draft.propertyCode && observation.sourceMessageId === draft.source.messageId &&
    criteria?.workflow === 'quote' && criteria.requestId === result.requestId && criteria.operationId === result.id &&
    typeof criteria.inputDigest === 'string' && Boolean(criteria.inputDigest);
  if (!boundCover) return false;
  if (payload.unavailableInventory !== undefined) {
    return validUnavailableInventoryReceipt(draft, result, observation, payload);
  }
  return Boolean(prepared && ref && observation.sourceRefs.includes(ref) && prepared.kind === 'rate_availability' &&
      prepared.status === 'complete' && prepared.coverage.complete && prepared.generationId === draft.generationId &&
      prepared.propertyCode === draft.propertyCode && prepared.sourceMessageId === draft.source.messageId &&
      preparedCriteria?.workflow === 'quote' && preparedCriteria.requestId === result.requestId &&
      preparedCriteria.sourceHash === draft.source.sourceHash && preparedCriteria.inputDigest === criteria.inputDigest &&
      preparedResult?.sourceHash === draft.source.sourceHash && revision?.id === payload.revisionRef);
}

/** Positive-only recovery: durable receipts are replayed; absent receipts never trigger a fresh HMS action. */
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
  const observation = operationObservation(loaded.draft, result.id, result.observationRefs);
  if (result.status === 'unknown' && !observation && quoteOperationExpired(result)) {
    const failed: QuoteOperationResult = { ...result, status: 'failed', updatedAt: new Date().toISOString(),
      summary: 'No quote output receipt was saved. No reservation was saved and no email was sent; check the quote before generating outputs again.' };
    const saved = await persistResult(ctx, input, loaded.draft.generationId, failed);
    return saved.status === 'ok' ? { status: 'failed', operationId: result.id, summary: failed.summary,
      artifacts: [], failures: [], emailSent: false, reservationSaved: false, retryAvailable: true } : saved;
  }
  if (observation && result.status === 'unknown') {
    const payload = record(observation.result) ?? {};
    const rawArtifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
    const artifacts = rawArtifacts.map(record).filter((artifact): artifact is Record<string, unknown> => Boolean(artifact))
      .filter((artifact) => {
        const encoded = typeof artifact.bytesBase64 === 'string' ? artifact.bytesBase64 : null;
        if (!encoded) return false;
        const bytes = Buffer.from(encoded, 'base64');
        return bytes.length > 0 && bytes.toString('base64') === encoded &&
          Number.isSafeInteger(artifact.sizeBytes) && artifact.sizeBytes === bytes.length &&
          artifact.sha256 === createHash('sha256').update(bytes).digest('hex');
      });
    const artifactsValid = artifacts.length === rawArtifacts.length;
    const textReceiptValid = rawArtifacts.length === 0 && validTextQuoteReceipt(loaded.draft, result, observation, payload);
    if (observation.status === 'complete' && observation.coverage.complete && artifactsValid &&
        (rawArtifacts.length > 0 || textReceiptValid)) {
      const recovered: QuoteOperationResult = { ...operationResult(loaded.draft, result.requestId, result.id, 'succeeded', [observation.ref],
        textReceiptValid ? 'Recovered the stored unsent quote email draft; no reservation saved or email sent'
          : `Recovered ${artifacts.length} stored quote artifact(s); no reservation saved or email sent`),
      draftRevision: result.draftRevision };
      const saved = await persistResult(ctx, input, loaded.draft.generationId, recovered);
      return saved.status === 'ok' ? { status: 'succeeded', operationId: result.id,
        observationRef: observation.ref, artifacts, coverEmail: payload.coverEmail, emailSent: false, reservationSaved: false } : saved;
    }
    const failures = Array.isArray(payload.failures)
      ? payload.failures.filter((failure): failure is string => typeof failure === 'string')
      : [...observation.coverage.notes];
    if (!artifactsValid) failures.push('quote_artifact_receipt_invalid');
    if (!failures.length) failures.push('quote_artifact_generation_incomplete');
    const summary = `Recovered an incomplete quote output receipt with ${artifacts.length} stored artifact(s); no reservation saved or email sent`;
    const recovered: QuoteOperationResult = { ...operationResult(loaded.draft, result.requestId, result.id, 'failed', [observation.ref], summary),
      draftRevision: result.draftRevision };
    const saved = await persistResult(ctx, input, loaded.draft.generationId, recovered);
    return saved.status === 'ok' ? { status: 'failed', operationId: result.id, summary,
      observationRef: observation.ref, artifacts, coverEmail: payload.coverEmail, failures,
      emailSent: false, reservationSaved: false, retryAvailable: true } : saved;
  }
  if (result.status === 'succeeded' || result.status === 'failed') {
    const payload = record(observation?.result) ?? {};
    return { status: result.status, operationId: result.id, summary: result.summary,
      observationRef: observation?.ref, artifacts: payload.artifacts ?? [], coverEmail: payload.coverEmail,
      failures: payload.failures ?? [], emailSent: false, reservationSaved: false };
  }
  return { status: 'needs_reconcile', operationId: result.id,
    issue: 'quote_artifact_receipt_not_confirmed; do_not_retry_automatically' };
}
