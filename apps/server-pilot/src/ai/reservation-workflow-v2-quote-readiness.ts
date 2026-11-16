import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { occupiedDates } from '../quote-proposal/quote-dates.js';
import type { ReservationWorkflowV2Draft, ReservationWorkflowV2Observation } from './reservation-workflow-v2-contract.js';
import { normalizeRequestedMealPlan } from './reservation-workflow-v2-meal-plan.js';
import { staffQuoteInput, type StaffQuoteInput } from './staff-quote-input.js';
import { PROPERTY_BOARD_MAP } from '../../tooling/hms-cloud/property-board-map.mjs';

type OtherRequest = Extract<ReservationWorkflowV2Draft['proposal']['content']['requests'][number], { kind: 'other' }>;
function separatedQuoteMoneyLinked(link: OtherRequest['body']['separatedFrom'], requestId: string, moneyId: string): boolean {
  return link?.moneyId === moneyId && (link.allowance ? link.allowance.quoteRequestIds.includes(requestId) : link.requestId === requestId);
}

export type QuoteRequest = Extract<ReservationWorkflowV2Draft['proposal']['content']['requests'][number], { kind: 'quote' }>;
type CompiledQuoteCore = {
  status: 'ok'; request: QuoteRequest; input: StaffQuoteInput; reviewPaths: string[]; sourceRefs: string[];
  outputKinds: Array<'email_quote' | 'pdf_quote' | 'xlsx_quote'>;
  strategyDefaulted: boolean; mealPlanDefaultedGroupIds: string[];
} | { status: 'needs_input' | 'needs_review' | 'unsupported'; issue: string; fields: string[] };

export type QuoteOperationResult = {
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
export type CompiledQuote = {
  status: 'ok';
  request: QuoteRequest;
  input: StaffQuoteInput;
  inputDigest: string;
  reviewPaths: string[];
  sourceRefs: string[];
  outputKinds: Array<'email_quote' | 'pdf_quote' | 'xlsx_quote'>;
  strategyDefaulted: boolean;
  mealPlanDefaultedGroupIds: string[];
} | {
  status: 'needs_input' | 'needs_review' | 'unsupported';
  issue: string;
  fields: string[];
};

export type UnavailableInventoryProof = {
  observation: ReservationWorkflowV2Observation;
  group: Extract<CompiledQuote, { status: 'ok' }>['input']['groups'][number];
  roomCode: string;
  roomLabel: string;
  freshUntil: string;
};
export const UNAVAILABLE_PREPARED_SUMMARY = 'Complete current Infor evidence supports an unsent requested-room decline; no price or reservation was created';

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const cleanText = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const stableValue = (value: unknown): unknown => Array.isArray(value) ? value.map(stableValue)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue((value as Record<string, unknown>)[key])])) : value;
const hash = (value: unknown): string => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(stableValue(value)))));
const isNone = (value: unknown): boolean => Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as { kind?: unknown }).kind === 'none');
const ptr = (...parts: Array<string | number>) => `/${parts.map(part => encodeURIComponent(String(part))).join('/')}`;
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
});
const providerCode = z.string().regex(/^[A-Z0-9_-]{1,16}$/);

export function resolvedLeaf(draft: ReservationWorkflowV2Draft, path: string, sourceValue: unknown):
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

export function boardCode(value: unknown, propertyCode?: string): 'room_only' | 'bb' | 'dinner_bb' | null {
  if (typeof value !== 'string') return null;
  const normalizedRequest = normalizeRequestedMealPlan(value).mealPlan;
  if (normalizedRequest) return normalizedRequest;
  const board = value.trim().toLocaleLowerCase().replace(/[,\s&-]+/gu, '_').replace(/_for_all$/u, '');
  if (['room_only', 'roomonly', 'ro'].includes(board)) return 'room_only';
  if (['bb', 'b_b', 'breakfast', 'bed_and_breakfast', 'bed_breakfast'].includes(board)) return 'bb';
  if (['dbb', 'dinner_bb', 'dinner_b_b', 'dinner_bed_breakfast', 'dinner_bed_and_breakfast', 'dinner_and_breakfast'].includes(board)) return 'dinner_bb';
  const mapped = propertyCode && PROPERTY_BOARD_MAP[propertyCode]?.[value.trim().toLowerCase().replace(/\s+/gu, ' ')];
  if (mapped === 'room_only') return 'room_only';
  if (mapped === 'breakfast') return 'bb';
  if (mapped === 'dinner_bed_breakfast') return 'dinner_bb';
  return null;
}

