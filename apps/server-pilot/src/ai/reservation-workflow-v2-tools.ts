import { assertReservationActionFence, lockReservationActionClaim } from './reservation-workflow-v2-action-lane.js';
import { isLunchOnlyMealRequest, normalizeRequestedMealPlan } from './reservation-workflow-v2-meal-plan.js';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import type { AiRunFence } from './run-ledger.js';
import { consumeStaffGoAtDispatch, hmsAllocationOperationId } from './hms-approval.js';
import { mailboxAccess, mailThread, message } from '../db/schema/mail.js';
import { workEvent, workItem } from '../db/schema/work.js';
import {
  reservationWorkflowV2DraftSchema,
  type ReservationWorkflowV2Draft,
  type ReservationWorkflowV2ExecuteInput,
  type ReservationWorkflowV2LookupInput,
  type ReservationWorkflowV2Observation,
  type ReservationWorkflowV2PrepareInput,
  type ReservationWorkflowV2ReconcileInput,
} from './reservation-workflow-v2-contract.js';
import {
  appendReservationWorkflowV2Observation,
  getReservationWorkflowV2Draft,
  lockReservationWorkflowV2Source,
  recordReservationWorkflowV2Result,
  reservationWorkflowV2DraftOf,
  withReservationWorkflowV2Draft,
  type ReservationNativeCheckBatch,
  type ReservationRecoveryScope,
  type ReservationWorkflowV2Context,
} from './reservation-workflow-v2-state.js';
import { canonicalJson } from './draft-approval.js';
import {
  captureHmsLabtestDispatchEpoch,
  claimHmsLabtestDispatch,
  HmsLabtestDispatchError,
  nativeCreateSaveDigest,
  recoverHmsLabtestCreate,
  readResolvedHmsLabtestCreates,
  resolveHmsLabtestDispatch,
  resolveNeverDispatchedCreate,
  type HmsLabtestIntent,
  type HmsLabtestWriteHandle,
} from './hms-labtest-dispatch.js';
import { hmsDispatchTargetKeys, hmsDispatchTargetSchema, type HmsDispatchTarget } from './hms-dispatch-target.js';
import { persistHmsShots, readStoredHmsShot, verifyStoredHmsShot } from './hms-shots-store.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import { acquisitionWithin, assertTargetAliasesHeld, createPostgresTargetAliasLock,
  PANE_PROPERTY_LOCK_WAIT_MS, isPropertyReadLockDeadline, type HeldTargetAliasLock } from '../hms/property-read-lock.js';
import { loadNativeRatePlans, propertyConfigurationForScope } from '../hms/rate-catalogue.js';
import { propertySwitchSchema, resolvePropertyScope } from '../hms/property-registry.js';
import { cloudCreatePolicyIssue } from './pane-create-cloud-input.js';
import { paneStayCloudTargetLock, paneStayCreateTarget, paneStayPropertyLock } from './pane-stay-save.js';
import { effectiveWorkflowPolicy } from '../../tooling/hms-cloud/hms-workflow-policy.mjs';
import { propertyCodeSchema } from '../hms/property-registry.js';
import { paneStayLookupEnabled } from './pane-stay-lookup.js';
import { projectCloudStayFind, runCloudStayFind } from './hms-cloud-saved-stay-find.js';
import { blockingCreateMatches, createCloudTargetKey, isLabtestGuest } from '../../tooling/hms-cloud/cloud-create-policy.mjs';
import { lockCreateActorSession } from './pane-create-actor-lock.js';
import { stayCommitsOf } from './work-items.js';
import { sameGuestName } from './guest-name-match.js';
import { compileCreateCore, createReadiness, effectiveSubtree, reviewed, leaf, existingConfirmationPath, exactSourceConfirmationClaim, sourceConfirmationClaim,
  type CreateCompileIssueDetail, type CreateRequestBody } from './reservation-workflow-v2-create-readiness.js';
export { effectiveSubtree, reviewed } from './reservation-workflow-v2-create-readiness.js';
import { quoteRateContextEnabled } from './quote-rate-switch.js';
import { boardsFor, norm } from './rate-options.js';
import { partyMatchSearchTerms } from './party-match-v2.js';
import { reservationEntityKey } from './reservation-workflow-v2-native-leads.js';
import type { ReservationWorkflowV2SystemReadContext } from './reservation-workflow-v2-system-read-context.js';
import { hmsReadTargetForProperty } from '../hms/hms-read-target.js';
import { getPropertyRegistration } from '../../tooling/hms-cloud/property-registry.mjs';
import { withCloudCredentialLease, type CloudCredentialLease } from '../../tooling/hms-cloud/cloud-session.mjs';

type V2StateContext = ReservationWorkflowV2Context;
export type ReservationWorkflowV2ServerContext = {
  db: DB;
  transport: { id: string };
  user: { id: string; sessionId?: string; sessionProfile?: 'legacy' | 'remote' };
  property: { propertyCode: string };
  writeRunFence?: AiRunFence;
  signal?: AbortSignal;
  heldTargetLock?: HeldTargetAliasLock;
  credentialLease?: CloudCredentialLease;
  verifiedBatchSiblings?: Array<{ confirmation: string; nativeStayId: string; approvedRequest: Record<string, unknown>;
    requestDigest: string; ratePlanAvailability: { averageRate: string; totalRate: string; currency: string };
    checkedPricing?: unknown; arProfileId?: string }>;
  /** Internal service-only scope; never populated from a pane request. */
  nativeBatch?: ReservationNativeCheckBatch;
  /** Internal reconciliation-only scope; never populated from a pane request. */
  recovery?: ReservationRecoveryScope;
};
type ReadContext = ReservationWorkflowV2ServerContext | ReservationWorkflowV2SystemReadContext;

async function createPolicyIssue(ctx: ReadContext, input: Record<string, unknown>): Promise<string | null> {
  const scope = resolvePropertyScope({ transportId: ctx.transport.id,
    ...(ctx.property.propertyCode === 'HRCEN' ? {} : { propertySwitch: propertySwitchSchema.parse(ctx.property.propertyCode) }) });
  return cloudCreatePolicyIssue((await propertyConfigurationForScope(scope)).formPolicy, input);
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const sameName = (left: unknown, right: unknown): boolean => typeof left === 'string' && typeof right === 'string' &&
  left.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase() ===
  right.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
const samePhone = (left: unknown, right: unknown): boolean => typeof left === 'string' && typeof right === 'string' &&
  Boolean(left.replace(/\D/g, '')) && left.replace(/\D/g, '') === right.replace(/\D/g, '');
const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
});

type Outcome = { status: string; issue?: string; [key: string]: unknown };
type NativeCreate = {
  outcome?: string; issue?: string; missing?: unknown[]; unsupportedFields?: unknown[];
  commitOnlyFields?: string[];
  applied?: Record<string, unknown>; ratePlanAvailability?: unknown; ratePlanIssue?: unknown;
  requestBinding?: { request?: unknown; digest?: unknown }; screenshots?: Record<string, unknown>;
  save?: { outcome?: string; dispatchCallbacksDrained?: boolean; billingReferenceStaged?: boolean; checkedPricing?: unknown };
  confirmation?: unknown; nativeStayId?: unknown; readback?: { fields?: unknown; mismatches?: unknown[]; partyProof?: unknown };
  writerSessionClosed?: boolean; saveAttempted?: boolean;
};
type NativeContinuation = (() => Promise<unknown>) & { proveNeverDispatched?: () => unknown };

function stateContext(ctx: ReadContext): V2StateContext {
  return { db: ctx.db, transportId: ctx.transport.id, userId: 'system' in ctx || ctx.nativeBatch ? null : ctx.user.id,
    propertyCode: ctx.property.propertyCode, nativeBatch: ctx.nativeBatch, recovery: ctx.recovery };
}

async function currentDraft(ctx: ReadContext, input: {
  workItemId: string; source: ReservationWorkflowV2PrepareInput['source']; expectedRevision: number; expectedSeq: number;
}) {
  const result = await getReservationWorkflowV2Draft(stateContext(ctx), input);
  if (result.status !== 'ok') return { result, draft: null } as const;
  if (result.revision !== input.expectedRevision || result.seq !== input.expectedSeq ||
      result.draft.revision !== input.expectedRevision) {
    return { result: { status: 'stale_revision' }, draft: null } as const;
  }
  return { result, draft: reservationWorkflowV2DraftSchema.parse(result.draft) } as const;
}

function ptr(...parts: Array<string | number>): string {
  return `/${parts.map((part) => encodeURIComponent(String(part))).join('/')}`;
}

type CreateCompile = { outcome: 'ok'; nativeInput: Record<string, unknown>; expectedGuest: { firstName: string; lastName: string };
  target: HmsDispatchTarget; reviewPaths: string[]; partySelectionPaths: Record<string, string>;
  semanticDigest: string; requestedMealPlan: string | null; mealPlan: string | null; preparedBinding: Record<string, unknown> | null } |
  { outcome: 'needs_input' | 'needs_review' | 'unsupported'; issue: string; fields?: string[]; details?: CreateCompileIssueDetail[] };


function createDispatchAdmission(compiled: Extract<CreateCompile, { outcome: 'ok' }>): { allowed: true; allowRealGuest: boolean } |
  { allowed: false; issue: string } {
  const input = compiled.nativeInput;
  const property = propertyCodeSchema.safeParse(input.propertyCode);
  if (!property.success) return { allowed: false, issue: 'property_scope_invalid' };
  const mode = effectiveWorkflowPolicy(process.env, property.data, 'create').admittedMode;
  if (mode === 'off') return { allowed: false, issue: 'pane_save_flag_off' };
  if (property.data === 'HRCEN' && process.env.PANE_CLOUD_CREATE_DISPATCH !== 'on') return { allowed: false, issue: 'cloud_create_dispatch_flag_off' };
  const allowRealGuest = !isLabtestGuest(compiled.expectedGuest);
  const stay = record(input.stay), cms = record(input.cms);
  if (allowRealGuest) {
    if (mode !== 'on' || (property.data === 'HRCEN' && process.env.PANE_WRITE_CREATE !== 'on')) {
      return { allowed: false, issue: 'real_guest_create_requires_write_on' };
    }
  } else {
    const arrival = text(stay?.arrival);
    const departure = text(stay?.departure);
    if (!arrival || arrival < '2027-01-01' || !departure || !isoDate.safeParse(arrival).success ||
        !isoDate.safeParse(departure).success || cms?.send === true) {
      return { allowed: false, issue: 'labtest_create_requires_2027_and_cms_off' };
    }
  }
  return { allowed: true, allowRealGuest };
}

function compileCreate(draft: ReservationWorkflowV2Draft, requestId: string, allocationId: string, propertyCode: string,
  mode: 'prepare' | 'background_prepare' | 'lookup' | 'execute' = 'prepare'): CreateCompile {
  const core = compileCreateCore(draft, requestId, allocationId, propertyCode, mode, Boolean(getPropertyRegistration(propertyCode)?.active));
  if (core.outcome !== 'ok') return core;
  const { nativeInput, expectedGuest, requestedMealPlan, mealPlan } = core;
  const guestName = `${expectedGuest.firstName} ${expectedGuest.lastName}`;
  const targetParsed = hmsDispatchTargetSchema.safeParse({ propertyCode, kind: 'create',
    firstName: expectedGuest.firstName, lastName: expectedGuest.lastName, arrival: record(nativeInput.stay)?.arrival });
  if (!targetParsed.success || targetParsed.data.kind !== 'create') return { outcome: 'needs_input', issue: 'invalid_create_target' };
  const semanticDigest = sha256({ nativeInput, guestName, requestedMealPlan, mealPlan });
  if (mode === 'execute') {
    const priceComparison = reservationWorkflowV2CreatePriceComparison(draft, requestId, allocationId, propertyCode);
    if (priceComparison.blocksGo) return { outcome: 'needs_input',
      issue: priceComparison.status === 'mismatch' ? 'create_requested_price_mismatch' : 'create_requested_price_unverifiable',
      fields: ['priceComparison'] };
  }
  return { ...core, target: targetParsed.data, semanticDigest, preparedBinding: null };
}

/** Reuse the same Create field compiler when a service preview needs its owning unsaved stay. */
export function compileReservationWorkflowV2Create(draft: ReservationWorkflowV2Draft, requestId: string,
  allocationId: string, propertyCode: string): CreateCompile {
  return compileCreate(draft, requestId, allocationId, propertyCode, 'prepare');
}

export function reservationWorkflowV2MealPlanMatches(expected: string | null, observed: unknown, propertyCode: string): boolean {
  if (expected === null) return true;
  if (typeof observed !== 'string') return false;
  const requested = normalizeRequestedMealPlan(expected);
  const aliases = boardsFor(propertyCode);
  const mealCode = (value: string) => {
    const normalized = norm(value);
    const mealPlan = normalizeRequestedMealPlan(value).mealPlan;
    const key = mealPlan === 'dinner_bb' ? 'dinner_bed_breakfast' : mealPlan;
    return aliases[normalized] ?? (key ? aliases[key] : undefined);
  };
  const expectedCode = mealCode(expected), observedCode = mealCode(observed);
  if (requested.lunchRequested && requested.mealPlan === null && isLunchOnlyMealRequest(expected)) return observedCode !== undefined;
  return expectedCode !== undefined && expectedCode === observedCode;
}

/** A requested cue is compared to a current, actually observed native value. */
export function reservationWorkflowV2CreateMealPlanMatches(requested: string | null, desiredActual: string | null,
  observed: unknown, propertyCode: string): boolean {
  return typeof observed === 'string' && Boolean(observed.trim()) && observed.length <= 120 && !/[\p{Cc}]/u.test(observed) &&
    reservationWorkflowV2MealPlanMatches(requested, observed, propertyCode) &&
    reservationWorkflowV2MealPlanMatches(desiredActual, observed, propertyCode);
}

function mapNativeOutcome(native: NativeCreate): Outcome {
  if (native.outcome === 'prepared' && native.requestBinding && native.ratePlanAvailability) {
    return { status: 'prepared', native };
  }
  return { status: native.outcome === 'unsupported' ? 'unsupported' : native.outcome === 'needs_input' ? 'needs_input' : 'failed',
    issue: native.issue ?? 'native_create_prepare_incomplete', native };
}

function validPrice(value: unknown): { averageRate: string; totalRate: string; currency: string } | null {
  const parsed = z.object({ averageRate: z.string().trim().min(1).max(64), totalRate: z.string().trim().min(1).max(64),
    currency: z.string().trim().min(1).max(16) }).safeParse(value);
  return parsed.success ? parsed.data : null;
}

function operationObservation(draft: ReservationWorkflowV2Draft, requestId: string, allocationId: string,
  input: unknown, native: NativeCreate, price: { averageRate: string; totalRate: string; currency: string } | null,
  status: 'complete' | 'partial' | 'failed', prepareShot: unknown, semanticDigest: string,
  requestedMealPlan: string | null, validationIssue?: string): ReservationWorkflowV2Observation {
  const binding = record(native.requestBinding);
  return {
    ref: randomUUID(), generationId: draft.generationId, kind: 'rate_availability', status, observedAt: new Date().toISOString(),
    propertyCode: draft.propertyCode, sourceMessageId: draft.source.messageId, sourceRefs: [],
    criteria: { workflow: 'create', requestId, allocationId, draftRevision: draft.revision,
      inputDigest: sha256(input), semanticDigest,
      ...(typeof binding?.digest === 'string' ? { requestDigest: binding.digest } : {}) },
    coverage: { complete: status === 'complete', notes: status === 'complete' ? [] : [validationIssue ?? native.issue ?? native.outcome ?? 'native_create_prepare_incomplete'] },
    result: { ...(binding ? { requestBinding: binding } : {}), ...(price ? { ratePlanAvailability: price } : {}),
      ...(prepareShot ? { prepareShot } : {}),
      requestedMealPlan, applied: native.applied ?? {}, unsupportedFields: native.unsupportedFields ?? [], missing: native.missing ?? [],
      nativeOutcome: native.outcome ?? 'unknown', semanticInput: input },
  };
}

async function recordNativeObservation(ctx: ReadContext, input: ReservationWorkflowV2PrepareInput,
  observation: ReservationWorkflowV2Observation, status: 'prepared' | 'failed' | 'unknown', summary: string | null,
  operationId: string = randomUUID()) {
  const base = { workItemId: input.workItemId, source: input.source, expectedRevision: input.expectedRevision,
    expectedSeq: input.expectedSeq };
  const appended = await appendReservationWorkflowV2Observation(stateContext(ctx), { ...base, observation });
  if (appended.status !== 'ok') return appended;
  return recordReservationWorkflowV2Result(stateContext(ctx), { ...base, result: {
    id: operationId, generationId: observation.generationId, requestId: observation.criteria.requestId as string,
    allocationId: observation.criteria.allocationId as string, workflow: 'create', status,
    draftRevision: input.expectedRevision, observationRefs: [observation.ref], updatedAt: new Date().toISOString(), summary,
  } });
}

type PartyLookup = { outcome: 'query'; name: string; selectionPath: string } |
  { outcome: 'not_requested' } | { outcome: 'needs_input'; issue: string };
type EffectivePath = { outcome: 'value'; value: unknown; path: string } | { outcome: 'unset' } | { outcome: 'unknown' };

function appendPtr(path: string, ...parts: Array<string | number>): string {
  return ptr(...path.slice(1).split('/').map(decodeURIComponent), ...parts);
}

function effectivePathValue(draft: ReservationWorkflowV2Draft, source: unknown, basePath: string,
  parts: Array<string | number>): EffectivePath {
  const root = leaf(draft, basePath, source);
  if ('issue' in root) return { outcome: 'unknown' };
  if (root.unset) return { outcome: 'unset' };
  let value = root.value, path = basePath;
  for (const part of parts) {
    const child = Array.isArray(value) && typeof part === 'number' ? value[part]
      : record(value)?.[String(part)];
    path = appendPtr(path, part);
    const resolved = leaf(draft, path, child);
    if ('issue' in resolved) return { outcome: 'unknown' };
    if (resolved.unset || (resolved.value && typeof resolved.value === 'object' &&
        (resolved.value as { kind?: unknown }).kind === 'none')) return { outcome: 'unset' };
    value = resolved.value;
  }
  return { outcome: 'value', value, path };
}

function effectiveLookupText(draft: ReservationWorkflowV2Draft, bodySource: unknown, requestPath: string,
  parts: Array<string | number>): { outcome: 'value'; value: string } | { outcome: 'none' | 'missing' | 'unknown' } {
  const resolved = effectivePathValue(draft, bodySource, requestPath, parts);
  if (resolved.outcome === 'unknown') return { outcome: 'unknown' };
  if (resolved.outcome === 'unset') return { outcome: 'none' };
  const value = text(resolved.value);
  return value ? { outcome: 'value', value } : { outcome: 'missing' };
}

function effectivePartyLookup(draft: ReservationWorkflowV2Draft, requestPath: string, bodySource: unknown,
  allocationIndex: number, dateIndex: number, field: 'bookingAgency' | 'organization' | 'arAccount'): PartyLookup {
  const choices = [
    ['allocations', allocationIndex, 'overrides', field],
    ['dateSections', dateIndex, 'defaults', field],
    ['shared', field],
  ];
  for (const parts of choices) {
    const resolved = effectivePathValue(draft, bodySource, requestPath, parts);
    if (resolved.outcome === 'unknown') return { outcome: 'needs_input', issue: 'party_name_unknown' };
    if (resolved.outcome === 'unset') return { outcome: 'not_requested' };
    const nameResult = effectivePathValue(draft, bodySource, requestPath, [...parts, 'name']);
    if (resolved.value === undefined || resolved.value === null) {
      // A manual name can be entered before the source proposal has a party object.
      if (nameResult.outcome !== 'value' || !text(nameResult.value)) continue;
    } else if (!record(resolved.value)) return { outcome: 'needs_input', issue: 'party_value_invalid' };
    if (nameResult.outcome === 'unknown') return { outcome: 'needs_input', issue: 'party_name_unknown' };
    if (nameResult.outcome === 'unset') return { outcome: 'needs_input', issue: 'party_name_query_required' };
    const name = text(nameResult.value);
    if (!name) return { outcome: 'needs_input', issue: 'party_name_query_required' };
    return { outcome: 'query', name, selectionPath: appendPtr(resolved.path, 'nativeSelectionRef') };
  }
  return { outcome: 'not_requested' };
}

export function verifiedNativeFields(result: unknown): string[] {
  const correlation = record(record(result)?.correlation);
  const fields = correlation?.verifiedFields;
  return Array.isArray(fields) ? fields.filter((field: unknown): field is string => typeof field === 'string') : [];
}

