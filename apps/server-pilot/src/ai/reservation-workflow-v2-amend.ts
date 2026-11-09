import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { mailboxAccess, mailThread, message } from '../db/schema/mail.js';
import { workEvent, workItem } from '../db/schema/work.js';
import { CENTURION_HMS_READ_TARGET, type HmsReadTarget } from '../hms/hms-read-target.js';
import { acquisitionWithin, PANE_PROPERTY_LOCK_WAIT_MS, isPropertyReadLockDeadline } from '../hms/property-read-lock.js';
import {
  reservationWorkflowV2DraftSchema,
  type ReservationWorkflowV2Draft,
  type ReservationWorkflowV2Observation,
  type ReservationWorkflowV2LookupInput,
  type ReservationWorkflowV2PrepareInput,
  type ReservationWorkflowV2ExecuteInput,
  type ReservationWorkflowV2ReconcileInput,
} from './reservation-workflow-v2-contract.js';
import {
  appendReservationWorkflowV2Observation,
  getReservationWorkflowV2Draft,
  recordReservationWorkflowV2Result,
  reservationWorkflowV2DraftOf,
  RESERVATION_WORKFLOW_V2_STATE_KEY,
  type ReservationNativeCheckBatch,
  type ReservationWorkflowV2Context,
} from './reservation-workflow-v2-state.js';
import { canonicalJson } from './draft-approval.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import { paneStayCloudTargetLock, paneStayPropertyLock } from './pane-stay-save.js';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';
import { searchGuest } from './pane-stay-lookup.js';
import { projectCloudStayFind, runCloudStayFind, type HmsCloudNativePreimage } from './hms-cloud-saved-stay-find.js';
import { hmsDispatchTargetKey, hmsDispatchTargetSchema } from './hms-dispatch-target.js';
import {
  captureHmsLabtestDispatchEpoch,
  claimHmsLabtestDispatch,
  resolveHmsLabtestDispatch,
  type HmsLabtestWriteHandle,
} from './hms-labtest-dispatch.js';
import { labtestAmendWorkerEnabled } from './pane-cloud-amend-readiness.js';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistHmsShots, verifyStoredHmsShot } from './hms-shots-store.js';
import { lockCreateActorSession } from './pane-create-actor-lock.js';

export type ReservationWorkflowV2AmendContext = {
  db: DB;
  transport: { id: string };
  user: { id: string; sessionId?: string; sessionProfile?: 'legacy' | 'remote' };
  property: { propertyCode: string };
  nativeBatch?: ReservationNativeCheckBatch;
};

type Input = ReservationWorkflowV2LookupInput | ReservationWorkflowV2PrepareInput |
  ReservationWorkflowV2ExecuteInput | ReservationWorkflowV2ReconcileInput;
type Outcome = { status: string; issue?: string; [key: string]: unknown };
type Amendment = {
  arrival?: string; departure?: string; adults?: number; children?: number; childAges?: number[];
  roomType?: string; ratePlan: string; retainRates: 'yes' | 'no'; firstName?: string; lastName?: string;
  guestEmail?: string; bookerName?: string; bookerContact?: string;
  cmsSend: boolean; cmsMessageId: string; cmsRecipient: string;
};
type Compile = { outcome: 'ok'; requestId: string; hintId: string; selectionPath: string; selectedRef: string;
  selected: HmsCloudNativePreimage; baseChanges: Record<string, unknown>; rateHandling: 'retain' | 'reprice';
  reviewPaths: string[]; baseDigest: string; target: Record<string, unknown>; requestPath: string } |
  { outcome: 'needs_input' | 'needs_review' | 'unsupported'; issue: string; fields?: string[] };
type V2StateContext = ReservationWorkflowV2Context;
type WriteTx = Parameters<Parameters<DB['transaction']>[0]>[0];

const NONE = Symbol('none');
const UNKNOWN = Symbol('unknown');
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const ptr = (...parts: Array<string | number>) => `/${parts.map((part) => encodeURIComponent(String(part))).join('/')}`;
const code = (value: unknown) => typeof value === 'string' && /^[A-Z0-9]{1,12}$/.test(value);
const realDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const sameName = (left: unknown, right: unknown) => typeof left === 'string' && typeof right === 'string' &&
  left.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase() ===
  right.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();

function stateContext(ctx: ReservationWorkflowV2AmendContext): V2StateContext {
  return { db: ctx.db, transportId: ctx.transport.id, userId: ctx.nativeBatch ? null : ctx.user.id,
    propertyCode: ctx.property.propertyCode, nativeBatch: ctx.nativeBatch };
}

async function currentDraft(ctx: ReservationWorkflowV2AmendContext, input: Input) {
  const result = await getReservationWorkflowV2Draft(stateContext(ctx), input);
  if (result.status !== 'ok') return { result, draft: null } as const;
  if (result.revision !== input.expectedRevision || result.seq !== input.expectedSeq ||
      result.draft.revision !== input.expectedRevision || result.draft.propertyCode !== ctx.property.propertyCode ||
      result.draft.transportId !== ctx.transport.id) {
    return { result: { status: 'stale_revision' }, draft: null } as const;
  }
  return { result, draft: reservationWorkflowV2DraftSchema.parse(result.draft) } as const;
}

function effectiveLeaf(draft: ReservationWorkflowV2Draft, path: string, source: unknown): unknown {
  const override = draft.fieldOverrides[path];
  if (override) {
    if (override.state === 'unknown') return UNKNOWN;
    if (override.state === 'set') return override.value;
    if (override.state === 'none' || override.state === 'clear') return NONE;
    if (override.state === 'inherit') return source && typeof source === 'object' && !Array.isArray(source) &&
      (source as { kind?: unknown }).kind === 'none' ? NONE : source;
  }
  if (source && typeof source === 'object' && !Array.isArray(source) &&
      (source as { kind?: unknown }).kind === 'none') return NONE;
  return source;
}

function effectiveTree(draft: ReservationWorkflowV2Draft, path: string, source: unknown, unknownPaths: Set<string>): unknown {
  const resolved = effectiveLeaf(draft, path, source);
  if (resolved === UNKNOWN) { unknownPaths.add(path); return undefined; }
  if (resolved === NONE) return NONE;
  if (Array.isArray(resolved)) return resolved.map((value, index) => effectiveTree(draft, `${path}/${index}`, value, unknownPaths));
  if (resolved && typeof resolved === 'object') {
    const sourceRecord = resolved as Record<string, unknown>;
    const keys = new Set(Object.keys(sourceRecord));
    const prefix = `${path}/`;
    for (const overridePath of Object.keys(draft.fieldOverrides)) {
      if (!overridePath.startsWith(prefix)) continue;
      const child = overridePath.slice(prefix.length).split('/')[0];
      if (!child) continue;
      try { keys.add(decodeURIComponent(child)); } catch { /* Invalid paths are rejected at mutation. */ }
    }
    return Object.fromEntries([...keys].map((key) =>
      [key, effectiveTree(draft, `${path}/${encodeURIComponent(key)}`, sourceRecord[key], unknownPaths)]));
  }
  return resolved;
}

function accepted(draft: ReservationWorkflowV2Draft, path: string): boolean {
  return draft.fieldReviewRequirements[path]?.required === false || draft.staffReviews[path]?.status === 'accepted';
}

function addDays(value: string, days: number): string | null {
  if (!realDate(value) || !Number.isSafeInteger(days) || Math.abs(days) > 3660) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  const result = date.toISOString().slice(0, 10);
  return realDate(result) ? result : null;
}

function targetRows(body: Record<string, unknown>) {
  const targets = record(body.targets);
  return { targets, include: Array.isArray(targets?.include) ? targets.include : [],
    mode: targets?.mode, exclude: Array.isArray(targets?.exclude) ? targets.exclude : [] };
}

function validNative(value: unknown): value is HmsCloudNativePreimage {
  const native = record(value);
  return Boolean(native && native.source === 'record_view_ext_model' && native.propertyCode === 'HRCEN' &&
    native.status === 'Reserved' && /^\d{6,10}-\d{1,2}$/.test(String(native.confirmation ?? '')) &&
    /^\d+$/.test(String(native.reservationStayId ?? '')) && /^\d+$/.test(String(native.reservationId ?? '')) &&
    /^\d+$/.test(String(native.recordId ?? '')) && /^\d+$/.test(String(native.guestId ?? '')) &&
    typeof native.firstName === 'string' && native.firstName.trim() && typeof native.lastName === 'string' && native.lastName.trim() &&
    realDate(native.arrival) && realDate(native.departure) && native.arrival < native.departure &&
    code(native.roomType) && code(native.ratePlan) && Number.isInteger(native.adults) && Number(native.adults) >= 1 &&
    Number(native.adults) <= 16 && Number.isInteger(native.children) && Number(native.children) >= 0 &&
    Number(native.children) <= 9 && (native.childAges === 'unknown' || (Array.isArray(native.childAges) &&
      native.childAges.length === native.children && native.childAges.every((age) => Number.isInteger(age) && age >= 0 && age <= 17))));
}

function validateHintAgainstNative(hint: Record<string, unknown>, native: HmsCloudNativePreimage): string | null {
  if (hint.confirmation !== undefined && hint.confirmation !== native.confirmation) return 'confirmation_hint_mismatch';
  if (hint.bookedArrival !== undefined && hint.bookedArrival !== native.arrival) return 'booked_arrival_hint_mismatch';
  if (hint.bookedDeparture !== undefined && hint.bookedDeparture !== native.departure) return 'booked_departure_hint_mismatch';
  const name = text(hint.guestName);
  if (name) {
    const nativeName = `${native.firstName} ${native.lastName}`;
    if (name.includes(' ') ? !sameName(name, nativeName) : !sameName(name, native.lastName)) return 'guest_name_hint_mismatch';
  }
  return null;
}