function selectedParty(
  draft: ReservationWorkflowV2Draft,
  request: QuoteRequest,
  role: 'organization' | 'bookingAgency',
  execute: boolean,
): { name?: string; party?: { kind: 'organization' | 'bookingAgency'; nativeId: string; name: string }; issue?: string; reviewPaths: string[]; observationRef?: string } {
  const raw = request.body.parties[role];
  const basePath = ptr('proposal', 'content', 'requests', request.id, 'body', 'parties', role);
  const namePath = ptr('proposal', 'content', 'requests', request.id, 'body', 'parties', role, 'name');
  const selectionPath = ptr('proposal', 'content', 'requests', request.id, 'body', 'parties', role, 'nativeSelectionRef');
  const partyLeaf = resolvedLeaf(draft, basePath, raw);
  // Always surface the mounted party picker path so Review/focus can land (O8/O9).
  if ('issue' in partyLeaf) return { reviewPaths: [basePath], issue: `${role}_${partyLeaf.issue}` };
  const value = isNone(partyLeaf.value) ? null : record(partyLeaf.value);
  // Child name edits can create a party even when extraction supplied null or no party object.
  // An explicit parent clear still wins over stale child overrides.
  const allowChildName = !partyLeaf.overridden;
  const named = !value && !allowChildName
    ? { value: undefined, path: namePath }
    : resolvedLeaf(draft, namePath, value?.name);
  if ('issue' in named) return { reviewPaths: [basePath], issue: `${role}_${named.issue}` };
  const name = cleanText(named.value);
  if (!name) {
    if ((('overridden' in named && named.overridden) || partyLeaf.overridden) &&
        typeof named.value === 'string' && !named.value.trim()) {
      const reviewPaths = execute ? [basePath, namePath].filter((path) => !reviewAccepted(draft, path)) : [];
      return { reviewPaths };
    }
    if (partyLeaf.value === null || partyLeaf.value === undefined || isNone(partyLeaf.value)) {
      const explicitlyUnset = raw !== undefined || partyLeaf.overridden;
      const reviewPaths = execute && explicitlyUnset && !reviewAccepted(draft, basePath) ? [basePath] : [];
      return { reviewPaths };
    }
    return { reviewPaths: [basePath], issue: `${role}_name_unresolved` };
  }
  const selectionOverride = draft.fieldOverrides[selectionPath];
  const nameEdits = [draft.fieldOverrides[basePath], draft.fieldOverrides[namePath]];
  const invalidatedByName = selectionOverride?.state === 'unknown' && nameEdits.some(edit =>
    edit?.state === 'set' && Date.parse(edit.updatedAt) >= Date.parse(selectionOverride.updatedAt));
  const selected = invalidatedByName
    ? { value: undefined, path: selectionPath }
    : resolvedLeaf(draft, selectionPath, value?.suggestedRef ?? null);
  if ('issue' in selected) return { reviewPaths: [basePath], issue: `${role}_${selected.issue}` };
  const ref = typeof selected.value === 'string' ? selected.value : null;
  if (!ref) {
    if (selected.value != null) return { reviewPaths: [basePath], issue: `${role}_candidate_unverified` };
    const reviewPaths = execute ? [basePath, namePath].filter((path) => !reviewAccepted(draft, path)) : [];
    return { name, reviewPaths };
  }
  const observation = draft.observations.find((entry) => entry.ref === ref && entry.kind === 'party_candidate');
  const criteria = record(observation?.criteria);
  const candidate = record(observation?.result);
  if (!observation || observation.status !== 'complete' || !observation.coverage.complete ||
      observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode ||
      observation.sourceMessageId !== draft.source.messageId || criteria?.workflow !== 'quote' ||
      criteria.requestId !== request.id || criteria.role !== role ||
      !candidate || !cleanText(candidate.nativeId) || !cleanText(candidate.name) || !sameName(candidate.name, name)) {
    return { reviewPaths: [basePath], issue: `${role}_candidate_unverified` };
  }
  const reviewPaths = execute
    ? [basePath, namePath, selectionPath].filter((path) => !reviewAccepted(draft, path))
    : [];
  if (execute && reviewPaths.length) return { reviewPaths, issue: `${role}_requires_staff_acceptance` };
  return {
    name,
    party: { kind: role, nativeId: String(candidate.nativeId), name: String(candidate.name) },
    reviewPaths,
    observationRef: observation.ref,
  };
}