function guestCandidateViews(candidates: unknown, verifiedFields: string[]) {
  const verified = new Set(verifiedFields);
  const rows = Array.isArray(candidates) ? candidates.map(record) : [];
  const valid = rows.every((candidate) => candidate && /^\d{1,30}$/.test(String(candidate.nativeId ?? '')) &&
    text(candidate.firstName) && text(candidate.lastName));
  return { valid, rows: rows.filter((candidate): candidate is Record<string, unknown> => Boolean(candidate))
    .map((candidate) => ({ nativeId: text(candidate.nativeId), firstName: text(candidate.firstName), lastName: text(candidate.lastName),
      ...(verified.has('emailaddress') && text(candidate.email) ? { email: text(candidate.email) } : {}),
      ...(verified.has('phonenumber') && text(candidate.phoneNumber) ? { phoneNumber: text(candidate.phoneNumber) } : {}),
      ...(verified.has('city') && text(candidate.city) ? { city: text(candidate.city) } : {}),
      ...(verified.has('country') && text(candidate.country) ? { country: text(candidate.country) } : {}) })) };
}

export function partyCandidateViews(candidates: unknown, role: 'agency' | 'organization' | 'ar_account', verifiedFields: string[]) {
  const verified = new Set(verifiedFields);
  const rows = Array.isArray(candidates) ? candidates.map(record) : [];
  const valid = rows.every((candidate) => candidate && /^\d{1,30}$/.test(String(candidate.nativeId ?? '')) &&
    text(candidate.name));
  return { valid, rows: rows.filter((candidate): candidate is Record<string, unknown> => Boolean(candidate)).map((candidate) => ({
    nativeId: text(candidate.nativeId), name: text(candidate.name),
    ...(verified.has('address') && text(candidate.address) ? { address: text(candidate.address) } : {}),
    ...(verified.has('city') && text(candidate.city) ? { city: text(candidate.city) } : {}),
    ...(verified.has('country') && text(candidate.country) ? { country: text(candidate.country) } : {}),
    ...(role !== 'ar_account' && verified.has('contactfirstname') && text(candidate.contactFirstName)
      ? { contactFirstName: text(candidate.contactFirstName) } : {}),
    ...(role !== 'ar_account' && verified.has('contactlastname') && text(candidate.contactLastName)
      ? { contactLastName: text(candidate.contactLastName) } : {}),
    ...(role !== 'ar_account' && verified.has('contactphone') && text(candidate.contactPhone)
      ? { contactPhone: text(candidate.contactPhone) } : {}),
    ...(role === 'ar_account' && verified.has('firstname') && text(candidate.contactFirstName)
      ? { contactFirstName: text(candidate.contactFirstName) } : {}),
    ...(role === 'ar_account' && verified.has('lastname') && text(candidate.contactLastName)
      ? { contactLastName: text(candidate.contactLastName) } : {}),
    ...(role === 'ar_account' && verified.has('phonenumber') && text(candidate.contactPhone)
      ? { contactPhone: text(candidate.contactPhone) } : {}),
    ...(role === 'agency' && candidate.referenceNumberEvidence === 'response_grid_correlated' && text(candidate.referenceNumber)
      ? { referenceNumber: text(candidate.referenceNumber) } : {}),
    ...(role === 'agency' && candidate.referenceNumberTypeEvidence === 'response_grid_correlated' && text(candidate.referenceNumberType)
      ? { referenceNumberType: text(candidate.referenceNumberType) } : {}),
    ...(role === 'organization' && verified.has('corporateaccountnumber') && text(candidate.corporateAccountNumber)
      ? { corporateAccountNumber: text(candidate.corporateAccountNumber) } : {}),
    ...(role === 'ar_account' && verified.has('araccountnumber') && text(candidate.accountNumber)
      ? { accountNumber: text(candidate.accountNumber) } : {}),
    ...(role === 'ar_account' && verified.has('arstatuscodedesc') && text(candidate.status)
      ? { status: text(candidate.status) } : {}),
    ...(role === 'ar_account' && verified.has('accttype') && text(candidate.accountType)
      ? { accountType: text(candidate.accountType) } : {}),
  })) };
}

type CreateCatalogueKind = 'room_type' | 'room_type_for_charge' | 'rate_plan';
type CreateCatalogueCandidate = { code: string; label: string; nativeId?: string };
type CreateCatalogueRead = { kind: CreateCatalogueKind; outcome: string; complete: boolean;
  candidates: CreateCatalogueCandidate[]; coverage: Record<string, unknown> | null;
  criteria: Record<string, unknown> | null; verifiedFields: string[]; issue: string | null };

function createCatalogueCandidate(value: unknown, kind: CreateCatalogueKind): CreateCatalogueCandidate | null {
  const candidate = record(value), response = record(candidate?.responseData), grid = record(candidate?.gridData);
  const code = text(candidate?.code), label = text(candidate?.name);
  const isRoom = kind !== 'rate_plan';
  const codeField = isRoom ? 'roomtypecode' : 'rateplancode';
  const labelField = isRoom ? 'roomtypedesc' : 'rateplanname';
  if (!response || !grid || !code || !label || text(response[codeField]) !== code || text(grid[codeField]) !== code ||
      text(response[labelField]) !== label || text(grid[labelField]) !== label) return null;
  if (isRoom) {
    const nativeId = text(candidate?.nativeId);
    if (!nativeId || text(response.roomtypeid) !== nativeId || text(grid.roomtypeid) !== nativeId) return null;
    return { code, label, nativeId };
  }
  return { code, label };
}

async function readCreateCatalogue(runTool: (request: Record<string, unknown>) => Promise<Record<string, unknown>>,
  tool: 'searchRoomTypes' | 'searchRoomTypesForCharge' | 'searchRatePlans', kind: CreateCatalogueKind,
  propertyCode: string): Promise<CreateCatalogueRead> {
  const first = await runTool({ tool, query: '', offset: 0, limit: 100 });
  const coverage = record(first.coverage), criteria = record(first.criteria);
  const matchingLoaded = coverage?.matchingLoaded;
  const loaded = coverage?.loaded;
  const expectedScope = kind !== 'rate_plan' ? 'guest_stay_room_catalog' : 'guest_stay_rate_shop_catalog';
  const allowedOutcome = ['matches', 'no_match', 'incomplete'].includes(String(first.outcome));
  const criteriaValid = criteria?.propertyCode === propertyCode && criteria.scope === expectedScope && criteria.query === '';
  if (!allowedOutcome || !criteriaValid || !Number.isInteger(matchingLoaded) || !Number.isInteger(loaded) ||
      (first.outcome === 'no_match' && matchingLoaded !== 0)) {
    return { kind, outcome: String(first.outcome ?? 'failed'), complete: false, candidates: [], coverage, criteria,
      verifiedFields: [], issue: text(first.issue) ?? 'native_catalogue_search_unverified' };
  }
  const count = matchingLoaded as number;
  const candidates: CreateCatalogueCandidate[] = [];
  const verifiedFields = kind !== 'rate_plan' ? ['roomtypeid', 'roomtypecode', 'roomtypedesc'] : ['rateplancode', 'rateplanname'];
  let pagesComplete = true, allCorrelated = true;
  for (let offset = 0; offset < count; offset += 100) {
    const page = offset === 0 ? first : await runTool({ tool, query: '', offset, limit: 100 });
    const pageCoverage = record(page.coverage), pageCriteria = record(page.criteria);
    const pageRows = Array.isArray(page.candidates) ? page.candidates : [];
    const expectedPageSize = Math.min(100, count - offset);
    if (!['matches', 'incomplete'].includes(String(page.outcome)) || pageCriteria?.propertyCode !== propertyCode ||
        pageCriteria.scope !== expectedScope || pageCriteria.query !== '' || pageCoverage?.loaded !== loaded ||
        pageCoverage?.matchingLoaded !== count || pageCoverage.returned !== expectedPageSize || pageRows.length !== expectedPageSize) {
      pagesComplete = false;
      break;
    }
    for (const row of pageRows) {
      const projected = createCatalogueCandidate(row, kind);
      if (projected) candidates.push(projected);
      else allCorrelated = false;
    }
  }
  if (count === 0 && first.outcome !== 'no_match') pagesComplete = false;
  const complete = ['matches', 'no_match'].includes(String(first.outcome)) && coverage?.complete === true &&
    coverage.possiblyTruncated === false && loaded === count && pagesComplete && allCorrelated && candidates.length === count;
  return { kind, outcome: String(first.outcome), complete, candidates, coverage, criteria, verifiedFields,
    issue: complete ? null : text(first.issue) ?? 'native_catalogue_coverage_or_correlation_incomplete' };
}

function createCatalogueObservation(draft: ReservationWorkflowV2Draft, target: {
  requestId: string; allocationId: string; allocationIndex: number;
}, catalogue: CreateCatalogueRead, closeOutcome: unknown): ReservationWorkflowV2Observation {
  const field = catalogue.kind === 'room_type' ? 'roomType' : catalogue.kind === 'room_type_for_charge' ? 'roomTypeForCharge' : 'ratePlan';
  const fieldPath = ptr('proposal', 'content', 'requests', target.requestId, 'body', 'allocations',
    target.allocationIndex, 'overrides', field);
  const complete = catalogue.complete && closeOutcome === 'closed_unsaved';
  const options = catalogue.candidates.map(candidate => catalogue.kind !== 'rate_plan'
    ? { room: { code: candidate.code, label: candidate.label } }
    : { ratePlan: { code: candidate.code, label: candidate.label } });
  return { ref: randomUUID(), generationId: draft.generationId, kind: 'rate_availability',
    status: complete ? 'complete' : 'partial', observedAt: new Date().toISOString(), propertyCode: draft.propertyCode,
    sourceMessageId: draft.source.messageId, sourceRefs: [],
    criteria: { workflow: 'create', kind: 'native_catalogue', catalogueKind: catalogue.kind,
      requestId: target.requestId, allocationId: target.allocationId, fieldPaths: [fieldPath],
      nativeCriteria: catalogue.criteria, nativeCoverage: catalogue.coverage,
      correlation: { method: 'native_response_grid', verifiedFields: catalogue.verifiedFields } },
    coverage: { complete, notes: complete ? [] : [catalogue.issue ?? 'native_catalogue_picker_close_unverified'] },
    result: { catalogueKind: catalogue.kind, groups: [{ id: target.allocationId,
      requestId: target.requestId, allocationId: target.allocationId, options }],
      candidates: catalogue.candidates, nativeOutcome: catalogue.outcome, nativeCoverage: catalogue.coverage,
      closeOutcome } };
}

function createFieldChoiceObservation(draft: ReservationWorkflowV2Draft, target: {
  requestId: string; allocationId: string; allocationIndex: number;
}, field: string, kind: string, candidates: CreateCatalogueCandidate[], coverageComplete: boolean,
  closeOutcome: string): ReservationWorkflowV2Observation {
  const fieldPath = ptr('proposal', 'content', 'requests', target.requestId, 'body', 'allocations',
    target.allocationIndex, 'overrides', field);
  return { ref: randomUUID(), generationId: draft.generationId, kind: 'rate_availability',
    // Each offered code was observed. The complete flag separately describes catalogue coverage.
    status: 'complete', observedAt: new Date().toISOString(), propertyCode: draft.propertyCode,
    sourceMessageId: draft.source.messageId, sourceRefs: [],
    criteria: { workflow: 'create', kind: 'native_catalogue', catalogueKind: kind,
      requestId: target.requestId, allocationId: target.allocationId, fieldPaths: [fieldPath] },
    coverage: { complete: coverageComplete, notes: coverageComplete ? [] : ['native_choice_coverage_incomplete'] },
    result: { candidates, closeOutcome } };
}

/** Catalogue reads do not require a priced room or a guest allocation. */
export async function reservationWorkflowV2NativeChoices(ctx: ReadContext,
  input: ReservationWorkflowV2LookupInput): Promise<Outcome> {
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return loaded.result;
  const request = loaded.draft.proposal.content.requests.find(row => row.id === input.requestId);
  if (!request || !['create', 'quote', 'amend'].includes(request.kind))
    return { status: 'unsupported', issue: 'native_choices_not_applicable' };
  const bodyPath = ptr('proposal', 'content', 'requests', request.id, 'body');
  const path = input.nativeFieldPath ?? '';
  const body = record(effectiveSubtree(loaded.draft, request.body, bodyPath));
  const relative = path.startsWith(`${bodyPath}/`) ? path.slice(bodyPath.length + 1).split('/') : [];
  let field = relative.at(-1) ?? '';
  const kinds: Record<string, string> = { roomType: 'room_type', roomTypeForCharge: 'room_type_for_charge',
    roomCodes: 'room_type', ratePlan: 'rate_plan', reasonForStay: 'reason_for_stay', guaranteeType: 'guarantee',
    cmsMessageId: 'cms_message', sourceOfBusiness: 'source_of_business', track: 'track' };
  const rows = (key: string) => Array.isArray(body?.[key]) ? body[key] as unknown[] : [];
  const validIndex = (key: string) => /^\d+$/.test(relative[1] ?? '') && record(rows(key)[Number(relative[1])]) !== null;
  let scopeValid = request.kind === 'quote'
    ? relative.length === 3 && relative[0] === 'groups' && validIndex('groups') && ['roomCodes', 'ratePlan'].includes(field)
    : request.kind === 'create' && (relative.length === 2 && relative[0] === 'shared' || relative.length === 4 &&
      (relative[0] === 'allocations' && relative[2] === 'overrides' && validIndex('allocations') ||
       relative[0] === 'dateSections' && relative[2] === 'defaults' && validIndex('dateSections'))) && field !== 'roomCodes';
  if (request.kind === 'amend') {
    const index = (value: string | undefined) => value && /^\d+$/.test(value) ? Number(value) : -1;
    const perTarget = record(rows('perTarget')[index(relative[1])]);
    const changes = relative[0] === 'sharedChanges' ? rows('sharedChanges')
      : Array.isArray(perTarget?.changes) ? perTarget.changes : [];
    const changeIndex = relative[0] === 'sharedChanges' ? index(relative[1]) : index(relative[3]);
    const change = record(changes[changeIndex]);
    scopeValid = (relative.length === 3 && relative[0] === 'sharedChanges' ||
      relative.length === 5 && relative[0] === 'perTarget' && relative[2] === 'changes' && perTarget !== null) &&
      relative.at(-1) === 'value' && change?.op === 'set' &&
      ['roomType', 'roomTypeForCharge', 'ratePlan', 'guaranteeType', 'cmsMessageId', 'track'].includes(String(change.field));
    field = scopeValid ? String(change?.field) : '';
  }
  const kind = kinds[field];
  if (!scopeValid || !kind) return { status: 'needs_input', issue: 'native_choice_field_not_supported' };
  if (kind === 'rate_plan' || kind === 'room_type' || kind === 'room_type_for_charge') {
    const sharedKind = kind;
    const cached = [...loaded.draft.observations].reverse().find(observation => {
      const criteria = record(observation.criteria), result = record(observation.result);
      const observedAt = Date.parse(observation.observedAt);
      const catalogueKind = criteria?.catalogueKind;
      return observation.generationId === loaded.draft.generationId && observation.propertyCode === ctx.property.propertyCode &&
        observation.sourceMessageId === loaded.draft.source.messageId && criteria?.sourceHash === loaded.draft.source.sourceHash &&
        criteria.kind === 'native_catalogue' && catalogueKind === sharedKind && observation.status === 'complete' &&
        observation.coverage.complete && Number.isFinite(observedAt) && Date.now() - observedAt < 30 * 60_000 &&
        result?.closeOutcome === 'closed_unsaved' && Array.isArray(result.candidates);
    });
    // A staff refresh of rate plans must reach HMS; captured catalog data is fallback only.
    if (cached && kind !== 'rate_plan') {
      const observation = { ...cached, ref: randomUUID(), criteria: { ...cached.criteria,
        workflow: `${request.kind}_catalogue`, requestId: request.id, catalogueKind: kind, fieldPaths: [path] } };
      const appended = await appendReservationWorkflowV2Observation(stateContext(ctx), { workItemId: input.workItemId,
        source: input.source, observation });
      return appended.status === 'ok' ? { status: 'ok', candidates: observation.result.candidates,
        observationRef: observation.ref } : appended;
    }
  }
  let read: Record<string, unknown> | null;
  const nativeRates = kind === 'rate_plan'
    ? await loadNativeRatePlans(ctx.property.propertyCode).catch(() => null)
    : null;
  const rateCatalogueFallback = () => nativeRates ? {
    candidates: nativeRates.map(({ code, name }) => ({ code, label: name })),
      complete: false, clean: true, nativeCriteria: { scope: 'configured_native_catalog' },
      nativeCoverage: { complete: false, loaded: nativeRates.length },
  } : null;
  if (request.kind === 'amend' && field === 'track') {
    const amend = await import('./reservation-workflow-v2-amend.js');
    const scoped = await amend.readAmendTrackChoices(ctx, loaded.draft, request.id, path);
    if (scoped.status !== 'ok') return scoped;
    read = { candidates: scoped.candidates, complete: true, clean: true,
      selectedTargets: scoped.selectedTargets, nativeCoverage: scoped.nativeCoverage };
  } else try {
    const tool = await import(new URL('../../tooling/hms-cloud/hms-lookup-read-session.mjs', import.meta.url).href) as {
      withCloudLookupReadSession: (operation: (session: { page: unknown; runTool: (request: Record<string, unknown>) => Promise<Record<string, unknown>> }) =>
        Promise<unknown>, options?: Record<string, unknown>) => Promise<unknown>;
      withCloudRoomRateReadSession: (name: 'searchRoomTypes' | 'searchRoomTypesForCharge' | 'searchRatePlans',
        operation: (session: { runTool: (request: Record<string, unknown>) => Promise<Record<string, unknown>> }) => Promise<unknown>,
        options: Record<string, unknown>) => Promise<unknown>;
    };
    if (['room_type', 'room_type_for_charge', 'rate_plan'].includes(kind)) {
      const name = kind === 'room_type' ? 'searchRoomTypes' :
        kind === 'room_type_for_charge' ? 'searchRoomTypesForCharge' : 'searchRatePlans';
      const catalogue = await tool.withCloudRoomRateReadSession(name, ({ runTool }) =>
        readCreateCatalogue(runTool, name, kind as CreateCatalogueKind, ctx.property.propertyCode),
      { propertyCode: ctx.property.propertyCode, transportId: ctx.transport.id, signal: ctx.nativeBatch?.signal }) as CreateCatalogueRead;
      read = { candidates: catalogue.candidates, complete: catalogue.complete, clean: true,
        outcome: catalogue.outcome, issue: catalogue.issue,
        nativeCriteria: catalogue.criteria, nativeCoverage: catalogue.coverage };
    } else read = record(await tool.withCloudLookupReadSession(async ({ page, runTool }) => {
      if (field === 'track') {
        const tracks = await import(new URL('../../tooling/hms-cloud/guest-stay-track-catalog.mjs', import.meta.url).href) as {
          listTrackSubSegments: (page: unknown, options: { propertyCode: string }) => Promise<Record<string, unknown>>;
        };
        const listed = await tracks.listTrackSubSegments(page, { propertyCode: ctx.property.propertyCode });
        const candidates = (Array.isArray(listed.candidates) ? listed.candidates : []).flatMap(raw => {
          const row = record(raw), code = text(row?.code), label = text(row?.description);
          return code && label ? [{ code, label }] : [];
        });
        return { candidates, complete: record(listed.coverage)?.complete === true,
          clean: listed.outcome === 'ok', issue: listed.issue, nativeCoverage: listed.coverage };
      }
      if (field === 'reasonForStay' || field === 'guaranteeType') {
        const listed = await runTool({ tool: 'listGuestStayDropdown', propertyCode: ctx.property.propertyCode, field });
        const candidates = (Array.isArray(listed.options) ? listed.options : []).flatMap(raw => {
          const option = record(raw), code = text(option?.value), label = text(option?.label);
          return code && label && (field !== 'reasonForStay' || /^(business|leisure(?: guest)?)$/i.test(label))
            ? [{ code, label: /^leisure/i.test(label) ? 'Leisure' : label }] : [];
        });
        return { candidates, complete: record(listed.coverage)?.complete === true, clean: listed.outcome === 'ok',
          nativeCoverage: listed.coverage, issue: listed.issue };
      }
      if (field === 'cmsMessageId') {
        const listed = await runTool({ tool: 'listCmsMessageIds', propertyCode: ctx.property.propertyCode });
        const closed = await runTool({ tool: 'closeCmsMessageIdPicker', propertyCode: ctx.property.propertyCode });
        const candidates = (Array.isArray(listed.candidates) ? listed.candidates : []).flatMap(raw => {
          const option = record(raw), code = text(option?.code), label = text(option?.description) ?? code;
          return code && label ? [{ code, label }] : [];
        });
        return { candidates, complete: false, clean: listed.outcome === 'ok' && closed.outcome === 'closed_unsaved',
          issue: listed.issue };
      }
      const found = await runTool({ tool: 'searchGuestStaySourceBusiness', field: 'description', query: '' });
      const coverage = record(found.coverage), candidates: CreateCatalogueCandidate[] = [];
      const loadedCount = typeof coverage?.loaded === 'number' && Number.isInteger(coverage.loaded) ? Math.min(coverage.loaded, 200) : 0;
      if (typeof found.searchId === 'string') for (let offset = 0; offset < loadedCount; offset += 100) {
        const page = await runTool({ tool: 'inspectGuestStaySourceBusiness', searchId: found.searchId, offset, limit: 100 });
        if (page.outcome !== 'ok' || !Array.isArray(page.candidates)) break;
        for (const raw of page.candidates) {
          const row = record(raw), response = record(row?.responseData), grid = record(row?.gridData);
          const code = text(row?.nativeCode), label = text(row?.description);
          if (code && label && text(response?.codevalue) === code && text(grid?.codevalue) === code &&
            text(response?.description) === label && text(grid?.description) === label) candidates.push({ code, label });
        }
      }
      const closed = await runTool({ tool: 'closeGuestStaySourceBusinessPicker' });
      return { candidates, complete: coverage?.serverMoreRecords === false && coverage.possiblyTruncated === false && candidates.length === coverage.loaded,
        clean: ['matches', 'no_match'].includes(String(found.outcome)) && closed.outcome === 'closed_unchanged',
        nativeCoverage: coverage, issue: found.issue };
    }, { propertyCode: ctx.property.propertyCode, transportId: ctx.transport.id, signal: ctx.nativeBatch?.signal }));
  } catch {
    read = rateCatalogueFallback();
    if (!read) return { status: 'failed', issue: 'native_choices_read_failed' };
  }
  if (kind === 'rate_plan' && (read?.clean !== true || !Array.isArray(read.candidates) || !read.candidates.length))
    read = rateCatalogueFallback() ?? read;
  if (read?.clean !== true) return { status: 'failed', issue: text(read?.issue) ?? 'native_choice_picker_close_unverified' };
  if (read.outcome === 'unavailable') return { status: 'unsupported', issue: text(read.issue) ?? 'native_choices_unavailable' };
  const candidates = Array.isArray(read.candidates) ? read.candidates : [];
  if (!candidates.length && read.complete !== true) return { status: 'failed', issue: text(read.issue) ?? 'native_choices_unavailable' };
  const fresh = await currentDraft(ctx, input);
  if (!fresh.draft) return fresh.result;
  const observation: ReservationWorkflowV2Observation = { ref: randomUUID(), generationId: loaded.draft.generationId,
    kind: 'rate_availability', status: 'complete', observedAt: new Date().toISOString(), propertyCode: loaded.draft.propertyCode,
    sourceMessageId: loaded.draft.source.messageId, sourceRefs: [],
    criteria: { workflow: `${request.kind}_catalogue`, kind: 'native_catalogue', catalogueKind: kind, requestId: request.id,
      sourceHash: loaded.draft.source.sourceHash, fieldPaths: [path], nativeCriteria: read.nativeCriteria, nativeCoverage: read.nativeCoverage,
      ...(Array.isArray(read.selectedTargets) ? { selectedTargets: read.selectedTargets } : {}) },
    coverage: { complete: read.complete === true, notes: read.complete === true ? [] : ['native_choice_coverage_incomplete'] },
    result: { candidates, closeOutcome: 'closed_unsaved' } };
  const appended = await appendReservationWorkflowV2Observation(stateContext(ctx), { workItemId: input.workItemId,
    source: input.source, observation });
  return appended.status === 'ok' ? { status: 'ok', candidates, observationRef: observation.ref } : appended;
}

