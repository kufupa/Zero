import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
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
  recordReservationWorkflowV2Result,
  reservationWorkflowV2DraftOf,
} from './reservation-workflow-v2-state.js';
import { canonicalJson } from './draft-approval.js';
import {
  captureHmsLabtestDispatchEpoch,
  claimHmsLabtestDispatch,
  HmsLabtestDispatchError,
  nativeCreateSaveDigest,
  recoverHmsLabtestCreate,
  resolveHmsLabtestDispatch,
  resolveNeverDispatchedCreate,
  type HmsLabtestIntent,
  type HmsLabtestWriteHandle,
} from './hms-labtest-dispatch.js';
import { hmsDispatchTargetSchema, type HmsDispatchTarget } from './hms-dispatch-target.js';
import { persistHmsShots, verifyStoredHmsShot } from './hms-shots-store.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import { acquisitionWithin, PANE_PROPERTY_LOCK_WAIT_MS, isPropertyReadLockDeadline } from '../hms/property-read-lock.js';
import { paneStayCloudTargetLock, paneStayCreateTarget } from './pane-stay-save.js';

type V2StateContext = { db: DB; transportId: string; userId: string; propertyCode: string };
export type ReservationWorkflowV2ServerContext = {
  db: DB;
  transport: { id: string };
  user: { id: string };
  property: { propertyCode: string };
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const sameName = (left: unknown, right: unknown): boolean => typeof left === 'string' && typeof right === 'string' &&
  left.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase() ===
  right.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
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
  save?: { outcome?: string; dispatchCallbacksDrained?: boolean; billingReferenceStaged?: boolean };
  confirmation?: unknown; readback?: { fields?: unknown; mismatches?: unknown[]; partyProof?: unknown };
  writerSessionClosed?: boolean; saveAttempted?: boolean;
};
type NativeContinuation = (() => Promise<unknown>) & { proveNeverDispatched?: () => unknown };

function stateContext(ctx: ReservationWorkflowV2ServerContext): V2StateContext {
  return { db: ctx.db, transportId: ctx.transport.id, userId: ctx.user.id, propertyCode: ctx.property.propertyCode };
}

async function currentDraft(ctx: ReservationWorkflowV2ServerContext, input: {
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

type ResolvedLeaf = { value: unknown; path: string; unset?: boolean };
function leaf(draft: ReservationWorkflowV2Draft, path: string, sourceValue: unknown): ResolvedLeaf | { issue: string } {
  const override = draft.fieldOverrides[path];
  if (override) {
    if (override.state === 'unknown') return { issue: 'unknown_staff_value' };
    if (override.state === 'set') return { value: override.value, path };
    if (override.state === 'none' || override.state === 'clear') return { value: undefined, path, unset: true };
    if (override.state === 'inherit') return { value: sourceValue, path };
  }
  if (sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue) &&
      (sourceValue as { kind?: unknown }).kind === 'none') return { value: undefined, path, unset: true };
  return { value: sourceValue, path };
}

function accepted(draft: ReservationWorkflowV2Draft, path: string): boolean {
  return draft.fieldReviewRequirements[path]?.required === false || draft.staffReviews[path]?.status === 'accepted';
}

function reviewed(draft: ReservationWorkflowV2Draft, path: string, value: unknown): string | null {
  if (value === undefined || value === null || (value && typeof value === 'object' &&
      (value as { kind?: unknown }).kind === 'none')) return null;
  return accepted(draft, path) ? null : path;
}

function getCandidateRows(result: Record<string, unknown>): Record<string, unknown>[] {
  const queue: unknown[] = [result], seen = new Set<object>(), rows: Record<string, unknown>[] = [];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || Array.isArray(current) || seen.has(current)) continue;
    seen.add(current);
    const item = current as Record<string, unknown>;
    if (/^\d{1,30}$/.test(String(item.nativeId ?? ''))) rows.push(item);
    for (const key of ['candidates', 'matches', 'guestCandidates', 'partyCandidates', 'results', 'result']) {
      const child = item[key];
      if (Array.isArray(child)) queue.push(...child);
      else if (child && typeof child === 'object') queue.push(child);
    }
  }
  return rows;
}

function chosenObservationRef(draft: ReservationWorkflowV2Draft, path: string, proposed: string | null,
  allowedKind: 'guest_candidate' | 'party_candidate', requestId: string, allocationId: string,
  allowSharedScope = false): string | null | { issue: string } {
  const selected = leaf(draft, path, proposed);
  if ('issue' in selected) return selected;
  if (selected.value == null) return null;
  const observation = typeof selected.value === 'string' ? draft.observations.find((entry) => entry.ref === selected.value) : null;
  const hostAdmitted = observation?.kind === allowedKind && observation.status === 'complete' &&
    observation.criteria.requestId === requestId &&
    (observation.criteria.allocationId === allocationId || (allowSharedScope &&
      typeof observation.criteria.allocationId === 'string')) &&
    (observation.criteria.fieldPath === path || (Array.isArray(observation.criteria.fieldPaths) &&
      observation.criteria.fieldPaths.includes(path)));
  if (typeof selected.value !== 'string' || !hostAdmitted) {
    return { issue: 'host_candidate_selection_required' };
  }
  return selected.value;
}