export function sameName(left: unknown, right: unknown): boolean {
  return typeof left === 'string' && typeof right === 'string' &&
    left.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase() ===
      right.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

export function compileQuoteCore(
  draft: ReservationWorkflowV2Draft,
  request: QuoteRequest,
  execute: boolean,
  allowRequestedForUnavailable = false,
): CompiledQuoteCore {
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
    childrenAges: number[]; mealPlan: 'room_only' | 'bb' | 'dinner_bb'; roomCodes?: string[]; rateCode?: string;
  }> = [];
  const datePairs = new Set<string>();
  const mealPlanDefaultedGroupIds: string[] = [];
  for (const [groupIndex, group] of request.body.groups.entries()) {
    const base = path('groups', groupIndex);
    const association = resolvedLeaf(draft, `${base}/sourceAssociationUnresolved`, group.sourceAssociationUnresolved);
    if ('issue' in association || association.value === true ||
        group.sourceAssociationUnresolved === true && association.value !== false ||
        association.value != null && typeof association.value !== 'boolean') {
      issues.push(`${base}/sourceAssociationUnresolved:room_group_association_unresolved`);
    }
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

    const boardResult = execute ? resolved(path('groups', groupIndex, 'mealPlan'), group.mealPlan)
      : resolvedLeaf(draft, path('groups', groupIndex, 'mealPlan'), group.mealPlan);
    const actual = boardResult && !('issue' in boardResult) ? boardCode(boardResult.value, draft.propertyCode) : null;
    const useRequested = execute && allowRequestedForUnavailable && !('issue' in boardResult) && boardResult.value == null;
    const requestedPath = path('groups', groupIndex, 'requestedMealPlan');
    const requested = useRequested ? resolved(requestedPath, group.requestedMealPlan)
      : resolvedLeaf(draft, requestedPath, group.requestedMealPlan);
    const requestedBoard = !('issue' in requested) ? boardCode(requested.value, draft.propertyCode) : null;
    const board = actual ?? (useRequested ? requestedBoard : !execute ? requestedBoard ?? 'bb' : null);
    if (!execute && !actual && !requestedBoard) mealPlanDefaultedGroupIds.push(group.id);
    if (!board) issues.push(`${base}/mealPlan:native_meal_plan_code_required`);

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
    else if (childrenAges === null) issues.push(`${base}/occupancy/${Number.isInteger(count) && Number(count) > 0 ? 'childAges' : 'childCount'}:known_child_count_and_ages_required`);

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
        quantity: Number(quantity), adults: Number(adults), childrenAges, mealPlan: board,
        ...(roomCodes ? { roomCodes } : {}), ...(rateCode ? { rateCode } : {}) });
    }
  }
  if (datePairs.size > 1) issues.push(`${path('groups')}:separate_quote_runs_required`);
  if (new Set(nativeGroups.map((group) => group.id)).size !== nativeGroups.length) {
    issues.push(`${path('groups')}:duplicate_group_id`);
  }

  const extras: NonNullable<StaffQuoteInput['extras']> = [];
  const lunchClaimGroupIds = new Set<string>();
  const separatedLunchGroupIds = new Set<string>();
  let dinner: Pick<StaffQuoteInput, 'dinnerAllowanceMinor' | 'dinnerAllowanceUnit' | 'dinnerAllowanceGroupIds'> = {};
  for (const [index, claim] of request.body.requestedMoney.entries()) {
    const base = path('requestedMoney', index);
    const read = (key: string, original: unknown) => resolvedLeaf(draft, `${base}/${key}`, original);
    const kind = read('staffAllowanceType', claim.staffAllowanceType);
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
    const unitAllowed = unitValue === 'per_person_per_night' || unitValue === 'per_room_per_night' || unitValue === 'per_person' || unitValue === 'per_trip' || unitValue === 'item';
    const scopeValue = !('issue' in scope) ? scope.value : undefined;
    const targetValues = !('issue' in targets) && Array.isArray(targets.value) ? targets.value : [];
    const allIds = nativeGroups.map((group) => group.id);
    const groupIds = scopeValue === 'overall' && targetValues.length === 0 ? allIds
      : scopeValue === 'per_target' && targetValues.length > 0 && targetValues.every((id) => typeof id === 'string' && allIds.includes(id)) &&
          new Set(targetValues).size === targetValues.length ? targetValues as string[] : [];
    const supportedKind = selectedKind === 'dinner' || selectedKind === 'lunch' || selectedKind === 'airport_transfer' || selectedKind === 'office_transfer';
    const supported = supportedKind && !values.some((item) => 'issue' in item) &&
      !('issue' in currency) && typeof currency.value === 'string' && currency.value.trim().toUpperCase() === 'ZAR' &&
      amountMinor > 0 && Number.isSafeInteger(amountMinor) && unitAllowed && groupIds.length > 0 &&
      (selectedKind !== 'dinner' || dinner.dinnerAllowanceMinor === undefined && unitValue !== 'per_trip' && unitValue !== 'item');
    const separatedOther = draft.proposal.content.requests.find(candidate => candidate.kind === 'other' &&
      separatedQuoteMoneyLinked(candidate.body.separatedFrom, request.id, claim.id));
    const explicitlySeparated = selectedKind === 'unsupported' && separatedOther?.kind === 'other';
    if (selectedKind === 'lunch') groupIds.forEach(id => lunchClaimGroupIds.add(id));
    if (explicitlySeparated && separatedOther.kind === 'other') {
      const allowance = separatedOther.body.separatedFrom?.allowance;
      const kind = allowance?.kind ?? claim.staffAllowanceType;
      if (kind === 'lunch') {
        const covered = allowance ? groupIds.filter(id => allowance.groupIds.includes(id)) : groupIds;
        covered.forEach(id => { lunchClaimGroupIds.add(id); separatedLunchGroupIds.add(id); });
      }
    }
    if (!supported && !explicitlySeparated) {
      // Background HMS room prices remain useful while the unpriced request stays visible.
      if (execute) issues.push(`${base}:allowance_requires_supported_staff_choice`);
      continue;
    }
    if (supported) {
      if (selectedKind !== 'dinner') {
        const service = selectedKind === 'lunch' ? 'lunch_allowance' : selectedKind === 'airport_transfer' ? 'shuttle' : 'office_transfer';
        const extraUnit = unitValue === 'per_person_per_night' ? 'per_person_night' : unitValue;
        if (extraUnit === 'per_person_night' || extraUnit === 'per_person' || extraUnit === 'per_room_per_night' || extraUnit === 'per_trip' || extraUnit === 'item') {
          extras.push({ id: claim.id, service, amountMinor, unit: extraUnit, groupIds });
        }
      } else dinner = { dinnerAllowanceMinor: amountMinor,
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

  const company = selectedParty(draft, request, 'organization', execute);
  const agency = selectedParty(draft, request, 'bookingAgency', execute);
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
  const sourceNotes = notesResult && !('issue' in notesResult) ? cleanText(notesResult.value) ?? undefined : undefined;
  const lunchRequestedGroupIds = new Set(lunchClaimGroupIds);
  request.body.groups.forEach((group, index) => {
    const requested = resolvedLeaf(draft, path('groups', index, 'requestedMealPlan'), group.requestedMealPlan);
    if (!('issue' in requested) && normalizeRequestedMealPlan(requested.value).lunchRequested) lunchRequestedGroupIds.add(group.id);
  });
  const pricedLunchGroupIds = new Set(extras.filter(extra => extra.service === 'lunch_allowance').flatMap(extra => extra.groupIds));
  const lunchSeparated = separatedLunchGroupIds.size > 0;
  const lunchRequested = lunchRequestedGroupIds.size > 0;
  const lunchNotice = lunchSeparated ? 'Centurion meal plans do not include lunch. The separate lunch request is not included in this room quote.'
    : lunchRequested ? 'Centurion meal plans do not include lunch. Lunch is quoted as a separate extra.' : undefined;
  const notes = [sourceNotes, lunchNotice].filter(Boolean).join('\n') || undefined;
  if (execute && [...lunchRequestedGroupIds].some(id => !separatedLunchGroupIds.has(id) && !pricedLunchGroupIds.has(id))) {
    issues.push(`${path('requestedMoney')}:lunch_extra_price_required`);
  }
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
    ...(company.party ? { organization: company.party } : {}),
    ...(agency.party ? { bookingAgency: agency.party } : {}),
  };
  const nativeInput = {
    messageId: draft.source.messageId,
    sourceHash: draft.source.sourceHash,
    selectionEpoch: draft.revision,
    inputRevision: draft.revision,
    groups: nativeGroups,
    salesStrategy: strategyDefaulted ? 'BAR' : strategy === 'GOV' ? 'Government' : strategy,
    organization: company.name ?? '',
    bookingAgency: agency.name ?? '',
    attention,
    clientEmail,
    clientTelephone,
    ...(notes ? { notes } : {}),
    ...(Object.keys(parties).length ? { parties } : {}),
    ...dinner,
    ...(extras.length ? { extras } : {}),
  };
  const parsedInput = staffQuoteInput.safeParse(nativeInput);
  if (!parsedInput.success) {
    return { status: 'needs_input', issue: 'quote_inputs_outside_native_limits',
      fields: parsedInput.error.issues.map((item) => `${path(...item.path)}:native_input_limit`) };
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
    reviewPaths: [...reviewPaths], sourceRefs, outputKinds, strategyDefaulted, mealPlanDefaultedGroupIds,
  };
}


export function quoteInputOverrides(draft: ReservationWorkflowV2Draft, requestId: string) {
  const index = draft.proposal.content.requests.findIndex((request) => request.id === requestId);
  const prefixes = [ptr('proposal', 'content', 'requests', requestId), ptr('proposal', 'content', 'requests', index)];
  return Object.fromEntries(Object.entries(draft.fieldOverrides)
    .filter(([path]) => prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, override]) => [path, { state: override.state,
      ...(override.state === 'set' ? { value: override.value } : {}) }]));
}