function observationForStay(draft: ReservationWorkflowV2Draft, requestId: string, hintId: string,
  selectionPath: string, query: Record<string, unknown>, native: HmsCloudNativePreimage,
  status: 'complete' | 'partial' = 'complete', note?: string): ReservationWorkflowV2Observation {
  return { ref: randomUUID(), generationId: draft.generationId, kind: 'stay_candidate', status,
    observedAt: new Date().toISOString(), propertyCode: 'HRCEN', sourceMessageId: draft.source.messageId, sourceRefs: [],
    criteria: { workflow: 'amend', kind: 'saved_target', requestId, hintId, selectionPath, query },
    coverage: { complete: status === 'complete', notes: note ? [note] : [] },
    result: { candidate: native, nativeStayId: native.reservationStayId, confirmation: native.confirmation } };
}

function failedStayObservation(draft: ReservationWorkflowV2Draft, requestId: string, hintId: string,
  selectionPath: string, query: Record<string, unknown>, issue: string): ReservationWorkflowV2Observation {
  return { ref: randomUUID(), generationId: draft.generationId, kind: 'stay_candidate', status: 'partial',
    observedAt: new Date().toISOString(), propertyCode: 'HRCEN', sourceMessageId: draft.source.messageId, sourceRefs: [],
    criteria: { workflow: 'amend', kind: 'saved_target', requestId, hintId, selectionPath, query },
    coverage: { complete: false, notes: [issue] }, result: { outcome: 'unverified', issue } };
}

function propertyTarget(ctx: ReservationWorkflowV2AmendContext): HmsReadTarget | null {
  if (ctx.property.propertyCode !== 'HRCEN') return null;
  const resolved = paneStayHmsTargetForTransport(ctx.transport.id);
  if (!resolved.ok) return null;
  const keys = ['propertyCode', 'secretId', 'browserSlot', 'origin', 'installationEnvName'] as const;
  return keys.every((key) => resolved.target[key] === CENTURION_HMS_READ_TARGET[key]) ? resolved.target : null;
}

async function readCandidate(target: HmsReadTarget, confirmation: string,
  arrival?: string, signal?: AbortSignal) {
  const lock = paneStayPropertyLock(target);
  if (!lock) return null;
  try {
    return await lock.withLock(async () => {
      const request = { confirmation, ...(arrival ? { arrival } : {}) };
      const timeout = AbortSignal.timeout(5 * 60_000);
      const raw = await runCloudStayFind({ request, target, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      return projectCloudStayFind(request, raw);
    }, { ...acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS), signal });
  } catch (error) {
    if (isPropertyReadLockDeadline(error)) return null;
    return null;
  }
}

type LookupHintResult = { rows: Array<{ observation: ReservationWorkflowV2Observation; native: HmsCloudNativePreimage }>;
  observation?: ReservationWorkflowV2Observation };

async function lookupHint(draft: ReservationWorkflowV2Draft,
  target: HmsReadTarget, requestId: string, hintId: string, hint: Record<string, unknown>, selectionPath: string,
  signal?: AbortSignal): Promise<LookupHintResult> {
  const query: Record<string, unknown> = {
    confirmation: hint.confirmation ?? null, guestName: hint.guestName ?? null,
    bookedArrival: hint.bookedArrival ?? null, bookedDeparture: hint.bookedDeparture ?? null,
  };
  const rows: Array<{ observation: ReservationWorkflowV2Observation; native: HmsCloudNativePreimage }> = [];
  const confirmation = text(hint.confirmation);
  if (confirmation) {
    if (!/^\d{6,10}-\d{1,2}$/.test(confirmation)) return { rows, observation: failedStayObservation(draft, requestId, hintId, selectionPath, query, 'confirmation_hint_invalid') };
    const found = await readCandidate(target, confirmation, realDate(hint.bookedArrival) ? hint.bookedArrival : undefined, signal);
    const native = record(found)?.nativePreimage;
    const mismatch = validNative(native) ? validateHintAgainstNative(hint, native) : 'native_stay_unverified';
    if (!validNative(native) || mismatch || found?.outcome !== 'found') {
      return { rows, observation: failedStayObservation(draft, requestId, hintId, selectionPath, query, mismatch ?? 'native_stay_unverified') };
    }
    return { rows: [{ observation: observationForStay(draft, requestId, hintId, selectionPath, query, native), native }] };
  }
  const name = text(hint.guestName), arrival = hint.bookedArrival, departure = hint.bookedDeparture;
  if (signal) return { rows, observation: failedStayObservation(draft, requestId, hintId, selectionPath, query,
    'background_guest_stay_reader_unavailable') };
  if (!name || !realDate(arrival) || (departure !== undefined && (!realDate(departure) || departure <= arrival))) {
    return { rows, observation: failedStayObservation(draft, requestId, hintId, selectionPath, query,
      'original_stay_hints_required') };
  }
  const parts = name.trim().split(/\s+/u), lastName = parts.at(-1)!;
  let search: Awaited<ReturnType<typeof searchGuest>>;
  try {
    search = await searchGuest({ lastName, arrival, ...(realDate(departure) ? { departure } : {}) }, {
      target, lock: () => paneStayPropertyLock(target), acquisition: acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS),
    });
  } catch {
    return { rows, observation: failedStayObservation(draft, requestId, hintId, selectionPath, query, 'stay_search_failed') };
  }
  if (search.outcome !== 'ok') return { rows, observation: failedStayObservation(draft, requestId, hintId, selectionPath, query,
    search.outcome === 'ambiguous_capped' ? 'stay_search_ambiguous' : 'stay_search_failed') };
  for (const row of search.rows) {
    if (row.arrival !== arrival || (realDate(departure) && row.departure !== departure)) continue;
    const found = await readCandidate(target, row.confirmation, row.arrival ?? undefined);
    const native = record(found)?.nativePreimage;
    const mismatch = validNative(native) ? validateHintAgainstNative(hint, native) : 'native_stay_unverified';
    if (!validNative(native) || mismatch || found?.outcome !== 'found') continue;
    rows.push({ observation: observationForStay(draft, requestId, hintId, selectionPath, query, native), native });
  }
  if (!rows.length) return { rows, observation: failedStayObservation(draft, requestId, hintId, selectionPath, query,
    'no_verified_native_stay_matches_original_hints') };
  return { rows };
}

function requestBody(draft: ReservationWorkflowV2Draft, requestId: string) {
  const request = draft.proposal.content.requests.find((row) => row.id === requestId);
  return request?.kind === 'amend' ? { request, path: ptr('proposal', 'content', 'requests', requestId, 'body') } : null;
}

function selectedStay(draft: ReservationWorkflowV2Draft, requestId: string, hintId: string,
  hint: Record<string, unknown>, hintIndex: number):
  { selected: HmsCloudNativePreimage; ref: string; path: string } | { issue: string; fields?: string[] } {
  const path = ptr('proposal', 'content', 'requests', requestId, 'body', 'targets', 'include', hintIndex, 'suggestedRef');
  const resolved = effectiveLeaf(draft, path, hint.suggestedRef);
  if (resolved === UNKNOWN) return { issue: 'target_selection_unknown', fields: [path] };
  if (resolved === NONE || typeof resolved !== 'string') return { issue: 'native_target_selection_required', fields: [path] };
  const observation = draft.observations.find((item) => item.ref === resolved && item.kind === 'stay_candidate' &&
    item.status === 'complete' && item.generationId === draft.generationId && item.propertyCode === 'HRCEN' &&
    item.criteria.workflow === 'amend' && item.criteria.kind === 'saved_target' && item.criteria.requestId === requestId &&
    item.criteria.hintId === hintId && item.criteria.selectionPath === path);
  const native = record(observation?.result)?.candidate;
  if (!validNative(native) || validateHintAgainstNative(hint, native)) {
    return { issue: 'host_native_target_selection_unverified', fields: [path] };
  }
  return { selected: native, ref: resolved, path };
}

function fieldChanged(current: Record<string, unknown>, field: string, value: unknown) {
  const baselineField = field === 'childCount' ? 'children' : field;
  const before = current[baselineField];
  if (field === 'childAges') return canonicalJson(before) !== canonicalJson(value);
  return before !== value;
}