function candidateFromObservation(draft: ReservationWorkflowV2Draft, kind: 'guest_candidate' | 'party_candidate',
  nativeRef: string | null, expectedName: string, role?: string, requestId?: string, allocationId?: string,
  fieldPath?: string, allowSharedScope = false): Record<string, unknown> | null {
  if (!nativeRef) return null;
  const observation = draft.observations.find((item) => item.ref === nativeRef && item.kind === kind && item.status === 'complete');
  if (!observation || observation.criteria.requestId !== requestId ||
      (observation.criteria.allocationId !== allocationId && !(allowSharedScope &&
        typeof observation.criteria.allocationId === 'string')) || (observation.criteria.fieldPath !== fieldPath &&
        !(Array.isArray(observation.criteria.fieldPaths) && observation.criteria.fieldPaths.includes(fieldPath)))) return null;
  const output = observation && record(observation.result);
  if (!output) return null;
  const candidates = getCandidateRows(output).filter((candidate) => {
    const candidateName = candidate.name ?? [candidate.firstName, candidate.lastName].filter(Boolean).join(' ');
    const roleMatches = !role || !observation.criteria.role || observation.criteria.role === role;
    return roleMatches && sameName(candidateName, expectedName);
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

type ResolvedParty = { id: string; name: string } | null;
function resolveParty(draft: ReservationWorkflowV2Draft, basePath: string, raw: unknown, role: string,
  requestId: string, allocationId: string):
  { value: ResolvedParty; issues: string[]; selectionPath?: string; selectedRef?: string | null } {
  const base = record(raw);
  if (!base || !text(base.name)) return { value: null, issues: [] };
  const selectionPath = ptr(...basePath.slice(1).split('/').map(decodeURIComponent), 'nativeSelectionRef');
  const selected = leaf(draft, selectionPath, typeof base.suggestedRef === 'string' ? base.suggestedRef : null);
  if ('issue' in selected) return { value: null, issues: ['host_party_selection_required'], selectionPath };
  const allowSharedScope = basePath.split('/').some((segment) => segment === 'shared' || segment === 'dateSections');
  const ref = chosenObservationRef(draft, selectionPath, typeof selected.value === 'string' ? selected.value : null,
    'party_candidate', requestId, allocationId, allowSharedScope);
  if (typeof ref !== 'string') return { value: null, issues: ['host_party_selection_required'], selectionPath,
    selectedRef: typeof selected.value === 'string' ? selected.value : null };
  const candidate = candidateFromObservation(draft, 'party_candidate', ref, String(base.name), role,
    requestId, allocationId, selectionPath, allowSharedScope);
  if (!candidate || !text(candidate.name)) return { value: null, issues: ['host_party_candidate_unverified'], selectionPath, selectedRef: ref };
  return { value: { id: String(candidate.nativeId), name: String(candidate.name) }, issues: [], selectionPath, selectedRef: ref };
}

type CreateCompile = { outcome: 'ok'; nativeInput: Record<string, unknown>; expectedGuest: { firstName: string; lastName: string };
  target: HmsDispatchTarget; reviewPaths: string[]; partySelectionPaths: Record<string, string>;
  semanticDigest: string; preparedBinding: Record<string, unknown> | null } |
  { outcome: 'needs_input' | 'needs_review' | 'unsupported'; issue: string; fields?: string[] };

function compileCreate(draft: ReservationWorkflowV2Draft, requestId: string, allocationId: string, propertyCode: string,
  mode: 'prepare' | 'lookup' | 'execute' = 'prepare'): CreateCompile {
  const request = draft.proposal.content.requests.find((entry) => entry.id === requestId);
  if (!request || request.kind !== 'create') return { outcome: 'needs_input', issue: 'create_request_not_found' };
  const body = request.body;
  const allocationIndex = body.allocations.findIndex((entry) => entry.id === allocationId);
  if (allocationIndex < 0) return { outcome: 'needs_input', issue: 'allocation_not_found' };
  const allocation = body.allocations[allocationIndex]!;
  const dateIndex = body.dateSections.findIndex((entry) => entry.id === allocation.dateSectionId);
  if (dateIndex < 0) return { outcome: 'needs_input', issue: 'date_section_not_found' };
  const section = body.dateSections[dateIndex]!;
  const req = ptr('proposal', 'content', 'requests', requestId, 'body');
  const alloc = ptr('proposal', 'content', 'requests', requestId, 'body', 'allocations', allocationIndex);
  const dates = ptr('proposal', 'content', 'requests', requestId, 'body', 'dateSections', dateIndex);
  const issues: string[] = [], reviewPaths = new Set<string>();
  const valueAt = (field: string): ResolvedLeaf | { issue: string } => {
    const choices = [
      { path: ptr(...alloc.slice(1).split('/').map(decodeURIComponent), 'overrides', field), value: allocation.overrides[field as keyof typeof allocation.overrides] },
      { path: ptr(...dates.slice(1).split('/').map(decodeURIComponent), 'defaults', field), value: section.defaults[field as keyof typeof section.defaults] },
      { path: ptr(...req.slice(1).split('/').map(decodeURIComponent), 'shared', field), value: body.shared[field as keyof typeof body.shared] },
    ];
    for (const choice of choices) {
      const resolved = leaf(draft, choice.path, choice.value);
      if ('issue' in resolved) return resolved;
      if (resolved.value !== undefined && resolved.value !== null) {
        const missingReview = reviewed(draft, resolved.path, resolved.value);
        if (missingReview) reviewPaths.add(missingReview);
        return resolved;
      }
      if (resolved.unset) return resolved;
    }
    return { value: undefined, path: choices[0]!.path };
  };
  const readValue = (field: string, required = false): unknown => {
    const result = valueAt(field);
    if ('issue' in result) { issues.push(`${field}:${result.issue}`); return undefined; }
    if (required && (result.value === undefined || result.value === null)) issues.push(`${field}:required`);
    return result.value;
  };
  for (const field of ['roomType', 'ratePlan', 'guaranteeType']) readValue(field, true);
  const roomTypeForCharge = readValue('roomTypeForCharge');
  if (roomTypeForCharge != null) issues.push('roomTypeForCharge:not_supported_by_create_reservation');
  const arrivalPath = ptr(...dates.slice(1).split('/').map(decodeURIComponent), 'arrival');
  const departurePath = ptr(...dates.slice(1).split('/').map(decodeURIComponent), 'departure');
  const arrivalResult = leaf(draft, arrivalPath, section.arrival);
  const departureResult = leaf(draft, departurePath, section.departure);
  const arrival = 'issue' in arrivalResult ? undefined : arrivalResult.value;
  const departure = 'issue' in departureResult ? undefined : departureResult.value;
  for (const [path, value] of [[arrivalPath, arrival], [departurePath, departure]] as const) {
    if (value == null) issues.push(`${path}:required`);
    else { const missingReview = reviewed(draft, path, value); if (missingReview) reviewPaths.add(missingReview); }
  }
  const adultsPath = ptr(...alloc.slice(1).split('/').map(decodeURIComponent), 'occupancy', 'adults');
  const childrenPath = ptr(...alloc.slice(1).split('/').map(decodeURIComponent), 'occupancy', 'childCount');
  const agesPath = ptr(...alloc.slice(1).split('/').map(decodeURIComponent), 'occupancy', 'childAges');
  const adults = allocation.occupancy.adults;
  const childCount = allocation.occupancy.childCount;
  const childAges = allocation.occupancy.childAges;
  for (const [path, value] of [[adultsPath, adults], [childrenPath, childCount], [agesPath, childAges]] as const) {
    if (value == null) issues.push(`${path}:required`);
    else { const missingReview = reviewed(draft, path, value); if (missingReview) reviewPaths.add(missingReview); }
  }
  if (adults !== null && (!Number.isInteger(adults) || adults < 1)) issues.push(`${adultsPath}:invalid`);
  if (childCount !== null && (!Number.isInteger(childCount) || childCount < 0)) issues.push(`${childrenPath}:invalid`);
  if (childAges !== null && (!childAges.every((age) => Number.isInteger(age) && age !== null && age >= 0 && age <= 17) ||
      (childCount !== null && childCount !== childAges.length))) issues.push(`${agesPath}:invalid`);
  const guestPath = ptr(...alloc.slice(1).split('/').map(decodeURIComponent), 'guest');
  const guest = allocation.guest;
  const firstName = text(guest.firstName), lastName = text(guest.lastName);
  for (const [key, value] of [['firstName', firstName], ['lastName', lastName]] as const) {
    const path = ptr(...guestPath.slice(1).split('/').map(decodeURIComponent), key);
    if (!value) issues.push(`${path}:required`);
    else { const missingReview = reviewed(draft, path, value); if (missingReview) reviewPaths.add(missingReview); }
  }
  if (guest.profileIntent !== 'existing_or_unknown') issues.push(`${guestPath}:requested_new_profile_unsupported`);
  const guestRefPath = ptr(...guestPath.slice(1).split('/').map(decodeURIComponent), 'nativeSelectionRef');
  const selectedGuestValue = leaf(draft, guestRefPath, guest.suggestedRef);
  const selectedGuestRef = 'issue' in selectedGuestValue ? selectedGuestValue
    : chosenObservationRef(draft, guestRefPath, typeof selectedGuestValue.value === 'string' ? selectedGuestValue.value : null,
      'guest_candidate', requestId, allocationId);
  let guestCandidate: Record<string, unknown> | null = null;
  if (typeof selectedGuestRef === 'string' && firstName && lastName) {
    guestCandidate = candidateFromObservation(draft, 'guest_candidate', selectedGuestRef, `${firstName} ${lastName}`,
      undefined, requestId, allocationId, guestRefPath);
    if (guestCandidate && (!sameName(guestCandidate.firstName, firstName) || !sameName(guestCandidate.lastName, lastName) ||
        (guest.email && !sameName(guestCandidate.email, guest.email)) || !text(guestCandidate.nativeId))) guestCandidate = null;
  } else if (mode !== 'lookup') issues.push(`${guestPath}:existing_profile_selection_required`);
  if (!guestCandidate && mode !== 'lookup') issues.push(`${guestPath}:native_profile_unverified`);
  const selectedGuestRefValue = typeof selectedGuestRef === 'string' ? selectedGuestRef : null;
  if (selectedGuestRefValue && mode === 'execute') {
    const missingReview = reviewed(draft, guestRefPath, selectedGuestRefValue);
    if (missingReview) reviewPaths.add(missingReview);
  }

  const parties: Record<string, ResolvedParty> = {};
  const partyInputs: Record<string, Record<string, unknown> | null> = {};
  const partySelectionPaths: Record<string, string> = {};
  for (const [field, role] of [['bookingAgency', 'agency'], ['organization', 'organization'], ['arAccount', 'ar_account']] as const) {
    const resolved = valueAt(field);
    if ('issue' in resolved) { issues.push(`${field}:${resolved.issue}`); continue; }
    const raw = resolved.value;
    partyInputs[field] = record(raw);
    partySelectionPaths[field] = ptr(...resolved.path.slice(1).split('/').map(decodeURIComponent), 'nativeSelectionRef');
    if (raw == null || (raw && typeof raw === 'object' && (raw as { kind?: unknown }).kind === 'none')) {
      parties[field] = null; continue;
    }
        if (mode === 'execute') { const missingReview = reviewed(draft, resolved.path, raw); if (missingReview) reviewPaths.add(missingReview); }
    const party = resolveParty(draft, resolved.path, raw, role, requestId, allocationId);
    if (mode === 'execute' && party.selectedRef && party.selectionPath) {
      const missingReview = reviewed(draft, party.selectionPath, party.selectedRef);
      if (missingReview) reviewPaths.add(missingReview);
    }
    if (mode !== 'lookup' || party.value) issues.push(...party.issues.map((issue) => `${field}:${issue}`));
    else if (!text(record(raw)?.name)) issues.push(`${field}:name_query_required`);
    parties[field] = party.value;
  }

  const optionalFields = ['sourceOfBusiness', 'reasonForStay', 'billingReference', 'track', 'guestOptIn', 'bookerName',
    'bookerContact', 'reservationNote', 'cmsSend', 'cmsMessageId', 'cmsRecipient'] as const;
  const optional = Object.fromEntries(optionalFields.map((field) => [field, readValue(field)]));
  for (const field of optionalFields) {
    const resolved = valueAt(field);
    if (mode !== 'lookup' && !('issue' in resolved) && resolved.value != null) {
      const missingReview = reviewed(draft, resolved.path, resolved.value); if (missingReview) reviewPaths.add(missingReview);
    }
  }
  if (optional.guestOptIn === true) issues.push('guestOptIn:true_not_supported');
  const supportedGuarantee = new Set(['AVOUCH', 'CNFREC', 'DEPREQ', 'GRPDEF', 'GTDAGT', 'GTDCMP', 'GTDCC', 'GTDDEP', 'NGG', 'NGI']);
  if (typeof arrival !== 'string' || !isoDate.safeParse(arrival).success || typeof departure !== 'string' ||
      !isoDate.safeParse(departure).success || arrival >= departure) issues.push('stay:date_range_invalid');
  if (propertyCode !== 'HRCEN') return { outcome: 'unsupported', issue: 'property_not_supported' };
  if (issues.some((issue) => issue.includes('not_supported') || issue.includes('unsupported'))) {
    return { outcome: 'unsupported', issue: 'create_contains_native_unsupported_field', fields: issues };
  }
  if (mode === 'execute' && reviewPaths.size) return { outcome: 'needs_review', issue: 'create_requires_staff_acceptance', fields: [...reviewPaths] };
  if (issues.length) return { outcome: 'needs_input', issue: 'create_input_incomplete', fields: issues };
  const roomType = readValue('roomType') as string;
  const ratePlan = readValue('ratePlan') as string;
  const guaranteeType = readValue('guaranteeType') as string;
  if (!supportedGuarantee.has(guaranteeType)) return { outcome: 'unsupported', issue: 'guarantee_not_supported_yet', fields: ['guaranteeType'] };
  if ((!guestCandidate && mode !== 'lookup') || !firstName || !lastName || adults === null || childCount === null || childAges === null) {
    return { outcome: 'needs_input', issue: 'native_create_input_incomplete' };
  }
  const nativeParties: Record<string, unknown> = {};
  if (parties.bookingAgency) { nativeParties.agencyId = parties.bookingAgency.id; nativeParties.agencyName = parties.bookingAgency.name; }
  else if (mode === 'lookup' && text(partyInputs.bookingAgency?.name)) nativeParties.agencyName = text(partyInputs.bookingAgency?.name);
  if (parties.organization) { nativeParties.organizationId = parties.organization.id; nativeParties.organizationName = parties.organization.name; }
  else if (mode === 'lookup' && text(partyInputs.organization?.name)) nativeParties.organizationName = text(partyInputs.organization?.name);
  if (parties.arAccount) { nativeParties.arAccountId = parties.arAccount.id; nativeParties.arAccountName = parties.arAccount.name; }
  else if (mode === 'lookup' && text(partyInputs.arAccount?.name)) nativeParties.arAccountName = text(partyInputs.arAccount?.name);
  const nativeInput: Record<string, unknown> = {
    mode: 'prepare', propertyCode,
    guest: guestCandidate ? { profileId: String(guestCandidate.nativeId) } : { search: {
      firstName, lastName, ...(text(guest.email) ? { email: text(guest.email) } : {}),
    } },
    stay: { arrival, departure, adults, childCount, childAges },
    room: { roomType, ratePlan }, guaranteeType,
    ...(optional.sourceOfBusiness != null ? { sourceOfBusiness: optional.sourceOfBusiness } : {}),
    ...(optional.reasonForStay != null ? { reasonForStay: optional.reasonForStay } : {}),
    ...(Object.keys(nativeParties).length ? { parties: nativeParties } : {}),
    ...(optional.reservationNote != null ? { note: optional.reservationNote } : {}),
    ...(optional.billingReference != null ? { billingReference: optional.billingReference } : {}),
    ...(optional.track != null ? { track: optional.track } : {}),
    ...(optional.guestOptIn === false ? { guestoptin4: false } : {}),
    ...(optional.bookerName != null || optional.bookerContact != null ? { booker: {
      ...(optional.bookerName != null ? { name: optional.bookerName } : {}),
      ...(optional.bookerContact != null ? { contact: optional.bookerContact } : {}),
    } } : {}),
    ...(optional.cmsSend !== undefined || optional.cmsMessageId != null || optional.cmsRecipient != null ? { cms: {
      ...(optional.cmsSend !== undefined ? { send: optional.cmsSend } : { send: false }),
      ...(optional.cmsMessageId != null ? { messageId: optional.cmsMessageId } : {}),
      ...(optional.cmsRecipient != null ? { recipient: optional.cmsRecipient } : {}),
    } } : {}),
  };
  // HMS's candidate selection may normalize case/spacing differently from the
  // source. Bind the exact verified native profile display into both Prepare
  // and Commit so the native writer's strict identity guard uses that value.
  const expectedGuest = guestCandidate ? {
    firstName: String(guestCandidate.firstName), lastName: String(guestCandidate.lastName),
  } : { firstName, lastName };
  const guestName = `${expectedGuest.firstName} ${expectedGuest.lastName}`;
  const targetParsed = hmsDispatchTargetSchema.safeParse({ propertyCode: 'HRCEN', kind: 'create', firstName, lastName, arrival });
  if (!targetParsed.success || targetParsed.data.kind !== 'create') return { outcome: 'needs_input', issue: 'invalid_create_target' };
  // The exact binding is only available after HMS has staged and read back the fields.
  return { outcome: 'ok', nativeInput, expectedGuest, target: targetParsed.data,
    reviewPaths: [...reviewPaths], partySelectionPaths,
    semanticDigest: sha256({ nativeInput, guestName }), preparedBinding: null };
}

function mapNativeOutcome(native: NativeCreate): Outcome {
  if (native.outcome === 'prepared' && native.requestBinding && native.ratePlanAvailability) {
    return { status: 'prepared', native };
  }
  return { status: native.outcome === 'unsupported' ? 'unsupported' : 'failed',
    issue: native.issue ?? 'native_create_prepare_incomplete', native };
}

function validPrice(value: unknown): { averageRate: string; totalRate: string; currency: string } | null {
  const parsed = z.object({ averageRate: z.string().trim().min(1).max(64), totalRate: z.string().trim().min(1).max(64),
    currency: z.string().trim().min(1).max(16) }).safeParse(value);
  return parsed.success ? parsed.data : null;
}

function operationObservation(draft: ReservationWorkflowV2Draft, requestId: string, allocationId: string,
  input: unknown, native: NativeCreate, price: { averageRate: string; totalRate: string; currency: string } | null,
  status: 'complete' | 'partial' | 'failed', prepareShot: unknown, semanticDigest: string): ReservationWorkflowV2Observation {
  const binding = record(native.requestBinding);
  return {
    ref: randomUUID(), generationId: draft.generationId, kind: 'rate_availability', status, observedAt: new Date().toISOString(),
    propertyCode: draft.propertyCode, sourceMessageId: draft.source.messageId, sourceRefs: [],
    criteria: { workflow: 'create', requestId, allocationId, draftRevision: draft.revision,
      inputDigest: sha256(input), semanticDigest,
      ...(typeof binding?.digest === 'string' ? { requestDigest: binding.digest } : {}) },
    coverage: { complete: status === 'complete', notes: status === 'complete' ? [] : [native.issue ?? native.outcome ?? 'native_create_prepare_incomplete'] },
    result: { ...(binding ? { requestBinding: binding } : {}), ...(price ? { ratePlanAvailability: price } : {}),
      ...(prepareShot ? { prepareShot } : {}),
      applied: native.applied ?? {}, unsupportedFields: native.unsupportedFields ?? [], missing: native.missing ?? [],
      nativeOutcome: native.outcome ?? 'unknown', semanticInput: input },
  };
}

async function recordNativeObservation(ctx: ReservationWorkflowV2ServerContext, input: ReservationWorkflowV2PrepareInput,
  observation: ReservationWorkflowV2Observation, status: 'prepared' | 'failed' | 'unknown', summary: string | null,
  operationId = randomUUID()) {
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

/** Read current, source-bound v2 observations; callers cannot supply lookup candidates. */
export async function reservationWorkflowV2Lookup(ctx: ReservationWorkflowV2ServerContext,
  input: ReservationWorkflowV2LookupInput): Promise<Outcome> {
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return loaded.result;
  const requests = loaded.draft.proposal.content.requests.filter((request) => !input.requestId || request.id === input.requestId);
  if (input.requestId && !requests.length) return { status: 'not_found' };
  const nativeObservations: ReservationWorkflowV2Observation[] = [], results: Outcome[] = [];
  for (const request of requests) {
    if (request.kind !== 'create') continue;
    for (const allocation of request.body.allocations) {
      const compiled = compileCreate(loaded.draft, request.id, allocation.id, ctx.property.propertyCode, 'lookup');
      if (compiled.outcome !== 'ok') {
        results.push({ status: compiled.outcome, requestId: request.id, allocationId: allocation.id,
          issue: compiled.issue, fields: compiled.fields ?? [] });
        continue;
      }
      try {
        const tool = await import(new URL('../../tooling/hms-cloud/create-reservation.mjs', import.meta.url).href) as {
          createReservation: (input: Record<string, unknown>, options: Record<string, unknown>) => Promise<NativeCreate & {
            guestCandidates?: unknown; guestCoverage?: unknown; guestCorrelation?: unknown; guestSearchOutcome?: unknown;
            partySearches?: Record<string, unknown>;
          }>;
        };
        const native = await tool.createReservation(compiled.nativeInput, { allowRealGuest: true,
          expectedGuest: compiled.expectedGuest, requireExplicitGuestSelection: true,
          allowCommitOnlyBillingReference: true });
        const guestInfo = record(native.guestCandidates) ||
          (Array.isArray(native.guestCandidates) ? { candidates: native.guestCandidates } : null);
        if (guestInfo) {
          const coverage = record(native.guestCoverage);
          const complete = Boolean(coverage && coverage.possiblyTruncated === false &&
            (coverage.serverMoreRecords === false || (Number.isInteger(coverage.loaded) && coverage.loaded === coverage.total)));
          nativeObservations.push({ ref: randomUUID(), generationId: loaded.draft.generationId,
            kind: 'guest_candidate', status: complete ? 'complete' : 'partial',
            observedAt: new Date().toISOString(), propertyCode: loaded.draft.propertyCode,
            sourceMessageId: loaded.draft.source.messageId, sourceRefs: [],
            criteria: { workflow: 'create', requestId: request.id, allocationId: allocation.id,
              fieldPaths: [
                ptr('proposal', 'content', 'requests', request.id, 'body', 'allocations',
                  request.body.allocations.findIndex((item) => item.id === allocation.id), 'guest', 'suggestedRef'),
                ptr('proposal', 'content', 'requests', request.id, 'body', 'allocations',
                  request.body.allocations.findIndex((item) => item.id === allocation.id), 'guest', 'nativeSelectionRef'),
              ],
              outcome: native.guestSearchOutcome ?? native.outcome },
            coverage: { complete, notes: complete ? [] : ['native_guest_search_incomplete'] },
            result: guestInfo });
        }
        for (const [role, field] of [['agency', 'bookingAgency'], ['organization', 'organization'], ['arAccount', 'arAccount']] as const) {
          const raw = native.partySearches?.[role];
          const party = record(raw);
          if (!party) continue;
          const coverage = record(party.coverage);
          const complete = Boolean(party.outcome === 'matches' && coverage && coverage.possiblyTruncated === false);
          const selectionPath = compiled.partySelectionPaths[field];
          if (!selectionPath) continue;
          nativeObservations.push({ ref: randomUUID(), generationId: loaded.draft.generationId,
            kind: 'party_candidate', status: complete ? 'complete' : 'partial',
            observedAt: new Date().toISOString(), propertyCode: loaded.draft.propertyCode,
            sourceMessageId: loaded.draft.source.messageId, sourceRefs: [],
            criteria: { workflow: 'create', requestId: request.id, allocationId: allocation.id, role, fieldPath: selectionPath },
            coverage: { complete, notes: complete ? [] : ['native_party_search_incomplete'] }, result: party });
        }
        results.push({ status: native.outcome ?? 'unknown', requestId: request.id, allocationId: allocation.id,
          guestCandidates: guestInfo, partySearches: native.partySearches ?? {}, ratePlanAvailability: native.ratePlanAvailability,
          missing: native.missing ?? [], issue: native.issue });
      } catch {
        results.push({ status: 'failed', requestId: request.id, allocationId: allocation.id, issue: 'native_create_lookup_failed' });
      }
    }
  }
  for (const observation of nativeObservations) {
    const appended = await appendReservationWorkflowV2Observation(stateContext(ctx), { workItemId: input.workItemId,
      source: input.source, observation });
    if (appended.status !== 'ok') return appended;
  }
  return { status: 'ok', revision: loaded.result.status === 'ok' ? loaded.result.revision : input.expectedRevision,
    seq: loaded.result.status === 'ok' ? loaded.result.seq : input.expectedSeq,
    requests, lookups: results,
    observations: [...loaded.draft.observations, ...nativeObservations], operationResults: loaded.draft.operationResults };
}

/** Compile one reviewed room against host-admitted IDs, then ask HMS for live unsaved availability. */
export async function reservationWorkflowV2Prepare(ctx: ReservationWorkflowV2ServerContext,
  input: ReservationWorkflowV2PrepareInput): Promise<Outcome> {
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return loaded.result;
  if (!input.allocationId) return { status: 'needs_input', issue: 'allocation_required' };
  const compiled = compileCreate(loaded.draft, input.requestId, input.allocationId, ctx.property.propertyCode);
  if (compiled.outcome !== 'ok') return compiled;
  try {
    const tool = await import(new URL('../../tooling/hms-cloud/create-reservation.mjs', import.meta.url).href) as {
      createReservation: (input: Record<string, unknown>, options: Record<string, unknown>) => Promise<NativeCreate>;
    };
    const native = await tool.createReservation(compiled.nativeInput, { allowRealGuest: true, expectedGuest: compiled.expectedGuest,
      requireExplicitGuestSelection: true, capturePrepareScreenshot: true, allowCommitOnlyBillingReference: true });
    const mapped = mapNativeOutcome(native), price = validPrice(native.ratePlanAvailability);
    const prepareShot = await persistPreparedScreenshot(ctx, input.workItemId, native.screenshots?.filled);
    const status = mapped.status === 'prepared' && price && prepareShot ? 'complete' : native.outcome === 'needs_input' ? 'partial' : 'failed';
    const observation = operationObservation(loaded.draft, input.requestId, input.allocationId, compiled.nativeInput,
      native, price, status, prepareShot, compiled.semanticDigest);
    const recorded = await recordNativeObservation(ctx, input, observation,
      status === 'complete' ? 'prepared' : 'failed', status === 'complete' ? 'HMS unsaved form and current rate availability verified' : mapped.issue ?? 'native prepare incomplete');
    if (recorded.status !== 'ok') return recorded;
    if (mapped.status !== 'prepared' || !price || !prepareShot) return { status: mapped.status === 'prepared' ? 'failed' : mapped.status,
      issue: prepareShot ? mapped.issue : 'prepare_screenshot_not_persisted', observationRef: observation.ref,
      ratePlanIssue: native.ratePlanIssue };
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

async function persistNativeShots(ctx: ReservationWorkflowV2ServerContext, workItemId: string,
  runId: string, paths: Partial<Record<'before.png' | 'filled.png' | 'saved.png', unknown>>) {
  const entries = Object.entries(paths).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  if (!entries.length) return null;
  const stage = await mkdtemp(join(tmpdir(), 'reservation-v2-shots-'));
  const owner = `${ctx.user.id}:${ctx.transport.id}`;
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

async function persistPreparedScreenshot(ctx: ReservationWorkflowV2ServerContext, workItemId: string, path: unknown) {
  const parsed = nativeRunId(path, 'filled.png');
  if (!parsed) return null;
  const persisted = await persistNativeShots(ctx, workItemId, parsed.runId, { 'filled.png': path });
  return persisted?.shots.find((shot) => shot.name === 'filled.png')
    ? { runId: parsed.runId, sha256: persisted.shots.find((shot) => shot.name === 'filled.png')!.sha256 } : null;
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
    entry.allocationId === allocationId && entry.workflow === 'create' && entry.status === 'prepared' &&
    entry.draftRevision <= draft.revision);
  if (!result) return null;
  const observation = draft.observations.find((item) => result.observationRefs.includes(item.ref) &&
    item.kind === 'rate_availability' && item.status === 'complete');
  const stored = observation && record(observation.result);
  const binding = stored && record(stored.requestBinding);
  const price = stored && validPrice(stored.ratePlanAvailability);
  const shot = stored && record(stored.prepareShot);
  if (!observation || !stored || (semanticDigest && observation.criteria.semanticDigest !== semanticDigest) ||
      !binding || typeof binding.digest !== 'string' || !/^[a-f0-9]{64}$/.test(binding.digest) ||
      !record(binding.request) || !price) return null;
  const bindingRequest = record(binding.request);
  const bindingParties = record(bindingRequest?.parties);
  const arAccountProfileId = text(binding.arAccountProfileId);
  if (bindingParties?.arAccount && (!arAccountProfileId || !/^\d+$/.test(arAccountProfileId))) return null;
  return { result, observation, stored, request: binding.request, digest: binding.digest, price, arAccountProfileId,
    prepareShot: shot && typeof shot.runId === 'string' && typeof shot.sha256 === 'string' ? shot : null };
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
  const clean = (value: string) => {
    const numeric = value.replace(/[^\d.-]/g, '');
    return /^-?\d+(?:\.\d+)?$/.test(numeric) ? Number(numeric).toFixed(2) : null;
  };
  return clean(left) !== null && clean(left) === clean(right);
}

function priceMatches(actual: unknown, expected: { averageRate: string; totalRate: string; currency: string }) {
  const parsed = validPrice(actual);
  return Boolean(parsed && moneyEqual(parsed.averageRate, expected.averageRate) && moneyEqual(parsed.totalRate, expected.totalRate) &&
    parsed.currency.toUpperCase() === expected.currency.toUpperCase());
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
    room.roomType === expectedRoom.roomType && room.ratePlan === expectedRoom.ratePlan;
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
  const state = { ...(item ? item.state as Record<string, unknown> : {}), reservationWorkflowV2: nextDraft };
  await tx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
  await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
    fieldPath: `reservationWorkflowV2:operationResults:${nextResult.id}`,
    value: { id: nextResult.id, requestId: nextResult.requestId, allocationId: nextResult.allocationId,
      workflow: 'create', status: nextResult.status, observationRefs: nextResult.observationRefs },
    evidence: { sourceHash: input.source.sourceHash, seq: input.expectedSeq, summary } });
}

async function authorizeCurrentCreate(tx: Parameters<Parameters<DB['transaction']>[0]>[0], ctx: ReservationWorkflowV2ServerContext,
  input: ReservationWorkflowV2ExecuteInput, expectedDigest: string, semanticDigest: string,
  requestId: string, allocationId: string) {
  const [item] = await tx.select({ state: workItem.state, revision: workItem.revision,
    revisionSeq: workItem.revisionSeq, sourceMessageId: workItem.sourceMessageId, threadId: workItem.threadId })
    .from(workItem).where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, ctx.transport.id))).limit(1).for('update');
  const draft = item && reservationWorkflowV2DraftOf(item.state as Record<string, unknown>);
  if (!item || !draft || item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq ||
      item.sourceMessageId !== input.source.messageId || item.threadId !== input.source.threadId ||
      draft.revision !== input.expectedRevision || draft.propertyCode !== ctx.property.propertyCode ||
      draft.source.sourceHash !== input.source.sourceHash || draft.transportId !== ctx.transport.id) {
    throw new Error('reservation_workflow_v2_create_stale');
  }
  const [source] = await tx.select({ id: message.id, threadId: message.threadId, transportId: message.transportId,
    direction: message.direction, historyOnly: message.historyOnly, sourceProvenance: message.sourceProvenance,
    subject: message.subject, textBody: message.textBody, htmlBody: message.htmlBody })
    .from(message).innerJoin(mailThread, and(eq(mailThread.id, message.threadId), eq(mailThread.transportId, message.transportId)))
    .where(and(eq(message.id, input.source.messageId), eq(message.threadId, input.source.threadId),
      eq(message.transportId, ctx.transport.id), eq(message.direction, 'inbound'), eq(message.historyOnly, false),
      eq(mailThread.historyOnly, false), eq(mailThread.trashedAt, null))).limit(1).for('share');
  const [access] = await tx.select({ id: mailboxAccess.id }).from(mailboxAccess)
    .where(and(eq(mailboxAccess.userId, ctx.user.id), eq(mailboxAccess.transportId, ctx.transport.id))).limit(1).for('share');
  const current = source && staffQuoteSourceHash(source);
  const compiled = compileCreate(draft, requestId, allocationId, ctx.property.propertyCode, 'execute');
  const prepared = preparedFor(draft, requestId, allocationId, compiled.outcome === 'ok' ? compiled.semanticDigest : undefined);
  const operation = draft.operationResults.find((result) => result.id === input.idempotencyKey && result.status === 'unknown' &&
    result.requestId === requestId && result.allocationId === allocationId && result.workflow === 'create');
  if (!access || !source || source.sourceProvenance?.attention != null || current !== input.source.sourceHash ||
      compiled.outcome !== 'ok' || compiled.semanticDigest !== semanticDigest || !prepared || prepared.digest !== expectedDigest || !operation) {
    throw new Error('reservation_workflow_v2_create_source_changed');
  }
}

function nativeInputMatchesBinding(compiled: Extract<CreateCompile, { outcome: 'ok' }>, request: unknown): boolean {
  const bound = record(request);
  if (!bound || !stayExpected(compiled, bound)) return false;
  const input = compiled.nativeInput, parties = record(input.parties), boundParties = record(bound.parties);
  for (const [key, id, name] of [
    ['agency', 'agencyId', 'agencyName'], ['organization', 'organizationId', 'organizationName'],
    ['arAccount', 'arAccountId', 'arAccountName'],
  ] as const) {
    const expectedId = parties?.[id], expectedName = parties?.[name];
    const actual = record(boundParties?.[key]);
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
    (input.track === undefined || sameName(record(bound.track)?.display, input.track)) &&
    (input.guestoptin4 !== false || bound.guestOptIn === false) &&
    (input.booker === undefined || canonicalJson(bound.booker) === canonicalJson(input.booker)) &&
    (input.cms === undefined || (record(bound.sendHmsConfirmation)?.kind === (record(input.cms)?.send === true ? 'send' : 'never') &&
      (record(input.cms)?.send !== true || (bound.cmsMessageId === record(input.cms)?.messageId &&
        bound.cmsRecipient === record(input.cms)?.recipient))));
}

function resultForId(draft: ReservationWorkflowV2Draft, id: string) {
  return draft.operationResults.find((entry) => entry.id === id);
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
  const roomResult = [...loaded.draft.operationResults].reverse().find((entry) => entry.requestId === input.requestId &&
    entry.allocationId === input.allocationId && entry.workflow === 'create' &&
    (entry.status === 'succeeded' || entry.status === 'unknown'));
  if (roomResult?.status === 'succeeded') return { status: 'already_succeeded', operationId: roomResult.id,
    summary: roomResult.summary, observationRefs: roomResult.observationRefs };
  if (prior?.status === 'unknown' || roomResult?.status === 'unknown') {
    return { status: 'needs_reconcile', operationId: roomResult?.id ?? prior!.id };
  }
  const compiled = compileCreate(loaded.draft, input.requestId, input.allocationId, ctx.property.propertyCode, 'execute');
  if (compiled.outcome !== 'ok') return compiled;
  const prepared = preparedFor(loaded.draft, input.requestId, input.allocationId, compiled.semanticDigest);
  if (!prepared || !prepared.prepareShot || prepared.result.draftRevision > input.expectedRevision ||
      !nativeInputMatchesBinding(compiled, prepared.request)) {
    return { status: 'needs_prepare', issue: 'prepared_create_or_price_is_stale' };
  }
  const targetResult = hmsDispatchTargetSchema.safeParse(compiled.target);
  if (!targetResult.success || targetResult.data.kind !== 'create') return { status: 'needs_input', issue: 'create_target_invalid' };
  const propertyTarget = paneStayCreateTarget({ transportId: ctx.transport.id, propertyCode: ctx.property.propertyCode });
  if (!propertyTarget.ok || propertyTarget.target.propertyCode !== 'HRCEN' || propertyTarget.target.browserSlot !== 'centurion') {
    return { status: 'unsupported', issue: 'create_property_session_unavailable' };
  }
  const targetLock = paneStayCloudTargetLock(propertyTarget.target, targetResult.data, { kind: 'independent_cloud' });
  if (!targetLock) return { status: 'needs_reconcile', issue: 'create_target_lock_unavailable' };
  let expectedEpoch: string;
  try { expectedEpoch = await captureHmsLabtestDispatchEpoch(ctx.db, targetResult.data, input.workItemId); }
  catch { return { status: 'needs_reconcile', issue: 'create_dispatch_history_unavailable' }; }
  const nativeModule = await import(new URL('../../tooling/hms-cloud/create-reservation.mjs', import.meta.url).href) as {
    createReservation: (input: Record<string, unknown>, options: Record<string, unknown>) => Promise<NativeCreate>;
  };
  const nativeInput = { ...compiled.nativeInput, mode: 'commit' };
  let dispatchHandle: HmsLabtestWriteHandle | null = null;
  let releaseProvedNeverDispatched = false;
  let claimIssue: string | null = null;
  const liveOptions: Record<string, unknown> = {
    allowRealGuest: true, expectedGuest: compiled.expectedGuest,
    expectedRequestDigest: prepared.digest, expectedRateAvailability: prepared.price,
    allowCommitOnlyBillingReference: true,
    authorizeCandidate: async () => {
      const current = await currentDraft(ctx, input);
      if (!current.draft) return false;
      const live = compileCreate(current.draft, input.requestId, input.allocationId!, ctx.property.propertyCode, 'execute');
      const livePrepared = live.outcome === 'ok' && preparedFor(current.draft, input.requestId,
        input.allocationId!, live.semanticDigest);
      return live.outcome === 'ok' && live.semanticDigest === compiled.semanticDigest &&
        Boolean(livePrepared && livePrepared.digest === prepared.digest && priceMatches(livePrepared.price, prepared.price));
    },
    dispatchCandidate: async (request: unknown, next: NativeContinuation, evidence: unknown) => {
      const requestDigest = nativeCreateSaveDigest(request);
      if (!nativeInputMatchesBinding(compiled, prepared.request)) throw new Error('reservation_v2_native_binding_changed');
      const event = record(evidence), beforePath = event?.beforeScreenshot, preimage = record(event?.preimage);
      const beforeShot = await persistBeforeScreenshot(ctx, input.workItemId, beforePath);
      if (!beforeShot || !preimage || !prepared.prepareShot || typeof event?.guaranteeDisplay !== 'string') {
        throw new Error('reservation_v2_create_recovery_evidence_missing');
      }
      const attempt = nativeObservation(loaded.draft, input, { outcome: 'dispatch_pending' }, 'partial', {
        requestDigest, approvedDigest: prepared.digest, requestBinding: prepared.request,
        expectedRateAvailability: prepared.price, prepareObservationRef: prepared.observation.ref,
        beforeShot, preimage, idempotencyKey: input.idempotencyKey,
      });
      const recorded = await recordNativeObservation(ctx, input, attempt, 'unknown',
        'Go accepted; native Create claim pending', input.idempotencyKey);
      if (recorded.status !== 'ok') throw new Error('reservation_v2_create_receipt_unavailable');
      let dispatch: HmsLabtestWriteHandle | null = null;
      try {
        dispatch = await claimHmsLabtestDispatch(ctx.db, {
          workItemId: input.workItemId, transportId: ctx.transport.id, actorUserId: ctx.user.id,
          grantId: input.idempotencyKey, propertyCode: 'HRCEN', firstName: compiled.expectedGuest.firstName,
          lastName: compiled.expectedGuest.lastName, target: targetResult.data, nativeGuestId: String(record(nativeInput.guest)?.profileId),
          operation: 'create', stayId: `${input.requestId}_${input.allocationId}`,
          sourceDigest: input.source.sourceHash, approvedDigest: prepared.digest, requestDigest,
          recovery: { request: prepared.request, requestId: input.requestId, allocationId: input.allocationId,
            operationId: input.idempotencyKey, draftRevision: input.expectedRevision,
            previewShot: prepared.prepareShot, beforeShot, preimage, guaranteeDisplay: event.guaranteeDisplay,
            ratePlanAvailability: prepared.price, arAccountProfileId: prepared.arAccountProfileId },
        }, async (tx) => authorizeCurrentCreate(tx, ctx, input, prepared.digest, compiled.semanticDigest,
          input.requestId, input.allocationId!), expectedEpoch);
      } catch (error) {
        if (error instanceof HmsLabtestDispatchError && error.reason === 'occupied') {
          claimIssue = 'create_target_held_for_reconciliation';
        }
        const failed = nativeObservation(loaded.draft, input, { outcome: 'claim_failed' }, 'failed', {
          requestDigest, issue: claimIssue ?? 'create_claim_failed', prepareObservationRef: prepared.observation.ref,
        });
        await recordNativeObservation(ctx, input, failed, 'failed', 'Native Create claim was not acquired', input.idempotencyKey);
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
          await resolveNeverDispatchedCreate(ctx.db, dispatch, proof, request, async () => {});
          releaseProvedNeverDispatched = true;
          dispatchHandle = null;
        }
        throw new Error('reservation_v2_create_receipt_unavailable');
      }
      try { return await next(); }
      catch (error) {
        const proof = next.proveNeverDispatched?.();
        if (proof) {
          await resolveNeverDispatchedCreate(ctx.db, dispatch, proof, request, async () => {});
          releaseProvedNeverDispatched = true;
          dispatchHandle = null;
          const failed = nativeObservation(loaded.draft, input, { outcome: 'not_dispatched' }, 'failed', {
            requestDigest, prepareObservationRef: prepared.observation.ref,
          });
          await recordNativeObservation(ctx, input, failed, 'failed', 'Native route proved Save was never dispatched', input.idempotencyKey);
        }
        throw error;
      }
    },
  };
  let native: NativeCreate;
  try { native = await targetLock.withLock(() => nativeModule.createReservation(nativeInput, liveOptions),
    acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS)); }
  catch (error) { native = { outcome: 'uncertain', issue: isPropertyReadLockDeadline(error) ? 'create_lock_busy' : 'native_create_invocation_failed' }; }
  if (claimIssue) return { status: 'needs_reconcile', issue: claimIssue };
  if (!dispatchHandle) return { status: releaseProvedNeverDispatched ? 'failed' : 'refused',
    issue: native.issue ?? native.outcome ?? 'native_create_not_dispatched', native };
  const confirmation = typeof native.confirmation === 'string' ? native.confirmation : '';
  const fields = native.readback?.fields;
  const savedPrice = nativeReadbackPrice(fields);
  const partiesRequested = Object.keys(record(nativeInput.parties) ?? {}).length > 0;
  const billingRequested = typeof nativeInput.billingReference === 'string';
  const success = native.outcome === 'saved' && native.writerSessionClosed === true &&
    native.save?.dispatchCallbacksDrained === true && /^\d{6,10}-\d{1,2}$/.test(confirmation) &&
    Array.isArray(fields) && Array.isArray(native.readback?.mismatches) && native.readback.mismatches.length === 0 &&
    (!partiesRequested || record(native.readback?.partyProof)?.outcome === 'verified') &&
    (!billingRequested || native.save?.billingReferenceStaged === true) && priceMatches(savedPrice, prepared.price);
  if (!success) {
    const uncertain = nativeObservation(loaded.draft, input, native, 'partial', {
      dispatchHoldId: dispatchHandle.holdId, confirmation: confirmation || null, nativeOutcome: native.outcome ?? 'unknown',
      issue: native.issue ?? (priceMatches(savedPrice, prepared.price) ? 'create_readback_unverified' : 'saved_price_mismatch'),
      pricePlanExpected: prepared.price, priceReadback: savedPrice, nativeReadback: native.readback ?? null,
      prepareObservationRef: prepared.observation.ref,
    });
    const savedResult = await recordNativeObservation(ctx, input, uncertain, 'unknown',
      'Create Save may have dispatched; fresh reconciliation required', input.idempotencyKey);
    return { status: 'needs_reconcile', operationId: input.idempotencyKey, dispatchHoldId: dispatchHandle.holdId,
      issue: savedResult.status === 'ok' ? uncertain.result.nativeOutcome : 'unknown_receipt_persist_failed' };
  }
  const paths = record(native.screenshots);
  const savedShots = await persistSavedScreenshot(ctx, input.workItemId, paths?.before, paths?.after);
  if (!savedShots) {
    const uncertain = nativeObservation(loaded.draft, input, native, 'partial', {
      dispatchHoldId: dispatchHandle.holdId, confirmation, issue: 'saved_screenshot_persist_failed', nativeReadback: native.readback,
      prepareObservationRef: prepared.observation.ref,
    });
    await recordNativeObservation(ctx, input, uncertain, 'unknown', 'Create exists but saved proof is unavailable', input.idempotencyKey);
    return { status: 'needs_reconcile', operationId: input.idempotencyKey, confirmation, dispatchHoldId: dispatchHandle.holdId };
  }
  const successObservation = nativeObservation(loaded.draft, input, native, 'complete', {
    confirmation, requestDigest: prepared.digest, ratePlanAvailability: prepared.price, savedPrice,
    priceMatched: true, nativeReadback: native.readback, savedShot: savedShots.savedShot,
    dispatchHoldId: dispatchHandle.holdId, prepareObservationRef: prepared.observation.ref,
  });
  try {
    await resolveHmsLabtestDispatch(ctx.db, dispatchHandle, { operation: 'create', confirmation,
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
      dispatchHoldId: dispatchHandle.holdId, confirmation, issue: 'durable_create_resolution_unconfirmed',
      nativeReadback: native.readback, savedShot: savedShots.savedShot,
      prepareObservationRef: prepared.observation.ref,
    });
    await recordNativeObservation(ctx, input, uncertain, 'unknown', 'Create readback passed but durable release is unresolved', input.idempotencyKey);
    return { status: 'needs_reconcile', operationId: input.idempotencyKey, confirmation, dispatchHoldId: dispatchHandle.holdId };
  }
  return { status: 'succeeded', operationId: input.idempotencyKey, requestId: input.requestId,
    allocationId: input.allocationId, confirmation, price: savedPrice, observationRef: successObservation.ref };
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
    const observation: ReservationWorkflowV2Observation = {
      ref: randomUUID(), generationId: initial.draft.generationId, kind: 'stay_candidate', status: 'failed', observedAt: new Date().toISOString(),
      propertyCode: initial.draft.propertyCode, sourceMessageId: initial.draft.source.messageId, sourceRefs: [],
      criteria: { workflow: 'create', operationId: input.operationId, sourceHash: input.source.sourceHash },
      coverage: { complete: false, notes: ['durable_create_claim_not_found'] },
      result: { outcome: 'not_dispatched', issue: 'No durable HMS Create claim exists for this Go.' },
    };
    const current = await getReservationWorkflowV2Draft(stateContext(ctx), input);
    if (current.status !== 'ok') return current;
    const base = { workItemId: input.workItemId, source: input.source,
      expectedRevision: current.revision, expectedSeq: current.seq };
    const appended = await appendReservationWorkflowV2Observation(stateContext(ctx), { ...base, observation });
    if (appended.status !== 'ok') return appended;
    const failed = await recordReservationWorkflowV2Result(stateContext(ctx), { ...base, result: {
      id: input.operationId, generationId: current.draft.generationId, requestId: result.requestId, allocationId: result.allocationId,
      workflow: 'create', status: 'failed', draftRevision: result.draftRevision, observationRefs: [observation.ref],
      updatedAt: new Date().toISOString(), summary: 'No durable claim; Save was not dispatched',
    } });
    return failed.status === 'ok' ? { status: 'failed', operationId: input.operationId, issue: 'create_not_dispatched' } : failed;
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