function pricingOverrides(overrides: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(overrides).filter(([path]) =>
    !/\/body\/(?:guestNames|groups\/[^/]+\/(?:guestNames|requestedRoomDescription))(?:\/|$)/u.test(path)));
}

export function quoteOverridesMatch(draft: ReservationWorkflowV2Draft, requestId: string, saved: unknown): boolean {
  const overrides = record(saved);
  return overrides !== null && hash(pricingOverrides(overrides)) ===
    hash(pricingOverrides(quoteInputOverrides(draft, requestId)));
}

export function currentQuoteAvailabilityObservation(
  draft: ReservationWorkflowV2Draft,
  requestId: string,
  inputDigest: string,
): ReservationWorkflowV2Observation | null {
  return [...draft.observations].reverse().find((item) => {
    const criteria = record(item.criteria);
    return item.kind === 'rate_availability' && item.generationId === draft.generationId &&
      item.propertyCode === draft.propertyCode && item.sourceMessageId === draft.source.messageId &&
      criteria?.workflow === 'quote' && criteria.requestId === requestId &&
      criteria.sourceHash === draft.source.sourceHash && criteria.inputDigest === inputDigest;
  }) ?? null;
}

/** A decline is safe only for one explicitly selected room/rate with complete, current nightly zero-stock facts. */
export function unavailableInventoryProof(
  draft: ReservationWorkflowV2Draft,
  compiled: Extract<CompiledQuote, { status: 'ok' }>,
): UnavailableInventoryProof | null {
  if (compiled.input.groups.length !== 1 || compiled.mealPlanDefaultedGroupIds.length) return null;
  const group = compiled.input.groups[0];
  const roomCode = group?.roomCodes?.length === 1 ? group.roomCodes[0] : undefined;
  if (!group || !roomCode || !group.rateCode) return null;

  const observation = currentQuoteAvailabilityObservation(draft, compiled.request.id, compiled.inputDigest);
  if (!observation || observation.status !== 'failed') return null;
  const result = record(observation.result), shortfall = record(result?.shortfall);
  // Bind the shortage to the complete current request, not just its normalized
  // quote digest. Undo can restore the same values/revision while old receipts
  // still contain an earlier recipient, occupancy, party, or override set.
  if (!quoteOverridesMatch(draft, compiled.request.id, result?.inputOverrides) ||
      !Array.isArray(result?.requestedGroups) ||
      hash(result.requestedGroups) !== hash(compiled.input.groups)) return null;
  if (result?.failureCode !== 'native_quote_insufficient_inventory' || result.failureKind !== 'proven_shortage' ||
      result.sourceHash !== draft.source.sourceHash || result.inputDigest !== compiled.inputDigest ||
      result.availabilityTruncated !== false || !shortfall || shortfall.roomCode !== roomCode ||
      shortfall.demand !== group.quantity || shortfall.supply !== 0 || typeof shortfall.date !== 'string' ||
      typeof shortfall.roomLabel !== 'string') return null;

  const freshUntil = typeof result.freshUntil === 'string' ? result.freshUntil : '';
  const expires = Date.parse(freshUntil);
  if (!Number.isFinite(expires) || expires <= Date.now()) return null;
  let nights: string[];
  try { nights = occupiedDates(group.arrivalDate, group.departureDate); } catch { return null; }
  if (!nights.length || !nights.includes(shortfall.date)) return null;

  const diagnostics: Record<string, unknown>[] = Array.isArray(result.quoteDiagnostics)
    ? result.quoteDiagnostics.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
  const diagnostic = [...diagnostics].reverse().find((item) => item.kind === 'requested' && item.contextMatchesSelection === true);
  const diagnosticExpiry = Date.parse(String(diagnostic?.freshUntil ?? ''));
  if (!diagnostic || diagnostic.availabilityTruncated !== false ||
      !Number.isFinite(diagnosticExpiry) || diagnosticExpiry <= Date.now()) return null;
  const board: Record<string, unknown>[] = Array.isArray(diagnostic.availabilityBoard)
    ? diagnostic.availabilityBoard.map(record).filter((row): row is Record<string, unknown> => row !== null) : [];
  const expectedBoard = board.filter((row) => row?.groupId === group.id && row.roomCode === roomCode &&
    row.rateCode === group.rateCode && boardCode(row.mealPlanLabel ?? row.mealPlan, draft.propertyCode) === group.mealPlan);
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
  return { observation, group, roomCode, roomLabel: shortfall.roomLabel, freshUntil: String(diagnostic.freshUntil) };
}