function compileBase(draft: ReservationWorkflowV2Draft, requestId: string, hintId: string,
  mode: 'prepare' | 'execute'): Compile {
  const found = requestBody(draft, requestId);
  if (!found) return { outcome: 'needs_input', issue: 'amend_request_not_found' };
  const { request, path: requestPath } = found;
  const unknownPaths = new Set<string>();
  const body = effectiveTree(draft, requestPath, request.body, unknownPaths);
  if (unknownPaths.size) return { outcome: 'needs_input', issue: 'amend_value_unknown', fields: [...unknownPaths] };
  const bodyValue = record(body);
  if (!bodyValue) return { outcome: 'needs_input', issue: 'amend_body_unavailable' };
  const scope = targetRows(bodyValue);
  if (!scope.targets || scope.mode !== 'explicit') {
    return { outcome: 'needs_input', issue: 'amend_target_scope_unresolved' };
  }
  const hints = scope.include.map(record).filter((hint): hint is Record<string, unknown> => Boolean(hint));
  const hintIndex = hints.findIndex((hint) => hint.id === hintId);
  if (hintIndex < 0) return { outcome: 'needs_input', issue: 'amend_target_not_included' };
  const hint = hints[hintIndex]!;
  if (scope.exclude.some((value) => record(value)?.id === hintId)) {
    return { outcome: 'needs_input', issue: 'amend_target_excluded' };
  }
  const chosen = selectedStay(draft, requestId, hintId, hint, hintIndex);
  if ('issue' in chosen) return { outcome: 'needs_input', issue: chosen.issue, fields: chosen.fields ?? [] };
  const targetPath = ptr('proposal', 'content', 'requests', requestId, 'body', 'perTarget');
  const perTargetUnknown = new Set<string>();
  const perTargetRoot = effectiveTree(draft, targetPath, request.body.perTarget, perTargetUnknown);
  if (perTargetUnknown.size) return { outcome: 'needs_input', issue: 'amend_target_changes_unknown', fields: [...perTargetUnknown] };
  const perRows = Array.isArray(perTargetRoot) ? perTargetRoot : [];
  const perIndex = perRows.findIndex((row) => record(row)?.hintId === hintId);
  if (perIndex < 0) return { outcome: 'needs_input', issue: 'amend_target_changes_required', fields: [targetPath] };
  const perPath = ptr('proposal', 'content', 'requests', requestId, 'body', 'perTarget', perIndex);
  const ratePath = `${perPath}/rateHandling`;
  const rateValue = effectiveLeaf(draft, ratePath, record(perRows[perIndex])?.rateHandling);
  if (rateValue === UNKNOWN || rateValue === NONE || !['retain', 'reprice'].includes(String(rateValue))) {
    return { outcome: 'needs_input', issue: 'amend_rate_handling_required', fields: [ratePath] };
  }
  const reviewPaths = new Set<string>([chosen.path]);
  if (mode === 'execute' && !accepted(draft, ratePath)) reviewPaths.add(ratePath);
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  const unsupported = new Set<string>();
  const applyChange = (change: unknown, changePath: string) => {
    const item = record(change);
    if (!item) { errors.push(`${changePath}:change_invalid`); return; }
    const opPath = `${changePath}/op`, fieldPath = `${changePath}/field`, valuePath = `${changePath}/value`;
    const op = effectiveLeaf(draft, opPath, item.op);
    if (op === UNKNOWN) { errors.push(`${opPath}:operation_unknown`); return; }
    if (op === NONE) return;
    if (op === 'shift_dates' || op === 'shift_departure') {
      const daysPath = `${changePath}/days`, days = effectiveLeaf(draft, daysPath, item.days);
      if (days === UNKNOWN || days === NONE || !Number.isSafeInteger(days)) { errors.push(`${daysPath}:shift_days_unknown`); return; }
      const shiftedArrival = op === 'shift_dates' ? addDays(String(values.arrival ?? chosen.selected.arrival), Number(days)) : null;
      const shiftedDeparture = addDays(String(values.departure ?? chosen.selected.departure), Number(days));
      if (op === 'shift_dates' && !shiftedArrival || !shiftedDeparture) { errors.push(`${daysPath}:shift_range_invalid`); return; }
      if (op === 'shift_dates') values.arrival = shiftedArrival;
      values.departure = shiftedDeparture;
      reviewPaths.add(daysPath);
      return;
    }
    const field = effectiveLeaf(draft, fieldPath, item.field);
    if (field === UNKNOWN || typeof field !== 'string') { errors.push(`${changePath}:change_unknown`); return; }
    if (['roomTypeForCharge', 'reservationNote'].includes(field)) { unsupported.add(field); return; }
    const supported = new Set(['arrival', 'departure', 'adults', 'childCount', 'childAges', 'roomType', 'ratePlan',
      'firstName', 'lastName', 'guestEmail', 'bookerName', 'bookerContact', 'cmsSend', 'cmsMessageId', 'cmsRecipient']);
    if (!supported.has(field)) { unsupported.add(field); return; }
    if (op === 'clear') {
      if (['guestEmail', 'bookerName', 'bookerContact'].includes(field)) values[field] = '';
      else if (field === 'cmsSend') values.cmsSend = false;
      else if (field === 'cmsMessageId' || field === 'cmsRecipient') values[field] = '';
      else errors.push(`${changePath}:field_cannot_be_cleared`);
      reviewPaths.add(valuePath);
      return;
    }
    if (op !== 'set') { errors.push(`${opPath}:operation_unsupported`); return; }
    const rawValue = effectiveLeaf(draft, valuePath, item.value);
    if (rawValue === UNKNOWN) { errors.push(`${valuePath}:value_unknown`); return; }
    if (rawValue === NONE) {
      if (['guestEmail', 'bookerName', 'bookerContact'].includes(field)) values[field] = '';
      else if (field === 'cmsSend') values.cmsSend = false;
      else errors.push(`${valuePath}:explicit_none_not_supported`);
      reviewPaths.add(valuePath);
      return;
    }
    const valid = field === 'arrival' || field === 'departure' ? realDate(rawValue) :
      field === 'adults' ? Number.isInteger(rawValue) && Number(rawValue) >= 1 && Number(rawValue) <= 16 :
      field === 'childCount' ? Number.isInteger(rawValue) && Number(rawValue) >= 0 && Number(rawValue) <= 9 :
      field === 'childAges' ? Array.isArray(rawValue) && rawValue.length <= 9 && rawValue.every((age) => Number.isInteger(age) && age >= 0 && age <= 17) :
      field === 'roomType' || field === 'ratePlan' ? code(rawValue) :
      field === 'cmsSend' ? typeof rawValue === 'boolean' : typeof rawValue === 'string' && rawValue.length <= 1000 && !/[\p{Cc}]/u.test(rawValue);
    if (!valid) { errors.push(`${valuePath}:value_invalid`); return; }
    values[field] = rawValue;
    reviewPaths.add(valuePath);
  };
  const sharedPath = ptr('proposal', 'content', 'requests', requestId, 'body', 'sharedChanges');
  const shared = effectiveLeaf(draft, sharedPath, request.body.sharedChanges);
  if (shared === UNKNOWN) return { outcome: 'needs_input', issue: 'amend_shared_changes_unknown', fields: [sharedPath] };
  if (Array.isArray(shared)) shared.forEach((change, index) => applyChange(change,
    ptr('proposal', 'content', 'requests', requestId, 'body', 'sharedChanges', index)));
  const targetChanges = record(perRows[perIndex])?.changes;
  const changesPath = `${perPath}/changes`;
  const effectiveChanges = effectiveLeaf(draft, changesPath, targetChanges);
  if (effectiveChanges === UNKNOWN) return { outcome: 'needs_input', issue: 'amend_target_changes_unknown', fields: [changesPath] };
  if (!Array.isArray(effectiveChanges)) return { outcome: 'needs_input', issue: 'amend_target_changes_required', fields: [changesPath] };
  effectiveChanges.forEach((change, index) => applyChange(change, `${changesPath}/${index}`));
  if (unsupported.size) return { outcome: 'unsupported', issue: 'amend_contains_native_unsupported_field', fields: [...unsupported] };
  if (errors.length) return { outcome: 'needs_input', issue: 'amend_changes_invalid_or_unknown', fields: errors };
  if (mode === 'execute') {
    const pending = [...reviewPaths].filter((path) => !accepted(draft, path));
    if (pending.length) return { outcome: 'needs_review', issue: 'amend_requires_staff_acceptance', fields: pending };
  }
  const current = chosen.selected as unknown as Record<string, unknown>;
  const baseChanges: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(values)) {
    if (field === 'childCount') baseChanges.children = value;
    else baseChanges[field] = value;
  }
  if (baseChanges.childAges !== undefined && baseChanges.children === undefined) baseChanges.children = (baseChanges.childAges as unknown[]).length;
  if (baseChanges.children !== undefined && baseChanges.childAges === undefined) {
    if (baseChanges.children === 0) baseChanges.childAges = [];
    else if (baseChanges.children === current.children && Array.isArray(current.childAges)) baseChanges.childAges = current.childAges;
    else return { outcome: 'needs_input', issue: 'child_ages_required_for_occupancy_change', fields: ['childCount', 'childAges'] };
  }
  if (Array.isArray(baseChanges.childAges) && baseChanges.children !== baseChanges.childAges.length) {
    return { outcome: 'needs_input', issue: 'child_ages_count_mismatch', fields: ['childCount', 'childAges'] };
  }
  if (baseChanges.arrival !== undefined && !realDate(baseChanges.arrival) ||
      baseChanges.departure !== undefined && !realDate(baseChanges.departure)) {
    return { outcome: 'needs_input', issue: 'amend_date_invalid', fields: ['arrival', 'departure'] };
  }
  const next = { ...current, ...baseChanges };
  if (typeof next.arrival !== 'string' || typeof next.departure !== 'string' || next.arrival >= next.departure) {
    return { outcome: 'needs_input', issue: 'amend_date_range_invalid', fields: ['arrival', 'departure'] };
  }
  if (typeof next.roomType !== 'string' || !code(next.roomType) || typeof next.ratePlan !== 'string' || !code(next.ratePlan)) {
    return { outcome: 'needs_input', issue: 'native_room_or_rate_baseline_invalid', fields: ['roomType', 'ratePlan'] };
  }
  const pricingChanged = ['arrival', 'departure', 'adults', 'children', 'childAges', 'roomType', 'ratePlan']
    .some((field) => fieldChanged(current, field, next[field]));
  if (rateValue === 'retain' && pricingChanged) {
    return { outcome: 'unsupported', issue: 'retained_rate_not_supported_for_priced_amendment', fields: ['rateHandling'] };
  }
  const target = { confirmation: current.confirmation, nativeStayId: current.reservationStayId,
    arrival: next.arrival, departure: next.departure, roomType: next.roomType, ratePlan: next.ratePlan,
    adults: next.adults, children: next.children, childAges: next.childAges,
    firstName: next.firstName, lastName: next.lastName };
  const baseDigest = sha256({ requestId, hintId, selectedRef: chosen.ref, selected: chosen.selected,
    rateHandling: rateValue, changes: baseChanges, reviewPaths: [...reviewPaths].sort() });
  return { outcome: 'ok', requestId, hintId, selectionPath: chosen.path, selectedRef: chosen.ref,
    selected: chosen.selected, baseChanges, rateHandling: rateValue as 'retain' | 'reprice',
    reviewPaths: [...reviewPaths], baseDigest, target, requestPath };
}

