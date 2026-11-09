import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
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
  lockReservationWorkflowV2Source,
  recordReservationWorkflowV2Result,
  reservationWorkflowV2DraftOf,
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
import { hmsDispatchTargetSchema, type HmsDispatchTarget } from './hms-dispatch-target.js';
import { persistHmsShots, readStoredHmsShot, verifyStoredHmsShot } from './hms-shots-store.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import { acquisitionWithin, PANE_PROPERTY_LOCK_WAIT_MS, isPropertyReadLockDeadline } from '../hms/property-read-lock.js';
import { paneStayCloudTargetLock, paneStayCreateTarget, paneStayPropertyLock, paneWriteMode } from './pane-stay-save.js';
import { findStay, paneStayLookupEnabled } from './pane-stay-lookup.js';
import { projectCloudStayFind, runCloudStayFind } from './hms-cloud-saved-stay-find.js';
import { createCloudTargetKey, isLabtestGuest } from '../../tooling/hms-cloud/cloud-create-policy.mjs';
import { lockCreateActorSession } from './pane-create-actor-lock.js';
import { stayCommitsOf } from './work-items.js';
import { sameGuestName } from './guest-name-match.js';
import { quoteRateContextEnabled } from './quote-rate-switch.js';

type V2StateContext = ReservationWorkflowV2Context;
export type ReservationWorkflowV2ServerContext = {
  db: DB;
  transport: { id: string };
  user: { id: string; sessionId?: string; sessionProfile?: 'legacy' | 'remote' };
  property: { propertyCode: string };
  /** Internal service-only scope; never populated from a pane request. */
  nativeBatch?: ReservationNativeCheckBatch;
  /** Internal reconciliation-only scope; never populated from a pane request. */
  recovery?: ReservationRecoveryScope;
};

/** Trusted arrival reads are fenced by their native batch and have no staff identity. */
export type ReservationWorkflowV2SystemReadContext = {
  kind: 'arrival-system-read';
  db: DB;
  transport: { id: string };
  property: { propertyCode: string };
  nativeBatch: ReservationNativeCheckBatch;
  user?: never;
  recovery?: never;
};
export type ReservationWorkflowV2ReadContext = ReservationWorkflowV2ServerContext | ReservationWorkflowV2SystemReadContext;

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

function stateContext(ctx: ReservationWorkflowV2ReadContext): V2StateContext {
  return { db: ctx.db, transportId: ctx.transport.id, userId: ctx.nativeBatch ? null : ctx.user!.id,
    propertyCode: ctx.property.propertyCode, nativeBatch: ctx.nativeBatch, recovery: ctx.recovery };
}

async function currentDraft(ctx: ReservationWorkflowV2ReadContext, input: {
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
    if (override.state === 'inherit') return record(sourceValue)?.kind === 'none'
      ? { value: undefined, path, unset: true } : { value: sourceValue, path };
  }
  if (sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue) &&
      (sourceValue as { kind?: unknown }).kind === 'none') return { value: undefined, path, unset: true };
  return { value: sourceValue, path };
}

export function effectiveSubtree(draft: ReservationWorkflowV2Draft, source: unknown, path: string): unknown {
  const resolved = leaf(draft, path, source);
  if ('issue' in resolved) return null;
  if (resolved.unset) return { kind: 'none' };
  const value = resolved.value;
  if (Array.isArray(value)) return value.map((item, index) => effectiveSubtree(draft, item, `${path}/${index}`));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, effectiveSubtree(draft, item, `${path}/${encodeURIComponent(key)}`)]));
  return value;
}

function accepted(draft: ReservationWorkflowV2Draft, path: string): boolean {
  return draft.fieldReviewRequirements[path]?.required === false || draft.staffReviews[path]?.status === 'accepted';
}