export function compileQuote(draft: ReservationWorkflowV2Draft, request: QuoteRequest, execute: boolean,
  allowRequestedForUnavailable = false): CompiledQuote {
  const result = compileQuoteCore(draft, request, execute, allowRequestedForUnavailable);
  if (result.status !== 'ok') return result;
  return { ...result, inputDigest: hash({ sourceHash: draft.source.sourceHash, requestId: request.id,
    input: { ...result.input, selectionEpoch: 0, inputRevision: 0 } }) };
}

export function operationResults(draft: ReservationWorkflowV2Draft): QuoteOperationResult[] {
  return draft.operationResults.filter((result): result is QuoteOperationResult =>
    result.workflow === 'quote' && result.allocationId === null);
}

export function preparedUnavailableOperation(
  draft: ReservationWorkflowV2Draft,
  requestId: string,
  observationRef: string,
): QuoteOperationResult | null {
  return [...operationResults(draft)].reverse().find((result) => result.requestId === requestId &&
    result.generationId === draft.generationId && result.draftRevision === draft.revision && result.status === 'prepared' &&
    result.summary === UNAVAILABLE_PREPARED_SUMMARY && result.observationRefs.includes(observationRef)) ?? null;
}

/** Only a current, prepared shortage can use the reviewed requested meal plan to compile a decline. */
export function compilePreparedUnavailableQuote(draft: ReservationWorkflowV2Draft, request: QuoteRequest): CompiledQuote | null {
  const discovery = compileQuote(draft, request, false);
  if (discovery.status !== 'ok') return null;
  const proof = unavailableInventoryProof(draft, discovery);
  if (!proof || !preparedUnavailableOperation(draft, request.id, proof.observation.ref)) return null;
  return compileQuote(draft, request, true, true);
}