/** Read current, source-bound v2 observations; callers cannot supply lookup candidates. */
export async function reservationWorkflowV2Lookup(ctx: ReadContext,
  input: ReservationWorkflowV2LookupInput): Promise<Outcome> {
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return loaded.result;
  const requests = loaded.draft.proposal.content.requests.filter((request) => !input.requestId || request.id === input.requestId);
  if (input.requestId && !requests.length) return { status: 'not_found' };
  const createRequests = requests.filter((request) => request.kind === 'create');
  if (!createRequests.length) return { status: 'unsupported', issue: 'create_lookup_not_applicable' };
  const nativeObservations: ReservationWorkflowV2Observation[] = [];
  for (const request of createRequests) {
    const path = existingConfirmationPath(request.id);
    if (!sourceConfirmationClaim(loaded.draft, request.id).required) continue;
    const claim = exactSourceConfirmationClaim(loaded.draft, path);
    const confirmation = claim?.raw ?? null;
    let outcome = 'unavailable', reason: string | null = 'source_confirmation_claim_missing_or_mismatched';
    let stay: Record<string, unknown> | null = null;
    const sourceEvidence = claim && loaded.draft.observations.find((entry) => {
      const evidenceRefs = record(entry.result)?.evidenceRefs;
      return entry.kind === 'source' && Array.isArray(evidenceRefs) && claim.sourceRefs.every((ref) => evidenceRefs.includes(ref));
    });
    const sourceRefs = sourceEvidence ? [sourceEvidence.ref] : [];
    const claimIsExact = Boolean(claim && confirmation && /^\d{6,10}-\d{1,4}$/.test(confirmation) && sourceEvidence &&
      claim.sourceRefs.length > 0);
    if (claimIsExact && confirmation && !paneStayLookupEnabled()) {
      reason = 'stay_lookup_disabled';
    } else if (claimIsExact && confirmation) {
      const targetResult = (() => {
        const property = getPropertyRegistration(ctx.property.propertyCode);
        if (!property?.active || !property.transportIds.includes(ctx.transport.id)) {
          return { ok: false, reason: 'property_read_transport_mismatch' } as const;
        }
        return { ok: true, target: hmsReadTargetForProperty(property.propertyCode) } as const;
      })();
      if (targetResult.ok) {
        try {
          const request = { confirmation };
          const lock = paneStayPropertyLock(targetResult.target);
          const found = lock
            ? await lock.withLock(async () => projectCloudStayFind(request,
              await runCloudStayFind({ request, target: targetResult.target, transportId: ctx.transport.id, signal: ctx.nativeBatch?.signal }),
            targetResult.target.propertyCode),
            { ...acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS), signal: ctx.nativeBatch?.signal })
            : null;
          if (!found) throw new Error('background_property_lock_unavailable');
          outcome = found.outcome;
          reason = found.reason ?? null;
          stay = record(found.stay);
          if (found.outcome === 'found' && stay?.confirmation !== confirmation) {
            outcome = 'execution_failure';
            reason = 'native_confirmation_exact_match_unverified';
          }
        } catch {
          outcome = 'execution_failure';
          reason = 'native_confirmation_lookup_failed';
        }
      } else reason = targetResult.reason;
    }
    const complete = outcome === 'found' || outcome === 'not_found';
    nativeObservations.push({ ref: randomUUID(), generationId: loaded.draft.generationId, kind: 'stay_candidate',
      status: complete ? 'complete' : outcome === 'unavailable' ? 'unavailable' : 'partial',
      observedAt: new Date().toISOString(), propertyCode: loaded.draft.propertyCode,
      sourceMessageId: loaded.draft.source.messageId, sourceRefs,
      criteria: { workflow: 'create_existing_reference_check', requestId: request.id, confirmation,
        sourceClaimPath: path, sourceClaimEvidenceRefs: claim?.sourceRefs ?? [] },
      coverage: { complete, notes: complete ? [] : [reason ?? 'native_confirmation_lookup_incomplete'] },
      result: { outcome, confirmation, reason, stay, propertyCode: ctx.property.propertyCode } });
  }
  const persistedConfirmationRefs = new Set<string>();
  if (nativeObservations.some((entry) => entry.criteria.workflow === 'create_existing_reference_check')) {
    const fresh = await currentDraft(ctx, input);
    if (!fresh.draft) return fresh.result;
    for (const observation of nativeObservations.filter((entry) => entry.criteria.workflow === 'create_existing_reference_check')) {
      const appended = await appendReservationWorkflowV2Observation(stateContext(ctx), {
        workItemId: input.workItemId, source: input.source, observation,
      });
      if (appended.status !== 'ok') return appended;
      persistedConfirmationRefs.add(observation.ref);
    }
  }
  const partySpecs = [
    { key: 'bookingAgency', field: 'bookingAgency', role: 'agency', tool: 'searchPrimaryBookingAgency', idField: 'travelagencyid', nameField: 'travelagencyname' },
    { key: 'organization', field: 'organization', role: 'organization', tool: 'searchOrganization', idField: 'companyid', nameField: 'companyname' },
    { key: 'arAccount', field: 'arAccount', role: 'ar_account', tool: 'searchArAccount', idField: 'araccountid', nameField: 'araccountname' },
  ] as const;
  const catalogueTargets: Array<{ requestId: string; allocationId: string; allocationIndex: number }> = [];
  const bookingTool = await import(new URL('../../tooling/hms-cloud/hms-lookup-read-session.mjs', import.meta.url).href) as {
    withCloudLookupReadSession: (operation: (session: { runTool: (request: Record<string, unknown>) => Promise<Record<string, unknown>> }) =>
      Promise<unknown>, options?: Record<string, unknown>) => Promise<unknown>;
    withCloudRoomRateReadSession: (name: 'searchRoomTypes' | 'searchRoomTypesForCharge' | 'searchRatePlans',
      operation: (session: { runTool: (request: Record<string, unknown>) => Promise<Record<string, unknown>> }) => Promise<unknown>,
      options: Record<string, unknown>) => Promise<unknown>;
  };
  let sessionResult: Record<string, unknown> | null = null;
  try {
    sessionResult = record(await bookingTool.withCloudLookupReadSession(async ({ runTool }) => {
      const perAllocation: Outcome[] = [];
      for (const request of createRequests) {
        const requestPath = ptr('proposal', 'content', 'requests', request.id, 'body');
        const body = effectiveSubtree(loaded.draft!, request.body, requestPath) as typeof request.body | null;
        if (!body || !Array.isArray(body.allocations) || !Array.isArray(body.dateSections)) {
          perAllocation.push({ status: 'needs_input', requestId: request.id, issue: 'create_body_incomplete' });
          continue;
        }
        for (const [allocationIndex, allocationValue] of body.allocations.entries()) {
          const allocation = record(allocationValue);
          const allocationId = text(allocation?.id);
          const dateSectionId = text(allocation?.dateSectionId);
          const dateIndex = dateSectionId
            ? body.dateSections.findIndex((section) => record(section)?.id === dateSectionId) : -1;
          if (!allocation || !allocationId || dateIndex < 0) {
            perAllocation.push({ status: 'needs_input', requestId: request.id, ...(allocationId ? { allocationId } : {}),
              issue: 'allocation_date_section_unresolved' });
            continue;
          }
          catalogueTargets.push({ requestId: request.id, allocationId, allocationIndex });
          const guestPath = appendPtr(requestPath, 'allocations', allocationIndex, 'guest');
          const intent = effectivePathValue(loaded.draft!, request.body, requestPath,
            ['allocations', allocationIndex, 'guest', 'profileIntent']);
          const first = effectiveLookupText(loaded.draft!, request.body, requestPath,
            ['allocations', allocationIndex, 'guest', 'firstName']);
          const last = effectiveLookupText(loaded.draft!, request.body, requestPath,
            ['allocations', allocationIndex, 'guest', 'lastName']);
          const email = effectiveLookupText(loaded.draft!, request.body, requestPath,
            ['allocations', allocationIndex, 'guest', 'email']);
          const mobile = effectiveLookupText(loaded.draft!, request.body, requestPath,
            ['allocations', allocationIndex, 'guest', 'mobile']);
          const guestSearch: Outcome = intent.outcome === 'value' && intent.value === 'requested_new'
            ? { status: 'unsupported', issue: 'requested_new_guest_profile_unsupported' }
            : intent.outcome !== 'value' || intent.value !== 'existing_or_unknown'
              ? { status: 'needs_input', issue: 'guest_profile_intent_unknown' }
              : { status: 'needs_input', issue: 'guest_name_query_required' };
          let guestInfo: Record<string, unknown> | null = null;
          if (intent.outcome === 'value' && intent.value === 'existing_or_unknown' &&
              first.outcome === 'value' && last.outcome === 'value') {
            const found = await runTool({ tool: 'searchGuestProfiles', field: 'lastName', query: last.value });
            const initial = Array.isArray(found.candidates) ? found.candidates.map(record).filter(Boolean) : [];
            const coverage = record(found.coverage);
            let candidates = [...initial];
            let enumerationComplete = true;
            const loadedCount = typeof coverage?.loaded === 'number' && Number.isInteger(coverage.loaded)
              ? coverage.loaded : null;
            if (loadedCount !== null && loadedCount > candidates.length) {
              for (let offset = candidates.length; offset < loadedCount; offset += 50) {
                const inspected = await runTool({ tool: 'inspectGuestProfileCandidates', searchId: found.searchId,
                  offset, limit: 50 });
                const pageRows = Array.isArray(inspected.candidates) ? inspected.candidates.map(record).filter(Boolean) : [];
                if (inspected.outcome !== 'current' || inspected.searchId !== found.searchId || !pageRows.length) {
                  enumerationComplete = false;
                  break;
                }
                candidates.push(...pageRows);
              }
            }
            const close = await runTool({ tool: 'closeGuestProfilePicker' });
            const verifiedFields = verifiedNativeFields(found);
            const requiredFields = ['guestid', 'firstname', 'lastname', ...(email.outcome === 'value' ? ['emailaddress'] : []),
              ...(mobile.outcome === 'value' ? ['phonenumber'] : [])];
            const projected = guestCandidateViews(candidates, verifiedFields);
            const ranked = projected.rows.sort((a, b) => {
              const score = (row: Record<string, unknown>) =>
                (sameGuestName(row.firstName, first.value) ? 2 : 0) + (sameGuestName(row.lastName, last.value) ? 2 : 0) +
                (email.outcome === 'value' && sameName(row.email, email.value) ? 3 : 0) +
                (mobile.outcome === 'value' && samePhone(row.phoneNumber, mobile.value) ? 3 : 0);
              return score(b) - score(a);
            }).slice(0, 3);
            const criteria = record(found.criteria);
            const complete = Boolean(['matches', 'no_match'].includes(String(found.outcome)) && found.searchId &&
              criteria?.field === 'lastName' && criteria.query === last.value &&
              coverage?.possiblyTruncated === false && loadedCount !== null && candidates.length === loadedCount &&
              enumerationComplete && requiredFields.every((field) => verifiedFields.includes(field)) && projected.valid &&
              close.outcome === 'closed_unsaved' && email.outcome !== 'unknown' && mobile.outcome !== 'unknown');
            guestInfo = { outcome: complete ? found.outcome : 'partial', searchOutcome: found.outcome,
              criteria, coverage, correlation: { verifiedFields }, candidates: ranked,
              query: { field: 'lastName', value: last.value, firstName: first.value,
                ...(email.outcome === 'value' ? { email: email.value } : {}),
                ...(mobile.outcome === 'value' ? { mobile: mobile.value } : {}) }, closeOutcome: close.outcome };
            if (found.searchId && ['matches', 'no_match'].includes(String(found.outcome))) {
              const suggestedPath = appendPtr(guestPath, 'suggestedRef');
              const selectionPath = appendPtr(guestPath, 'nativeSelectionRef');
              const candidatesForObservation = ranked.length ? ranked : [null];
              for (const [candidateIndex, candidate] of candidatesForObservation.entries()) {
                nativeObservations.push({ ref: randomUUID(), generationId: loaded.draft!.generationId, kind: 'guest_candidate',
                  status: complete ? 'complete' : 'partial', observedAt: new Date().toISOString(),
                  propertyCode: loaded.draft!.propertyCode, sourceMessageId: loaded.draft!.source.messageId, sourceRefs: [],
                  criteria: { workflow: 'create', kind: 'guest_profile', requestId: request.id, allocationId,
                    fieldPaths: [suggestedPath, selectionPath], query: { field: 'lastName', value: last.value,
                      firstName: first.value, ...(email.outcome === 'value' ? { email: email.value } : {}),
                      ...(mobile.outcome === 'value' ? { mobile: mobile.value } : {}) },
                    candidateIndex, coverage, correlation: { verifiedFields } },
                  coverage: { complete: Boolean(complete), notes: complete ? [] : ['native_guest_profile_lookup_incomplete'] },
                  result: { outcome: found.outcome, criteria: record(found.criteria), coverage,
                    correlation: { verifiedFields }, candidates: candidate ? [candidate] : [] } });
              }
            }
            Object.assign(guestSearch, { status: complete ? found.outcome : 'partial',
              ...(guestInfo ? { guestCandidates: guestInfo } : {}),
              ...(complete ? {} : { issue: found.issue ?? 'native_guest_profile_lookup_incomplete' }) });
            if (close.outcome !== 'closed_unsaved') {
              perAllocation.push({ status: 'failed', requestId: request.id, allocationId,
                guestCandidates: guestInfo, issue: 'guest_picker_close_unverified' });
              return { lookups: perAllocation, observations: nativeObservations, sessionSafe: false };
            }
          } else if (intent.outcome === 'value' && intent.value === 'existing_or_unknown') {
            guestSearch.issue = first.outcome === 'unknown' || last.outcome === 'unknown'
              ? 'guest_name_unknown' : 'guest_name_query_required';
          }
          const partySearches: Record<string, unknown> = {};
          let allocationStatus = guestSearch.status;
          for (const spec of partySpecs) {
            const party = effectivePartyLookup(loaded.draft!, requestPath, request.body,
              allocationIndex, dateIndex, spec.field);
            if (party.outcome === 'not_requested') {
              partySearches[spec.key] = { status: 'not_requested' };
              continue;
            }
            if (party.outcome === 'needs_input') {
              partySearches[spec.key] = { status: 'needs_input', issue: party.issue };
              if (allocationStatus === 'ok' || allocationStatus === 'matches' || allocationStatus === 'no_match') allocationStatus = 'partial';
              continue;
            }
            if (!quoteRateContextEnabled()) {
              partySearches[spec.key] = { status: 'partial', outcome: 'refused_flag_off',
                searchOutcome: 'refused_flag_off', issue: 'refused_flag_off', candidates: [] };
              if (allocationStatus === 'ok' || allocationStatus === 'matches' || allocationStatus === 'no_match') allocationStatus = 'partial';
              continue;
            }
            let nativeQuery = party.name;
            let found = await runTool({ tool: spec.tool, query: nativeQuery });
            const searchesTried = [{ query: nativeQuery, outcome: found.outcome }];
            if (found.outcome === 'no_match') {
              const fallbacks = partyMatchSearchTerms(party.name).filter(term => term !== party.name).slice(0, 2);
              for (const term of fallbacks) {
                nativeQuery = term;
                found = await runTool({ tool: spec.tool, query: nativeQuery });
                searchesTried.push({ query: nativeQuery, outcome: found.outcome });
                if (found.outcome !== 'no_match') break;
              }
            }
            const closed = await runTool({ tool: 'closeGuestStayPartyPicker', propertyCode: ctx.property.propertyCode });
            const coverage = record(found.coverage), verifiedFields = verifiedNativeFields(found);
            const candidates = Array.isArray(found.candidates) ? found.candidates.map(record).filter(Boolean) : [];
            const projected = partyCandidateViews(candidates, spec.role, verifiedFields);
            const criteria = record(found.criteria);
            const complete = ['matches', 'no_match'].includes(String(found.outcome)) && typeof found.searchId === 'string' &&
              criteria?.query === nativeQuery && coverage?.possiblyTruncated === false &&
              typeof coverage.loaded === 'number' && Number.isInteger(coverage.loaded) && candidates.length === coverage.loaded &&
              verifiedFields.includes(spec.idField) && verifiedFields.includes(spec.nameField) && projected.valid &&
              closed.outcome === 'closed_unsaved';
            projected.rows.sort((left, right) => Number(reservationEntityKey(String(right.name), spec.role) === reservationEntityKey(party.name, spec.role)) -
              Number(reservationEntityKey(String(left.name), spec.role) === reservationEntityKey(party.name, spec.role)));
            const info = { outcome: complete ? found.outcome : 'partial', searchOutcome: found.outcome,
              query: party.name, searchId: typeof found.searchId === 'string' ? found.searchId : null,
              criteria, coverage, correlation: { verifiedFields }, candidates: projected.rows, nativeQuery, searchesTried,
              closeOutcome: closed.outcome };
            partySearches[spec.key] = info;
            if (found.searchId && ['matches', 'no_match'].includes(String(found.outcome))) {
              const candidatesForObservation = projected.rows.length ? projected.rows : [null];
              for (const [candidateIndex, candidate] of candidatesForObservation.entries()) {
                nativeObservations.push({ ref: randomUUID(), generationId: loaded.draft!.generationId,
                  kind: 'party_candidate', status: complete ? 'complete' : 'partial', observedAt: new Date().toISOString(),
                  propertyCode: loaded.draft!.propertyCode, sourceMessageId: loaded.draft!.source.messageId, sourceRefs: [],
                  criteria: { workflow: 'create', kind: 'party_name', requestId: request.id, allocationId,
                    role: spec.role === 'agency' ? 'bookingAgency' : spec.role, fieldPaths: [party.selectionPath], query: party.name, nativeQuery, searchesTried,
                    candidateIndex, coverage,
                    correlation: { verifiedFields } },
                  coverage: { complete: Boolean(complete), notes: complete ? [] : ['native_party_lookup_incomplete'] },
                  result: { outcome: found.outcome, criteria: record(found.criteria), coverage,
                    correlation: { verifiedFields }, candidates: candidate ? [candidate] : [] } });
              }
            }
            if (!complete) allocationStatus = 'partial';
            if (closed.outcome !== 'closed_unsaved') {
              perAllocation.push({ status: 'failed', requestId: request.id, allocationId,
                guestCandidates: guestInfo, partySearches, issue: 'party_picker_close_unverified' });
              return { lookups: perAllocation, observations: nativeObservations, sessionSafe: false };
            }
          }
          perAllocation.push({ status: allocationStatus, requestId: request.id, allocationId,
            guestCandidates: guestInfo, partySearches,
            ...(guestSearch.issue ? { issue: guestSearch.issue } : {}) });
        }
      }
      const uniqueTargets = [...new Map(catalogueTargets.map(target =>
        [`${target.requestId}\u0000${target.allocationId}`, target])).values()];
      const catalogues: Array<Record<string, unknown>> = [];
      if (uniqueTargets.length) {
        for (const spec of [
          { field: 'guaranteeType', kind: 'guarantee' }, { field: 'reasonForStay', kind: 'reason_for_stay' },
        ] as const) {
          const listed = await runTool({ tool: 'listGuestStayDropdown', propertyCode: ctx.property.propertyCode, field: spec.field });
          const options = Array.isArray(listed.options) ? listed.options.map(record).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
          const choices = options.flatMap((item) => {
            const code = text(item.value) ?? (typeof item.value === 'number' ? String(item.value) : null), label = text(item.label);
            return code && label ? [{ code, label }] : [];
          });
          if (listed.outcome === 'ok') for (const target of uniqueTargets) nativeObservations.push(
            createFieldChoiceObservation(loaded.draft!, target, spec.field, spec.kind, choices, false, 'closed_unsaved'));
        }
        const cms = await runTool({ tool: 'listCmsMessageIds', propertyCode: ctx.property.propertyCode });
        const cmsClosed = await runTool({ tool: 'closeCmsMessageIdPicker', propertyCode: ctx.property.propertyCode });
        if (!['closed_unsaved', 'not_open'].includes(String(cmsClosed.outcome))) {
          return { lookups: perAllocation, observations: nativeObservations, catalogues, sessionSafe: false, issue: 'cms_picker_close_unverified' };
        }
        if (cms.outcome === 'ok' && cmsClosed.outcome === 'closed_unsaved') {
          const choices = (Array.isArray(cms.candidates) ? cms.candidates : []).map(record).flatMap((item) => {
            const code = text(item?.code), label = text(item?.description) ?? code;
            return code && label ? [{ code, label }] : [];
          });
          for (const target of uniqueTargets) nativeObservations.push(createFieldChoiceObservation(
            loaded.draft!, target, 'cmsMessageId', 'cms_message', choices, false, String(cmsClosed.outcome)));
        }
        const source = await runTool({ tool: 'searchGuestStaySourceBusiness', field: 'description', query: '' });
        const sourceCoverage = record(source.coverage);
        const sourceRows: Record<string, unknown>[] = [];
        const loadedCount = typeof sourceCoverage?.loaded === 'number' && Number.isInteger(sourceCoverage.loaded)
          ? Math.min(sourceCoverage.loaded, 200) : 0;
        if (typeof source.searchId === 'string') {
          for (let offset = 0; offset < loadedCount; offset += 100) {
            const page = await runTool({ tool: 'inspectGuestStaySourceBusiness', searchId: source.searchId, offset, limit: 100 });
            if (page.outcome !== 'ok' || !Array.isArray(page.candidates)) break;
            sourceRows.push(...page.candidates.map(record).filter((item): item is Record<string, unknown> => Boolean(item)));
          }
        }
        const sourceClosed = await runTool({ tool: 'closeGuestStaySourceBusinessPicker' });
        if (!['closed_unchanged', 'not_open'].includes(String(sourceClosed.outcome))) {
          return { lookups: perAllocation, observations: nativeObservations, catalogues, sessionSafe: false, issue: 'source_picker_close_unverified' };
        }
        if (['matches', 'no_match'].includes(String(source.outcome)) && sourceClosed.outcome === 'closed_unchanged') {
          const choices = sourceRows.flatMap((item) => {
            const response = record(item.responseData), grid = record(item.gridData);
            const code = text(item.nativeCode), label = text(item.description);
            return code && label && response && grid && text(response.codevalue) === code && text(grid.codevalue) === code &&
              text(response.description) === label && text(grid.description) === label ? [{ code, label }] : [];
          });
          const complete = sourceCoverage?.serverMoreRecords === false && sourceCoverage.possiblyTruncated === false &&
            sourceRows.length === sourceCoverage.loaded && choices.length === sourceRows.length;
          for (const target of uniqueTargets) nativeObservations.push(createFieldChoiceObservation(
            loaded.draft!, target, 'sourceOfBusiness', 'source_of_business', choices, complete, String(sourceClosed.outcome)));
        }
      }
      return { lookups: perAllocation, observations: nativeObservations, catalogues, sessionSafe: true };
    }, { propertyCode: ctx.property.propertyCode, transportId: ctx.transport.id, signal: ctx.nativeBatch?.signal }));
  } catch {
    return { status: 'failed', issue: 'native_create_lookup_failed', requestId: input.requestId ?? null };
  }
  if (!sessionResult || sessionResult.sessionSafe !== true || !Array.isArray(sessionResult.observations) ||
      !Array.isArray(sessionResult.lookups)) {
    return { status: 'failed', issue: 'native_lookup_session_not_clean', requestId: input.requestId ?? null,
      lookups: sessionResult?.lookups ?? [] };
  }
  const catalogues: Array<Record<string, unknown>> = [];
  const uniqueTargets = [...new Map(catalogueTargets.map(target =>
    [`${target.requestId}\u0000${target.allocationId}`, target])).values()];
  try {
    if (uniqueTargets.length) for (const spec of [
      { tool: 'searchRoomTypes', kind: 'room_type' },
      { tool: 'searchRoomTypesForCharge', kind: 'room_type_for_charge' },
      { tool: 'searchRatePlans', kind: 'rate_plan' },
    ] as const) {
      const catalogue = await bookingTool.withCloudRoomRateReadSession(spec.tool, ({ runTool }) =>
        readCreateCatalogue(runTool, spec.tool, spec.kind, ctx.property.propertyCode),
      { propertyCode: ctx.property.propertyCode, transportId: ctx.transport.id, signal: ctx.nativeBatch?.signal }) as CreateCatalogueRead;
      catalogues.push({ kind: catalogue.kind, outcome: catalogue.outcome, complete: catalogue.complete,
        candidateCount: catalogue.candidates.length, coverage: catalogue.coverage, issue: catalogue.issue });
      for (const target of uniqueTargets) nativeObservations.push(
        createCatalogueObservation(loaded.draft!, target, catalogue, 'closed_unsaved'));
    }
  } catch {
    return { status: 'failed', issue: 'native_catalogue_session_not_clean', requestId: input.requestId ?? null };
  }
  const observations = nativeObservations.filter((item): item is ReservationWorkflowV2Observation => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    return !persistedConfirmationRefs.has((item as ReservationWorkflowV2Observation).ref);
  });
  const fresh = await currentDraft(ctx, input);
  if (!fresh.draft) return fresh.result;
  for (const observation of nativeObservations) {
    if (persistedConfirmationRefs.has(observation.ref)) continue;
    const appended = await appendReservationWorkflowV2Observation(stateContext(ctx), { workItemId: input.workItemId,
      source: input.source, observation });
    if (appended.status !== 'ok') return appended;
  }
  return { status: 'ok', revision: fresh.result.status === 'ok' ? fresh.result.revision : input.expectedRevision,
    seq: fresh.result.status === 'ok' ? fresh.result.seq : input.expectedSeq,
    requests, lookups: sessionResult.lookups, catalogues,
    observations: [...fresh.draft.observations, ...observations], operationResults: fresh.draft.operationResults };
}

