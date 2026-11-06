'use client';

import { useCallback, useEffect, useReducer, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import styles from './reservation-pane.module.css';
import { initialReservationUiState, reduceReservationUi, type PendingReservationEdit } from '@/lib/reservation-workflow/reducer';
import { ReservationWorkflowStaleRevisionError } from '@/lib/reservation-workflow/types';
import type {
  ReservationFieldProjection,
  ReservationPaneSnapshot,
  ReservationRequestProjection,
  ReservationSourceContext,
  ReservationWorkflowClient,
  ReservationWorkflowKind,
} from '@/lib/reservation-workflow/types';

export type ReservationPaneProps = {
  source: ReservationSourceContext;
  snapshot: ReservationPaneSnapshot | null;
  loadError: string | null;
  client: ReservationWorkflowClient;
  onSnapshot: (snapshot: ReservationPaneSnapshot) => void;
  onOpenEvidence?: (ref: string) => void;
  onOpenAttachment?: (ref: string) => void;
};

const KIND_LABEL: Record<ReservationWorkflowKind, string> = {
  create: 'Create', quote: 'Quote', amend: 'Amend', cancel: 'Cancel', services: 'Services', filing: 'Filing', other: 'Other',
};
const KINDS: ReservationWorkflowKind[] = ['create', 'quote', 'amend', 'cancel', 'services', 'filing'];
const CREATE_SHARED_REVIEW_FIELDS = new Set(['roomType', 'ratePlan', 'bookingAgency', 'organization', 'arAccount', 'guaranteeType',
  'track', 'reasonForStay', 'sourceOfBusiness', 'billingReference', 'reservationNote', 'guestOptIn',
  'bookerName', 'bookerContact', 'cmsSend', 'cmsMessageId', 'cmsRecipient']);
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const text = (value: unknown): string => {
  if (value == null || (record(value)?.kind === 'none')) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(text).join(', ');
  return String(record(value)?.name ?? record(value)?.meaning ?? record(value)?.code ?? '');
};
const encoded = (value: string | number) => encodeURIComponent(String(value));
const requestPath = (request: ReservationRequestProjection) => `/proposal/content/requests/${encoded(request.id)}`;
const hasValue = (value: unknown) => value !== null && value !== undefined
  && !(record(value)?.kind === 'none') && !(typeof value === 'string' && value.trim() === '')
  && !(Array.isArray(value) && value.length === 0);
const humanize = (value: string) => value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
const sameIdentityText = (left: unknown, right: unknown) => text(left).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase()
  === text(right).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();

function guestSelectionMatches(snapshot: ReservationPaneSnapshot, path: string, guest: { firstName: unknown; lastName: unknown; email?: unknown }): boolean {
  const selected = nativeSelectionValue(snapshot, path);
  const ref = typeof selected === 'string' ? selected : null;
  if (!ref) return false;
  const observation = snapshot.session.draft.observations.find((item) => item.ref === ref && item.kind === 'guest_candidate'
    && item.status === 'complete' && ((Array.isArray(item.criteria.fieldPaths) && item.criteria.fieldPaths.includes(path))
      || item.criteria.fieldPath === path));
  const result = record(observation?.result);
  const candidates: unknown[] = Array.isArray(result?.candidates) ? result.candidates : [];
  return candidates.some((value) => {
    const candidate = record(value);
    return Boolean(candidate && sameIdentityText(candidate.firstName, guest.firstName)
      && sameIdentityText(candidate.lastName, guest.lastName)
      && (!hasValue(guest.email) || sameIdentityText(candidate.email, guest.email)) && hasValue(candidate.nativeId));
  });
}

function draftAtPath(snapshot: ReservationPaneSnapshot, path: string): unknown {
  const parts = path.split('/').slice(1).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  let value: unknown = snapshot.session.draft;
  for (const part of parts) {
    if (Array.isArray(value)) {
      const numericIndex = Number(part);
      value = Number.isInteger(numericIndex) && numericIndex >= 0 && String(numericIndex) === part
        ? value[numericIndex] : value.find((item) => record(item)?.id === part);
    }
    else {
      const objectValue = record(value);
      if (!objectValue) return undefined;
      value = objectValue[part];
    }
  }
  return value;
}

function valueFor(snapshot: ReservationPaneSnapshot, path: string): unknown {
  const field = snapshot.fields[path];
  return field ? field.value : draftAtPath(snapshot, path);
}

function nativeSelectionValue(snapshot: ReservationPaneSnapshot, path: string): unknown {
  const field = snapshot.fields[path];
  const suggestion = draftAtPath(snapshot, path.replace(/\/nativeSelectionRef$/u, '/suggestedRef'));
  if (field?.override) {
    if (field.override.state === 'set') return field.value;
    if (field.override.state === 'inherit') return typeof suggestion === 'string' ? suggestion : null;
    return null;
  }
  const value = valueFor(snapshot, path);
  return hasValue(value) ? value : typeof suggestion === 'string' ? suggestion : null;
}

function inheritedValue(snapshot: ReservationPaneSnapshot, paths: string[]): unknown {
  for (const path of paths) {
    const field = snapshot.fields[path];
    const override = field?.override;
    if (override) {
      if (override.state === 'unknown' || override.state === 'none' || override.state === 'clear') return null;
      if (override.state === 'set') return field.value;
      if (override.state === 'inherit') continue;
    }
    const base = draftAtPath(snapshot, path);
    if (record(base)?.kind === 'none') return null;
    if (base !== null && base !== undefined) return field?.value ?? base;
  }
  return null;
}

function fieldOrBase(snapshot: ReservationPaneSnapshot, path: string, base: unknown): unknown {
  return Object.hasOwn(snapshot.fields, path) ? snapshot.fields[path]?.value : base;
}

function createRequestForField(snapshot: ReservationPaneSnapshot, path: string): string | null {
  const request = snapshot.requests.find((item) => path.startsWith(`${requestPath(item)}/`));
  if (request) return request.id;
  const parts = path.split('/').slice(1).map((part) => {
    try { return decodeURIComponent(part); } catch { return ''; }
  });
  if (parts[0] !== 'proposal' || parts[1] !== 'content' || parts[2] !== 'services' || parts.length < 5) return null;
  const rawIndex = parts[3]!;
  const index = Number(rawIndex);
  const services = snapshot.session.draft.proposal.content.services;
  const service = Number.isInteger(index) && index >= 0 && String(index) === rawIndex
    ? services[index] : services.find((row) => row.id === rawIndex);
  if (!service) return null;
  const creates = snapshot.session.draft.proposal.content.requests.filter((item) => item.kind === 'create');
  return creates.find((item) => item.id === service.ownerRequestId)?.id
    ?? creates.find((item) => item.serviceRefs.includes(service.id) || service.targets.some((target) =>
      target.target.kind === 'allocation' && target.target.requestId === item.id))?.id ?? null;
}

function createSections(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection) {
  const body = requestPath(request) + '/body';
  const row = record(draftAtPath(snapshot, body));
  const dateSections = valueFor(snapshot, `${body}/dateSections`);
  const allocationRows = valueFor(snapshot, `${body}/allocations`);
  if (!row || !Array.isArray(dateSections) || !Array.isArray(allocationRows)) return { body, data: null, sections: [], allocations: [] };
  const data = { ...row, dateSections, allocations: allocationRows };
  const sections = dateSections.map((value, index) => ({ value: record(value) ?? {}, index }));
  const allocations = allocationRows.map((value, index) => ({ value: record(value) ?? {}, index }));
  return { body, data, sections, allocations };
}

function emptyRoomAllocation(dateSectionId: string) {
  return {
    id: `room_${crypto.randomUUID().replaceAll('-', '')}`,
    dateSectionId,
    overrides: {},
    guest: { firstName: null, lastName: null, email: null, mobile: null,
      profileIntent: 'existing_or_unknown', candidateRefs: [], suggestedRef: null },
    occupancy: { adults: null, childCount: null, childAges: null },
    priceObservationRefs: [],
  };
}

function latestQuotePriceObservation(snapshot: ReservationPaneSnapshot, requestId: string) {
  return [...snapshot.session.draft.observations].reverse().find((observation) => observation.kind === 'rate_availability'
    && observation.criteria.workflow === 'quote' && observation.criteria.requestId === requestId);
}

function quoteRateOptions(snapshot: ReservationPaneSnapshot, requestId: string, groupId?: string): Array<Record<string, unknown>> {
  const observation = latestQuotePriceObservation(snapshot, requestId);
  if (!observation || observation.status !== 'complete' || record(observation.coverage)?.complete !== true) return [];
  const result = record(observation.result);
  const options = Array.isArray(result?.rateOptions) ? result.rateOptions.map(record).filter((value): value is Record<string, unknown> => Boolean(value)) : [];
  return groupId ? options.filter((option) => option.groupId === groupId) : options;
}

function isQuotePrepared(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection): boolean {
  const preparation = [...snapshot.operationResults].reverse().find((result) => result.requestId === request.id
    && result.workflow === 'quote' && result.status === 'prepared');
  if (!preparation || preparation.generationId !== snapshot.session.draft.generationId
      || preparation.draftRevision !== snapshot.session.revision || !Array.isArray(preparation.observationRefs)) return false;
  return preparation.observationRefs.some((ref) => {
    const observation = snapshot.session.draft.observations.find((item) => item.ref === ref && item.kind === 'rate_availability');
    const result = record(observation?.result);
    const criteria = record(observation?.criteria);
    const freshUntil = typeof result?.freshUntil === 'string' ? Date.parse(result.freshUntil) : Number.NaN;
    return observation?.status === 'complete' && record(observation.coverage)?.complete === true
      && observation.generationId === snapshot.session.draft.generationId
      && observation.propertyCode === snapshot.session.draft.propertyCode
      && observation.sourceMessageId === snapshot.session.draft.source.messageId
      && criteria?.workflow === 'quote' && criteria.requestId === request.id
      && criteria.inputDigest === result?.inputDigest && typeof result?.inputDigest === 'string'
      && criteria.sourceHash === snapshot.session.draft.source.sourceHash
      && Number.isFinite(freshUntil) && freshUntil > Date.now();
  });
}

function quoteReceiptObservations(snapshot: ReservationPaneSnapshot, requestId: string) {
  const operationIds = new Set(snapshot.operationResults.filter((result) => result.workflow === 'quote' && result.requestId === requestId)
    .map((result) => text(result.id)).filter(Boolean));
  return snapshot.session.draft.observations.filter((observation) => observation.kind === 'document'
    && observation.criteria.workflow === 'quote' && observation.criteria.requestId === requestId
    && typeof observation.criteria.operationId === 'string' && operationIds.has(observation.criteria.operationId));
}

function deliverQuoteArtifact(artifact: Record<string, unknown>, open = false) {
  const encodedBytes = artifact.bytesBase64;
  const mimeType = text(artifact.mimeType);
  const fileName = text(artifact.fileName) || 'quote-artifact';
  if (typeof encodedBytes !== 'string' || !encodedBytes || !mimeType || typeof window === 'undefined') return;
  try {
    const binary = window.atob(encodedBytes);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    if (open && mimeType === 'application/pdf') window.open(url, '_blank', 'noopener,noreferrer');
    else {
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    // The receipt stays visible; malformed bytes never become a fake download link.
  }
}

function observedNativeCodes(snapshot: ReservationPaneSnapshot, path: string): Array<{ code: string; meaning: string; ref: string }> {
  const leaf = path.split('/').at(-1);
  const catalogKey = leaf === 'roomType' ? 'room' : leaf === 'ratePlan' ? 'ratePlan' : leaf === 'board' ? 'board' : null;
  if (!catalogKey) return [];
  const requestId = path.split('/')[4];
  const choices = new Map<string, { code: string; meaning: string; ref: string }>();
  for (const observation of snapshot.session.draft.observations) {
    if (observation.kind !== 'rate_availability' || observation.status !== 'complete'
        || observation.criteria.requestId !== requestId || record(observation.coverage)?.complete !== true) continue;
    if (observation.criteria.workflow === 'quote') {
      const options = quoteRateOptions(snapshot, requestId);
      for (const option of options) {
        const code = text(catalogKey === 'room' ? option.roomCode : catalogKey === 'ratePlan' ? option.rateCode : option.board).trim();
        if (!code || choices.has(code)) continue;
        const meaning = text(catalogKey === 'room' ? option.roomLabel : catalogKey === 'ratePlan' ? option.rateLabel : option.boardLabel).trim() || code;
        choices.set(code, { code, meaning, ref: observation.ref });
      }
      continue;
    }
    const groups = record(observation.result)?.groups;
    if (!Array.isArray(groups)) continue;
    for (const groupValue of groups) {
      const options = record(groupValue)?.options;
      if (!Array.isArray(options)) continue;
      for (const optionValue of options) {
        const value = record(optionValue);
        const nativeChoice = record(value?.[catalogKey]);
        const code = text(nativeChoice?.code).trim();
        if (!code) continue;
        const meaning = text(nativeChoice?.label).trim() || code;
        if (!choices.has(code)) choices.set(code, { code, meaning, ref: observation.ref });
      }
    }
  }
  return [...choices.values()];
}

function isInputReady(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection): boolean {
  const { body, data, sections, allocations } = createSections(snapshot, request);
  if (!data || allocations.length === 0) return false;
  if (sections.some(({ value: section, index }) => {
    const requestedRooms = valueFor(snapshot, `${body}/dateSections/${index}/requestedRooms`);
    return typeof requestedRooms === 'number'
      && allocations.filter(({ value }) => value.dateSectionId === section.id).length !== requestedRooms;
  })) return false;
  return allocations.every(({ value: allocation, index }) => {
    const dateIndex = Array.isArray(data.dateSections)
      ? data.dateSections.findIndex((entry) => record(entry)?.id === allocation.dateSectionId) : -1;
    const allocRoot = `${body}/allocations/${index}`;
    const sectionRoot = `${body}/dateSections/${Math.max(0, dateIndex)}`;
    const arrival = valueFor(snapshot, `${sectionRoot}/arrival`);
    const departure = valueFor(snapshot, `${sectionRoot}/departure`);
    const room = inheritedValue(snapshot, [`${allocRoot}/overrides/roomType`, `${sectionRoot}/defaults/roomType`, `${body}/shared/roomType`]);
    const rate = inheritedValue(snapshot, [`${allocRoot}/overrides/ratePlan`, `${sectionRoot}/defaults/ratePlan`, `${body}/shared/ratePlan`]);
    const guarantee = inheritedValue(snapshot, [`${allocRoot}/overrides/guaranteeType`, `${sectionRoot}/defaults/guaranteeType`, `${body}/shared/guaranteeType`]);
    const guest = record(allocation.guest) ?? {};
    const firstName = fieldOrBase(snapshot, `${allocRoot}/guest/firstName`, guest.firstName);
    const lastName = fieldOrBase(snapshot, `${allocRoot}/guest/lastName`, guest.lastName);
    const adults = fieldOrBase(snapshot, `${allocRoot}/occupancy/adults`, record(allocation.occupancy)?.adults);
    const children = fieldOrBase(snapshot, `${allocRoot}/occupancy/childCount`, record(allocation.occupancy)?.childCount);
    const ages = fieldOrBase(snapshot, `${allocRoot}/occupancy/childAges`, record(allocation.occupancy)?.childAges);
    const childCount = typeof children === 'number' ? children : null;
    const ageList = Array.isArray(ages) ? ages : [];
    const ageReady = childCount !== null && ageList.length === childCount
      && Array.from(ageList).every((age) => typeof age === 'number' && age >= 0 && age <= 17);
    const profileSelected = guestSelectionMatches(snapshot, `${allocRoot}/guest/nativeSelectionRef`, {
      firstName, lastName, email: fieldOrBase(snapshot, `${allocRoot}/guest/email`, guest.email),
    });
    return hasValue(arrival) && hasValue(departure) && hasValue(room) && hasValue(rate) && hasValue(guarantee) && hasValue(firstName) && hasValue(lastName)
      && typeof adults === 'number' && adults >= 1 && ageReady && profileSelected;
  });
}

function effectiveCreatePath(snapshot: ReservationPaneSnapshot, paths: string[]): string | null {
  for (const path of paths) {
    const field = snapshot.fields[path];
    const override = field?.override;
    if (override) {
      if (override.state === 'unknown' || override.state === 'none' || override.state === 'clear') return null;
      if (override.state === 'set') return hasValue(field.value) ? path : null;
      if (override.state === 'inherit') continue;
    }
    const base = draftAtPath(snapshot, path);
    if (record(base)?.kind === 'none') return null;
    if (hasValue(base)) return path;
  }
  return null;
}

function createReviewPaths(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection): string[] {
  const { body, data, sections, allocations } = createSections(snapshot, request);
  if (!data) return [];
  const paths = new Set<string>();
  const addWhenSet = (path: string) => {
    const value = path.endsWith('/nativeSelectionRef') ? nativeSelectionValue(snapshot, path) : valueFor(snapshot, path);
    if (hasValue(value)) paths.add(path);
  };
  const sharedFields = ['bookingAgency', 'organization', 'arAccount', 'sourceOfBusiness', 'reasonForStay',
    'billingReference', 'track', 'guestOptIn', 'bookerName', 'bookerContact', 'reservationNote',
    'cmsSend', 'cmsMessageId', 'cmsRecipient'];

  for (const { value: allocation, index } of allocations) {
    const allocRoot = `${body}/allocations/${index}`;
    const dateIndex = sections.findIndex(({ value }) => value.id === allocation.dateSectionId);
    if (dateIndex < 0) continue;
    const sectionRoot = `${body}/dateSections/${dateIndex}`;
    addWhenSet(`${sectionRoot}/arrival`);
    addWhenSet(`${sectionRoot}/departure`);
    for (const field of ['roomType', 'ratePlan', 'guaranteeType']) {
      const path = effectiveCreatePath(snapshot, [`${allocRoot}/overrides/${field}`, `${sectionRoot}/defaults/${field}`, `${body}/shared/${field}`]);
      if (path) paths.add(path);
    }
    for (const field of sharedFields) {
      const path = effectiveCreatePath(snapshot, [`${allocRoot}/overrides/${field}`, `${sectionRoot}/defaults/${field}`, `${body}/shared/${field}`]);
      if (!path) continue;
      paths.add(path);
      if (['bookingAgency', 'organization', 'arAccount'].includes(field)) addWhenSet(`${path}/nativeSelectionRef`);
    }
    for (const field of ['firstName', 'lastName']) addWhenSet(`${allocRoot}/guest/${field}`);
    addWhenSet(`${allocRoot}/guest/nativeSelectionRef`);
    for (const field of ['adults', 'childCount']) addWhenSet(`${allocRoot}/occupancy/${field}`);
    const childCount = valueFor(snapshot, `${allocRoot}/occupancy/childCount`);
    if (typeof childCount === 'number' && childCount > 0) addWhenSet(`${allocRoot}/occupancy/childAges`);
  }
  return [...paths];
}

function filingDocuments(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection) {
  const requestData = snapshot.session.draft.proposal.content.requests.find((entry) => entry.id === request.id);
  if (!requestData || requestData.kind !== 'filing') return [];
  return snapshot.session.draft.proposal.content.documents.filter((document) =>
    document.ownerRequestId === request.id && requestData.documentRefs.includes(document.id));
}

function filingTargetHints(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection) {
  const scope = record(draftAtPath(snapshot, `${requestPath(request)}/body/targets`));
  const include = Array.isArray(scope?.include) ? scope.include : [];
  return { scope, include: include.map(record).filter((item): item is Record<string, unknown> => Boolean(item)) };
}

function filingTargetPath(request: ReservationRequestProjection, hintId: string): string {
  return `${requestPath(request)}/body/targets/include/${encoded(hintId)}/suggestedRef`;
}

function filingReviewPaths(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection): string[] {
  const paths: string[] = [];
  for (const document of filingDocuments(snapshot, request)) {
    const root = `/proposal/content/documents/${encoded(document.id)}`;
    paths.push(`${root}/documentSourceRef`, `${root}/kind`, `${root}/handling`);
    if (document.requestedName !== null) paths.push(`${root}/requestedName`);
    if (document.requestedDescription !== null) paths.push(`${root}/requestedDescription`);
  }
  const { scope, include } = filingTargetHints(snapshot, request);
  if (scope?.mode === 'explicit' && include.length === 1 && typeof include[0]?.id === 'string') {
    paths.push(filingTargetPath(request, include[0].id));
  }
  return paths;
}

function filingTargetObservation(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection) {
  const { scope, include } = filingTargetHints(snapshot, request);
  if (scope?.mode !== 'explicit' || include.length !== 1 || (Array.isArray(scope.exclude) && scope.exclude.length > 0)) return null;
  const hint = include[0]!;
  if (typeof hint.id !== 'string') return null;
  const path = filingTargetPath(request, hint.id);
  const selectedRef = valueFor(snapshot, path);
  if (typeof selectedRef !== 'string') return null;
  const observation = snapshot.session.draft.observations.find((entry) => entry.ref === selectedRef && entry.kind === 'stay_candidate'
    && entry.status === 'complete' && record(entry.coverage)?.complete === true
    && entry.criteria.workflow === 'filing' && entry.criteria.requestId === request.id && entry.criteria.targetHintId === hint.id
    && record(entry.result)?.outcome === 'found');
  const stay = record(record(observation?.result)?.stay);
  if (!observation || !stay || (hasValue(hint.confirmation) && hint.confirmation !== stay.confirmation)
      || (hasValue(hint.bookedArrival) && hint.bookedArrival !== stay.arrival)
      || (hasValue(hint.bookedDeparture) && hint.bookedDeparture !== stay.departure)
      || (hasValue(hint.guestName) && !sameIdentityText(hint.guestName, `${text(stay.firstName)} ${text(stay.lastName)}`))) return null;
  return { hint, path, observation, stay };
}

function filingSourceObservation(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection, documentId: string) {
  return [...snapshot.session.draft.observations].reverse().find((entry) => entry.kind === 'document'
    && entry.status === 'complete' && record(entry.coverage)?.complete === true
    && entry.criteria.workflow === 'filing' && entry.criteria.requestId === request.id && entry.criteria.documentId === documentId
    && record(entry.result)?.outcome === 'ready');
}

function isFilingReadyForPrepare(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection): boolean {
  const documents = filingDocuments(snapshot, request);
  if (documents.length !== 1 || documents[0]!.handling !== 'filing_requested'
      || !['voucher', 'payment_proof'].includes(documents[0]!.kind) || !filingTargetObservation(snapshot, request)) return false;
  const source = filingSourceObservation(snapshot, request, documents[0]!.id);
  return Boolean(source && typeof record(source.result)?.sha256 === 'string'
    && typeof record(source.result)?.sourceSnapshotDigest === 'string');
}

function isRenderedCreateReviewPath(request: ReservationRequestProjection, path: string): boolean {
  const prefix = requestPath(request) + '/body';
  const relative = path.slice(`${prefix}/`.length).split('/');
  if (relative[0] === 'shared') return CREATE_SHARED_REVIEW_FIELDS.has(relative[1] ?? '');
  if (relative[0] === 'dateSections') {
    return ['arrival', 'departure'].includes(relative.at(-1) ?? '')
      || relative[2] === 'defaults' && ['roomType', 'ratePlan', 'guaranteeType'].includes(relative.at(-1) ?? '');
  }
  if (relative[0] !== 'allocations') return false;
  if (relative[2] === 'guest') return ['firstName', 'lastName', 'nativeSelectionRef'].includes(relative.at(-1) ?? '');
  if (relative[2] === 'occupancy') return ['adults', 'childCount', 'childAges'].includes(relative.at(-1) ?? '');
  return relative[2] === 'overrides'
    && ['roomType', 'ratePlan', 'guaranteeType', 'reservationNote'].includes(relative.at(-1) ?? '');
}

function hasUnreviewedRequiredFields(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection): boolean {
  const paths = request.kind === 'create' ? createReviewPaths(snapshot, request)
    : request.kind === 'filing' ? filingReviewPaths(snapshot, request) : request.fieldPaths;
  return paths.some((path) => {
    const field = snapshot.fields[path];
    const selectedValue = request.kind === 'create' && path.endsWith('/nativeSelectionRef')
      ? nativeSelectionValue(snapshot, path) : undefined;
    const value = field?.value ?? selectedValue ?? valueFor(snapshot, path);
    const required = field?.required === true || typeof selectedValue === 'string';
    const review = field?.review ?? snapshot.session.draft.staffReviews[path]?.status;
    return required && hasValue(value) && review !== 'accepted';
  });
}

function serviceRowsForAllocation(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection, allocationId: string) {
  return snapshot.session.draft.proposal.content.services.flatMap((service, serviceIndex) => {
    const createRequest = snapshot.session.draft.proposal.content.requests.find((item) => item.id === request.id);
    const targetsRequest = service.targets.some((target) => target.target.kind === 'allocation' && target.target.requestId === request.id);
    const hasLink = service.ownerRequestId === request.id || createRequest?.kind === 'create'
      && (createRequest.serviceRefs.includes(service.id) || targetsRequest);
    if (!hasLink) return [];
    return service.targets.flatMap((target, targetIndex) => target.target.kind === 'allocation'
      && target.target.requestId === request.id && target.target.allocationId === allocationId
      ? [{ service, serviceIndex, target, targetIndex }] : []);
  });
}

function serviceFieldValue(snapshot: ReservationPaneSnapshot, serviceIndex: number, targetIndex: number,
  field: string, pendingValue?: { present: boolean; value: unknown }): unknown {
  const targetPath = `/proposal/content/services/${serviceIndex}/targets/${targetIndex}/fields/${field}`;
  if (pendingValue?.present) return pendingValue.value;
  const target = snapshot.fields[targetPath];
  if (target?.override) {
    if (target.override.state === 'set') return target.value;
    if (target.override.state === 'unknown' || target.override.state === 'none' || target.override.state === 'clear') return null;
    if (target.override.state === 'inherit') return valueFor(snapshot, `/proposal/content/services/${serviceIndex}/sharedFields/${field}`);
  }
  const targetValue = Object.hasOwn(snapshot.fields, targetPath) ? target.value : draftAtPath(snapshot, targetPath);
  return hasValue(targetValue) ? targetValue : valueFor(snapshot, `/proposal/content/services/${serviceIndex}/sharedFields/${field}`);
}

function isRequestPrepared(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection): boolean {
  const allocations = createSections(snapshot, request).allocations;
  return allocations.length > 0 && allocations.every(({ value }) => {
    const allocationId = String(value.id ?? '');
    return snapshot.preparationViews.some((view) => view.requestId === request.id && view.allocationId === allocationId && view.current);
  });
}

export function ReservationPane({ source, snapshot, loadError, client, onSnapshot, onOpenEvidence, onOpenAttachment }: ReservationPaneProps) {
  const [ui, dispatch] = useReducer(reduceReservationUi, source.selectionEpoch, initialReservationUiState);
  const sourceRef = useRef(source);
  const snapshotRef = useRef(snapshot);
  const pending = useRef(new Map<string, PendingReservationEdit>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const sequence = useRef(0);
  const triedPrepare = useRef(new Set<string>());
  const activeRequestRef = useRef<string | null>(null);
  const activeKindRef = useRef<ReservationWorkflowKind>('create');
  sourceRef.current = source;
  snapshotRef.current = snapshot;

  useEffect(() => {
    pending.current.clear();
    triedPrepare.current.clear();
    activeRequestRef.current = null;
    activeKindRef.current = 'create';
    dispatch({ type: 'source-changed', selectionEpoch: source.selectionEpoch });
  }, [source.selectionEpoch, source.messageId]);

  useEffect(() => {
    if (!snapshot || snapshot.sourceMessageId !== source.messageId) return;
    dispatch({ type: 'snapshot-received', snapshot });
    if (!activeRequestRef.current || !snapshot.requests.some((request) => request.id === activeRequestRef.current)) {
      const create = snapshot.requests.find((request) => request.kind === 'create');
      const first = create ?? snapshot.requests[0];
      activeRequestRef.current = first?.id ?? null;
      activeKindRef.current = first?.kind ?? 'create';
    }
  }, [snapshot, source.messageId]);

  const activeRequest = snapshot?.requests.find((request) => request.id === activeRequestRef.current)
    ?? snapshot?.requests.find((request) => request.kind === activeKindRef.current);
  const activeKind = activeRequest?.kind ?? activeKindRef.current;

  const applySnapshot = useCallback((next: ReservationPaneSnapshot, bound: ReservationSourceContext) => {
    if (sourceRef.current.selectionEpoch !== bound.selectionEpoch || sourceRef.current.messageId !== bound.messageId
      || next.sourceMessageId !== bound.messageId) return;
    snapshotRef.current = next;
    onSnapshot(next);
  }, [onSnapshot]);

  const enqueue = useCallback((label: string, bound: ReservationSourceContext, action: () => Promise<void>) => {
    const run = queue.current.then(async () => {
      if (sourceRef.current.selectionEpoch !== bound.selectionEpoch || sourceRef.current.messageId !== bound.messageId) return;
      dispatch({ type: 'set-busy', action: label });
      try {
        await action();
        if (sourceRef.current.selectionEpoch === bound.selectionEpoch) {
          dispatch({ type: 'action-error', message: null });
          dispatch({ type: 'set-busy', action: null });
        }
      } catch (error) {
        if (sourceRef.current.selectionEpoch === bound.selectionEpoch) {
          if (error instanceof ReservationWorkflowStaleRevisionError) applySnapshot(error.snapshot, bound);
          dispatch({ type: 'action-error', message: error instanceof Error ? error.message : 'Reservation action did not complete.' });
        }
      }
    });
    queue.current = run.then(() => undefined, () => undefined);
    return run;
  }, [applySnapshot]);

  const stage = useCallback((path: string, value: unknown, state: PendingReservationEdit['state'] = 'set') => {
    const edit = { path, value, state, sequence: ++sequence.current };
    pending.current.set(path, edit);
    dispatch({ type: 'stage-edit', edit });
  }, []);

  const flushEdits = useCallback(async (bound: ReservationSourceContext, paths?: string[]) => {
    const allowed = paths ? new Set(paths) : null;
    const edits = [...pending.current.values()].filter((edit) => !allowed || allowed.has(edit.path));
    if (!edits.length) return;
    let current = snapshotRef.current;
    if (!current) throw new Error('The source-bound reservation draft is still loading.');
    for (const edit of edits) {
      const requestId = createRequestForField(current, edit.path);
      if (!requestId) throw new Error('This value has no source-bound Create or linked service request; no local-only draft was accepted.');
      const next = await client.edit({ source: bound, snapshot: current, requestId,
        fieldPath: edit.path, state: edit.state, ...(edit.state === 'set' ? { value: edit.value } : {}) });
      current = next;
      applySnapshot(next, bound);
      const valid = edit.state === 'set' ? hasValue(edit.value) : edit.state === 'none' || edit.state === 'clear';
      if (valid) {
        current = await client.review({ source: bound, snapshot: current, fieldPath: edit.path, decision: 'accepted' });
        applySnapshot(current, bound);
      }
      if (pending.current.get(edit.path)?.sequence === edit.sequence) pending.current.delete(edit.path);
      dispatch({ type: 'edit-acknowledged', sequence: edit.sequence });
    }
  }, [applySnapshot, client]);

  const saveEdits = useCallback((paths?: string[]) => {
    const bound = sourceRef.current;
    return enqueue('Saving reservation edits', bound, () => flushEdits(bound, paths));
  }, [enqueue, flushEdits]);

  const editOnBlur = useCallback((path: string) => { void saveEdits([path]); }, [saveEdits]);
  const editValue = useCallback((path: string): unknown => {
    const pendingEdit = pending.current.get(path);
    if (pendingEdit) return pendingEdit.state === 'set' ? pendingEdit.value : null;
    const current = snapshotRef.current;
    return current ? valueFor(current, path) ?? null : null;
  }, []);
  const hasPendingEdit = useCallback((path: string) => pending.current.has(path), []);
  const markDone = useCallback((path: string) => {
    const bound = sourceRef.current;
    void enqueue('Marking value reviewed', bound, async () => {
      if (pending.current.has(path)) await flushEdits(bound, [path]);
      const current = snapshotRef.current;
      if (!current) throw new Error('The source-bound reservation draft is still loading.');
      const field = current.fields[path];
      const suggestedSelection = path.endsWith('/nativeSelectionRef') ? nativeSelectionValue(current, path) : null;
      const required = field?.required === true || typeof suggestedSelection === 'string';
      const review = current.session.draft.staffReviews[path];
      if (!required || (field?.review ?? review?.status) === 'accepted') return;
      if (!hasValue(field?.value ?? suggestedSelection ?? valueFor(current, path))) throw new Error('Enter or resolve this value before marking it reviewed.');
      const next = await client.review({ source: bound, snapshot: current, fieldPath: path, decision: 'accepted' });
      applySnapshot(next, bound);
    });
  }, [applySnapshot, client, enqueue, flushEdits]);

  const chooseRequest = useCallback((request: ReservationRequestProjection) => {
    activeRequestRef.current = request.id;
    activeKindRef.current = request.kind;
    dispatch({ type: 'action-error', message: null });
  }, []);

  const refreshNative = useCallback(() => {
    const bound = sourceRef.current;
    const current = snapshotRef.current;
    if (!current || !activeRequest) return;
    void enqueue('Checking current Infor records and availability', bound, async () => {
      let saved = snapshotRef.current ?? current;
      if (pending.current.size) {
        await flushEdits(bound);
        saved = snapshotRef.current ?? saved;
      }
      const next = await client.lookup({ source: bound, snapshot: saved, requestId: activeRequest.id });
      applySnapshot(next, bound);
    });
  }, [activeRequest, applySnapshot, client, enqueue, flushEdits]);

  const prepareAll = useCallback(async (auto = false) => {
    const bound = sourceRef.current;
    let current = snapshotRef.current;
    let request = current?.requests.find((item) => item.id === activeRequestRef.current)
      ?? current?.requests.find((item) => item.kind === 'create');
    if (!current || !request || request.kind !== 'create') return;
    if (pending.current.size) {
      await flushEdits(bound);
      current = snapshotRef.current;
      request = current?.requests.find((item) => item.id === request?.id && item.kind === 'create');
    }
    if (!current || !request || request.kind !== 'create' || !isInputReady(current, request)) return;
    const { allocations } = createSections(current, request);
    if (!allocations.length) return;
    const key = `${bound.selectionEpoch}:${current.session.revision}:${request.id}`;
    if (auto && triedPrepare.current.has(key)) return;
    triedPrepare.current.add(key);
    let latest = current;
    for (const allocation of allocations) {
      const next = await client.prepare({ source: bound, snapshot: latest, requestId: request.id, allocationId: String(allocation.value.id ?? '') });
      latest = next;
      applySnapshot(next, bound);
      if (next.serviceNotice) throw new Error(next.serviceNotice);
    }
  }, [applySnapshot, client, flushEdits]);

  useEffect(() => {
    if (!snapshot || activeKind !== 'create' || !activeRequest || snapshot.preparation.state === 'current') return;
    if (!isInputReady(snapshot, activeRequest)) return;
    const key = `${source.selectionEpoch}:${snapshot.session.revision}:${activeRequest.id}`;
    if (triedPrepare.current.has(key)) return;
    const timer = window.setTimeout(() => {
      void enqueue('Checking current Infor price and availability', source, () => prepareAll(true));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [activeKind, activeRequest, enqueue, prepareAll, snapshot, source]);

  const runGo = useCallback(() => {
    const bound = sourceRef.current;
    void enqueue('Creating reservations in Infor', bound, async () => {
      if (pending.current.size) await flushEdits(bound);
      let current = snapshotRef.current;
      const request = current?.requests.find((item) => item.id === activeRequestRef.current);
      if (!current || !request || request.kind !== 'create') throw new Error('Only connected Create requests can be sent to Infor in this release.');
      const { allocations } = createSections(current, request);
      if (!allocations.length) throw new Error('This saved Create request has no room allocations to submit.');
      if (!isInputReady(current, request)) throw new Error('Complete each room and select the exact existing guest profile first.');
      if (hasUnreviewedRequiredFields(current, request)) throw new Error('Review every required field before Go.');
      if (!isRequestPrepared(current, request)) throw new Error('Native price and availability are stale. Wait for the automatic Infor check before Go.');
      for (const allocation of allocations) {
        const allocationId = String(allocation.value.id ?? '');
        const alreadyDone = current.operationResults.some((result) => result.requestId === request.id
          && result.allocationId === allocationId && result.workflow === 'create' && result.status === 'succeeded');
        if (alreadyDone) continue;
        const uncertain = current.operationResults.some((result) => result.requestId === request.id
          && result.allocationId === allocationId && result.workflow === 'create' && result.status === 'unknown');
        if (uncertain) throw new Error(`Room ${allocationId} has an uncertain save. Reconcile it before retrying.`);
        const idempotencyKey = crypto.randomUUID();
        current = await client.execute({ source: bound, snapshot: current, requestId: request.id, allocationId, idempotencyKey });
        applySnapshot(current, bound);
        const outcome = current.operationResults.find((result) => result.id === idempotencyKey)
          ?? [...current.operationResults].reverse().find((result) => result.requestId === request.id && result.allocationId === allocationId);
        if (!outcome || outcome.status !== 'succeeded') {
          throw new Error(current.serviceNotice ?? (outcome?.status === 'unknown'
            ? 'Infor save outcome is uncertain. Reconcile the room before retrying.'
            : `Infor did not confirm room ${allocationId}.`));
        }
      }
    });
  }, [applySnapshot, client, enqueue, flushEdits]);

  const prepareQuote = useCallback((requestId: string) => {
    const bound = sourceRef.current;
    void enqueue('Preparing native quote price and availability', bound, async () => {
      if (pending.current.size) await flushEdits(bound);
      const current = snapshotRef.current;
      const request = current?.requests.find((item) => item.id === requestId && item.kind === 'quote');
      if (!current || !request || !request.supported) throw new Error('This Quote request is not connected to the current native quote service.');
      const next = await client.prepare({ source: bound, snapshot: current, requestId });
      applySnapshot(next, bound);
      if (next.serviceNotice) throw new Error(next.serviceNotice);
    });
  }, [applySnapshot, client, enqueue, flushEdits]);

  const generateQuote = useCallback((requestId: string) => {
    const bound = sourceRef.current;
    void enqueue('Generating unsent quote outputs', bound, async () => {
      if (pending.current.size) await flushEdits(bound);
      const current = snapshotRef.current;
      const request = current?.requests.find((item) => item.id === requestId && item.kind === 'quote');
      if (!current || !request || !request.supported) throw new Error('This Quote request is not connected to the current quote output service.');
      if (current.operationResults.some((result) => result.workflow === 'quote' && result.requestId === request.id && result.status === 'unknown')) {
        throw new Error('Quote output receipt is uncertain. Reconcile the saved operation before retrying.');
      }
      if (!isQuotePrepared(current, request)) throw new Error('Native Quote price/availability is not current. Prepare it again before generating files.');
      if (hasUnreviewedRequiredFields(current, request)) throw new Error('Review every required Quote field before generating outputs.');
      const next = await client.execute({ source: bound, snapshot: current, requestId: request.id, idempotencyKey: crypto.randomUUID() });
      applySnapshot(next, bound);
    });
  }, [applySnapshot, client, enqueue, flushEdits]);

  const reconcile = useCallback((operationId: string) => {
    const bound = sourceRef.current;
    void enqueue('Reconciling the Infor save outcome', bound, async () => {
      const current = snapshotRef.current;
      if (!current) return;
      const next = await client.reconcile({ source: bound, snapshot: current, operationId });
      applySnapshot(next, bound);
    });
  }, [applySnapshot, client, enqueue]);

  const runServiceAction = useCallback((mode: 'lookup' | 'preview', requestId: string, allocationId: string, serviceId: string) => {
    const bound = sourceRef.current;
    void enqueue(mode === 'lookup' ? 'Loading native Add-On catalogue' : 'Previewing unsaved Add-On on this room', bound, async () => {
      if (pending.current.size) await flushEdits(bound);
      const current = snapshotRef.current;
      const request = current?.requests.find((item) => item.id === requestId && item.kind === 'create');
      if (!current || !request) throw new Error('The owning Create request is no longer available.');
      if (!isInputReady(current, request)) {
        throw new Error('Complete every Create room and select each exact existing guest profile before native Add-On lookup or preview.');
      }
      const command = { source: bound, snapshot: current, requestId, allocationId, serviceId };
      const next = mode === 'lookup' ? await client.lookupServices(command) : await client.previewServices(command);
      applySnapshot(next, bound);
    });
  }, [applySnapshot, client, enqueue, flushEdits]);

  const undoRedo = useCallback((direction: 'undo' | 'redo') => {
    const bound = sourceRef.current;
    void enqueue(direction === 'undo' ? 'Undoing last edit' : 'Redoing edit', bound, async () => {
      if (pending.current.size) await flushEdits(bound);
      const current = snapshotRef.current;
      if (!current) return;
      const next = direction === 'undo' ? await client.undo({ source: bound, snapshot: current })
        : await client.redo({ source: bound, snapshot: current });
      applySnapshot(next, bound);
    });
  }, [applySnapshot, client, enqueue, flushEdits]);

  const reviewRequired = Boolean(snapshot && activeRequest && hasUnreviewedRequiredFields(snapshot, activeRequest));
  const hasUncertain = snapshot?.operationResults.some((result) => result.requestId === activeRequest?.id && result.status === 'unknown') ?? false;
  const canGo = Boolean(snapshot && activeRequest?.kind === 'create' && activeRequest.supported
    && isInputReady(snapshot, activeRequest) && isRequestPrepared(snapshot, activeRequest) && !reviewRequired && !ui.pendingEdits.length
    && !ui.busyAction && !hasUncertain);
  const displayedResult = snapshot?.operationResults.filter((result) => result.requestId === activeRequest?.id
    && result.workflow === activeRequest?.kind) ?? [];
  const canGenerateQuote = Boolean(snapshot && activeRequest?.kind === 'quote' && activeRequest.supported
    && isQuotePrepared(snapshot, activeRequest) && !hasUnreviewedRequiredFields(snapshot, activeRequest)
    && !ui.pendingEdits.length && !ui.busyAction && !hasUncertain);

  return (
    <div className={styles.pane} data-reservation-pane="v2" data-source-message={source.messageId}>
      <header className={styles.header}>
        <div className={styles.brand}><span className={styles.brandMark}>N</span><span><b>Nava</b><small>Reservations</small></span></div>
        <div className={styles.history}>
          <button type="button" onClick={() => undoRedo('undo')} disabled={!snapshot || Boolean(ui.busyAction)} aria-label="Undo edit">↶</button>
          <button type="button" onClick={() => undoRedo('redo')} disabled={!snapshot || Boolean(ui.busyAction)} aria-label="Redo edit">↷</button>
        </div>
      </header>
      <section className={styles.sourceCard} aria-label="Selected email">
        <div className={styles.sourceMeta}>✉ <span>Selected email</span>{source.receivedAt && <time>{source.receivedAt}</time>}</div>
        <strong>{source.subject || 'Untitled email'}</strong><small>{source.sender || 'Sender unavailable'}</small>
        {source.attachments.length > 0 && <div className={styles.attachmentList}>
          {source.attachments.map((item) => <button type="button" key={item.sourceRef} disabled={item.uploadability !== 'ready' || !onOpenAttachment}
            onClick={() => onOpenAttachment?.(item.sourceRef)}><span>▤</span>{item.name}<small>{item.uploadability === 'ready' ? 'Ready' : item.uploadability}</small></button>)}
        </div>}
      </section>
      {loadError && <div className={styles.alert} role="alert">{loadError}</div>}
      {snapshot?.session.draft.status === 'prefill_failed' && <div className={styles.notice} role="status">Reservation details could not be prefilled. Nothing has been sent to Infor; fields below show only saved server values.</div>}
      {!snapshot && !loadError && <div className={styles.notice} role="status">Opening this source-bound reservation draft…</div>}
      {snapshot && <>
        <nav className={styles.tabs} aria-label="Reservation workflows">
          {KINDS.map((kind) => {
            const matches = snapshot.requests.filter((request) => request.kind === kind);
            return <button key={kind} type="button" className={activeKind === kind ? styles.activeTab : ''}
              aria-pressed={activeKind === kind} onClick={() => {
                const match = matches.find((request) => request.id === activeRequest?.id) ?? matches[0];
                if (match) chooseRequest(match);
                else { activeRequestRef.current = null; activeKindRef.current = kind; dispatch({ type: 'action-error', message: null }); }
              }}>{KIND_LABEL[kind]}{matches.length > 1 && <small>{matches.length}</small>}</button>;
          })}
        </nav>
        <main className={styles.main}>
          {activeRequest ? <>
            <div className={styles.titleRow}><div><small className={styles.eyebrow}>{KIND_LABEL[activeRequest.kind]}</small><h1>{activeRequest.text || `${KIND_LABEL[activeRequest.kind]} reservation work`}</h1></div>
              <span className={activeRequest.supported ? styles.connected : styles.notConnected}>{activeRequest.supported ? 'Connected' : 'Review only'}</span></div>
            {snapshot.issues.filter((issue) => !issue.path || issue.path.startsWith(`${requestPath(activeRequest)}/`)).map((issue, index) =>
              <div className={styles.issueLine} key={`${issue.kind}-${index}`}><b>{humanize(issue.kind)}</b><span>{issue.explanation}</span></div>)}
            {activeRequest.kind === 'create' && displayedResult.some((result) => result.status === 'succeeded') && <div className={styles.notice}>At least one room already has an HMS confirmation. Later edits and undo affect the draft only; they do not change a saved reservation.</div>}
            {activeRequest.kind === 'create'
                ? <CreateEditor snapshot={snapshot} request={activeRequest} onStage={stage} onBlur={editOnBlur} onDone={markDone} editValue={editValue} hasPendingEdit={hasPendingEdit}
                  busy={Boolean(ui.busyAction) || ui.pendingEdits.length > 0}
                  onLookupServices={(allocationId, serviceId) => runServiceAction('lookup', activeRequest.id, allocationId, serviceId)}
                  onPreviewServices={(allocationId, serviceId) => runServiceAction('preview', activeRequest.id, allocationId, serviceId)}
                  onOpenEvidence={onOpenEvidence} onPrepare={() => { void enqueue('Checking Infor now', sourceRef.current, () => prepareAll(false)); }}
                  onLookup={refreshNative} />
              : activeRequest.kind === 'filing'
                ? <FilingEditor snapshot={snapshot} request={activeRequest} source={source} onOpenAttachment={onOpenAttachment} />
                : activeRequest.kind === 'quote'
                  ? <QuoteEditor snapshot={snapshot} request={activeRequest} onStage={stage} onBlur={editOnBlur} onDone={markDone} editValue={editValue}
                    onOpenEvidence={onOpenEvidence} busy={Boolean(ui.busyAction) || Boolean(ui.pendingEdits.length)}
                    onLookup={refreshNative} onPrepare={() => prepareQuote(activeRequest.id)} />
                  : <RequestReview snapshot={snapshot} request={activeRequest} />}
            {displayedResult.map((result, index) => <OperationResult key={String(result.id ?? index)} result={result}
              onReconcile={reconcile} busy={Boolean(ui.busyAction)} />)}
            {activeRequest.kind !== 'create' && activeRequest.kind !== 'quote' && <div className={styles.notice}>This v2 request is visible from saved source facts. Its native operation is not connected in the current UI route, so no Go action is offered.</div>}
          </> : <>
            <div className={styles.titleRow}><div><small className={styles.eyebrow}>{KIND_LABEL[activeKind]}</small><h1>{activeKind === 'create' ? 'New reservation' : `${KIND_LABEL[activeKind]} request`}</h1></div></div>
            {activeKind === 'create'
              ? <div className={styles.alert}>The saved v2 draft has no Create request row. Forms cannot be saved until the server seeds an editable request; no local-only draft will be treated as real.</div>
              : <div className={styles.notice}>No {KIND_LABEL[activeKind].toLowerCase()} request is present in this email’s saved v2 draft.</div>}
          </>}
        </main>
        <footer className={styles.footer}>
          <div className={styles.footerMessage} aria-live="polite">
            {ui.busyAction ? <><span className={styles.spinner} />{ui.busyAction}</> : ui.actionError ?? snapshot.serviceNotice ?? (activeRequest?.kind === 'create' && isRequestPrepared(snapshot, activeRequest)
              ? 'Current Infor unsaved form and price are ready for review.' : activeRequest?.kind === 'quote' && isQuotePrepared(snapshot, activeRequest)
                ? 'Current native quote price and availability are prepared; outputs remain unsent.' : snapshot.preparation.message)}
          </div>
          {ui.pendingEdits.length > 0 && <button type="button" className={styles.secondaryButton} disabled={Boolean(ui.busyAction)} onClick={() => { void saveEdits(); }}>Save {ui.pendingEdits.length} edit{ui.pendingEdits.length === 1 ? '' : 's'}</button>}
          {activeKind === 'create' && activeRequest && <button type="button" className={styles.goButton} disabled={!canGo} onClick={runGo}>Create · {createSections(snapshot, activeRequest).allocations.length} room reservations</button>}
          {activeRequest?.kind === 'quote' && <button type="button" className={styles.goButton} disabled={!canGenerateQuote}
            onClick={() => generateQuote(activeRequest.id)}>Generate unsent quote</button>}
        </footer>
      </>}
    </div>
  );
}

type EditorProps = {
  snapshot: ReservationPaneSnapshot;
  request: ReservationRequestProjection;
  busy?: boolean;
  onStage: (path: string, value: unknown, state?: PendingReservationEdit['state']) => void;
  onBlur: (path: string) => void;
  onDone?: (path: string) => void;
  editValue: (path: string) => unknown;
  hasPendingEdit?: (path: string) => boolean;
  onOpenEvidence?: (ref: string) => void;
};

function CreateEditor(props: EditorProps & { busy: boolean; onPrepare: () => void; onLookup: () => void;
  onLookupServices: (allocationId: string, serviceId: string) => void;
  onPreviewServices: (allocationId: string, serviceId: string) => void }) {
  const { snapshot, request } = props;
  const sections = createSections(snapshot, request);
  const data = sections.data;
  if (!data) return <div className={styles.alert}>The saved Create request has no v2 booking body. Wait for source prefill or report the draft as invalid; there is no safe fallback DTO.</div>;
  const partyFields = [
    ['bookingAgency', 'Agency'], ['organization', 'Organization'], ['arAccount', 'A/R account'],
  ] as const;
  const body = sections.body;
  return <>
    <div className={styles.sectionHeader}><div><h2>Rate and payer</h2><p>Choose native codes and preserve shared values. Nightly price is observed from Infor, never typed here.</p></div></div>
    <div className={styles.card}>
      <CodeField {...props} path={`${body}/shared/roomType`} label="Shared room category" />
      <CodeField {...props} path={`${body}/shared/ratePlan`} label="Shared rate plan" help="Native code; price and availability come from Infor." />
      {partyFields.map(([key, label]) => <PartyField key={key} {...props} path={`${body}/shared/${key}`} label={label} />)}
      <div className={styles.twoCol}>
        <CodeField {...props} path={`${body}/shared/guaranteeType`} label="Guarantee type" />
        <CodeField {...props} path={`${body}/shared/track`} label="Track" />
      </div>
      <TextField {...props} path={`${body}/shared/reasonForStay`} label="Reason for stay" />
      <TextField {...props} path={`${body}/shared/sourceOfBusiness`} label="Source of business code"
        help="Editable source-bound value. Use the exact supported Infor code; no unobserved catalogue is invented." />
      <TextField {...props} path={`${body}/shared/billingReference`} label="Billing reference" />
      <TextField {...props} path={`${body}/shared/reservationNote`} label="Shared reservation note" multiline />
    </div>

    <div className={styles.sectionHeader}><div><h2>Dates and room allocation</h2><p>Each room retains its own guest and occupancy. Empty child ages remain unknown—not zero.</p></div></div>
    <div className={styles.twoCol}><button type="button" className={styles.secondaryButton} onClick={props.onLookup}>Refresh native guest and party matches</button>
      <button type="button" className={styles.secondaryButton} onClick={props.onPrepare}>Refresh current Infor price</button></div>
    {sections.sections.map(({ value: section, index }) => {
      const sectionRoot = `${body}/dateSections/${index}`;
      const allocationCount = sections.allocations.filter(({ value }) => value.dateSectionId === section.id).length;
      const requestedRooms = valueFor(snapshot, `${sectionRoot}/requestedRooms`);
      return <section className={styles.card} key={String(section.id ?? index)}>
        <div className={styles.cardTitle}><b>{text(section.title) || `Date section ${index + 1}`}</b><small>{text(requestedRooms) || 'Room count unresolved'}</small></div>
        <div className={styles.twoCol}>
          <TextField {...props} path={`${sectionRoot}/arrival`} label="Arrival" type="date" />
          <TextField {...props} path={`${sectionRoot}/departure`} label="Departure" type="date" />
        </div>
        <div className={styles.fixedValue}><span>Requested rooms / existing allocations</span><b>{text(requestedRooms) || 'Unresolved'} / {allocationCount}</b>
          <small>Addition persists as a source-bound edit. Removing/reordering rows awaits server rebasing of index-bound review and evidence paths.</small></div>
        {typeof requestedRooms === 'number' && allocationCount !== requestedRooms && <small className={styles.problem}>Room count and saved allocation rows differ. Create stays blocked until the server draft is structurally reconciled.</small>}
        <button type="button" className={styles.secondaryButton} disabled={props.busy || typeof section.id !== 'string'} onClick={() => {
          const allocationPath = `${body}/allocations`;
          const requestedRoomsPath = `${sectionRoot}/requestedRooms`;
          const nextRows = [...sections.allocations.map(({ value }) => value), emptyRoomAllocation(String(section.id))];
          const effectiveRequestedRooms = fieldOrBase(snapshot, requestedRoomsPath, requestedRooms);
          const nextRequestedRooms = typeof effectiveRequestedRooms === 'number' && effectiveRequestedRooms > allocationCount
            ? effectiveRequestedRooms : allocationCount + 1;
          props.onStage(allocationPath, nextRows);
          props.onStage(requestedRoomsPath, nextRequestedRooms);
          props.onBlur(allocationPath);
          props.onBlur(requestedRoomsPath);
        }}>Add room to these dates</button>
        <CodeField {...props} path={`${sectionRoot}/defaults/roomType`} label="Default room category" />
        <CodeField {...props} path={`${sectionRoot}/defaults/ratePlan`} label="Default rate plan" />
        <CodeField {...props} path={`${sectionRoot}/defaults/guaranteeType`} label="Default guarantee type" />
      </section>;
    })}
    {sections.allocations.map(({ value: allocation, index }) => {
      const allocationRoot = `${body}/allocations/${index}`;
      const occupancy = record(allocation.occupancy) ?? {};
      const guest = record(allocation.guest) ?? {};
      const agePath = `${allocationRoot}/occupancy/childAges`;
      const ageValue = props.editValue(agePath);
      const ages = Array.isArray(ageValue) ? ageValue : Array.isArray(occupancy.childAges) ? occupancy.childAges : [];
      const countValue = fieldOrBase(snapshot, `${allocationRoot}/occupancy/childCount`, occupancy.childCount);
      const childCount = typeof countValue === 'number' ? countValue : null;
      const profileChoicePath = `${allocationRoot}/guest/nativeSelectionRef`;
      const serviceRows = serviceRowsForAllocation(snapshot, request, String(allocation.id ?? ''));
      return <section className={styles.card} key={String(allocation.id ?? index)}>
        <div className={styles.cardTitle}><b>Room reservation {index + 1}</b><small>{text(allocation.dateSectionId) ? `Dates: ${text(allocation.dateSectionId)}` : 'Date section not assigned'}</small></div>
        <div className={styles.twoCol}>
          <TextField {...props} path={`${allocationRoot}/guest/firstName`} label="Guest first name" />
          <TextField {...props} path={`${allocationRoot}/guest/lastName`} label="Guest last name" />
        </div>
        <div className={styles.twoCol}>
          <TextField {...props} path={`${allocationRoot}/guest/email`} label="Guest email" type="email" />
          <TextField {...props} path={`${allocationRoot}/guest/mobile`} label="Guest mobile" type="tel" />
        </div>
        <GuestProfileStatus snapshot={snapshot} path={profileChoicePath}
          expected={{ firstName: Object.hasOwn(snapshot.fields, `${allocationRoot}/guest/firstName`)
            ? props.editValue(`${allocationRoot}/guest/firstName`) : guest.firstName,
            lastName: Object.hasOwn(snapshot.fields, `${allocationRoot}/guest/lastName`)
              ? props.editValue(`${allocationRoot}/guest/lastName`) : guest.lastName,
            email: Object.hasOwn(snapshot.fields, `${allocationRoot}/guest/email`)
              ? props.editValue(`${allocationRoot}/guest/email`) : guest.email }}
          onStage={props.onStage} onBlur={props.onBlur} onDone={props.onDone} />
        <div className={styles.twoCol}>
          <TextField {...props} path={`${allocationRoot}/occupancy/adults`} label="Adults" type="number" min={1} max={20} />
          <TextField {...props} path={`${allocationRoot}/occupancy/childCount`} label="Children" type="number" min={0} max={12} hideState
            blurPaths={[`${allocationRoot}/occupancy/childCount`, agePath]}
            onValue={(value) => {
              if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 12) {
                props.onStage(`${allocationRoot}/occupancy/childCount`, value);
                props.onStage(agePath, Array.from({ length: value }, (_, ageIndex) => ages[ageIndex] ?? null));
              } else {
                props.onStage(`${allocationRoot}/occupancy/childCount`, undefined, 'unknown');
                props.onStage(agePath, undefined, 'unknown');
              }
            }} />
        </div>
        {childCount !== null && childCount > 0 && <FieldShell path={agePath} label="Child ages"
          field={snapshot.fields[agePath]} onOpenEvidence={props.onOpenEvidence} onDone={props.onDone}>
          <div className={styles.ageGrid}>
          <span>Enter one exact age for each child</span>
          <FieldValueState {...props} path={agePath} />
          {Array.from({ length: childCount }, (_, ageIndex) => <TextField key={ageIndex} {...props}
            path={`${agePath}/${ageIndex}`} label={`Child ${ageIndex + 1} age`} type="number" min={0} max={17}
            valueOverride={ages[ageIndex] ?? null} blurPath={agePath} hideState onValue={(value) => {
              const next = [...ages]; next[ageIndex] = value === null ? null : Number(value); props.onStage(agePath, next);
            }} />)}
          {ages.length !== childCount || ages.some((age) => typeof age !== 'number')
            ? <small className={styles.problem}>Child count and complete ages must match.</small> : null}
          </div>
        </FieldShell>}
        <ScopedCodeField {...props} path={`${allocationRoot}/overrides/roomType`} label="Room category for this room" inherited={text(props.editValue(`${body}/dateSections/${Math.max(0, sections.sections.findIndex((entry) => entry.value.id === allocation.dateSectionId))}/defaults/roomType`)) || 'Date-section default'} />
        <ScopedCodeField {...props} path={`${allocationRoot}/overrides/ratePlan`} label="Rate plan for this room" inherited={text(props.editValue(`${body}/dateSections/${Math.max(0, sections.sections.findIndex((entry) => entry.value.id === allocation.dateSectionId))}/defaults/ratePlan`)) || text(props.editValue(`${body}/shared/ratePlan`)) || 'Shared rate plan'} />
        <ScopedCodeField {...props} path={`${allocationRoot}/overrides/guaranteeType`} label="Guarantee type for this room" inherited={text(props.editValue(`${body}/dateSections/${Math.max(0, sections.sections.findIndex((entry) => entry.value.id === allocation.dateSectionId))}/defaults/guaranteeType`)) || text(props.editValue(`${body}/shared/guaranteeType`)) || 'Shared guarantee type'} />
        <div className={styles.fixedValue}><span>Charge category</span><b>Infor default</b><small>Per-room charge-category override is not supported by the connected native Create tool.</small></div>
        <TextField {...props} path={`${allocationRoot}/overrides/reservationNote`} label="Reservation note" multiline />
        {Array.isArray(allocation.priceObservationRefs) && allocation.priceObservationRefs.length > 0 && <small className={styles.help}>Native price evidence: {allocation.priceObservationRefs.length} observation reference(s).</small>}
        {serviceRows.length > 0 && <div className={styles.serviceBlock}>
          <div className={styles.sectionHeader}><div><h3>Targeted Add-On services</h3><p>Native catalog and price previews attach to this unsaved room; service Save is not connected.</p></div></div>
          {serviceRows.map(({ service, serviceIndex, target, targetIndex }) => <ServiceEditor key={`${service.id}-${targetIndex}`}
            {...props} service={service} serviceIndex={serviceIndex} target={target} targetIndex={targetIndex}
            requestId={request.id} allocationId={String(allocation.id ?? '')}
            onLookup={() => props.onLookupServices(String(allocation.id ?? ''), service.id)}
            onPreview={() => props.onPreviewServices(String(allocation.id ?? ''), service.id)} />)}
        </div>}
      </section>;
    })}
    {sections.allocations.length === 0 && <div className={styles.notice}>No room allocations yet. Add one to a date section above to build the reservation.</div>}
    {createReviewPaths(snapshot, request).some((path) => !isRenderedCreateReviewPath(request, path)) && <section className={styles.card}>
      <div className={styles.cardTitle}><b>Additional inherited Create fields</b><small>Source-bound values outside the shared form</small></div>
      <p className={styles.help}>These populated room/date values are sent to Infor. Review or edit them before Create.</p>
      {createReviewPaths(snapshot, request).filter((path) => !isRenderedCreateReviewPath(request, path)
        && !path.endsWith('/nativeSelectionRef')).map((path) => <SupplementalCreateField key={path} {...props} path={path} />)}
    </section>}
    <NativePriceSummary snapshot={snapshot} request={request} />

    <div className={styles.sectionHeader}><div><h2>Booker and confirmation</h2><p>Booker remains distinct from each reservation guest.</p></div></div>
    <section className={styles.card}>
      <div className={styles.twoCol}><TextField {...props} path={`${body}/shared/bookerName`} label="Booker name" /><TextField {...props} path={`${body}/shared/bookerContact`} label="Booker contact" /></div>
      <BooleanField {...props} path={`${body}/shared/cmsSend`} label="Send an HMS confirmation" />
      <BooleanField {...props} path={`${body}/shared/guestOptIn`} label="Guest marketing opt-in" falseOnly />
      {Boolean(props.editValue(`${body}/shared/cmsSend`)) || hasValue(props.editValue(`${body}/shared/cmsMessageId`))
        || hasValue(props.editValue(`${body}/shared/cmsRecipient`)) ? <>
        <CodeField {...props} path={`${body}/shared/cmsMessageId`} label="Confirmation message code" />
        <TextField {...props} path={`${body}/shared/cmsRecipient`} label="Confirmation recipient" type="email" />
      </> : null}
    </section>

    {snapshot.session.draft.proposal.content.services.some((service) => service.ownerRequestId === request.id
      || service.targets.some((target) => target.target.kind === 'allocation' && target.target.requestId === request.id))
      ? <div className={styles.notice}>Service catalogue and amount previews remain unsaved; a Create confirmation does not imply an Add-On was saved.</div> : null}
    <div className={styles.policyLine}>Shared fields apply to each room unless a room-level value is explicitly set.</div>
  </>;
}

function SupplementalCreateField(props: EditorProps & { path: string }) {
  const value = valueFor(props.snapshot, props.path);
  const leaf = props.path.split('/').at(-1) ?? 'field';
  const scope = props.path.includes('/dateSections/') ? 'Date-section default' : 'Room override';
  const label = `${humanize(leaf)} · ${scope}`;
  if (record(value) && Array.isArray(record(value)?.candidateRefs)) {
    return <PartyField {...props} path={props.path} label={label} />;
  }
  if (typeof value === 'boolean' || leaf === 'guestOptIn') {
    return <BooleanField {...props} path={props.path} label={label} falseOnly={leaf === 'guestOptIn'} />;
  }
  if (['roomType', 'ratePlan', 'guaranteeType', 'track', 'cmsMessageId'].includes(leaf)) {
    return <CodeField {...props} path={props.path} label={label} />;
  }
  return <TextField {...props} path={props.path} label={label} type={leaf === 'cmsRecipient' ? 'email' : 'text'}
    multiline={leaf === 'reservationNote'} />;
}

type LinkedServiceRow = ReturnType<typeof serviceRowsForAllocation>[number];

function ServiceEditor(props: EditorProps & {
  service: LinkedServiceRow['service'];
  serviceIndex: number;
  target: LinkedServiceRow['target'];
  targetIndex: number;
  requestId: string;
  allocationId: string;
  onLookup: () => void;
  onPreview: () => void;
}) {
  const { snapshot, service, serviceIndex, targetIndex, allocationId } = props;
  const createReady = isInputReady(snapshot, props.request);
  const serviceRoot = `/proposal/content/services/${serviceIndex}`;
  const targetRoot = `${serviceRoot}/targets/${targetIndex}`;
  const itemPath = `${serviceRoot}/itemCandidateRef`;
  const selectedRef = snapshot.fields[itemPath]?.override?.state === 'set' && typeof snapshot.fields[itemPath]?.value === 'string'
    ? snapshot.fields[itemPath]!.value as string : null;
  const catalogueRows = snapshot.session.draft.observations.filter((observation) => observation.kind === 'service_preview'
    && observation.criteria.workflow === 'services' && observation.criteria.kind === 'catalogue_candidate'
    && observation.criteria.requestId === props.requestId && observation.criteria.sourceAllocationId === allocationId
    && observation.criteria.serviceId === service.id && observation.criteria.fieldPath === itemPath)
    .flatMap((observation) => {
      const candidate = record(record(observation.result)?.candidate);
      return candidate ? [{ observation, candidate }] : [];
    });
  const selected = catalogueRows.find((row) => row.observation.ref === selectedRef && row.observation.status === 'complete'
    && record(row.observation.coverage)?.complete === true);
  const latestPreview = [...snapshot.session.draft.observations].reverse().find((observation) => observation.kind === 'service_preview'
    && observation.criteria.workflow === 'services' && observation.criteria.kind === 'unsaved_addon_preview'
    && observation.criteria.requestId === props.requestId && observation.criteria.allocationId === allocationId
    && observation.criteria.serviceId === service.id);
  const previewResult = record(latestPreview?.result);
  const native = record(previewResult?.native);
  const previewCurrent = latestPreview?.criteria.draftRevision === snapshot.session.revision;
  const fields = [
    ['quantity', 'Target quantity', 'text'], ['startDate', 'Service start', 'date'], ['endDate', 'Service end', 'date'],
    ['unitPrice', 'Source unit price', 'text'], ['frequency', 'Frequency', 'text'], ['pricingControl', 'Pricing control', 'text'],
    ['folio', 'Folio', 'text'], ['comment', 'Service comment', 'text'],
  ] as const;
  return <section className={styles.serviceCard}>
    <div className={styles.cardTitle}><b>{service.requestedText || service.code || 'Add-On service'}</b><small>{humanize(service.operation)} · room {allocationId}</small></div>
    <p className={styles.help}>Choose a host-observed ITEM, then review exact target, dates, quantity and source price. All actions below are preview-only.</p>
    {service.operation !== 'add' && <div className={styles.notice}>Saved Add-On edit/remove is not connected. This row cannot be previewed as a new Add-On.</div>}
    <FieldShell path={itemPath} label="Native Add-On ITEM" field={snapshot.fields[itemPath]} onOpenEvidence={props.onOpenEvidence}>
      {selected ? <div className={styles.readValue}>{text(selected.candidate.code)} · {text(selected.candidate.name)}</div>
        : <small className={styles.help}>{selectedRef ? 'Saved ITEM choice is not verified against the current native catalogue.' : 'No staff-selected native ITEM.'}</small>}
      {catalogueRows.length > 0 && <div className={styles.candidateList}>
        {catalogueRows.map(({ observation, candidate }, index) => {
          const complete = observation.status === 'complete' && record(observation.coverage)?.complete === true;
          return <div className={styles.candidateOption} key={`${observation.ref}-${text(candidate.itemId) || index}`}>
            <span><b>{text(candidate.code)} · {text(candidate.name)}</b><small>{complete ? 'Complete native ITEM observation' : 'Incomplete native catalogue coverage; cannot be selected'}</small></span>
            {complete ? <button type="button" disabled={props.busy} onClick={() => { props.onStage(itemPath, observation.ref); props.onBlur(itemPath); }}>Select</button>
              : <small>Unavailable</small>}
          </div>;
        })}
      </div>}
      {catalogueRows.length === 0 && <small className={styles.help}>Load the native Add-On catalogue after this room’s Create inputs are ready.</small>}
    </FieldShell>
    <TextField {...props} path={`${serviceRoot}/quantityRequest/value`} label={`Requested quantity · ${humanize(service.quantityRequest.scope)} scope`} />
    <div className={styles.twoCol}>
      {fields.map(([field, label, type]) => {
        const path = `${targetRoot}/fields/${field}`;
        const sharedPath = `${serviceRoot}/sharedFields/${field}`;
        const targetField = snapshot.fields[path];
        const displayField = targetField?.override || hasValue(targetField?.value) ? targetField : snapshot.fields[sharedPath];
        return <TextField key={field} {...props} path={path} label={label} type={type}
          valueOverride={serviceFieldValue(snapshot, serviceIndex, targetIndex, field,
            { present: props.hasPendingEdit?.(path) ?? false, value: props.editValue(path) })} fieldOverride={displayField}
          help="Target value overrides the shared service value when set." />;
      })}
    </div>
    <div className={styles.twoCol}>
      <button type="button" className={styles.secondaryButton} disabled={props.busy || !createReady || service.operation !== 'add'} onClick={props.onLookup}>Load native ITEM choices</button>
      <button type="button" className={styles.secondaryButton} disabled={props.busy || !createReady || service.operation !== 'add' || !selected} onClick={props.onPreview}>Preview this Add-On · not saved</button>
    </div>
    {!createReady && <small className={styles.help}>Complete every Create room and select each existing guest profile before loading or previewing Add-On values.</small>}
    {latestPreview && <div className={latestPreview.status === 'complete' ? styles.result : styles.notice}>
      <b>Native Add-On preview · {latestPreview.status === 'complete' ? 'not saved' : 'needs attention'}</b>
      {previewCurrent ? <small>Preview matches the current saved draft revision.</small>
        : <small className={styles.problem}>Draft changed since this preview. Re-run it before relying on these values.</small>}
      {native ? <span>{text(native.code)} · {text(native.name)} · quantity {text(native.quantity)} · {text(native.currency)} {text(native.totalCost)} total</span>
        : <small>{text(previewResult?.issue) || 'No complete native Add-On price result was returned.'}</small>}
      {previewResult?.saved === false && <small>Saved: no. Create does not save this Add-On.</small>}
    </div>}
    <small className={styles.help}>This workflow can load native ITEM choices and preview exact amounts on the unsaved Create stay. It never saves an Add-On.</small>
  </section>;
}

function FieldShell({ path, label, field, children, onOpenEvidence, onDone }: {
  path: string; label: string; field?: ReservationFieldProjection; children: ReactNode; onOpenEvidence?: (ref: string) => void;
  onDone?: (path: string) => void;
}) {
  const showEvidence = Boolean(field && (field.provenance === 'source' || field.provenance === 'inferred' || field.provenance === 'assumption'));
  return <div className={styles.field} data-path={path}>
    <div className={styles.labelRow}><label htmlFor={path}>{label}</label><div className={styles.fieldStatus}>
      {showEvidence && <span className={styles.purpleDot} title={`From ${field?.provenance}`}>●</span>}
      {field?.required && field.review !== 'accepted' ? <span className={styles.required}>Review</span>
        : field?.review === 'accepted' ? <span className={styles.accepted}>✓ Reviewed</span> : null}
      {field?.required && field.review !== 'accepted' && hasValue(field.value) && onDone
        ? <button type="button" className={styles.inlineButton} onClick={() => onDone(path)}>Done</button> : null}
    </div></div>
    {children}
    {field?.issue && <small className={styles.problem}>{field.issue}</small>}
    {showEvidence && <details className={styles.evidence}><summary>Why this value?</summary><div>
      {field?.evidenceRefs.map((ref) => <button key={ref} type="button" disabled={!onOpenEvidence} onClick={() => onOpenEvidence?.(ref)}>{ref}</button>)}
      {!field?.evidenceRefs.length && <small>Evidence reference is not available.</small>}
    </div></details>}
  </div>;
}

function TextField(props: EditorProps & { path: string; label: string; type?: 'text' | 'email' | 'date' | 'number' | 'tel'; min?: number; max?: number; multiline?: boolean; help?: string; valueOverride?: unknown; fieldOverride?: ReservationFieldProjection; onValue?: (value: unknown) => void; blurPath?: string; blurPaths?: string[]; hideState?: boolean }) {
  const field = props.fieldOverride ?? props.snapshot.fields[props.path];
  const value = props.valueOverride !== undefined ? props.valueOverride : props.editValue(props.path);
  const rawValue = text(value);
  const inputValue = props.type === 'date' && rawValue.length > 10 ? rawValue.slice(0, 10) : rawValue;
  const commitOnBlur = () => {
    const paths = props.blurPaths ?? [props.blurPath ?? props.path];
    for (const path of paths) props.onBlur(path);
  };
  const input = <input id={props.path} className={styles.input} type={props.type ?? 'text'} value={inputValue} min={props.min} max={props.max}
    onChange={(event: ChangeEvent<HTMLInputElement>) => {
      const raw = event.target.value;
      const next = props.type === 'number' ? raw === '' ? null : Number(raw) : raw;
      props.onValue ? props.onValue(next) : props.onStage(props.path, next, raw === '' ? 'none' : 'set');
    }} onBlur={commitOnBlur} />;
  return <FieldShell path={props.path} label={props.label} field={field} onOpenEvidence={props.onOpenEvidence} onDone={props.onDone}>
    {props.multiline ? <textarea id={props.path} className={styles.textarea} rows={3} value={text(value)} onChange={(event) => props.onStage(props.path, event.target.value, event.target.value ? 'set' : 'none')} onBlur={commitOnBlur} /> : input}
    {!props.hideState && <FieldValueState {...props} path={props.blurPath ?? props.path} />}
    {props.help && <small className={styles.help}>{props.help}</small>}
  </FieldShell>;
}

function CodeField(props: EditorProps & { path: string; label: string; help?: string; hideState?: boolean }) {
  const field = props.snapshot.fields[props.path];
  const value = props.editValue(props.path);
  const options = observedNativeCodes(props.snapshot, props.path);
  const selectedOption = options.find((option) => option.code === text(value));
  const roomOrRate = ['roomType', 'ratePlan'].includes(props.path.split('/').at(-1) ?? '');
  return <FieldShell path={props.path} label={props.label} field={field} onOpenEvidence={props.onOpenEvidence} onDone={props.onDone}>
    <input id={props.path} className={styles.input} value={text(value)} placeholder="Native code"
      onChange={(event) => props.onStage(props.path, event.target.value, event.target.value ? 'set' : 'none')} onBlur={() => props.onBlur(props.path)} />
    {!props.hideState && <FieldValueState {...props} path={props.path} />}
    {options.length > 0 && <select className={styles.select} value={selectedOption?.code ?? ''} aria-label={`${props.label} observed native choices`} onChange={(event) => {
      const code = event.target.value;
      props.onStage(props.path, code, 'set');
      props.onBlur(props.path);
    }}><option value="">Choose a code observed in this email’s availability reads</option>
      {options.map((option) => <option key={`${option.code}-${option.ref}`} value={option.code}>{option.code} · {option.meaning}</option>)}
    </select>}
    {selectedOption && <small className={styles.help}>Observed meaning: {selectedOption.meaning}</small>}
    <small className={styles.help}>{props.help ?? (options.length
      ? 'Observed room/rate choices are source-bound native results, not a guarantee of current availability.'
      : roomOrRate ? 'Type the native code. No complete room/rate catalogue has been observed for this email yet.'
        : 'Type the supported native code. A field-specific code/meaning catalogue is not connected here yet.')}</small>
  </FieldShell>;
}

function PartyField(props: EditorProps & { path: string; label: string }) {
  const current = record(props.editValue(props.path)) ?? {};
  const field = props.snapshot.fields[props.path];
  const selectionPath = `${props.path}/nativeSelectionRef`;
  const selection = props.snapshot.fields[selectionPath];
  const selectedValue = nativeSelectionValue(props.snapshot, selectionPath);
  const selectedRef = typeof selectedValue === 'string' ? selectedValue : null;
  const tail = props.path.split('/').pop();
  const role = tail === 'bookingAgency' || tail === 'agency' ? 'agency' : tail === 'arAccount' ? 'ar_account' : 'organization';
  const candidates = props.snapshot.session.draft.observations.flatMap((observation) => {
    if (observation.kind !== 'party_candidate' || observation.status !== 'complete'
        || observation.criteria.role !== role
        || observation.criteria.fieldPath !== selectionPath
          && !(Array.isArray(observation.criteria.fieldPaths) && observation.criteria.fieldPaths.includes(selectionPath))) return [];
    const results = record(observation.result);
    const rows = Array.isArray(results?.candidates) ? results.candidates : [];
    return rows.map((candidate) => ({ observationRef: observation.ref, candidate: record(candidate) })).filter((item) => item.candidate);
  });
  const selectedCandidate = candidates.find((item) => item.observationRef === selectedRef)?.candidate;
  const selectedMatches = Boolean(selectedCandidate && sameIdentityText(selectedCandidate.name, current.name) && hasValue(selectedCandidate.nativeId));
  return <FieldShell path={props.path} label={props.label} field={field} onOpenEvidence={props.onOpenEvidence} onDone={props.onDone}>
    <input id={props.path} className={styles.input} value={String(current.name ?? '')} placeholder="Enter the requested party name"
      onChange={(event) => props.onStage(props.path, { ...current, name: event.target.value, suggestedRef: current.suggestedRef ?? null, candidateRefs: current.candidateRefs ?? [] }, event.target.value ? 'set' : 'none')}
      onBlur={() => props.onBlur(props.path)} />
    <FieldValueState {...props} path={props.path} />
    {selectedMatches && <small className={styles.accepted}>Native candidate selected.</small>}
    {selectedMatches && selectedRef && (selection?.review ?? props.snapshot.session.draft.staffReviews[selectionPath]?.status) !== 'accepted' && props.onDone
      ? <button type="button" className={styles.inlineButton} onClick={() => props.onDone?.(selectionPath)}>Confirm selected party</button> : null}
    {selectedRef && !selectedMatches && <small className={styles.problem}>Saved native selection no longer matches this party name. Select a matching result again.</small>}
    {!selectedMatches && candidates.map(({ observationRef, candidate }, index) => {
      const exact = sameIdentityText(candidate?.name, current.name) && hasValue(candidate?.nativeId);
      return <div className={styles.candidateOption} key={`${observationRef}-${String(candidate?.nativeId ?? index)}`}>
        <span><b>{text(candidate?.name)}</b><small>Infor profile {text(candidate?.nativeId)}</small></span>
        {exact ? <button type="button" onClick={() => { props.onStage(selectionPath, observationRef); props.onBlur(selectionPath); }}>Select</button>
          : <small>Search result does not exactly match the entered party name.</small>}
      </div>;
    })}
    {!selectedMatches && <small className={styles.help}>{candidates.length ? 'Select the exact host-observed match.' : 'Refresh native matches; a typed name alone is not a profile selection.'}</small>}
  </FieldShell>;
}

function ScopedCodeField(props: EditorProps & { path: string; label: string; inherited: string }) {
  const field = props.snapshot.fields[props.path];
  const ownsValue = ['set', 'none', 'clear'].includes(field?.override?.state ?? '');
  const [own, setOwn] = useState(ownsValue);
  useEffect(() => { setOwn(ownsValue); }, [field?.override?.updatedAt, field?.override?.state]);
  const mode = own ? 'own' : field?.override?.state === 'unknown' ? 'unknown' : 'inherit';
  return <div className={styles.scoped}>
    <FieldShell path={`${props.path}-mode`} label={props.label} field={field} onOpenEvidence={props.onOpenEvidence}
      onDone={props.onDone ? () => props.onDone?.(props.path) : undefined}>
      <select id={`${props.path}-mode`} className={styles.select} value={mode} onChange={(event) => {
        const value = event.target.value;
        if (value === 'own') {
          setOwn(true);
          if (!ownsValue) { props.onStage(props.path, undefined, 'none'); props.onBlur(props.path); }
          return;
        }
        if (value !== 'inherit' && value !== 'unknown') return;
        setOwn(false);
        props.onStage(props.path, undefined, value);
        props.onBlur(props.path);
      }}>
        <option value="inherit">Inherit · {props.inherited || 'default'}</option><option value="own">Own value</option><option value="unknown">Unknown</option>
      </select>
    </FieldShell>
    {mode === 'own' && <CodeField {...props} hideState />}
  </div>;
}

function FieldValueState(props: EditorProps & { path: string }) {
  const current = props.snapshot.fields[props.path]?.override?.state;
  const label = current === 'set' ? 'Own value' : current === 'unknown' ? 'Unknown'
    : current === 'none' || current === 'clear' ? 'No value' : current === 'inherit' ? 'Inherited' : 'Source value';
  return <div className={styles.valueState}>
    <small>{label}</small>
    {current !== 'inherit' && <button type="button" onClick={() => { props.onStage(props.path, undefined, 'inherit'); props.onBlur(props.path); }}>Use source / inherit</button>}
    {current !== 'unknown' && <button type="button" onClick={() => { props.onStage(props.path, undefined, 'unknown'); props.onBlur(props.path); }}>Mark unknown</button>}
    {current !== 'none' && current !== 'clear' && <button type="button" onClick={() => { props.onStage(props.path, undefined, 'none'); props.onBlur(props.path); }}>Clear value</button>}
  </div>;
}

function BooleanField(props: EditorProps & { path: string; label: string; falseOnly?: boolean }) {
  const value = props.editValue(props.path);
  return <FieldShell path={props.path} label={props.label} field={props.snapshot.fields[props.path]} onOpenEvidence={props.onOpenEvidence} onDone={props.onDone}>
    <select id={props.path} className={styles.select} value={value == null ? '' : value ? 'true' : 'false'} onChange={(event) => {
      const next = event.target.value;
      props.onStage(props.path, next === 'true' ? true : next === 'false' ? false : undefined,
        next === '' ? 'unknown' : next === 'none' ? 'none' : 'set');
      props.onBlur(props.path);
    }}><option value="">Unknown</option><option value="none">No value</option>
      {props.falseOnly ? value === true && <option value="true" disabled>Yes · unsupported</option> : <option value="true">Yes</option>}
      <option value="false">No</option></select>
    {props.falseOnly && <small className={styles.help}>The connected Create tool supports an explicit opt-out only. A requested opt-in stays visible but blocks Create.</small>}
  </FieldShell>;
}

function GuestProfileStatus({ snapshot, path, expected, onStage, onBlur, onDone }: {
  snapshot: ReservationPaneSnapshot; path: string;
  expected: { firstName: unknown; lastName: unknown; email: unknown };
  onStage: EditorProps['onStage']; onBlur: EditorProps['onBlur'];
  onDone?: EditorProps['onDone'];
}) {
  const selectedValue = nativeSelectionValue(snapshot, path);
  const selectedRef = typeof selectedValue === 'string' ? selectedValue : null;
  const selectedObservation = selectedRef ? snapshot.session.draft.observations.find((item) => item.ref === selectedRef && item.kind === 'guest_candidate') : null;
  const candidates = snapshot.session.draft.observations.filter((item) => item.kind === 'guest_candidate'
    && item.criteria.requestId === path.split('/')[4] && item.status === 'complete'
    && ((Array.isArray(item.criteria.fieldPaths) && item.criteria.fieldPaths.includes(path)) || item.criteria.fieldPath === path)).flatMap((item) => {
      const result = record(item.result);
      return Array.isArray(result?.candidates) ? result.candidates.map((candidate) => ({ observationRef: item.ref, candidate: record(candidate) })) : [];
    }).filter((item): item is { observationRef: string; candidate: Record<string, unknown> } => Boolean(item.candidate));
  const selected = guestSelectionMatches(snapshot, path, expected) ? selectedRef : null;
  return <div className={selected ? styles.profileReady : styles.profileWarning} data-profile-path={path}>
    <b>{selected ? 'Existing guest profile selected' : selectedRef ? 'Selection no longer matches this guest' : 'Select an existing Infor guest profile'}</b>
    <span>{selectedObservation ? `Native match · ${selectedObservation.status}` : selectedRef ?? 'A typed name alone is not a profile selection.'}</span>
    {selected && selectedRef && (snapshot.fields[path]?.review ?? snapshot.session.draft.staffReviews[path]?.status) !== 'accepted' && onDone
      ? <button type="button" className={styles.inlineButton} onClick={() => onDone(path)}>Confirm selected guest</button> : null}
    {!selected && candidates.length > 0 && <div className={styles.candidateList}>
      {candidates.map(({ observationRef, candidate }, index) => {
        const matchesGuest = sameIdentityText(candidate.firstName, expected.firstName) && sameIdentityText(candidate.lastName, expected.lastName)
          && (!hasValue(expected.email) || sameIdentityText(candidate.email, expected.email)) && hasValue(candidate.nativeId);
        return <div className={styles.candidateOption} key={`${observationRef}-${String(candidate.nativeId ?? index)}`}>
          <span><b>{text(candidate.firstName)} {text(candidate.lastName)}</b><small>{text(candidate.email) || `Profile ${text(candidate.nativeId)}`}</small></span>
          {matchesGuest ? <button type="button" onClick={() => { onStage(path, observationRef); onBlur(path); }}>Select</button>
            : <small>Does not exactly match the entered guest identity.</small>}
        </div>;
      })}
    </div>}
    {!selected && <small>{candidates.length ? 'Matches are evidence only until a source-bound profile selection is recorded.' : 'Refresh native matches after entering the guest name. A typed name alone will not select an existing profile.'}</small>}
  </div>;
}

function NativePriceSummary({ snapshot, request }: { snapshot: ReservationPaneSnapshot; request: ReservationRequestProjection }) {
  const allocations = createSections(snapshot, request).allocations;
  if (allocations.length === 0) return null;
  return <div className={styles.priceList} aria-label="Native Infor price and availability">
    {allocations.map(({ value: allocation }) => {
      const id = String(allocation.id ?? '');
      const view = snapshot.preparationViews.find((item) => item.requestId === request.id && item.allocationId === id);
      const price = record(view?.price);
      const hasPrice = Boolean(price && hasValue(price.currency) && hasValue(price.averageRate) && hasValue(price.totalRate));
      return <div className={styles.priceRow} key={id}>
        <span>Room {id || 'reservation'}</span>
        {hasPrice && price ? <b>{text(price.currency)} {text(price.averageRate)} / night · {text(price.totalRate)} total</b>
          : <small>{view?.issue ? humanize(view.issue) : 'No native price has been returned for this room.'}</small>}
        <small>{view?.current ? 'Current HMS price and availability' : 'Not confirmed current; Go stays blocked'}</small>
      </div>;
    })}
  </div>;
}

function QuoteEditor(props: EditorProps & { busy: boolean; onLookup: () => void; onPrepare: () => void }) {
  const body = `${requestPath(props.request)}/body`;
  const quote = record(draftAtPath(props.snapshot, body));
  if (!quote || !Array.isArray(quote.groups)) return <div className={styles.alert}>The saved Quote request has no v2 quote body.</div>;
  const groups = quote.groups.map((value, index) => ({ value: record(value) ?? {}, index }));
  const client = record(quote.client) ?? {};
  const money = Array.isArray(quote.requestedMoney) ? quote.requestedMoney : [];
  const intent = record(quote.outputIntent) ?? {};
  const artifactPath = `${body}/outputIntent/artifacts`;
  const requestedArtifactsValue = props.editValue(artifactPath);
  const requestedArtifacts = Array.isArray(requestedArtifactsValue) ? requestedArtifactsValue
    : Array.isArray(intent.artifacts) ? intent.artifacts : [];
  return <>
    <div className={styles.notice}>Quote makes source-bound, unsent customer outputs only. It never creates a booking or sends email. This adapter supports one shared date range per quote run and per-room occupancy.</div>
    <div className={styles.twoCol}>
      <button type="button" className={styles.secondaryButton} disabled={props.busy} onClick={props.onLookup}>Search native parties and quote availability</button>
      <button type="button" className={styles.secondaryButton} disabled={props.busy} onClick={props.onPrepare}>Prepare current native quote price</button>
    </div>
    <div className={styles.sectionHeader}><div><h2>Stay requirements</h2><p>HMS owns price and availability; no nightly amount can be typed into this form.</p></div></div>
    {groups.map(({ value: group, index }) => {
      const root = `${body}/groups/${index}`;
      const occupancyRoot = `${root}/occupancy`;
      const occupancy = record(group.occupancy) ?? {};
      const childCountPath = `${occupancyRoot}/childCount`;
      const agesPath = `${occupancyRoot}/childAges`;
      const countValue = props.editValue(childCountPath) ?? occupancy.childCount;
      const childCount = typeof countValue === 'number' ? countValue : null;
      const agesValue = props.editValue(agesPath);
      const ages = Array.isArray(agesValue) ? agesValue : Array.isArray(occupancy.childAges) ? occupancy.childAges : [];
      const roomCodesPath = `${root}/roomCodes`;
      const roomCodesValue = props.editValue(roomCodesPath);
      const roomCodes = Array.isArray(roomCodesValue) ? roomCodesValue.map(text).filter(Boolean)
        : Array.isArray(group.roomCodes) ? group.roomCodes.map(text).filter(Boolean) : [];
      const dateGroupCount = groups.filter(({ value: other }) => other.arrival === group.arrival && other.departure === group.departure).length;
      return <section className={styles.card} key={String(group.id ?? index)}>
        <div className={styles.cardTitle}><b>Quote group {index + 1}</b><small>{text(occupancy.scope) || 'Occupancy scope unresolved'} · {dateGroupCount === groups.length ? 'shared dates' : 'separate date range not supported in one run'}</small></div>
        <div className={styles.twoCol}><TextField {...props} path={`${root}/arrival`} label="Arrival" type="date" /><TextField {...props} path={`${root}/departure`} label="Departure" type="date" /></div>
        <div className={styles.twoCol}><TextField {...props} path={`${root}/quantity`} label="Rooms" type="number" min={1} /><CodeField {...props} path={`${root}/ratePlan`} label="Native rate-plan code" help="A pinned rate is checked against a fresh HMS quote; otherwise HMS chooses the quote rate." /></div>
        <CodeField {...props} path={`${root}/board`} label="Board code" help="Supported codes: room_only, bb, dinner_bb. Native observed meanings appear after quote lookup." />
        <TextField {...props} path={roomCodesPath} label="Room-category codes" valueOverride={roomCodes}
          onValue={(value) => props.onStage(roomCodesPath, typeof value === 'string'
            ? [...new Set(value.split(',').map((code) => code.trim()).filter(Boolean))] : [])}
          help="Optional native categories, comma-separated. Leave blank when the request does not pin a room type." />
        <QuoteRateChoices {...props} group={group} groupId={String(group.id ?? '')} groupRoot={root} />
        <FieldShell path={`${occupancyRoot}/scope`} label="Occupancy applies to" field={props.snapshot.fields[`${occupancyRoot}/scope`]}
          onOpenEvidence={props.onOpenEvidence} onDone={props.onDone}>
          <select id={`${occupancyRoot}/scope`} className={styles.select} value={text(props.editValue(`${occupancyRoot}/scope`)) || text(occupancy.scope)} onChange={(event) => {
            props.onStage(`${occupancyRoot}/scope`, event.target.value); props.onBlur(`${occupancyRoot}/scope`);
          }}><option value="">Unresolved</option><option value="per_room">Per room — supported</option><option value="whole_group">Whole group — unsupported by native quote</option><option value="unresolved">Unresolved</option></select>
          <small className={styles.help}>Native quote requires an explicit per-room occupancy scenario. No whole-party adult split is inferred.</small>
        </FieldShell>
        <div className={styles.twoCol}>
          <TextField {...props} path={`${occupancyRoot}/adults`} label="Adults per room" type="number" min={1} max={6} />
          <TextField {...props} path={childCountPath} label="Children per room" type="number" min={0} max={12} hideState
            blurPaths={[childCountPath, agesPath]} onValue={(value) => {
              if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 12) {
                props.onStage(childCountPath, value);
                props.onStage(agesPath, Array.from({ length: value }, (_, ageIndex) => ages[ageIndex] ?? null));
              } else {
                props.onStage(childCountPath, undefined, 'unknown');
                props.onStage(agesPath, undefined, 'unknown');
              }
            }} />
        </div>
        {childCount !== null && childCount >= 0 && <FieldShell path={agesPath} label="Child ages"
          field={props.snapshot.fields[agesPath]} onOpenEvidence={props.onOpenEvidence} onDone={props.onDone}>
          <div className={styles.ageGrid}>
          <span>{childCount === 0 ? 'No child ages (zero children).' : 'Exact age for each child'}</span><FieldValueState {...props} path={agesPath} />
          {childCount > 0 && Array.from({ length: childCount }, (_, ageIndex) => <TextField key={`${String(group.id ?? index)}-child-${ageIndex}`} {...props}
            path={`${agesPath}/${ageIndex}`} label={`Child ${ageIndex + 1} age`} type="number" min={0} max={17}
            valueOverride={ages[ageIndex] ?? null} blurPath={agesPath} hideState onValue={(value) => {
              const next = [...ages]; next[ageIndex] = value === null ? null : Number(value); props.onStage(agesPath, next);
            }} />)}
          {childCount > 0 && (ages.length !== childCount || ages.some((age) => typeof age !== 'number'))
            ? <small className={styles.problem}>Enter one known exact age for every child.</small> : null}
          </div>
        </FieldShell>}
      </section>;
    })}
    {groups.length === 0 && <div className={styles.notice}>This saved Quote request has no native quote groups; the server cannot price or generate outputs until source-backed groups are available.</div>}
    <QuotePriceSummary snapshot={props.snapshot} request={props.request} />
    <div className={styles.sectionHeader}><div><h2>Commercial and client details</h2><p>Native company/agency results must be explicitly selected and reviewed.</p></div></div>
    <section className={styles.card}>
      <QuotePartyField {...props} path={`${body}/parties/agency`} role="agency" label="Agency" />
      <QuotePartyField {...props} path={`${body}/parties/company`} role="company" label="Company" />
      <QuoteSalesStrategyField {...props} path={`${body}/salesStrategy`} label="Sales strategy" />
      <TextField {...props} path={`${body}/client/attention`} label="Attention" />
      <div className={styles.twoCol}><TextField {...props} path={`${body}/client/email`} label="Email for cover letter" type="email" /><TextField {...props} path={`${body}/client/telephone`} label="Telephone" type="tel" /></div>
      <TextField {...props} path={`${body}/notes`} label="Quote notes" multiline />
    </section>
    <section className={styles.card}>
      <div className={styles.cardTitle}><b>Requested amounts</b><small>Source claims only; staff-priced allowances are not connected.</small></div>
      {money.length === 0 ? <div className={styles.readValue}>No requested amount</div> : money.map((value, index) => {
        const item = record(value) ?? {};
        return <div className={styles.moneyRow} key={String(item.id ?? index)}>
          <b>{[text(item.amount), text(item.currency)].filter(Boolean).join(' ') || 'Amount unresolved'}</b>
          <span>{text(item.unit) || 'Unit unresolved'} · {humanize(text(item.scope) || 'unresolved')}</span>
          <small>Targets: {Array.isArray(item.targetRefs) ? item.targetRefs.length : 0} · evidence refs: {Array.isArray(item.sourceRefs) ? item.sourceRefs.length : 0}</small>
        </div>;
      })}
    </section>
    <section className={styles.card}>
      <div className={styles.cardTitle}><b>Unsent customer outputs</b><small>No artifact is sent from Nava.</small></div>
      <FieldShell path={artifactPath} label="Generate" field={props.snapshot.fields[artifactPath]}
        onOpenEvidence={props.onOpenEvidence} onDone={props.onDone}>
        <div className={styles.candidateList}>
          {([
            ['email_quote', 'Email cover preview'], ['pdf_quote', 'PDF attachment'], ['xlsx_quote', 'Excel workbook'],
          ] as const).map(([kind, label]) => <label className={styles.candidateOption} key={kind}>
            <span><b>{label}</b><small>{kind === 'email_quote' ? 'Cover text only; no send.' : 'Stored on this source-bound quote receipt.'}</small></span>
            <input type="checkbox" checked={requestedArtifacts.includes(kind)} onChange={(event) => {
              const next = event.target.checked ? [...new Set([...requestedArtifacts, kind])] : requestedArtifacts.filter((value) => value !== kind);
              props.onStage(artifactPath, next); props.onBlur(artifactPath);
            }} />
          </label>)}
        </div>
        {requestedArtifacts.includes('email_quote') && !requestedArtifacts.some((value) => value === 'pdf_quote' || value === 'xlsx_quote')
          && <small className={styles.problem}>The native quote adapter requires a PDF or Excel attachment with an email-cover preview.</small>}
      </FieldShell>
    </section>
    <QuoteArtifactReceipts snapshot={props.snapshot} request={props.request} />
    {Object.keys(client).length === 0 && <span className={styles.help}>No client identity was extracted.</span>}
  </>;
}

function QuotePartyField(props: EditorProps & { path: string; role: 'agency' | 'company'; label: string }) {
  const party = record(props.editValue(props.path)) ?? record(draftAtPath(props.snapshot, props.path)) ?? {};
  const namePath = `${props.path}/name`;
  const name = text(props.editValue(namePath) ?? party.name);
  const nameField = props.snapshot.fields[namePath] ?? {
    path: namePath, value: name,
    required: props.snapshot.session.draft.fieldReviewRequirements[namePath]?.required !== false,
    review: props.snapshot.session.draft.staffReviews[namePath]?.status ?? 'pending',
    provenance: 'source' as const,
    evidenceRefs: props.snapshot.session.draft.fieldReviewRequirements[namePath]?.evidenceRefs ??
      props.snapshot.session.draft.proposal.sourceClaims.find((claim) => claim.path === namePath)?.sourceRefs ?? [],
  };
  const selectionPath = `${props.path}/nativeSelectionRef`;
  const selectedRef = props.snapshot.fields[selectionPath]?.override?.state === 'set'
    && typeof props.snapshot.fields[selectionPath]?.value === 'string' ? props.snapshot.fields[selectionPath]!.value as string : null;
  const candidates = props.snapshot.session.draft.observations.flatMap((observation) => {
    if (observation.kind !== 'party_candidate' || observation.status !== 'complete' || record(observation.coverage)?.complete !== true
        || observation.criteria.workflow !== 'quote' || observation.criteria.requestId !== props.request.id
        || observation.criteria.role !== props.role || !sameIdentityText(observation.criteria.searchName, name)) return [];
    const candidate = record(observation.result);
    return candidate && hasValue(candidate.nativeId) && hasValue(candidate.name) ? [{ observation, candidate }] : [];
  });
  const selected = candidates.find((entry) => entry.observation.ref === selectedRef
    && sameIdentityText(entry.candidate.name, name));
  return <FieldShell path={props.path} label={props.label} field={props.snapshot.fields[props.path]}
    onOpenEvidence={props.onOpenEvidence} onDone={props.onDone}>
    <TextField {...props} path={namePath} label={`${props.label} name`} fieldOverride={nameField} />
    <FieldValueState {...props} path={props.path} />
    {selected ? <small className={styles.accepted}>Native {props.role} selected: {text(selected.candidate.name)} · {text(selected.candidate.nativeId)}</small>
      : <small className={styles.help}>{selectedRef ? 'Selected native result no longer matches this name.' : 'Search native parties, then select the exact matching company or agency.'}</small>}
    {!selected && candidates.map(({ observation, candidate }) => <div className={styles.candidateOption} key={observation.ref}>
      <span><b>{text(candidate.name)}</b><small>Native {props.role} · {text(candidate.nativeId)}</small></span>
      <button type="button" disabled={props.busy} onClick={() => { props.onStage(selectionPath, observation.ref); props.onBlur(selectionPath); }}>Select</button>
    </div>)}
  </FieldShell>;
}

function QuoteSalesStrategyField(props: EditorProps & { path: string; label: string }) {
  const value = text(props.editValue(props.path));
  const choices = ['BAR', 'PROMO', 'PRESET', 'WS', 'NC', 'GOV', 'AIR', 'DOML', 'OTHER', 'Government'];
  return <FieldShell path={props.path} label={props.label} field={props.snapshot.fields[props.path]}
    onOpenEvidence={props.onOpenEvidence} onDone={props.onDone}>
    <select id={props.path} className={styles.select} value={value} onChange={(event) => {
      props.onStage(props.path, event.target.value); props.onBlur(props.path);
    }}><option value="">Choose supported strategy code</option>
      {value && !choices.includes(value) && <option value={value}>{value} · not in native quote adapter</option>}
      {choices.map((code) => <option key={code} value={code}>{code} · {humanize(code)}</option>)}
    </select>
  </FieldShell>;
}

function quoteMoney(minor: unknown, currency: unknown): string {
  if (typeof minor !== 'number' || !Number.isSafeInteger(minor)) return '';
  return `${text(currency) || 'ZAR'} ${(minor / 100).toFixed(2)}`;
}

function QuoteRateChoices(props: EditorProps & { group: Record<string, unknown>; groupId: string; groupRoot: string }) {
  const { snapshot, request, groupId, groupRoot } = props;
  const options = quoteRateOptions(snapshot, request.id, groupId);
  const observation = latestQuotePriceObservation(snapshot, request.id);
  if (!options.length) return <small className={styles.help}>Native room/rate meanings appear after a complete quote lookup; a later Prepare refreshes current price.</small>;
  const roomCodesPath = `${groupRoot}/roomCodes`;
  const boardPath = `${groupRoot}/board`;
  const ratePath = `${groupRoot}/ratePlan`;
  return <div className={styles.candidateList}>
    {options.map((option, index) => {
      const roomCode = text(option.roomCode);
      const rateCode = text(option.rateCode);
      const board = text(option.board);
      const optionId = text(option.id) || `${roomCode}-${rateCode}-${board}-${index}`;
      const currentRate = text(props.editValue(ratePath));
      const currentRoomCodes = props.editValue(roomCodesPath);
      const currentBoard = text(props.editValue(boardPath));
      const selected = currentRate === rateCode && currentBoard === board
        && Array.isArray(currentRoomCodes) && currentRoomCodes.map(text).includes(roomCode);
      return <div className={styles.candidateOption} key={`${observation?.ref}-${optionId}`}>
        <span><b>{roomCode} · {text(option.roomLabel) || roomCode} / {rateCode} · {text(option.rateLabel) || rateCode}</b>
          <small>{text(option.boardLabel) || board} · {quoteMoney(option.perNightMinor, option.currency)} per night · {quoteMoney(option.totalMinor, option.currency)} total
            {typeof option.roomsLeft === 'number' ? ` · ${option.roomsLeft} rooms left` : ''}{option.priced === 'summary' ? ' · summary only' : ''}</small></span>
        <button type="button" disabled={props.busy || !roomCode || !rateCode || !board} aria-pressed={selected}
          onClick={() => {
            const rateCodes = props.editValue(roomCodesPath);
            props.onStage(roomCodesPath, [...new Set([...(Array.isArray(rateCodes) ? rateCodes.map(text).filter(Boolean) : []), roomCode])]);
            props.onStage(ratePath, rateCode);
            props.onStage(boardPath, board);
            props.onBlur(roomCodesPath); props.onBlur(ratePath); props.onBlur(boardPath);
          }}>{selected ? 'Selected option' : 'Use observed option'}</button>
      </div>;
    })}
  </div>;
}

function QuotePriceSummary({ snapshot, request }: { snapshot: ReservationPaneSnapshot; request: ReservationRequestProjection }) {
  const observation = latestQuotePriceObservation(snapshot, request.id);
  if (!observation) return <div className={styles.notice}>No native quote price has been observed yet. Search parties, select exact native matches, then look up and prepare the quote.</div>;
  const result = record(observation.result);
  const freshUntil = typeof result?.freshUntil === 'string' ? Date.parse(result.freshUntil) : Number.NaN;
  const fresh = observation.status === 'complete' && record(observation.coverage)?.complete === true && Number.isFinite(freshUntil) && freshUntil > Date.now();
  const prepared = isQuotePrepared(snapshot, request);
  const notes = record(observation.coverage)?.notes;
  const issue = text(result?.issue) || (Array.isArray(notes) ? text(notes[0]) : '');
  return <section className={styles.card} aria-label="Native Quote price and availability">
    <div className={styles.cardTitle}><b>Native HMS quote price</b><small>{prepared ? 'Prepared for current saved fields' : fresh ? 'Observed; prepare again before generating outputs' : 'Expired or incomplete'}</small></div>
    {hasValue(result?.totalMinor) ? <div className={styles.priceRow}><b>{quoteMoney(result?.totalMinor, result?.currency)}</b>
      <small>{text(result?.arrivalDate)} – {text(result?.departureDate)} · native quote total</small></div>
      : <div className={styles.notice}>{issue ? humanize(issue) : 'No current native quote total was returned.'}</div>}
    {freshUntil && Number.isFinite(freshUntil) && <small className={styles.help}>Native price valid until {new Date(freshUntil).toLocaleString()}.</small>}
    <small className={fresh ? styles.help : styles.problem}>{prepared ? 'Current HMS price and availability are ready. Go only creates requested unsent artifacts.'
      : fresh ? 'This read is not yet a prepared quote for the current draft.' : 'No current price is confirmed; Go stays blocked.'}</small>
  </section>;
}

function QuoteArtifactReceipts({ snapshot, request }: { snapshot: ReservationPaneSnapshot; request: ReservationRequestProjection }) {
  const receipts = quoteReceiptObservations(snapshot, request.id);
  if (!receipts.length) return <div className={styles.notice}>No quote output receipt exists yet. Generate is enabled only after a current native Prepare and required-field review.</div>;
  return <>
    {receipts.map((observation) => {
      const result = record(observation.result) ?? {};
      const artifacts = Array.isArray(result.artifacts) ? result.artifacts.map(record).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
      const cover = record(result.coverEmail);
      const failures = Array.isArray(result.failures) ? result.failures.map(text).filter(Boolean) : [];
      return <section className={styles.card} key={observation.ref}>
        <div className={styles.cardTitle}><b>Quote output receipt</b><small>{observation.coverage.complete ? 'Complete' : 'Partial or failed'}</small></div>
        <div className={styles.notice}>Email sent: no. Reservation saved: no.</div>
        {artifacts.length ? artifacts.map((artifact, index) => {
          const name = text(artifact.fileName) || `quote-output-${index + 1}`;
          const mime = text(artifact.mimeType);
          const hasBytes = typeof artifact.bytesBase64 === 'string' && artifact.bytesBase64.length > 0;
          return <div className={styles.attachmentBound} key={`${text(artifact.sha256) || name}-${index}`}>
            <b>{name}</b><small>{humanize(text(artifact.kind) || 'quote output')} · {mime || 'MIME type unavailable'} · {text(artifact.sizeBytes)} bytes</small>
            {hasBytes ? <div className={styles.twoCol}>
              <button type="button" className={styles.inlineButton} onClick={() => deliverQuoteArtifact(artifact)}>Download</button>
              {mime === 'application/pdf' && <button type="button" className={styles.inlineButton} onClick={() => deliverQuoteArtifact(artifact, true)}>Open PDF</button>}
            </div> : <small className={styles.problem}>This receipt has no artifact bytes; no download is offered.</small>}
          </div>;
        }) : <div className={styles.notice}>No output bytes were returned for this receipt.</div>}
        {cover && <div className={styles.fixedValue}><b>Email cover preview · not sent</b><span>To: {text(cover.to)}</span><span>{text(cover.subject)}</span><small className={styles.coverText}>{text(cover.body)}</small></div>}
        {failures.map((failure) => <small className={styles.problem} key={failure}>{humanize(failure)}</small>)}
      </section>;
    })}
  </>;
}

function FilingEditor({ snapshot, request, source, onOpenAttachment }: {
  snapshot: ReservationPaneSnapshot; request: ReservationRequestProjection; source: ReservationSourceContext;
  onOpenAttachment?: (ref: string) => void;
}) {
  const linkedRefs = draftAtPath(snapshot, `${requestPath(request)}/documentRefs`);
  const requestDocs = Array.isArray(linkedRefs) ? linkedRefs : [];
  const docs = snapshot.session.draft.proposal.content.documents.filter((document) =>
    document.ownerRequestId === request.id || requestDocs.includes(document.id));
  const targetScope = draftAtPath(snapshot, `${requestPath(request)}/body/targets`);
  return <>
    <div className={styles.sectionHeader}><div><h2>Filing source and destination</h2><p>Files stay bound to admitted email bytes and exact existing reservation targets.</p></div></div>
    {docs.length === 0 ? <div className={styles.notice}>No document is bound to this Filing request.</div> : docs.map((document) => {
      const attachment = source.attachments.find((item) => item.sourceRef === document.documentSourceRef);
      return <section className={styles.card} key={document.id}>
        <div className={styles.cardTitle}><b>{humanize(document.kind)}</b><small>{document.handling === 'filing_requested' ? 'Filing requested' : document.handling}</small></div>
        {attachment ? <div className={styles.attachmentBound}><b>{attachment.name}</b><small>{attachment.mimeType ?? 'Unknown file type'} · {attachment.uploadability}</small>
          {onOpenAttachment && <button type="button" className={styles.inlineButton} disabled={attachment.uploadability !== 'ready'} onClick={() => onOpenAttachment(attachment.sourceRef)}>Open admitted attachment</button>}</div>
          : <div className={styles.alert}>Saved source evidence ref: {document.documentSourceRef}. It does not match a host attachment ID; no file-bytes binding is available yet.</div>}
        <div className={styles.fixedValue}><span>Targets in saved request</span><b>{document.targetRefs.length || 'Unresolved'}</b><small>No destination is inferred from a guest name.</small></div>
      </section>;
    })}
    {!docs.length && source.attachments.length > 0 && <section className={styles.card}>
      <div className={styles.cardTitle}><b>Attachments on selected email</b><small>No filing document is linked to them</small></div>
      {source.attachments.map((attachment) => <div className={styles.attachmentBound} key={attachment.sourceRef}>
        <b>{attachment.name}</b><small>{attachment.mimeType ?? 'Unknown file type'} · {attachment.uploadability}</small>
        {onOpenAttachment && <button type="button" className={styles.inlineButton} disabled={attachment.uploadability !== 'ready'} onClick={() => onOpenAttachment(attachment.sourceRef)}>Open admitted attachment</button>}
      </div>)}
    </section>}
    {record(targetScope) && <section className={styles.card}>
      <div className={styles.cardTitle}><b>Saved target scope</b><small>{humanize(String(record(targetScope)?.mode ?? 'unresolved'))}</small></div>
      {['include', 'exclude'].map((side) => {
        const refs = record(targetScope)?.[side];
        const list = Array.isArray(refs) ? refs : [];
        return <div className={styles.targetScope} key={side}><b>{humanize(side)}</b>{list.length
          ? list.map((value) => <small key={`${side}-${text(record(value)?.id) || JSON.stringify(value)}`}>{JSON.stringify(value)}</small>)
          : <small>None recorded</small>}</div>;
      })}
    </section>}
    <div className={styles.notice}>Filing execution is not connected in the current route. No local receipt or success state is created.</div>
  </>;
}

function RequestReview({ snapshot, request }: { snapshot: ReservationPaneSnapshot; request: ReservationRequestProjection }) {
  const fields = request.fieldPaths.map((path) => ({ path, field: snapshot.fields[path] }))
    .filter((item) => item.field && !item.path.endsWith('/id'));
  return <>
    <div className={styles.notice}>This v2 request is visible from the saved source draft. A dedicated task form is not connected yet; the fields below are read-only.</div>
    <section className={styles.card}>{fields.map(({ path, field }) => <div className={styles.readRow} key={path}>
      <b>{humanize(path.split('/').pop() ?? 'Field')}</b><span>{text(field?.value) || 'Not provided'}</span>
      {field?.provenance !== 'unknown' && <small>Source: {field?.provenance}</small>}
    </div>)}</section>
  </>;
}

function OperationResult({ result, onReconcile, busy }: { result: Record<string, unknown>; onReconcile: (operationId: string) => void; busy: boolean }) {
  const status = text(result.status) || 'Unknown';
  return <section className={styles.result}>
    <div><b>{text(result.summary) || `${humanize(text(result.workflow) || 'operation')} · ${text(result.allocationId) || ''}`}</b><span className={styles.resultStatus}>{humanize(status)}</span></div>
    {hasValue(result.confirmation) && <p>Confirmation <strong>{text(result.confirmation)}</strong></p>}
    {hasValue(result.summary) && <small>{text(result.summary)}</small>}
    {status === 'unknown' && typeof result.id === 'string' && <button type="button" className={styles.secondaryButton} disabled={busy}
      onClick={() => onReconcile(result.id as string)}>Check Infor outcome</button>}
  </section>;
}
