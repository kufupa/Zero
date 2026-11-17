import { z } from 'zod';
import type { ReservationWorkflowV2Draft } from './reservation-workflow-v2-contract.js';
import type { ReadinessItem } from './reservation-workflow-v2-readiness.js';
import { sameGuestName } from './guest-name-match.js';
import { extractionRequestForProposal } from './reservation-workflow-v2-source-match.js';
import { formatBookerContact } from './reservation-workflow-v2-booker-contact.js';

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const sameName = (left: unknown, right: unknown): boolean => typeof left === 'string' && typeof right === 'string' &&
  left.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase() ===
  right.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
const samePhone = (left: unknown, right: unknown): boolean => typeof left === 'string' && typeof right === 'string' &&
  Boolean(left.replace(/\D/g, '')) && left.replace(/\D/g, '') === right.replace(/\D/g, '');
const ptr = (...parts: Array<string | number>): string => `/${parts.map(part => encodeURIComponent(String(part))).join('/')}`;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
});

type CreateCore = { outcome: 'ok'; nativeInput: Record<string, unknown>; expectedGuest: { firstName: string; lastName: string };
  reviewPaths: string[]; partySelectionPaths: Record<string, string>; requestedMealPlan: string | null; mealPlan: string | null } |
  { outcome: 'needs_input' | 'needs_review' | 'unsupported'; issue: string; fields?: string[]; details?: CreateCompileIssueDetail[] };