/** Compile one reviewed room against host-admitted IDs, then ask HMS for live unsaved availability. */
export async function reservationWorkflowV2Prepare(ctx: ReadContext,
  input: ReservationWorkflowV2PrepareInput): Promise<Outcome> {
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return loaded.result;
  if (!input.allocationId) return { status: 'needs_input', issue: 'allocation_required' };
  const compiled = compileCreate(loaded.draft, input.requestId, input.allocationId, ctx.property.propertyCode,
    ctx.nativeBatch ? 'background_prepare' : 'prepare');
  if (compiled.outcome !== 'ok') return { status: compiled.outcome, outcomeClass: 'needs_input', issue: compiled.issue,
    fields: compiled.fields ?? [], details: compiled.details ?? [], readiness: createReadiness(loaded.draft, input.requestId, 'check') };
  const policyIssue = await createPolicyIssue(ctx, compiled.nativeInput);
  if (policyIssue) return { status: 'needs_input', issue: policyIssue };
  try {
    const tool = await import(new URL('../../tooling/hms-cloud/create-reservation.mjs', import.meta.url).href) as {
      createReservation: (input: Record<string, unknown>, options: Record<string, unknown>) => Promise<NativeCreate>;
    };
    const session = ctx.nativeBatch ? await import(new URL('../../tooling/hms-cloud/booking-lookup-session.mjs', import.meta.url).href) as {
      withBookingLookupSession: (callback: unknown, options: Record<string, unknown>) => Promise<unknown>;
    } : null;
    const native = await tool.createReservation(compiled.nativeInput, { allowRealGuest: true, expectedGuest: compiled.expectedGuest,
      transportId: ctx.transport.id, signal: ctx.nativeBatch?.signal,
      cloudTargetKey: createCloudTargetKey(compiled.expectedGuest, record(compiled.nativeInput.stay)?.arrival),
      requireExplicitGuestSelection: true, capturePrepareScreenshot: true, allowCommitOnlyBillingReference: true,
      ...(session ? { withSession: (callback: unknown, options: Record<string, unknown>) =>
        session.withBookingLookupSession(callback, { ...options, signal: ctx.nativeBatch!.signal }) } : {}) });
    ctx.nativeBatch?.signal.throwIfAborted();
    const mapped = mapNativeOutcome(native), price = validPrice(native.ratePlanAvailability);
    const nativeMeal = native.applied?.mealPlan;
    const bindingRoom = record(record(native.requestBinding?.request)?.room);
    const mealPlanMatches = mapped.status !== 'prepared' || (nativeMeal === bindingRoom?.mealPlan &&
      reservationWorkflowV2CreateMealPlanMatches(compiled.requestedMealPlan, compiled.mealPlan, nativeMeal, ctx.property.propertyCode));
    const prepareShot = await persistPreparedScreenshot(ctx, input.workItemId, native.screenshots?.filled);
    const status = mapped.status === 'prepared' && price && prepareShot && mealPlanMatches ? 'complete'
      : native.outcome === 'needs_input' || !mealPlanMatches ? 'partial' : 'failed';
    const observation = operationObservation(loaded.draft, input.requestId, input.allocationId, compiled.nativeInput,
      native, price, status, prepareShot, compiled.semanticDigest, compiled.requestedMealPlan,
      !mealPlanMatches ? 'native_meal_plan_mismatch_or_unknown' : undefined);
    const recorded = await recordNativeObservation(ctx, input, observation,
      status === 'complete' ? 'prepared' : 'failed', status === 'complete' ? 'HMS unsaved form and current rate availability verified' :
        !mealPlanMatches ? 'Requested meal plan differs from the current native rate' : mapped.issue ?? 'native prepare incomplete');
    if (recorded.status !== 'ok') return recorded;
    if (!mealPlanMatches) return { status: 'needs_input', issue: 'native_meal_plan_mismatch_or_unknown',
      fields: [compiled.requestedMealPlan !== null ? 'requestedMealPlan' : compiled.mealPlan !== null ? 'mealPlan' : 'ratePlan'],
      observationRef: observation.ref, applied: native.applied ?? {} };
    if (mapped.status !== 'prepared' || !price || !prepareShot) return { status: mapped.status === 'prepared' ? 'failed' : mapped.status,
      issue: mapped.status !== 'prepared' ? mapped.issue : !price ? 'rate_availability_unverified' : 'prepare_screenshot_not_persisted',
      fields: [...new Set([...(native.missing ?? []).filter((field): field is string => typeof field === 'string')
        .map(field => field.split('.').at(-1)!), ...(native.issue === 'RATE_NOT_AVAILABLE' ? ['ratePlan'] : [])])],
      observationRef: observation.ref, ratePlanIssue: native.ratePlanIssue };
    return { status: 'prepared', requestId: input.requestId, allocationId: input.allocationId,
      observationRef: observation.ref, requestDigest: native.requestBinding?.digest,
      ratePlanAvailability: price, applied: native.applied ?? {}, commitOnlyFields: native.commitOnlyFields ?? [],
      screenshot: prepareShot };
  } catch {
    return { status: 'failed', issue: 'native_create_prepare_failed' };
  }
}

function nativeRunId(path: unknown, expectedName: string): { runId: string; sourceDir: string } | null {
  if (typeof path !== 'string') return null;
  const dir = dirname(path);
  const match = /^hms-cloud-create-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(basename(dir));
  if (!match || path !== join(dir, expectedName) || dir.startsWith('/') === false) return null;
  return { runId: match[1]!, sourceDir: dir };
}

