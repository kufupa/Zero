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
import { propertyCodeSchema } from '../hms/property-registry.js';
import { buildStaffProposalFacts, staffQuoteInput } from './staff-quote-workflow.js';
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
import { compileQuote, compilePreparedUnavailableQuote, currentQuoteAvailabilityObservation, operationResults,
  preparedUnavailableOperation, quoteExtrasReadiness, quoteInputOverrides, quoteOverridesMatch, quoteReadiness, resolvedLeaf, sameName,
  unavailableInventoryProof, UNAVAILABLE_PREPARED_SUMMARY, type CompiledQuote, type QuoteOperationResult, type QuoteRequest, type UnavailableInventoryProof
} from './reservation-workflow-v2-quote-readiness.js';

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
  companyShownInCover: boolean;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const cleanText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;
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
      actual.mealPlan !== 'breakfast' || typeof actual.rateCode !== 'string' || !actual.rateCode.trim() ||
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
  if (input.extras?.length) {
    const facts = record(factsValue);
    if (!facts || facts.revisionId !== revision.id || facts.authorizationId !== revision.authorizationId || facts.sourceHash !== input.sourceHash) return false;
    try {
      const expectedFacts = buildStaffProposalFacts({ ...input, dinnerAllowanceMinor: undefined, dinnerAllowanceUnit: undefined,
        dinnerAllowanceLabel: undefined, dinnerAllowanceGroupIds: undefined }, { messageId: input.messageId, sourceHash: input.sourceHash },
        { authorizationId: String(revision.authorizationId) }, revision as unknown as QuoteRevision).facts;
      const expectedExtras = expectedFacts?.extras ?? [];
      const actualExtras = Array.isArray(facts.extras) ? facts.extras : [];
      if (!expectedExtras.length || expectedExtras.some(expected =>
        !actualExtras.some(actual => hash(actual) === hash(expected)))) return false;
      deriveAuthorizedExtraLines(revision as unknown as QuoteRevision, facts as unknown as AuthorizedProposalFacts);
    } catch { return false; }
  }
  for (const expected of input.groups) {
    const actual = groups.find((group) => group?.id === expected.id);
    const board = expected.mealPlan === 'bb' ? 'breakfast'
      : expected.mealPlan === 'dinner_bb' ? 'dinner_bed_breakfast' : 'room_only';
    const boardMatches = actual?.mealPlan === board || Boolean(actual && expected.mealPlan === 'dinner_bb' &&
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

function unavailableInventoryMarker(
  compiled: Extract<CompiledQuote, { status: 'ok' }>,
  proof: UnavailableInventoryProof,
): Record<string, unknown> {
  const { group } = proof;
  return {
    kind: 'requested_room_unavailable',
    availabilityObservationRef: proof.observation.ref,
    groupId: group.id,
    roomCode: proof.roomCode,
    roomLabel: proof.roomLabel,
    rateCode: group.rateCode,
    mealPlan: group.mealPlan,
    arrivalDate: group.arrivalDate,
    departureDate: group.departureDate,
    quantity: group.quantity,
    freshUntil: proof.freshUntil,
  };
}

export const compileReservationWorkflowV2Quote = compileQuote;

async function quoteTarget(ctx: ReadContext, input: QuoteBaseInput) {
  try {
    const result = await resolveHmsQuoteJobTarget({
      transportId: ctx.transport.id,
      threadId: input.source.threadId,
      messageId: input.source.messageId,
      propertyCode: propertyCodeSchema.parse(ctx.property.propertyCode),
    });
    if (!result.ok) {
      console.warn('quote_target_not_enabled', { workItemId: input.workItemId, propertyCode: ctx.property.propertyCode });
      return { target: null, issue: 'quote_property_not_enabled' };
    }
    if (result.target.propertyCode !== ctx.property.propertyCode) {
      console.warn('quote_target_scope_mismatch', { workItemId: input.workItemId, propertyCode: ctx.property.propertyCode });
      return { target: null, issue: 'quote_property_scope_mismatch' };
    }
    return { target: result.target, issue: null };
  } catch {
    console.warn('quote_target_unavailable', { workItemId: input.workItemId, propertyCode: ctx.property.propertyCode });
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
      strategySource: compiled.strategyDefaulted ? 'discovery_default' : 'draft',
      mealPlanDefaultedGroupIds: compiled.mealPlanDefaultedGroupIds },
    nativeInputDigest: result.inputDigest ?? null,
    inputOverrides: quoteInputOverrides(draft, compiled.request.id),
    requestedGroups: compiled.input.groups,
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
  const observation = currentQuoteAvailabilityObservation(draft, compiled.request.id, compiled.inputDigest);
  if (!observation || observation.status !== 'complete' || !observation.coverage.complete ||
      (preparedOnly && !preparedRefs.has(observation.ref))) return null;
  const criteria = record(observation.criteria), result = record(observation.result);
  const revision = record(result?.revision);
  const expires = typeof result?.freshUntil === 'string' ? Date.parse(result.freshUntil) : Number.NaN;
  return criteria?.workflow === 'quote' && criteria.requestId === compiled.request.id &&
    criteria.inputDigest === compiled.inputDigest && criteria.sourceHash === draft.source.sourceHash &&
    Number.isFinite(expires) && expires > now && revision?.propertyCode === draft.propertyCode &&
    quoteOverridesMatch(draft, compiled.request.id, result?.inputOverrides) &&
    preparedQuoteMatches(compiled.input, revision, result?.facts, result?.dinnerFallbackGroupIds)
    ? observation : null;
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

async function prepareUnavailableInventory(
  ctx: ReadContext,
  input: QuoteBaseInput,
  draft: ReservationWorkflowV2Draft,
  compiled: Extract<CompiledQuote, { status: 'ok' }>,
  proof: UnavailableInventoryProof,
) {
  const operation = operationResult(draft, compiled.request.id, randomUUID(), 'prepared', [proof.observation.ref],
    UNAVAILABLE_PREPARED_SUMMARY);
  const saved = await persistResult(ctx, input, draft.generationId, operation);
  return saved.status === 'ok' ? {
    status: 'prepared' as const,
    requestId: compiled.request.id,
    operationId: operation.id,
    observationRef: proof.observation.ref,
    summary: operation.summary,
    unavailableInventory: unavailableInventoryMarker(compiled, proof),
  } : saved;
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
    ...(parties?.organization ? { organization: parties.organization.nativeId } : {}),
    ...(parties?.bookingAgency ? { bookingAgency: parties.bookingAgency.nativeId } : {}),
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
  if (draft.propertyCode !== ctx.property.propertyCode) {
    return { status: 'failed' as const, issue: 'quote_property_scope_mismatch' };
  }
  let quote: QuoteRunResult;
  try {
    quote = await runStaffQuote(compiled.input, { transportId: ctx.transport.id,
      propertyCode: propertyCodeSchema.parse(draft.propertyCode) }, ctx.db,
      ctx.nativeBatch ? { persistence: 'return_only', signal: ctx.nativeBatch.signal,
        deadlineAt: ctx.nativeBatch.deadlineAt, preparedRunId: ctx.nativeBatch.jobFence.runId, autoStart: true } : {}) as unknown as QuoteRunResult;
  } catch (error) {
    ctx.nativeBatch?.signal.throwIfAborted();
    const cause = staffQuoteCauseSummary(error);
    if (cause.code === 'HMS_LOCK_BUSY' || cause.code === 'STAFF_QUOTE_ACTIVE') {
      return { status: 'failed' as const, issue: cause.code, outcomeClass: 'hms_busy' as const };
    }
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
    const answered = Boolean(latest) && (mismatch || shortage || restricted);
    if (!answered) console.warn('quote_price_failed', { workItemId: input.workItemId, requestId: compiled.request.id, code: cause.code, phase: cause.phase ?? 'unknown' });
    const failureDetails = {
      searchContext: { salesStrategy: compiled.input.salesStrategy,
        strategySource: compiled.strategyDefaulted ? 'discovery_default' : 'draft',
      mealPlanDefaultedGroupIds: compiled.mealPlanDefaultedGroupIds },
      failureCode: cause.code,
      failurePhase: cause.phase ?? 'unknown',
      failureKind: !answered ? 'system_fault' : cause.code === 'native_quote_no_matching_rate' ? 'requested_mismatch'
        : mismatch ? 'requested_unqualified' : shortage ? 'proven_shortage' : 'restricted',
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
      ? { status: answered ? 'needs_input' as const : 'failed' as const, issue, outcomeClass: answered ? 'hms_answered_no' as const : 'system_fault' as const, observationRef: failure.ref,
        quote: { observationRef: failure.ref, ...failureDetails } }
      : saved;
  }
  const observation = quoteObservation(draft, compiled, quote, null);
  const saved = await persistObservation(ctx, input, observation);
  if (saved.status !== 'ok') return saved;
  if (!observation.coverage.complete) {
    if (quote.dinnerAddOnRequired === true) {
      const path = `${quoteBodyPath(compiled.request.id)}/requestedMoney`;
      return { status: 'needs_input' as const, outcomeClass: 'needs_input' as const,
        issue: 'quote_dinner_scope_required', fields: [path],
        readiness: [{ code: 'quote_dinner_scope_required', path,
          message: 'Enter a dinner price and select every room group that needs dinner' }],
        observationRef: observation.ref };
    }
    console.warn('quote_price_incomplete', { workItemId: input.workItemId, requestId: compiled.request.id, code: observation.coverage.notes[0] ?? 'incomplete' });
    return { status: 'failed' as const, outcomeClass: 'system_fault' as const,
    issue: quote.status !== 'ready' ? 'native_quote_price_unavailable'
      : observation.coverage.notes[0] === 'native_quote_price_expired'
        ? 'native_quote_price_expired' : 'native_quote_business_fields_did_not_match_request',
    observationRef: observation.ref };
  }
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
  for (const role of ['organization', 'bookingAgency'] as const) {
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
      const found = await lookupNativeParty({ role: role === 'organization' ? 'organization' : 'agency',
        name, target: target.target, transportId: ctx.transport.id, signal: ctx.nativeBatch.signal });
      if (found.result.outcome === 'refused_lock_busy' || found.result.reason === 'HMS_LOCK_BUSY' || found.coverage.notes.includes('refused_lock_busy')) {
        return { status: 'failed', issue: 'HMS_LOCK_BUSY', outcomeClass: 'hms_busy', candidates };
      }
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
      if (found.status !== 'complete') {
        console.warn('quote_party_lookup_incomplete', { workItemId: input.workItemId, requestId: request.id });
        return { status: 'failed', issue: 'native_party_search_incomplete', outcomeClass: 'system_fault', candidates };
      }
      continue;
    }
    let found: Awaited<ReturnType<typeof findParty>>;
    try {
      found = await findParty({ kind: role, name }, { target: target.target, transportId: ctx.transport.id });
    } catch (error) {
      const cause = staffQuoteCauseSummary(error);
      if (cause.code === 'HMS_LOCK_BUSY' || cause.code === 'STAFF_QUOTE_ACTIVE') {
        return { status: 'failed', issue: cause.code, outcomeClass: 'hms_busy', candidates };
      }
      console.warn('quote_party_lookup_failed', { workItemId: input.workItemId, requestId: request.id, code: cause.code, phase: cause.phase ?? 'unknown' });
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
    if (found.outcome === 'refused_lock_busy') return { status: 'failed', issue: 'HMS_LOCK_BUSY', outcomeClass: 'hms_busy', candidates };
    if (!['resolved', 'ambiguous', 'no_match'].includes(found.outcome)) {
      console.warn('quote_party_lookup_failed', { workItemId: input.workItemId, requestId: request.id, code: found.outcome });
      return { status: 'failed', issue: 'native_party_search_failed', outcomeClass: 'system_fault', candidates };
    }
    if (found.truncated) {
      console.warn('quote_party_lookup_incomplete', { workItemId: input.workItemId, requestId: request.id });
      return { status: 'failed', issue: 'native_party_search_incomplete', outcomeClass: 'system_fault', candidates };
    }
    const answered = true;
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
      results.push({ status: 'needs_input', requestId: request.id, issue: compiled.issue, fields: compiled.fields, outcomeClass: 'needs_input',
        readiness: quoteReadiness(loaded.draft, request.id, 'check'),
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
    } catch (error) {
      const cause = staffQuoteCauseSummary(error);
      const busy = cause.code === 'HMS_LOCK_BUSY' || cause.code === 'STAFF_QUOTE_ACTIVE';
      if (!busy) console.warn('quote_lookup_failed', { workItemId: input.workItemId, requestId: request.id, code: cause.code, phase: cause.phase ?? 'unknown' });
      results.push({ status: 'failed', requestId: request.id, issue: busy ? cause.code : 'native_quote_price_unavailable',
        outcomeClass: busy ? 'hms_busy' : 'system_fault', partyCandidates: parties.candidates });
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
  if (compiled.status !== 'ok') return { status: 'needs_input', issue: compiled.issue, fields: compiled.fields, outcomeClass: 'needs_input',
    readiness: quoteReadiness(loaded.draft, request.id, 'check') };
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
  const existingUnavailable = unavailableInventoryProof(loaded.draft, compiled);
  if (existingUnavailable) {
    return prepareUnavailableInventory(ctx, input, loaded.draft, compiled, existingUnavailable);
  }
  try {
    const priced = await priceQuote(ctx, input, loaded.draft, compiled);
    if (priced.status !== 'priced') {
      if (priced.status !== 'needs_input') return priced;
      // priceQuote persists proven native shortage as a failed availability observation. Reload it
      // before preparing a decline, then bind the operation to the exact current inputs and ref.
      const current = await getReservationWorkflowV2Draft(stateContext(ctx), {
        workItemId: input.workItemId, source: input.source,
      });
      if (current.status !== 'ok') return current;
      if (current.draft.generationId !== loaded.draft.generationId) return { status: 'stale_revision' };
      const currentRequest = quoteRequests(current.draft, input.requestId)[0];
      if (!currentRequest) return { status: 'not_found' };
      const currentCompiled = compileQuote(current.draft, currentRequest, false);
      if (currentCompiled.status !== 'ok') return { status: currentCompiled.status,
        issue: currentCompiled.issue, fields: currentCompiled.fields };
      if (currentCompiled.inputDigest !== compiled.inputDigest) return { status: 'stale_revision' };
      const unavailable = unavailableInventoryProof(current.draft, currentCompiled);
      if (!unavailable) return priced;
      const currentInput = { ...input, expectedRevision: current.revision, expectedSeq: current.seq };
      return prepareUnavailableInventory(ctx, currentInput, current.draft, currentCompiled, unavailable);
    }
    const observation = priced.observation;
    if (!observation) return { status: 'failed', issue: 'quote_price_observation_missing' };
    const result = operationResult(loaded.draft, request.id, randomUUID(), 'prepared', [observation.ref],
      'Current HMS quote price and availability prepared; no reservation or email created');
    const saved = await persistResult(ctx, input, loaded.draft.generationId, result);
    return saved.status === 'ok' ? { status: 'prepared', requestId: request.id, operationId: result.id,
      quote: pricePayload(observation), observationRef: observation.ref } : saved;
  } catch (error) {
    const cause = staffQuoteCauseSummary(error);
    const busy = cause.code === 'HMS_LOCK_BUSY' || cause.code === 'STAFF_QUOTE_ACTIVE';
    if (!busy) console.warn('quote_prepare_failed', { workItemId: input.workItemId, requestId: request.id, code: cause.code, phase: cause.phase ?? 'unknown' });
    return { status: 'failed', issue: busy ? cause.code : 'native_quote_prepare_failed', outcomeClass: busy ? 'hms_busy' : 'system_fault' };
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
      `${line.quantity} room${line.quantity === 1 ? '' : 's'}, ${group.adults} adult${group.adults === 1 ? '' : 's'} and ${group.children} ${group.children === 1 ? 'child' : 'children'}${ages} per room · ${boardLabels[group.mealPlan]}`,
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
    organization: compiled.input.organization,
    bookingAgency: compiled.input.bookingAgency,
    displayBookingAgency: compiled.input.bookingAgency,
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
      artifacts.push({ kind: 'xlsx_quote', fileName: quoteWorkbookFileName(compiled.input.bookingAgency || compiled.input.organization,
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
        const pdf = await buildStaysProposalPdf(stays, { ...header, notes: compiled.input.notes },
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
    sourceHash: compiled.input.sourceHash, nativeInputDigest: typeof prepared?.nativeInputDigest === 'string' ? prepared.nativeInputDigest : null,
    preparedObservationRef: preparedObservation.ref, workflowRunId: typeof prepared?.workflowRunId === 'string' ? prepared.workflowRunId : null,
    claims: compiled.input.groups.map((entry) => ({ groupId: entry.id, arrivalDate: entry.arrivalDate,
      departureDate: entry.departureDate, quantity: entry.quantity, mealPlan: entry.mealPlan, adultsPerRoom: entry.adults,
      childAgesPerRoom: entry.childrenAges })),
    companyShownInCover: false };
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
      quantity: group.quantity, mealPlan: group.mealPlan, adultsPerRoom: group.adults,
      childAgesPerRoom: group.childrenAges }],
    unavailableInventory: unavailableInventoryMarker(compiled, proof),
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
  let compiled = compileQuote(loaded.draft, request, true);
  let declineOnly = false;
  if (compiled.status !== 'ok') {
    const decline = compilePreparedUnavailableQuote(loaded.draft, request);
    if (decline) {
      compiled = decline;
      declineOnly = true;
    }
  }
  if (compiled.status !== 'ok') return { status: 'needs_input', issue: compiled.issue, fields: compiled.fields, outcomeClass: 'needs_input',
    readiness: quoteReadiness(loaded.draft, request.id, 'execute') };
  const preparedObservation = declineOnly ? null : matchingPreparedQuote(loaded.draft, compiled, true);
  const unavailable = preparedObservation ? null : unavailableInventoryProof(loaded.draft, compiled);
  if (!preparedObservation && !unavailable) return { status: 'needs_prepare', issue: 'current_native_quote_prepare_required' };
  if (unavailable && !preparedUnavailableOperation(loaded.draft, request.id, unavailable.observation.ref)) {
    return { status: 'needs_prepare', issue: 'current_native_unavailable_decline_prepare_required' };
  }
  if (unavailable && !compiled.outputKinds.includes('email_quote')) {
    const readiness = quoteReadiness(loaded.draft, request.id, 'execute');
    return { status: 'needs_input', outcomeClass: 'needs_input', issue: 'cover_email_required_for_unavailable_reply',
      fields: readiness.map(item => item.path), readiness };
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
    const extrasReadiness = quoteExtrasReadiness(loaded.draft, request.id, preparedObservation.ref);
    if (extrasReadiness.length) {
      return { status: 'needs_review', outcomeClass: 'needs_input', issue: 'quote_extras_require_staff_acceptance',
        fields: extrasReadiness.map(item => item.path), readiness: extrasReadiness,
        extrasReviewItems, extrasReviewPath: extrasReadiness[0]?.path };
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
    console.warn('quote_artifact_generation_failed', { workItemId: input.workItemId, requestId: request.id });
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
  const strict = compileQuote(draft, request, true);
  const compiled = strict.status === 'ok' ? strict : compilePreparedUnavailableQuote(draft, request) ?? strict;
  if (compiled.status !== 'ok' || !compiled.outputKinds.includes('email_quote')) return false;
  const proof = unavailableInventoryProof(draft, compiled);
  if (!proof) return false;
  if (!preparedUnavailableOperation(draft, result.requestId, proof.observation.ref)) return false;
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