function nativePrice(value: unknown): Record<string, unknown> | null {
  const row = record(value);
  if (!row || row.version !== 2 || typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency) ||
      typeof row.totalCents !== 'string' || !/^\d+$/.test(row.totalCents) ||
      row.averageCents !== null && (typeof row.averageCents !== 'string' || !/^\d+$/.test(row.averageCents))) return null;
  return row;
}

function normalizedChanges(base: Compile & { outcome: 'ok' }, preserved: Record<string, unknown>): Amendment | null {
  if (typeof preserved.cmsSend !== 'boolean' || typeof preserved.cmsRecipient !== 'string') return null;
  const cmsSend = typeof base.baseChanges.cmsSend === 'boolean' ? base.baseChanges.cmsSend : preserved.cmsSend;
  const cmsRecipient = typeof base.baseChanges.cmsRecipient === 'string' ? base.baseChanges.cmsRecipient : preserved.cmsRecipient;
  const cmsMessageId = typeof base.baseChanges.cmsMessageId === 'string'
    ? base.baseChanges.cmsMessageId : typeof preserved.cmsMessageId === 'string' ? preserved.cmsMessageId : '';
  if (!cmsSend && ((base.baseChanges.cmsRecipient !== undefined && base.baseChanges.cmsRecipient !== preserved.cmsRecipient) ||
      (base.baseChanges.cmsMessageId !== undefined && base.baseChanges.cmsMessageId !== preserved.cmsMessageId)) ||
      cmsSend && (!cmsMessageId.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cmsRecipient))) return null;
  return { ...base.baseChanges, ratePlan: String(base.baseChanges.ratePlan ?? base.selected.ratePlan),
    retainRates: base.rateHandling === 'retain' ? 'yes' : 'no', cmsSend, cmsMessageId, cmsRecipient } as Amendment;
}