async function persistNativeShots(ctx: ReadContext, workItemId: string,
  runId: string, paths: Partial<Record<'before.png' | 'filled.png' | 'saved.png', unknown>>) {
  const entries = Object.entries(paths).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  if (!entries.length) return null;
  const stage = await mkdtemp(join(tmpdir(), 'reservation-v2-shots-'));
  const owner = 'system' in ctx ? `arrival-service:${ctx.nativeBatch.jobFence.runId}:${ctx.transport.id}`
    : `${ctx.user.id}:${ctx.transport.id}`;
  try {
    for (const [name, source] of entries) {
      const parsed = nativeRunId(source, name);
      if (!parsed || parsed.runId !== runId) return null;
      await copyFile(source, join(stage, name));
    }
    const shots = await persistHmsShots({ propertyCode: ctx.property.propertyCode, workItemId, runId,
      sourceDir: stage, owner, now: Date.now() });
    if (!shots) return null;
    for (const [name] of entries) {
      const saved = shots.find((shot) => shot.name === name);
      if (!saved || !await verifyStoredHmsShot({ runId, name, sha256: saved.sha256, owner,
        propertyCode: ctx.property.propertyCode, workItemId }, name as 'before.png' | 'filled.png' | 'saved.png')) return null;
    }
    return { runId, shots };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function persistPreparedScreenshot(ctx: ReadContext, workItemId: string, path: unknown) {
  const parsed = nativeRunId(path, 'filled.png');
  if (!parsed) return null;
  const persisted = await persistNativeShots(ctx, workItemId, parsed.runId, { 'filled.png': path });
  return persisted?.shots.find((shot) => shot.name === 'filled.png')
    ? { runId: parsed.runId, sha256: persisted.shots.find((shot) => shot.name === 'filled.png')!.sha256 } : null;
}

/** Give a staff-authorised dispatch its own verified copy of a background preview. */
async function staffOwnedPrepareShot(ctx: ReservationWorkflowV2ServerContext, draft: ReservationWorkflowV2Draft,
  workItemId: string, shot: { runId: string; sha256: string }) {
  const staffOwner = `${ctx.user.id}:${ctx.transport.id}`;
  const verify = (owner: string, ref = shot) => verifyStoredHmsShot({ ...ref, name: 'filled.png', owner,
    propertyCode: ctx.property.propertyCode, workItemId });
  if (await verify(staffOwner)) return shot;
  const jobId = draft.prefill?.jobRunId;
  if (!jobId) return null;
  const backgroundOwner = `arrival-service:${jobId}:${ctx.transport.id}`;
  if (!await verify(backgroundOwner)) return null;
  const bytes = await readStoredHmsShot({ runId: shot.runId, name: 'filled.png', owner: backgroundOwner });
  if (!bytes) return null;
  const stage = await mkdtemp(join(tmpdir(), 'reservation-v2-preview-copy-'));
  try {
    await writeFile(join(stage, 'filled.png'), bytes, { mode: 0o600 });
    const runId = randomUUID();
    const copies = await persistHmsShots({ propertyCode: ctx.property.propertyCode, workItemId, runId,
      sourceDir: stage, owner: staffOwner, now: Date.now() });
    const copy = copies?.find((entry) => entry.name === 'filled.png' && entry.sha256 === shot.sha256);
    const ref = copy && { runId, sha256: copy.sha256 };
    return ref && await verify(staffOwner, ref) ? ref : null;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function persistBeforeScreenshot(ctx: ReservationWorkflowV2ServerContext, workItemId: string, path: unknown) {
  const parsed = nativeRunId(path, 'before.png');
  if (!parsed) return null;
  const persisted = await persistNativeShots(ctx, workItemId, parsed.runId, { 'before.png': path });
  const shot = persisted?.shots.find((item) => item.name === 'before.png');
  return shot ? { runId: parsed.runId, sha256: shot.sha256 } : null;
}

async function persistSavedScreenshot(ctx: ReservationWorkflowV2ServerContext, workItemId: string,
  beforePath: unknown, afterPath: unknown) {
  const before = nativeRunId(beforePath, 'before.png');
  if (!before || typeof afterPath !== 'string' || dirname(afterPath) !== before.sourceDir ||
      afterPath !== join(before.sourceDir, 'after.png')) return null;
  const stage = await mkdtemp(join(tmpdir(), 'reservation-v2-shots-'));
  const owner = `${ctx.user.id}:${ctx.transport.id}`;
  try {
    await copyFile(beforePath as string, join(stage, 'before.png'));
    await copyFile(afterPath, join(stage, 'saved.png'));
    const shots = await persistHmsShots({ propertyCode: ctx.property.propertyCode, workItemId, runId: before.runId,
      sourceDir: stage, owner, now: Date.now() });
    const saved = shots?.find((shot) => shot.name === 'saved.png');
    const prior = shots?.find((shot) => shot.name === 'before.png');
    if (!saved || !prior || !await verifyStoredHmsShot({ runId: before.runId, name: 'saved.png', sha256: saved.sha256,
      owner, propertyCode: ctx.property.propertyCode, workItemId }, 'saved.png')) return null;
    return { runId: before.runId, savedShot: { runId: before.runId, sha256: saved.sha256 },
      beforeShot: { runId: before.runId, sha256: prior.sha256 } };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

function preparedFor(draft: ReservationWorkflowV2Draft, requestId: string, allocationId: string, semanticDigest?: string) {
  const result = [...draft.operationResults].reverse().find((entry) => entry.requestId === requestId &&
    entry.allocationId === allocationId && entry.workflow === 'create' && entry.generationId === draft.generationId &&
    entry.draftRevision <= draft.revision && (entry.status === 'prepared' || entry.status === 'failed' &&
      draft.observations.some(item => entry.observationRefs.includes(item.ref) && item.kind === 'rate_availability' &&
        item.generationId === draft.generationId && item.criteria.workflow === 'create' &&
        item.criteria.requestId === requestId && item.criteria.allocationId === allocationId)));
  if (!result || result.status !== 'prepared') return null;
  const observation = draft.observations.find((item) => result.observationRefs.includes(item.ref) &&
    item.kind === 'rate_availability' && item.status === 'complete' && item.generationId === draft.generationId);
  const stored = observation && record(observation.result);
  const binding = stored && record(stored.requestBinding);
  const price = stored && validPrice(stored.ratePlanAvailability);
  const shot = stored && record(stored.prepareShot);
  if (!observation || !stored || !Number.isFinite(Date.parse(observation.observedAt)) ||
      Date.now() - Date.parse(observation.observedAt) >= 30 * 60_000 ||
      (semanticDigest && observation.criteria.semanticDigest !== semanticDigest) ||
      !binding || typeof binding.digest !== 'string' || !/^[a-f0-9]{64}$/.test(binding.digest) ||
      !record(binding.request) || !price) return null;
  const bindingRequest = record(binding.request);
  const bindingParties = record(bindingRequest?.parties);
  const arAccountProfileId = text(binding.arAccountProfileId);
  if (bindingParties?.arAccount && (!arAccountProfileId || !/^\d+$/.test(arAccountProfileId))) return null;
  return { result, observation, stored, request: binding.request, digest: binding.digest, price, arAccountProfileId,
    prepareShot: shot && typeof shot.runId === 'string' && typeof shot.sha256 === 'string' ? shot : null };
}

/** Project only a current, fully verified native Create preview into the durable approval boundary. */
export async function reservationWorkflowV2CreatePreparation(ctx: ReservationWorkflowV2ServerContext,
  input: ReservationWorkflowV2PrepareInput, observationRef?: string) {
  if (!input.allocationId) return null;
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return null;
  const request = loaded.draft.proposal.content.requests.find(entry => entry.id === input.requestId);
  if (!request || request.kind !== 'create') return null;
  const body = effectiveSubtree(loaded.draft, request.body, ptr('proposal', 'content', 'requests', request.id, 'body')) as typeof request.body | null;
  if (!body || !Array.isArray(body.allocations) || body.allocations.length < 1 || body.allocations.length > 8 ||
      new Set(body.allocations.map(allocation => allocation.id)).size !== body.allocations.length) return null;
  const allocations: Array<{ allocationId: string; businessDigest: string; observationRef: string }> = [];
  const observations: Array<{ allocationId: string; observationRef: string; stored: unknown }> = [];
  const prices: Array<{ allocationId: string; price: unknown }> = [];
  const aliases = new Set<string>();
  const warnings: string[] = [];
  let oldest = '';
  for (const allocation of body.allocations) {
    if (loaded.draft.operationResults.some(result => result.workflow === 'create' && result.requestId === input.requestId &&
        result.allocationId === allocation.id && (result.status === 'succeeded' || result.status === 'unknown'))) return null;
    const compiled = compileCreate(loaded.draft, input.requestId, allocation.id, ctx.property.propertyCode, 'prepare');
    if (compiled.outcome !== 'ok') return null;
    if (await createPolicyIssue(ctx, compiled.nativeInput)) return null;
    const prepared = preparedFor(loaded.draft, input.requestId, allocation.id, compiled.semanticDigest);
    const target = hmsDispatchTargetSchema.safeParse(compiled.target);
    if (!prepared || observationRef && allocation.id === input.allocationId && prepared.observation.ref !== observationRef ||
        !prepared.prepareShot || !prepared.observation.coverage.complete ||
        !Number.isFinite(Date.parse(prepared.observation.observedAt)) ||
        Date.now() - Date.parse(prepared.observation.observedAt) >= 30 * 60_000 ||
        !nativeInputMatchesBinding(compiled, prepared.request) || !target.success || target.data.kind !== 'create' ||
        reservationWorkflowV2CreatePriceComparison(loaded.draft, input.requestId, allocation.id, ctx.property.propertyCode).blocksGo) return null;
    for (const alias of hmsDispatchTargetKeys(target.data)) aliases.add(alias);
    allocations.push({ allocationId: allocation.id, businessDigest: compiled.semanticDigest, observationRef: prepared.observation.ref });
    observations.push({ allocationId: allocation.id, observationRef: prepared.observation.ref, stored: prepared.stored });
    prices.push({ allocationId: allocation.id, price: prepared.price });
    warnings.push(...prepared.observation.coverage.notes);
    if (!oldest || Date.parse(prepared.observation.observedAt) < Date.parse(oldest)) oldest = prepared.observation.observedAt;
  }
  if (!allocations.some(allocation => allocation.allocationId === input.allocationId)) return null;
  const { allocationId: _allocationId, ...batchInput } = input;
  return { operation: 'create' as const, targetAliases: [...aliases].sort(),
    nativeObservation: { beforeDigest: sha256(observations), capturedAt: oldest, price: prices, warnings },
    allocations, workflowContext: { endpoint: 'execute' as const, input: batchInput } };
}

type PriceCheck = 'match' | 'mismatch' | 'unknown' | 'not_requested';
type PriceComparison = {
  status: 'not_requested' | 'not_applicable' | 'match' | 'mismatch' | 'unknown';
  blocksGo: boolean;
  scope?: 'per_room' | 'whole_group' | 'unknown';
  dateIndex?: number;
  requested: { nightlyRate: string | null; total: string | null; currency: string | null };
  native: { averageRate: string; totalRate: string; currency: string } | null;
  rooms: Array<{ allocationId: string; current: boolean; price?: { averageRate: string; totalRate: string; currency: string } }>;
  checks: { nightlyRate: PriceCheck; total: PriceCheck; currency: PriceCheck };
  sourceRefs: string[];
  explanation: string;
};
type ExtractedPriceRequest = NonNullable<NonNullable<ReservationWorkflowV2Draft['extraction']>['requests'][number]['requestedPrice']>;
type ParsedMoney = { minor: bigint; currency: string | null };

function effectivePriceScope(price: ExtractedPriceRequest): 'per_room' | 'whole_group' | 'unknown' {
  const totalRaw = price.total?.raw ?? '';
  // Preserve the extractor's scope unless the total itself clearly names the
  // whole booking/group. Weak phrases like "stay total" can mean a per-room
  // total, and separate nightly wording must not change this claim's scope.
  const describesWholeGroup = [
    /\b(?:whole|entire|overall)\s+(?:booking|reservation|stay|group)\b/i,
    /\b(?:for\s+)?all\s+(?:\d+\s+)?rooms\b/i,
  ].some((pattern) => pattern.test(totalRaw));
  if (describesWholeGroup) {
    return 'whole_group';
  }
  return price.scope;
}

function hasExplicitPerRoomNightlyBasis(price: ExtractedPriceRequest): boolean {
  return /\bper\s+room\s+per\s+night\b/i.test(price.nightlyRate?.raw ?? '');
}

function currencyCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toUpperCase();
  if (raw === 'R' || raw === 'RAND') return 'ZAR';
  if (raw === '£') return 'GBP';
  if (raw === '€') return 'EUR';
  return /^[A-Z]{3}$/.test(raw) ? raw : null;
}

/** Parse an unambiguous decimal amount without floating-point arithmetic. */
function parseMoney(value: unknown): ParsedMoney | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) return null;
  let raw = String(value).trim();
  if (!raw || raw.length > 80) return null;
  let foundCurrency: string | null = null;
  const prefix = /^(ZAR|USD|EUR|GBP|CAD|AUD|NZD|CHF|JPY|CNY|INR|R|\$|£|€)\s*/i.exec(raw);
  if (prefix) {
    foundCurrency = currencyCode(prefix[1]);
    raw = raw.slice(prefix[0].length);
  }
  const suffix = /\s*(ZAR|USD|EUR|GBP|CAD|AUD|NZD|CHF|JPY|CNY|INR)$/i.exec(raw);
  if (suffix) {
    const trailingCurrency = currencyCode(suffix[1]);
    if (foundCurrency && trailingCurrency !== foundCurrency) return null;
    foundCurrency = trailingCurrency;
    raw = raw.slice(0, suffix.index).trim();
  }
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.replaceAll(',', '').split('.');
  if (whole!.length > 30) return null;
  return { minor: BigInt(whole!) * 100n + BigInt((fraction + '00').slice(0, 2)), currency: foundCurrency };
}

function moneyText(minor: bigint): string {
  const whole = minor / 100n;
  const fraction = (minor % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}

function extractedMoney(claim: { raw: string; value: unknown; sourceRefs: string[] } | undefined): ParsedMoney | null {
  if (!claim || !claim.sourceRefs.length) return null;
  const parsed = parseMoney(claim.value);
  if (!parsed) return null;
  return { ...parsed, currency: parsed.currency ?? parseMoney(claim.raw)?.currency ?? null };
}

function extractedCurrency(claim: { raw: string; value: unknown; sourceRefs: string[] } | undefined): string | null {
  if (!claim || !claim.sourceRefs.length) return null;
  return currencyCode(claim.value) ?? currencyCode(claim.raw) ?? parseMoney(claim.raw)?.currency ?? null;
}

function extractionPriceRequest(draft: ReservationWorkflowV2Draft, requestId: string) {
  const extraction = draft.extraction;
  if (!extraction || draft.extractionGenerationId !== draft.generationId) return null;
  const proposed = draft.proposal.content.requests.find(request => request.id === requestId && request.kind === 'create');
  if (!proposed) return null;
  // Synthesis IDs can have been borrowed by another action. Match source text
  // first, just as the source projector does, rather than comparing its price.
  const candidates = extraction.requests.filter(request => request.kind === 'create');
  const matchingText = candidates.filter(request => request.requestText.raw.trim() === proposed.requestText.trim());
  if (matchingText.length === 1) return matchingText[0]!;
  return candidates.length === 1 && candidates[0]!.id === requestId ? candidates[0]! : null;
}

function priceSection(body: CreateRequestBody, extracted: NonNullable<ReturnType<typeof extractionPriceRequest>>,
  price: ExtractedPriceRequest): { sectionId: string } | { issue: string; blocksGo?: boolean } {
  if (price.scope === 'unknown') return { issue: 'The source did not distinguish per-room from whole-group pricing.' };
  const dateIndex = price.dateIndex ?? (extracted.dates.length === 1 ? 0 : undefined);
  if (dateIndex === undefined || dateIndex >= extracted.dates.length) {
    return { issue: 'The requested price is not tied to one unambiguous source date range.' };
  }
  const dates = extracted.dates[dateIndex];
  const arrival = text(dates?.arrival?.value), departure = text(dates?.departure?.value);
  if (!arrival || !departure) return { issue: 'The source price date range is incomplete.' };
  const sections = body.dateSections.filter((section) => section.arrival === arrival && section.departure === departure);
  if (sections.length !== 1) return { blocksGo: sections.length === 0, issue: sections.length ? 'The source date range maps to multiple booking sections.' :
    'The voucher price belongs to the original source dates. Correct the booking dates or review an updated voucher before saving.' };
  return { sectionId: sections[0]!.id };
}

function unknownPriceComparison(input: {
  price: ExtractedPriceRequest; reason: string; rooms?: PriceComparison['rooms']; native?: PriceComparison['native'];
  blocksGo?: boolean;
}): PriceComparison {
  return { status: 'unknown', blocksGo: input.blocksGo ?? false, scope: input.price.scope,
    ...(input.price.dateIndex !== undefined ? { dateIndex: input.price.dateIndex } : {}),
    requested: { nightlyRate: input.price.nightlyRate?.raw ?? null, total: input.price.total?.raw ?? null,
      currency: input.price.currency?.raw ?? null }, native: input.native ?? null, rooms: input.rooms ?? [],
    checks: { nightlyRate: input.price.nightlyRate ? 'unknown' : 'not_requested',
      total: input.price.total ? 'unknown' : 'not_requested', currency: 'unknown' },
    sourceRefs: [...new Set([...(input.price.nightlyRate?.sourceRefs ?? []), ...(input.price.total?.sourceRefs ?? []),
      ...(input.price.currency?.sourceRefs ?? [])])], explanation: input.reason };
}

function reservationWorkflowV2CreatePriceComparison(draft: ReservationWorkflowV2Draft, requestId: string,
  allocationId: string, propertyCode: string): PriceComparison {
  const extracted = extractionPriceRequest(draft, requestId);
  const extractedPrice = extracted?.requestedPrice;
  const price = extractedPrice ? { ...extractedPrice, scope: effectivePriceScope(extractedPrice) } : undefined;
  const requested = { nightlyRate: price?.nightlyRate?.raw ?? null, total: price?.total?.raw ?? null,
    currency: price?.currency?.raw ?? null };
  const sourceRefs = [...new Set([...(price?.nightlyRate?.sourceRefs ?? []), ...(price?.total?.sourceRefs ?? []),
    ...(price?.currency?.sourceRefs ?? [])])];
  if (!extracted && draft.extractionGenerationId === draft.generationId &&
      draft.extraction?.requests.some(row => row.kind === 'create' &&
        (row.requestedPrice?.nightlyRate || row.requestedPrice?.total))) return {
    status: 'unknown', blocksGo: false, requested, native: null, rooms: [],
    checks: { nightlyRate: 'unknown', total: 'unknown', currency: 'unknown' }, sourceRefs,
    explanation: 'A source booking price exists, but it cannot be linked uniquely to this Create action. Review the original voucher; no price from another action was assumed.' };
  if (!price || (!price.nightlyRate && !price.total)) return { status: 'not_requested', blocksGo: false, requested,
    native: null, rooms: [], checks: { nightlyRate: 'not_requested', total: 'not_requested', currency: 'not_requested' },
    sourceRefs, explanation: 'No source-cited nightly rate or total was requested.' };
  const request = draft.proposal.content.requests.find((entry) => entry.id === requestId && entry.kind === 'create');
  const body = request && request.kind === 'create' ? effectiveSubtree(draft, request.body,
    ptr('proposal', 'content', 'requests', requestId, 'body')) as CreateRequestBody | null : null;
  if (!body || !extracted) return unknownPriceComparison({ price,
    reason: 'The current Create extraction or booking fields are unavailable; no source price was assumed.' });
  // Moving the original voucher to its dependent Filing owner must not detach
  // that PDF's cited price from the Create allocation it describes.
  const ownedAttachmentRefs = draft.proposal.content.documents.filter(document =>
    document.ownerRequestId === requestId || extracted.documentRefs.includes(document.documentSourceRef) &&
      document.targetRefs.some(target => target.kind === 'allocation' && target.requestId === requestId &&
        body.allocations.some(allocation => allocation.id === target.allocationId)))
    .flatMap(document => [document.documentSourceRef, ...document.sourceRefs]);
  const currentPriceRefs = new Set([...extracted.requestText.sourceRefs, ...ownedAttachmentRefs]);
  const priceClaims = [price.nightlyRate, price.total, price.currency].filter((claim) => claim !== undefined);
  if (priceClaims.some((claim) => claim.sourceRefs.some((ref) => !currentPriceRefs.has(ref)))) {
    return unknownPriceComparison({ price,
      reason: 'A requested price cites evidence outside the current request and its owned attachments; prior-thread prices were not used.' });
  }
  const nightly = extractedMoney(price.nightlyRate);
  const total = extractedMoney(price.total);
  const claimedCurrency = extractedCurrency(price.currency) ?? nightly?.currency ?? total?.currency;
  if ((price.nightlyRate && !nightly) || (price.total && !total)) return unknownPriceComparison({ price,
    reason: 'A source-cited requested amount is not an unambiguous decimal; it was not compared.' });
  if (!claimedCurrency) return unknownPriceComparison({ price,
    reason: 'Source currency is missing or ambiguous; no currency or conversion was assumed.' });
  if ((nightly?.currency && nightly.currency !== claimedCurrency) || (total?.currency && total.currency !== claimedCurrency)) {
    return unknownPriceComparison({ price, reason: 'Source amount and currency claims conflict; the price was not compared.' });
  }
  const section = priceSection(body, extracted, price);
  if ('issue' in section) return unknownPriceComparison({ price, reason: section.issue, blocksGo: section.blocksGo });
  const allocation = body.allocations.find((entry) => entry.id === allocationId);
  if (!allocation) return unknownPriceComparison({ price, reason: 'The target room allocation is unavailable.' });
  if (allocation.dateSectionId !== section.sectionId) return { status: 'not_applicable', blocksGo: false,
    scope: price.scope, ...(price.dateIndex !== undefined ? { dateIndex: price.dateIndex } : {}), requested,
    native: null, rooms: [], checks: { nightlyRate: 'not_requested', total: 'not_requested', currency: 'not_requested' },
    sourceRefs, explanation: 'This requested price belongs to a different date section.' };
  const allocations = price.scope === 'whole_group'
    ? body.allocations.filter((entry) => entry.dateSectionId === section.sectionId) : [allocation];
  if (!allocations.length || allocations.length > 8) return unknownPriceComparison({ price,
    reason: 'The source price room group is empty or exceeds the supported native Create room limit.' });
  if (price.scope === 'whole_group') {
    const sectionRow = body.dateSections.find((entry) => entry.id === section.sectionId);
    if (!Number.isSafeInteger(sectionRow?.requestedRooms) || sectionRow?.requestedRooms !== allocations.length) {
      return unknownPriceComparison({ price,
        reason: 'The whole-group room count cannot be matched to the current booking allocations; the price was not compared.' });
    }
  }
  const rooms = allocations.map((room) => {
    const compiled = compileCreate(draft, requestId, room.id, propertyCode, 'prepare');
    const saved = savedCreateNativePrice(draft, requestId, room.id, compiled);
    if (saved.completed) return { allocationId: room.id, current: Boolean(saved.price),
      ...(saved.price ? { price: saved.price } : {}) };
    const prepared = compiled.outcome === 'ok' ? preparedFor(draft, requestId, room.id, compiled.semanticDigest) : null;
    return { allocationId: room.id, current: Boolean(prepared), ...(prepared ? { price: prepared.price } : {}) };
  });
  if (rooms.some((room) => !room.current || !room.price)) return unknownPriceComparison({ price, rooms,
    reason: price.scope === 'whole_group' ? 'Fresh native Prepare prices are required for every room in this date group before Create Go.' :
      'A fresh native Prepare price is required for this room before comparison.', blocksGo: price.scope === 'whole_group' });
  const nativeCurrency = rooms.map((room) => currencyCode(room.price?.currency));
  if (nativeCurrency.some((currency) => !currency) || new Set(nativeCurrency).size !== 1) {
    return unknownPriceComparison({ price, rooms, reason: 'Native room currencies are missing or inconsistent; no conversion was assumed.', blocksGo: true });
  }
  const currency = nativeCurrency[0]!;
  const sumNative = (field: 'averageRate' | 'totalRate') => rooms.reduce<bigint | null>((sum, room) => {
    const value = parseMoney(room.price?.[field]);
    if (!value || value.currency && value.currency !== currency) return null;
    return sum === null ? null : sum + value.minor;
  }, 0n);
  const averageMinor = sumNative('averageRate'), totalMinor = sumNative('totalRate');
  const native = averageMinor === null || totalMinor === null ? null : {
    averageRate: price.scope === 'whole_group' ? moneyText(averageMinor) : rooms[0]!.price!.averageRate,
    totalRate: price.scope === 'whole_group' ? moneyText(totalMinor) : rooms[0]!.price!.totalRate,
    currency,
  };
  if (!native) return unknownPriceComparison({ price, rooms, reason: 'Native price values are not unambiguous decimal amounts.', blocksGo: true });
  const currencyCheck: PriceCheck = claimedCurrency === currency ? 'match' : 'mismatch';
  const compareAmount = (claim: ParsedMoney | null, actual: string | undefined): PriceCheck => {
    if (!claim) return 'not_requested';
    if (currencyCheck !== 'match' || !actual) return currencyCheck === 'mismatch' ? 'mismatch' : 'unknown';
    const nativeAmount = parseMoney(actual);
    if (!nativeAmount || nativeAmount.currency && nativeAmount.currency !== currency) return 'unknown';
    return claim.minor === nativeAmount.minor ? 'match' : 'mismatch';
  };
  let nightlyRateCheck = compareAmount(nightly, native.averageRate);
  if (nightly && hasExplicitPerRoomNightlyBasis(price)) {
    const perRoomChecks = new Set(rooms.map((room) => compareAmount(nightly, room.price?.averageRate)));
    nightlyRateCheck = perRoomChecks.has('mismatch') ? 'mismatch' :
      perRoomChecks.has('unknown') ? 'unknown' : 'match';
  }
  const checks = { nightlyRate: nightlyRateCheck, total: compareAmount(total, native.totalRate),
    currency: currencyCheck };
  const requestedChecks = new Set([checks.nightlyRate, checks.total, checks.currency]);
  const status = requestedChecks.has('mismatch') ? 'mismatch' : requestedChecks.has('unknown') ? 'unknown' : 'match';
  return { status, blocksGo: status !== 'match', scope: price.scope,
    ...(price.dateIndex !== undefined ? { dateIndex: price.dateIndex } : {}), requested, native, rooms, checks, sourceRefs,
    explanation: status === 'match' ? 'The fresh native HMS price matches the source-cited requested price.' :
      status === 'mismatch' ? 'The source price differs from the current native HMS price. Resolve the rate in HMS and refresh Prepare; numeric price overrides are not supported.' :
        'The source and native prices could not be compared safely; resolve in HMS and refresh Prepare.' };
}

/** Price currentness depends on native business values, not the staff review revision. */
export function reservationWorkflowV2PreparationViews(draft: ReservationWorkflowV2Draft, propertyCode: string) {
  return draft.proposal.content.requests.flatMap((request) => {
    if (request.kind !== 'create') return [];
    const body = effectiveSubtree(draft, request.body, ptr('proposal', 'content', 'requests', request.id, 'body')) as typeof request.body | null;
    if (!body || !Array.isArray(body.allocations)) return [];
    return body.allocations.map((allocation) => {
      const compiled = compileCreate(draft, request.id, allocation.id, propertyCode, 'prepare');
      const priceComparison = reservationWorkflowV2CreatePriceComparison(draft, request.id, allocation.id, propertyCode);
      if (compiled.outcome !== 'ok') return { requestId: request.id, allocationId: allocation.id,
        current: false, issue: compiled.issue, fields: compiled.fields ?? [], details: compiled.details ?? [], priceComparison };
      const prepared = preparedFor(draft, request.id, allocation.id, compiled.semanticDigest);
      return { requestId: request.id, allocationId: allocation.id, current: Boolean(prepared) && !priceComparison.blocksGo,
        ...(prepared ? { price: prepared.price, observedAt: prepared.observation.observedAt } : {}), priceComparison };
    });
  });
}

function nativeReadbackPrice(fields: unknown): { averageRate: string; totalRate: string; currency: string } | null {
  if (!Array.isArray(fields)) return null;
  const value = (name: string) => {
    const found = fields.filter((field) => record(field)?.name === name);
    const raw = found.length === 1 ? record(found[0])?.value : undefined;
    return typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  };
  const normalizeCurrency = (raw: string) => raw.toUpperCase() === 'R' ? 'ZAR' : raw.toUpperCase();
  const averageRate = value('averagerate'), totalRate = value('totalrate');
  const currencies = [value('averageratecurr'), value('totalratecurr'), value('currency')].filter(Boolean).map(normalizeCurrency);
  if (!currencies.length && [averageRate, totalRate].every((amount) => /^(?:R|ZAR)\s*\d/i.test(amount) || /\bZAR$/i.test(amount))) {
    currencies.push('ZAR');
  }
  if (!averageRate || !totalRate || !currencies.length || new Set(currencies).size !== 1) return null;
  return { averageRate, totalRate, currency: currencies[0]! };
}

function moneyEqual(left: string, right: string): boolean {
  const leftAmount = parseMoney(left), rightAmount = parseMoney(right);
  return Boolean(leftAmount && rightAmount && leftAmount.minor === rightAmount.minor);
}

function priceMatches(actual: unknown, expected: { averageRate: string; totalRate: string; currency: string }) {
  const parsed = validPrice(actual);
  return Boolean(parsed && moneyEqual(parsed.averageRate, expected.averageRate) && moneyEqual(parsed.totalRate, expected.totalRate) &&
    currencyCode(parsed.currency) === currencyCode(expected.currency));
}

function stayExpected(compiled: Extract<CreateCompile, { outcome: 'ok' }>, binding: Record<string, unknown>) {
  const request = record(binding), stay = record(request?.stay), room = record(request?.room), guest = record(request?.guest);
  const nativeInput = compiled.nativeInput;
  const expectedStay = record(nativeInput.stay), expectedRoom = record(nativeInput.room), expectedGuest = compiled.expectedGuest;
  if (!stay || !room || !guest || !expectedStay || !expectedRoom) return false;
  return String(guest.nativeId) === String(record(nativeInput.guest)?.profileId) &&
    guest.firstName === expectedGuest.firstName && guest.lastName === expectedGuest.lastName &&
    stay.arrival === expectedStay.arrival && stay.departure === expectedStay.departure && stay.adults === expectedStay.adults &&
    canonicalJson(stay.childAges) === canonicalJson(expectedStay.childAges) &&
    room.roomType === expectedRoom.roomType && room.ratePlan === expectedRoom.ratePlan &&
    room.roomTypeForCharge === expectedRoom.roomTypeForCharge &&
    reservationWorkflowV2CreateMealPlanMatches(compiled.requestedMealPlan, compiled.mealPlan, room.mealPlan, String(nativeInput.propertyCode));
}

function nativeObservation(draft: ReservationWorkflowV2Draft, input: ReservationWorkflowV2ExecuteInput,
  native: NativeCreate, status: 'complete' | 'partial' | 'failed', result: Record<string, unknown>): ReservationWorkflowV2Observation {
  return { ref: randomUUID(), generationId: draft.generationId, kind: 'stay_candidate', status, observedAt: new Date().toISOString(),
    propertyCode: draft.propertyCode, sourceMessageId: draft.source.messageId, sourceRefs: [],
    criteria: { workflow: 'create', requestId: input.requestId, allocationId: input.allocationId ?? null,
      draftRevision: draft.revision, idempotencyKey: input.idempotencyKey },
    coverage: { complete: status === 'complete', notes: status === 'complete' ? [] : [String(native.issue ?? native.outcome ?? 'save_not_verified')] },
    result };
}

async function persistOperationResultInTransaction(tx: Parameters<Parameters<DB['transaction']>[0]>[0], ctx: ReservationWorkflowV2ServerContext,
  input: ReservationWorkflowV2ExecuteInput, observation: ReservationWorkflowV2Observation, summary: string) {
  await lockReservationActionClaim(tx, input.workItemId);
  await assertReservationActionFence(tx, input.workItemId);
  const [item] = await tx.select({ state: workItem.state, revision: workItem.revision, revisionSeq: workItem.revisionSeq })
    .from(workItem).where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, ctx.transport.id))).limit(1).for('update');
  const draft = item && reservationWorkflowV2DraftOf(item.state as Record<string, unknown>);
  if (!draft || draft.source.sourceHash !== input.source.sourceHash || draft.revision !== input.expectedRevision ||
      item?.revisionSeq !== input.expectedSeq || draft.propertyCode !== ctx.property.propertyCode) {
    throw new Error('reservation_workflow_v2_result_scope_changed');
  }
  if (!draft.observations.some((entry) => entry.ref === observation.ref)) {
    // The receipt and the durable dispatch resolution are one transaction.
    const existing = new Set(draft.observations.map((entry) => entry.ref));
    if (observation.sourceRefs.some((ref) => !existing.has(ref))) throw new Error('reservation_workflow_v2_result_scope_changed');
  }
  const observations = draft.observations.some((entry) => entry.ref === observation.ref)
    ? draft.observations : [...draft.observations, observation];
  const nextResult = { id: input.idempotencyKey, requestId: input.requestId, allocationId: input.allocationId ?? null,
    generationId: draft.generationId, workflow: 'create' as const, status: 'succeeded' as const, draftRevision: draft.revision,
    observationRefs: [observation.ref], updatedAt: new Date().toISOString(), summary };
  const operationResults = [...draft.operationResults.filter((entry) => entry.id !== nextResult.id), nextResult];
  const nextDraft = reservationWorkflowV2DraftSchema.parse({ ...draft, observations, operationResults });
  const state = withReservationWorkflowV2Draft(item ? item.state as Record<string, unknown> : {}, nextDraft);
  await tx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
  await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
    fieldPath: `reservationWorkflowV2:operationResults:${nextResult.id}`,
    value: { id: nextResult.id, requestId: nextResult.requestId, allocationId: nextResult.allocationId,
      workflow: 'create', status: nextResult.status, observationRefs: nextResult.observationRefs },
    evidence: { sourceHash: input.source.sourceHash, seq: input.expectedSeq, summary } });
}