export function reviewed(draft: ReservationWorkflowV2Draft, path: string, value: unknown): string | null {
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
  const hostAdmitted = observation?.kind === allowedKind && observation.status === 'complete' && observation.coverage.complete &&
    observation.generationId === draft.generationId && observation.propertyCode === draft.propertyCode && observation.sourceMessageId === draft.source.messageId &&
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
  if (!observation || !observation.coverage.complete || observation.generationId !== draft.generationId ||
      observation.propertyCode !== draft.propertyCode || observation.sourceMessageId !== draft.source.messageId || observation.criteria.requestId !== requestId ||
      (observation.criteria.allocationId !== allocationId && !(allowSharedScope &&
        typeof observation.criteria.allocationId === 'string')) || (observation.criteria.fieldPath !== fieldPath &&
        !(Array.isArray(observation.criteria.fieldPaths) && observation.criteria.fieldPaths.includes(fieldPath)))) return null;
  const output = observation && record(observation.result);
  if (!output) return null;
  const candidates = getCandidateRows(output).filter((candidate) => {
    const candidateName = candidate.name ?? [candidate.firstName, candidate.lastName].filter(Boolean).join(' ');
    const roleMatches = !role || !observation.criteria.role || observation.criteria.role === role;
    return roleMatches && (kind === 'guest_candidate' ? sameGuestName(candidateName, expectedName) : sameName(candidateName, expectedName));
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

const existingConfirmationPath = (requestId: string) => ptr('proposal', 'content', 'requests', requestId, 'confirmationReference');

function exactSourceConfirmationClaim(draft: ReservationWorkflowV2Draft, path: string) {
  const claims = draft.proposal.sourceClaims.filter((claim) =>
    (claim.path === path || claim.path.startsWith(`${path}/`)) &&
    /^\d{6,10}-\d{1,4}$/.test(claim.raw.trim()) && claim.sourceRefs.length > 0);
  const confirmations = new Set(claims.map((claim) => claim.raw.trim()));
  // PNR/voucher/trip labels do not make an exact hotel confirmation ambiguous.
  // Two different exact confirmations do: never select the first arbitrarily.
  if (confirmations.size !== 1 || !claims[0]) return undefined;
  return { ...claims[0], raw: claims[0].raw.trim(),
    sourceRefs: [...new Set(claims.flatMap((claim) => claim.sourceRefs))].sort() };
}

function sourceConfirmationClaim(draft: ReservationWorkflowV2Draft, requestId: string) {
  const path = existingConfirmationPath(requestId);
  const claims = draft.proposal.sourceClaims.filter((claim) => claim.path === path || claim.path.startsWith(`${path}/`));
  const guarded = draft.proposal.issues.some((issue) =>
    (issue.path === path || issue.path === `/requests/${requestId}/confirmationReference`) &&
    (issue.kind === 'existing_confirmation_requires_lookup' || issue.kind === 'existing_confirmation_requires_review'));
  if (!guarded && claims.length === 0) return { required: false as const, path };
  const claim = exactSourceConfirmationClaim(draft, path);
  if (!claim) {
    return { required: true as const, path, issue: 'existing_confirmation_requires_lookup' as const };
  }
  const observation = [...draft.observations].reverse().find((entry) => entry.kind === 'stay_candidate' &&
    entry.generationId === draft.generationId && entry.propertyCode === draft.propertyCode &&
    entry.sourceMessageId === draft.source.messageId &&
    canonicalJson(entry.criteria.sourceClaimEvidenceRefs) === canonicalJson(claim.sourceRefs) &&
    entry.sourceRefs.some((ref) => draft.observations.some((source) => source.kind === 'source' && source.ref === ref)) &&
    entry.criteria.workflow === 'create_existing_reference_check' && entry.criteria.requestId === requestId &&
    entry.criteria.confirmation === claim.raw && entry.status === 'complete' && entry.coverage.complete === true &&
    entry.result.confirmation === claim.raw && (entry.result.outcome === 'found' || entry.result.outcome === 'not_found'));
  if (!observation) return { required: true as const, path, issue: 'existing_confirmation_requires_lookup' as const };
  if (observation.result.outcome === 'found') return { required: true as const, path, issue: 'existing_confirmation_found' as const };
  return { required: true as const, path, issue: null };
}

function createDispatchAdmission(compiled: Extract<CreateCompile, { outcome: 'ok' }>): { allowed: true; allowRealGuest: boolean } |
  { allowed: false; issue: string } {
  const mode = paneWriteMode('create');
  if (mode === 'off') return { allowed: false, issue: 'pane_save_flag_off' };
  if (process.env.PANE_CLOUD_CREATE_DISPATCH !== 'on') return { allowed: false, issue: 'cloud_create_dispatch_flag_off' };
  const allowRealGuest = !isLabtestGuest(compiled.expectedGuest);
  const input = compiled.nativeInput;
  const stay = record(input.stay), cms = record(input.cms);
  if (allowRealGuest) {
    if (mode !== 'on' || process.env.PANE_WRITE_CREATE !== 'on') {
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
  mode: 'prepare' | 'lookup' | 'execute' = 'prepare'): CreateCompile {
  const request = draft.proposal.content.requests.find((entry) => entry.id === requestId);
  if (!request || request.kind !== 'create') return { outcome: 'needs_input', issue: 'create_request_not_found' };
  const confirmation = sourceConfirmationClaim(draft, requestId);
  if (confirmation.required && confirmation.issue) return { outcome: 'needs_input', issue: confirmation.issue, fields: [confirmation.path] };
  const req = ptr('proposal', 'content', 'requests', requestId, 'body');
  const body = effectiveSubtree(draft, request.body, req) as typeof request.body | null;
  if (!body || !Array.isArray(body.allocations) || !Array.isArray(body.dateSections) || !body.shared) {
    return { outcome: 'needs_input', issue: 'create_body_incomplete' };
  }
  if (body.allocations.length < 1 || body.allocations.length > 8) {
    return { outcome: 'needs_input', issue: 'create_requires_one_to_eight_rooms', fields: [`${req}/allocations`] };
  }
  const allocationIndex = body.allocations.findIndex((entry) => entry.id === allocationId);
  if (allocationIndex < 0) return { outcome: 'needs_input', issue: 'allocation_not_found' };
  const allocation = body.allocations[allocationIndex]!;
  const dateIndex = body.dateSections.findIndex((entry) => entry.id === allocation.dateSectionId);
  if (dateIndex < 0) return { outcome: 'needs_input', issue: 'date_section_not_found' };
  const section = body.dateSections[dateIndex]!;
  if (!allocation.occupancy || !allocation.guest || !allocation.overrides || !section.defaults) {
    return { outcome: 'needs_input', issue: 'allocation_fields_incomplete' };
  }
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
      if (choice.path !== choices[choices.length - 1]!.path && draft.fieldOverrides[choice.path]?.state === 'inherit') continue;
      let source = choice.value;
      if (['bookingAgency', 'organization', 'arAccount'].includes(field) && source == null &&
          !draft.fieldOverrides[choice.path]) {
        const childName = leaf(draft, `${choice.path}/name`, undefined);
        if (!('issue' in childName) && text(childName.value)) source = { name: childName.value, candidateRefs: [], suggestedRef: null } as typeof source;
      }
      const resolved = leaf(draft, choice.path, source);
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
  if (roomTypeForCharge != null && (typeof roomTypeForCharge !== 'string' || !/^[A-Z0-9]{1,12}$/.test(roomTypeForCharge))) {
    issues.push('roomTypeForCharge:invalid_code');
  }
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
    else if (!(path === agesPath && childCount === 0 && Array.isArray(childAges) && childAges.length === 0)) {
      const missingReview = reviewed(draft, path, value); if (missingReview) reviewPaths.add(missingReview);
    }
  }
  if (adults !== null && (!Number.isInteger(adults) || adults < 1)) issues.push(`${adultsPath}:invalid`);
  if (childCount !== null && (!Number.isInteger(childCount) || childCount < 0)) issues.push(`${childrenPath}:invalid`);
  if (childAges !== null && (!Array.isArray(childAges) || !childAges.every((age) => Number.isInteger(age) && age !== null && age >= 0 && age <= 17) ||
      (childCount !== null && childCount !== childAges.length))) issues.push(`${agesPath}:invalid`);
  const guestPath = ptr(...alloc.slice(1).split('/').map(decodeURIComponent), 'guest');
  const guest = allocation.guest;
  const firstName = text(guest.firstName), lastName = text(guest.lastName);
  for (const [key, value] of [['firstName', firstName], ['lastName', lastName]] as const) {
    const path = ptr(...guestPath.slice(1).split('/').map(decodeURIComponent), key);
    if (!value) issues.push(`${path}:required`);
    else { const missingReview = reviewed(draft, path, value); if (missingReview) reviewPaths.add(missingReview); }
  }
  if (mode !== 'lookup' && guest.profileIntent !== 'existing_or_unknown') {
    issues.push(`${guestPath}:new_profile_creation_required`);
  }
  const guestRefPath = ptr(...guestPath.slice(1).split('/').map(decodeURIComponent), 'nativeSelectionRef');
  const selectedGuestValue = leaf(draft, guestRefPath, guest.suggestedRef);
  const selectedGuestRef = 'issue' in selectedGuestValue ? selectedGuestValue
    : chosenObservationRef(draft, guestRefPath, typeof selectedGuestValue.value === 'string' ? selectedGuestValue.value : null,
      'guest_candidate', requestId, allocationId);
  let guestCandidate: Record<string, unknown> | null = null;
  if (typeof selectedGuestRef === 'string' && firstName && lastName) {
    guestCandidate = candidateFromObservation(draft, 'guest_candidate', selectedGuestRef, `${firstName} ${lastName}`,
      undefined, requestId, allocationId, guestRefPath);
    if (guestCandidate && (!sameGuestName(guestCandidate.firstName, firstName) || !sameGuestName(guestCandidate.lastName, lastName) ||
        (text(guest.email) && !sameName(guestCandidate.email, guest.email)) || !text(guestCandidate.nativeId))) guestCandidate = null;
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
  if (mode !== 'lookup' && !text(optional.sourceOfBusiness)) issues.push('sourceOfBusiness:native_required');
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
    room: { roomType, ratePlan, ...(roomTypeForCharge != null ? { roomTypeForCharge } : {}) }, guaranteeType,
    ...(optional.sourceOfBusiness != null ? { sourceOfBusiness: optional.sourceOfBusiness } : {}),
    ...(optional.reasonForStay != null ? { reasonForStay: optional.reasonForStay } : {}),
    ...(Object.keys(nativeParties).length ? { parties: nativeParties } : {}),
    note: optional.reservationNote ?? '',
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
  const targetParsed = hmsDispatchTargetSchema.safeParse({ propertyCode: 'HRCEN', kind: 'create',
    firstName: expectedGuest.firstName, lastName: expectedGuest.lastName, arrival });
  if (!targetParsed.success || targetParsed.data.kind !== 'create') return { outcome: 'needs_input', issue: 'invalid_create_target' };
  // The exact binding is only available after HMS has staged and read back the fields.
  return { outcome: 'ok', nativeInput, expectedGuest, target: targetParsed.data,
    reviewPaths: [...reviewPaths], partySelectionPaths,
    semanticDigest: sha256({ nativeInput, guestName }), preparedBinding: null };
}

/** Reuse the same Create field compiler when a service preview needs its owning unsaved stay. */
export function compileReservationWorkflowV2Create(draft: ReservationWorkflowV2Draft, requestId: string,
  allocationId: string, propertyCode: string): CreateCompile {
  return compileCreate(draft, requestId, allocationId, propertyCode, 'prepare');
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

async function recordNativeObservation(ctx: ReservationWorkflowV2ReadContext, input: ReservationWorkflowV2PrepareInput,
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

function verifiedNativeFields(result: unknown): string[] {
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

function partyCandidateViews(candidates: unknown, role: 'agency' | 'organization' | 'ar_account', verifiedFields: string[]) {
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
  tool: 'searchRoomTypes' | 'searchRoomTypesForCharge' | 'searchRatePlans', kind: CreateCatalogueKind): Promise<CreateCatalogueRead> {
  const first = await runTool({ tool, query: '', offset: 0, limit: 100 });
  const coverage = record(first.coverage), criteria = record(first.criteria);
  const matchingLoaded = coverage?.matchingLoaded;
  const loaded = coverage?.loaded;
  const expectedScope = kind !== 'rate_plan' ? 'guest_stay_room_catalog' : 'guest_stay_rate_shop_catalog';
  const allowedOutcome = ['matches', 'no_match', 'incomplete'].includes(String(first.outcome));
  const criteriaValid = criteria?.propertyCode === 'HRCEN' && criteria.scope === expectedScope && criteria.query === '';
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
    if (!['matches', 'incomplete'].includes(String(page.outcome)) || pageCriteria?.propertyCode !== 'HRCEN' ||
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

/** Read current, source-bound v2 observations; callers cannot supply lookup candidates. */
export async function reservationWorkflowV2Lookup(ctx: ReservationWorkflowV2ReadContext,
  input: ReservationWorkflowV2LookupInput): Promise<Outcome> {
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return loaded.result;
  const requests = loaded.draft.proposal.content.requests.filter((request) => !input.requestId || request.id === input.requestId);
  if (input.requestId && !requests.length) return { status: 'not_found' };
  if (ctx.property.propertyCode !== 'HRCEN') return { status: 'unsupported', issue: 'property_not_supported' };
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
    if (claimIsExact && confirmation && ctx.nativeBatch && !paneStayLookupEnabled()) {
      reason = 'stay_lookup_disabled';
    } else if (claimIsExact && confirmation) {
      const targetResult = paneStayCreateTarget({ transportId: ctx.transport.id, propertyCode: ctx.property.propertyCode });
      if (targetResult.ok) {
        try {
          const request = { confirmation };
          const lock = paneStayPropertyLock(targetResult.target);
          const found = ctx.nativeBatch && lock
            ? await lock.withLock(async () => projectCloudStayFind(request,
              await runCloudStayFind({ request, target: targetResult.target, signal: ctx.nativeBatch!.signal })),
            { ...acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS), signal: ctx.nativeBatch.signal })
            : ctx.nativeBatch ? null : await findStay(request, { target: targetResult.target,
              lock: () => paneStayPropertyLock(targetResult.target), acquisition: acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS) });
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
      result: { outcome, confirmation, reason, stay } });
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
    { key: 'agency', field: 'bookingAgency', role: 'agency', tool: 'searchPrimaryBookingAgency', idField: 'travelagencyid', nameField: 'travelagencyname' },
    { key: 'organization', field: 'organization', role: 'organization', tool: 'searchOrganization', idField: 'companyid', nameField: 'companyname' },
    { key: 'arAccount', field: 'arAccount', role: 'ar_account', tool: 'searchArAccount', idField: 'araccountid', nameField: 'araccountname' },
  ] as const;
  const bookingTool = await import(new URL('../../tooling/hms-cloud/booking-lookup-session.mjs', import.meta.url).href) as {
    withBookingLookupSession: (operation: (session: { runTool: (request: Record<string, unknown>) => Promise<Record<string, unknown>> }) =>
      Promise<unknown>, options?: Record<string, unknown>) => Promise<unknown>;
  };
  let sessionResult: Record<string, unknown> | null = null;
  try {
    sessionResult = record(await bookingTool.withBookingLookupSession(async ({ runTool }) => {
      const perAllocation: Outcome[] = [];
      const catalogueTargets: Array<{ requestId: string; allocationId: string; allocationIndex: number }> = [];
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
            const requiredFields = ['guestid', 'firstname', 'lastname', ...(email.outcome === 'value' ? ['emailaddress'] : [])];
            const projected = guestCandidateViews(candidates, verifiedFields);
            const criteria = record(found.criteria);
            const complete = Boolean(['matches', 'no_match'].includes(String(found.outcome)) && found.searchId &&
              criteria?.field === 'lastName' && criteria.query === last.value &&
              coverage?.possiblyTruncated === false && loadedCount !== null && candidates.length === loadedCount &&
              enumerationComplete && requiredFields.every((field) => verifiedFields.includes(field)) && projected.valid &&
              close.outcome === 'closed_unsaved' && email.outcome !== 'unknown');
            guestInfo = { outcome: complete ? found.outcome : 'partial', searchOutcome: found.outcome,
              criteria, coverage, correlation: { verifiedFields }, candidates: projected.rows,
              query: { field: 'lastName', value: last.value, firstName: first.value,
                ...(email.outcome === 'value' ? { email: email.value } : {}) }, closeOutcome: close.outcome };
            if (found.searchId && ['matches', 'no_match'].includes(String(found.outcome))) {
              const suggestedPath = appendPtr(guestPath, 'suggestedRef');
              const selectionPath = appendPtr(guestPath, 'nativeSelectionRef');
              const candidatesForObservation = projected.rows.length ? projected.rows : [null];
              for (const [candidateIndex, candidate] of candidatesForObservation.entries()) {
                nativeObservations.push({ ref: randomUUID(), generationId: loaded.draft!.generationId, kind: 'guest_candidate',
                  status: complete ? 'complete' : 'partial', observedAt: new Date().toISOString(),
                  propertyCode: loaded.draft!.propertyCode, sourceMessageId: loaded.draft!.source.messageId, sourceRefs: [],
                  criteria: { workflow: 'create', kind: 'guest_profile', requestId: request.id, allocationId,
                    fieldPaths: [suggestedPath, selectionPath], query: { field: 'lastName', value: last.value,
                      firstName: first.value, ...(email.outcome === 'value' ? { email: email.value } : {}) },
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
            const found = await runTool({ tool: spec.tool, query: party.name });
            const closed = await runTool({ tool: 'closeGuestStayPartyPicker', propertyCode: ctx.property.propertyCode });
            const coverage = record(found.coverage), verifiedFields = verifiedNativeFields(found);
            const candidates = Array.isArray(found.candidates) ? found.candidates.map(record).filter(Boolean) : [];
            const projected = partyCandidateViews(candidates, spec.role, verifiedFields);
            const criteria = record(found.criteria);
            const complete = ['matches', 'no_match'].includes(String(found.outcome)) && typeof found.searchId === 'string' &&
              criteria?.query === party.name && coverage?.possiblyTruncated === false &&
              typeof coverage.loaded === 'number' && Number.isInteger(coverage.loaded) && candidates.length === coverage.loaded &&
              verifiedFields.includes(spec.idField) && verifiedFields.includes(spec.nameField) && projected.valid &&
              closed.outcome === 'closed_unsaved';
            const info = { outcome: complete ? found.outcome : 'partial', searchOutcome: found.outcome,
              query: party.name, searchId: typeof found.searchId === 'string' ? found.searchId : null,
              criteria, coverage, correlation: { verifiedFields }, candidates: projected.rows,
              closeOutcome: closed.outcome };
            partySearches[spec.key] = info;
            if (found.searchId && ['matches', 'no_match'].includes(String(found.outcome))) {
              const candidatesForObservation = projected.rows.length ? projected.rows : [null];
              for (const [candidateIndex, candidate] of candidatesForObservation.entries()) {
                nativeObservations.push({ ref: randomUUID(), generationId: loaded.draft!.generationId,
                  kind: 'party_candidate', status: complete ? 'complete' : 'partial', observedAt: new Date().toISOString(),
                  propertyCode: loaded.draft!.propertyCode, sourceMessageId: loaded.draft!.source.messageId, sourceRefs: [],
                  criteria: { workflow: 'create', kind: 'party_name', requestId: request.id, allocationId,
                    role: spec.role, fieldPaths: [party.selectionPath], query: party.name, candidateIndex, coverage,
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
          { tool: 'searchRoomTypes', kind: 'room_type' },
          { tool: 'searchRoomTypesForCharge', kind: 'room_type_for_charge' },
          { tool: 'searchRatePlans', kind: 'rate_plan' },
        ] as const) {
          const catalogue = await readCreateCatalogue(runTool, spec.tool, spec.kind);
          const closed = await runTool({ tool: 'closeRoomRatePicker' });
          if (closed.outcome !== 'closed_unsaved') {
            return { lookups: perAllocation, observations: nativeObservations, catalogues,
              sessionSafe: false, issue: 'native_catalogue_picker_close_unverified' };
          }
          catalogues.push({ kind: catalogue.kind, outcome: catalogue.outcome, complete: catalogue.complete,
            candidateCount: catalogue.candidates.length, coverage: catalogue.coverage, issue: catalogue.issue });
          for (const target of uniqueTargets) nativeObservations.push(
            createCatalogueObservation(loaded.draft!, target, catalogue, closed.outcome));
        }
        for (const spec of [
          { field: 'guaranteeType', kind: 'guarantee' }, { field: 'reasonForStay', kind: 'reason_for_stay' },
        ] as const) {
          const listed = await runTool({ tool: 'listGuestStayDropdown', propertyCode: ctx.property.propertyCode, field: spec.field });
          const options = Array.isArray(listed.options) ? listed.options.map(record).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
          const supportedGuarantees = new Set(['AVOUCH', 'CNFREC', 'DEPREQ', 'GRPDEF', 'GTDAGT', 'GTDCMP', 'GTDCC', 'GTDDEP', 'NGG', 'NGI']);
          const choices = options.flatMap((item) => {
            const code = text(item.value) ?? (typeof item.value === 'number' ? String(item.value) : null), label = text(item.label);
            return code && label && (spec.field !== 'guaranteeType' || supportedGuarantees.has(code)) ? [{ code, label }] : [];
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
    }, { memory: null, blockServiceWorkers: true, signal: ctx.nativeBatch?.signal }));
  } catch {
    return { status: 'failed', issue: 'native_create_lookup_failed', requestId: input.requestId ?? null };
  }
  if (!sessionResult || sessionResult.sessionSafe !== true || !Array.isArray(sessionResult.observations) ||
      !Array.isArray(sessionResult.lookups)) {
    return { status: 'failed', issue: 'native_lookup_session_not_clean', requestId: input.requestId ?? null,
      lookups: sessionResult?.lookups ?? [] };
  }
  const observations = sessionResult.observations.filter((item): item is ReservationWorkflowV2Observation => {
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
    requests, lookups: sessionResult.lookups, catalogues: sessionResult.catalogues ?? [],
    observations: [...fresh.draft.observations, ...observations], operationResults: fresh.draft.operationResults };
}

/** Compile one reviewed room against host-admitted IDs, then ask HMS for live unsaved availability. */
export async function reservationWorkflowV2Prepare(ctx: ReservationWorkflowV2ReadContext,
  input: ReservationWorkflowV2PrepareInput): Promise<Outcome> {
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return loaded.result;
  if (!input.allocationId) return { status: 'needs_input', issue: 'allocation_required' };
  const compiled = compileCreate(loaded.draft, input.requestId, input.allocationId, ctx.property.propertyCode);
  if (compiled.outcome !== 'ok') return { status: compiled.outcome, issue: compiled.issue, fields: compiled.fields ?? [] };
  try {
    const tool = await import(new URL('../../tooling/hms-cloud/create-reservation.mjs', import.meta.url).href) as {
      createReservation: (input: Record<string, unknown>, options: Record<string, unknown>) => Promise<NativeCreate>;
    };
    const session = ctx.nativeBatch ? await import(new URL('../../tooling/hms-cloud/booking-lookup-session.mjs', import.meta.url).href) as {
      withBookingLookupSession: (callback: unknown, options: Record<string, unknown>) => Promise<unknown>;
    } : null;
    const native = await tool.createReservation(compiled.nativeInput, { allowRealGuest: true, expectedGuest: compiled.expectedGuest,
      cloudTargetKey: createCloudTargetKey(compiled.expectedGuest, record(compiled.nativeInput.stay)?.arrival),
      requireExplicitGuestSelection: true, capturePrepareScreenshot: true, allowCommitOnlyBillingReference: true,
      ...(session ? { withSession: (callback: unknown, options: Record<string, unknown>) =>
        session.withBookingLookupSession(callback, { ...options, signal: ctx.nativeBatch!.signal }) } : {}) });
    ctx.nativeBatch?.signal.throwIfAborted();
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

async function persistNativeShots(ctx: ReservationWorkflowV2ReadContext, workItemId: string,
  runId: string, paths: Partial<Record<'before.png' | 'filled.png' | 'saved.png', unknown>>) {
  const entries = Object.entries(paths).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  if (!entries.length) return null;
  const stage = await mkdtemp(join(tmpdir(), 'reservation-v2-shots-'));
  const owner = ctx.nativeBatch ? `arrival-service:${ctx.nativeBatch.jobFence.runId}:${ctx.transport.id}` : `${ctx.user!.id}:${ctx.transport.id}`;
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

async function persistPreparedScreenshot(ctx: ReservationWorkflowV2ReadContext, workItemId: string, path: unknown) {
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
    entry.allocationId === allocationId && entry.workflow === 'create' && entry.status === 'prepared' &&
    entry.generationId === draft.generationId &&
    entry.draftRevision <= draft.revision);
  if (!result) return null;
  const observation = draft.observations.find((item) => result.observationRefs.includes(item.ref) &&
    item.kind === 'rate_availability' && item.status === 'complete' && item.generationId === draft.generationId);
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

/** Price currentness depends on native business values, not the staff review revision. */
export function reservationWorkflowV2PreparationViews(draft: ReservationWorkflowV2Draft, propertyCode: string) {
  return draft.proposal.content.requests.flatMap((request) => {
    if (request.kind !== 'create') return [];
    const body = effectiveSubtree(draft, request.body, ptr('proposal', 'content', 'requests', request.id, 'body')) as typeof request.body | null;
    if (!body || !Array.isArray(body.allocations)) return [];
    return body.allocations.map((allocation) => {
      const compiled = compileCreate(draft, request.id, allocation.id, propertyCode, 'prepare');
      if (compiled.outcome !== 'ok') return { requestId: request.id, allocationId: allocation.id,
        current: false, issue: compiled.issue };
      const prepared = preparedFor(draft, request.id, allocation.id, compiled.semanticDigest);
      return { requestId: request.id, allocationId: allocation.id, current: Boolean(prepared),
        ...(prepared ? { price: prepared.price } : {}) };
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
    room.roomType === expectedRoom.roomType && room.ratePlan === expectedRoom.ratePlan &&
    room.roomTypeForCharge === expectedRoom.roomTypeForCharge;
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

/** A one-use native proof permits a failure receipt even if the email or access changed after the claim. */
async function persistNeverDispatchedCreate(tx: Parameters<Parameters<DB['transaction']>[0]>[0], ctx: ReservationWorkflowV2ServerContext,
  input: ReservationWorkflowV2ExecuteInput, intent: Readonly<HmsLabtestIntent>, generationId: string, approvedDigest: string) {
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
  await tx.update(workItem).set({ state: { ...item.state, reservationWorkflowV2: nextDraft }, updatedAt: new Date() })
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
      compiled.semanticDigest !== semanticDigest || !prepared || prepared.digest !== expectedDigest || operation ||
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
  await tx.update(workItem).set({ state: { ...item.state, reservationWorkflowV2: nextDraft }, updatedAt: new Date() })
    .where(eq(workItem.id, input.workItemId));
  await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
    fieldPath: `reservationWorkflowV2:operationResults:${result.id}`,
    value: { id: result.id, requestId, allocationId, workflow: 'create', status: result.status,
      observationRefs: result.observationRefs },
    evidence: { sourceHash: input.source.sourceHash, seq: input.expectedSeq, summary: result.summary } });
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
    (input.track === undefined || input.track === record(bound.track)?.lookupCode || input.track === record(bound.track)?.display) &&
    (input.guestoptin4 !== false || bound.guestOptIn === false) &&
    (input.booker === undefined || canonicalJson(bound.booker) === canonicalJson(input.booker)) &&
    (input.cms === undefined || (record(bound.sendHmsConfirmation)?.kind === (record(input.cms)?.send === true ? 'send' : 'never') &&
      (record(input.cms)?.send !== true || (bound.cmsMessageId === record(input.cms)?.messageId &&
        bound.cmsRecipient === record(input.cms)?.recipient))));
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
  if (compiled.outcome !== 'ok') return { status: compiled.outcome, issue: compiled.issue, fields: compiled.fields ?? [] };
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
  if (!propertyTarget.ok || propertyTarget.target.propertyCode !== 'HRCEN' || propertyTarget.target.browserSlot !== 'centurion') {
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
    verifyBatchSiblings: (census: unknown, siblings: Array<{ confirmation: string; approvedRequest: Record<string, unknown>;
      requestDigest: string }>, options?: Record<string, unknown>) => Promise<boolean>;
  } : null;
  const nativeInput: Record<string, unknown> = { ...compiled.nativeInput, mode: 'commit' };
  let dispatchHandle: HmsLabtestWriteHandle | null = null;
  let releaseProvedNeverDispatched = false;
  let claimIssue: string | null = null;
  let priorSiblingsVerified = false;
  const liveOptions: Record<string, unknown> = {
    allowRealGuest: admission.allowRealGuest, expectedGuest: compiled.expectedGuest,
    cloudTargetKey: createCloudTargetKey(compiled.expectedGuest, record(compiled.nativeInput.stay)?.arrival),
    expectedRequestDigest: prepared.digest, expectedRateAvailability: prepared.price,
    allowCommitOnlyBillingReference: true,
    ...(siblingVerifier ? { verifyLabtestMatches: async (census: unknown) => {
      priorSiblingsVerified = await siblingVerifier.verifyBatchSiblings(census, priorSiblings,
        { cloudTargetKey: createCloudTargetKey(compiled.expectedGuest, record(compiled.nativeInput.stay)?.arrival) });
      return priorSiblingsVerified;
    } } : {}),
    authorizeCandidate: async () => {
      const current = await currentDraft(ctx, input);
      if (!current.draft) return false;
      const live = compileCreate(current.draft, input.requestId, input.allocationId!, ctx.property.propertyCode, 'execute');
      const liveAdmission = live.outcome === 'ok' ? createDispatchAdmission(live) : null;
      const livePrepared = live.outcome === 'ok' && preparedFor(current.draft, input.requestId,
        input.allocationId!, live.semanticDigest);
      return live.outcome === 'ok' && liveAdmission?.allowed === true && live.semanticDigest === compiled.semanticDigest &&
        Boolean(livePrepared && livePrepared.digest === prepared.digest && priceMatches(livePrepared.price, prepared.price));
    },
    dispatchCandidate: async (request: unknown, next: NativeContinuation, evidence: unknown) => {
      const requestDigest = nativeCreateSaveDigest(request);
      if (!nativeInputMatchesBinding(compiled, prepared.request)) throw new Error('reservation_v2_native_binding_changed');
      const event = record(evidence), beforePath = event?.beforeScreenshot, preimage = record(event?.preimage);
      if (priorSiblings.length) {
        const sameArrival = Array.isArray(preimage?.sameArrival) ? preimage.sameArrival.map(record)
          .filter((row): row is Record<string, unknown> => row !== null) : [];
        if (!priorSiblingsVerified || preimage?.verifiedExisting !== true || sameArrival.length !== priorSiblings.length ||
            priorSiblings.some((sibling) => !sameArrival.some((row) => row.confirmation === sibling.confirmation))) {
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
          grantId: input.idempotencyKey, propertyCode: 'HRCEN', firstName: compiled.expectedGuest.firstName,
          lastName: compiled.expectedGuest.lastName, target: targetResult.data, nativeGuestId: String(record(nativeInput.guest)?.profileId),
          operation: 'create', stayId: `${input.requestId}_${input.allocationId}`,
          sourceDigest: input.source.sourceHash, approvedDigest: prepared.digest, requestDigest,
          recovery: { request: prepared.request, requestId: input.requestId, allocationId: input.allocationId,
            operationId: input.idempotencyKey, draftRevision: input.expectedRevision,
            previewShot, beforeShot, preimage, guaranteeDisplay: event.guaranteeDisplay,
            ratePlanAvailability: prepared.price, arAccountProfileId: prepared.arAccountProfileId,
            priorRoomConfirmations: priorSiblings.map(({ confirmation, requestDigest }) => ({ confirmation, requestDigest })) },
        }, async (tx) => authorizeCurrentCreate(tx, ctx, input, prepared.digest, compiled.semanticDigest,
          input.requestId, input.allocationId!, priorSiblings, attempt), expectedEpoch);
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
      try { return await next(); }
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
  try { native = await targetLock.withLock(() => nativeModule.createReservation(nativeInput, liveOptions),
    acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS)); }
  catch (error) { native = { outcome: 'uncertain', issue: isPropertyReadLockDeadline(error) ? 'create_lock_busy' : 'native_create_invocation_failed' }; }
  if (claimIssue) return { status: 'needs_reconcile', issue: claimIssue };
  const activeDispatch = dispatchHandle as HmsLabtestWriteHandle | null;
  if (!activeDispatch) return { status: releaseProvedNeverDispatched ? 'failed' : 'refused',
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