function nativeModule() {
  const url = new URL('../../tooling/hms-cloud/pane-amend-session.mjs', import.meta.url);
  return import(url.href) as Promise<{
    prepareCloudPaneAmend(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    commitCloudPaneAmend(input: Record<string, unknown>, authorization: Record<string, unknown>): Promise<Record<string, unknown>>;
  }>;
}

async function persistAmendShot(ctx: ReservationWorkflowV2AmendContext, workItemId: string,
  runId: string, sourcePath: string, name: 'before.png' | 'saved.png') {
  const stage = await mkdtemp(join(tmpdir(), 'reservation-v2-amend-shot-'));
  try {
    await copyFile(sourcePath, join(stage, name));
    const owner = `${ctx.user.id}:${ctx.transport.id}`;
    const shots = await persistHmsShots({ propertyCode: 'HRCEN', workItemId, runId,
      sourceDir: stage, owner, now: Date.now() });
    const shot = shots?.find((candidate) => candidate.name === name);
    if (!shot || !await verifyStoredHmsShot({ runId, name, sha256: shot.sha256, owner,
      propertyCode: 'HRCEN', workItemId }, name)) return null;
    return { runId, sha256: shot.sha256 };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

function targetWriteLock(ctx: ReservationWorkflowV2AmendContext, selected: HmsCloudNativePreimage) {
  const target = propertyTarget(ctx);
  const targetRef = hmsDispatchTargetSchema.safeParse({ propertyCode: 'HRCEN', kind: 'saved',
    confirmation: selected.confirmation, nativeStayId: selected.reservationStayId });
  if (!target || !targetRef.success) return null;
  return { target, dispatchTarget: targetRef.data,
    lock: paneStayCloudTargetLock(target, targetRef.data, { kind: 'independent_cloud' }) };
}

function preparationObservation(draft: ReservationWorkflowV2Draft, compiled: Compile & { outcome: 'ok' },
  native: Record<string, unknown>, changes: Amendment, preserved: Record<string, unknown>, price: Record<string, unknown>,
  recoveryBaseline: Record<string, unknown>, semanticDigest: string): ReservationWorkflowV2Observation {
  return { ref: randomUUID(), generationId: draft.generationId, kind: 'rate_availability', status: 'complete',
    observedAt: new Date().toISOString(), propertyCode: 'HRCEN', sourceMessageId: draft.source.messageId, sourceRefs: [],
    criteria: { workflow: 'amend', requestId: compiled.requestId, hintId: compiled.hintId, selectedRef: compiled.selectedRef,
      draftRevision: draft.revision, baseDigest: compiled.baseDigest, semanticDigest,
      nativeDigest: native.nativeDigest },
    coverage: { complete: true, notes: [] },
    result: { outcome: 'prepared', before: compiled.selected, target: compiled.target, nativeChanges: changes,
      nativeDigest: native.nativeDigest, approvedPrices: price, preserved, recoveryBaseline,
      semanticInput: { requestId: compiled.requestId, hintId: compiled.hintId, selectedRef: compiled.selectedRef,
        selected: compiled.selected, baseChanges: compiled.baseChanges, rateHandling: compiled.rateHandling,
        changes, target: compiled.target } } };
}

async function recordObservation(ctx: ReservationWorkflowV2AmendContext, input: Input,
  observation: ReservationWorkflowV2Observation, status: 'prepared' | 'failed' | 'unknown', summary: string,
  operationId = randomUUID(), hintId: string | null = null) {
  const base = { workItemId: input.workItemId, source: input.source };
  const appended = await appendReservationWorkflowV2Observation(stateContext(ctx), { ...base, observation });
  if (appended.status !== 'ok') return appended;
  return recordReservationWorkflowV2Result(stateContext(ctx), { ...base, result: {
    id: operationId, generationId: observation.generationId, requestId: String(observation.criteria.requestId ?? ''),
    allocationId: hintId, workflow: 'amend', status, draftRevision: input.expectedRevision,
    observationRefs: [observation.ref], updatedAt: new Date().toISOString(), summary,
  } });
}

function preparedObservation(draft: ReservationWorkflowV2Draft, compiled: Compile & { outcome: 'ok' }) {
  const rows = draft.observations.filter((observation) => observation.kind === 'rate_availability' &&
    observation.status === 'complete' && observation.generationId === draft.generationId && observation.criteria.workflow === 'amend' &&
    observation.criteria.requestId === compiled.requestId && observation.criteria.hintId === compiled.hintId &&
    observation.criteria.selectedRef === compiled.selectedRef && observation.criteria.baseDigest === compiled.baseDigest);
  return rows.at(-1) ?? null;
}

export async function reservationWorkflowV2AmendLookup(ctx: ReservationWorkflowV2AmendContext,
  input: ReservationWorkflowV2LookupInput): Promise<Outcome> {
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return loaded.result;
  if (ctx.property.propertyCode !== 'HRCEN') return { status: 'unsupported', issue: 'property_not_supported' };
  const requests = loaded.draft.proposal.content.requests.filter((request) =>
    request.kind === 'amend' && (!input.requestId || request.id === input.requestId));
  if (input.requestId && !requests.length) return { status: 'not_found' };
  if (!requests.length) return { status: 'unsupported', issue: 'amend_lookup_not_applicable' };
  const target = propertyTarget(ctx);
  if (!target) return { status: 'unsupported', issue: 'amend_property_session_unavailable' };
  const observations: ReservationWorkflowV2Observation[] = [];
  const lookups: Array<Record<string, unknown>> = [];
  for (const request of requests) {
    const bodyPath = ptr('proposal', 'content', 'requests', request.id, 'body');
    const unknownPaths = new Set<string>();
    const body = record(effectiveLeaf(loaded.draft, bodyPath, request.body));
    const targetsPath = `${bodyPath}/targets`;
    const targets = record(effectiveLeaf(loaded.draft, targetsPath, body?.targets));
    const mode = effectiveTree(loaded.draft, `${targetsPath}/mode`, targets?.mode, unknownPaths);
    const includePath = `${targetsPath}/include`;
    const include = effectiveLeaf(loaded.draft, includePath, targets?.include);
    const exclude = effectiveTree(loaded.draft, `${targetsPath}/exclude`, targets?.exclude, unknownPaths);
    if (!body || !targets || include === UNKNOWN || unknownPaths.size) {
      lookups.push({ requestId: request.id, status: 'needs_input', issue: 'amend_target_hints_unknown', fields: [...unknownPaths] });
      continue;
    }
    if ((mode !== 'explicit' && mode !== 'unresolved') || !Array.isArray(include) || !include.length || !Array.isArray(exclude)) {
      lookups.push({ requestId: request.id, status: 'needs_input', issue: 'amend_target_scope_unresolved' });
      continue;
    }
    for (const [index, value] of include.entries()) {
      const hintPath = `${includePath}/${index}`;
      const rawHint = record(effectiveLeaf(loaded.draft, hintPath, value));
      const hintUnknownPaths = new Set<string>();
      // Lookup consumes identity hints only. Candidate refs and change/pricing decisions
      // belong to later stages and must not prevent read-only native discovery.
      const hint = rawHint && Object.fromEntries(['id', 'confirmation', 'guestName', 'bookedArrival', 'bookedDeparture'].map((key) =>
        [key, effectiveTree(loaded.draft, `${hintPath}/${key}`, rawHint[key], hintUnknownPaths)]));
      const hintId = text(hint?.id);
      if (!hint || !hintId) { lookups.push({ requestId: request.id, status: 'needs_input', issue: 'saved_target_hint_invalid' }); continue; }
      if (exclude.some((excluded) => record(excluded)?.id === hintId)) {
        lookups.push({ requestId: request.id, hintId, status: 'excluded' });
        continue;
      }
      if (hintUnknownPaths.size) {
        lookups.push({ requestId: request.id, hintId, status: 'needs_input', issue: 'amend_target_hints_unknown', fields: [...hintUnknownPaths] });
        continue;
      }
      const selectionPath = ptr('proposal', 'content', 'requests', request.id, 'body', 'targets', 'include', index, 'suggestedRef');
      const result = await lookupHint(loaded.draft, target, request.id, hintId, hint, selectionPath, ctx.nativeBatch?.signal);
      observations.push(...result.rows.map((row) => row.observation));
      if (result.observation) observations.push(result.observation);
      lookups.push({ requestId: request.id, hintId, status: result.rows.length ? 'matches' : 'partial',
        ...(result.observation ? { issue: result.observation.result.issue } : {}),
        selectionPath, candidates: result.rows.map(({ observation, native }) => ({ ref: observation.ref,
          confirmation: native.confirmation, guestName: `${native.firstName} ${native.lastName}`,
          bookedArrival: native.arrival, bookedDeparture: native.departure,
          roomType: native.roomType, ratePlan: native.ratePlan })) });
    }
  }
  const fresh = await currentDraft(ctx, input);
  if (!fresh.draft) return fresh.result;
  for (const observation of observations) {
    const appended = await appendReservationWorkflowV2Observation(stateContext(ctx), { workItemId: input.workItemId,
      source: input.source, observation });
    if (appended.status !== 'ok') return appended;
  }
  return { status: 'ok', revision: fresh.result.status === 'ok' ? fresh.result.revision : input.expectedRevision,
    seq: fresh.result.status === 'ok' ? fresh.result.seq : input.expectedSeq, requests, lookups, observations,
    operationResults: fresh.draft.operationResults };
}

export async function reservationWorkflowV2AmendPrepare(ctx: ReservationWorkflowV2AmendContext,
  input: ReservationWorkflowV2PrepareInput): Promise<Outcome> {
  if (!input.allocationId) return { status: 'needs_input', issue: 'amend_target_required' };
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return loaded.result;
  const compiled = compileBase(loaded.draft, input.requestId, input.allocationId, 'prepare');
  if (compiled.outcome !== 'ok') return { status: compiled.outcome, issue: compiled.issue, fields: compiled.fields ?? [] };
  if (typeof compiled.target.children === 'number' && compiled.target.children > 0 &&
      !Array.isArray(compiled.target.childAges)) {
    return { status: 'needs_input', issue: 'amend_child_age_baseline_unavailable', fields: ['childAges'] };
  }
  const locked = targetWriteLock(ctx, compiled.selected);
  if (!locked?.lock) return { status: 'unsupported', issue: 'amend_target_lock_unavailable' };
  const module = await nativeModule();
  const dispatchKey = hmsDispatchTargetKey(locked.dispatchTarget);
  const discoveryChanges = { ...compiled.baseChanges, ratePlan: String(compiled.baseChanges.ratePlan ?? compiled.selected.ratePlan),
    retainRates: compiled.rateHandling === 'retain' ? 'yes' : 'no', cmsSend: false, cmsMessageId: '', cmsRecipient: '' };
  try {
    const prepared = await locked.lock.withLock(async () => {
      ctx.nativeBatch?.signal.throwIfAborted();
      const discovery = await module.prepareCloudPaneAmend({ target: locked.target, selected: compiled.selected,
        confirmation: compiled.selected.confirmation, arrival: compiled.selected.arrival, changes: discoveryChanges,
        allowRealGuest: true, cloudTargetKey: dispatchKey, signal: ctx.nativeBatch?.signal ?? AbortSignal.timeout(8 * 60_000) });
      const discoveryBaseline = record(discovery.recoveryBaseline);
      if (discovery.outcome !== 'prepared' || !record(discovery.preserved) || !discoveryBaseline) {
        return { issue: 'native_amend_baseline_unavailable' };
      }
      const preserved = record(discovery.preserved)!;
      const changes = normalizedChanges(compiled, preserved);
      if (!changes) return { issue: 'native_amend_cms_baseline_unavailable' };
      const native = await module.prepareCloudPaneAmend({ target: locked.target, selected: compiled.selected,
        confirmation: compiled.selected.confirmation, arrival: compiled.selected.arrival, changes,
        allowRealGuest: true, cloudTargetKey: dispatchKey, signal: ctx.nativeBatch?.signal ?? AbortSignal.timeout(8 * 60_000) });
      const price = nativePrice(native.approvedPrices), afterPreserved = record(native.preserved),
        recoveryBaseline = record(native.recoveryBaseline);
      if (native.outcome !== 'prepared' || typeof native.nativeDigest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(native.nativeDigest) || !price || !afterPreserved ||
          !recoveryBaseline || typeof recoveryBaseline.beforeNote !== 'string' || recoveryBaseline.beforeNote.length > 2000 ||
          !record(recoveryBaseline.beforeParties) || typeof recoveryBaseline.beforeRecipient !== 'string' ||
          !(typeof recoveryBaseline.beforeGuestEmail === 'string' || recoveryBaseline.beforeGuestEmail === null) ||
          !(typeof recoveryBaseline.beforeBookerName === 'string' || recoveryBaseline.beforeBookerName === null) ||
          !(typeof recoveryBaseline.beforeBookerContact === 'string' || recoveryBaseline.beforeBookerContact === null) ||
          (!Object.hasOwn(changes, 'guestEmail') && typeof recoveryBaseline.beforeGuestEmail !== 'string') ||
          (!Object.hasOwn(changes, 'bookerName') && typeof recoveryBaseline.beforeBookerName !== 'string') ||
          (!Object.hasOwn(changes, 'bookerContact') && typeof recoveryBaseline.beforeBookerContact !== 'string') ||
          (!changes.cmsSend && typeof afterPreserved.cmsMessageId !== 'string') ||
          typeof recoveryBaseline.beforeGuaranteeCode !== 'string' ||
          !/^[A-Z0-9]{1,40}$/.test(recoveryBaseline.beforeGuaranteeCode) ||
          !(recoveryBaseline.beforeSavedRates === null || record(recoveryBaseline.beforeSavedRates)) ||
          canonicalJson(afterPreserved) !== canonicalJson(preserved) ||
          canonicalJson(recoveryBaseline) !== canonicalJson(discoveryBaseline)) return { issue: 'native_amend_prepare_unverified' };
      const semanticDigest = sha256({ baseDigest: compiled.baseDigest, selectedRef: compiled.selectedRef,
        selected: compiled.selected, target: compiled.target, changes, preserved, recoveryBaseline,
        nativeDigest: native.nativeDigest, price });
      return { observation: preparationObservation(loaded.draft!, compiled, native, changes, preserved, price,
        recoveryBaseline, semanticDigest), changes, preserved, price, recoveryBaseline, semanticDigest, nativeDigest: native.nativeDigest };
    }, { ...acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS), signal: ctx.nativeBatch?.signal });
    if ('issue' in prepared) return { status: 'failed', issue: prepared.issue };
    const recorded = await recordObservation(ctx, input, prepared.observation, 'prepared',
      'HMS amendment staged unsaved; native price and baseline observed', randomUUID(), compiled.hintId);
    if (recorded.status !== 'ok') return recorded;
    return { status: 'prepared', requestId: input.requestId, allocationId: compiled.hintId,
      observationRef: prepared.observation.ref, target: compiled.target, before: compiled.selected,
      price: prepared.price, changes: prepared.changes, semanticDigest: prepared.semanticDigest };
  } catch (error) {
    return { status: 'failed', issue: isPropertyReadLockDeadline(error) ? 'amend_lock_busy' : 'native_amend_prepare_failed' };
  }
}

function observationForWrite(draft: ReservationWorkflowV2Draft, input: ReservationWorkflowV2ExecuteInput,
  hintId: string, status: 'complete' | 'partial' | 'failed', result: Record<string, unknown>) {
  return { ref: randomUUID(), generationId: draft.generationId, kind: 'stay_candidate' as const, status,
    observedAt: new Date().toISOString(), propertyCode: 'HRCEN', sourceMessageId: draft.source.messageId, sourceRefs: [],
    criteria: { workflow: 'amend', requestId: input.requestId, hintId, draftRevision: draft.revision,
      idempotencyKey: input.idempotencyKey },
    coverage: { complete: status === 'complete', notes: status === 'complete' ? [] : [String(record(result)?.issue ?? record(result)?.outcome ?? 'amend_save_unverified')] },
    result } satisfies ReservationWorkflowV2Observation;
}

async function persistResolvedResult(tx: WriteTx, ctx: ReservationWorkflowV2AmendContext, input: ReservationWorkflowV2ExecuteInput,
  hintId: string, observation: ReservationWorkflowV2Observation, summary: string) {
  const [item] = await tx.select({ state: workItem.state, revision: workItem.revision, revisionSeq: workItem.revisionSeq })
    .from(workItem).where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, ctx.transport.id))).limit(1).for('update');
  const draft = item && reservationWorkflowV2DraftOf(item.state as Record<string, unknown>);
  if (!item || !draft || item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq ||
      draft.revision !== input.expectedRevision || draft.source.sourceHash !== input.source.sourceHash ||
      draft.source.messageId !== input.source.messageId || draft.source.threadId !== input.source.threadId ||
      draft.propertyCode !== 'HRCEN' || draft.transportId !== ctx.transport.id) throw new Error('reservation_workflow_v2_amend_result_scope_changed');
  const observations = draft.observations.some((row) => row.ref === observation.ref) ? draft.observations : [...draft.observations, observation];
  const nextResult = { id: input.idempotencyKey, requestId: input.requestId, allocationId: hintId,
    generationId: draft.generationId, workflow: 'amend' as const, status: 'succeeded' as const,
    draftRevision: draft.revision, observationRefs: [observation.ref], updatedAt: new Date().toISOString(), summary };
  const operationResults = [...draft.operationResults.filter((row) => row.id !== input.idempotencyKey), nextResult];
  const nextDraft = reservationWorkflowV2DraftSchema.parse({ ...draft, observations, operationResults });
  await tx.update(workItem).set({ state: { ...(item.state as Record<string, unknown>),
    [RESERVATION_WORKFLOW_V2_STATE_KEY]: nextDraft }, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
  await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
    fieldPath: `${RESERVATION_WORKFLOW_V2_STATE_KEY}:operationResults:${nextResult.id}`,
    value: { id: nextResult.id, requestId: nextResult.requestId, allocationId: hintId, workflow: 'amend',
      status: 'succeeded', observationRefs: nextResult.observationRefs },
    evidence: { sourceHash: input.source.sourceHash, seq: input.expectedSeq, summary } });
}