/** A one-use native proof permits a failure receipt even if the email or access changed after the claim. */
async function persistNeverDispatchedCreate(tx: Parameters<Parameters<DB['transaction']>[0]>[0], ctx: ReservationWorkflowV2ServerContext,
  input: ReservationWorkflowV2ExecuteInput, intent: Readonly<HmsLabtestIntent>, generationId: string, approvedDigest: string) {
  await lockReservationActionClaim(tx, input.workItemId);
  await assertReservationActionFence(tx, input.workItemId);
  const [item] = await tx.select({ state: workItem.state }).from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, ctx.transport.id))).limit(1).for('update');
  const draft = item && reservationWorkflowV2DraftOf(item.state);
  const prior = draft?.operationResults.find((entry) => entry.id === input.idempotencyKey && entry.workflow === 'create' &&
    entry.requestId === input.requestId && entry.allocationId === input.allocationId && entry.status === 'unknown');
  if (!item || !draft || !prior || draft.workItemId !== input.workItemId || draft.transportId !== ctx.transport.id ||
      draft.propertyCode !== ctx.property.propertyCode || draft.generationId !== generationId ||
      draft.source.threadId !== input.source.threadId || draft.source.messageId !== input.source.messageId ||
      draft.source.sourceHash !== input.source.sourceHash || draft.source.arrivedAt !== input.source.arrivedAt ||
      intent.workItemId !== input.workItemId.toLowerCase() || intent.transportId !== ctx.transport.id ||
      intent.actorUserId !== ctx.user.id || intent.propertyCode !== ctx.property.propertyCode ||
      intent.grantId !== input.idempotencyKey.toLowerCase() || intent.stayId !== `${input.requestId}_${input.allocationId}` ||
      intent.sourceDigest !== input.source.sourceHash || intent.approvedDigest !== approvedDigest ||
      intent.recovery.requestId !== input.requestId || intent.recovery.allocationId !== input.allocationId ||
      intent.recovery.operationId !== input.idempotencyKey) {
    throw new Error('reservation_workflow_v2_never_dispatched_scope_changed');
  }
  const observation = nativeObservation(draft, input, { outcome: 'not_dispatched' }, 'failed', {
    issue: 'native_route_proved_save_never_dispatched', dispatchHoldId: intent.holdId,
  });
  const summary = 'Native route proved Save was never dispatched';
  const result = { ...prior, status: 'failed' as const, observationRefs: [observation.ref],
    updatedAt: new Date().toISOString(), summary };
  const nextDraft = reservationWorkflowV2DraftSchema.parse({ ...draft,
    observations: [...draft.observations, observation],
    operationResults: [...draft.operationResults.filter((entry) => entry.id !== prior.id), result] });
  await tx.update(workItem).set({ state: withReservationWorkflowV2Draft(item.state as Record<string, unknown>, nextDraft), updatedAt: new Date() })
    .where(eq(workItem.id, input.workItemId));
  await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
    fieldPath: `reservationWorkflowV2:operationResults:${prior.id}`,
    value: { id: prior.id, requestId: prior.requestId, allocationId: prior.allocationId,
      workflow: 'create', status: 'failed', observationRefs: [observation.ref] },
    evidence: { sourceHash: input.source.sourceHash, dispatchHoldId: intent.holdId, summary } });
}

async function authorizeCurrentCreate(tx: Parameters<Parameters<DB['transaction']>[0]>[0], ctx: ReservationWorkflowV2ServerContext,
  input: ReservationWorkflowV2ExecuteInput, expectedDigest: string, semanticDigest: string,
  requestId: string, allocationId: string, priorSiblings: VerifiedCreateSibling[],
  attempt: ReservationWorkflowV2Observation) {
  await lockReservationWorkflowV2Source(tx, ctx.transport.id, input.source.messageId);
  // Match the legacy writer's thread → message → WorkItem lock order.
  const [thread] = await tx.select({ id: mailThread.id }).from(mailThread)
    .where(and(eq(mailThread.id, input.source.threadId), eq(mailThread.transportId, ctx.transport.id),
      eq(mailThread.historyOnly, false), isNull(mailThread.trashedAt), isNull(mailThread.spamAt))).limit(1).for('share');
  const [source] = await tx.select({ id: message.id, threadId: message.threadId, transportId: message.transportId,
    direction: message.direction, historyOnly: message.historyOnly, sourceProvenance: message.sourceProvenance,
    subject: message.subject, textBody: message.textBody, htmlBody: message.htmlBody })
    .from(message).where(and(eq(message.id, input.source.messageId), eq(message.threadId, input.source.threadId),
      eq(message.transportId, ctx.transport.id), eq(message.direction, 'inbound'), eq(message.historyOnly, false)))
    .limit(1).for('share');
  const items = await tx.select({ id: workItem.id, state: workItem.state, revision: workItem.revision,
    revisionSeq: workItem.revisionSeq, sourceMessageId: workItem.sourceMessageId, threadId: workItem.threadId })
    .from(workItem).where(and(eq(workItem.transportId, ctx.transport.id), eq(workItem.threadId, input.source.threadId),
      eq(workItem.sourceMessageId, input.source.messageId))).orderBy(workItem.id).for('update');
  const item = items.find((entry) => entry.id === input.workItemId);
  const draft = item && reservationWorkflowV2DraftOf(item.state as Record<string, unknown>);
  if (items.some((entry) => Object.keys(stayCommitsOf(entry.state)).length > 0)) {
    throw new Error('reservation_workflow_v2_legacy_create_requires_review');
  }
  if (!item || !draft || item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq ||
      item.sourceMessageId !== input.source.messageId || item.threadId !== input.source.threadId ||
      draft.revision !== input.expectedRevision || draft.propertyCode !== ctx.property.propertyCode ||
      draft.workItemId !== input.workItemId || draft.transportId !== ctx.transport.id ||
      draft.source.threadId !== input.source.threadId || draft.source.messageId !== input.source.messageId ||
      draft.source.sourceHash !== input.source.sourceHash || draft.source.arrivedAt !== input.source.arrivedAt ||
      draft.generationId !== attempt.generationId) {
    throw new Error('reservation_workflow_v2_create_stale');
  }
  const [access] = await tx.select({ id: mailboxAccess.id }).from(mailboxAccess)
    .where(and(eq(mailboxAccess.userId, ctx.user.id), eq(mailboxAccess.transportId, ctx.transport.id))).limit(1).for('share');
  const current = source && staffQuoteSourceHash(source);
  const compiled = compileCreate(draft, requestId, allocationId, ctx.property.propertyCode, 'execute');
  const admission = compiled.outcome === 'ok' ? createDispatchAdmission(compiled) : null;
  const prepared = preparedFor(draft, requestId, allocationId, compiled.outcome === 'ok' ? compiled.semanticDigest : undefined);
  const operation = draft.operationResults.find((result) => result.id === input.idempotencyKey);
  const competingOperation = draft.operationResults.some((result) =>
    result.requestId === requestId && result.allocationId === allocationId && result.workflow === 'create' &&
    (result.status === 'succeeded' || result.status === 'unknown'));
  if (!thread || !access || !source || source.sourceProvenance?.attention != null || current !== input.source.sourceHash ||
      compiled.outcome !== 'ok' || !admission?.allowed || competingOperation ||
      compiled.semanticDigest !== semanticDigest || !prepared || prepared.digest !== expectedDigest ||
      !nativeInputMatchesBinding(compiled, prepared.request) || operation ||
      draft.observations.some((entry) => entry.ref === attempt.ref)) {
    throw new Error('reservation_workflow_v2_create_source_changed');
  }
  if (priorSiblings.length) {
    const receipts = await readResolvedHmsLabtestCreates(tx, input.workItemId);
    const siblingEvidenceValid = priorSiblings.every((sibling) => {
      const prior = draft.operationResults.find((result) => result.id === sibling.operationId && result.status === 'succeeded' &&
        result.workflow === 'create' && result.requestId === requestId && result.allocationId === sibling.allocationId);
      const matches = receipts.filter((receipt) => siblingReceiptMatches(receipt, sibling, ctx, input));
      const success = prior && matches.length === 1 && siblingSuccessObservation(draft, prior, matches[0]!, sibling.requestDigest);
      const preparedSibling = draft.observations.some((entry) => {
        const binding = record(record(entry.result)?.requestBinding);
        return entry.kind === 'rate_availability' && entry.status === 'complete' && entry.criteria.workflow === 'create' &&
          entry.criteria.requestId === requestId && entry.criteria.allocationId === sibling.allocationId &&
          binding?.digest === sibling.requestDigest && canonicalJson(binding.request) === canonicalJson(sibling.approvedRequest);
      });
      return Boolean(success && preparedSibling);
    });
    if (!siblingEvidenceValid) throw new Error('reservation_workflow_v2_create_prior_room_changed');
  }
  await lockCreateActorSession(tx, { actorUserId: ctx.user.id, sessionId: ctx.user.sessionId,
    sessionProfile: ctx.user.sessionProfile });
  // Claim intent and pending receipt must commit together. A crash cannot leave
  // an unknown result with no dispatch history to reconcile.
  const result = { id: input.idempotencyKey, generationId: draft.generationId, requestId, allocationId,
    workflow: 'create' as const, status: 'unknown' as const, draftRevision: draft.revision,
    observationRefs: [attempt.ref], updatedAt: new Date().toISOString(), summary: 'Native Create claimed; outcome pending reconciliation' };
  const nextDraft = reservationWorkflowV2DraftSchema.parse({ ...draft,
    observations: [...draft.observations, attempt], operationResults: [...draft.operationResults, result] });
  await tx.update(workItem).set({ state: withReservationWorkflowV2Draft(item.state as Record<string, unknown>, nextDraft), updatedAt: new Date() })
    .where(eq(workItem.id, input.workItemId));
  await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
    fieldPath: `reservationWorkflowV2:operationResults:${result.id}`,
    value: { id: result.id, requestId, allocationId, workflow: 'create', status: result.status,
      observationRefs: result.observationRefs },
    evidence: { sourceHash: input.source.sourceHash, seq: input.expectedSeq, summary: result.summary } });
}

function nativeInputMatchesBinding(compiled: Extract<CreateCompile, { outcome: 'ok' }>, request: unknown,
  options: { ignoreBookerContact?: boolean } = {}): boolean {
  const bound = record(request);
  if (!bound || !stayExpected(compiled, bound)) return false;
  const input = compiled.nativeInput, parties = record(input.parties), boundParties = record(bound.parties);
  if (options.ignoreBookerContact &&
      ((input.sourceOfBusiness === undefined && bound.sourceOfBusiness != null) ||
       (input.reasonForStay === undefined && bound.reasonForStay != null) ||
       (input.billingReference === undefined && bound.billingReference != null) ||
       (input.taCommission === undefined && bound.nativeCommissionPercent != null) ||
       (input.track === undefined && bound.track != null) ||
       (input.marketSegment === undefined && bound.marketSegment != null) ||
       (input.guestoptin4 === undefined && bound.guestOptIn != null) ||
       (input.cms === undefined && (bound.cmsMessageId != null || bound.cmsRecipient != null)))) return false;
  for (const [key, id, name] of [
    ['agency', 'agencyId', 'agencyName'], ['organization', 'organizationId', 'organizationName'],
    ['arAccount', 'arAccountId', 'arAccountName'],
  ] as const) {
    const expectedId = parties?.[id], expectedName = parties?.[name];
    const actual = record(boundParties?.[key]) ?? record(boundParties?.[key === 'agency' ? 'bookingAgency' : key]);
    if ((expectedId != null || expectedName != null) && (!actual || String(actual.nativeId) !== String(expectedId) ||
        !sameName(actual.name, expectedName))) return false;
    if (expectedId == null && expectedName == null && actual) return false;
  }
  return bound.propertyCode === input.propertyCode && bound.guaranteeType === input.guaranteeType &&
    (input.sourceOfBusiness === undefined || sameName(record(bound.sourceOfBusiness)?.nativeCode, input.sourceOfBusiness) ||
      sameName(record(bound.sourceOfBusiness)?.description, input.sourceOfBusiness)) &&
    (input.reasonForStay === undefined || sameName(record(bound.reasonForStay)?.value, input.reasonForStay) ||
      sameName(record(bound.reasonForStay)?.display, input.reasonForStay)) &&
    (input.note === undefined || bound.note === input.note) &&
    (input.billingReference === undefined || bound.billingReference === input.billingReference) &&
    (input.taCommission === undefined ? bound.nativeCommissionPercent == null : bound.nativeCommissionPercent === input.taCommission) &&
    (input.track === undefined || input.track === record(bound.track)?.lookupCode || input.track === record(bound.track)?.display) &&
    (input.marketSegment === undefined ? bound.marketSegment == null : input.marketSegment === record(bound.marketSegment)?.value) &&
    (input.guestoptin4 === undefined || bound.guestOptIn === input.guestoptin4) &&
    (options.ignoreBookerContact
      ? canonicalJson(withoutBookerContact(bound.booker)) === canonicalJson(withoutBookerContact(input.booker))
      : input.booker === undefined || canonicalJson(bound.booker) === canonicalJson(input.booker)) &&
    (input.cms === undefined || (record(bound.sendHmsConfirmation)?.kind === (record(input.cms)?.send === true ? 'send' : 'never') &&
      (record(input.cms)?.send !== true || (bound.cmsMessageId === record(input.cms)?.messageId &&
        bound.cmsRecipient === record(input.cms)?.recipient))));
}

function withoutBookerContact(value: unknown): Record<string, unknown> | undefined {
  const booker = record(value);
  if (!booker) return undefined;
  const { contact: _contact, ...identity } = booker;
  return Object.keys(identity).length ? identity : undefined;
}

function validSavedPriceShot(value: unknown): boolean {
  const shot = record(value);
  return Boolean(shot && typeof shot.runId === 'string' && typeof shot.sha256 === 'string' && /^[a-f0-9]{64}$/.test(shot.sha256));
}