export type QuoteReadinessItem = { code: string; path: string; message: string };
const messages: Record<string, string> = {
  group_required: 'Add at least one room group.', native_quote_group_limit: 'Use at most eight room groups.',
  room_group_association_unresolved: 'Confirm whether this room group is separate or remove it.',
  valid_date_required: 'Enter a valid date.', date_range_invalid: 'Departure must be after arrival.',
  valid_room_count_required: 'Enter a room count from 1 to 100.', per_room_scenario_required: 'Choose occupancy per room.',
  valid_per_room_adults_required: 'Enter 1 to 6 adults per room.', known_child_count_and_ages_required: 'Enter the number and ages of children per room.',
  native_quote_max_six_children_per_room: 'Enter at most six children per room.', native_room_codes_required: 'Enter valid Infor room codes.',
  native_room_selection_required: 'Select an Infor room type.', native_rate_code_required: 'Enter a valid Infor rate code.',
  native_meal_plan_code_required: 'Select a meal plan.', supported_sales_strategy_required: 'Choose a sales strategy.',
  separate_quote_runs_required: 'Separate room groups with different dates into separate quotes.', duplicate_group_id: 'Fix duplicate room groups.',
  native_group_id_limit: 'Fix the room group identifier.', allowance_requires_supported_staff_choice: 'Complete or separate this extra charge.',
  lunch_extra_price_required: 'Add a lunch price or separate the lunch request.', native_note_limit: 'Shorten the quote notes.',
  unsupported_artifact_kind: 'Choose supported quote outputs.', output_required: 'Choose at least one quote output.',
  recipient_required_for_cover: 'Enter the recipient email.', separate_create_required: 'Handle the booking request separately.',
  quote_only_choice_required: 'Confirm this is a quote only.', unknown_staff_value: 'Complete this field.',
  native_input_limit: 'Check this value against the quote limits.', requires_staff_acceptance: 'Review and confirm this field.',
};
function itemFor(field: string, requestId: string): QuoteReadinessItem {
  const colon = field.lastIndexOf(':');
  const rawPath = colon < 0 ? (field.startsWith('/') ? field : '') : field.slice(0, colon);
  const code = colon < 0 ? (rawPath ? 'requires_staff_acceptance' : field) : field.slice(colon + 1);
  const role = code.startsWith('organization_') ? 'organization' : code.startsWith('bookingAgency_') ? 'bookingAgency' : null;
  const path = rawPath || (role ? ptr('proposal', 'content', 'requests', requestId, 'body', 'parties', role) : ptr('proposal', 'content', 'requests', requestId, 'body'));
  const message = role ? (code.endsWith('requires_staff_acceptance') ? 'Review and confirm this party.' : 'Select the matching Infor party or choose None.')
    : messages[code] ?? 'Review and confirm this field.';
  return { code, path, message };
}
export function quoteExtrasReadiness(draft: ReservationWorkflowV2Draft, requestId: string, observationRef: string): QuoteReadinessItem[] {
  const observation = draft.observations.find(row => row.ref === observationRef && row.kind === 'rate_availability');
  const operation = [...draft.operationResults].reverse().find(row => row.workflow === 'quote' && row.requestId === requestId &&
    row.generationId === draft.generationId && row.status === 'prepared' && row.observationRefs.includes(observationRef));
  if (!observation) return [];
  const extras = record(observation.result)?.extrasReviewItems;
  if (!Array.isArray(extras) || !extras.some(item => typeof item === 'string' && item.trim())) return [];
  const path = ptr('proposal', 'content', 'requests', requestId, 'body');
  const review = draft.staffReviews[path];
  if (operation && review?.status === 'accepted' && Date.parse(review.at ?? '') >= Date.parse(observation.observedAt) &&
      Date.parse(review.at ?? '') >= Date.parse(operation.updatedAt)) return [];
  return [{ code: 'quote_extras_require_staff_acceptance', path, message: 'Review the extra charges in the prepared quote.' }];
}