async function authorizeCurrentAmend(tx: WriteTx, ctx: ReservationWorkflowV2AmendContext,
  input: ReservationWorkflowV2ExecuteInput, compiled: Compile & { outcome: 'ok' }, prepared: ReservationWorkflowV2Observation,
  approvedDigest: string, attempt: ReservationWorkflowV2Observation) {
  const [item] = await tx.select({ state: workItem.state, revision: workItem.revision, revisionSeq: workItem.revisionSeq,
    sourceMessageId: workItem.sourceMessageId, threadId: workItem.threadId })
    .from(workItem).where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, ctx.transport.id))).limit(1).for('update');
  const draft = item && reservationWorkflowV2DraftOf(item.state as Record<string, unknown>);
  if (!item || !draft || item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq ||
      item.sourceMessageId !== input.source.messageId || item.threadId !== input.source.threadId ||
      draft.revision !== input.expectedRevision || draft.propertyCode !== 'HRCEN' || draft.transportId !== ctx.transport.id ||
      draft.source.messageId !== input.source.messageId || draft.source.threadId !== input.source.threadId ||
      draft.source.sourceHash !== input.source.sourceHash || draft.source.arrivedAt !== input.source.arrivedAt ||
      draft.generationId !== attempt.generationId) {
    throw new Error('reservation_workflow_v2_amend_stale');
  }
  const [source] = await tx.select({ id: message.id, threadId: message.threadId, transportId: message.transportId,
    direction: message.direction, historyOnly: message.historyOnly, sourceProvenance: message.sourceProvenance,
    subject: message.subject, textBody: message.textBody, htmlBody: message.htmlBody })
    .from(message).innerJoin(mailThread, and(eq(mailThread.id, message.threadId), eq(mailThread.transportId, message.transportId)))
    .where(and(eq(message.id, input.source.messageId), eq(message.threadId, input.source.threadId),
      eq(message.transportId, ctx.transport.id), eq(message.direction, 'inbound'), eq(message.historyOnly, false),
      eq(mailThread.historyOnly, false), isNull(mailThread.trashedAt), isNull(mailThread.spamAt))).limit(1).for('share');
  const [access] = await tx.select({ id: mailboxAccess.id }).from(mailboxAccess)
    .where(and(eq(mailboxAccess.userId, ctx.user.id), eq(mailboxAccess.transportId, ctx.transport.id))).limit(1).for('share');
  const existing = draft.operationResults.filter((row) => row.id === input.idempotencyKey);
  const retryableFailure = existing.length === 1 && existing[0]!.status === 'failed' &&
    existing[0]!.workflow === 'amend' && existing[0]!.requestId === input.requestId &&
    existing[0]!.allocationId === compiled.hintId;
  const competingOperation = draft.operationResults.some((row) => row.id !== input.idempotencyKey &&
    row.workflow === 'amend' && row.requestId === input.requestId && row.allocationId === compiled.hintId &&
    (row.status === 'succeeded' || row.status === 'unknown'));
  const current = source && staffQuoteSourceHash(source);
  const live = compileBase(draft, input.requestId, compiled.hintId, 'execute');
  const livePrepared = preparedObservation(draft, compiled);
  const attemptResult = record(attempt.result);
  if (!access || !source || source.sourceProvenance?.attention != null || current !== input.source.sourceHash ||
      existing.length > 1 || (existing.length === 1 && !retryableFailure) || competingOperation ||
      live.outcome !== 'ok' || live.baseDigest !== compiled.baseDigest || !livePrepared || livePrepared.ref !== prepared.ref ||
      livePrepared.criteria.semanticDigest !== prepared.criteria.semanticDigest ||
      canonicalJson(livePrepared.result) !== canonicalJson(prepared.result) ||
      livePrepared.criteria.semanticDigest !== approvedDigest || attempt.kind !== 'stay_candidate' ||
      attempt.status !== 'partial' || attempt.criteria.workflow !== 'amend' ||
      attempt.criteria.requestId !== input.requestId || attempt.criteria.hintId !== compiled.hintId ||
      attempt.criteria.idempotencyKey !== input.idempotencyKey || attempt.sourceMessageId !== draft.source.messageId ||
      attemptResult?.outcome !== 'dispatch_pending' || attemptResult.approvedDigest !== approvedDigest ||
      typeof attemptResult.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(attemptResult.requestDigest) ||
      draft.observations.some((row) => row.ref === attempt.ref) ||
      !hmsDispatchTargetSchema.safeParse({ propertyCode: 'HRCEN', kind: 'saved',
        confirmation: compiled.selected.confirmation, nativeStayId: compiled.selected.reservationStayId }).success) {
    throw new Error('reservation_workflow_v2_amend_source_changed');
  }
  await lockCreateActorSession(tx, { actorUserId: ctx.user.id, sessionId: ctx.user.sessionId,
    sessionProfile: ctx.user.sessionProfile });

  const nextResult = { id: input.idempotencyKey, generationId: draft.generationId, requestId: input.requestId,
    allocationId: compiled.hintId, workflow: 'amend' as const, status: 'unknown' as const,
    draftRevision: draft.revision, observationRefs: [attempt.ref], updatedAt: new Date().toISOString(),
    summary: 'Native Amend claim acquired; outcome pending reconciliation' };
  const nextDraft = reservationWorkflowV2DraftSchema.parse({ ...draft, observations: [...draft.observations, attempt],
    operationResults: [...draft.operationResults.filter((row) => row.id !== input.idempotencyKey), nextResult] });
  await tx.update(workItem).set({ state: { ...(item.state as Record<string, unknown>),
    [RESERVATION_WORKFLOW_V2_STATE_KEY]: nextDraft }, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
  await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
    fieldPath: `${RESERVATION_WORKFLOW_V2_STATE_KEY}:operationResults:${nextResult.id}`,
    value: { id: nextResult.id, requestId: nextResult.requestId, allocationId: nextResult.allocationId,
      workflow: 'amend', status: 'unknown', observationRefs: nextResult.observationRefs },
    evidence: { sourceHash: input.source.sourceHash, seq: input.expectedSeq, approvedDigest,
      prepareObservationRef: prepared.ref, summary: nextResult.summary } });
}