/** A completed room may use only the price from its exact verified Save/readback receipt. */
function savedCreateNativePrice(draft: ReservationWorkflowV2Draft, requestId: string, allocationId: string,
  compiled: CreateCompile): { completed: boolean; price: ReturnType<typeof nativeReadbackPrice> } {
  const operations = draft.operationResults.filter((entry) => entry.workflow === 'create' && entry.requestId === requestId &&
    entry.allocationId === allocationId && (entry.status === 'succeeded' || entry.status === 'unknown'));
  if (!operations.length) return { completed: false, price: null };
  const successes = operations.filter((entry) => entry.status === 'succeeded');
  if (compiled.outcome !== 'ok' || operations.some((entry) => entry.status === 'unknown' ||
      entry.generationId !== draft.generationId) || successes.length !== 1) return { completed: true, price: null };
  const operation = successes[0]!;
  if (operation.observationRefs.length !== 1) return { completed: true, price: null };
  const observations = draft.observations.filter((entry) => operation.observationRefs.includes(entry.ref));
  if (observations.length !== 1) return { completed: true, price: null };
  const observation = observations[0]!, result = record(observation.result);
  if (!result) return { completed: true, price: null };
  const confirmation = result.confirmation;
  if (observation.kind !== 'stay_candidate' || observation.status !== 'complete' || !observation.coverage.complete ||
      observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode ||
      observation.sourceMessageId !== draft.source.messageId || observation.criteria.workflow !== 'create' ||
      observation.criteria.requestId !== requestId || observation.criteria.allocationId !== allocationId ||
      observation.criteria.draftRevision !== operation.draftRevision || typeof confirmation !== 'string' ||
      !/^\d{6,10}-\d{1,2}$/.test(confirmation)) return { completed: true, price: null };

  const readback = record(result.nativeReadback);
  const price = nativeReadbackPrice(readback?.fields);
  const expectedPrice = validPrice(result.ratePlanAvailability);
  if (!readback || !Array.isArray(readback.mismatches) || readback.mismatches.length !== 0 || !price ||
      !expectedPrice || !priceMatches(price, expectedPrice) || !validSavedPriceShot(result.savedShot)) {
    return { completed: true, price: null };
  }

  let prepareObservationRef: string | null = null;
  let recoveredRequestBinding: Record<string, unknown> | null = null;
  let recoveredApprovedDigest: string | null = null;
  if (observation.criteria.recovered === true) {
    // Recovery appends the independently verified confirmation after hashing the native readback.
    const { confirmation: readbackConfirmation, ...recoveryReadback } = readback;
    if (observation.criteria.operationId !== operation.id || observation.criteria.sourceHash !== draft.source.sourceHash ||
        readbackConfirmation !== confirmation || result.readbackDigest !== sha256(recoveryReadback)) {
      return { completed: true, price: null };
    }
    const attempts = draft.observations.filter((entry) => {
      const attempt = record(entry.result);
      return entry.kind === 'stay_candidate' && entry.status === 'partial' && entry.generationId === draft.generationId &&
        entry.propertyCode === draft.propertyCode && entry.sourceMessageId === draft.source.messageId &&
        entry.criteria.workflow === 'create' && entry.criteria.requestId === requestId &&
        entry.criteria.allocationId === allocationId && entry.criteria.draftRevision === operation.draftRevision &&
        entry.criteria.idempotencyKey === operation.id && attempt?.requestBinding && attempt.prepareObservationRef &&
        attempt.approvedDigest && attempt.expectedRateAvailability;
    });
    const refs = [...new Set(attempts.map((entry) => text(record(entry.result)?.prepareObservationRef)).filter(Boolean))];
    const holdIds = [...new Set(attempts.map((entry) => text(record(entry.result)?.dispatchHoldId)).filter(Boolean))];
    // Dispatch markers carry the raw request; approvedDigest binds it to Prepare's wrapped binding.
    const binding = record(record(attempts[0]?.result)?.requestBinding);
    const approvedDigests = [...new Set(attempts.map((entry) => text(record(entry.result)?.approvedDigest)).filter(Boolean))];
    if (!attempts.length || refs.length !== 1 || holdIds.length !== 1 || !binding || approvedDigests.length !== 1 ||
        !/^[a-f0-9]{64}$/.test(approvedDigests[0]!) ||
        attempts.some((entry) => {
          const attempt = record(entry.result), candidate = record(attempt?.requestBinding);
          return !candidate || attempt?.approvedDigest !== approvedDigests[0] ||
            attempt?.prepareObservationRef !== refs[0] || canonicalJson(candidate) !== canonicalJson(binding) ||
            !priceMatches(attempt?.expectedRateAvailability, expectedPrice);
        })) return { completed: true, price: null };
    prepareObservationRef = refs[0]!;
    recoveredRequestBinding = binding;
    recoveredApprovedDigest = approvedDigests[0]!;
  } else {
    const savedPrice = validPrice(result.savedPrice);
    if (observation.criteria.idempotencyKey !== operation.id || result.priceMatched !== true ||
        typeof result.prepareObservationRef !== 'string' || typeof result.requestDigest !== 'string' ||
        !text(result.dispatchHoldId) || !savedPrice || !priceMatches(savedPrice, price)) {
      return { completed: true, price: null };
    }
    prepareObservationRef = result.prepareObservationRef;
  }

  const prepared = draft.observations.filter((entry) => entry.ref === prepareObservationRef);
  if (prepared.length !== 1) return { completed: true, price: null };
  const preparedObservation = prepared[0]!, preparedResult = record(preparedObservation.result);
  const binding = record(preparedResult?.requestBinding), boundRequest = record(binding?.request);
  const preparedPrice = validPrice(preparedResult?.ratePlanAvailability);
  if (preparedObservation.kind !== 'rate_availability' || preparedObservation.status !== 'complete' ||
      !preparedObservation.coverage.complete || preparedObservation.generationId !== draft.generationId ||
      preparedObservation.propertyCode !== draft.propertyCode || preparedObservation.sourceMessageId !== draft.source.messageId ||
      preparedObservation.criteria.workflow !== 'create' || preparedObservation.criteria.requestId !== requestId ||
      preparedObservation.criteria.allocationId !== allocationId ||
      typeof preparedObservation.criteria.draftRevision !== 'number' ||
      preparedObservation.criteria.draftRevision > operation.draftRevision || !binding || !boundRequest ||
      typeof binding.digest !== 'string' || !/^[a-f0-9]{64}$/.test(binding.digest) ||
      (recoveredRequestBinding !== null && (canonicalJson(recoveredRequestBinding) !== canonicalJson(boundRequest) ||
        recoveredApprovedDigest !== binding.digest)) ||
      preparedObservation.criteria.requestDigest !== binding.digest || !preparedPrice || !priceMatches(price, preparedPrice) ||
      !nativeInputMatchesBinding(compiled, boundRequest, { ignoreBookerContact: true })) {
    return { completed: true, price: null };
  }
  if (observation.criteria.recovered !== true && result.requestDigest !== binding.digest) {
    return { completed: true, price: null };
  }
  return { completed: true, price };
}

function resultForId(draft: ReservationWorkflowV2Draft, id: string) {
  return draft.operationResults.find((entry) => entry.id === id);
}

type VerifiedCreateSibling = {
  operationId: string; allocationId: string; stayId: string; nativeGuestId: string;
  confirmation: string; requestDigest: string; approvedRequest: Record<string, unknown>;
};

type ResolvedCreateReceipt = Awaited<ReturnType<typeof readResolvedHmsLabtestCreates>>[number];
type CreateOperation = ReservationWorkflowV2Draft['operationResults'][number];

function siblingReceiptMatches(receipt: ResolvedCreateReceipt, sibling: VerifiedCreateSibling,
  ctx: ReservationWorkflowV2ServerContext, input: ReservationWorkflowV2ExecuteInput): boolean {
  const { intent, resolution } = receipt;
  return intent.transportId === ctx.transport.id && intent.propertyCode === ctx.property.propertyCode &&
    intent.actorUserId === ctx.user.id && intent.grantId === sibling.operationId.toLowerCase() &&
    intent.stayId === sibling.stayId && intent.nativeGuestId === sibling.nativeGuestId &&
    intent.sourceDigest === input.source.sourceHash && intent.approvedDigest === sibling.requestDigest &&
    intent.recovery.requestId === input.requestId && intent.recovery.allocationId === sibling.allocationId &&
    intent.recovery.operationId === sibling.operationId &&
    canonicalJson(intent.recovery.request) === canonicalJson(sibling.approvedRequest) &&
    resolution.confirmation === sibling.confirmation;
}

function siblingSuccessObservation(draft: ReservationWorkflowV2Draft, operation: CreateOperation,
  receipt: ResolvedCreateReceipt, requestDigest: string): ReservationWorkflowV2Observation | undefined {
  return draft.observations.find((entry) => {
    if (!operation.observationRefs.includes(entry.ref) || entry.kind !== 'stay_candidate' || entry.status !== 'complete' ||
        !entry.coverage.complete || entry.generationId !== draft.generationId || entry.propertyCode !== draft.propertyCode ||
        entry.sourceMessageId !== draft.source.messageId || entry.criteria.workflow !== 'create' ||
        entry.criteria.requestId !== operation.requestId || entry.criteria.allocationId !== operation.allocationId ||
        record(entry.result)?.confirmation !== receipt.resolution.confirmation) return false;
    if (!receipt.resolution.recovered) return entry.criteria.idempotencyKey === operation.id &&
      record(entry.result)?.requestDigest === requestDigest;
    const result = record(entry.result);
    const observedReadback = record(result?.nativeReadback), resolvedReadback = record(receipt.resolution.nativeReadback);
    return entry.criteria.recovered === true && entry.criteria.operationId === operation.id &&
      Boolean(observedReadback && resolvedReadback && observedReadback.confirmation === receipt.resolution.confirmation) &&
      result?.readbackDigest === receipt.resolution.readbackDigest &&
      canonicalJson(result?.savedShot) === canonicalJson(receipt.resolution.savedShot) &&
      canonicalJson(observedReadback) === canonicalJson(resolvedReadback);
  });
}

/** Earlier successful rooms may clear a same-name/arrival census only after fresh record and party readback. */
async function verifiedEarlierCreateSiblings(ctx: ReservationWorkflowV2ServerContext, draft: ReservationWorkflowV2Draft,
  input: ReservationWorkflowV2ExecuteInput, compiled: Extract<CreateCompile, { outcome: 'ok' }>):
  Promise<{ siblings: VerifiedCreateSibling[]; issue?: string }> {
  const currentGuestId = text(record(compiled.nativeInput.guest)?.profileId);
  const currentStay = record(compiled.nativeInput.stay);
  if (!currentGuestId || !currentStay) return { siblings: [] };
  const operations = draft.operationResults.filter((operation) => operation.workflow === 'create' &&
    operation.status === 'succeeded' && operation.requestId === input.requestId &&
    operation.allocationId != null && operation.allocationId !== input.allocationId);
  if (!operations.length) return { siblings: [] };
  let completed: ResolvedCreateReceipt[];
  try { completed = await ctx.db.transaction((tx) => readResolvedHmsLabtestCreates(tx, input.workItemId)); }
  catch { return { siblings: [], issue: 'create_prior_room_receipt_unavailable' }; }
  const candidates: VerifiedCreateSibling[] = [];
  for (const operation of operations) {
    if (!operation.allocationId) continue;
    const receipts = completed.filter(({ intent }) => intent.transportId === ctx.transport.id &&
      intent.actorUserId === ctx.user.id && intent.grantId === operation.id.toLowerCase() &&
      intent.stayId === `${input.requestId}_${operation.allocationId}` && intent.sourceDigest === input.source.sourceHash &&
      intent.recovery.requestId === input.requestId && intent.recovery.allocationId === operation.allocationId &&
      intent.recovery.operationId === operation.id);
    if (receipts.length !== 1) continue;
    const receipt = receipts[0]!, requestDigest = receipt.intent.approvedDigest, confirmation = receipt.resolution.confirmation;
    if (!siblingSuccessObservation(draft, operation, receipt, requestDigest)) continue;
    const preparedObservation = [...draft.observations].reverse().find((entry) => {
      const binding = record(record(entry.result)?.requestBinding);
      return entry.kind === 'rate_availability' && entry.status === 'complete' && entry.criteria.workflow === 'create' &&
        entry.criteria.requestId === input.requestId && entry.criteria.allocationId === operation.allocationId &&
        binding?.digest === requestDigest;
    });
    const binding = preparedObservation && record(record(preparedObservation.result)?.requestBinding);
    const approvedRequest = record(binding?.request);
    const approvedGuest = record(approvedRequest?.guest), approvedStay = record(approvedRequest?.stay);
    if (!approvedRequest || !approvedGuest || !approvedStay || approvedGuest.nativeId == null ||
        !/^\d+$/.test(String(approvedGuest.nativeId)) || !sameName(approvedGuest.firstName, compiled.expectedGuest.firstName) ||
        !sameName(approvedGuest.lastName, compiled.expectedGuest.lastName) || approvedStay.arrival !== currentStay.arrival) continue;
    const candidate = { operationId: operation.id, allocationId: operation.allocationId,
      stayId: `${input.requestId}_${operation.allocationId}`, nativeGuestId: String(approvedGuest.nativeId),
      confirmation, requestDigest, approvedRequest };
    if (!siblingReceiptMatches(receipt, candidate, ctx, input)) return { siblings: [], issue: 'create_prior_room_receipt_unverified' };
    candidates.push(candidate);
  }
  if (!candidates.length) return { siblings: [] };
  if (new Set(candidates.map((sibling) => sibling.confirmation)).size !== candidates.length) {
    return { siblings: [], issue: 'create_prior_room_confirmation_ambiguous' };
  }
  return { siblings: candidates };
}