export function quoteReadiness(draft: ReservationWorkflowV2Draft, requestId: string, stage: 'check' | 'execute'): QuoteReadinessItem[] {
  const request = draft.proposal.content.requests.find((item): item is QuoteRequest => item.id === requestId && item.kind === 'quote');
  if (!request) return [{ code: 'quote_request_required', path: ptr('proposal', 'content', 'requests', requestId), message: 'Add a quote request.' }];
  let compiled = compileQuoteCore(draft, request, stage === 'execute');
  const decline = stage === 'execute' ? compilePreparedUnavailableQuote(draft, request) : null;
  if (compiled.status !== 'ok' && decline) compiled = decline;
  const items = compiled.status === 'ok' ? [] : compiled.fields.map(field => itemFor(field, requestId));
  if (decline?.status === 'ok' && !decline.outputKinds.includes('email_quote')) {
    items.push({ code: 'cover_email_required_for_unavailable_reply', path: ptr('proposal', 'content', 'requests', requestId, 'body', 'outputIntent', 'artifacts'), message: 'Choose an email reply for the unavailable room.' });
  }
  if (stage === 'execute') {
    const operation = [...draft.operationResults].reverse().find(row => row.workflow === 'quote' && row.requestId === requestId &&
      row.generationId === draft.generationId && row.status === 'prepared');
    for (const ref of operation?.observationRefs ?? []) items.push(...quoteExtrasReadiness(draft, requestId, ref));
  }
  return items.filter((item, index) => items.findIndex(other => other.code === item.code && other.path === item.path) === index);
}