function readbackMatches(readback: unknown, prepared: Record<string, unknown>): Record<string, unknown> | null {
  const actual = record(readback), target = record(prepared.target), changes = record(prepared.nativeChanges), preserved = record(prepared.preserved);
  const baseline = record(prepared.recoveryBaseline);
  const actualPrice = record(actual?.price), approvedPrice = record(prepared.approvedPrices);
  if (!actual || !target || !changes || !preserved || !baseline || actual.confirmation !== target.confirmation ||
      actual.nativeStayId !== target.nativeStayId || actual.arrival !== target.arrival || actual.departure !== target.departure ||
      actual.roomType !== target.roomType || actual.ratePlan !== target.ratePlan || actual.adults !== target.adults ||
      actual.children !== target.children || actual.firstName !== target.firstName || actual.lastName !== target.lastName ||
      actual.cmsSend !== changes.cmsSend || !actualPrice || !approvedPrice ||
      actualPrice.version !== approvedPrice.version || actualPrice.currency !== approvedPrice.currency ||
      actualPrice.totalCents !== approvedPrice.totalCents || actualPrice.averageCents !== approvedPrice.averageCents) return null;
  if (Array.isArray(target.childAges) && (!Array.isArray(actual.childAges) ||
      canonicalJson([...actual.childAges].sort((a: number, b: number) => a - b) as unknown) !==
      canonicalJson([...target.childAges].sort((a: number, b: number) => a - b)))) return null;
  const beforeKeys = { guestEmail: 'beforeGuestEmail', bookerName: 'beforeBookerName', bookerContact: 'beforeBookerContact' } as const;
  for (const key of ['guestEmail', 'bookerName', 'bookerContact'] as const) {
    if (Object.hasOwn(changes, key) && actual[key] !== changes[key]) return null;
    if (!Object.hasOwn(changes, key) && (typeof baseline[beforeKeys[key]] !== 'string' ||
        actual[key] !== baseline[beforeKeys[key]])) return null;
  }
  if (changes.cmsSend === true && (actual.cmsMessageId !== changes.cmsMessageId || actual.cmsRecipient !== changes.cmsRecipient)) return null;
  if (changes.cmsSend === false && (actual.cmsRecipient !== preserved.cmsRecipient ||
      (Object.hasOwn(preserved, 'cmsMessageId') && actual.cmsMessageId !== preserved.cmsMessageId))) return null;
  return actual;
}