/** Commit a reviewed native Create using one Go-bound durable target claim. */
export async function reservationWorkflowV2Execute(ctx: ReservationWorkflowV2ServerContext,
  input: ReservationWorkflowV2ExecuteInput): Promise<Outcome> {
  if (!input.allocationId) return { status: 'needs_input', issue: 'allocation_required' };
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return loaded.result;
  const prior = resultForId(loaded.draft, input.idempotencyKey);
  if (prior?.status === 'succeeded') return { status: 'succeeded', operationId: prior.id,
    summary: prior.summary, observationRefs: prior.observationRefs };
  if (prior?.status === 'failed') return { status: 'failed', operationId: prior.id, summary: prior.summary };
  const roomResult = [...loaded.draft.operationResults].reverse().find((entry) => entry.requestId === input.requestId &&
    entry.allocationId === input.allocationId && entry.workflow === 'create' &&
    (entry.status === 'succeeded' || entry.status === 'unknown'));
  if (roomResult?.status === 'succeeded') return { status: 'already_succeeded', operationId: roomResult.id,
    summary: roomResult.summary, observationRefs: roomResult.observationRefs };
  if (prior?.status === 'unknown' || roomResult?.status === 'unknown') {
    return { status: 'needs_reconcile', operationId: roomResult?.id ?? prior!.id };
  }
  const compiled = compileCreate(loaded.draft, input.requestId, input.allocationId, ctx.property.propertyCode, 'execute');
  if (compiled.outcome !== 'ok') return { status: compiled.outcome, outcomeClass: 'needs_input', issue: compiled.issue,
    fields: compiled.fields ?? [], details: compiled.details ?? [], readiness: createReadiness(loaded.draft, input.requestId, 'execute') };
  const policyIssue = await createPolicyIssue(ctx, compiled.nativeInput);
  if (policyIssue) return { status: 'needs_input', issue: policyIssue };
  const admission = createDispatchAdmission(compiled);
  if (!admission.allowed) return { status: 'refused', issue: admission.issue };
  if (!ctx.user.sessionId || !ctx.user.sessionProfile) return { status: 'refused', issue: 'authenticated_staff_session_required' };
  const prepared = preparedFor(loaded.draft, input.requestId, input.allocationId, compiled.semanticDigest);
  if (!prepared || !prepared.prepareShot || prepared.result.draftRevision > input.expectedRevision ||
      !nativeInputMatchesBinding(compiled, prepared.request)) {
    return { status: 'needs_prepare', issue: 'prepared_create_or_price_is_stale' };
  }
  const targetResult = hmsDispatchTargetSchema.safeParse(compiled.target);
  if (!targetResult.success || targetResult.data.kind !== 'create') return { status: 'needs_input', issue: 'create_target_invalid' };
  const propertyTarget = paneStayCreateTarget({ transportId: ctx.transport.id, propertyCode: ctx.property.propertyCode });
  if (!propertyTarget.ok || propertyTarget.target.propertyCode !== ctx.property.propertyCode) {
    return { status: 'unsupported', issue: 'create_property_session_unavailable' };
  }
  const targetLock = paneStayCloudTargetLock(propertyTarget.target, targetResult.data, { kind: 'independent_cloud' });
  if (!targetLock) return { status: 'needs_reconcile', issue: 'create_target_lock_unavailable' };
  const siblingResult = await verifiedEarlierCreateSiblings(ctx, loaded.draft, input, compiled);
  if (siblingResult.issue) return { status: 'needs_reconcile', issue: siblingResult.issue };
  const priorSiblings = siblingResult.siblings;
  let expectedEpoch: string;
  try { expectedEpoch = await captureHmsLabtestDispatchEpoch(ctx.db, targetResult.data, input.workItemId); }
  catch { return { status: 'needs_reconcile', issue: 'create_dispatch_history_unavailable' }; }
  const nativeModule = await import(new URL('../../tooling/hms-cloud/create-reservation.mjs', import.meta.url).href) as {
    createReservation: (input: Record<string, unknown>, options: Record<string, unknown>) => Promise<NativeCreate>;
  };
  const siblingVerifier = priorSiblings.length ? await import(new URL('../../tooling/hms-cloud/batch-sibling-readback.mjs', import.meta.url).href) as {
    censusMatchesApprovedSiblings: (census: unknown, siblings: NonNullable<ReservationWorkflowV2ServerContext['verifiedBatchSiblings']>,
      options: Record<string, unknown>) => boolean;
  } : null;
  if (priorSiblings.length && (!ctx.verifiedBatchSiblings || priorSiblings.some(sibling =>
      !ctx.verifiedBatchSiblings!.some(proved => proved.confirmation === sibling.confirmation && proved.requestDigest === sibling.requestDigest)))) {
    return { status: 'needs_reconcile', issue: 'create_prior_room_fresh_proof_missing' };
  }
  const nativeInput: Record<string, unknown> = { ...compiled.nativeInput, mode: 'commit' };
  let dispatchHandle: HmsLabtestWriteHandle | null = null;
  let releaseProvedNeverDispatched = false;
  let claimIssue: string | null = null;
  let priorSiblingsVerified = false;
  let lockSignal: AbortSignal | undefined;
  const liveOptions: Record<string, unknown> = {
    allowRealGuest: admission.allowRealGuest, expectedGuest: compiled.expectedGuest,
    cloudTargetKey: createCloudTargetKey(compiled.expectedGuest, record(compiled.nativeInput.stay)?.arrival),
    expectedRequestDigest: prepared.digest, expectedRateAvailability: prepared.price,
    ...(prepared.arAccountProfileId ? { expectedArProfileId: prepared.arAccountProfileId } : {}),
    allowCommitOnlyBillingReference: true,
    ...(siblingVerifier ? { verifyLabtestMatches: async (census: unknown) => {
      priorSiblingsVerified = siblingVerifier.censusMatchesApprovedSiblings(census, ctx.verifiedBatchSiblings!,
        { propertyCode: ctx.property.propertyCode });
      return priorSiblingsVerified;
    } } : {}),
    authorizeCandidate: async () => {
      if (lockSignal?.aborted) return false;
      const current = await currentDraft(ctx, input);
      if (!current.draft) return false;
      const live = compileCreate(current.draft, input.requestId, input.allocationId!, ctx.property.propertyCode, 'execute');
      const liveAdmission = live.outcome === 'ok' ? createDispatchAdmission(live) : null;
      const livePrepared = live.outcome === 'ok' && preparedFor(current.draft, input.requestId,
        input.allocationId!, live.semanticDigest);
      return live.outcome === 'ok' && liveAdmission?.allowed === true && live.semanticDigest === compiled.semanticDigest &&
        Boolean(livePrepared && livePrepared.digest === prepared.digest && priceMatches(livePrepared.price, prepared.price) &&
          nativeInputMatchesBinding(live, livePrepared.request));
    },
    dispatchCandidate: async (request: unknown, next: NativeContinuation, evidence: unknown) => {
      lockSignal?.throwIfAborted();
      const requestDigest = nativeCreateSaveDigest(request);
      if (!nativeInputMatchesBinding(compiled, prepared.request)) throw new Error('reservation_v2_native_binding_changed');
      const event = record(evidence), beforePath = event?.beforeScreenshot, preimage = record(event?.preimage);
      if (priorSiblings.length) {
        const sameArrival = Array.isArray(preimage?.sameArrival) ? preimage.sameArrival.map(record)
          .filter((row): row is Record<string, unknown> => row !== null) : [];
        const blockingMatches = blockingCreateMatches(sameArrival);
        if (!priorSiblingsVerified || preimage?.verifiedExisting !== true || blockingMatches.length !== priorSiblings.length ||
            priorSiblings.some((sibling) => !blockingMatches.some((row) => row.confirmation === sibling.confirmation))) {
          throw new Error('reservation_workflow_v2_prior_rooms_unverified');
        }
      }
      const beforeShot = await persistBeforeScreenshot(ctx, input.workItemId, beforePath);
      const previewShot = prepared.prepareShot && await staffOwnedPrepareShot(ctx, loaded.draft, input.workItemId,
        { runId: String(prepared.prepareShot.runId), sha256: String(prepared.prepareShot.sha256) });
      if (!beforeShot || !preimage || !previewShot || typeof event?.guaranteeDisplay !== 'string') {
        throw new Error('reservation_v2_create_recovery_evidence_missing');
      }
      const attempt = nativeObservation(loaded.draft, input, { outcome: 'dispatch_pending' }, 'partial', {
        requestDigest, approvedDigest: prepared.digest, requestBinding: prepared.request,
        expectedRateAvailability: prepared.price, prepareObservationRef: prepared.observation.ref,
        beforeShot, preimage, idempotencyKey: input.idempotencyKey,
        priorRoomConfirmations: priorSiblings.map(({ confirmation, requestDigest }) => ({ confirmation, requestDigest })),
      });
      let dispatch: HmsLabtestWriteHandle | null = null;
      try {
        dispatch = await claimHmsLabtestDispatch(ctx.db, {
          workItemId: input.workItemId, transportId: ctx.transport.id, actorUserId: ctx.user.id,
          grantId: input.idempotencyKey, propertyCode: targetResult.data.propertyCode, firstName: compiled.expectedGuest.firstName,
          lastName: compiled.expectedGuest.lastName, target: targetResult.data, nativeGuestId: String(record(nativeInput.guest)?.profileId),
          operation: 'create', stayId: `${input.requestId}_${input.allocationId}`,
          sourceDigest: input.source.sourceHash, approvedDigest: prepared.digest, requestDigest,
          recovery: { request: prepared.request, requestId: input.requestId, allocationId: input.allocationId,
            operationId: input.idempotencyKey, draftRevision: input.expectedRevision,
            previewShot, beforeShot, preimage, guaranteeDisplay: event.guaranteeDisplay,
            ratePlanAvailability: prepared.price, arAccountProfileId: prepared.arAccountProfileId,
            priorRoomConfirmations: priorSiblings.map(({ confirmation, requestDigest }) => ({ confirmation, requestDigest })) },
        }, async (tx) => {
          if (!ctx.writeRunFence) throw new Error('staff_go_required');
          await consumeStaffGoAtDispatch(tx, ctx.writeRunFence, lockSignal, input.allocationId);
          await authorizeCurrentCreate(tx, ctx, input, prepared.digest, compiled.semanticDigest,
            input.requestId, input.allocationId!, priorSiblings, attempt);
        }, expectedEpoch);
      } catch (error) {
        if (error instanceof HmsLabtestDispatchError && error.reason === 'occupied') {
          claimIssue = 'create_target_held_for_reconciliation';
        }
        // An ambiguous commit may have persisted the intent and pending result;
        // never overwrite that evidence with an unproven failed result.
        throw error;
      }
      dispatchHandle = dispatch;
      const claimed = nativeObservation(loaded.draft, input, { outcome: 'dispatching' }, 'partial', {
        dispatchHoldId: dispatch.holdId, requestDigest, approvedDigest: prepared.digest,
        requestBinding: prepared.request, expectedRateAvailability: prepared.price,
        prepareObservationRef: prepared.observation.ref,
      });
      const claimRecorded = await recordNativeObservation(ctx, input, claimed, 'unknown', 'Native Create claimed; outcome pending reconciliation',
        input.idempotencyKey);
      if (claimRecorded.status !== 'ok') {
        const proof = next.proveNeverDispatched?.();
        if (proof) {
          await resolveNeverDispatchedCreate(ctx.db, dispatch, proof, request, async (tx, intent) =>
            persistNeverDispatchedCreate(tx, ctx, input, intent, loaded.draft!.generationId, prepared.digest));
          releaseProvedNeverDispatched = true;
          dispatchHandle = null;
        }
        throw new Error('reservation_v2_create_receipt_unavailable');
      }
      try { lockSignal?.throwIfAborted(); return await next(); }
      catch (error) {
        const proof = next.proveNeverDispatched?.();
        if (proof) {
          await resolveNeverDispatchedCreate(ctx.db, dispatch, proof, request, async (tx, intent) =>
            persistNeverDispatchedCreate(tx, ctx, input, intent, loaded.draft!.generationId, prepared.digest));
          releaseProvedNeverDispatched = true;
          dispatchHandle = null;
        }
        throw error;
      }
    },
  };
  let native: NativeCreate;
  const invoke = (signal?: AbortSignal) => {
    lockSignal = signal && ctx.signal ? AbortSignal.any([signal, ctx.signal]) : signal ?? ctx.signal;
    return nativeModule.createReservation(nativeInput, { ...liveOptions, signal: lockSignal, transportId: ctx.transport.id,
      credentialLease: ctx.credentialLease });
  };
  try {
    if (ctx.heldTargetLock) {
      const property = getPropertyRegistration(targetResult.data.propertyCode);
      if (!property || !ctx.credentialLease) throw new Error('create_batch_scope_unavailable');
      assertTargetAliasesHeld(ctx.heldTargetLock, { tenantId: property.expectedTenant, propertyCode: property.propertyCode,
        targetAliases: hmsDispatchTargetKeys(targetResult.data) });
      native = await invoke(ctx.heldTargetLock.signal);
    } else native = await targetLock.withLock(invoke, acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
  }
  catch (error) { native = { outcome: 'uncertain', issue: isPropertyReadLockDeadline(error) ? 'create_lock_busy' : 'native_create_invocation_failed' }; }
  if (claimIssue) return { status: 'needs_reconcile', issue: claimIssue };
  const activeDispatch = dispatchHandle as HmsLabtestWriteHandle | null;
  if (!activeDispatch) return { status: releaseProvedNeverDispatched ? 'failed' : 'refused',
    issue: native.issue ?? native.outcome ?? 'native_create_not_dispatched', native };
  const confirmation = typeof native.confirmation === 'string' ? native.confirmation : '';
  const fields = native.readback?.fields;
  const savedPrice = nativeReadbackPrice(fields);
  const mealFields = Array.isArray(fields) ? fields.filter(field => record(field)?.name === 'mealplan') : [];
  const savedMeal = mealFields.length === 1 ? record(mealFields[0])?.value : null;
  const preparedMeal = record(record(prepared.request)?.room)?.mealPlan;
  const mealReadbackMatched = typeof preparedMeal === 'string' && savedMeal === preparedMeal &&
    reservationWorkflowV2CreateMealPlanMatches(compiled.requestedMealPlan, compiled.mealPlan, savedMeal, ctx.property.propertyCode);
  const partiesRequested = Object.keys(record(nativeInput.parties) ?? {}).length > 0;
  const billingRequested = typeof nativeInput.billingReference === 'string';
  const success = native.outcome === 'saved' && native.writerSessionClosed === true &&
    native.save?.dispatchCallbacksDrained === true && /^\d{6,10}-\d{1,2}$/.test(confirmation) &&
    typeof native.nativeStayId === 'string' && /^\d{1,100}$/.test(native.nativeStayId) &&
    Array.isArray(fields) && Array.isArray(native.readback?.mismatches) && native.readback.mismatches.length === 0 &&
    (!partiesRequested || record(native.readback?.partyProof)?.outcome === 'verified') &&
    (!billingRequested || native.save?.billingReferenceStaged === true) && mealReadbackMatched && priceMatches(savedPrice, prepared.price);
  if (!success) {
    const uncertain = nativeObservation(loaded.draft, input, native, 'partial', {
      dispatchHoldId: activeDispatch.holdId, confirmation: confirmation || null, nativeOutcome: native.outcome ?? 'unknown',
      issue: native.issue ?? (priceMatches(savedPrice, prepared.price) ? 'create_readback_unverified' : 'saved_price_mismatch'),
      pricePlanExpected: prepared.price, priceReadback: savedPrice, nativeReadback: native.readback ?? null,
      prepareObservationRef: prepared.observation.ref,
    });
    const savedResult = await recordNativeObservation(ctx, input, uncertain, 'unknown',
      'Create Save may have dispatched; fresh reconciliation required', input.idempotencyKey);
    return { status: 'needs_reconcile', operationId: input.idempotencyKey, dispatchHoldId: activeDispatch.holdId,
      issue: savedResult.status === 'ok' ? String(uncertain.result.nativeOutcome ?? 'unknown') : 'unknown_receipt_persist_failed' };
  }
  const paths = record(native.screenshots);
  const savedShots = await persistSavedScreenshot(ctx, input.workItemId, paths?.before, paths?.after);
  if (!savedShots) {
    const uncertain = nativeObservation(loaded.draft, input, native, 'partial', {
      dispatchHoldId: activeDispatch.holdId, confirmation, issue: 'saved_screenshot_persist_failed', nativeReadback: native.readback,
      prepareObservationRef: prepared.observation.ref,
    });
    await recordNativeObservation(ctx, input, uncertain, 'unknown', 'Create exists but saved proof is unavailable', input.idempotencyKey);
    return { status: 'needs_reconcile', operationId: input.idempotencyKey, confirmation, dispatchHoldId: activeDispatch.holdId };
  }
  const successObservation = nativeObservation(loaded.draft, input, native, 'complete', {
    confirmation, requestDigest: prepared.digest, ratePlanAvailability: prepared.price, savedPrice,
    priceMatched: true, nativeReadback: native.readback, savedShot: savedShots.savedShot,
    dispatchHoldId: activeDispatch.holdId, prepareObservationRef: prepared.observation.ref,
  });
  try {
    await resolveHmsLabtestDispatch(ctx.db, activeDispatch, { operation: 'create', confirmation,
      readbackDigest: sha256(native.readback), savedShot: savedShots.savedShot }, async (tx, intent) => {
      if (intent.workItemId !== input.workItemId || intent.transportId !== ctx.transport.id ||
          intent.actorUserId !== ctx.user.id || intent.grantId !== input.idempotencyKey || intent.stayId !== `${input.requestId}_${input.allocationId}` ||
          intent.approvedDigest !== prepared.digest || intent.sourceDigest !== input.source.sourceHash ||
          intent.recovery.requestId !== input.requestId || intent.recovery.allocationId !== input.allocationId) {
        throw new Error('reservation_workflow_v2_create_resolution_scope_changed');
      }
      await persistOperationResultInTransaction(tx, ctx, input, successObservation,
        `Created ${compiled.expectedGuest.firstName} ${compiled.expectedGuest.lastName}; HMS price read back equal`);
    });
  } catch {
    const uncertain = nativeObservation(loaded.draft, input, native, 'partial', {
      dispatchHoldId: activeDispatch.holdId, confirmation, issue: 'durable_create_resolution_unconfirmed',
      nativeReadback: native.readback, savedShot: savedShots.savedShot,
      prepareObservationRef: prepared.observation.ref,
    });
    await recordNativeObservation(ctx, input, uncertain, 'unknown', 'Create readback passed but durable release is unresolved', input.idempotencyKey);
    return { status: 'needs_reconcile', operationId: input.idempotencyKey, confirmation, dispatchHoldId: activeDispatch.holdId };
  }
  return { status: 'succeeded', operationId: input.idempotencyKey, requestId: input.requestId,
    allocationId: input.allocationId, confirmation, nativeStayId: native.nativeStayId,
    checkedPricing: native.save?.checkedPricing, price: savedPrice, observationRef: successObservation.ref };
}

/** Positive-only recovery: an uncertain Save remains blocked unless fresh native reconciliation proves the created stay. */
export async function reservationWorkflowV2Reconcile(ctx: ReservationWorkflowV2ServerContext,
  input: ReservationWorkflowV2ReconcileInput): Promise<Outcome> {
  if (!z.string().uuid().safeParse(input.operationId).success) return { status: 'invalid_input', issue: 'operation_id_must_be_uuid' };
  const initial = await getReservationWorkflowV2Draft(stateContext(ctx), input);
  if (initial.status !== 'ok') return initial;
  const result = initial.draft.operationResults.find((entry) => entry.id === input.operationId);
  if (!result || result.workflow !== 'create') return { status: 'not_found' };
  if (result.status === 'succeeded') return { status: 'succeeded', operationId: result.id,
    summary: result.summary, observationRefs: result.observationRefs };
  if (result.status === 'failed') return { status: 'failed', operationId: result.id, summary: result.summary };
  if (result.status !== 'unknown') return { status: 'not_reconcilable', operationId: result.id };
  const dispatchRows = await ctx.db.select({ id: workEvent.id, value: workEvent.value }).from(workEvent)
    .where(and(eq(workEvent.workItemId, input.workItemId), eq(workEvent.type, 'write.evidence'),
      eq(workEvent.fieldPath, 'nava.hms.labtest.dispatch.v1'))).limit(5000);
  const intents = dispatchRows.map((entry) => record(entry.value)).filter((entry): entry is Record<string, unknown> =>
    Boolean(entry && entry.kind === 'intent' && entry.operation === 'create' && entry.grantId === input.operationId));
  if (!intents.length) {
    // Reconcile may overlap the writer between its pending receipt and claim.
    // Absence is not proof that Save was never dispatched; only the writer's
    // positive never-dispatched proof can release this operation for a retry.
    return { status: 'needs_reconcile', operationId: input.operationId,
      issue: 'create_claim_not_yet_observed' };
  }
  const intent = intents.find((entry) => entry.recovery && record(entry.recovery)?.operationId === result.id &&
    record(entry.recovery)?.requestId === result.requestId && record(entry.recovery)?.allocationId === result.allocationId);
  if (!intent || typeof intent.holdId !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(intent.holdId)) return { status: 'needs_reconcile', operationId: result.id,
    issue: 'create_dispatch_intent_scope_unverified' };
  try { await recoverHmsLabtestCreate(ctx.db, intent.holdId); }
  catch { return { status: 'needs_reconcile', operationId: result.id, issue: 'fresh_create_readback_not_positive' }; }
  const resolved = await getReservationWorkflowV2Draft(stateContext(ctx), input);
  if (resolved.status !== 'ok') return resolved;
  const final = resolved.draft.operationResults.find((entry) => entry.id === input.operationId);
  return final?.status === 'succeeded' ? { status: 'succeeded', operationId: final.id,
    summary: final.summary, observationRefs: final.observationRefs } : { status: 'needs_reconcile',
      operationId: input.operationId, issue: 'create_recovery_receipt_missing' };
}



/** Execute only the exact request captured by a verified, worker-owned staff Go. */
export async function executePreparedReservationV2Run(input: {
  db: DB; go: import('../hms/staff-go-authority.js').VerifiedStaffGo; fence: AiRunFence; signal?: AbortSignal;
}) {
  const { go, fence, signal, db } = input;
  signal?.throwIfAborted();
  const prepared = go.preparation, captured = prepared.workflowContext;
  if (!captured || go.grant.preparedRef !== prepared.preparedRef || go.grant.workItemId !== captured.input.workItemId ||
      go.grant.transportId !== prepared.scope.transportId || go.grant.propertyCode !== prepared.scope.propertyCode) {
    throw new Error('reservation_v2_preparation_invalid');
  }
  const ctx: ReservationWorkflowV2ServerContext = { db, transport: { id: go.grant.transportId },
    property: { propertyCode: go.grant.propertyCode },
    user: { id: go.actorUserId, sessionId: go.sessionId, sessionProfile: go.sessionProfile },
    writeRunFence: fence, signal };
  if (captured.endpoint === 'createGuestProfile') {
    if (go.grant.operation !== 'create_guest_profile') throw new Error('reservation_v2_operation_mismatch');
    const { reservationWorkflowV2CreateGuestProfile } = await import('./reservation-workflow-v2-guest.js');
    return reservationWorkflowV2CreateGuestProfile(ctx, { ...captured.input, go: true, idempotencyKey: go.grant.grantId });
  }
  if (captured.endpoint === 'executeServices') {
    if (go.grant.operation !== 'add_on') throw new Error('reservation_v2_operation_mismatch');
    const { reservationWorkflowV2ExecuteServices } = await import('./reservation-workflow-v2-services-execute.js');
    return reservationWorkflowV2ExecuteServices(ctx, { ...captured.input, go: true, idempotencyKey: go.grant.grantId });
  }
  if (captured.endpoint === 'executeSavedServices') {
    if (go.grant.operation !== 'add_on') throw new Error('reservation_v2_operation_mismatch');
    const { reservationWorkflowV2ExecuteSavedServices } = await import('./reservation-workflow-v2-services-execute.js');
    return reservationWorkflowV2ExecuteSavedServices(ctx, { ...captured.input, go: true, idempotencyKey: go.grant.grantId });
  }
  const current = await getReservationWorkflowV2Draft(stateContext(ctx), captured.input);
  if (current.status !== 'ok') throw new Error('reservation_v2_draft_unavailable');
  const request = current.draft.proposal.content.requests.find((row) => row.id === captured.input.requestId);
  if (!request || (request.kind === 'filing' ? 'attach_document' : request.kind) !== go.grant.operation) {
    throw new Error('reservation_v2_operation_mismatch');
  }
  const requestInput = { ...captured.input, go: true as const, idempotencyKey: go.grant.grantId };
  if (request.kind === 'create') {
    const allocations = prepared.allocations;
    if (!allocations?.length || captured.input.allocationId !== undefined) throw new Error('reservation_v2_batch_preparation_invalid');
    const last = allocations.at(-1)!;
    if (!last.observationRef) throw new Error('reservation_v2_batch_observation_missing');
    const projection = await reservationWorkflowV2CreatePreparation(ctx,
      { ...captured.input, allocationId: last.allocationId }, last.observationRef);
    if (!projection || canonicalJson(projection.allocations) !== canonicalJson(allocations) ||
        canonicalJson(projection.targetAliases) !== canonicalJson(prepared.targetAliases) ||
        canonicalJson(projection.nativeObservation) !== canonicalJson(prepared.nativeObservation)) {
      throw new Error('reservation_v2_batch_preparation_changed');
    }
    const snapshots = allocations.map(allocation => {
      const compiled = compileCreate(current.draft, captured.input.requestId, allocation.allocationId,
        ctx.property.propertyCode, 'prepare');
      const staged = compiled.outcome === 'ok' ? preparedFor(current.draft, captured.input.requestId,
        allocation.allocationId, compiled.semanticDigest) : null;
      if (!staged || !record(staged.request)) throw new Error('reservation_v2_batch_binding_missing');
      return { approvedRequest: record(staged.request)!, requestDigest: staged.digest, ratePlanAvailability: staged.price,
        arProfileId: staged.arAccountProfileId ?? undefined };
    });
    const property = getPropertyRegistration(go.grant.propertyCode), databaseUrl = process.env.DATABASE_URL;
    if (!property?.active || !databaseUrl || property.expectedTenant !== go.grant.tenantId) throw new Error('reservation_v2_batch_lock_unavailable');
    const siblingTools = await import(new URL('../../tooling/hms-cloud/batch-sibling-readback.mjs', import.meta.url).href) as {
      verifyApprovedBatchSiblings: (siblings: NonNullable<ReservationWorkflowV2ServerContext['verifiedBatchSiblings']>,
        options: Record<string, unknown>) => Promise<boolean>;
    };
    const aliases = new Set(prepared.targetAliases);
    const siblings: NonNullable<ReservationWorkflowV2ServerContext['verifiedBatchSiblings']> = [];
    const results: Outcome[] = [];
    for (const [index, allocation] of allocations.entries()) {
      signal?.throwIfAborted();
      const lock = createPostgresTargetAliasLock({ tenantId: property.expectedTenant, propertyCode: property.propertyCode,
        targetAliases: [...aliases], databaseUrl });
      const result = await lock.withLock(async (_connection, targetSignal, heldTargetLock) => {
        const currentSignal = signal ? AbortSignal.any([signal, targetSignal]) : targetSignal;
        return withCloudCredentialLease(property.propertyCode, async credentialLease => {
          if (siblings.length && !await siblingTools.verifyApprovedBatchSiblings(siblings, {
            propertyCode: property.propertyCode, transportId: ctx.transport.id, signal: currentSignal, credentialLease,
          })) return { status: 'needs_reconcile', issue: 'create_prior_room_fresh_proof_missing' };
          currentSignal.throwIfAborted();
          return reservationWorkflowV2Execute({ ...ctx, signal: currentSignal, heldTargetLock, credentialLease,
            verifiedBatchSiblings: siblings }, { ...captured.input, allocationId: allocation.allocationId, go: true,
            idempotencyKey: hmsAllocationOperationId(go.grant.grantId, allocation.allocationId) });
        }, { signal: currentSignal });
      }, { ...acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS), ...(signal ? { signal } : {}) });
      results.push(result);
      if (result.status !== 'succeeded' || typeof result.confirmation !== 'string' ||
          typeof result.nativeStayId !== 'string' || !/^\d{1,100}$/.test(result.nativeStayId)) {
        return { status: 'needs_reconcile', issue: 'create_batch_incomplete', allocationId: allocation.allocationId, results };
      }
      const target = hmsDispatchTargetSchema.safeParse({ propertyCode: property.propertyCode, kind: 'saved',
        confirmation: result.confirmation, nativeStayId: result.nativeStayId });
      if (!target.success || target.data.kind !== 'saved') return { status: 'needs_reconcile', issue: 'create_batch_target_unverified', results };
      for (const alias of hmsDispatchTargetKeys(target.data)) aliases.add(alias);
      siblings.push({ ...snapshots[index]!, confirmation: result.confirmation, nativeStayId: result.nativeStayId,
        checkedPricing: result.checkedPricing });
    }
    return { status: 'succeeded', operationId: go.grant.grantId, observationRef: results.at(-1)?.observationRef, results };
  }
  if (request.kind === 'amend') {
    const { reservationWorkflowV2AmendExecute } = await import('./reservation-workflow-v2-amend.js');
    return reservationWorkflowV2AmendExecute(ctx, requestInput);
  }
  if (request.kind === 'cancel') {
    const { reservationWorkflowV2CancelExecute } = await import('./reservation-workflow-v2-cancel.js');
    return reservationWorkflowV2CancelExecute(ctx, requestInput);
  }
  if (request.kind === 'filing') {
    const { reservationWorkflowV2FilingExecute } = await import('./reservation-workflow-v2-filing.js');
    return reservationWorkflowV2FilingExecute(ctx, requestInput);
  }
  throw new Error('reservation_v2_operation_unavailable');
}
