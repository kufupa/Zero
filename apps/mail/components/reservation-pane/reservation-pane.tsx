'use client';

import { useCallback, useEffect, useReducer, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import styles from './reservation-pane.module.css';
import { initialReservationUiState, reduceReservationUi, type PendingReservationEdit } from '@/lib/reservation-workflow/reducer';
import { beginMutation, endMutation } from '@/lib/workstation/mutations-in-flight';
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

/** Read a source subtree with all source-bound staff leaf overrides applied. */
function effectiveValueFor(snapshot: ReservationPaneSnapshot, path: string, sourceValue?: unknown): unknown {
  const field = snapshot.fields[path];
  const raw = field ? field.value : sourceValue ?? draftAtPath(snapshot, path);
  const override = snapshot.session.draft.fieldOverrides[path] ?? field?.override;
  let value = raw;
  if (override?.state === 'set') value = override.value;
  else if (override?.state === 'none' || override?.state === 'clear' || override?.state === 'unknown') return null;
  else if (record(raw)?.kind === 'none') return null;

  const prefix = `${path}/`;
  const childSegments = Object.keys(snapshot.session.draft.fieldOverrides).flatMap((overridePath) => {
    if (!overridePath.startsWith(prefix)) return [];
    const segment = overridePath.slice(prefix.length).split('/')[0];
    try { return [decodeURIComponent(segment)]; } catch { return [segment]; }
  });
  if (Array.isArray(value)) {
    const overrideIndexes = childSegments.map(Number).filter((index) => Number.isInteger(index) && index >= 0 && index < 200);
    const length = Math.max(value.length, overrideIndexes.length ? Math.max(...overrideIndexes) + 1 : 0);
    return Array.from({ length }, (_, index) => effectiveValueFor(snapshot, `${path}/${index}`, value[index]));
  }
  const objectValue = record(value);
  if (objectValue) {
    const keys = new Set([...Object.keys(objectValue), ...childSegments]);
    return Object.fromEntries([...keys].map((key) => [key,
      effectiveValueFor(snapshot, `${path}/${encodeURIComponent(key)}`, objectValue[key])]));
  }
  return value;
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
  for (const [index, path] of paths.entries()) {
    const field = snapshot.fields[path];
    const override = field?.override;
    if (override) {
      if (override.state === 'unknown' || override.state === 'none' || override.state === 'clear') return null;
      if (override.state === 'set') return field.value;
      if (override.state === 'inherit' && index < paths.length - 1) continue;
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
  if (parts[0] === 'proposal' && parts[1] === 'content' && parts[2] === 'documents' && parts.length >= 5) {
    const document = snapshot.session.draft.proposal.content.documents.find((entry) => entry.id === parts[3]);
    if (!document?.ownerRequestId) return null;
    const request = snapshot.session.draft.proposal.content.requests.find((entry) => entry.id === document.ownerRequestId
      && entry.kind === 'filing');
    const requestRoot = request ? `/proposal/content/requests/${encoded(request.id)}` : '';
    const refs = request ? valueFor(snapshot, `${requestRoot}/documentRefs`) : null;
    return request && Array.isArray(refs) && refs.includes(document.id) ? request.id : null;
  }
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

function serviceIdForField(snapshot: ReservationPaneSnapshot, path: string): string | null {
  const parts = path.split('/').slice(1).map((part) => {
    try { return decodeURIComponent(part); } catch { return ''; }
  });
  if (parts[0] !== 'proposal' || parts[1] !== 'content' || parts[2] !== 'services' || parts.length < 5) return null;
  const rawIndex = parts[3]!;
  const index = Number(rawIndex);
  const services = snapshot.session.draft.proposal.content.services;
  const service = Number.isInteger(index) && index >= 0 && String(index) === rawIndex
    ? services[index] : services.find((row) => row.id === rawIndex);
  return service?.id ?? null;
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
  return preparedQuoteObservation(snapshot, requestId) ?? [...snapshot.session.draft.observations].reverse().find((observation) => observation.kind === 'rate_availability'
    && observation.criteria.workflow === 'quote' && observation.criteria.requestId === requestId);
}

function quoteRateOptions(snapshot: ReservationPaneSnapshot, requestId: string, groupId?: string): Array<Record<string, unknown>> {
  const observation = latestQuotePriceObservation(snapshot, requestId);
  if (!observation || observation.status !== 'complete' || record(observation.coverage)?.complete !== true) return [];
  const result = record(observation.result);
  const options = Array.isArray(result?.rateOptions) ? result.rateOptions.map(record).filter((value): value is Record<string, unknown> => Boolean(value)) : [];
  return groupId ? options.filter((option) => option.groupId === groupId) : options;
}

function quoteInputOverrides(snapshot: ReservationPaneSnapshot, requestId: string) {
  const draft = snapshot.session.draft;
  const index = draft.proposal.content.requests.findIndex((request) => request.id === requestId);
  const prefixes = [`/proposal/content/requests/${encodeURIComponent(requestId)}`, `/proposal/content/requests/${index}`];
  return Object.fromEntries(Object.entries(draft.fieldOverrides)
    .filter(([path]) => prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, override]) => [path, { state: override.state,
      ...(override.state === 'set' ? { value: override.value } : {}) }]));
}

function quoteReviewInfo(snapshot: ReservationPaneSnapshot, requestId: string) {
  const observation = latestQuotePriceObservation(snapshot, requestId);
  const rawItems = record(observation?.result)?.extrasReviewItems;
  const items = Array.isArray(rawItems) ? rawItems.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
  const path = `/proposal/content/requests/${encodeURIComponent(requestId)}/body`;
  const review = snapshot.session.draft.staffReviews[path];
  return { path, items, accepted: review?.status === 'accepted' && Boolean(observation) &&
    Date.parse(review.at ?? '') >= Date.parse(observation!.observedAt) };
}

function preparedQuoteObservation(snapshot: ReservationPaneSnapshot, requestId: string) {
  const preparation = [...snapshot.operationResults].reverse().find((result) => result.requestId === requestId
    && result.workflow === 'quote' && result.status === 'prepared');
  if (!preparation || preparation.generationId !== snapshot.session.draft.generationId
      || !Array.isArray(preparation.observationRefs)) return null;
  return preparation.observationRefs.map((ref) => snapshot.session.draft.observations.find((item) => item.ref === ref && item.kind === 'rate_availability')).find((observation) => {
    const result = record(observation?.result);
    const criteria = record(observation?.criteria);
    const freshUntil = typeof result?.freshUntil === 'string' ? Date.parse(result.freshUntil) : Number.NaN;
    return observation?.status === 'complete' && record(observation.coverage)?.complete === true
      && observation.generationId === snapshot.session.draft.generationId
      && observation.propertyCode === snapshot.session.draft.propertyCode
      && observation.sourceMessageId === snapshot.session.draft.source.messageId
      && JSON.stringify(result?.inputOverrides) === JSON.stringify(quoteInputOverrides(snapshot, requestId))
      && criteria?.workflow === 'quote' && criteria.requestId === requestId
      && criteria.inputDigest === result?.inputDigest && typeof result?.inputDigest === 'string'
      && criteria.sourceHash === snapshot.session.draft.source.sourceHash
      && Number.isFinite(freshUntil) && freshUntil > Date.now();
  });
}

function isQuotePrepared(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection): boolean {
  return Boolean(preparedQuoteObservation(snapshot, request.id));
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
  const requestedField = leaf === 'value' ? text(valueFor(snapshot, `${path.replace(/\/value$/u, '')}/field`)) : leaf;
  const catalogKey = requestedField === 'roomType' ? 'room' : requestedField === 'ratePlan' ? 'ratePlan'
    : requestedField === 'board' ? 'board' : null;
  if (!catalogKey) return [];
  const requestId = path.split('/')[4];
  const choices = new Map<string, { code: string; meaning: string; ref: string }>();
  const addChoice = (rawCode: unknown, rawMeaning: unknown, ref: string) => {
    const code = text(rawCode).trim();
    if (!code || choices.has(code)) return;
    choices.set(code, { code, meaning: text(rawMeaning).trim() || code, ref });
  };
  for (const observation of snapshot.session.draft.observations) {
    if (observation.status !== 'complete' || observation.criteria.requestId !== requestId
        || record(observation.coverage)?.complete !== true) continue;
    if (observation.kind === 'stay_candidate' && observation.criteria.workflow === 'amend') {
      const candidate = record(record(observation.result)?.candidate);
      if (!candidate) continue;
      const codeField = catalogKey === 'room' ? 'roomType' : 'ratePlan';
      addChoice(candidate[codeField], `Observed on saved stay ${text(candidate.confirmation)}`.trim(), observation.ref);
      continue;
    }
    if (observation.kind !== 'rate_availability') continue;
    if (observation.criteria.workflow === 'quote') {
      const options = quoteRateOptions(snapshot, requestId);
      for (const option of options) {
        const code = text(catalogKey === 'room' ? option.roomCode : catalogKey === 'ratePlan' ? option.rateCode : option.board).trim();
        if (!code || choices.has(code)) continue;
        const meaning = text(catalogKey === 'room' ? option.roomLabel : catalogKey === 'ratePlan' ? option.rateLabel : option.boardLabel).trim() || code;
        addChoice(code, meaning, observation.ref);
      }
      continue;
    }
    if (observation.criteria.workflow === 'amend') {
      const target = record(record(observation.result)?.target);
      if (target) {
        const codeField = catalogKey === 'room' ? 'roomType' : 'ratePlan';
        addChoice(target[codeField], `Prepared native value · ${text(target.confirmation)}`.trim(), observation.ref);
      }
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
        addChoice(code, meaning, observation.ref);
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
  for (const [index, path] of paths.entries()) {
    const field = snapshot.fields[path];
    const override = field?.override;
    if (override) {
      if (override.state === 'unknown' || override.state === 'none' || override.state === 'clear') return null;
      if (override.state === 'set') return hasValue(field.value) ? path : null;
      if (override.state === 'inherit' && index < paths.length - 1) continue;
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
  const refs = valueFor(snapshot, `${requestPath(request)}/documentRefs`);
  if (!Array.isArray(refs)) return [];
  return refs.flatMap((ref) => typeof ref === 'string' ? snapshot.session.draft.proposal.content.documents.filter((document) =>
    document.id === ref && document.ownerRequestId === request.id) : []);
}

function filingDocumentPath(documentId: string, field: string): string {
  return `/proposal/content/documents/${encoded(documentId)}/${encoded(field)}`;
}

function filingDocumentValue(snapshot: ReservationPaneSnapshot, document: { id: string; kind: string; handling: string }, field: 'kind' | 'handling'): unknown {
  const path = filingDocumentPath(document.id, field);
  return Object.hasOwn(snapshot.fields, path) ? snapshot.fields[path]?.value : document[field];
}

function filingTargetHints(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection) {
  const scope = record(valueFor(snapshot, `${requestPath(request)}/body/targets`));
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
  const draft = snapshot.session.draft;
  const observation = snapshot.session.draft.observations.find((entry) => entry.ref === selectedRef && entry.kind === 'stay_candidate'
    && entry.status === 'complete' && record(entry.coverage)?.complete === true && entry.generationId === draft.generationId
    && entry.propertyCode === draft.propertyCode && entry.sourceMessageId === draft.source.messageId
    && entry.criteria.workflow === 'filing' && entry.criteria.requestId === request.id && entry.criteria.targetHintId === hint.id
    && record(entry.result)?.outcome === 'found');
  const stay = record(record(observation?.result)?.stay);
  if (!observation || !stay || (hasValue(hint.confirmation) && hint.confirmation !== stay.confirmation)
      || (hasValue(hint.bookedArrival) && hint.bookedArrival !== stay.arrival)
      || (hasValue(hint.bookedDeparture) && hint.bookedDeparture !== stay.departure)
      || (hasValue(hint.guestName) && !sameIdentityText(hint.guestName, `${text(stay.firstName)} ${text(stay.lastName)}`))) return null;
  return { hint, path, observation, stay };
}

function filingTargetCandidates(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection,
  hint: Record<string, unknown>) {
  const draft = snapshot.session.draft;
  return draft.observations.flatMap((observation) => {
    if (observation.kind !== 'stay_candidate' || observation.status !== 'complete' || record(observation.coverage)?.complete !== true
        || observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode
        || observation.sourceMessageId !== draft.source.messageId || observation.criteria.workflow !== 'filing'
        || observation.criteria.requestId !== request.id || observation.criteria.targetHintId !== hint.id) return [];
    const result = record(observation.result);
    const stay = record(result?.stay);
    if (result?.outcome !== 'found' || !stay) return [];
    const matches = (!hasValue(hint.confirmation) || hint.confirmation === stay.confirmation)
      && (!hasValue(hint.bookedArrival) || hint.bookedArrival === stay.arrival)
      && (!hasValue(hint.bookedDeparture) || hint.bookedDeparture === stay.departure)
      && (!hasValue(hint.guestName) || sameIdentityText(hint.guestName, `${text(stay.firstName)} ${text(stay.lastName)}`));
    return [{ observation, stay, matches }];
  });
}

function filingSourceObservation(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection, documentId: string,
  targetObservationRef?: string) {
  const draft = snapshot.session.draft;
  return [...snapshot.session.draft.observations].reverse().find((entry) => entry.kind === 'document'
    && entry.status === 'complete' && record(entry.coverage)?.complete === true
    && entry.generationId === draft.generationId && entry.propertyCode === draft.propertyCode && entry.sourceMessageId === draft.source.messageId
    && entry.criteria.workflow === 'filing' && entry.criteria.requestId === request.id && entry.criteria.documentId === documentId
    && (!targetObservationRef || entry.criteria.targetObservationRef === targetObservationRef)
    && record(entry.result)?.outcome === 'ready');
}

function isFilingReadyForPrepare(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection): boolean {
  const documents = filingDocuments(snapshot, request);
  const target = filingTargetObservation(snapshot, request);
  const document = documents[0];
  if (documents.length !== 1 || !document || filingDocumentValue(snapshot, document, 'handling') !== 'filing_requested'
      || !['voucher', 'payment_proof'].includes(String(filingDocumentValue(snapshot, document, 'kind'))) || !target) return false;
  const source = filingSourceObservation(snapshot, request, documents[0]!.id, target.observation.ref);
  return Boolean(source && typeof record(source.result)?.sha256 === 'string'
    && typeof record(source.result)?.sourceSnapshotDigest === 'string');
}

function isFilingReadyForLookup(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection): boolean {
  const documents = filingDocuments(snapshot, request);
  const document = documents[0];
  const { scope, include } = filingTargetHints(snapshot, request);
  return documents.length === 1 && Boolean(document)
    && Boolean(document?.documentSourceRef)
    && filingDocumentValue(snapshot, document!, 'handling') === 'filing_requested'
    && ['voucher', 'payment_proof'].includes(String(filingDocumentValue(snapshot, document!, 'kind')))
    && scope?.mode === 'explicit' && include.length === 1
    && (!Array.isArray(scope.exclude) || scope.exclude.length === 0)
    && typeof include[0]?.confirmation === 'string' && /^\d+-\d+$/u.test(include[0].confirmation);
}

function hasCurrentFilingPreparation(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection): boolean {
  const documents = filingDocuments(snapshot, request);
  const target = filingTargetObservation(snapshot, request);
  const source = documents.length === 1 && target
    ? filingSourceObservation(snapshot, request, documents[0]!.id, target.observation.ref) : undefined;
  if (!target || !source) return false;
  const draft = snapshot.session.draft;
  const operation = [...snapshot.operationResults].reverse().find((result) => result.workflow === 'filing'
    && result.requestId === request.id && result.generationId === draft.generationId && result.status === 'prepared');
  if (!operation || !Array.isArray(operation.observationRefs)) return false;
  return operation.observationRefs.some((ref) => {
    const observation = draft.observations.find((entry) => entry.ref === ref && entry.kind === 'document'
      && entry.status === 'complete' && entry.generationId === draft.generationId
      && entry.criteria.workflow === 'filing' && entry.criteria.requestId === request.id
      && entry.criteria.documentId === documents[0]!.id && entry.criteria.targetObservationRef === target.observation.ref);
    const result = record(observation?.result);
    const preparedTarget = record(result?.target);
    const sourceResult = record(source.result);
    return result?.outcome === 'prepared' && typeof result.semanticDigest === 'string'
      && result.sha256 === sourceResult?.sha256 && result.sourceSnapshotDigest === sourceResult?.sourceSnapshotDigest
      && preparedTarget?.confirmation === target.stay.confirmation && preparedTarget?.arrival === target.stay.arrival;
  });
}

function filingPreparationStamp(snapshot: ReservationPaneSnapshot, source: ReservationSourceContext): string {
  const draft = snapshot.session.draft;
  return [source.selectionEpoch, source.messageId, source.sourceHash, draft.generationId, snapshot.session.revision, snapshot.session.seq].join(':');
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
  const filingRequired = request.kind === 'filing' ? new Set(filingReviewPaths(snapshot, request)) : null;
  return paths.some((path) => {
    const field = snapshot.fields[path];
    const selectedValue = request.kind === 'create' && path.endsWith('/nativeSelectionRef')
      ? nativeSelectionValue(snapshot, path) : undefined;
    const value = field?.value ?? selectedValue ?? valueFor(snapshot, path);
    const required = field?.required === true || typeof selectedValue === 'string' || filingRequired?.has(path) === true;
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
  if (record(targetValue)?.kind === 'none') return null;
  return hasValue(targetValue) ? targetValue : valueFor(snapshot, `/proposal/content/services/${serviceIndex}/sharedFields/${field}`);
}

type ServicePreviewStamp = { inputDigest: string; signature: string };

function serviceInputSignature(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection,
  serviceIndex: number, targetIndex: number): string {
  const serviceRoot = `/proposal/content/services/${serviceIndex}`;
  const targetRoot = `${serviceRoot}/targets/${targetIndex}`;
  const service = snapshot.session.draft.proposal.content.services[serviceIndex];
  const target = service?.targets[targetIndex];
  const createValues = request.fieldPaths.map((path) => [path, valueFor(snapshot, path)]);
  const serviceFields = ['quantity', 'startDate', 'endDate', 'unitPrice', 'frequency', 'pricingControl', 'folio', 'comment']
    .map((field) => [field, serviceFieldValue(snapshot, serviceIndex, targetIndex, field)]);
  return JSON.stringify({ serviceId: service?.id, operation: service?.operation, quantityRequest: valueFor(snapshot, `${serviceRoot}/quantityRequest`),
    sharedFields: valueFor(snapshot, `${serviceRoot}/sharedFields`), itemCandidateRef: valueFor(snapshot, `${serviceRoot}/itemCandidateRef`),
    target: target?.target ?? null, targetFields: serviceFields, createValues });
}

function latestServiceFreshPrepare(snapshot: ReservationPaneSnapshot, requestId: string, allocationId: string, serviceId: string) {
  return [...snapshot.session.draft.observations].reverse().find((item) => item.kind === 'service_preview'
    && item.criteria.workflow === 'services' && item.criteria.kind === 'saved_addon_fresh_prepare'
    && item.criteria.requestId === requestId && item.criteria.allocationId === allocationId
    && item.criteria.serviceId === serviceId) ?? null;
}

function serviceOperationResult(snapshot: ReservationPaneSnapshot, requestId: string, allocationId: string, serviceId: string) {
  return [...snapshot.operationResults].reverse().find((result) => (result.status === 'unknown' || result.status === 'succeeded')
    && result.requestId === requestId
    && result.allocationId === allocationId && result.workflow === 'services'
    && Array.isArray(result.observationRefs) && result.observationRefs.some((ref) => snapshot.session.draft.observations.some((item) =>
      item.ref === ref && item.criteria.workflow === 'services' && item.criteria.serviceId === serviceId
        && item.criteria.requestId === requestId && item.criteria.allocationId === allocationId))) ?? null;
}

function serviceNeedsInputReview(snapshot: ReservationPaneSnapshot, serviceIndex: number, targetIndex: number, path: string): boolean {
  const leaf = path.split('/').at(-1) ?? '';
  if (leaf !== 'folio' && leaf !== 'comment') return true;
  return hasValue(serviceFieldValue(snapshot, serviceIndex, targetIndex, leaf));
}

function serviceInputReviewPaths(snapshot: ReservationPaneSnapshot, serviceIndex: number, targetIndex: number,
  values: unknown): string[] {
  return Array.isArray(values) ? values.filter((path): path is string => typeof path === 'string'
    && serviceNeedsInputReview(snapshot, serviceIndex, targetIndex, path)) : [];
}

function serviceFreshReviewNote(requestId: string, allocationId: string, serviceId: string, prepareRef: string): string {
  return `services_fresh:${requestId}:${allocationId}:${serviceId}:${prepareRef}`;
}

function serviceFreshReviewAccepted(snapshot: ReservationPaneSnapshot, path: string, requestId: string, allocationId: string,
  serviceId: string, prepareRef: string, observedAt: string): boolean {
  const review = snapshot.session.draft.staffReviews[path];
  return review?.status === 'accepted'
    && review.note === serviceFreshReviewNote(requestId, allocationId, serviceId, prepareRef)
    && typeof review.at === 'string'
    && Date.parse(review.at) > Date.parse(observedAt);
}

function isRequestPrepared(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection): boolean {
  const allocations = createSections(snapshot, request).allocations;
  return allocations.length > 0 && allocations.every(({ value }) => {
    const allocationId = String(value.id ?? '');
    return snapshot.preparationViews.some((view) => view.requestId === request.id && view.allocationId === allocationId && view.current);
  });
}

function amendTargets(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection) {
  const body = `${requestPath(request)}/body`;
  const scope = record(effectiveValueFor(snapshot, `${body}/targets`));
  const rows = Array.isArray(scope?.include) ? scope.include : [];
  return { body, scope, rows: rows.map((value, index) => ({ value: record(value) ?? {}, index })) };
}

function latestAmendPreparation(snapshot: ReservationPaneSnapshot, requestId: string, hintId: string) {
  return [...snapshot.session.draft.observations].reverse().find((item) => item.kind === 'rate_availability'
    && item.status === 'complete' && item.criteria.workflow === 'amend' && item.criteria.requestId === requestId
    && item.criteria.hintId === hintId && record(item.result)?.outcome === 'prepared') ?? null;
}

function amendSelection(snapshot: ReservationPaneSnapshot, path: string): string | null {
  const override = snapshot.session.draft.fieldOverrides[path];
  if (override) return override.state === 'set' && typeof override.value === 'string' ? override.value : null;
  const suggested = draftAtPath(snapshot, path);
  return typeof suggested === 'string' ? suggested : null;
}

type CancelFinancialReview = { observationRef: string; approvalDigest: string; reviewFieldPath: string; reviewNote: string };

function cancelFinancialReview(value: unknown): CancelFinancialReview | null {
  const row = record(value);
  return row?.required === true && typeof row.observationRef === 'string' && typeof row.approvalDigest === 'string'
      && typeof row.reviewFieldPath === 'string' && typeof row.reviewNote === 'string'
    ? { observationRef: row.observationRef, approvalDigest: row.approvalDigest,
      reviewFieldPath: row.reviewFieldPath, reviewNote: row.reviewNote } : null;
}

function latestCancelPreview(snapshot: ReservationPaneSnapshot, requestId: string, hintId: string, selectionRef?: string | null) {
  return [...snapshot.session.draft.observations].reverse().find((item) => item.kind === 'stay_candidate'
    && item.status === 'complete' && item.criteria.workflow === 'cancel' && item.criteria.stage === 'prepare'
    && item.criteria.requestId === requestId && item.criteria.hintId === hintId
    && (!selectionRef || item.criteria.selectionRef === selectionRef)) ?? null;
}

function cancelSelectedRef(snapshot: ReservationPaneSnapshot, path: string): string | null {
  const override = snapshot.session.draft.fieldOverrides[path];
  return override?.state === 'set' && typeof override.value === 'string' ? override.value : null;
}

function hasLegacyCreateReceiptIssue(snapshot: ReservationPaneSnapshot): boolean {
  return snapshot.issues.some((issue) => issue.kind === 'legacy_create_receipts');
}

export function ReservationPane({ source, snapshot, loadError, client, onSnapshot, onOpenEvidence, onOpenAttachment }: ReservationPaneProps) {
  const [ui, dispatch] = useReducer(reduceReservationUi, source.selectionEpoch, initialReservationUiState);
  const [amendPreparedRefs, setAmendPreparedRefs] = useState<Record<string, string>>({});
  const [cancelReviewBindings, setCancelReviewBindings] = useState<Record<string, CancelFinancialReview>>({});
  const [servicePreviewStamps, setServicePreviewStamps] = useState<Record<string, ServicePreviewStamp>>({});
  const [filingPreparedStamps, setFilingPreparedStamps] = useState<Record<string, string>>({});
  const sourceRef = useRef(source);
  const snapshotRef = useRef(snapshot);
  const pending = useRef(new Map<string, PendingReservationEdit>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const busyActionRef = useRef(false);
  const sequence = useRef(0);
  const triedPrepare = useRef(new Set<string>());
  const activeRequestRef = useRef<string | null>(null);
  const activeKindRef = useRef<ReservationWorkflowKind>('create');
  sourceRef.current = source;
  snapshotRef.current = snapshot;

  useEffect(() => {
    pending.current.clear();
    triedPrepare.current.clear();
    setAmendPreparedRefs({});
    setCancelReviewBindings({});
    setServicePreviewStamps({});
    setFilingPreparedStamps({});
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
  const activeRequests = snapshot?.requests.filter((request) => request.kind === activeKind) ?? [];

  const applySnapshot = useCallback((next: ReservationPaneSnapshot, bound: ReservationSourceContext) => {
    if (sourceRef.current.selectionEpoch !== bound.selectionEpoch || sourceRef.current.messageId !== bound.messageId
      || next.sourceMessageId !== bound.messageId) return;
    snapshotRef.current = next;
    onSnapshot(next);
  }, [onSnapshot]);

  const enqueue = useCallback((label: string, bound: ReservationSourceContext, action: () => Promise<void>) => {
    const run = queue.current.then(async () => {
      if (sourceRef.current.selectionEpoch !== bound.selectionEpoch || sourceRef.current.messageId !== bound.messageId) return;
      busyActionRef.current = true;
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
      } finally {
        busyActionRef.current = false;
      }
    });
    queue.current = run.then(() => undefined, () => undefined);
    return run;
  }, [applySnapshot]);

  const stage = useCallback((path: string, value: unknown, state: PendingReservationEdit['state'] = 'set') => {
    if (busyActionRef.current) return;
    const current = snapshotRef.current;
    const amend = current?.requests.find((request) => request.kind === 'amend'
      && path.startsWith(`${requestPath(request)}/body/`));
    if (amend) setAmendPreparedRefs((previous) => {
      const next = { ...previous };
      for (const key of Object.keys(next)) if (key.startsWith(`${amend.id}:`)) delete next[key];
      return next;
    });
    const cancel = current?.requests.find((request) => request.kind === 'cancel'
      && path.startsWith(`${requestPath(request)}/body/`));
    if (cancel && !path.includes('/previewObservationRefs/')) setCancelReviewBindings((previous) => {
      const next = { ...previous };
      for (const key of Object.keys(next)) if (key.startsWith(`${cancel.id}:`)) delete next[key];
      return next;
    });
    const create = current?.requests.find((request) => request.kind === 'create'
      && path.startsWith(`${requestPath(request)}/body/`));
    if (create) setServicePreviewStamps({});
    const serviceId = current ? serviceIdForField(current, path) : null;
    if (serviceId) setServicePreviewStamps((previous) => Object.fromEntries(Object.entries(previous)
      .filter(([key]) => !key.endsWith(`:${serviceId}`))));
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

  const editOnBlur = useCallback((path: string) => { if (!busyActionRef.current) void saveEdits([path]); }, [saveEdits]);
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
      const filingSelection = current.requests.some((request) => request.kind === 'filing'
        && filingReviewPaths(current, request).includes(path));
      const quote = current.session.draft.proposal.content.requests.find((request) => request.kind === 'quote'
        && `/proposal/content/requests/${encodeURIComponent(request.id)}/body` === path);
      const quoteReview = quote ? quoteReviewInfo(current, quote.id) : null;
      const explicitAmendReview = isAmendClearOrEmptyReviewPath(current, path);
      const required = field?.required === true || typeof suggestedSelection === 'string' || Boolean(quoteReview?.items.length)
        || explicitAmendReview || filingSelection;
      const review = current.session.draft.staffReviews[path];
      if (!required || (quoteReview?.items.length ? quoteReview.accepted : (field?.review ?? review?.status) === 'accepted')) return;
      if (!explicitAmendReview && !hasValue(field?.value ?? suggestedSelection ?? valueFor(current, path))) {
        throw new Error('Enter or resolve this value before marking it reviewed.');
      }
      const next = await client.review({ source: bound, snapshot: current, fieldPath: path, decision: 'accepted' });
      applySnapshot(next, bound);
    });
  }, [applySnapshot, client, enqueue, flushEdits]);

  const chooseRequest = useCallback((request: ReservationRequestProjection) => {
    if (busyActionRef.current) return;
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
    if (hasLegacyCreateReceiptIssue(current)) return;
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
    if (hasLegacyCreateReceiptIssue(snapshot)) return;
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
    const selectedRequestId = activeRequestRef.current;
    if (!selectedRequestId) return;
    void enqueue('Creating reservations in Infor', bound, async () => {
      beginMutation();
      try {
        if (pending.current.size) await flushEdits(bound);
        let current = snapshotRef.current;
        const request = current?.requests.find((item) => item.id === selectedRequestId);
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
      } finally {
        endMutation();
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

  const lookupFiling = useCallback((requestId: string) => {
    const bound = sourceRef.current;
    void enqueue('Finding exact saved stay and verifying its source PDF', bound, async () => {
      let current = snapshotRef.current;
      if (!current) throw new Error('The source-bound reservation draft is still loading.');
      if (pending.current.size) {
        await flushEdits(bound);
        current = snapshotRef.current;
      }
      const request = current?.requests.find((item) => item.id === requestId && item.kind === 'filing');
      if (!current || !request?.supported) throw new Error('This Filing request is not connected to the selected source.');
      if (!isFilingReadyForLookup(current, request)) {
        throw new Error('Choose one PDF, enter the exact existing confirmation, and select its document kind before Lookup.');
      }
      const next = await client.lookup({ source: bound, snapshot: current, requestId });
      applySnapshot(next, bound);
      if (next.serviceNotice) throw new Error(next.serviceNotice);
    });
  }, [applySnapshot, client, enqueue, flushEdits]);

  const configureFiling = useCallback((requestId: string, selection: { attachmentId: string; confirmation: string;
    kind: 'voucher' | 'payment_proof' }): Promise<boolean> => {
    const bound = sourceRef.current;
    let configured = false;
    const run = enqueue('Saving selected PDF and exact confirmation', bound, async () => {
      if (pending.current.size) await flushEdits(bound);
      const current = snapshotRef.current;
      const request = current?.requests.find((item) => item.id === requestId && item.kind === 'filing');
      const attachment = bound.attachments.find((item) => item.sourceRef === selection.attachmentId);
      const isPdf = Boolean(attachment && (attachment.mimeType?.toLowerCase() === 'application/pdf'
        || /\.pdf$/iu.test(attachment.name)) && attachment.uploadability !== 'unsupported');
      if (!current || !request?.supported) throw new Error('This Filing request is not connected to the selected source.');
      if (!isPdf) throw new Error('Choose an eligible PDF attachment from this selected email.');
      const confirmation = selection.confirmation.trim();
      if (!/^\d+-\d+$/u.test(confirmation)) throw new Error('Enter the exact existing Infor confirmation in digits-digits format.');
      const next = await client.configureFiling({ source: bound, snapshot: current, requestId: request.id,
        attachmentId: selection.attachmentId, confirmation, kind: selection.kind });
      setFilingPreparedStamps((previous) => { const copy = { ...previous }; delete copy[request.id]; return copy; });
      applySnapshot(next, bound);
      configured = true;
    });
    return run.then(() => configured);
  }, [applySnapshot, client, enqueue, flushEdits]);

  const prepareFiling = useCallback((requestId: string) => {
    const bound = sourceRef.current;
    void enqueue('Preparing exact PDF and saved stay in Infor · no save', bound, async () => {
      if (pending.current.size) await flushEdits(bound);
      const current = snapshotRef.current;
      const request = current?.requests.find((item) => item.id === requestId && item.kind === 'filing');
      if (!current || !request?.supported) throw new Error('This Filing request is not connected to the selected source.');
      if (!isFilingReadyForPrepare(current, request)) throw new Error('Run Lookup and select one exact source-bound PDF and saved stay before Prepare.');
      if (hasUnreviewedRequiredFields(current, request)) throw new Error('Confirm the source PDF, document facts, and selected stay before Prepare.');
      const next = await client.prepare({ source: bound, snapshot: current, requestId });
      applySnapshot(next, bound);
      if (next.serviceNotice) throw new Error(next.serviceNotice);
      if (!hasCurrentFilingPreparation(next, request)) throw new Error('Infor did not record a current Filing preparation. Nothing was uploaded.');
      setFilingPreparedStamps((prior) => ({ ...prior, [request.id]: filingPreparationStamp(next, bound) }));
    });
  }, [applySnapshot, client, enqueue, flushEdits]);

  const fileFiling = useCallback((requestId: string) => {
    const bound = sourceRef.current;
    void enqueue('Filing verified PDF to Infor', bound, async () => {
      beginMutation();
      try {
        if (pending.current.size) await flushEdits(bound);
        const current = snapshotRef.current;
        const request = current?.requests.find((item) => item.id === requestId && item.kind === 'filing');
        if (!current || !request?.supported) throw new Error('This Filing request is not connected to the selected source.');
        const previous = current.operationResults.find((result) => result.workflow === 'filing' && result.requestId === request.id
          && (result.status === 'unknown' || result.status === 'succeeded'));
        if (previous?.status === 'unknown') throw new Error('Filing outcome is uncertain. Reconcile the saved operation before retrying.');
        if (previous?.status === 'succeeded') throw new Error('This Filing request already has a confirmed Infor receipt; no duplicate upload was started.');
        if (filingPreparedStamps[request.id] !== filingPreparationStamp(current, bound)
            || !isFilingReadyForPrepare(current, request) || hasUnreviewedRequiredFields(current, request)
            || !hasCurrentFilingPreparation(current, request)) {
          throw new Error('Filing preparation is stale. Review the source and selected stay, then Prepare again before File.');
        }
        const idempotencyKey = crypto.randomUUID();
        const next = await client.execute({ source: bound, snapshot: current, requestId: request.id, idempotencyKey });
        applySnapshot(next, bound);
        const outcome = next.operationResults.find((result) => result.id === idempotencyKey)
          ?? [...next.operationResults].reverse().find((result) => result.workflow === 'filing' && result.requestId === request.id);
        if (!outcome || outcome.status !== 'succeeded') {
          throw new Error(next.serviceNotice ?? (outcome?.status === 'unknown'
            ? 'The PDF may have reached Infor. Reconcile its saved operation before retrying.'
            : 'Infor did not confirm a saved PDF listing/readback. Check the Filing receipt before retrying.'));
        }
      } finally {
        endMutation();
      }
    });
  }, [applySnapshot, client, enqueue, filingPreparedStamps, flushEdits]);

  const reconcile = useCallback((operationId: string) => {
    const bound = sourceRef.current;
    void enqueue('Reconciling the Infor save outcome', bound, async () => {
      const current = snapshotRef.current;
      if (!current) return;
      const operation = current.operationResults.find((result) => result.id === operationId);
      const next = operation?.workflow === 'services'
        ? await client.reconcileServices({ source: bound, snapshot: current, operationId })
        : await client.reconcile({ source: bound, snapshot: current, operationId });
      applySnapshot(next, bound);
    });
  }, [applySnapshot, client, enqueue]);

  const acceptReview = useCallback((fieldPath: string, note?: string) => {
    const bound = sourceRef.current;
    void enqueue('Recording staff review', bound, async () => {
      if (pending.current.has(fieldPath)) await flushEdits(bound, [fieldPath]);
      const current = snapshotRef.current;
      if (!current) throw new Error('The source-bound reservation draft is still loading.');
      const next = await client.review({ source: bound, snapshot: current, fieldPath, decision: 'accepted', ...(note ? { note } : {}) });
      applySnapshot(next, bound);
    });
  }, [applySnapshot, client, enqueue, flushEdits]);

  const runAmendAction = useCallback((mode: 'lookup' | 'prepare' | 'execute', requestId: string, hintId?: string) => {
    const bound = sourceRef.current;
    const targetKey = hintId ? `${requestId}:${hintId}` : null;
    const label = mode === 'lookup' ? 'Finding exact saved stays in Infor'
      : mode === 'prepare' ? 'Preparing unsaved amendment and price in Infor' : 'Saving amendment in Infor';
    void enqueue(label, bound, async () => {
      beginMutation();
      try {
        if (pending.current.size) await flushEdits(bound);
        const current = snapshotRef.current;
        const request = current?.requests.find((item) => item.id === requestId && item.kind === 'amend');
        if (!current || !request) throw new Error('The source-bound Amend request is no longer available.');
        if (mode === 'lookup') {
          const next = await client.lookup({ source: bound, snapshot: current, requestId });
          applySnapshot(next, bound);
          return;
        }
        if (!hintId) throw new Error('Choose one exact saved stay target first.');
        if (mode === 'prepare') {
          const next = await client.prepare({ source: bound, snapshot: current, requestId, allocationId: hintId });
          applySnapshot(next, bound);
          const prepared = latestAmendPreparation(next, requestId, hintId);
          if (next.workflowReply?.status === 'prepared' && prepared) {
            setAmendPreparedRefs((previous) => ({ ...previous, [targetKey!]: prepared.ref }));
          } else {
            setAmendPreparedRefs((previous) => { const copy = { ...previous }; delete copy[targetKey!]; return copy; });
          }
          return;
        }
        const prepared = latestAmendPreparation(current, requestId, hintId);
        if (!prepared || amendPreparedRefs[targetKey!] !== prepared.ref) {
          throw new Error('Prepare this exact amendment again after the last edit before Go.');
        }
        const prior = current.operationResults.find((result) => result.requestId === requestId
          && result.allocationId === hintId && result.workflow === 'amend'
          && (result.status === 'succeeded' || result.status === 'unknown'));
        if (prior?.status === 'unknown') throw new Error('This amendment has an uncertain save. Reconcile it before retrying.');
        if (prior?.status === 'succeeded') throw new Error('This saved stay is already amended; later edits do not change the Infor reservation.');
        const next = await client.execute({ source: bound, snapshot: current, requestId, allocationId: hintId,
          idempotencyKey: crypto.randomUUID() });
        applySnapshot(next, bound);
        setAmendPreparedRefs((previous) => { const copy = { ...previous }; delete copy[targetKey!]; return copy; });
      } finally {
        endMutation();
      }
    });
  }, [amendPreparedRefs, applySnapshot, client, enqueue, flushEdits]);

  const runCancelAction = useCallback((mode: 'lookup' | 'prepare' | 'execute', requestId: string, hintId?: string) => {
    const bound = sourceRef.current;
    const targetKey = hintId ? `${requestId}:${hintId}` : null;
    const label = mode === 'lookup' ? 'Finding exact cancellation target in Infor'
      : mode === 'prepare' ? 'Refreshing native cancellation policy and fee preview' : 'Cancelling the exact saved stay in Infor';
    void enqueue(label, bound, async () => {
      beginMutation();
      try {
        if (pending.current.size) await flushEdits(bound);
        const current = snapshotRef.current;
        const request = current?.requests.find((item) => item.id === requestId && item.kind === 'cancel');
        if (!current || !request) throw new Error('The source-bound Cancel request is no longer available.');
        if (mode === 'lookup') {
          applySnapshot(await client.lookup({ source: bound, snapshot: current, requestId }), bound);
          return;
        }
        if (!hintId) throw new Error('Cancel requires one exact saved-stay target.');
        if (mode === 'prepare') {
          const next = await client.prepare({ source: bound, snapshot: current, requestId, allocationId: hintId });
          applySnapshot(next, bound);
          const binding = cancelFinancialReview(next.workflowReply?.financialReview);
          if ((next.workflowReply?.status === 'prepared' || next.workflowReply?.status === 'needs_review') && binding) {
            setCancelReviewBindings((previous) => ({ ...previous, [targetKey!]: binding }));
          } else {
            setCancelReviewBindings((previous) => { const copy = { ...previous }; delete copy[targetKey!]; return copy; });
          }
          return;
        }
        const prior = current.operationResults.find((result) => result.requestId === requestId
          && result.allocationId === hintId && result.workflow === 'cancel'
          && (result.status === 'succeeded' || result.status === 'unknown'));
        if (prior?.status === 'unknown') throw new Error('Cancel outcome is uncertain. Reconcile the operation before any retry.');
        if (prior?.status === 'succeeded') throw new Error('This stay already has a verified cancellation receipt.');
        const binding = cancelReviewBindings[targetKey!];
        if (!binding) throw new Error('Refresh the native preview and explicitly review its financial facts before Go.');
        const review = current.session.draft.staffReviews[binding.reviewFieldPath];
        if (review?.status !== 'accepted' || review.note !== binding.reviewNote) {
          throw new Error('The exact native cancellation preview has not been accepted.');
        }
        const next = await client.execute({ source: bound, snapshot: current, requestId, allocationId: hintId,
          idempotencyKey: crypto.randomUUID() });
        applySnapshot(next, bound);
        const changedBinding = cancelFinancialReview(next.workflowReply?.financialReview);
        if (next.workflowReply?.status === 'needs_review' && changedBinding) {
          setCancelReviewBindings((previous) => ({ ...previous, [targetKey!]: changedBinding }));
        } else if (next.workflowReply?.status === 'succeeded') {
          setCancelReviewBindings((previous) => { const copy = { ...previous }; delete copy[targetKey!]; return copy; });
        } else if (next.workflowReply?.status !== 'needs_reconcile') {
          setCancelReviewBindings((previous) => { const copy = { ...previous }; delete copy[targetKey!]; return copy; });
        }
      } finally {
        endMutation();
      }
    });
  }, [applySnapshot, cancelReviewBindings, client, enqueue, flushEdits]);

  const acceptCancelPreview = useCallback((requestId: string, hintId: string) => {
    const bound = sourceRef.current;
    const targetKey = `${requestId}:${hintId}`;
    void enqueue('Recording review of this exact cancellation preview', bound, async () => {
      beginMutation();
      try {
        const current = snapshotRef.current;
        const request = current?.requests.find((item) => item.id === requestId && item.kind === 'cancel');
        const binding = cancelReviewBindings[targetKey];
        if (!current || !request || !binding) throw new Error('The source-bound native cancellation preview is unavailable.');
        const prefix = `${requestPath(request)}/body/previewObservationRefs/`;
        const index = binding.reviewFieldPath.startsWith(prefix) ? binding.reviewFieldPath.slice(prefix.length) : '';
        if (!/^(?:0|[1-9]\d*)$/.test(index)) throw new Error('The server returned an invalid cancellation review path.');
        const item = current.session.draft.observations.find((observation) => observation.ref === binding.observationRef
          && observation.kind === 'stay_candidate' && observation.status === 'complete'
          && observation.criteria.workflow === 'cancel' && observation.criteria.stage === 'prepare'
          && observation.criteria.requestId === requestId && observation.criteria.hintId === hintId);
        if (!item || record(item.result)?.ready !== true || record(item.result)?.approvalDigest !== binding.approvalDigest) {
          throw new Error('This preview is no longer the current prepared cancellation; Prepare again.');
        }
        let latest = current;
        const boundRef = valueFor(latest, binding.reviewFieldPath);
        if (boundRef !== binding.observationRef) {
          latest = await client.edit({ source: bound, snapshot: latest, requestId,
            fieldPath: binding.reviewFieldPath, state: 'set', value: binding.observationRef });
          applySnapshot(latest, bound);
        }
        const next = await client.review({ source: bound, snapshot: latest, fieldPath: binding.reviewFieldPath,
          decision: 'accepted', note: binding.reviewNote });
        applySnapshot(next, bound);
      } finally {
        endMutation();
      }
    });
  }, [applySnapshot, cancelReviewBindings, client, enqueue]);

  const runServiceAction = useCallback((mode: 'lookup' | 'preview', requestId: string, allocationId: string, serviceId: string) => {
    const bound = sourceRef.current;
    void enqueue(mode === 'lookup' ? 'Loading native Add-On catalogue' : 'Previewing unsaved Add-On on this room', bound, async () => {
      beginMutation();
      try {
        if (pending.current.size) await flushEdits(bound);
        const current = snapshotRef.current;
        const request = current?.requests.find((item) => item.id === requestId && item.kind === 'create');
        if (!current || !request) throw new Error('The owning Create request is no longer available.');
        if (!isInputReady(current, request)) {
          throw new Error('Complete every Create room and select each exact existing guest profile before native Add-On lookup or preview.');
        }
        const linked = serviceRowsForAllocation(current, request, allocationId).find((row) => row.service.id === serviceId);
        if (!linked) throw new Error('This Add-On is not linked to the selected Create room.');
        const command = { source: bound, snapshot: current, requestId, allocationId, serviceId };
        const next = mode === 'lookup' ? await client.lookupServices(command) : await client.previewServices(command);
        applySnapshot(next, bound);
        if (mode === 'preview') {
          const preview = [...next.session.draft.observations].reverse().find((item) => item.kind === 'service_preview'
            && item.criteria.workflow === 'services' && item.criteria.kind === 'unsaved_addon_preview'
            && item.criteria.requestId === requestId && item.criteria.allocationId === allocationId
            && item.criteria.serviceId === serviceId && item.status === 'complete');
          const key = `${requestId}:${allocationId}:${serviceId}`;
          if (typeof preview?.criteria.inputDigest === 'string') {
            setServicePreviewStamps((previous) => ({ ...previous, [key]: { inputDigest: preview.criteria.inputDigest as string,
              signature: serviceInputSignature(current, request, linked.serviceIndex, linked.targetIndex) } }));
          } else {
            setServicePreviewStamps((previous) => { const copy = { ...previous }; delete copy[key]; return copy; });
          }
        }
      } finally {
        endMutation();
      }
    });
  }, [applySnapshot, client, enqueue, flushEdits]);

  const runServiceExecute = useCallback((requestId: string, allocationId: string, serviceId: string) => {
    const bound = sourceRef.current;
    void enqueue('Verifying and saving this Add-On on the confirmed HMS stay', bound, async () => {
      beginMutation();
      try {
        if (pending.current.size) await flushEdits(bound);
        const current = snapshotRef.current;
        const request = current?.requests.find((item) => item.id === requestId && item.kind === 'create');
        if (!current || !request) throw new Error('The owning Create request is no longer available.');
        if (!isInputReady(current, request)) throw new Error('The source-bound Create inputs are incomplete; do not attach an Add-On to an unresolved stay.');
        if (!current.operationResults.some((result) => result.requestId === requestId && result.allocationId === allocationId
          && result.workflow === 'create' && result.status === 'succeeded')) {
          throw new Error('Save the Create room and verify its Infor confirmation before saving this Add-On.');
        }
        const prior = serviceOperationResult(current, requestId, allocationId, serviceId);
        if (prior?.status === 'unknown') throw new Error('This Add-On Save outcome is uncertain. Reconcile it before retrying.');
        if (prior?.status === 'succeeded') throw new Error('This Add-On already has a verified HMS receipt.');
        const linked = serviceRowsForAllocation(current, request, allocationId).find((row) => row.service.id === serviceId);
        if (!linked) throw new Error('This Add-On is not linked to the selected Create room.');
        const previewStamp = servicePreviewStamps[`${requestId}:${allocationId}:${serviceId}`];
        const preview = [...current.session.draft.observations].reverse().find((item) => item.kind === 'service_preview'
          && item.status === 'complete' && item.criteria.workflow === 'services' && item.criteria.kind === 'unsaved_addon_preview'
          && item.criteria.requestId === requestId && item.criteria.allocationId === allocationId
          && item.criteria.serviceId === serviceId && item.criteria.inputDigest === previewStamp?.inputDigest);
        if (!previewStamp || serviceInputSignature(current, request, linked.serviceIndex, linked.targetIndex) !== previewStamp.signature) {
          throw new Error('Re-run the complete unsaved Add-On preview after the last service/Create edit.');
        }
        if (!preview) throw new Error('Re-run the complete unsaved Add-On preview after the last service/Create edit.');
        const unsavedReviewPaths = serviceInputReviewPaths(current, linked.serviceIndex, linked.targetIndex,
          record(preview.result)?.hostValuesRequireReview);
        if (unsavedReviewPaths.some((path) => current.session.draft.staffReviews[path]?.status !== 'accepted')) {
          throw new Error('Review the service input fields against the unsaved native preview before Go.');
        }
        const fresh = latestServiceFreshPrepare(current, requestId, allocationId, serviceId);
        const freshResult = record(fresh?.result);
        const freshRef = fresh && fresh.criteria.unsavedPreviewRef === preview.ref
          && fresh.criteria.inputDigest === preview.criteria.inputDigest && fresh.status === 'complete'
          && freshResult?.matchesApprovedNative === false ? fresh.ref : undefined;
        if (freshRef && fresh) {
          const paths = Array.isArray(fresh.criteria.reviewPaths) ? fresh.criteria.reviewPaths.filter((path): path is string => typeof path === 'string') : [];
          if (!paths.length || !paths.every((path) => serviceFreshReviewAccepted(current, path, requestId, allocationId,
            serviceId, fresh.ref, fresh.observedAt))) {
            throw new Error('Review every field and native amount in the latest saved-stay prepare before Go.');
          }
        }
        const next = await client.executeServices({ source: bound, snapshot: current, requestId, allocationId, serviceId,
          idempotencyKey: crypto.randomUUID(), ...(freshRef ? { reviewedPrepareRef: freshRef } : {}) });
        applySnapshot(next, bound);
      } finally {
        endMutation();
      }
    });
  }, [applySnapshot, client, enqueue, flushEdits, servicePreviewStamps]);

  const undoRedo = useCallback((direction: 'undo' | 'redo') => {
    const bound = sourceRef.current;
    void enqueue(direction === 'undo' ? 'Undoing last edit' : 'Redoing edit', bound, async () => {
      if (pending.current.size) await flushEdits(bound);
      const current = snapshotRef.current;
      if (!current) return;
      const next = direction === 'undo' ? await client.undo({ source: bound, snapshot: current })
        : await client.redo({ source: bound, snapshot: current });
      applySnapshot(next, bound);
      setServicePreviewStamps({});
    });
  }, [applySnapshot, client, enqueue, flushEdits]);

  const reviewRequired = Boolean(snapshot && activeRequest && hasUnreviewedRequiredFields(snapshot, activeRequest));
  const hasUncertain = snapshot?.operationResults.some((result) => result.requestId === activeRequest?.id && result.status === 'unknown') ?? false;
  const canGo = Boolean(snapshot && activeRequest?.kind === 'create' && activeRequest.supported
    && isInputReady(snapshot, activeRequest) && isRequestPrepared(snapshot, activeRequest) && !reviewRequired && !ui.pendingEdits.length
    && !ui.busyAction && !hasUncertain);
  const displayedResult = snapshot?.operationResults.filter((result) => result.requestId === activeRequest?.id
    && (result.workflow === activeRequest?.kind || activeRequest?.kind === 'create' && result.workflow === 'services')) ?? [];
  const canGenerateQuote = Boolean(snapshot && activeRequest?.kind === 'quote' && activeRequest.supported
    && isQuotePrepared(snapshot, activeRequest) && !hasUnreviewedRequiredFields(snapshot, activeRequest)
    && (!quoteReviewInfo(snapshot, activeRequest.id).items.length || quoteReviewInfo(snapshot, activeRequest.id).accepted)
    && !ui.pendingEdits.length && !ui.busyAction && !hasUncertain);
  const filingPreparedStamp = snapshot && activeRequest?.kind === 'filing'
    ? filingPreparationStamp(snapshot, source) : null;
  const filingCompleted = Boolean(snapshot && activeRequest?.kind === 'filing'
    && snapshot.operationResults.some((result) => result.workflow === 'filing' && result.requestId === activeRequest.id && result.status === 'succeeded'));
  const filingBlockedByUncertainty = Boolean(snapshot && activeRequest?.kind === 'filing'
    && snapshot.operationResults.some((result) => result.workflow === 'filing' && result.requestId === activeRequest.id && result.status === 'unknown'));
  const canPrepareFiling = Boolean(snapshot && activeRequest?.kind === 'filing' && activeRequest.supported
    && isFilingReadyForPrepare(snapshot, activeRequest) && !hasUnreviewedRequiredFields(snapshot, activeRequest)
    && !ui.pendingEdits.length && !ui.busyAction && !filingCompleted && !filingBlockedByUncertainty);
  const canFileFiling = Boolean(snapshot && activeRequest?.kind === 'filing' && activeRequest.supported
    && filingPreparedStamp && filingPreparedStamps[activeRequest.id] === filingPreparedStamp
    && isFilingReadyForPrepare(snapshot, activeRequest) && hasCurrentFilingPreparation(snapshot, activeRequest)
    && !hasUnreviewedRequiredFields(snapshot, activeRequest) && !ui.pendingEdits.length && !ui.busyAction
    && !filingCompleted && !filingBlockedByUncertainty);

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
              aria-pressed={activeKind === kind} disabled={Boolean(ui.busyAction) || busyActionRef.current} onClick={() => {
                const match = matches.find((request) => request.id === activeRequest?.id) ?? matches[0];
                if (match) chooseRequest(match);
                else if (!busyActionRef.current) { activeRequestRef.current = null; activeKindRef.current = kind; dispatch({ type: 'action-error', message: null }); }
              }}>{KIND_LABEL[kind]}{matches.length > 1 && <small>{matches.length}</small>}</button>;
          })}
        </nav>
        <main className={styles.main}>
          {snapshot.issues.filter((issue) => issue.kind === 'legacy_create_receipts' || !activeRequest || !issue.path || issue.path.startsWith(`${requestPath(activeRequest)}/`)).map((issue, index) =>
            <div className={styles.issueLine} key={`${issue.kind}-${index}`}><b>{humanize(issue.kind)}</b><span>{issue.explanation}</span></div>)}
          {activeRequest ? <>
            <div className={styles.titleRow}><div><small className={styles.eyebrow}>{KIND_LABEL[activeRequest.kind]}</small><h1>{activeRequest.text || `${KIND_LABEL[activeRequest.kind]} reservation work`}</h1></div>
              <span className={activeRequest.supported ? styles.connected : styles.notConnected}>{activeRequest.supported ? 'Connected' : 'Review only'}</span></div>
            {activeRequests.length > 1 && <section className={styles.card}>
              <label htmlFor="reservation-request-picker">Choose a {KIND_LABEL[activeKind].toLowerCase()} request</label>
              <select id="reservation-request-picker" className={styles.select} value={activeRequest.id} disabled={Boolean(ui.busyAction) || busyActionRef.current} onChange={(event) => {
                const selected = activeRequests.find((request) => request.id === event.target.value);
                if (selected) chooseRequest(selected);
              }}>
                {activeRequests.map((request, index) => <option key={request.id} value={request.id}>
                  {`Request ${index + 1} · ${request.text || 'Details unavailable'}`}
                </option>)}
              </select>
            </section>}
            {activeRequest.kind === 'create' && displayedResult.some((result) => result.status === 'succeeded') && <div className={styles.notice}>At least one room already has an HMS confirmation. Later edits and undo affect the draft only; they do not change a saved reservation.</div>}
            {activeRequest.kind === 'create'
                ? <fieldset disabled={Boolean(ui.busyAction) || busyActionRef.current} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
                  <CreateEditor snapshot={snapshot} request={activeRequest} onStage={stage} onBlur={editOnBlur} onDone={markDone} editValue={editValue} hasPendingEdit={hasPendingEdit}
                  onAcceptReview={acceptReview}
                  busy={Boolean(ui.busyAction) || ui.pendingEdits.length > 0}
                  prepareBlockedReason={hasLegacyCreateReceiptIssue(snapshot) ? 'A legacy Create save cannot be matched safely to this v2 room. Refreshing native price is disabled to avoid creating an unrelated or duplicate reservation.' : undefined}
                  onLookupServices={(allocationId, serviceId) => runServiceAction('lookup', activeRequest.id, allocationId, serviceId)}
                  onPreviewServices={(allocationId, serviceId) => runServiceAction('preview', activeRequest.id, allocationId, serviceId)}
                  onExecuteServices={(allocationId, serviceId) => runServiceExecute(activeRequest.id, allocationId, serviceId)}
                  servicePreviewStamps={servicePreviewStamps}
                  onOpenEvidence={onOpenEvidence} onPrepare={() => { void enqueue('Checking Infor now', sourceRef.current, () => prepareAll(false)); }}
                  onLookup={refreshNative} />
                </fieldset>
              : activeRequest.kind === 'amend'
                ? <fieldset disabled={Boolean(ui.busyAction) || busyActionRef.current} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
                  <AmendEditor snapshot={snapshot} request={activeRequest} onStage={stage} onBlur={editOnBlur}
                    onDone={acceptReview} editValue={editValue} onOpenEvidence={onOpenEvidence}
                    preparedRefs={amendPreparedRefs} busy={Boolean(ui.busyAction) || ui.pendingEdits.length > 0}
                    onLookup={() => runAmendAction('lookup', activeRequest.id)}
                    onPrepare={(hintId) => runAmendAction('prepare', activeRequest.id, hintId)}
                    onExecute={(hintId) => runAmendAction('execute', activeRequest.id, hintId)} />
                </fieldset>
              : activeRequest.kind === 'cancel'
                ? <fieldset disabled={Boolean(ui.busyAction) || busyActionRef.current} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
                  <CancelEditor snapshot={snapshot} request={activeRequest} onStage={stage} onBlur={editOnBlur}
                    editValue={editValue} busy={Boolean(ui.busyAction) || ui.pendingEdits.length > 0}
                    reviewBindings={cancelReviewBindings}
                    onLookup={() => runCancelAction('lookup', activeRequest.id)}
                    onPrepare={(hintId) => runCancelAction('prepare', activeRequest.id, hintId)}
                    onAcceptPreview={(hintId) => acceptCancelPreview(activeRequest.id, hintId)}
                    onExecute={(hintId) => runCancelAction('execute', activeRequest.id, hintId)} />
                </fieldset>
              : activeRequest.kind === 'filing'
                ? <FilingEditor key={`${source.selectionEpoch}:${activeRequest.id}`} snapshot={snapshot} request={activeRequest} source={source} onOpenAttachment={onOpenAttachment}
                    onStage={stage} onBlur={editOnBlur} onDone={markDone} editValue={editValue} onOpenEvidence={onOpenEvidence}
                    busy={Boolean(ui.busyAction) || Boolean(ui.pendingEdits.length)} canPrepare={canPrepareFiling} canFile={canFileFiling}
                    onConfigure={(selection) => configureFiling(activeRequest.id, selection)}
                    onLookup={() => lookupFiling(activeRequest.id)} onPrepare={() => prepareFiling(activeRequest.id)} onFile={() => fileFiling(activeRequest.id)} />
                : activeRequest.kind === 'quote'
                  ? <QuoteEditor snapshot={snapshot} request={activeRequest} onStage={stage} onBlur={editOnBlur} onDone={markDone} editValue={editValue}
                    onOpenEvidence={onOpenEvidence} busy={Boolean(ui.busyAction) || Boolean(ui.pendingEdits.length)}
                    onLookup={refreshNative} onPrepare={() => prepareQuote(activeRequest.id)} />
                  : <RequestReview snapshot={snapshot} request={activeRequest} />}
            {displayedResult.map((result, index) => <OperationResult key={String(result.id ?? index)} result={result}
              onReconcile={reconcile} busy={Boolean(ui.busyAction)} />)}
            {activeRequest.kind !== 'create' && activeRequest.kind !== 'quote' && activeRequest.kind !== 'amend' && activeRequest.kind !== 'cancel' && activeRequest.kind !== 'filing' && <div className={styles.notice}>This v2 request is visible from saved source facts. Its native operation is not connected in the current UI route, so no Go action is offered.</div>}
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
              ? 'Current native quote price and availability are prepared; outputs remain unsent.'
              : activeRequest?.kind === 'amend' ? 'Each saved stay needs an exact native match and current unsaved Prepare before Go.'
                : activeRequest?.kind === 'cancel' ? 'Cancel requires an exact native target and reviewed policy and fees.'
                  : activeRequest?.kind === 'filing' && filingCompleted ? 'Infor confirmed this PDF filing. Review the source-bound receipt below.'
                    : activeRequest?.kind === 'filing' && filingPreparedStamp && filingPreparedStamps[activeRequest.id] === filingPreparedStamp
                      ? 'Current PDF and existing stay are prepared; no save has been performed.' : snapshot.preparation.message)}
          </div>
          {ui.pendingEdits.length > 0 && <button type="button" className={styles.secondaryButton} disabled={Boolean(ui.busyAction)} onClick={() => { void saveEdits(); }}>Save {ui.pendingEdits.length} edit{ui.pendingEdits.length === 1 ? '' : 's'}</button>}
          {activeKind === 'create' && activeRequest && <button type="button" className={styles.goButton} disabled={!canGo || busyActionRef.current} onClick={runGo}>Create · {createSections(snapshot, activeRequest).allocations.length} room reservations</button>}
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
  onDone?: (path: string, note?: string) => void;
  onAcceptReview?: (path: string, note?: string) => void;
  editValue: (path: string) => unknown;
  hasPendingEdit?: (path: string) => boolean;
  onOpenEvidence?: (ref: string) => void;
};

function CreateEditor(props: EditorProps & { busy: boolean; prepareBlockedReason?: string; onPrepare: () => void; onLookup: () => void;
  onLookupServices: (allocationId: string, serviceId: string) => void;
  onPreviewServices: (allocationId: string, serviceId: string) => void;
  onExecuteServices: (allocationId: string, serviceId: string) => void; servicePreviewStamps: Record<string, ServicePreviewStamp> }) {
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
        help="Required by Infor before Save. Enter the native code, for example EMA for E-Mail; confirm the source for this booking." />
      <TextField {...props} path={`${body}/shared/billingReference`} label="Billing reference" />
      <TextField {...props} path={`${body}/shared/reservationNote`} label="Shared reservation note" multiline />
    </div>

    <div className={styles.sectionHeader}><div><h2>Dates and room allocation</h2><p>Each room retains its own guest and occupancy. Empty child ages remain unknown—not zero.</p></div></div>
    <div className={styles.twoCol}><button type="button" className={styles.secondaryButton} onClick={props.onLookup}>Refresh native guest and party matches</button>
      <button type="button" className={styles.secondaryButton} disabled={props.busy || Boolean(props.prepareBlockedReason)} onClick={props.onPrepare}>Refresh current Infor price</button></div>
    {props.prepareBlockedReason && <div className={styles.alert}>{props.prepareBlockedReason}</div>}
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
        <button type="button" className={styles.secondaryButton} disabled={props.busy || sections.allocations.length >= 8 || typeof section.id !== 'string'} onClick={() => {
          if (sections.allocations.length >= 8) return;
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
            previewStamp={props.servicePreviewStamps[`${request.id}:${String(allocation.id ?? '')}:${service.id}`]}
            onLookup={() => props.onLookupServices(String(allocation.id ?? ''), service.id)}
            onPreview={() => props.onPreviewServices(String(allocation.id ?? ''), service.id)}
            onExecute={() => props.onExecuteServices(String(allocation.id ?? ''), service.id)} />)}
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
      ? <div className={styles.notice}>A Create confirmation does not save Add-Ons. Each service needs its own verified target receipt and fresh readback.</div> : null}
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
  previewStamp?: ServicePreviewStamp;
  onLookup: () => void;
  onPreview: () => void;
  onExecute: () => void;
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
  const previewCurrent = Boolean(latestPreview?.status === 'complete' && props.previewStamp
    && latestPreview.criteria.inputDigest === props.previewStamp.inputDigest
    && serviceInputSignature(snapshot, props.request, serviceIndex, targetIndex) === props.previewStamp.signature);
  const unsavedReviewPaths = serviceInputReviewPaths(snapshot, serviceIndex, targetIndex, previewResult?.hostValuesRequireReview);
  const unsavedInputsReviewed = unsavedReviewPaths.every((path) => snapshot.session.draft.staffReviews[path]?.status === 'accepted');
  const freshPrepare = latestServiceFreshPrepare(snapshot, props.requestId, allocationId, service.id);
  const freshResult = record(freshPrepare?.result);
  const freshCurrent = Boolean(freshPrepare && latestPreview && previewCurrent && freshPrepare.status === 'complete'
    && freshPrepare.criteria.unsavedPreviewRef === latestPreview.ref
    && freshPrepare.criteria.inputDigest === latestPreview?.criteria.inputDigest && freshResult?.matchesApprovedNative === false);
  const freshPaths = freshCurrent && freshPrepare && Array.isArray(freshPrepare.criteria.reviewPaths)
    ? freshPrepare.criteria.reviewPaths.filter((path): path is string => typeof path === 'string') : [];
  const freshReviewsComplete = Boolean(freshCurrent && freshPrepare && freshPaths.length > 0
    && freshPaths.every((path) => serviceFreshReviewAccepted(snapshot, path, props.requestId, allocationId,
      service.id, freshPrepare.ref, freshPrepare.observedAt)));
  const createSaved = snapshot.operationResults.some((result) => result.requestId === props.requestId
    && result.allocationId === allocationId && result.workflow === 'create' && result.status === 'succeeded');
  const createReceipt = [...snapshot.operationResults].reverse().find((result) => result.requestId === props.requestId
    && result.allocationId === allocationId && result.workflow === 'create' && result.status === 'succeeded');
  const recoveredCreate = Boolean(createReceipt?.observationRefs.some((ref) => snapshot.session.draft.observations.some((item) =>
    item.ref === ref && item.criteria.workflow === 'create' && item.criteria.recovered === true)));
  const priorService = serviceOperationResult(snapshot, props.requestId, allocationId, service.id);
  const serviceRefs = Array.isArray(priorService?.observationRefs)
    ? priorService.observationRefs.filter((ref): ref is string => typeof ref === 'string') : [];
  const receiptObservation = snapshot.session.draft.observations.find((observation) => serviceRefs.includes(observation.ref)
    && observation.kind === 'service_preview' && observation.criteria.kind === 'saved_addon_receipt'
    && observation.criteria.serviceId === service.id && observation.criteria.requestId === props.requestId
    && observation.criteria.allocationId === allocationId);
  const savedReceipt = record(receiptObservation?.result);
  const canExecute = createReady && createSaved && !recoveredCreate && service.operation === 'add' && Boolean(selected) && previewCurrent
    && unsavedInputsReviewed && priorService?.status !== 'unknown' && priorService?.status !== 'succeeded'
    && (!freshCurrent || freshReviewsComplete) && !props.busy;
  const fields = [
    ['quantity', 'Target quantity', 'text'], ['startDate', 'Service start', 'date'], ['endDate', 'Service end', 'date'],
    ['unitPrice', 'Source unit price', 'text'], ['frequency', 'Frequency', 'text'], ['pricingControl', 'Pricing control', 'text'],
    ['folio', 'Folio', 'text'], ['comment', 'Service comment', 'text'],
  ] as const;
  return <section className={styles.serviceCard}>
    <div className={styles.cardTitle}><b>{service.requestedText || service.code || 'Add-On service'}</b><small>{humanize(service.operation)} · room {allocationId}</small></div>
    <p className={styles.help}>Choose a host-observed ITEM and review the unsaved native amount. After the owning Create has a verified confirmation, Go re-prepares on that saved stay; changed saved-target values require a separate review before Add-On Save.</p>
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
        const displayField = targetField?.override?.state === 'inherit' ? snapshot.fields[sharedPath]
          : targetField?.override || hasValue(targetField?.value) || record(targetField?.value)?.kind === 'none'
            ? targetField : snapshot.fields[sharedPath];
        return <TextField key={field} {...props} path={path} label={label} type={type}
          valueOverride={serviceFieldValue(snapshot, serviceIndex, targetIndex, field,
            { present: props.hasPendingEdit?.(path) ?? false, value: props.editValue(path) })} fieldOverride={displayField}
          onDone={props.onDone ? () => props.onDone?.(displayField?.path ?? path) : undefined}
          help="Target value overrides the shared service value when set." />;
      })}
    </div>
    <div className={styles.twoCol}>
      <button type="button" className={styles.secondaryButton} disabled={props.busy || !createReady || service.operation !== 'add'} onClick={props.onLookup}>Load native ITEM choices</button>
      <button type="button" className={styles.secondaryButton} disabled={props.busy || !createReady || service.operation !== 'add' || !selected} onClick={props.onPreview}>Preview this Add-On · not saved</button>
    </div>
    {!createReady && <small className={styles.help}>Complete every Create room and select each existing guest profile before loading or previewing Add-On values.</small>}
    {selected && !createSaved && <div className={styles.notice}>Save this Create room and verify its confirmation before an Add-On can be saved.</div>}
    {recoveredCreate && <div className={styles.notice}>This reservation was recovered after an interrupted Save. Add the service in Infor for now.</div>}
    {createReceipt && <div className={styles.fixedValue}><span>Saved Create target</span><b>{text(createReceipt.confirmation) || 'Confirmation receipt present'}</b><small>HMS Add-On operations below are bound to this room, not a guest-name search.</small></div>}
    {latestPreview && <div className={latestPreview.status === 'complete' ? styles.result : styles.notice}>
      <b>Native Add-On preview · {latestPreview.status === 'complete' ? 'not saved' : 'needs attention'}</b>
      {previewCurrent ? <small>Complete native preview still matches this service input; a Create receipt alone does not invalidate it.</small>
        : <small className={styles.problem}>No current complete preview matches the latest service/Create inputs. Re-run it before Go.</small>}
      {native ? <span>{text(native.code)} · {text(native.name)} · quantity {text(native.quantity)} · {text(native.currency)} {text(native.totalCost)} total</span>
        : <small>{text(previewResult?.issue) || 'No complete native Add-On price result was returned.'}</small>}
      {previewResult?.saved === false && <small>Saved: no. Create does not save this Add-On.</small>}
      {!unsavedInputsReviewed && unsavedReviewPaths.length > 0 && <small className={styles.problem}>Review the service input fields above before Add-On Go.</small>}
    </div>}
    {freshCurrent && freshPrepare && freshResult && <section className={styles.card}>
      <div className={styles.cardTitle}><b>Fresh Add-On prepare on saved confirmation</b><small>{text(record(freshResult.target)?.confirmation)} · not saved</small></div>
      <div className={styles.readValue}>Approved preview: {text(record(freshResult.previouslyApprovedNative)?.currency)} {text(record(freshResult.previouslyApprovedNative)?.totalCost)} total
        {' · '}Current saved-target prepare: {text(record(freshResult.native)?.currency)} {text(record(freshResult.native)?.totalCost)} total</div>
      <p className={styles.help}>These values were read from a new native prepare on the saved stay. Inspect each field and explicitly review it after this observation before the second Go.</p>
      {freshPaths.map((path) => {
        const leaf = path.split('/').at(-1) ?? '';
        const fieldName = leaf === 'value' ? 'quantity' : leaf;
        const freshValue = record(freshResult.native)?.[fieldName];
        const approvedValue = record(freshResult.previouslyApprovedNative)?.[fieldName];
        const reviewed = serviceFreshReviewAccepted(snapshot, path, props.requestId, allocationId,
          service.id, freshPrepare.ref, freshPrepare.observedAt);
        return <div className={styles.candidateOption} key={path}>
          <span><b>{humanize(fieldName)}</b><small>Approved preview: {text(approvedValue) || '—'} · Current saved prepare: {text(freshValue) || '—'}</small></span>
          {reviewed ? <span className={styles.accepted}>✓ Reviewed after fresh prepare</span>
            : <button type="button" className={styles.inlineButton} disabled={props.busy} onClick={() => props.onAcceptReview?.(path,
              serviceFreshReviewNote(props.requestId, allocationId, service.id, freshPrepare.ref))}>Review this native value</button>}
        </div>;
      })}
      {!freshReviewsComplete && <small className={styles.problem}>Go stays blocked until every field above is reviewed after this exact prepare.</small>}
    </section>}
    {priorService?.status === 'unknown' && <div className={styles.alert}>The Add-On Save may have dispatched. Reconcile its receipt below before any retry.</div>}
    {priorService?.status === 'succeeded' && <div className={styles.profileReady}>
      <b>Verified Add-On saved on confirmation {text(savedReceipt?.confirmation) || '—'}</b>
      <span>{text(record(savedReceipt?.native)?.code)} · {text(record(savedReceipt?.native)?.name)} · native ID {text(savedReceipt?.nativeId)}</span>
      <small>{text(record(savedReceipt?.native)?.currency)} {text(record(savedReceipt?.native)?.totalCost)} · fresh HMS readback confirmed</small>
    </div>}
    {createSaved && service.operation === 'add' && <button type="button" className={styles.goButton} disabled={!canExecute} onClick={props.onExecute}>
      {freshCurrent ? 'Go · save the reviewed HMS Add-On' : 'Go · recheck saved stay, then save Add-On'}
    </button>}
    <small className={styles.help}>Each service save is separate from the reservation and records its own native receipt and readback.</small>
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

function TextField(props: EditorProps & { path: string; label: string; type?: 'text' | 'email' | 'date' | 'number' | 'tel'; min?: number; max?: number; multiline?: boolean; help?: string; valueOverride?: unknown; fieldOverride?: ReservationFieldProjection; onValue?: (value: unknown) => void; blurPath?: string; blurPaths?: string[]; hideState?: boolean; hideClear?: boolean }) {
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
    {!props.hideState && <FieldValueState {...props} path={props.blurPath ?? props.path} hideClear={props.hideClear} />}
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
  const sourceValue = draftAtPath(props.snapshot, props.path);
  const hasSourceValue = sourceValue !== null && sourceValue !== undefined;
  const ownsValue = field?.override?.state === 'inherit'
    ? false
    : field?.override
      ? true
      : hasSourceValue;
  const [own, setOwn] = useState(ownsValue);
  useEffect(() => { setOwn(ownsValue); }, [field?.override?.updatedAt, field?.override?.state, sourceValue]);
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

function FieldValueState(props: EditorProps & { path: string; hideClear?: boolean }) {
  const current = props.snapshot.fields[props.path]?.override?.state;
  const label = current === 'set' ? 'Own value' : current === 'unknown' ? 'Unknown'
    : current === 'none' || current === 'clear' ? 'No value' : current === 'inherit' ? 'Inherited' : 'Source value';
  return <div className={styles.valueState}>
    <small>{label}</small>
    {current !== 'inherit' && <button type="button" onClick={() => { props.onStage(props.path, undefined, 'inherit'); props.onBlur(props.path); }}>Use source / inherit</button>}
    {current !== 'unknown' && <button type="button" onClick={() => { props.onStage(props.path, undefined, 'unknown'); props.onBlur(props.path); }}>Mark unknown</button>}
    {!props.hideClear && current !== 'none' && current !== 'clear' && <button type="button" onClick={() => { props.onStage(props.path, undefined, 'none'); props.onBlur(props.path); }}>Clear value</button>}
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

function CancelEditor(props: EditorProps & {
  busy: boolean; reviewBindings: Record<string, CancelFinancialReview>; onLookup: () => void;
  onPrepare: (hintId: string) => void; onAcceptPreview: (hintId: string) => void; onExecute: (hintId: string) => void;
}) {
  const body = `${requestPath(props.request)}/body`;
  const scope = record(effectiveValueFor(props.snapshot, `${body}/targets`));
  const include = Array.isArray(scope?.include) ? scope.include.map((value, index) => ({ value: record(value) ?? {}, index })) : [];
  const reasonPath = `${body}/reason/text`;
  const notePath = `${body}/cancellationNote`;
  const reason = text(props.editValue(reasonPath));
  const note = text(props.editValue(notePath));
  const excludes = Array.isArray(scope?.exclude) ? scope.exclude : [];
  const sourceRequest = props.snapshot.session.draft.proposal.content.requests.find((request) => request.id === props.request.id);
  const unhandledRefs = Boolean(sourceRequest && (sourceRequest.serviceRefs.length > 0 || sourceRequest.documentRefs.length > 0));
  const targetMode = text(props.editValue(`${body}/targets/mode`));
  const hint = include.length === 1 ? include[0] : null;
  const hintId = hint ? String(hint.value.id ?? '') : '';
  const hintRoot = hint ? `${body}/targets/include/${hint.index}` : '';
  const selectionPath = hint ? `${hintRoot}/suggestedRef` : '';
  const selectedRef = selectionPath ? cancelSelectedRef(props.snapshot, selectionPath) : null;
  const queryPart = (path: string) => text(props.editValue(path)) || null;
  const candidates = hint ? props.snapshot.session.draft.observations.flatMap((observation) => {
    const criteria = observation.criteria, query = record(criteria.query), result = record(observation.result);
    if (observation.kind !== 'stay_candidate' || observation.status !== 'complete' || criteria.workflow !== 'cancel'
        || criteria.stage !== 'lookup' || criteria.requestId !== props.request.id || criteria.hintId !== hintId
        || criteria.fieldPath !== selectionPath || !query
        || query.confirmation !== queryPart(`${hintRoot}/confirmation`)
        || query.guestName !== queryPart(`${hintRoot}/guestName`)
        || query.arrival !== queryPart(`${hintRoot}/bookedArrival`)
        || query.departure !== queryPart(`${hintRoot}/bookedDeparture`)) return [];
    const preimage = record(result?.preimage);
    return preimage ? [{ ref: observation.ref, preimage }] : [];
  }) : [];
  const selectedCandidate = candidates.find((candidate) => candidate.ref === selectedRef);
  const suggestedRef = selectionPath ? draftAtPath(props.snapshot, selectionPath) : null;
  const binding = hint ? props.reviewBindings[`${props.request.id}:${hintId}`] : null;
  const preview = hint && selectedRef ? latestCancelPreview(props.snapshot, props.request.id, hintId, selectedRef) : null;
  const previewResult = record(preview?.result);
  const previewReady = previewResult?.ready === true;
  const previewIsCurrent = Boolean(binding && preview?.ref === binding.observationRef && previewReady
    && previewResult?.approvalDigest === binding.approvalDigest);
  const acceptedReview = Boolean(binding && props.snapshot.session.draft.staffReviews[binding.reviewFieldPath]?.status === 'accepted'
    && props.snapshot.session.draft.staffReviews[binding.reviewFieldPath]?.note === binding.reviewNote);
  const nativeReasons = Array.isArray(previewResult?.reasons) ? previewResult.reasons.flatMap((value) => {
    const option = record(value);
    return option && typeof option.value === 'string' && typeof option.display === 'string'
      ? [{ value: option.value, display: option.display }] : [];
  }) : [];
  const reasonMatches = nativeReasons.some((option) => option.display === reason);
  const prior = hint ? props.snapshot.operationResults.find((result) => result.requestId === props.request.id
    && result.allocationId === hintId && result.workflow === 'cancel'
    && (result.status === 'unknown' || result.status === 'succeeded')) : undefined;
  const scopeReady = targetMode === 'explicit' && include.length === 1 && excludes.length === 0 && Boolean(hintId);
  const targetReady = Boolean(props.request.supported && scopeReady && selectedCandidate && !unhandledRefs && note.length <= 200);
  const canPrepare = targetReady && !props.busy;
  const canReview = targetReady && previewIsCurrent && reasonMatches && !acceptedReview && !props.busy && !prior;
  const canExecute = targetReady && previewIsCurrent && acceptedReview && reasonMatches && !props.busy && !prior;
  const preflight = record(previewResult?.preflight);
  const readOnlyFacts = preflight ? JSON.stringify(preflight, null, 2) : null;

  return <>
    <div className={styles.notice}>Cancel is one exact saved stay at a time. Lookup and Prepare are read-only; Go rechecks current policy and fees before any native cancellation. An uncertain save must be reconciled, never retried blindly.</div>
    {!props.request.supported && <div className={styles.alert}>Cancel is not enabled for this property in the connected native route.</div>}
    {unhandledRefs && <div className={styles.alert}>This request also contains service or document references that the connected Cancel tool cannot process. It will not cancel a broader scope.</div>}
    <section className={styles.card}>
      <div className={styles.cardTitle}><b>Exact saved-stay target</b><small>{include.length} included target(s)</small></div>
      <FieldShell path={`${body}/targets/mode`} label="Scope" field={props.snapshot.fields[`${body}/targets/mode`]}>
        <select className={styles.select} value={targetMode} onChange={(event) => {
          props.onStage(`${body}/targets/mode`, event.target.value); props.onBlur(`${body}/targets/mode`);
        }}><option value="unresolved">Unresolved</option><option value="explicit">One explicit saved stay</option></select>
      </FieldShell>
      {hint ? <>
        <div className={styles.twoCol}>
          <TextField {...props} path={`${hintRoot}/confirmation`} label="Confirmation" />
          <TextField {...props} path={`${hintRoot}/guestName`} label="Guest name hint" />
        </div>
        <div className={styles.twoCol}>
          <TextField {...props} path={`${hintRoot}/bookedArrival`} label="Booked arrival hint" type="date" />
          <TextField {...props} path={`${hintRoot}/bookedDeparture`} label="Booked departure hint" type="date" />
        </div>
        <div className={selectedCandidate ? styles.profileReady : styles.profileWarning}>
          <b>{selectedCandidate ? 'Exact native stay selected' : 'Select a native match from Lookup'}</b>
          {selectedCandidate && <span>{text(selectedCandidate.preimage.confirmation)} · {text(selectedCandidate.preimage.firstName)} {text(selectedCandidate.preimage.lastName)} · {text(selectedCandidate.preimage.arrival)} → {text(selectedCandidate.preimage.departure)} · {text(selectedCandidate.preimage.roomType)} / {text(selectedCandidate.preimage.ratePlan)}</span>}
          {typeof suggestedRef === 'string' && !selectedRef && <small>A source/model suggestion is not an approved target. Select a complete native lookup result.</small>}
          {candidates.length > 0 && <div className={styles.candidateList}>{candidates.map(({ ref, preimage }) => <div className={styles.candidateOption} key={ref}>
            <span><b>{text(preimage.confirmation)} · {text(preimage.firstName)} {text(preimage.lastName)}</b><small>{text(preimage.arrival)} → {text(preimage.departure)} · stay {text(preimage.nativeStayId)}</small></span>
            <button type="button" disabled={props.busy} onClick={() => { props.onStage(selectionPath, ref); props.onBlur(selectionPath); }}>
              {selectedRef === ref ? 'Selected exact stay' : 'Select this stay'}
            </button>
          </div>)}</div>}
          {!candidates.length && <small>Enter the exact confirmation and original dates from the email, then run native Lookup.</small>}
        </div>
      </> : <div className={styles.alert}>
        {include.length === 0
          ? <>Add one exact saved-stay hint from the message before lookup. The target must be confirmed in Infor; no broad cancellation is allowed. <button type="button" className={styles.inlineButton} disabled={props.busy} onClick={() => {
            const id = `cancel_target_${crypto.randomUUID().replaceAll('-', '')}`;
            const includePath = `${body}/targets/include`;
            props.onStage(includePath, [{ id, candidateRefs: [], suggestedRef: null, sourceRefs: [] }]);
            props.onStage(`${body}/targets/mode`, 'explicit');
            props.onBlur(includePath); props.onBlur(`${body}/targets/mode`);
          }}>Add exact saved-stay hint</button></>
          : <>This Cancel tool requires exactly one explicit saved-stay hint. Split multiple stays into separate requests before proceeding.</>}
      </div>}
      {excludes.length > 0 && <div className={styles.alert}>Excluded targets are unsupported. No cancellation action is offered for this scope.</div>}
      <button type="button" className={styles.secondaryButton} disabled={!props.request.supported || targetMode !== 'explicit' || include.length !== 1 || excludes.length > 0 || props.busy}
        onClick={props.onLookup}>Find exact stay and current preflight in Infor</button>
    </section>
    <section className={styles.card}>
      <div className={styles.cardTitle}><b>Cancellation reason and note</b><small>Reason must exactly match a current native option</small></div>
      <FieldShell path={reasonPath} label="Native cancellation reason" field={props.snapshot.fields[reasonPath]}>
        <select className={styles.select} value={nativeReasons.some((option) => option.display === reason) ? reason : ''}
          disabled={nativeReasons.length === 0} onChange={(event) => {
            const value = event.target.value;
            props.onStage(reasonPath, value, value ? 'set' : 'none'); props.onBlur(reasonPath);
          }}><option value="">{nativeReasons.length ? 'Choose one listed Infor reason' : 'Prepare a native preview to load reason options'}</option>
          {nativeReasons.map((option) => <option value={option.display} key={option.value}>{option.display}</option>)}
        </select>
        {nativeReasons.length > 0 && reason && !reasonMatches && <small className={styles.problem}>The source reason does not match a current Infor option. Choose one listed above.</small>}
      </FieldShell>
      <FieldShell path={notePath} label="Cancellation note (optional, max 200 characters)" field={props.snapshot.fields[notePath]}>
        <textarea id={notePath} className={styles.textarea} rows={3} maxLength={200} value={note}
          onChange={(event) => props.onStage(notePath, event.target.value, event.target.value ? 'set' : 'none')}
          onBlur={() => props.onBlur(notePath)} />
        <small className={styles.help}>{note.length}/200 characters. No unsupported note is passed through.</small>
      </FieldShell>
    </section>
    {previewResult && <section className={styles.card}>
      <div className={styles.cardTitle}><b>{previewIsCurrent ? 'Current native cancellation preview' : 'Previous native preview · refresh before approval'}</b>
        <small>{text(previewResult.feeState) || 'Fee state unknown'} · {text(preview?.observedAt)}</small></div>
      {preview && <div className={styles.readValue}>Preview observation {preview.ref} · {text(record(previewResult.target)?.confirmation)} · {
        text(record(previewResult.target)?.arrival)} → {text(record(previewResult.target)?.departure)}</div>}
      {previewResult.penaltyText ? <div className={styles.alert}><b>Current native penalty / charge text</b><span>{text(previewResult.penaltyText)}</span></div>
        : <div className={styles.notice}>No penalty text was returned in this preview; fee state remains explicit below.</div>}
      {Boolean(previewResult.roomScope) && <div className={styles.notice}>Native room scope: {text(previewResult.roomScope) || JSON.stringify(previewResult.roomScope)}</div>}
      {Array.isArray(previewResult.policyFacts) && previewResult.policyFacts.length > 0 && <ul className={styles.help}>
        {previewResult.policyFacts.map((fact, index) => <li key={`${index}-${text(fact)}`}>{text(fact)}</li>)}
      </ul>}
      {preflight && <details className={styles.evidence}><summary>Inspect all read-only HMS preflight facts</summary><pre>{readOnlyFacts}</pre></details>}
      {binding && previewIsCurrent && previewReady && <div className={acceptedReview ? styles.profileReady : styles.profileWarning}>
        <b>{acceptedReview ? 'Exact preview and fee facts reviewed' : 'Staff review required before Go'}</b>
        <span>Approval digest {binding.approvalDigest}</span>
        {!acceptedReview && <button type="button" className={styles.secondaryButton} disabled={!canReview}
          onClick={() => hint && props.onAcceptPreview(hintId)}>I reviewed the current scope, policy, and fee facts</button>}
      </div>}
      {binding && !previewIsCurrent && <div className={styles.problem}>The prepared observation no longer matches the latest preview binding. Refresh and review again.</div>}
    </section>}
    {hint && <div className={styles.twoCol}>
      <button type="button" className={styles.secondaryButton} disabled={!canPrepare} onClick={() => props.onPrepare(hintId)}>
        {nativeReasons.length ? 'Refresh native preview and policy' : 'Load native preview and cancellation reasons'}
      </button>
      <button type="button" className={styles.goButton} disabled={!canExecute} onClick={() => props.onExecute(hintId)}>Go · cancel this exact stay</button>
    </div>}
    {prior?.status === 'succeeded' && <div className={styles.notice}>This stay has a verified cancellation receipt. Later edits affect only the source-bound draft.</div>}
    {prior?.status === 'unknown' && <div className={styles.alert}>Cancel outcome is uncertain. Use the operation’s reconciliation action below before taking any further action.</div>}
  </>;
}

const AMEND_FIELDS = [
  { value: 'arrival', label: 'Arrival', type: 'date' }, { value: 'departure', label: 'Departure', type: 'date' },
  { value: 'adults', label: 'Adults', type: 'number' }, { value: 'childCount', label: 'Children', type: 'number' },
  { value: 'childAges', label: 'Child ages', type: 'ages' }, { value: 'roomType', label: 'Room category', type: 'code' },
  { value: 'ratePlan', label: 'Rate plan', type: 'code' }, { value: 'firstName', label: 'Guest first name', type: 'text' },
  { value: 'lastName', label: 'Guest last name', type: 'text' }, { value: 'guestEmail', label: 'Guest email', type: 'email' },
  { value: 'bookerName', label: 'Booker name', type: 'text' }, { value: 'bookerContact', label: 'Booker contact', type: 'text' },
  { value: 'cmsSend', label: 'Send confirmation email', type: 'boolean' },
  { value: 'cmsMessageId', label: 'Confirmation template ID', type: 'text' },
  { value: 'cmsRecipient', label: 'Confirmation recipient', type: 'email' },
] as const;
const AMEND_CLEAR_FIELDS = ['guestEmail', 'bookerName', 'bookerContact', 'cmsSend'];
const AMEND_PRICE_FIELDS = new Set(['arrival', 'departure', 'adults', 'childCount', 'childAges', 'roomType', 'ratePlan']);
const AMEND_UNSUPPORTED_FIELDS = new Set(['roomTypeForCharge', 'reservationNote']);

function changeSupported(change: Record<string, unknown>): boolean {
  const op = text(change.op), field = text(change.field);
  if (op === 'shift_dates' || op === 'shift_departure') return typeof change.days === 'number' && Number.isSafeInteger(change.days);
  if (op === 'clear') return AMEND_CLEAR_FIELDS.some((value) => value === field);
  return op === 'set' && AMEND_FIELDS.some((item) => item.value === field);
}

function changeHasUsefulValue(change: Record<string, unknown>): boolean {
  const op = text(change.op), field = text(change.field);
  if (op === 'clear') return AMEND_CLEAR_FIELDS.some((value) => value === field);
  if (op === 'shift_dates' || op === 'shift_departure') return Number.isSafeInteger(change.days) && change.days !== 0;
  const value = change.value;
  if (field === 'childAges') return Array.isArray(value) && value.every((age) => typeof age === 'number' && Number.isInteger(age) && age >= 0 && age <= 17);
  if (field === 'adults') return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 16;
  if (field === 'childCount') return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 9;
  if (field === 'arrival' || field === 'departure') return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (field === 'roomType' || field === 'ratePlan') return typeof value === 'string' && /^[A-Z0-9]{1,12}$/.test(value);
  if (field === 'cmsSend') return typeof value === 'boolean';
  if (field === 'guestEmail' || field === 'cmsRecipient') return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1000;
}

function isAmendClearOrEmptyReviewPath(snapshot: ReservationPaneSnapshot, path: string): boolean {
  const requests = snapshot.session.draft.proposal.content.requests.filter((request) => request.kind === 'amend');
  for (const request of requests) {
    const body = `/proposal/content/requests/${encodeURIComponent(request.id)}/body`;
    const groups: Array<{ path: string; changes: unknown[] }> = [];
    const sharedPath = `${body}/sharedChanges`;
    const shared = effectiveValueFor(snapshot, sharedPath);
    groups.push({ path: sharedPath, changes: Array.isArray(shared) ? shared : [] });
    const perTargetPath = `${body}/perTarget`;
    const perTarget = effectiveValueFor(snapshot, perTargetPath);
    if (Array.isArray(perTarget)) perTarget.forEach((rawPerTarget, perIndex) => {
      const per = record(rawPerTarget);
      const changePath = `${perTargetPath}/${perIndex}/changes`;
      groups.push({ path: changePath, changes: Array.isArray(per?.changes) ? per.changes : [] });
    });
    for (const group of groups) {
      for (const [index, rawChange] of group.changes.entries()) {
        const change = record(rawChange);
        if (!change || path !== `${group.path}/${index}/value`) continue;
        const field = text(change.field);
        if (change.op === 'clear' && AMEND_CLEAR_FIELDS.some((value) => value === field)) return true;
        if (change.op === 'set' && field === 'childAges' && Array.isArray(change.value) && change.value.length === 0) return true;
      }
    }
  }
  return false;
}

function centsLabel(price: Record<string, unknown> | null, key: 'averageCents' | 'totalCents'): string | null {
  const value = price?.[key];
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const padded = value.padStart(3, '0');
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

function AmendEditor(props: EditorProps & {
  preparedRefs: Record<string, string>; busy: boolean; onLookup: () => void;
  onPrepare: (hintId: string) => void; onExecute: (hintId: string) => void;
}) {
  const { body, scope, rows } = amendTargets(props.snapshot, props.request);
  const perTargetPath = `${body}/perTarget`;
  const rawPerTargets = effectiveValueFor(props.snapshot, perTargetPath);
  const perTargets = Array.isArray(rawPerTargets) ? rawPerTargets.map((value, index) => ({ value: record(value) ?? {}, index })) : [];
  const excludes = Array.isArray(scope?.exclude) ? scope.exclude : [];
  const sharedChangesPath = `${body}/sharedChanges`;
  const rawSharedChanges = effectiveValueFor(props.snapshot, sharedChangesPath);
  const sharedChanges = Array.isArray(rawSharedChanges) ? rawSharedChanges.map((value) => record(value) ?? {}) : [];
  const addTarget = () => {
    const id = `amend_target_${crypto.randomUUID().replaceAll('-', '')}`;
    const includePath = `${body}/targets/include`;
    const include = rows.map(({ value }) => value);
    const per = perTargets.map(({ value }) => value);
    props.onStage(includePath, [...include, { id, candidateRefs: [], suggestedRef: null, sourceRefs: [] }]);
    props.onStage(`${body}/targets/mode`, 'explicit');
    if (!per.some((item) => item.hintId === id)) per.push({ hintId: id, changes: [], rateHandling: null, currentObservationRefs: [] });
    props.onStage(perTargetPath, per);
    props.onBlur(includePath); props.onBlur(`${body}/targets/mode`); props.onBlur(perTargetPath);
  };
  const addPerTarget = (hintId: string) => {
    const per = perTargets.map(({ value }) => value);
    if (per.some((item) => item.hintId === hintId)) return;
    per.push({ hintId, changes: [], rateHandling: null, currentObservationRefs: [] });
    props.onStage(perTargetPath, per); props.onBlur(perTargetPath);
  };
  if (!scope) return <div className={styles.alert}>The saved Amend request has no exact saved-stay scope. Nothing can be looked up or amended from a guessed target.</div>;
  const unsupportedShared = sharedChanges.some((change) => !changeSupported(change));
  const unsupportedTarget = (per: Record<string, unknown> | undefined) => {
    const changes = Array.isArray(per?.changes) ? per.changes.map((value) => record(value) ?? {}) : [];
    return changes.some((change) => !changeSupported(change)) || changes.some((change) => AMEND_UNSUPPORTED_FIELDS.has(text(change.field)));
  };

  return <>
    <div className={styles.notice}>Amend applies only to an exact saved stay selected from fresh native lookup. Prepare shows unsaved HMS price/readback; Go saves one stay. No manual nightly price is accepted.</div>
    <section className={styles.card}>
      <div className={styles.cardTitle}><b>Target scope</b><small>{humanize(text(scope.mode) || 'unresolved')} · {rows.length} stay hint(s)</small></div>
      <FieldShell path={`${body}/targets/mode`} label="Scope" field={props.snapshot.fields[`${body}/targets/mode`]}>
        <select className={styles.select} value={text(props.editValue(`${body}/targets/mode`))} onChange={(event) => {
          props.onStage(`${body}/targets/mode`, event.target.value); props.onBlur(`${body}/targets/mode`);
        }}><option value="unresolved">Unresolved</option><option value="explicit">Explicit saved stays</option></select>
      </FieldShell>
      {excludes.length > 0 && <div className={styles.alert}>This native Amend route cannot apply excluded stays. Clear the unsupported exclusion in the source-bound draft before continuing.</div>}
      <button type="button" className={styles.secondaryButton} disabled={props.busy} onClick={props.onLookup}>Find exact stays in Infor</button>
      <button type="button" className={styles.secondaryButton} disabled={props.busy || rows.length >= 100} onClick={addTarget}>Add saved-stay hint</button>
    </section>
    {rows.map(({ value: hint, index }) => {
      const hintId = String(hint.id ?? '');
      const hintRoot = `${body}/targets/include/${index}`;
      const selectionPath = `${hintRoot}/suggestedRef`;
      const selectedRef = amendSelection(props.snapshot, selectionPath);
      const candidates = props.snapshot.session.draft.observations.flatMap((observation) => {
        const criteria = observation.criteria;
        if (observation.kind !== 'stay_candidate' || observation.status !== 'complete' || criteria.workflow !== 'amend'
            || criteria.requestId !== props.request.id || criteria.hintId !== hintId || criteria.selectionPath !== selectionPath) return [];
        const candidate = record(record(observation.result)?.candidate);
        return candidate ? [{ ref: observation.ref, candidate }] : [];
      });
      const selectedObservation = candidates.find((item) => item.ref === selectedRef);
      const selectionReview = props.snapshot.session.draft.staffReviews[selectionPath]?.status === 'accepted';
      const per = perTargets.find((item) => item.value.hintId === hintId);
      const perRoot = per ? `${perTargetPath}/${per.index}` : null;
      const ratePath = perRoot ? `${perRoot}/rateHandling` : null;
      const changesPath = perRoot ? `${perRoot}/changes` : null;
      const rawChanges = changesPath ? effectiveValueFor(props.snapshot, changesPath) : null;
      const targetChanges = Array.isArray(rawChanges) ? rawChanges.map((value) => record(value) ?? {}) : [];
      const allChanges = [...sharedChanges, ...targetChanges];
      const prep = latestAmendPreparation(props.snapshot, props.request.id, hintId);
      const prepRefCurrent = Boolean(prep && props.preparedRefs[`${props.request.id}:${hintId}`] === prep.ref);
      const prepResult = record(prep?.result);
      const approvedPrice = record(prepResult?.approvedPrices);
      const priceTotal = centsLabel(approvedPrice, 'totalCents');
      const priceAverage = centsLabel(approvedPrice, 'averageCents');
      const rateHandling = ratePath ? text(props.editValue(ratePath)) : '';
      const pricingChanged = allChanges.some((change) => change.op === 'shift_dates' || change.op === 'shift_departure'
        || change.op === 'set' && AMEND_PRICE_FIELDS.has(text(change.field)));
      const needsReprice = pricingChanged && rateHandling !== 'reprice';
      const targetUnsupported = unsupportedShared || unsupportedTarget(per?.value);
      const changePathsReviewed = allChanges.every((change, changeIndex) => {
        const isShared = changeIndex < sharedChanges.length;
        const localIndex = isShared ? changeIndex : changeIndex - sharedChanges.length;
        const changeRoot = isShared ? `${sharedChangesPath}/${localIndex}` : `${changesPath}/${localIndex}`;
        const path = change.op === 'shift_dates' || change.op === 'shift_departure' ? `${changeRoot}/days`
          : change.op === 'clear' || change.op === 'set' ? `${changeRoot}/value` : '';
        return Boolean(path && props.snapshot.session.draft.staffReviews[path]?.status === 'accepted');
      });
      const rateReviewed = Boolean(ratePath && props.snapshot.session.draft.staffReviews[ratePath]?.status === 'accepted');
      const changesReady = allChanges.length > 0 && allChanges.every((change) => changeSupported(change) && changeHasUsefulValue(change));
      const prior = props.snapshot.operationResults.find((result) => result.requestId === props.request.id
        && result.allocationId === hintId && result.workflow === 'amend' && (result.status === 'succeeded' || result.status === 'unknown'));
      const canPrepare = props.request.supported && !props.busy && !targetUnsupported && Boolean(selectedObservation)
        && Boolean(per && rateHandling) && changesReady;
      const canExecute = canPrepare && prepRefCurrent && changePathsReviewed && rateReviewed && !needsReprice
        && selectionReview && prior?.status !== 'unknown' && prior?.status !== 'succeeded';
      const targetValue = record(prepResult?.target);
      return <section className={styles.card} key={hintId || index}>
        <div className={styles.cardTitle}><b>Saved stay {index + 1}</b><small>{hintId || 'Target identifier missing'}</small></div>
        <div className={styles.twoCol}>
          <TextField {...props} path={`${hintRoot}/confirmation`} label="Confirmation" />
          <TextField {...props} path={`${hintRoot}/guestName`} label="Guest name" />
        </div>
        <div className={styles.twoCol}>
          <TextField {...props} path={`${hintRoot}/bookedArrival`} label="Booked arrival hint" type="date" />
          <TextField {...props} path={`${hintRoot}/bookedDeparture`} label="Booked departure hint" type="date" />
        </div>
        <div className={styles.profileWarning}>
          <b>{selectedObservation && selectionReview ? 'Exact native stay selected and reviewed' : selectedObservation ? 'Native stay selected · staff confirmation required' : 'Select an exact native stay'}</b>
          {selectedObservation && <span>{text(selectedObservation.candidate.confirmation)} · {text(selectedObservation.candidate.firstName)} {text(selectedObservation.candidate.lastName)} · {text(selectedObservation.candidate.arrival)} → {text(selectedObservation.candidate.departure)} · {text(selectedObservation.candidate.roomType)} / {text(selectedObservation.candidate.ratePlan)}</span>}
          {candidates.length > 0 && <div className={styles.candidateList}>{candidates.map(({ ref, candidate }) => <div className={styles.candidateOption} key={ref}>
            <span><b>{text(candidate.confirmation)} · {text(candidate.firstName)} {text(candidate.lastName)}</b><small>{text(candidate.arrival)} → {text(candidate.departure)} · {text(candidate.roomType)} / {text(candidate.ratePlan)}</small></span>
            <button type="button" disabled={props.busy} onClick={() => { props.onStage(selectionPath, ref); props.onBlur(selectionPath); }}>{selectedRef === ref ? 'Confirm selected' : 'Select exact stay'}</button>
          </div>)}</div>}
          {!candidates.length && <small>Enter exact confirmation and/or original stay hints, then refresh native lookup. A source suggestion alone is not a native match.</small>}
        </div>
        {per ? <>
          <FieldShell path={ratePath!} label="Rate handling" field={props.snapshot.fields[ratePath!] }>
            <select className={styles.select} value={rateHandling} onChange={(event) => {
              const value = event.target.value;
              props.onStage(ratePath!, value, value ? 'set' : 'none'); props.onBlur(ratePath!);
            }}><option value="">Choose rate handling</option><option value="retain">Retain existing rate</option><option value="reprice">Reprice from current HMS rates</option></select>
            <small className={styles.help}>A date, occupancy, room-category or rate-plan change requires Reprice. Rate amounts remain native-only.</small>
          </FieldShell>
          <AmendChangeList {...props} path={sharedChangesPath} label="Changes shared across selected stays" changes={sharedChanges} shared />
          <AmendChangeList {...props} path={changesPath!} label="Changes for this stay" changes={targetChanges} />
          {targetUnsupported && <div className={styles.alert}>A change in this request is not supported by the connected Amend native tools. Remove or correct it in the source request; no write will be offered.</div>}
          {needsReprice && <div className={styles.problem}>This change can affect price. Choose “Reprice from current HMS rates” before Prepare.</div>}
          {prepResult && <div className={prepRefCurrent ? styles.profileReady : styles.profileWarning}>
            <b>{prepRefCurrent ? 'Current unsaved Amend preview' : 'Previous preview · changes since then require Prepare again'}</b>
            <span>{priceAverage && approvedPrice ? `${text(approvedPrice.currency)} ${priceAverage} average / night` : 'No native average price was returned'}
              {priceTotal && approvedPrice ? ` · ${text(approvedPrice.currency)} ${priceTotal} total` : ''}</span>
            {targetValue && <small>Prepared target: {text(targetValue.arrival)} → {text(targetValue.departure)} · {text(targetValue.roomType)} / {text(targetValue.ratePlan)}</small>}
          </div>}
          <div className={styles.twoCol}>
            <button type="button" className={styles.secondaryButton} disabled={!canPrepare} onClick={() => props.onPrepare(hintId)}>Prepare unsaved price and availability</button>
            <button type="button" className={styles.goButton} disabled={!canExecute} onClick={() => props.onExecute(hintId)}>Go · amend this stay</button>
          </div>
          {prior?.status === 'succeeded' && <div className={styles.notice}>This stay already has a verified Amend receipt. Later edits affect the draft only.</div>}
          {prior?.status === 'unknown' && <div className={styles.alert}>Amend outcome is uncertain. Reconcile the operation below before retrying.</div>}
        </> : <div className={styles.notice}>
          No per-stay change record exists yet. <button type="button" className={styles.inlineButton} disabled={props.busy} onClick={() => addPerTarget(hintId)}>Add rate handling and changes for this stay</button>
        </div>}
      </section>;
    })}
    {rows.length === 0 && <div className={styles.notice}>Add the exact saved-stay confirmation and dates from the selected email, then resolve them against Infor.</div>}
    {!props.request.supported && <div className={styles.alert}>Amend is not enabled for this property in the connected native route.</div>}
  </>;
}

function AmendChangeList(props: EditorProps & { path: string; label: string; changes: Record<string, unknown>[]; shared?: boolean }) {
  const add = (op: 'set' | 'clear' | 'shift_dates' | 'shift_departure') => {
    const row = op === 'shift_dates' || op === 'shift_departure'
      ? { op, days: 0, sourceRefs: [] }
      : op === 'clear' ? { op, field: 'guestEmail', sourceRefs: [] }
        : { op, field: 'arrival', value: '', sourceRefs: [] };
    props.onStage(props.path, [...props.changes, row]); props.onBlur(props.path);
  };
  return <section className={styles.card}>
    <div className={styles.cardTitle}><b>{props.label}</b><small>{props.changes.length} change(s)</small></div>
    {props.changes.map((change, index) => <AmendChangeRow key={`${props.path}-${index}`} {...props} path={`${props.path}/${index}`} change={change} />)}
    {props.changes.length === 0 && <small className={styles.help}>No changes recorded. Add only the exact fields requested; shared changes apply to every included stay.</small>}
    <div className={styles.twoCol}>
      <button type="button" className={styles.secondaryButton} disabled={Boolean(props.busy)} onClick={() => add('set')}>Add field change</button>
      <button type="button" className={styles.secondaryButton} disabled={Boolean(props.busy)} onClick={() => add('clear')}>Add allowed field clear</button>
      <button type="button" className={styles.secondaryButton} disabled={Boolean(props.busy)} onClick={() => add('shift_dates')}>Shift arrival and departure</button>
      <button type="button" className={styles.secondaryButton} disabled={Boolean(props.busy)} onClick={() => add('shift_departure')}>Shift departure only</button>
    </div>
  </section>;
}

function AmendChangeRow(props: EditorProps & { path: string; change: Record<string, unknown>; shared?: boolean }) {
  const { path, change } = props;
  const op = text(change.op);
  const fieldName = text(props.editValue(`${path}/field`)) || text(change.field);
  const spec = AMEND_FIELDS.find((item) => item.value === fieldName);
  const unsupported = !changeSupported(change) || AMEND_UNSUPPORTED_FIELDS.has(fieldName);
  const valuePath = `${path}/value`;
  const currentValue = props.editValue(valuePath);
  const updateField = (field: string) => {
    props.onStage(`${path}/field`, field);
    if (op === 'set') props.onStage(valuePath, '', 'set');
    props.onBlur(`${path}/field`); if (op === 'set') props.onBlur(valuePath);
  };
  return <div className={styles.serviceCard}>
    <div className={styles.cardTitle}><b>{op === 'set' ? 'Set field' : op === 'clear' ? 'Clear field' : op === 'shift_dates' ? 'Shift both dates' : op === 'shift_departure' ? 'Shift departure' : 'Unsupported source change'}</b>
      <small>{props.shared ? 'Shared across stays' : 'This stay only'}</small></div>
    {op === 'set' || op === 'clear' ? <FieldShell path={`${path}/field`} label="Native field" field={props.snapshot.fields[`${path}/field`]}>
      <select className={styles.select} value={fieldName} onChange={(event) => updateField(event.target.value)}>
        {(op === 'clear' ? AMEND_FIELDS.filter((item) => AMEND_CLEAR_FIELDS.some((value) => value === item.value)) : AMEND_FIELDS)
          .map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
      </select>
    </FieldShell> : null}
    {op === 'shift_dates' || op === 'shift_departure' ? <TextField {...props} path={`${path}/days`} label="Days to shift" type="number" min={-3660} max={3660} /> : null}
    {op === 'set' && spec ? spec.type === 'boolean' ? <FieldShell path={valuePath} label={spec.label} field={props.snapshot.fields[valuePath]}>
      <select className={styles.select} value={currentValue == null || currentValue === '' ? '' : currentValue ? 'true' : 'false'} onChange={(event) => {
        const value = event.target.value;
        props.onStage(valuePath, value === 'true', value ? 'set' : 'unknown'); props.onBlur(valuePath);
      }}><option value="">Choose explicitly</option><option value="true">Yes</option><option value="false">No</option></select>
    </FieldShell> : spec.type === 'ages' ? <TextField {...props} path={valuePath} label={spec.label} valueOverride={Array.isArray(currentValue) ? currentValue.join(', ') : text(currentValue)}
      help="Enter comma-separated exact ages. Leave empty only to explicitly set zero children." onValue={(value) => {
        const raw = text(value).trim();
        if (!raw) { props.onStage(valuePath, [], 'set'); return; }
        const parts = raw.split(',').map((item) => item.trim());
        const ages = parts.map(Number);
        props.onStage(valuePath, parts.every((item) => /^\d+$/.test(item)) && ages.every((age) => age <= 17) ? ages : raw);
      }} /> : spec.type === 'code' ? <CodeField {...props} path={valuePath} label={spec.label}
        help="Choose a code from complete native availability observations or type the requested HMS code." />
        : <TextField {...props} path={valuePath} label={spec.label} type={spec.type === 'date' ? 'date'
        : spec.type === 'number' ? 'number' : spec.type === 'email' ? 'email' : 'text'} min={spec.type === 'number' ? 0 : undefined}
        max={spec.type === 'number' ? (fieldName === 'adults' ? 16 : 9) : undefined}
        hideClear={fieldName === 'cmsMessageId' || fieldName === 'cmsRecipient'} /> : null}
    {op === 'set' && fieldName === 'childAges' && Array.isArray(currentValue) && currentValue.length === 0
        && props.snapshot.fields[valuePath]?.review !== 'accepted'
        && props.snapshot.session.draft.staffReviews[valuePath]?.status !== 'accepted' && props.onDone
      ? <button type="button" className={styles.inlineButton} disabled={Boolean(props.busy)} onClick={() => props.onDone?.(valuePath)}>Confirm zero children</button> : null}
    {op === 'clear' && !unsupported && <div className={styles.notice}>
      <span>This explicitly clears {spec?.label ?? fieldName}; HMS applies only supported contact/CMS clears.</span>
      <button type="button" className={styles.inlineButton} disabled={Boolean(props.busy)} onClick={() => props.onDone?.(valuePath)}>Confirm this clear</button>
    </div>}
    {unsupported && <div className={styles.alert}>This source change is unsupported by the connected native Amend module. Do not proceed until request is corrected.</div>}
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
    <QuoteReviewNotice {...props} />
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
  const parentOverride = props.snapshot.session.draft.fieldOverrides[props.path];
  const parentEmpty = parentOverride && ['none', 'clear', 'unknown'].includes(parentOverride.state);
  const party = parentEmpty ? {} : record(props.editValue(props.path)) ?? record(draftAtPath(props.snapshot, props.path)) ?? {};
  const namePath = `${props.path}/name`;
  const name = parentEmpty ? '' : text(props.editValue(namePath) ?? party.name);
  const nameField = { ...props.snapshot.fields[namePath],
    path: namePath, value: name,
    required: !parentEmpty && props.snapshot.session.draft.fieldReviewRequirements[namePath]?.required !== false,
    review: props.snapshot.session.draft.staffReviews[namePath]?.status ?? 'pending',
    provenance: props.snapshot.fields[namePath]?.provenance ?? 'source' as const,
    evidenceRefs: props.snapshot.session.draft.fieldReviewRequirements[namePath]?.evidenceRefs ??
      props.snapshot.session.draft.proposal.sourceClaims.find((claim) => claim.path === namePath)?.sourceRefs ?? [],
  };
  const selectionPath = `${props.path}/nativeSelectionRef`;
  const selectedRef = !parentEmpty && props.snapshot.fields[selectionPath]?.override?.state === 'set'
    && typeof props.snapshot.fields[selectionPath]?.value === 'string' ? props.snapshot.fields[selectionPath]!.value as string : null;
  const candidates = props.snapshot.session.draft.observations.flatMap((observation) => {
    if (parentEmpty || observation.kind !== 'party_candidate' || observation.status !== 'complete' || record(observation.coverage)?.complete !== true
        || observation.criteria.workflow !== 'quote' || observation.criteria.requestId !== props.request.id
        || observation.criteria.role !== props.role || !sameIdentityText(observation.criteria.searchName, name)) return [];
    const candidate = record(observation.result);
    return candidate && hasValue(candidate.nativeId) && hasValue(candidate.name) ? [{ observation, candidate }] : [];
  });
  const selected = candidates.find((entry) => entry.observation.ref === selectedRef
    && sameIdentityText(entry.candidate.name, name));
  return <FieldShell path={props.path} label={props.label} field={props.snapshot.fields[props.path]}
    onOpenEvidence={props.onOpenEvidence} onDone={props.onDone}>
    <fieldset disabled={Boolean(parentEmpty)} style={{ border: 0, padding: 0, margin: 0 }}>
      <TextField {...props} path={namePath} label={`${props.label} name`} fieldOverride={nameField}
        valueOverride={parentEmpty ? '' : undefined} />
    </fieldset>
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
            props.onStage(roomCodesPath, [roomCode]);
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

function QuoteReviewNotice(props: EditorProps) {
  const review = quoteReviewInfo(props.snapshot, props.request.id);
  if (!review.items.length) return null;
  return <section className={styles.card} aria-label="Quote rate and allowance review">
    <div className={styles.cardTitle}><b>Review before generating</b></div>
    {review.items.map((item, index) => <p className={styles.problem} key={index}>{item}</p>)}
    {review.accepted ? <small className={styles.accepted}>Reviewed for this native price.</small>
      : <button type="button" className={styles.secondaryButton} disabled={props.busy}
        onClick={() => props.onDone?.(review.path)}>Accept displayed rate and allowances</button>}
  </section>;
}

function QuoteArtifactReceipts({ snapshot, request }: { snapshot: ReservationPaneSnapshot; request: ReservationRequestProjection }) {
  const receipts = quoteReceiptObservations(snapshot, request.id);
  if (!receipts.length) return <div className={styles.notice}>No quote output receipt exists yet. Generate is enabled only after a current native Prepare and required-field review.</div>;
  return <>
    {receipts.map((observation) => {
      const operation = snapshot.operationResults.find((item) => item.workflow === 'quote' && item.requestId === request.id
        && item.id === observation.criteria.operationId);
      const currentDraft = operation?.draftRevision === snapshot.session.revision;
      const result = record(observation.result) ?? {};
      const artifacts = Array.isArray(result.artifacts) ? result.artifacts.map(record).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
      const cover = record(result.coverEmail);
      const failures = Array.isArray(result.failures) ? result.failures.map(text).filter(Boolean) : [];
      return <section className={styles.card} key={observation.ref}>
        <div className={styles.cardTitle}><b>Quote output receipt</b><small>{currentDraft ? 'Current draft' : 'Earlier draft'} · {observation.coverage.complete ? 'Complete' : 'Partial or failed'}</small></div>
        {!currentDraft && <div className={styles.problem}>These files reflect an earlier draft. Generate new outputs after reviewing your current changes.</div>}
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

function FilingReviewControl({ snapshot, path, label, value, busy, onDone }: {
  snapshot: ReservationPaneSnapshot; path: string; label: string; value: unknown; busy: boolean; onDone?: (path: string) => void;
}) {
  const review = snapshot.fields[path]?.review ?? snapshot.session.draft.staffReviews[path]?.status;
  return <div className={styles.valueState}>
    <small>{review === 'accepted' ? `Confirmed · ${label}` : `Confirm source · ${label}`}</small>
    {review !== 'accepted' && hasValue(value) && <button type="button" className={styles.inlineButton} disabled={busy}
      onClick={() => onDone?.(path)}>Confirm</button>}
  </div>;
}

function filingObservationResult(snapshot: ReservationPaneSnapshot, operation: Record<string, unknown>) {
  const refs = Array.isArray(operation.observationRefs) ? operation.observationRefs.filter((ref): ref is string => typeof ref === 'string') : [];
  return [...snapshot.session.draft.observations].reverse().find((observation) => refs.includes(observation.ref)
    && observation.kind === 'document' && observation.criteria.workflow === 'filing'
    && observation.criteria.requestId === operation.requestId);
}

function FilingEditor(props: EditorProps & { source: ReservationSourceContext; busy: boolean; canPrepare: boolean; canFile: boolean;
  onConfigure: (selection: { attachmentId: string; confirmation: string; kind: 'voucher' | 'payment_proof' }) => Promise<boolean>;
  onLookup: () => void; onPrepare: () => void; onFile: () => void; onOpenAttachment?: (ref: string) => void }) {
  const { snapshot, request, source } = props;
  const docs = filingDocuments(snapshot, request);
  const { scope, include } = filingTargetHints(snapshot, request);
  const hint = scope?.mode === 'explicit' && include.length === 1 && (!Array.isArray(scope.exclude) || scope.exclude.length === 0)
    ? include[0] : null;
  const targetPath = typeof hint?.id === 'string' ? filingTargetPath(request, hint.id) : null;
  const selectedTarget = filingTargetObservation(snapshot, request);
  const selectedRef = targetPath ? props.editValue(targetPath) : null;
  const candidates = hint ? filingTargetCandidates(snapshot, request, hint) : [];
  const targetReview = targetPath ? snapshot.session.draft.staffReviews[targetPath]?.status : undefined;
  const sourceProof = docs.length === 1 && selectedTarget
    ? filingSourceObservation(snapshot, request, docs[0]!.id, selectedTarget.observation.ref) : undefined;
  const proofResult = record(sourceProof?.result);
  const filingResults = snapshot.operationResults.filter((result) => result.workflow === 'filing' && result.requestId === request.id);
  const savedReceipt = filingResults.some((result) => result.status === 'succeeded');
  const eligiblePdfs = source.attachments.filter((attachment) => (attachment.mimeType?.toLowerCase() === 'application/pdf'
    || /\.pdf$/iu.test(attachment.name)) && attachment.uploadability !== 'unsupported');
  const sourceDocumentKind = docs.length === 1 ? filingDocumentValue(snapshot, docs[0]!, 'kind') : null;
  const [attachmentId, setAttachmentId] = useState('');
  const [confirmation, setConfirmation] = useState(() => typeof hint?.confirmation === 'string' ? hint.confirmation : '');
  const [kind, setKind] = useState<'voucher' | 'payment_proof' | ''>(() =>
    sourceDocumentKind === 'voucher' || sourceDocumentKind === 'payment_proof' ? sourceDocumentKind : '');
  const selectedAttachment = eligiblePdfs.find((attachment) => attachment.sourceRef === attachmentId);
  const validConfirmation = /^\d+-\d+$/u.test(confirmation.trim());
  const canConfigure = Boolean(request.supported && selectedAttachment && validConfirmation
    && (kind === 'voucher' || kind === 'payment_proof'));
  const originalConfigurationKey = JSON.stringify(['', typeof hint?.confirmation === 'string' ? hint.confirmation.trim() : '',
    sourceDocumentKind === 'voucher' || sourceDocumentKind === 'payment_proof' ? sourceDocumentKind : '']);
  const currentConfigurationKey = JSON.stringify([attachmentId, confirmation.trim(), kind]);
  const [savedConfigurationKey, setSavedConfigurationKey] = useState<string | null>(null);
  const configurationCurrent = currentConfigurationKey === originalConfigurationKey || currentConfigurationKey === savedConfigurationKey;
  const canLookup = request.supported && configurationCurrent && isFilingReadyForLookup(snapshot, request);

  return <>
    <div className={styles.sectionHeader}><div><h2>File an admitted PDF to an existing stay</h2>
      <p>Choose the email PDF and exact confirmation if prefill missed them. Lookup is read-only, Prepare does not save, and File requires the selected exact stay.</p></div></div>
    <section className={styles.card}>
      <div className={styles.cardTitle}><b>PDF and existing confirmation</b><small>Selected email · no native write</small></div>
      <div className={styles.field}>
        <div className={styles.labelRow}><label htmlFor="filing-source-attachment">PDF attachment</label></div>
        <select id="filing-source-attachment" className={styles.select} value={attachmentId} disabled={props.busy}
          onChange={(event) => setAttachmentId(event.target.value)}>
          <option value="">Choose a PDF from this email</option>
          {eligiblePdfs.map((attachment) => <option key={attachment.sourceRef} value={attachment.sourceRef}>
            {attachment.name}{attachment.uploadability === 'unknown' || attachment.uploadability === 'checking' ? ' · verify on lookup' : ''}
          </option>)}
        </select>
        {!eligiblePdfs.length && <small className={styles.problem}>This email has no eligible PDF attachment. Filing cannot continue with a guessed or demo document.</small>}
      </div>
      <div className={styles.twoCol}>
        <div className={styles.field}>
          <div className={styles.labelRow}><label htmlFor="filing-confirmation">Existing Infor confirmation</label></div>
          <input id="filing-confirmation" className={styles.input} type="text" inputMode="numeric" maxLength={200}
            placeholder="Digits-digits" pattern="[0-9]+-[0-9]+" value={confirmation} disabled={props.busy}
            aria-invalid={confirmation.trim() !== '' && !validConfirmation}
            onChange={(event) => setConfirmation(event.target.value)} />
          {confirmation.trim() !== '' && !validConfirmation && <small className={styles.problem}>Enter the exact confirmation as digits-digits.</small>}
        </div>
        <div className={styles.field}>
          <div className={styles.labelRow}><label htmlFor="filing-document-kind">Document kind</label></div>
          <select id="filing-document-kind" className={styles.select} value={kind} disabled={props.busy}
            onChange={(event) => setKind(event.target.value === 'voucher' || event.target.value === 'payment_proof' ? event.target.value : '')}>
            <option value="">Choose document kind</option><option value="voucher">Voucher</option><option value="payment_proof">Payment proof</option>
          </select>
        </div>
      </div>
      <p className={styles.help}>Saving this selection adds a staff-selected filing document with no extracted file name or description. It preserves extracted document rows, replaces only the active document/target selection, and does not run Lookup or upload anything.</p>
      <button type="button" className={styles.secondaryButton} disabled={props.busy || !canConfigure}
        onClick={() => {
          if (kind !== 'voucher' && kind !== 'payment_proof') return;
          void props.onConfigure({ attachmentId, confirmation: confirmation.trim(), kind }).then((saved) => {
            if (saved) setSavedConfigurationKey(currentConfigurationKey);
          });
        }}>
        Save PDF and confirmation selection
      </button>
      <small className={styles.help}>Next: Lookup, select one exact stay, Lookup again to bind the PDF to that stay, then Prepare and File.</small>
      {!configurationCurrent && <small className={styles.problem}>Save the changed PDF, confirmation, and kind before Lookup or Prepare.</small>}
    </section>
    <div className={styles.twoCol}>
      <button type="button" className={styles.secondaryButton} disabled={props.busy || !canLookup} onClick={props.onLookup}>
        {sourceProof ? 'Lookup selected stay and PDF again' : 'Lookup existing stay and PDF'}
      </button>
      <button type="button" className={styles.secondaryButton} disabled={props.busy || !configurationCurrent || !props.canPrepare} onClick={props.onPrepare}>Prepare PDF in Infor · no save</button>
    </div>
    {docs.length !== 1 && <div className={styles.alert}>The active Filing selection needs exactly one document; currently there are {docs.length}. Choose a PDF above to set the active document. Existing extracted documents remain in the saved draft.</div>}
    {docs.map((document) => {
      const root = `/proposal/content/documents/${encoded(document.id)}`;
      const sourcePath = `${root}/documentSourceRef`;
      const kindPath = `${root}/kind`;
      const handlingPath = `${root}/handling`;
      const documentKind = text(props.editValue(kindPath)) || document.kind;
      const documentHandling = text(props.editValue(handlingPath)) || document.handling;
      return <section className={styles.card} key={document.id}>
        <div className={styles.cardTitle}><b>Source document</b><small>{humanize(documentKind)} · {humanize(documentHandling)}</small></div>
        <FieldShell path={sourcePath} label="Source PDF evidence" field={snapshot.fields[sourcePath]} onOpenEvidence={props.onOpenEvidence}>
          <div className={styles.readValue}>{document.documentSourceRef}</div>
        </FieldShell>
        <FilingReviewControl snapshot={snapshot} path={sourcePath} label="PDF source" value={document.documentSourceRef} busy={props.busy} onDone={props.onDone} />
        <div className={styles.twoCol}>
          <FieldShell path={kindPath} label="Document kind" field={snapshot.fields[kindPath]} onOpenEvidence={props.onOpenEvidence}>
            <select id={kindPath} className={styles.select} value={text(props.editValue(kindPath)) || document.kind} disabled={props.busy} onChange={(event) => {
              props.onStage(kindPath, event.target.value);
              props.onBlur(kindPath);
            }}>
              <option value="voucher">Voucher</option><option value="payment_proof">Payment proof</option>
              <option value="other">Other</option><option value="unclassified">Unclassified</option>
            </select>
          </FieldShell>
          <FieldShell path={handlingPath} label="Requested action" field={snapshot.fields[handlingPath]} onOpenEvidence={props.onOpenEvidence}>
            <select id={handlingPath} className={styles.select} value={text(props.editValue(handlingPath)) || document.handling} disabled={props.busy} onChange={(event) => {
              props.onStage(handlingPath, event.target.value);
              props.onBlur(handlingPath);
            }}>
              <option value="filing_requested">File this document</option><option value="context">Keep as context</option><option value="unclear">Unclear</option>
            </select>
          </FieldShell>
        </div>
        <FilingReviewControl snapshot={snapshot} path={kindPath} label="document kind" value={documentKind} busy={props.busy} onDone={props.onDone} />
        <FilingReviewControl snapshot={snapshot} path={handlingPath} label="filing action" value={documentHandling} busy={props.busy} onDone={props.onDone} />
        {document.requestedName !== null && <>
          <FieldShell path={`${root}/requestedName`} label="Requested file name" field={snapshot.fields[`${root}/requestedName`]} onOpenEvidence={props.onOpenEvidence}>
            <div className={styles.readValue}>{document.requestedName}</div>
          </FieldShell>
          <FilingReviewControl snapshot={snapshot} path={`${root}/requestedName`} label="requested file name" value={document.requestedName} busy={props.busy} onDone={props.onDone} />
        </>}
        {document.requestedDescription !== null && <>
          <FieldShell path={`${root}/requestedDescription`} label="Requested description" field={snapshot.fields[`${root}/requestedDescription`]} onOpenEvidence={props.onOpenEvidence}>
            <div className={styles.readValue}>{document.requestedDescription}</div>
          </FieldShell>
          <FilingReviewControl snapshot={snapshot} path={`${root}/requestedDescription`} label="requested description" value={document.requestedDescription} busy={props.busy} onDone={props.onDone} />
        </>}
        {sourceProof ? <div className={styles.fixedValue}>
          <b>Native lookup verified a source PDF</b><span>{text(proofResult?.documentName)}</span>
          <small>SHA-256 of the admitted source PDF: {text(proofResult?.sha256)}</small>
        </div> : <div className={styles.notice}>Lookup has not yet verified this filing document’s PDF bytes against the selected stay. No upload happens during Lookup.</div>}
      </section>;
    })}
    {source.attachments.length > 0 && <section className={styles.card}>
      <div className={styles.cardTitle}><b>Attachments on selected email</b><small>PDF selected above; native lookup verifies its admitted contents</small></div>
      {source.attachments.map((attachment) => <div className={styles.attachmentBound} key={attachment.sourceRef}>
        <b>{attachment.name}</b><small>{attachment.mimeType ?? 'Unknown file type'} · {attachment.uploadability}</small>
        {props.onOpenAttachment && <button type="button" className={styles.inlineButton} disabled={attachment.uploadability !== 'ready'} onClick={() => props.onOpenAttachment?.(attachment.sourceRef)}>Open attachment</button>}
      </div>)}
    </section>}
    <section className={styles.card}>
      <div className={styles.cardTitle}><b>Exact existing reservation</b><small>One explicit included stay; no excluded targets</small></div>
      {!hint || !targetPath ? <div className={styles.alert}>The saved draft does not contain exactly one explicit stay target. A source-bound target hint is required; no guest-name-only search or new stay is available.</div> : <>
        <div className={styles.twoCol}>
          <div className={styles.fixedValue}><span>Confirmation</span><b>{text(hint.confirmation) || 'Not provided'}</b></div>
          <div className={styles.fixedValue}><span>Booked arrival</span><b>{text(hint.bookedArrival) || 'Not provided'}</b></div>
        </div>
        {hasValue(hint.bookedDeparture) && <div className={styles.fixedValue}><span>Booked departure assertion</span><b>{text(hint.bookedDeparture)}</b></div>}
        {hasValue(hint.guestName) && <div className={styles.fixedValue}><span>Guest-name assertion</span><b>{text(hint.guestName)}</b></div>}
        {!hasValue(hint.confirmation) && <div className={styles.alert}>This native lookup currently searches by a source-bound confirmation (and optional arrival), not by name. Correct the source draft before lookup.</div>}
        {selectedTarget ? <div className={styles.fixedValue}>
          <b>Exact saved stay selected</b><span>{text(selectedTarget.stay.confirmation)} · {text(selectedTarget.stay.arrival)}–{text(selectedTarget.stay.departure)}</span>
          <small>{text(selectedTarget.stay.firstName)} {text(selectedTarget.stay.lastName)} · {text(selectedTarget.stay.status)}</small>
        </div> : selectedRef ? <div className={styles.alert}>The saved selection no longer matches the source-bound confirmation/date assertions. Run Lookup and select an exact current result.</div>
          : <div className={styles.notice}>Select the exact complete stay returned by Lookup. A name match alone is not accepted.</div>}
        {targetPath && hasValue(selectedRef) && targetReview !== 'accepted' && <FilingReviewControl snapshot={snapshot} path={targetPath}
          label="selected existing stay" value={selectedRef} busy={props.busy} onDone={props.onDone} />}
        {candidates.map(({ observation, stay, matches }) => <div className={styles.candidateOption} key={observation.ref}>
          <span><b>{text(stay.confirmation)} · {text(stay.arrival)}–{text(stay.departure)}</b>
            <small>{text(stay.firstName)} {text(stay.lastName)} · {text(stay.status)} · observation {observation.ref}</small></span>
          {matches ? <button type="button" className={styles.inlineButton} disabled={props.busy} onClick={() => {
            props.onStage(targetPath!, observation.ref);
            props.onBlur(targetPath!);
          }}>{selectedRef === observation.ref ? 'Selected' : 'Select exact stay'}</button>
            : <small className={styles.problem}>Does not match all populated confirmation/date/name assertions.</small>}
        </div>)}
      </>}
    </section>
    {filingResults.length > 0 && <section className={styles.card}>
      <div className={styles.cardTitle}><b>Filing receipts</b><small>Source-bound native outcomes</small></div>
      {filingResults.map((operation, index) => {
        const observation = filingObservationResult(snapshot, operation);
        const result = record(observation?.result);
        const target = record(result?.target) ?? record(result?.nativeReadback);
        const status = text(operation.status) || 'unknown';
        return <div className={styles.fixedValue} key={text(operation.id) || index}>
          <b>{status === 'prepared' ? 'Prepared only · no save performed' : status === 'succeeded' ? 'Uploaded and verified by fresh Infor listing/readback' : `Filing ${humanize(status)}`}</b>
          {hasValue(target?.confirmation) && <span>Confirmation {text(target?.confirmation)}</span>}
          {hasValue(result?.documentCode) && <span>Infor document code {text(result?.documentCode)}</span>}
          {hasValue(result?.documentName) && <span>{text(result?.documentName)}</span>}
          {hasValue(result?.sourcePdfSha256 ?? result?.sha256) && <small>Source PDF SHA-256: {text(result?.sourcePdfSha256 ?? result?.sha256)}</small>}
          {status === 'succeeded' && result?.storedBytesHashVerified === false && result.actualStoredSha256 === null
            && <small>HMS does not expose stored bytes to this reader; the uploaded bytes’ hash was not verified.</small>}
          {status === 'unknown' && <small>Do not retry. Reconcile this saved operation first.</small>}
        </div>;
      })}
      {savedReceipt && <div className={styles.notice}>The saved Infor record cannot be undone by changing this email draft.</div>}
    </section>}
    <div className={styles.twoCol}>
      <button type="button" className={styles.goButton} disabled={props.busy || !configurationCurrent || !props.canFile || savedReceipt} onClick={props.onFile}>File verified PDF to Infor</button>
    </div>
    {!props.canFile && <small className={styles.help}>File is enabled only after one source PDF and one exact stay are verified, all required facts are confirmed, and the current form is prepared.</small>}
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