export async function reservationWorkflowV2AmendExecute(ctx: ReservationWorkflowV2AmendContext,
  input: ReservationWorkflowV2ExecuteInput): Promise<Outcome> {
  if (input.go !== true || !input.allocationId) return { status: 'needs_input', issue: 'amend_target_and_go_required' };
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return loaded.result;
  if (ctx.property.propertyCode !== 'HRCEN') return { status: 'unsupported', issue: 'property_not_supported' };
  const prior = loaded.draft.operationResults.find((row) => row.id === input.idempotencyKey);
  if (prior && (prior.workflow !== 'amend' || prior.requestId !== input.requestId ||
      prior.allocationId !== input.allocationId)) {
    return { status: 'idempotency_conflict', issue: 'idempotency_key_bound_to_different_operation' };
  }
  if (prior?.status === 'succeeded') return { status: 'succeeded', operationId: prior.id, summary: prior.summary,
    observationRefs: prior.observationRefs };
  const targetResult = [...loaded.draft.operationResults].reverse().find((row) => row.workflow === 'amend' &&
    row.requestId === input.requestId && row.allocationId === input.allocationId && (row.status === 'succeeded' || row.status === 'unknown'));
  if (targetResult?.status === 'succeeded') return { status: 'already_succeeded', operationId: targetResult.id,
    summary: targetResult.summary, observationRefs: targetResult.observationRefs };
  if (prior?.status === 'unknown' || targetResult?.status === 'unknown') return { status: 'needs_reconcile', operationId: targetResult?.id ?? prior!.id };
  const compiled = compileBase(loaded.draft, input.requestId, input.allocationId, 'execute');
  if (compiled.outcome !== 'ok') return { status: compiled.outcome, issue: compiled.issue, fields: compiled.fields ?? [] };
  if (!ctx.user.sessionId || !ctx.user.sessionProfile) {
    return { status: 'refused', issue: 'authenticated_staff_session_required' };
  }
  const prepared = preparedObservation(loaded.draft, compiled), preparedResult = record(prepared?.result);
  const nativeChanges = record(preparedResult?.nativeChanges), preserved = record(preparedResult?.preserved),
    price = nativePrice(preparedResult?.approvedPrices);
  const expectedSemantic = preparedResult && prepared ? sha256({ baseDigest: compiled.baseDigest,
    selectedRef: compiled.selectedRef, selected: compiled.selected, target: preparedResult.target,
    changes: nativeChanges, preserved, recoveryBaseline: preparedResult.recoveryBaseline,
    nativeDigest: preparedResult.nativeDigest, price }) : null;
  if (!prepared || !preparedResult || !record(preparedResult.recoveryBaseline) ||
      typeof prepared.criteria.draftRevision !== 'number' || prepared.criteria.draftRevision > input.expectedRevision ||
      prepared.criteria.semanticDigest !== expectedSemantic || !nativeChanges || !preserved || !price ||
      typeof preparedResult.nativeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(preparedResult.nativeDigest)) {
    return { status: 'needs_prepare', issue: 'prepared_amend_or_price_is_stale' };
  }
  if (!labtestAmendWorkerEnabled()) return { status: 'refused', issue: 'amend_save_unavailable' };
  const locked = targetWriteLock(ctx, compiled.selected);
  if (!locked?.lock) return { status: 'needs_reconcile', issue: 'amend_target_lock_unavailable' };
  let expectedEpoch: string;
  try { expectedEpoch = await captureHmsLabtestDispatchEpoch(ctx.db, locked.dispatchTarget, input.workItemId); }
  catch { return { status: 'needs_reconcile', issue: 'amend_dispatch_history_unavailable' }; }
  const native = await nativeModule();
  const work = await mkdtemp(join(tmpdir(), 'reservation-v2-amend-'));
  const beforeScreenshot = join(work, 'before.png'), afterScreenshot = join(work, 'after.png');
  const runId = randomUUID();
  const dispatchState: { beforeEvidence: { eventId: string; sha256: string } | null;
    beforeShot: { runId: string; sha256: string } | null; afterShot: { runId: string; sha256: string } | null;
    handle: HmsLabtestWriteHandle | null; claimAttempted: boolean } = {
    beforeEvidence: null, beforeShot: null, afterShot: null, handle: null, claimAttempted: false };
  let result: Record<string, unknown>;
  const claimInputBase = {
    workItemId: input.workItemId, transportId: ctx.transport.id, actorUserId: ctx.user.id,
    grantId: input.idempotencyKey, propertyCode: 'HRCEN' as const,
    firstName: compiled.selected.firstName, lastName: compiled.selected.lastName,
    nativeGuestId: compiled.selected.guestId, operation: 'amend' as const,
    sourceDigest: input.source.sourceHash, approvedDigest: prepared.criteria.semanticDigest as string,
    recovery: { selected: compiled.selected, confirmation: compiled.selected.confirmation,
      reservationStayId: compiled.selected.reservationStayId, reservationId: compiled.selected.reservationId,
      recordId: compiled.selected.recordId, approved: nativeChanges,
      approvedPrices: price, preserved, nativeDigest: preparedResult.nativeDigest,
      prepareObservationRef: prepared.ref,
      approvedAfter: preparedResult.target, recoveryBaseline: preparedResult.recoveryBaseline,
      requestId: input.requestId, hintId: compiled.hintId, operationId: input.idempotencyKey,
      draftRevision: input.expectedRevision },
    target: locked.dispatchTarget,
  };
  let approvedClaim = '';
  const authorizeFirst = async (stepValue: unknown) => {
    const step = record(stepValue);
    if (dispatchState.claimAttempted || !step || step.operationDigest !== prepared.criteria.semanticDigest ||
        !['amend.availability', 'amend.save'].includes(String(step.phase)) ||
        typeof step.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(step.requestDigest) || !dispatchState.beforeEvidence) {
      throw new Error('AMEND_APPROVAL_INVALID');
    }
    dispatchState.claimAttempted = true;
    const claimInput = { ...claimInputBase, requestDigest: step.requestDigest,
      recovery: { ...claimInputBase.recovery, firstPhase: step.phase,
        runId, beforeShot: dispatchState.beforeShot } };
    approvedClaim = canonicalJson(claimInput);
    const attempt = observationForWrite(loaded.draft!, input, compiled.hintId, 'partial', {
      outcome: 'dispatch_pending', requestDigest: step.requestDigest,
      approvedDigest: prepared.criteria.semanticDigest, prepareObservationRef: prepared.ref,
      target: preparedResult.target, before: compiled.selected, approvedPrices: price,
      beforeShot: dispatchState.beforeShot, semanticInput: preparedResult.semanticInput,
    });
    dispatchState.handle = await claimHmsLabtestDispatch(ctx.db, claimInput,
      async (tx) => authorizeCurrentAmend(tx, ctx, input, compiled, prepared,
        prepared.criteria.semanticDigest as string, attempt),
      expectedEpoch);
    return dispatchState.handle;
  };
  const sealBeforeEvidence = async () => {
    const shot = await persistAmendShot(ctx, input.workItemId, runId, beforeScreenshot, 'before.png');
    if (!shot) throw new Error('AMEND_EVIDENCE_REQUIRED');
    dispatchState.beforeShot = shot;
    // The native API requires a UUID evidence handle; the durable v2 intent binds
    // the actual owner-bound shot receipt and never treats this marker as proof.
    dispatchState.beforeEvidence = { eventId: randomUUID(), sha256: shot.sha256 };
    return dispatchState.beforeEvidence;
  };
  try {
    try {
      result = await locked.lock.withLock(() => native.commitCloudPaneAmend({ target: locked.target,
        selected: compiled.selected, confirmation: compiled.selected.confirmation, arrival: compiled.selected.arrival,
        changes: nativeChanges, nativeDigest: preparedResult.nativeDigest, approvedPrices: price, preserved,
        allowRealGuest: process.env.PANE_WRITE_AMEND === 'on', cloudTargetKey: hmsDispatchTargetKey(locked.dispatchTarget),
        beforeScreenshot, afterScreenshot, signal: AbortSignal.timeout(20 * 60_000) },
      { operationDigest: prepared.criteria.semanticDigest as string, authorizeFirst, sealBeforeEvidence,
        isEnabled: () => labtestAmendWorkerEnabled() && ['lab', 'on'].includes(process.env.PANE_WRITE_AMEND ?? '') }),
      acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
    } catch (error) {
      result = { outcome: 'uncertain', issue: isPropertyReadLockDeadline(error) ? 'amend_lock_busy' : 'native_amend_invocation_failed' };
    }
    try { dispatchState.afterShot = await persistAmendShot(ctx, input.workItemId, runId, afterScreenshot, 'saved.png'); }
    catch { /* No positive completion without the saved evidence. */ }
  } finally { await rm(work, { recursive: true, force: true }).catch(() => {}); }
  const intent = record(result.readback);
  const readback = result.outcome === 'amended' && result.writerSessionClosed === true &&
    result.dispatchCallbacksDrained === true && result.businessFieldsMatched === true ? readbackMatches(intent, preparedResult) : null;
  if (!dispatchState.handle) {
    if (dispatchState.claimAttempted) return { status: 'needs_reconcile', operationId: input.idempotencyKey,
      issue: 'amend_dispatch_claim_unconfirmed' };
    return result.outcome === 'not_dispatched'
      ? { status: 'failed', operationId: input.idempotencyKey, issue: text(result.issue) ?? 'amend_not_dispatched' }
      : { status: 'refused', issue: text(result.issue) ?? 'amend_dispatch_not_authorized' };
  }
  if (!readback || !dispatchState.beforeEvidence || !dispatchState.beforeShot || !dispatchState.afterShot) {
    return { status: 'needs_reconcile', operationId: input.idempotencyKey, dispatchHoldId: dispatchState.handle.holdId,
      issue: 'amend_readback_or_durable_receipt_unverified' };
  }
  const handle = dispatchState.handle as HmsLabtestWriteHandle;
  const beforeShot = dispatchState.beforeShot as { runId: string; sha256: string };
  const afterShot = dispatchState.afterShot as { runId: string; sha256: string };
  const success = observationForWrite(loaded.draft, input, compiled.hintId, 'complete', {
    nativeOutcome: result.outcome, target: preparedResult.target, before: compiled.selected,
    nativeReadback: readback, approvedPrices: price, prepareObservationRef: prepared.ref,
    dispatchHoldId: handle.holdId, beforeShot, savedShot: afterShot,
  });
  try {
    const owner = `${ctx.user.id}:${ctx.transport.id}`;
    if (!await verifyStoredHmsShot({ ...beforeShot, name: 'before.png', owner, propertyCode: 'HRCEN',
      workItemId: input.workItemId }, 'before.png') ||
      !await verifyStoredHmsShot({ ...afterShot, name: 'saved.png', owner, propertyCode: 'HRCEN',
        workItemId: input.workItemId }, 'saved.png')) throw new Error('reservation_v2_amend_screenshot_unverified');
    await resolveHmsLabtestDispatch(ctx.db, handle, { operation: 'amend', confirmation: String(readback.confirmation),
      nativeStayId: String(readback.nativeStayId), nativeReadback: readback,
      readbackDigest: sha256(readback), savedShot: afterShot }, async (tx, durableIntent) => {
      const { version: _version, kind: _kind, holdId: _holdId, ownerDigest: _ownerDigest, ...claimed } = durableIntent;
      if (!approvedClaim || canonicalJson(claimed) !== approvedClaim) throw new Error('reservation_v2_amend_intent_changed');
      await persistResolvedResult(tx, ctx, input, compiled.hintId, success,
        `Amended ${readback.confirmation}; HMS fresh readback matched`);
    });
  } catch {
    return { status: 'needs_reconcile', operationId: input.idempotencyKey, dispatchHoldId: handle.holdId,
      issue: 'amend_durable_resolution_unconfirmed' };
  }
  await rm(work, { recursive: true, force: true }).catch(() => {});
  return { status: 'succeeded', operationId: input.idempotencyKey, requestId: input.requestId,
    allocationId: compiled.hintId, confirmation: readback.confirmation, price: readback.price,
    observationRef: success.ref };
}

export async function reservationWorkflowV2AmendReconcile(ctx: ReservationWorkflowV2AmendContext,
  input: ReservationWorkflowV2ReconcileInput): Promise<Outcome> {
  if (!z.string().uuid().safeParse(input.operationId).success) return { status: 'invalid_input', issue: 'operation_id_must_be_uuid' };
  if (ctx.property.propertyCode !== 'HRCEN') return { status: 'unsupported', issue: 'property_not_supported' };
  const loaded = await getReservationWorkflowV2Draft(stateContext(ctx), input);
  if (loaded.status !== 'ok') return loaded;
  const operation = loaded.draft.operationResults.find((row) => row.id === input.operationId);
  if (!operation || operation.workflow !== 'amend') return { status: 'not_found' };
  if (operation.status === 'succeeded') return { status: 'succeeded', operationId: operation.id,
    summary: operation.summary, observationRefs: operation.observationRefs };
  if (operation.status === 'failed') return { status: 'failed', operationId: operation.id, summary: operation.summary };
  if (operation.status !== 'unknown') return { status: 'not_reconcilable', operationId: operation.id };
  const rows = await ctx.db.select({ value: workEvent.value }).from(workEvent)
    .where(and(eq(workEvent.workItemId, input.workItemId), eq(workEvent.type, 'write.evidence'),
      eq(workEvent.fieldPath, 'nava.hms.labtest.dispatch.v1'))).limit(5000);
  const intents = rows.map((row) => record(row.value)).filter((row): row is Record<string, unknown> =>
    Boolean(row && row.kind === 'intent' && row.operation === 'amend' && row.grantId === input.operationId));
  if (!intents.length) return { status: 'needs_reconcile', operationId: input.operationId,
    issue: 'amend_claim_not_yet_observed' };
  const attempt = loaded.draft.observations.find((observation) => operation.observationRefs.includes(observation.ref) &&
    observation.kind === 'stay_candidate' && observation.status === 'partial' &&
    observation.criteria.workflow === 'amend' && observation.criteria.requestId === operation.requestId &&
    observation.criteria.hintId === operation.allocationId && observation.criteria.idempotencyKey === operation.id);
  const attemptResult = record(attempt?.result), prepareObservationRef = text(attemptResult?.prepareObservationRef);
  const prepared = prepareObservationRef ? loaded.draft.observations.find((observation) =>
    observation.ref === prepareObservationRef && observation.kind === 'rate_availability' &&
    observation.status === 'complete' && observation.criteria.workflow === 'amend' &&
    observation.criteria.requestId === operation.requestId && observation.criteria.hintId === operation.allocationId &&
    observation.criteria.semanticDigest === attemptResult?.approvedDigest) : undefined;
  const preparedResult = record(prepared?.result), before = record(preparedResult?.before);
  const expectedTarget = before ? hmsDispatchTargetSchema.safeParse({ propertyCode: 'HRCEN', kind: 'saved',
    confirmation: before.confirmation, nativeStayId: before.reservationStayId }) : null;
  const intent = intents.find((row) => {
    const recovery = record(row.recovery), target = hmsDispatchTargetSchema.safeParse(row.target);
    if (row.workItemId !== input.workItemId || row.transportId !== ctx.transport.id || row.propertyCode !== 'HRCEN' ||
        row.sourceDigest !== input.source.sourceHash || row.approvedDigest !== attemptResult?.approvedDigest ||
        recovery?.requestId !== operation.requestId || recovery.hintId !== operation.allocationId ||
        recovery.operationId !== operation.id || recovery.prepareObservationRef !== prepareObservationRef ||
        recovery.draftRevision !== operation.draftRevision || !expectedTarget?.success || !target.success) return false;
    return hmsDispatchTargetKey(target.data) === hmsDispatchTargetKey(expectedTarget.data);
  });
  if (!intent || typeof intent.holdId !== 'string' || !z.string().uuid().safeParse(intent.holdId).success) {
    return { status: 'needs_reconcile', operationId: input.operationId, issue: 'amend_dispatch_intent_scope_unverified' };
  }
  // The durable Amend hold deliberately remains active without positive evidence.
  // Recovery is wired through the existing dispatch protocol when its Amend driver is available.
  try {
    const dispatch = await import('./hms-labtest-dispatch.js') as Record<string, unknown>;
    const recover = dispatch.recoverHmsLabtestAmend;
    if (typeof recover !== 'function') return { status: 'needs_reconcile', operationId: input.operationId,
      dispatchHoldId: intent.holdId, issue: 'positive_amend_recovery_unavailable' };
    await (recover as (db: DB, holdId: string) => Promise<void>)(ctx.db, intent.holdId);
  } catch (error) {
    return { status: 'needs_reconcile', operationId: input.operationId, dispatchHoldId: intent.holdId,
      issue: error instanceof Error && error.message === 'amend_automatic_recovery_unavailable_operator_must_verify_writer_closed'
        ? error.message : 'fresh_amend_readback_not_positive' };
  }
  const resolved = await getReservationWorkflowV2Draft(stateContext(ctx), input);
  if (resolved.status !== 'ok') return resolved;
  const final = resolved.draft.operationResults.find((row) => row.id === input.operationId);
  return final?.status === 'succeeded' ? { status: 'succeeded', operationId: final.id,
    summary: final.summary, observationRefs: final.observationRefs } : { status: 'needs_reconcile',
      operationId: input.operationId, issue: 'amend_recovery_receipt_missing' };
}