/** The pane splits different date ranges before it submits a quote check. */
export function quoteReadinessBeforeSplit(draft: ReservationWorkflowV2Draft, requestId: string): QuoteReadinessItem[] {
  const request = draft.proposal.content.requests.find((item): item is QuoteRequest => item.id === requestId && item.kind === 'quote');
  const dates = new Map<string, number>();
  const canSplit = request && request.body.groups.every((group, index) => {
    const path = (...parts: Array<string | number>) => ptr('proposal', 'content', 'requests', requestId, 'body', 'groups', index, ...parts);
    const arrival = resolvedLeaf(draft, path('arrival'), group.arrival);
    const departure = resolvedLeaf(draft, path('departure'), group.departure);
    if ('issue' in arrival || 'issue' in departure || typeof arrival.value !== 'string' ||
        typeof departure.value !== 'string' || !dateSchema.safeParse(arrival.value).success ||
        !dateSchema.safeParse(departure.value).success || arrival.value >= departure.value) return false;
    const key = `${arrival.value}/${departure.value}`;
    dates.set(key, (dates.get(key) ?? 0) + 1);
    return true;
  }) && dates.size > 1 && [...dates.values()].every(count => count <= 8);
  return quoteReadiness(draft, requestId, 'check').filter(item => item.code !== 'separate_quote_runs_required' &&
    (item.code !== 'native_quote_group_limit' || !canSplit));
}