type ResolvedLeaf = { value: unknown; path: string; unset?: boolean };
export function leaf(draft: ReservationWorkflowV2Draft, path: string, sourceValue: unknown): ResolvedLeaf | { issue: string } {
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

function staffSelectedIdentity(draft: ReservationWorkflowV2Draft, path: string, ref: string): boolean {
  const override = draft.fieldOverrides[path];
  if (draft.staffReviews[path]?.status === 'flagged') return false;
  return (override?.state === 'set' && override.value === ref) || draft.staffReviews[path]?.status === 'accepted';
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

export type CreateCompileIssueDetail = { path: string; code: string; expected?: number; actual?: number;
  allocationIds?: string[]; unresolvedAllocationIds?: string[] };

export type CreateRequestBody = Extract<ReservationWorkflowV2Draft['proposal']['content']['requests'][number], { kind: 'create' }>['body'];

function createTotalsIssues(body: CreateRequestBody, requestPath: string): CreateCompileIssueDetail[] {
  const issues: CreateCompileIssueDetail[] = [];
  const sectionCounts = new Map<string, number>();
  for (const section of body.dateSections) sectionCounts.set(section.id, (sectionCounts.get(section.id) ?? 0) + 1);
  for (const [index, section] of body.dateSections.entries()) {
    const sectionPath = ptr(...requestPath.slice(1).split('/').map(decodeURIComponent), 'dateSections', index);
    const allocations = body.allocations.filter((allocation) => allocation.dateSectionId === section.id);
    const allocationIds = allocations.map((allocation) => allocation.id);
    if (sectionCounts.get(section.id) !== 1) {
      issues.push({ path: `${sectionPath}/id`, code: 'duplicate_date_section_id', allocationIds });
      continue;
    }
    if (section.requestedRooms != null) {
      if (!Number.isSafeInteger(section.requestedRooms) || section.requestedRooms < 0) {
        issues.push({ path: `${sectionPath}/requestedRooms`, code: 'requested_room_count_invalid', allocationIds });
      } else if (section.requestedRooms !== allocations.length) {
        issues.push({ path: `${sectionPath}/requestedRooms`, code: 'requested_room_count_mismatch',
          expected: section.requestedRooms, actual: allocations.length, allocationIds });
      }
    }
    for (const field of ['adults', 'childCount'] as const) {
      const expected = section.requestedTotals[field];
      if (expected == null) continue; // Unknown source totals are not zero.
      const totalPath = `${sectionPath}/requestedTotals/${field}`;
      if (!Number.isSafeInteger(expected) || (field === 'adults' ? expected < 1 : expected < 0)) {
        issues.push({ path: totalPath, code: 'requested_occupancy_total_invalid', allocationIds });
        continue;
      }
      const unresolved = allocations.filter((allocation) => {
        const value = allocation.occupancy?.[field];
        return value == null || !Number.isSafeInteger(value) || (field === 'adults' ? value < 1 : value < 0);
      }).map((allocation) => allocation.id);
      if (unresolved.length) {
        issues.push({ path: totalPath, code: 'requested_occupancy_total_unresolved', expected,
          allocationIds, unresolvedAllocationIds: unresolved });
        continue;
      }
      const actual = allocations.reduce((sum, allocation) => sum + allocation.occupancy[field]!, 0);
      if (actual !== expected) issues.push({ path: totalPath, code: 'requested_occupancy_total_mismatch',
        expected, actual, allocationIds });
    }
  }
  const ids = new Set<string>();
  for (const [index, allocation] of body.allocations.entries()) {
    if (ids.has(allocation.id)) issues.push({ path: `${requestPath}/allocations/${index}/id`, code: 'duplicate_allocation_id' });
    ids.add(allocation.id);
    if (sectionCounts.get(allocation.dateSectionId) !== 1) issues.push({
      path: ptr(...requestPath.slice(1).split('/').map(decodeURIComponent), 'allocations', index, 'dateSectionId'),
      code: 'allocation_date_section_invalid', allocationIds: [allocation.id] });
  }
  return issues;
}

export const existingConfirmationPath = (requestId: string) => ptr('proposal', 'content', 'requests', requestId, 'confirmationReference');

export function exactSourceConfirmationClaim(draft: ReservationWorkflowV2Draft, path: string) {
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

export function sourceConfirmationClaim(draft: ReservationWorkflowV2Draft, requestId: string) {
  const path = existingConfirmationPath(requestId);
  const claims = draft.proposal.sourceClaims.filter((claim) => claim.path === path || claim.path.startsWith(`${path}/`));
  const capacityExceeded = draft.proposal.issues.some((issue) => issue.path === path &&
    issue.kind === 'confirmation_claim_capacity_exceeded');
  if (capacityExceeded) {
    return { required: true as const, path, issue: 'confirmation_claim_capacity_exceeded' as const };
  }
  const guarded = draft.proposal.issues.some((issue) =>
    (issue.path === path || issue.path === `/requests/${requestId}/confirmationReference`) &&
    (issue.kind === 'existing_confirmation_requires_lookup' || issue.kind === 'existing_confirmation_requires_review'));
  const citesNativeConfirmation = claims.some((claim) => /\b\d{6,10}-\d{1,4}\b/.test(claim.raw));
  if (!guarded && !citesNativeConfirmation) return { required: false as const, path };
  const claim = exactSourceConfirmationClaim(draft, path);
  if (!claim) {
    return { required: true as const, path, issue: 'existing_confirmation_requires_lookup' as const };
  }
  const observation = [...draft.observations].reverse().find((entry) => entry.kind === 'stay_candidate' &&
    entry.generationId === draft.generationId && entry.propertyCode === draft.propertyCode &&
    entry.sourceMessageId === draft.source.messageId &&
    JSON.stringify(entry.criteria.sourceClaimEvidenceRefs) === JSON.stringify(claim.sourceRefs) &&
    entry.sourceRefs.some((ref) => draft.observations.some((source) => source.kind === 'source' && source.ref === ref)) &&
    entry.criteria.workflow === 'create_existing_reference_check' && entry.criteria.requestId === requestId &&
    entry.criteria.confirmation === claim.raw && entry.status === 'complete' && entry.coverage.complete === true &&
    entry.result.confirmation === claim.raw && (entry.result.outcome === 'found' || entry.result.outcome === 'not_found'));
  if (!observation) return { required: true as const, path, issue: 'existing_confirmation_requires_lookup' as const };
  if (observation.result.outcome === 'found') return { required: true as const, path, issue: 'existing_confirmation_found' as const };
  return { required: true as const, path, issue: null };
}

export function compileCreateCore(draft: ReservationWorkflowV2Draft, requestId: string, allocationId: string, propertyCode: string,
  mode: 'prepare' | 'background_prepare' | 'lookup' | 'execute' = 'prepare', propertySupported = true): CreateCore {
  const request = draft.proposal.content.requests.find((entry) => entry.id === requestId);
  if (!request || request.kind !== 'create') return { outcome: 'needs_input', issue: 'create_request_not_found' };
  const confirmation = sourceConfirmationClaim(draft, requestId);
  if (confirmation.required && confirmation.issue) return { outcome: 'needs_input', issue: confirmation.issue, fields: [confirmation.path] };
  const req = ptr('proposal', 'content', 'requests', requestId, 'body');
  const body = effectiveSubtree(draft, request.body, req) as typeof request.body | null;
  if (!body || !Array.isArray(body.allocations) || !Array.isArray(body.dateSections) || !body.shared) {
    return { outcome: 'needs_input', issue: 'create_body_incomplete' };
  }
  if (mode !== 'lookup') {
    const totalsIssues = createTotalsIssues(body, req);
    if (totalsIssues.length) return { outcome: 'needs_input', issue: 'create_requested_totals_conflict',
      fields: totalsIssues.map((item) => item.path), details: totalsIssues };
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
  const roomTypeValue = readValue('roomType', true);
  const ratePlanValue = readValue('ratePlan', true);
  readValue('guaranteeType', true);
  if (mode !== 'lookup') {
    for (const [field, value, max] of [['roomType', roomTypeValue, 200], ['ratePlan', ratePlanValue, 100]] as const) {
      if (value == null) continue;
      if (typeof value !== 'string' || value.trim() !== value || !value.length || value.length > max || /[\r\n]/.test(value)) {
        issues.push(`${field}:native_text_limit`);
      } else if (!/^[A-Z0-9]{1,12}$/.test(value)) {
        issues.push(`${field}:native_code_not_commit_safe`);
      }
    }
  }
  const requestedMealPlan = readValue('requestedMealPlan');
  const mealPlan = readValue('mealPlan');
  for (const [field, value] of [['requestedMealPlan', requestedMealPlan], ['mealPlan', mealPlan]] as const) {
    if (value != null && (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\p{Cc}]/u.test(value))) {
      issues.push(`${field}:invalid_value`);
    }
  }
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
  const extracted = draft.extraction && extractionRequestForProposal(request, draft.proposal.content.requests, draft.extraction);
  const requestIndex = draft.proposal.content.requests.indexOf(request);
  const ageAlias = `/proposal/content/requests/${requestIndex}/body/allocations/${allocationIndex}/occupancy/childAges`;
  const ageOverridden = Object.entries(draft.fieldOverrides).some(([path, override]) => override.state !== 'inherit' &&
    [agesPath, ageAlias].some(target => path === target || target.startsWith(`${path}/`)));
  const childEvidence = extracted?.occupancy.some(row => row.childCount && row.childCount.value !== 0 || row.childAges?.length);
  const completeSource = draft.observations.some(row => row.kind === 'source' && row.status === 'complete' &&
    row.coverage.complete && row.generationId === draft.generationId && row.propertyCode === draft.propertyCode &&
    row.sourceMessageId === draft.source.messageId && row.result.textCoverageComplete === true);
  const ageClaims = draft.proposal.sourceClaims?.some(claim => claim.path.includes('/occupancy/') && claim.path.includes('/childAges'));
  const occupancyConflict = draft.proposal.issues?.some(issue => issue.kind.includes('occupancy') &&
    (issue.path?.includes(`/requests/${requestId}/`) || issue.path?.includes(`/requests/${encodeURIComponent(requestId)}/`)));
  const childAges = allocation.occupancy.childAges === null && childCount === 0 && !ageOverridden && !childEvidence &&
    !occupancyConflict && !ageClaims && completeSource && extracted ? [] : allocation.occupancy.childAges;
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
        (text(guest.email) && !sameName(guestCandidate.email, guest.email)) ||
        (text(guest.mobile) && !samePhone(guestCandidate.phoneNumber ?? guestCandidate.mobile, guest.mobile)) || !text(guestCandidate.nativeId))) guestCandidate = null;
  } else if (mode !== 'lookup') issues.push(`${guestPath}:existing_profile_selection_required`);
  if (!guestCandidate && mode !== 'lookup') issues.push(`${guestPath}:native_profile_unverified`);
  const selectedGuestRefValue = typeof selectedGuestRef === 'string' ? selectedGuestRef : null;
  if (mode === 'background_prepare' && selectedGuestRefValue && !staffSelectedIdentity(draft, guestRefPath, selectedGuestRefValue)) {
    issues.push(`${guestRefPath}:staff_selection_required`);
  }
  if (selectedGuestRefValue && mode === 'execute') {
    const missingReview = reviewed(draft, guestRefPath, selectedGuestRefValue);
    if (missingReview) reviewPaths.add(missingReview);
  }

  const parties: Record<string, ResolvedParty> = {};
  const partyInputs: Record<string, Record<string, unknown> | null> = {};
  const partySelectionPaths: Record<string, string> = {};
  const unlinkedPartyNotes: string[] = [];
  for (const [field, role] of [['bookingAgency', 'bookingAgency'], ['organization', 'organization'], ['arAccount', 'ar_account']] as const) {
    const resolved = valueAt(field);
    if ('issue' in resolved) { issues.push(`${field}:${resolved.issue}`); continue; }
    const raw = resolved.value;
    partyInputs[field] = record(raw);
    partySelectionPaths[field] = ptr(...resolved.path.slice(1).split('/').map(decodeURIComponent), 'nativeSelectionRef');
    if (raw == null || (raw && typeof raw === 'object' && (raw as { kind?: unknown }).kind === 'none')) {
      parties[field] = null; continue;
    }
    if (mode === 'execute') { const missingReview = reviewed(draft, resolved.path, raw); if (missingReview) reviewPaths.add(missingReview); }
    const unlinkedName = field !== 'arAccount' && draft.fieldOverrides[partySelectionPaths[field]!]?.state === 'none'
      ? text(partyInputs[field]?.name) : null;
    if (unlinkedName) {
      unlinkedPartyNotes.push(`${field === 'organization' ? 'Organization' : 'Booking agency'}: ${unlinkedName}`);
      parties[field] = null;
      continue;
    }
    const party = resolveParty(draft, resolved.path, raw, role, requestId, allocationId);
    if (mode === 'background_prepare' && party.selectedRef && party.selectionPath &&
        !staffSelectedIdentity(draft, party.selectionPath, party.selectedRef)) {
      issues.push(`${party.selectionPath}:staff_selection_required`);
    }
    if (mode === 'execute' && party.selectedRef && party.selectionPath) {
      const missingReview = reviewed(draft, party.selectionPath, party.selectedRef);
      if (missingReview) reviewPaths.add(missingReview);
    }
    if (mode !== 'lookup' || party.value) issues.push(...party.issues.map((issue) => `${field}:${issue}`));
    else if (!text(record(raw)?.name)) issues.push(`${field}:name_query_required`);
    parties[field] = party.value;
  }

  const optionalFields = ['sourceOfBusiness', 'reasonForStay', 'billingReference', 'track', 'marketSegment', 'taCommission', 'guestOptIn', 'bookerName',
    'bookerEmail', 'bookerMobile', 'reservationNote', 'cmsSend', 'cmsMessageId', 'cmsRecipient'] as const;
  const optional = Object.fromEntries(optionalFields.map((field) => [field, readValue(field)]));
  if (unlinkedPartyNotes.length && (optional.reservationNote == null || typeof optional.reservationNote === 'string')) {
    optional.reservationNote = [optional.reservationNote, ...unlinkedPartyNotes].filter(Boolean).join('\n');
  }
  if (mode !== 'lookup') {
    const nativeTextFields = [
      ['reasonForStay', optional.reasonForStay, 100], ['billingReference', optional.billingReference, 50], ['bookerName', optional.bookerName, 50],
      ['bookerEmail', optional.bookerEmail, 320], ['bookerMobile', optional.bookerMobile, 120], ['cmsMessageId', optional.cmsMessageId, 100],
      ['cmsRecipient', optional.cmsRecipient, 255],
    ] as const;
    for (const [field, value, max] of nativeTextFields) {
      if (value == null) continue;
      if (field === 'bookerName' && typeof value === 'string' && value.length > 50) {
        issues.push('bookerName:native_booker_name_max_50');
      }
      if (typeof value !== 'string' || value.trim() !== value || !value.length || value.length > max || /[\r\n]/.test(value)) {
        issues.push(`${field}:native_text_limit`);
      }
    }
    if (optional.cmsRecipient != null && (typeof optional.cmsRecipient !== 'string' ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(optional.cmsRecipient))) issues.push('cmsRecipient:invalid_email');
    if (optional.bookerEmail != null && (typeof optional.bookerEmail !== 'string' ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(optional.bookerEmail))) issues.push('bookerEmail:invalid_email');
    if ((optional.bookerEmail != null || optional.bookerMobile != null) &&
        formatBookerContact(text(optional.bookerEmail), text(optional.bookerMobile)) === null) {
      issues.push('bookerContact:native_text_limit');
    }
    if (optional.reservationNote != null && (typeof optional.reservationNote !== 'string' || optional.reservationNote.length > 2_000 ||
        [...optional.reservationNote].some((char) => (char.charCodeAt(0) < 32 && char !== '\n') || char.charCodeAt(0) === 127))) {
      issues.push('reservationNote:native_note_limit');
    }
  }
  for (const field of optionalFields) {
    const resolved = valueAt(field);
    if (mode !== 'lookup' && !('issue' in resolved) && resolved.value != null) {
      const missingReview = reviewed(draft, resolved.path, resolved.value); if (missingReview) reviewPaths.add(missingReview);
    }
  }
  if (mode !== 'lookup' && !text(optional.sourceOfBusiness)) issues.push('sourceOfBusiness:native_required');
  if (mode !== 'lookup' && optional.taCommission != null && (typeof optional.taCommission !== 'number' ||
      !Number.isFinite(optional.taCommission) || optional.taCommission < 0 || optional.taCommission > 100)) {
    issues.push('taCommission:percent_invalid');
  }
  if (mode !== 'lookup' && optional.taCommission != null && !parties.bookingAgency) issues.push('taCommission:booking_agency_required');
  if (mode !== 'lookup' && optional.marketSegment != null &&
      (typeof optional.marketSegment !== 'string' || !/^[A-Z0-9]{1,20}$/.test(optional.marketSegment))) issues.push('marketSegment:invalid_code');
  if (mode !== 'lookup' && optional.billingReference != null && !parties.arAccount) issues.push('billingReference:ar_account_required');
  const supportedGuarantee = new Set(['AVOUCH', 'CNFREC', 'DEPREQ', 'GRPDEF', 'GTDAGT', 'GTDCMP', 'GTDCC', 'GTDDEP', 'NGG', 'NGI']);
  if (typeof arrival !== 'string' || !isoDate.safeParse(arrival).success || typeof departure !== 'string' ||
      !isoDate.safeParse(departure).success || arrival >= departure) issues.push('stay:date_range_invalid');
  if (!propertySupported || draft.propertyCode !== propertyCode) {
    return { outcome: 'unsupported', issue: 'property_not_supported' };
  }
  if (issues.some((issue) => issue.includes('not_supported') || issue.includes('unsupported'))) {
    return { outcome: 'unsupported', issue: 'create_contains_native_unsupported_field', fields: issues };
  }
  if (mode === 'execute' && reviewPaths.size) return { outcome: 'needs_review', issue: 'create_requires_staff_acceptance', fields: [...reviewPaths] };
  if (issues.length) return { outcome: 'needs_input', issue: 'create_input_incomplete', fields: issues };
  const roomType = roomTypeValue as string;
  const ratePlan = ratePlanValue as string;
  const guaranteeType = readValue('guaranteeType') as string;
  if (!supportedGuarantee.has(guaranteeType)) return { outcome: 'unsupported', issue: 'guarantee_not_supported_yet', fields: ['guaranteeType'] };
  if ((!guestCandidate && mode !== 'lookup') || !firstName || !lastName || adults === null || childCount === null || childAges === null) {
    return { outcome: 'needs_input', issue: 'native_create_input_incomplete' };
  }
  const nativeParties: Record<string, unknown> = {};
  if (parties.bookingAgency) { nativeParties.agencyId = parties.bookingAgency.id; nativeParties.agencyName = parties.bookingAgency.name; }
  else if (mode === 'lookup' && draft.fieldOverrides[partySelectionPaths.bookingAgency!]?.state !== 'none' && text(partyInputs.bookingAgency?.name)) nativeParties.agencyName = text(partyInputs.bookingAgency?.name);
  if (parties.organization) { nativeParties.organizationId = parties.organization.id; nativeParties.organizationName = parties.organization.name; }
  else if (mode === 'lookup' && draft.fieldOverrides[partySelectionPaths.organization!]?.state !== 'none' && text(partyInputs.organization?.name)) nativeParties.organizationName = text(partyInputs.organization?.name);
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
    ...(optional.taCommission != null ? { taCommission: optional.taCommission } : {}),
    ...(optional.track != null ? { track: optional.track } : {}),
    ...(optional.marketSegment != null ? { marketSegment: optional.marketSegment } : {}),
    ...(typeof optional.guestOptIn === 'boolean' ? { guestoptin4: optional.guestOptIn } : {}),
    ...(optional.bookerName != null || optional.bookerEmail != null || optional.bookerMobile != null ? { booker: {
      ...(optional.bookerName != null ? { name: optional.bookerName } : {}),
      ...(optional.bookerEmail != null || optional.bookerMobile != null
        ? { contact: formatBookerContact(text(optional.bookerEmail), text(optional.bookerMobile)) } : {}),
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
  if ([expectedGuest.firstName, expectedGuest.lastName].some(name => !name.trim() || name.trim().length > 256 || /[\p{Cc}]/u.test(name))) {
    return { outcome: 'needs_input', issue: 'invalid_create_target', fields: [guestPath] };
  }
  return { outcome: 'ok', nativeInput, expectedGuest, reviewPaths: [...reviewPaths], partySelectionPaths,
    requestedMealPlan: typeof requestedMealPlan === 'string' ? requestedMealPlan : null,
    mealPlan: typeof mealPlan === 'string' ? mealPlan : null };
}

const createMessages: Record<string, string> = {
  create_request_not_found: 'Add a booking action.', create_body_incomplete: 'Rebuild the booking dates and rooms.',
  create_requires_one_to_eight_rooms: 'Add between one and eight rooms.', allocation_not_found: 'Choose a room.',
  date_section_not_found: 'Choose dates for this room.', allocation_fields_incomplete: 'Complete the room’s guest and occupancy details.',
  invalid_create_target: 'Check the guest name and profile selection.',
  existing_confirmation_requires_lookup: 'Review the source confirmation and check for an existing stay.',
  existing_confirmation_found: 'Infor already has this booking. Use the existing stay for Amend or Filing.',
  confirmation_claim_capacity_exceeded: 'Review the source confirmations and split the booking actions.',
  create_requested_totals_conflict: 'Make the requested totals match the room allocations.',
  required: 'Complete this field.', native_required: 'Complete this field.', unknown_staff_value: 'Complete this field.',
  native_text_limit: 'Check this field’s length and format.', native_code_not_commit_safe: 'Select a valid Infor code.',
  invalid_code: 'Select a valid Infor code.', invalid_value: 'Check this value.', invalid_email: 'Enter a valid email address.',
  invalid: 'Check this value.', date_range_invalid: 'Enter valid arrival and departure dates.',
  new_profile_creation_required: 'Create or select the guest profile.', existing_profile_selection_required: 'Select or create the guest profile.',
  native_profile_unverified: 'Select or create the guest profile.', host_party_selection_required: 'Select the matching Infor party or choose None.',
  host_party_candidate_unverified: 'Select a verified Infor party.', percent_invalid: 'Enter a commission from 0 to 100%.',
  booking_agency_required: 'Select a Primary Booking Agency for the commission.', ar_account_required: 'Select an A/R Account for the Billing Reference.',
  native_note_limit: 'Check the Reservation Note’s length and characters.', native_booker_name_max_50: 'Shorten the Booker name to 50 characters.',
  guarantee_not_supported_yet: 'Select a supported Guarantee Type.', requires_staff_acceptance: 'Review and confirm this field.',
};

/** The same compiler supplies the pane checklist and server input refusals. */
export function createReadiness(draft: ReservationWorkflowV2Draft, requestId: string, stage: 'check' | 'execute'): ReadinessItem[] {
  const root = ptr('proposal', 'content', 'requests', requestId, 'body');
  const request = draft.proposal.content.requests.find(item => item.id === requestId && item.kind === 'create');
  if (!request || request.kind !== 'create') return [{ code: 'create_request_not_found', path: root, message: createMessages.create_request_not_found! }];
  const body = effectiveSubtree(draft, request.body, root) as CreateRequestBody | null;
  if (!body || !Array.isArray(body.allocations) || !Array.isArray(body.dateSections) || !body.shared) {
    return [{ code: 'create_body_incomplete', path: root, message: createMessages.create_body_incomplete! }];
  }
  if (body.allocations.length < 1 || body.allocations.length > 8) {
    return [{ code: 'create_requires_one_to_eight_rooms', path: `${root}/allocations`, message: createMessages.create_requires_one_to_eight_rooms! }];
  }
  const items: ReadinessItem[] = [];
  for (const [index, allocation] of body.allocations.entries()) {
    if (draft.operationResults.some(row => row.workflow === 'create' && row.requestId === requestId &&
        row.allocationId === allocation.id && (row.status === 'succeeded' || row.status === 'unknown'))) continue;
    const sectionIndex = body.dateSections.findIndex(section => section.id === allocation.dateSectionId);
    const room = `${root}/allocations/${index}`;
    const section = `${root}/dateSections/${sectionIndex}`;
    const result = compileCreateCore(draft, requestId, allocation.id, draft.propertyCode, stage === 'check' ? 'prepare' : 'execute');
    if (result.outcome === 'ok') continue;
    const fields = result.fields?.length ? result.fields : [result.issue];
    for (const field of fields) {
      const colon = field.lastIndexOf(':');
      const key = colon >= 0 ? field.slice(0, colon) : field;
      const code = colon >= 0 ? field.slice(colon + 1) : result.details?.find(detail => detail.path === key)?.code ??
        (key.startsWith('/') && result.outcome === 'needs_review' ? 'requires_staff_acceptance' : result.issue);
      let path = key.startsWith('/') ? key : root;
      if (!key.startsWith('/')) {
        if (key === 'stay') path = sectionIndex >= 0 ? `${section}/arrival` : `${room}/dateSectionId`;
        else if (key === 'guaranteeType' || key in body.shared) {
          const choices = [`${room}/overrides/${key}`, `${section}/defaults/${key}`, `${root}/shared/${key}`];
          path = choices.find(candidate => {
            const value = draft.fieldOverrides[candidate];
            if (value?.state === 'inherit') return false;
            const parts = candidate.split('/');
            const parent = parts.includes('overrides') ? allocation.overrides : parts.includes('defaults') ? body.dateSections[sectionIndex]?.defaults : body.shared;
            return value !== undefined || record(parent)?.[key] != null;
          }) ?? `${root}/shared/${key}`;
        }
      }
      const labels: Record<string, string> = { arrival: 'Arrival Date', departure: 'Departure Date',
        adults: 'Adults', childCount: 'Children', childAges: 'child ages', firstName: 'first name', lastName: 'last name',
        roomType: 'Room Type', roomTypeForCharge: 'Room Type for Charge', ratePlan: 'Rate Plan', guaranteeType: 'Guarantee Type',
        sourceOfBusiness: 'Source of Business', requestedMealPlan: 'Meal Plan request', mealPlan: 'Meal Plan',
        bookingAgency: 'Primary Booking Agency', organization: 'Organization', arAccount: 'A/R Account',
        billingReference: 'Billing Reference', taCommission: 'travel agency commission', reservationNote: 'Reservation Note',
        bookerName: 'Booker name', bookerEmail: 'Booker email', bookerMobile: 'Booker mobile', bookerContact: 'Booker contact',
        cmsRecipient: 'CMS Booker Email', cmsMessageId: 'CMS Message Id', requestedRooms: 'requested rooms' };
      const labelKey = key.startsWith('/') ? key.split('/').at(-1) ?? '' : key;
      const label = labels[labelKey];
      const message = code === 'required' || code === 'native_required' || code === 'unknown_staff_value'
        ? label ? `Complete ${label}.` : 'Complete this field.'
        : code === 'requires_staff_acceptance' && label ? `Review and confirm ${label}.`
        : createMessages[code] ?? createMessages[result.issue] ?? (label ? `Review ${label}.` : 'Review and confirm this field.');
      items.push({ code, path, message: path.includes('/allocations/') ? `Room ${index + 1}: ${message}` : message });
    }
  }
  const visualOrder = (path: string) => {
    if (/\/shared\/(bookingAgency|organization|arAccount|billingReference|taCommission)/.test(path)) return 0;
    if (path.includes('/dateSections/') || path.includes('/occupancy/')) return 1;
    if (/\/shared\/(sourceOfBusiness|reasonForStay|marketSegment|track)/.test(path)) return 2;
    if (path.includes('/shared/')) return 3;
    return 4;
  };
  return items.filter((item, index) => items.findIndex(other => other.path === item.path && other.message === item.message) === index)
    .sort((a, b) => visualOrder(a.path) - visualOrder(b.path));
}
