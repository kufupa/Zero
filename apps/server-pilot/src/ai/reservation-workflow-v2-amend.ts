import type { ReservationWorkflowV2SystemReadContext } from './reservation-workflow-v2-system-read-context.js';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import type { AiRunFence } from './run-ledger.js';
import { consumeStaffGoAtDispatch } from './hms-approval.js';
import type { VerifiedStaffGo } from '../hms/staff-go-authority.js';
import { mailboxAccess, mailThread, message } from '../db/schema/mail.js';
import { workEvent, workItem } from '../db/schema/work.js';
import type { HmsReadTarget } from '../hms/hms-read-target.js';
import { getPropertyRegistration } from '../../tooling/hms-cloud/property-registry.mjs';
import { effectiveWorkflowPolicy } from '../../tooling/hms-cloud/hms-workflow-policy.mjs';
import { cloudWriterCurrent, cloudWriterQuiesced, withCloudCredentialLease } from '../../tooling/hms-cloud/cloud-session.mjs';
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
  withReservationWorkflowV2Draft,
  type ReservationNativeCheckBatch,
  type ReservationWorkflowV2Context,
} from './reservation-workflow-v2-state.js';
import { canonicalJson } from './draft-approval.js';
import { sameGuestName } from './guest-name-match.js';
import { savedTargetExclusionIssue } from './reservation-workflow-v2-services.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import { paneStayCloudTargetLock, paneStayPropertyLock } from './pane-stay-save.js';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';
import { paneStayLookupEnabled, searchGuest } from './pane-stay-lookup.js';
import { projectCloudStayFind, runCloudStayFind, type HmsCloudNativePreimage } from './hms-cloud-saved-stay-find.js';
import { hmsDispatchTargetKey, hmsDispatchTargetKeys, hmsDispatchTargetSchema } from './hms-dispatch-target.js';
import {
  captureHmsLabtestDispatchEpoch,
  claimHmsLabtestDispatch,
  normalizeHmsLabtestClaim,
  resolveHmsLabtestDispatch,
  type HmsLabtestWriteHandle,
} from './hms-labtest-dispatch.js';
import { labtestAmendWorkerEnabled } from './pane-cloud-amend-readiness.js';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistHmsShots, verifyStoredHmsShot } from './hms-shots-store.js';
import { lockCreateActorSession } from './pane-create-actor-lock.js';
import { formatBookerContact, parseBookerContact } from './reservation-workflow-v2-booker-contact.js';
import { partyCandidateViews, verifiedNativeFields, reservationWorkflowV2MealPlanMatches } from './reservation-workflow-v2-tools.js';
import { partyMatchSearchTerms } from './party-match-v2.js';
import { loadReservationAmendBaselineAutoTransferLeads, reservationEntityKey } from './reservation-workflow-v2-native-leads.js';

export type ReservationWorkflowV2AmendContext = {
  db: DB;
  transport: { id: string };
  user: { id: string; sessionId?: string; sessionProfile?: 'legacy' | 'remote' };
  property: { propertyCode: string };
  writeRunFence?: AiRunFence;
  signal?: AbortSignal;
  nativeBatch?: ReservationNativeCheckBatch;
  recovery?: ReservationWorkflowV2Context['recovery'];
};
type ReadContext = ReservationWorkflowV2AmendContext | ReservationWorkflowV2SystemReadContext;

type Input = ReservationWorkflowV2LookupInput | ReservationWorkflowV2PrepareInput |
  ReservationWorkflowV2ExecuteInput | ReservationWorkflowV2ReconcileInput;
type Outcome = { status: string; issue?: string; [key: string]: unknown };
type AmendRequest = Extract<ReservationWorkflowV2Draft['proposal']['content']['requests'][number], { kind: 'amend' }>;
type Amendment = {
  arrival?: string; departure?: string; adults?: number; children?: number; childAges?: number[];
  roomType?: string; roomTypeForCharge?: string; ratePlan: string; retainRates: 'yes' | 'no'; firstName?: string; lastName?: string;
  guestEmail?: string; bookerName?: string; bookerContact?: string; billingReference?: string; taCommission?: number; guestOptIn?: boolean;
  track?: { lookupCode: string; display: string }; guaranteeType?: string;
  cmsSend: boolean; cmsMessageId: string; cmsRecipient: string;
};
type Compile = { outcome: 'ok'; requestId: string; hintId: string; selectionPath: string; selectedRef: string;
  selected: HmsCloudNativePreimage; baseChanges: Record<string, unknown>; rateHandling: 'retain' | 'reprice';
  reviewPaths: string[]; baseDigest: string; target: Record<string, unknown>; requestPath: string } |
  { outcome: 'needs_input' | 'needs_review' | 'unsupported'; issue: string; fields?: string[] };
type V2StateContext = ReservationWorkflowV2Context;
type WriteTx = Parameters<Parameters<DB['transaction']>[0]>[0];

function amendMode(ctx: ReadContext): 'off' | 'lab' | 'on' {
  const property = getPropertyRegistration(ctx.property.propertyCode);
  if (!property?.active) return 'off';
  if (property.propertyCode === 'HRCEN' && !labtestAmendWorkerEnabled()) return 'off';
  const policy = effectiveWorkflowPolicy(process.env, property.propertyCode, 'amend');
  return policy.readEnabled ? policy.admittedMode : 'off';
}

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
function stateContext(ctx: ReadContext): V2StateContext {
  return { db: ctx.db, transportId: ctx.transport.id, userId: 'system' in ctx || ctx.nativeBatch ? null : ctx.user.id,
    propertyCode: ctx.property.propertyCode, nativeBatch: ctx.nativeBatch, recovery: ctx.recovery };
}

async function currentDraft(ctx: ReadContext, input: Input) {
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

function effectiveRefList(draft: ReservationWorkflowV2Draft, path: string, source: unknown): unknown {
  const root = effectiveLeaf(draft, path, source);
  if (!Array.isArray(root)) return root;
  let length = root.length;
  const prefix = `${path}/`;
  for (const key of Object.keys(draft.fieldOverrides)) {
    if (!key.startsWith(prefix)) continue;
    const part = key.slice(prefix.length).split('/')[0];
    if (/^(?:0|[1-9]\d*)$/.test(part ?? '')) length = Math.max(length, Number(part) + 1);
  }
  if (length > 100) return UNKNOWN;
  const values = Array.from({ length }, (_, index) => effectiveLeaf(draft, `${path}/${index}`, root[index]));
  return values.some(value => value === undefined) ? UNKNOWN : values;
}

function amendDigestBody(draft: ReservationWorkflowV2Draft, requestId: string, requestPath: string,
  body: Record<string, unknown>): Record<string, unknown> {
  const reviews = new Set(draft.operationResults.filter(operation => operation.workflow === 'amend' &&
    operation.requestId === requestId && operation.generationId === draft.generationId && operation.status === 'prepared')
    .flatMap(operation => operation.observationRefs.filter(ref => draft.observations.some(observation =>
      observation.ref === ref && observation.kind === 'rate_availability' && observation.status === 'complete' &&
      observation.generationId === draft.generationId && observation.propertyCode === draft.propertyCode &&
      observation.sourceMessageId === draft.source.messageId && observation.criteria.workflow === 'amend' &&
      observation.criteria.stage === 'callback_price_review' && observation.criteria.requestId === requestId &&
      observation.criteria.hintId === operation.allocationId))));
  if (!Array.isArray(body.perTarget)) return body;
  return { ...body, perTarget: body.perTarget.map((value, index) => {
    const row = record(value);
    if (!row) return value;
    const refs = effectiveRefList(draft, `${requestPath}/perTarget/${index}/currentObservationRefs`, row.currentObservationRefs);
    return Array.isArray(refs) ? { ...row, currentObservationRefs: refs.filter(ref => typeof ref !== 'string' || !reviews.has(ref)) } : row;
  }) };
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

const targetIdentityFields = ['confirmation', 'guestName', 'bookedArrival', 'bookedDeparture'] as const;
function unknownTargetExclusionIdentityPaths(paths: Set<string>, root: string): string[] {
  return [...paths].filter((path) => {
    if (path === root) return true;
    if (!path.startsWith(`${root}/`)) return false;
    let parts: string[];
    try { parts = path.slice(root.length + 1).split('/').map((part) => decodeURIComponent(part)); }
    catch { return true; }
    return parts.length === 1 || parts.length > 1 && (parts[1] === 'id' || targetIdentityFields.includes(parts[1] as typeof targetIdentityFields[number]));
  });
}
function unknownPathsOutsideTargetExclusions(paths: Set<string>, root: string): string[] {
  return [...paths].filter((path) => path !== root && !path.startsWith(`${root}/`));
}
type ResolvedTargetExclusions = { rows: Array<{ hint: Record<string, unknown>; index: number; unresolved: boolean; fields: string[] }>;
  issue?: string; fields: string[] };

/** Resolve indexed and stable-ID edits, and hold malformed, duplicate, or unknown exclusion identities. */
function resolveTargetExclusions(draft: ReservationWorkflowV2Draft, path: string, value: unknown,
  unknownPaths: Set<string>): ResolvedTargetExclusions {
  if (!Array.isArray(value)) return { rows: [], issue: 'unresolved', fields: [path] };
  const sourceRows = value.map(record), ids = sourceRows.map((row) => text(row?.id));
  const duplicateIds = new Set(ids.filter((id): id is string => Boolean(id) && ids.filter((other) => other === id).length > 1));
  const rows: ResolvedTargetExclusions['rows'] = [];
  const fields = new Set<string>();
  for (const [index, source] of sourceRows.entries()) {
    if (!source || !ids[index]) {
      fields.add(`${path}/${index}`);
      continue;
    }
    const id = ids[index]!, hint = { ...source }, rowFields: string[] = [];
    let unresolved = duplicateIds.has(id);
    if (unresolved) rowFields.push(path);
    const idPaths = [...new Set([`${path}/${index}/id`, `${path}/${encodeURIComponent(id)}/id`])];
    const idOverrides = idPaths.flatMap((overridePath) => {
      const override = draft.fieldOverrides[overridePath];
      return override && override.state !== 'inherit' ? [{ path: overridePath, override }] : [];
    });
    const idSignatures = idOverrides.map(({ override }) => override.state === 'set'
      ? `set:${canonicalJson(override.value ?? null)}` : override.state);
    if (new Set(idSignatures).size > 1 || idOverrides.some(({ override }) => override.state !== 'set' || override.value !== id)) {
      unresolved = true;
      rowFields.push(...(idOverrides.length ? idOverrides.map((entry) => entry.path) : [path]));
    }
    for (const field of targetIdentityFields) {
      const indexPath = `${path}/${index}/${field}`, idPath = `${path}/${encodeURIComponent(id)}/${field}`;
      const overrides = [...new Set([indexPath, idPath])].flatMap((overridePath) => {
        const override = draft.fieldOverrides[overridePath];
        return override && override.state !== 'inherit' ? [{ path: overridePath, override }] : [];
      });
      const signatures = overrides.map(({ override }) => override.state === 'set'
        ? `set:${canonicalJson(override.value ?? null)}` : override.state);
      if (new Set(signatures).size > 1) {
        unresolved = true;
        rowFields.push(...overrides.map((entry) => entry.path));
        hint[field] = null;
      } else {
        const entry = overrides[0];
        if (entry?.override.state === 'unknown' || unknownPaths.has(indexPath)) {
          unresolved = true;
          rowFields.push(entry?.path ?? indexPath);
          hint[field] = null;
        } else if (entry?.override.state === 'set') hint[field] = entry.override.value;
        else if (entry && ['none', 'clear'].includes(entry.override.state)) hint[field] = null;
      }
    }
    rows.push({ hint, index, unresolved, fields: rowFields });
    rowFields.forEach((rowPath) => fields.add(rowPath));
  }
  if (fields.size) return { rows, issue: 'unresolved', fields: [...fields] };
  return { rows, fields: [] };
}

function auditTargetExclusions(stay: Record<string, unknown>, exclusions: ResolvedTargetExclusions,
  path: string): { issue: string; hintId?: string; fields: string[] } | null {
  if (exclusions.issue) return { issue: 'amend_target_exclusion_identity_unresolved', fields: [path, ...exclusions.fields] };
  for (const row of exclusions.rows) {
    if (row.unresolved) return { issue: 'amend_target_exclusion_identity_unresolved', hintId: text(row.hint.id) ?? undefined,
      fields: [path, ...row.fields] };
    const issue = savedTargetExclusionIssue(stay, [row.hint], false);
    if (issue) return { issue: issue === 'saved_target_exclusion_overlaps_native_stay'
      ? 'amend_target_exclusion_overlaps_native_stay' : 'amend_target_exclusion_identity_unresolved',
    hintId: text(row.hint.id) ?? undefined, fields: [path, `${path}/${row.index}`] };
  }
  return null;
}

/** Empty optional search hints mean no constraint; they are not native field clears. */
function normalizedTargetHint(hint: Record<string, unknown>): Record<string, unknown> {
  const result = { ...hint };
  for (const key of ['confirmation', 'guestName', 'bookedArrival', 'bookedDeparture']) {
    const value = result[key];
    if (value === NONE || value === null || typeof value === 'string' && !value.trim()) delete result[key];
    else if (typeof value === 'string') result[key] = value.trim();
  }
  return result;
}

function validNative(value: unknown, propertyCode: string): value is HmsCloudNativePreimage {
  const native = record(value);
  return Boolean(native && native.source === 'record_view_ext_model' && native.propertyCode === propertyCode &&
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
    if (!sameGuestName(name, nativeName) && !sameGuestName(name, native.lastName)) return 'guest_name_hint_mismatch';
  }
  return null;
}

function observationForStay(draft: ReservationWorkflowV2Draft, requestId: string, hintId: string,
  selectionPath: string, query: Record<string, unknown>, native: HmsCloudNativePreimage,
  reservationObservations: unknown, status: 'complete' | 'partial' = 'complete', note?: string): ReservationWorkflowV2Observation {
  return { ref: randomUUID(), generationId: draft.generationId, kind: 'stay_candidate', status,
    observedAt: new Date().toISOString(), propertyCode: draft.propertyCode, sourceMessageId: draft.source.messageId, sourceRefs: [],
    criteria: { workflow: 'amend', kind: 'saved_target', requestId, hintId, selectionPath, query },
    coverage: { complete: status === 'complete', notes: note ? [note] : [] },
    result: { candidate: native, nativeStayId: native.reservationStayId, confirmation: native.confirmation,
      reservationObservations } };
}

function failedStayObservation(draft: ReservationWorkflowV2Draft, requestId: string, hintId: string,
  selectionPath: string, query: Record<string, unknown>, issue: string): ReservationWorkflowV2Observation {
  return { ref: randomUUID(), generationId: draft.generationId, kind: 'stay_candidate', status: 'partial',
    observedAt: new Date().toISOString(), propertyCode: draft.propertyCode, sourceMessageId: draft.source.messageId, sourceRefs: [],
    criteria: { workflow: 'amend', kind: 'saved_target', requestId, hintId, selectionPath, query },
    coverage: { complete: false, notes: [issue] }, result: { outcome: 'unverified', issue } };
}

function propertyTarget(ctx: ReadContext): HmsReadTarget | null {
  const resolved = paneStayHmsTargetForTransport(ctx.transport.id, ctx.property.propertyCode);
  return resolved.ok && resolved.target.propertyCode === ctx.property.propertyCode ? resolved.target : null;
}

async function readCandidate(target: HmsReadTarget, confirmation: string,
  arrival?: string, signal?: AbortSignal, transportId?: string) {
  if (!paneStayLookupEnabled()) return null;
  const lock = paneStayPropertyLock(target);
  if (!lock) return null;
  try {
    return await lock.withLock(async () => {
      const request = { confirmation, ...(arrival ? { arrival } : {}) };
      const timeout = AbortSignal.timeout(5 * 60_000);
      const raw = await runCloudStayFind({ request, target, transportId, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
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
  signal?: AbortSignal, transportId?: string): Promise<LookupHintResult> {
  const query: Record<string, unknown> = {
    confirmation: hint.confirmation ?? null, guestName: hint.guestName ?? null,
    bookedArrival: hint.bookedArrival ?? null, bookedDeparture: hint.bookedDeparture ?? null,
  };
  const rows: Array<{ observation: ReservationWorkflowV2Observation; native: HmsCloudNativePreimage }> = [];
  const confirmation = text(hint.confirmation);
  if (confirmation) {
    if (!/^\d{6,10}-\d{1,2}$/.test(confirmation)) return { rows, observation: failedStayObservation(draft, requestId, hintId, selectionPath, query, 'confirmation_hint_invalid') };
    const found = await readCandidate(target, confirmation, realDate(hint.bookedArrival) ? hint.bookedArrival : undefined, signal, transportId);
    const native = record(found)?.nativePreimage;
    const mismatch = validNative(native, target.propertyCode) ? validateHintAgainstNative(hint, native) : 'native_stay_unverified';
    if (!validNative(native, target.propertyCode) || mismatch || found?.outcome !== 'found') {
      return { rows, observation: failedStayObservation(draft, requestId, hintId, selectionPath, query, mismatch ?? 'native_stay_unverified') };
    }
    return { rows: [{ observation: observationForStay(draft, requestId, hintId, selectionPath, query, native,
      found.reservationObservations), native }] };
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
      target, transportId, lock: () => paneStayPropertyLock(target), acquisition: acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS),
    });
  } catch {
    return { rows, observation: failedStayObservation(draft, requestId, hintId, selectionPath, query, 'stay_search_failed') };
  }
  if (search.outcome !== 'ok') return { rows, observation: failedStayObservation(draft, requestId, hintId, selectionPath, query,
    search.outcome === 'ambiguous_capped' ? 'stay_search_ambiguous' : 'stay_search_failed') };
  for (const row of search.rows) {
    if (row.arrival !== arrival || (realDate(departure) && row.departure !== departure)) continue;
    const found = await readCandidate(target, row.confirmation, row.arrival ?? undefined, undefined, transportId);
    const native = record(found)?.nativePreimage;
    const mismatch = validNative(native, target.propertyCode) ? validateHintAgainstNative(hint, native) : 'native_stay_unverified';
    if (!validNative(native, target.propertyCode) || mismatch || found?.outcome !== 'found') continue;
    rows.push({ observation: observationForStay(draft, requestId, hintId, selectionPath, query, native,
      found.reservationObservations), native });
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
    item.status === 'complete' && item.generationId === draft.generationId && item.propertyCode === draft.propertyCode &&
    item.criteria.workflow === 'amend' && item.criteria.kind === 'saved_target' && item.criteria.requestId === requestId &&
    item.criteria.hintId === hintId && item.criteria.selectionPath === path);
  const native = record(observation?.result)?.candidate;
  const mismatch = validNative(native, draft.propertyCode) ? validateHintAgainstNative(hint, native) : null;
  if (mismatch === 'guest_name_hint_mismatch') return { issue: mismatch, fields: [path.replace(/\/suggestedRef$/, '/guestName')] };
  if (!validNative(native, draft.propertyCode) || mismatch) {
    return { issue: 'host_native_target_selection_unverified', fields: [path] };
  }
  return { selected: native, ref: resolved, path };
}

function fieldChanged(current: Record<string, unknown>, field: string, value: unknown) {
  const baselineField = field === 'childCount' ? 'children' : field === 'guaranteeType' ? 'guaranteeCode' : field;
  const before = current[baselineField];
  if (field === 'childAges') return canonicalJson(before) !== canonicalJson(value);
  return before !== value;
}

function sameChildAges(left: unknown, right: unknown) {
  if (!Array.isArray(left) || !Array.isArray(right)) return left === right;
  return canonicalJson([...left].sort((a, b) => Number(a) - Number(b))) ===
    canonicalJson([...right].sort((a, b) => Number(a) - Number(b)));
}

function compileBase(draft: ReservationWorkflowV2Draft, requestId: string, hintId: string,
  mode: 'prepare' | 'execute'): Compile {
  const found = requestBody(draft, requestId);
  if (!found) return { outcome: 'needs_input', issue: 'amend_request_not_found' };
  const { request, path: requestPath } = found;
  const unknownPaths = new Set<string>();
  const body = effectiveTree(draft, requestPath, request.body, unknownPaths);
  const exclusionPath = ptr('proposal', 'content', 'requests', requestId, 'body', 'targets', 'exclude');
  const unknownExclusionPaths = unknownTargetExclusionIdentityPaths(unknownPaths, exclusionPath);
  if (unknownExclusionPaths.length) return { outcome: 'needs_input', issue: 'amend_target_exclusion_identity_unresolved',
    fields: [exclusionPath, ...unknownExclusionPaths] };
  const unknownOtherPaths = unknownPathsOutsideTargetExclusions(unknownPaths, exclusionPath);
  if (unknownOtherPaths.length) return { outcome: 'needs_input', issue: 'amend_value_unknown', fields: unknownOtherPaths };
  const bodyValue = record(body);
  if (!bodyValue) return { outcome: 'needs_input', issue: 'amend_body_unavailable' };
  const scope = targetRows(bodyValue);
  if (!scope.targets || scope.mode !== 'explicit') {
    return { outcome: 'needs_input', issue: 'amend_target_scope_unresolved' };
  }
  if (!Array.isArray(scope.targets.exclude)) {
    return { outcome: 'needs_input', issue: 'amend_target_exclusion_identity_unresolved', fields: [exclusionPath] };
  }
  const targetExclusions = resolveTargetExclusions(draft, exclusionPath, scope.targets.exclude, unknownPaths);
  if (targetExclusions.issue) return { outcome: 'needs_input', issue: 'amend_target_exclusion_identity_unresolved',
    fields: [exclusionPath, ...targetExclusions.fields] };
  const hints = scope.include.map(record).filter((hint): hint is Record<string, unknown> => Boolean(hint));
  const hintIndex = hints.findIndex((hint) => hint.id === hintId);
  if (hintIndex < 0) return { outcome: 'needs_input', issue: 'amend_target_not_included' };
  const hint = normalizedTargetHint(hints[hintIndex]!);
  if (scope.exclude.some((value) => record(value)?.id === hintId)) {
    return { outcome: 'needs_input', issue: 'amend_target_excluded' };
  }
  const chosen = selectedStay(draft, requestId, hintId, hint, hintIndex);
  if ('issue' in chosen) return { outcome: 'needs_input', issue: chosen.issue, fields: chosen.fields ?? [] };
  const exclusionIssue = auditTargetExclusions(chosen.selected as unknown as Record<string, unknown>, targetExclusions, exclusionPath);
  if (exclusionIssue) return { outcome: 'needs_input', issue: exclusionIssue.issue, fields: exclusionIssue.fields };
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
  const roomCountPaths: string[] = [];
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
    if (field === 'roomCount') { roomCountPaths.push(changePath); return; }
    const supported = new Set(['arrival', 'departure', 'adults', 'childCount', 'childAges', 'roomType', 'roomTypeForCharge', 'ratePlan',
      'firstName', 'lastName', 'guestEmail', 'bookerName', 'bookerEmail', 'bookerMobile', 'reservationNote', 'billingReference', 'taCommission', 'guestOptIn', 'track', 'guaranteeType', 'cmsSend', 'cmsMessageId', 'cmsRecipient',
      'bookingAgency', 'organization', 'arAccount', 'requestedMealPlan']);
    if (!supported.has(field)) { unsupported.add(field); return; }
    if (op === 'clear') {
      if (['guestEmail', 'bookerName', 'bookerEmail', 'bookerMobile', 'reservationNote', 'billingReference', 'roomTypeForCharge'].includes(field)) values[field] = '';
      else if (field === 'cmsSend' || field === 'guestOptIn') values[field] = false;
      else if (field === 'cmsMessageId' || field === 'cmsRecipient') values[field] = '';
      else errors.push(`${changePath}:field_cannot_be_cleared`);
      reviewPaths.add(valuePath);
      return;
    }
    if (op !== 'set') { errors.push(`${opPath}:operation_unsupported`); return; }
    const rawValue = effectiveLeaf(draft, valuePath, item.value);
    if (rawValue === UNKNOWN) { errors.push(`${valuePath}:value_unknown`); return; }
    if (field === 'bookingAgency' || field === 'organization' || field === 'arAccount') {
      const party = record(rawValue), name = text(effectiveLeaf(draft, `${valuePath}/name`, party?.name));
      const selectionPath = `${valuePath}/nativeSelectionRef`;
      const ref = effectiveLeaf(draft, selectionPath, party?.suggestedRef);
      const rows = typeof ref === 'string' ? draft.observations.filter(observation => observation.ref === ref) : [];
      const observation = rows.length === 1 ? rows[0] : null;
      const role = field === 'bookingAgency' ? 'bookingAgency' : field === 'organization' ? 'organization' : 'ar_account';
      const candidates = Array.isArray(observation?.result.candidates) ? observation.result.candidates : [];
      const candidate = candidates.length === 1 ? record(candidates[0]) : null;
      if (!name || !observation || observation.kind !== 'party_candidate' || observation.status !== 'complete' ||
          !observation.coverage.complete || observation.generationId !== draft.generationId ||
          observation.propertyCode !== draft.propertyCode || observation.sourceMessageId !== draft.source.messageId ||
          observation.criteria.workflow !== 'amend' || observation.criteria.kind !== 'party_name' ||
          observation.criteria.requestId !== requestId || observation.criteria.role !== role ||
          observation.criteria.query !== name || !Array.isArray(observation.criteria.fieldPaths) ||
          !observation.criteria.fieldPaths.includes(selectionPath) || !candidate ||
          !/^\d{1,30}$/.test(String(candidate.nativeId ?? '')) || !text(candidate.name) ||
          String(candidate.name).length > 200 || /[\p{Cc}]/u.test(String(candidate.name))) {
        errors.push(`${selectionPath}:party_candidate_unverified`); return;
      }
      values[field] = { nativeId: String(candidate.nativeId), name: String(candidate.name), query: String(candidate.name),
        selectedRef: ref, selectionPath };
      reviewPaths.add(valuePath);
      reviewPaths.add(selectionPath);
      return;
    }
    if (rawValue === NONE) {
      if (['guestEmail', 'bookerName', 'bookerEmail', 'bookerMobile', 'reservationNote', 'billingReference', 'roomTypeForCharge'].includes(field)) values[field] = '';
      else if (field === 'cmsSend' || field === 'guestOptIn') values[field] = false;
      else errors.push(`${valuePath}:explicit_none_not_supported`);
      reviewPaths.add(valuePath);
      return;
    }
    const valid = field === 'arrival' || field === 'departure' ? realDate(rawValue) :
      field === 'adults' ? Number.isInteger(rawValue) && Number(rawValue) >= 1 && Number(rawValue) <= 16 :
      field === 'childCount' ? Number.isInteger(rawValue) && Number(rawValue) >= 0 && Number(rawValue) <= 9 :
      field === 'childAges' ? Array.isArray(rawValue) && rawValue.length <= 9 && rawValue.every((age) => Number.isInteger(age) && age >= 0 && age <= 17) :
      field === 'roomType' || field === 'roomTypeForCharge' || field === 'ratePlan' ? code(rawValue) :
      field === 'reservationNote' ? typeof rawValue === 'string' && rawValue.length <= 2000 &&
        ![...rawValue].some((char) => (char.charCodeAt(0) < 32 && char !== '\n') || char.charCodeAt(0) === 127) :
      field === 'track' ? (() => { const track = record(rawValue); return Boolean(track && Object.keys(track).length === 2 &&
        typeof track.lookupCode === 'string' && /^[A-Z0-9]{1,12}$/.test(track.lookupCode) && typeof track.display === 'string' &&
        track.display.length > 0 && track.display.length <= 200 && track.display.trim() === track.display && !/[\p{Cc}]/u.test(track.display)); })() :
      field === 'requestedMealPlan' ? typeof rawValue === 'string' && Boolean(rawValue.trim()) && rawValue.length <= 120 && !/[\p{Cc}]/u.test(rawValue) :
      field === 'billingReference' ? typeof rawValue === 'string' && rawValue.length <= 4000 && !/[\p{Cc}]/u.test(rawValue) :
      field === 'taCommission' ? typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue >= 0 && rawValue <= 100 :
      field === 'guestOptIn' ? typeof rawValue === 'boolean' :
      field === 'guaranteeType' ? typeof rawValue === 'string' && /^[A-Z0-9]{1,20}$/.test(rawValue) :
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
  if (roomCountPaths.length) return { outcome: 'needs_input', issue: 'amend_room_count_requires_separate_reservations', fields: roomCountPaths };
  if (unsupported.size) return { outcome: 'unsupported', issue: 'amend_contains_native_unsupported_field', fields: [...unsupported] };
  if (errors.length) return { outcome: 'needs_input', issue: 'amend_changes_invalid_or_unknown', fields: errors };
  if (typeof values.billingReference === 'string' && values.billingReference.length > 50) {
    return { outcome: 'needs_input', issue: 'native_billing_reference_max_50', fields: ['billingReference'] };
  }
  const observationRefs = effectiveRefList(draft, `${perPath}/currentObservationRefs`, record(perRows[perIndex])?.currentObservationRefs);
  if (Object.hasOwn(values, 'reservationNote') && (observationRefs === UNKNOWN || observationRefs === NONE ||
      (observationRefs != null && (!Array.isArray(observationRefs) || observationRefs.some(ref =>
        typeof ref !== 'string' || draft.observations.filter(item => item.ref === ref).length !== 1))))) {
    return { outcome: 'needs_input', issue: 'amend_note_baseline_unavailable', fields: [`${perPath}/currentObservationRefs`] };
  }
  const noteBaselines = Array.isArray(observationRefs) ? observationRefs.flatMap(ref => {
    const observation = draft.observations.find(item => item.ref === ref && item.kind === 'stay_candidate' &&
      item.criteria.kind === 'prefill_saved_note_baseline');
    return observation ? [observation] : [];
  }) : [];
  if (Object.hasOwn(values, 'reservationNote') && noteBaselines.length) {
    const baseline = noteBaselines[0], selectedObservation = draft.observations.find(item => item.ref === chosen.ref);
    const note = record(record(record(baseline?.result)?.reservationObservations)?.reservationNote);
    const selectedNote = record(record(record(selectedObservation?.result)?.reservationObservations)?.reservationNote);
    const review = draft.staffReviews[`${perPath}/currentObservationRefs`];
    const reviewedRefresh = review?.status === 'accepted' && review.note ===
      `amend-note:${sha256([chosen.ref, values.reservationNote])}`;
    if (noteBaselines.length !== 1 || baseline?.status !== 'complete' || !baseline.coverage.complete ||
        baseline.generationId !== draft.generationId || baseline.propertyCode !== draft.propertyCode ||
        baseline.sourceMessageId !== draft.source.messageId || baseline.criteria.requestId !== requestId || !note || !selectedNote ||
        !['observed', 'blank'].includes(String(note.state)) || note.source !== 'record_view_raw_value' ||
        note.confirmation !== chosen.selected.confirmation || typeof note.value !== 'string' ||
        selectedObservation?.status !== 'complete' || !selectedObservation.coverage.complete ||
        selectedObservation.sourceMessageId !== draft.source.messageId ||
        !['observed', 'blank'].includes(String(selectedNote.state)) || selectedNote.source !== note.source ||
        selectedNote.confirmation !== note.confirmation || typeof selectedNote.value !== 'string' ||
        (!reviewedRefresh && (selectedNote.state !== note.state || selectedNote.value !== note.value))) {
      return { outcome: 'needs_input', issue: 'amend_note_baseline_does_not_match_selected_stay',
        fields: [`${perPath}/currentObservationRefs`] };
    }
  }
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
  const pricingChanged = ['arrival', 'departure', 'adults', 'roomType', 'roomTypeForCharge', 'ratePlan']
    .some((field) => Object.hasOwn(baseChanges, field) && fieldChanged(current, field, baseChanges[field]));
  const knownChildAgesChanged = Array.isArray(baseChanges.childAges) && Array.isArray(current.childAges) &&
    !sameChildAges(baseChanges.childAges, current.childAges);
  const knownCallbackChanged = (typeof baseChanges.children === 'number' && baseChanges.children !== current.children) ||
    knownChildAgesChanged || (typeof baseChanges.guaranteeType === 'string' && typeof current.guaranteeCode === 'string' &&
      baseChanges.guaranteeType !== current.guaranteeCode);
  if (rateValue === 'retain' && (pricingChanged || knownCallbackChanged)) {
    if (typeof baseChanges.guaranteeType === 'string') {
      return { outcome: 'unsupported', issue: 'amend_guarantee_change_finish_in_hms', fields: ['guaranteeType'] };
    }
    return { outcome: 'unsupported', issue: 'retained_rate_not_supported_for_priced_amendment', fields: ['rateHandling'] };
  }
  const target = { confirmation: current.confirmation, nativeStayId: current.reservationStayId,
    arrival: next.arrival, departure: next.departure, roomType: next.roomType, ratePlan: next.ratePlan,
    adults: next.adults, children: next.children, childAges: next.childAges,
    firstName: next.firstName, lastName: next.lastName };
  const baseDigest = sha256({ requestId, hintId, selectedRef: chosen.ref, selected: chosen.selected,
    body: amendDigestBody(draft, requestId, requestPath, bodyValue),
    scope: { mode: scope.mode, include: scope.include, exclude: targetExclusions.rows.map(({ hint: excluded }) => ({ id: excluded.id ?? null,
      confirmation: excluded.confirmation ?? null, guestName: excluded.guestName ?? null,
      bookedArrival: excluded.bookedArrival ?? null, bookedDeparture: excluded.bookedDeparture ?? null })) },
    rateHandling: rateValue, changes: baseChanges, noteBaselineRefs: noteBaselines.map(item => item.ref),
    reviewPaths: [...reviewPaths].sort() });
  return { outcome: 'ok', requestId, hintId, selectionPath: chosen.path, selectedRef: chosen.ref,
    selected: chosen.selected, baseChanges, rateHandling: rateValue as 'retain' | 'reprice',
    reviewPaths: [...reviewPaths], baseDigest, target, requestPath };
}

function nativePrice(value: unknown): Record<string, unknown> | null {
  const row = record(value);
  if (!row || row.version !== 2 || typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency) ||
      typeof row.totalCents !== 'string' || !/^\d+$/.test(row.totalCents) ||
      row.averageCents !== null && (typeof row.averageCents !== 'string' || !/^\d+$/.test(row.averageCents))) return null;
  if (row.componentsTenThousandths !== undefined) {
    const components = record(row.componentsTenThousandths);
    const allowed = new Set(['grandtotal', 'averagenightly', 'averagerate', 'totalrate', 'totalratewithtax',
      'enhancedexptotal', 'guesttotal', 'guesttax', 'guesttotalwithtax', 'tax', 'totalresortfee', 'ratetax']);
    if (!components || Object.entries(components).some(([key, value]) => !allowed.has(key) ||
        typeof value !== 'string' || !/^\d+$/.test(value))) return null;
  }
  return row;
}

function normalizedChanges(base: Compile & { outcome: 'ok' }, preserved: Record<string, unknown>,
  baseline: Record<string, unknown>): Amendment | null {
  if (typeof preserved.cmsSend !== 'boolean' || typeof preserved.cmsRecipient !== 'string') return null;
  const cmsSend = typeof base.baseChanges.cmsSend === 'boolean' ? base.baseChanges.cmsSend : preserved.cmsSend;
  const cmsRecipient = typeof base.baseChanges.cmsRecipient === 'string' ? base.baseChanges.cmsRecipient : preserved.cmsRecipient;
  const cmsMessageId = typeof base.baseChanges.cmsMessageId === 'string'
    ? base.baseChanges.cmsMessageId : typeof preserved.cmsMessageId === 'string' ? preserved.cmsMessageId : '';
  if (typeof preserved.cmsMessageId !== 'string' ||
      cmsSend && (!cmsMessageId.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cmsRecipient))) return null;
  const { bookerEmail, bookerMobile, requestedMealPlan: _requestedMealPlan, ...nativeChanges } = base.baseChanges;
  if (bookerEmail !== undefined || bookerMobile !== undefined) {
    const previous = typeof baseline.beforeBookerContact === 'string' ? parseBookerContact(baseline.beforeBookerContact) : null;
    if ((!previous && (bookerEmail === undefined || bookerMobile === undefined)) ||
        (bookerEmail !== undefined && typeof bookerEmail !== 'string') ||
        (bookerMobile !== undefined && typeof bookerMobile !== 'string')) return null;
    const email = typeof bookerEmail === 'string' ? bookerEmail || null : previous?.email ?? null;
    const mobile = typeof bookerMobile === 'string' ? bookerMobile || null : previous?.mobile ?? null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    const contact = formatBookerContact(email, mobile);
    if (contact === null) return null;
    nativeChanges.bookerContact = contact;
  }
  return { ...nativeChanges, ratePlan: String(base.baseChanges.ratePlan ?? base.selected.ratePlan),
    retainRates: base.rateHandling === 'retain' ? 'yes' : 'no', cmsSend, cmsMessageId, cmsRecipient } as Amendment;
}

function nativeModule() {
  const url = new URL('../../tooling/hms-cloud/pane-amend-session.mjs', import.meta.url);
  return import(url.href) as Promise<{
    prepareCloudPaneAmend(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    readCloudSavedChildAges(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    previewCloudPaneAmendChildren(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    inspectCloudPaneAmendParties(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    reviewCloudPaneAmendCallbacks(input: Record<string, unknown>, authorization: Record<string, unknown>): Promise<Record<string, unknown>>;
    readCloudCallbackReviewState(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    commitCloudPaneAmendReviewed(input: Record<string, unknown>, authorization: Record<string, unknown>): Promise<Record<string, unknown>>;
    commitCloudPaneAmend(input: Record<string, unknown>, authorization: Record<string, unknown>): Promise<Record<string, unknown>>;
  }>;
}

const nativeAmendFailure = (result: Record<string, unknown>, fallback: string) =>
  result.outcome === 'refused' && result.issue === 'RATE_NOT_AVAILABLE' ? 'RATE_NOT_AVAILABLE' : fallback;

async function persistAmendShot(ctx: ReservationWorkflowV2AmendContext, workItemId: string,
  runId: string, sourcePath: string, name: 'before.png' | 'saved.png') {
  const stage = await mkdtemp(join(tmpdir(), 'reservation-v2-amend-shot-'));
  try {
    await copyFile(sourcePath, join(stage, name));
    const owner = `${ctx.user.id}:${ctx.transport.id}`;
    const shots = await persistHmsShots({ propertyCode: ctx.property.propertyCode, workItemId, runId,
      sourceDir: stage, owner, now: Date.now() });
    const shot = shots?.find((candidate) => candidate.name === name);
    if (!shot || !await verifyStoredHmsShot({ runId, name, sha256: shot.sha256, owner,
      propertyCode: ctx.property.propertyCode, workItemId }, name)) return null;
    return { runId, sha256: shot.sha256 };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

function targetWriteLock(ctx: ReadContext, selected: HmsCloudNativePreimage) {
  const target = propertyTarget(ctx);
  const targetRef = hmsDispatchTargetSchema.safeParse({ propertyCode: selected.propertyCode, kind: 'saved',
    confirmation: selected.confirmation, nativeStayId: selected.reservationStayId });
  if (!target || !targetRef.success || selected.propertyCode !== ctx.property.propertyCode) return null;
  return { target, dispatchTarget: targetRef.data,
    lock: paneStayCloudTargetLock(target, targetRef.data, { kind: 'independent_cloud' }) };
}

/** Read the current Track picker for every selected reservation in this change's scope. */
export async function readAmendTrackChoices(ctx: ReadContext, draft: ReservationWorkflowV2Draft,
  requestId: string, fieldPath: string): Promise<Outcome> {
  if (!paneStayLookupEnabled()) return { status: 'needs_input', issue: 'stay_lookup_disabled' };
  const found = requestBody(draft, requestId);
  if (!found) return { status: 'needs_input', issue: 'amend_track_target_selection_required' };
  const unknown = new Set<string>(), targetsPath = `${found.path}/targets`;
  const targets = record(effectiveTree(draft, targetsPath, found.request.body.targets, unknown));
  if (!targets || targets.mode !== 'explicit' || !Array.isArray(targets.include) || !targets.include.length ||
      !Array.isArray(targets.exclude) || unknown.size) return { status: 'needs_input', issue: 'amend_track_target_selection_required' };
  const exclusionPath = `${targetsPath}/exclude`;
  const exclusions = resolveTargetExclusions(draft, exclusionPath, targets.exclude, unknown);
  if (exclusions.issue) return { status: 'needs_input', issue: 'amend_track_target_selection_required' };
  const relative = fieldPath.startsWith(`${found.path}/`) ? fieldPath.slice(found.path.length + 1).split('/') : [];
  let targetHint: string | null = null;
  if (relative[0] === 'perTarget' && /^\d+$/.test(relative[1] ?? '')) {
    const index = Number(relative[1]), root = `${found.path}/perTarget`;
    const rows = effectiveLeaf(draft, root, found.request.body.perTarget);
    const row = Array.isArray(rows) ? record(effectiveLeaf(draft, `${root}/${index}`, rows[index])) : null;
    const value = effectiveLeaf(draft, `${root}/${index}/hintId`, row?.hintId);
    targetHint = text(value);
    if (!targetHint) return { status: 'needs_input', issue: 'amend_track_target_selection_required' };
  } else if (relative[0] !== 'sharedChanges') return { status: 'needs_input', issue: 'amend_track_target_selection_required' };
  const selected: Array<{ hintId: string; ref: string; native: HmsCloudNativePreimage }> = [];
  const ids = new Set<string>();
  for (const [index, value] of targets.include.entries()) {
    const hint = record(value), hintId = text(hint?.id);
    if (!hint || !hintId || ids.has(hintId)) return { status: 'needs_input', issue: 'amend_track_target_selection_required' };
    ids.add(hintId);
    if (targets.exclude.some(value => record(value)?.id === hintId) || (targetHint && hintId !== targetHint)) continue;
    const chosen = selectedStay(draft, requestId, hintId, normalizedTargetHint(hint), index);
    if ('issue' in chosen || auditTargetExclusions(chosen.selected as unknown as Record<string, unknown>, exclusions, exclusionPath)) {
      return { status: 'needs_input', issue: 'amend_track_target_selection_required' };
    }
    selected.push({ hintId, ref: chosen.ref, native: chosen.selected });
  }
  if (!selected.length || (targetHint && selected.length !== 1)) return { status: 'needs_input', issue: 'amend_track_target_selection_required' };
  const native = await import(new URL('../../tooling/hms-cloud/pane-amend-session.mjs', import.meta.url).href) as {
    listCloudPaneAmendTrackChoices: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  let intersection: Array<{ code: string; label: string }> | null = null;
  for (const item of selected) {
    const locked = targetWriteLock(ctx, item.native);
    if (!locked?.lock) return { status: 'failed', issue: 'amend_track_choices_unavailable' };
    let result: Record<string, unknown>;
    try {
      result = await locked.lock.withLock(() => native.listCloudPaneAmendTrackChoices({ target: locked.target, transportId: ctx.transport.id,
        selected: item.native, confirmation: item.native.confirmation, arrival: item.native.arrival, allowRealGuest: true,
        cloudTargetKey: hmsDispatchTargetKey(locked.dispatchTarget), signal: ctx.nativeBatch?.signal ?? AbortSignal.timeout(8 * 60_000) }),
      { ...acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS), signal: ctx.nativeBatch?.signal });
    } catch { return { status: 'failed', issue: 'amend_track_choices_unavailable' }; }
    const coverage = record(result.coverage), rows = Array.isArray(result.candidates) ? result.candidates : null;
    if (result.outcome !== 'ok' || coverage?.complete !== true || coverage.nativeResponseCorrelated !== true || !rows) {
      return { status: 'failed', issue: 'amend_track_choices_unavailable' };
    }
    const choices: Array<{ code: string; label: string }> = [];
    for (const value of rows) {
      const row = record(value), code = text(row?.code), label = text(row?.label);
      if (!code || !label || choices.some(choice => choice.code === code)) return { status: 'failed', issue: 'amend_track_choices_unavailable' };
      choices.push({ code, label });
    }
    intersection = intersection === null ? choices : intersection.filter(choice =>
      choices.some(other => other.code === choice.code && other.label === choice.label));
  }
  return { status: 'ok', candidates: intersection ?? [], selectedTargets: selected.map(({ hintId, ref }) => ({ hintId, ref })),
    nativeCoverage: { complete: true, nativeResponseCorrelated: true, selectedStayCount: selected.length } };
}

const nativePartySchema = z.discriminatedUnion('state', [z.object({ state: z.literal('unknown') }).strict(),
  z.object({ state: z.literal('blank') }).strict(),
  z.object({ state: z.literal('selected'), nativeId: z.string().regex(/^[1-9]\d{0,29}$/),
    name: z.string().min(1).max(300).refine(value => Boolean(value.trim()) && !/[\p{Cc}]/u.test(value)) }).strict()]);
const nativePartyBaselineSchema = z.object({ organization: nativePartySchema, arAccount: nativePartySchema }).strict();

function appliedMealPlan(native: Record<string, unknown> | null): string | null {
  const value = record(native?.applied)?.mealPlan;
  if (typeof value !== 'string' || value.length > 120 || /[\p{Cc}]/u.test(value)) return null;
  // Keep exact native blank bound; whitespace-only stays unknown.
  if (value === '') return value;
  return value.trim() ? value : null;
}

function mealPlanVerified(draft: ReservationWorkflowV2Draft, compiled: CompiledAmend, native: Record<string, unknown>): boolean {
  const actual = appliedMealPlan(native), baseline = record(native.recoveryBaseline)?.beforeMealPlan;
  const requested = typeof compiled.baseChanges.requestedMealPlan === 'string' ? compiled.baseChanges.requestedMealPlan : null;
  // Blank allowance only when both observed sides are exact "" and nothing was requested.
  // Mixed blank/nonblank stays fail closed so Amend cannot clear an existing meal unrequested.
  if (actual === '' || baseline === '') {
    return actual === '' && baseline === '' && requested === null;
  }
  return actual !== null && typeof baseline === 'string' && Boolean(baseline.trim()) &&
    reservationWorkflowV2MealPlanMatches(requested === 'dinner_bb' ? 'dinner_bed_breakfast' : requested, actual, draft.propertyCode);
}

function mealMismatchObservation(draft: ReservationWorkflowV2Draft, compiled: CompiledAmend,
  native: Record<string, unknown>): ReservationWorkflowV2Observation {
  return { ref: randomUUID(), generationId: draft.generationId, kind: 'rate_availability', status: 'partial',
    observedAt: new Date().toISOString(), propertyCode: draft.propertyCode, sourceMessageId: draft.source.messageId, sourceRefs: [],
    criteria: { workflow: 'amend', stage: 'prepare', requestId: compiled.requestId, hintId: compiled.hintId, selectedRef: compiled.selectedRef,
      draftRevision: draft.revision, baseDigest: compiled.baseDigest },
    coverage: { complete: false, notes: ['native_meal_plan_mismatch_or_unknown'] },
    result: { outcome: 'meal_plan_mismatch_or_unknown', before: compiled.selected, target: compiled.target,
      requestedMealPlan: compiled.baseChanges.requestedMealPlan ?? null, applied: { mealPlan: appliedMealPlan(native) } } };
}

async function recordMealMismatch(ctx: ReadContext, input: ReservationWorkflowV2PrepareInput, compiled: CompiledAmend,
  observation: ReservationWorkflowV2Observation): Promise<Outcome> {
  const recorded = await recordObservation(ctx, input, observation, 'failed',
    'Requested meal plan needs a matching native rate', randomUUID(), compiled.hintId);
  if (recorded.status !== 'ok') return recorded;
  return { status: 'needs_input', issue: 'native_meal_plan_mismatch_or_unknown', fields: ['requestedMealPlan'],
    observationRef: observation.ref, applied: observation.result.applied };
}

function preparationObservation(draft: ReservationWorkflowV2Draft, compiled: Compile & { outcome: 'ok' },
  native: Record<string, unknown>, changes: Amendment, preserved: Record<string, unknown>, price: Record<string, unknown>,
  recoveryBaseline: Record<string, unknown>, semanticDigest: string): ReservationWorkflowV2Observation {
  const baseline = nativePartyBaselineSchema.safeParse(native.nativePartyBaseline);
  return { ref: randomUUID(), generationId: draft.generationId, kind: 'rate_availability', status: 'complete',
    observedAt: new Date().toISOString(), propertyCode: draft.propertyCode, sourceMessageId: draft.source.messageId, sourceRefs: [],
    criteria: { workflow: 'amend', requestId: compiled.requestId, hintId: compiled.hintId, selectedRef: compiled.selectedRef,
      draftRevision: draft.revision, baseDigest: compiled.baseDigest, semanticDigest,
      nativeDigest: native.nativeDigest },
    coverage: { complete: true, notes: [] },
    result: { outcome: 'prepared', before: compiled.selected, target: compiled.target, nativeChanges: changes,
      requestedMealPlan: compiled.baseChanges.requestedMealPlan ?? null, applied: { mealPlan: appliedMealPlan(native) },
      nativeDigest: native.nativeDigest, approvedPrices: price, preserved, recoveryBaseline,
      ...(baseline.success ? { nativePartyBaseline: baseline.data } : {}),
      semanticInput: { requestId: compiled.requestId, hintId: compiled.hintId, selectedRef: compiled.selectedRef,
        selected: compiled.selected, baseChanges: compiled.baseChanges, rateHandling: compiled.rateHandling,
        changes, target: compiled.target } } };
}

async function recordObservation(ctx: ReadContext, input: Input,
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

async function appendSavedBaselineHints(ctx: ReadContext, input: ReservationWorkflowV2PrepareInput,
  compiled: Compile & { outcome: 'ok' }, prepareRef: string, recorded: Awaited<ReturnType<typeof recordObservation>>) {
  if (recorded.status !== 'ok' || recorded.revision !== input.expectedRevision || recorded.seq !== input.expectedSeq) return;
  const draft = recorded.draft;
  const live = compileBase(draft, compiled.requestId, compiled.hintId, 'prepare');
  if (live.outcome !== 'ok' || live.baseDigest !== compiled.baseDigest || live.selectedRef !== compiled.selectedRef) return;
  const prepare = draft.observations.find(row => row.ref === prepareRef);
  const target = draft.observations.find(row => row.ref === compiled.selectedRef);
  if (!prepare || !target || prepare.criteria.baseDigest !== compiled.baseDigest ||
      prepare.criteria.selectedRef !== compiled.selectedRef || prepare.criteria.draftRevision !== draft.revision ||
      !draft.operationResults.some(row => row.workflow === 'amend' && row.status === 'prepared' &&
        row.requestId === compiled.requestId && row.allocationId === compiled.hintId && row.observationRefs.includes(prepareRef))) return;
  const signal = ctx.nativeBatch?.signal ?? AbortSignal.timeout(30_000);
  try {
    const hints = await loadReservationAmendBaselineAutoTransferLeads({ propertyCode: draft.propertyCode,
      source: draft.source, generationId: draft.generationId, proposal: draft.proposal, db: ctx.db,
      transportId: ctx.transport.id, signal, prepareObservation: prepare, targetObservation: target });
    for (const observation of hints) {
      const appended = await appendReservationWorkflowV2Observation(stateContext(ctx), {
        workItemId: input.workItemId, source: input.source, observation,
        ...(!ctx.nativeBatch ? { fence: { expectedRevision: input.expectedRevision, expectedSeq: input.expectedSeq,
          generationId: draft.generationId, signal } } : {}),
      });
      if (appended.status !== 'ok') break;
    }
  } catch { /* Historical guidance is optional; Prepare remains valid. */ }
}

function preparedObservation(draft: ReservationWorkflowV2Draft, compiled: Compile & { outcome: 'ok' }) {
  const rows = draft.observations.filter((observation) => observation.kind === 'rate_availability' &&
    observation.status === 'complete' && observation.generationId === draft.generationId && observation.criteria.workflow === 'amend' &&
    observation.criteria.stage !== 'callback_price_review' && observation.criteria.stage !== 'retain_callback_unsupported' &&
    observation.criteria.requestId === compiled.requestId && observation.criteria.hintId === compiled.hintId &&
    observation.criteria.selectedRef === compiled.selectedRef && observation.criteria.baseDigest === compiled.baseDigest);
  return rows.at(-1) ?? null;
}

async function lookupAmendParties(draft: ReservationWorkflowV2Draft,
  requests: AmendRequest[], transportId: string, signal?: AbortSignal) {
  const specs = {
    bookingAgency: { role: 'agency', tool: 'searchPrimaryBookingAgency', id: 'travelagencyid', name: 'travelagencyname' },
    organization: { role: 'organization', tool: 'searchOrganization', id: 'companyid', name: 'companyname' },
    arAccount: { role: 'ar_account', tool: 'searchArAccount', id: 'araccountid', name: 'araccountname' },
  } as const;
  const queries: Array<{ requestId: string; path: string; name: string; spec: typeof specs[keyof typeof specs] }> = [];
  for (const request of requests) {
    const root = ptr('proposal', 'content', 'requests', request.id, 'body');
    const sharedPath = `${root}/sharedChanges`, perPath = `${root}/perTarget`;
    const shared = effectiveLeaf(draft, sharedPath, request.body.sharedChanges);
    const perTarget = effectiveLeaf(draft, perPath, request.body.perTarget);
    const collect = (rows: unknown, path: string) => {
      if (!Array.isArray(rows)) return;
      rows.forEach((entry, index) => {
        const changePath = `${path}/${index}`, item = record(effectiveLeaf(draft, changePath, entry));
        if (!item || effectiveLeaf(draft, `${changePath}/op`, item.op) !== 'set') return;
        const field = effectiveLeaf(draft, `${changePath}/field`, item.field);
        if (typeof field !== 'string' || !Object.hasOwn(specs, field)) return;
        const valuePath = `${changePath}/value`, value = record(effectiveLeaf(draft, valuePath, item.value));
        const name = text(effectiveLeaf(draft, `${valuePath}/name`, value?.name));
        if (name) queries.push({ requestId: request.id, path: `${valuePath}/nativeSelectionRef`, name,
          spec: specs[field as keyof typeof specs] });
      });
    };
    collect(shared, sharedPath);
    if (Array.isArray(perTarget)) perTarget.forEach((entry, index) => {
      const path = `${perPath}/${index}`, row = record(effectiveLeaf(draft, path, entry));
      if (row) collect(effectiveLeaf(draft, `${path}/changes`, row.changes), `${path}/changes`);
    });
  }
  if (!queries.length) return { observations: [] as ReservationWorkflowV2Observation[], lookups: [] as Record<string, unknown>[] };
  const tool = await import(new URL('../../tooling/hms-cloud/booking-lookup-session.mjs', import.meta.url).href) as {
    withBookingLookupSession: (operation: (session: { runTool: (request: Record<string, unknown>) => Promise<Record<string, unknown>> }) =>
      Promise<unknown>, options?: Record<string, unknown>) => Promise<unknown>;
  };
  return await tool.withBookingLookupSession(async ({ runTool }) => {
    const observations: ReservationWorkflowV2Observation[] = [], lookups: Record<string, unknown>[] = [];
    for (const query of queries) {
      let nativeQuery = query.name, found = await runTool({ tool: query.spec.tool, query: nativeQuery });
      const searchesTried = [{ query: nativeQuery, outcome: found.outcome }];
      if (found.outcome === 'no_match') for (const term of partyMatchSearchTerms(query.name).filter(term => term !== query.name).slice(0, 2)) {
        nativeQuery = term;
        found = await runTool({ tool: query.spec.tool, query: nativeQuery });
        searchesTried.push({ query: nativeQuery, outcome: found.outcome });
        if (found.outcome !== 'no_match') break;
      }
      const closed = await runTool({ tool: 'closeGuestStayPartyPicker', propertyCode: draft.propertyCode });
      if (closed.outcome !== 'closed_unsaved') throw new Error('PARTY_PICKER_CLOSE_UNVERIFIED');
      const coverage = record(found.coverage), verifiedFields = verifiedNativeFields(found), criteria = record(found.criteria);
      const candidates = Array.isArray(found.candidates) ? found.candidates.map(record).filter(Boolean) : [];
      const projected = partyCandidateViews(candidates, query.spec.role, verifiedFields);
      const complete = ['matches', 'no_match'].includes(String(found.outcome)) && typeof found.searchId === 'string' &&
        criteria?.query === nativeQuery && coverage?.possiblyTruncated === false && typeof coverage.loaded === 'number' && Number.isInteger(coverage.loaded) &&
        candidates.length === coverage.loaded && verifiedFields.includes(query.spec.id) && verifiedFields.includes(query.spec.name) && projected.valid;
      projected.rows.sort((left, right) => Number(reservationEntityKey(String(right.name), query.spec.role) === reservationEntityKey(query.name, query.spec.role)) -
        Number(reservationEntityKey(String(left.name), query.spec.role) === reservationEntityKey(query.name, query.spec.role)));
      const entries = projected.rows.length ? projected.rows : [null];
      if (typeof found.searchId === 'string' && ['matches', 'no_match'].includes(String(found.outcome))) {
        entries.forEach((candidate, candidateIndex) => observations.push({ ref: randomUUID(), generationId: draft.generationId,
          kind: 'party_candidate', status: complete ? 'complete' : 'partial', observedAt: new Date().toISOString(),
          propertyCode: draft.propertyCode, sourceMessageId: draft.source.messageId, sourceRefs: [],
          criteria: { workflow: 'amend', kind: 'party_name', requestId: query.requestId,
            role: query.spec.role === 'agency' ? 'bookingAgency' : query.spec.role,
            fieldPaths: [query.path], query: query.name, nativeQuery, searchesTried, candidateIndex, coverage,
            correlation: { verifiedFields } }, coverage: { complete, notes: complete ? [] : ['native_party_lookup_incomplete'] },
          result: { outcome: found.outcome, criteria, coverage, correlation: { verifiedFields }, candidates: candidate ? [candidate] : [] } }));
      }
      lookups.push({ requestId: query.requestId, selectionPath: query.path, status: complete ? found.outcome : 'partial',
        candidates: projected.rows });
    }
    return { observations, lookups };
  }, { propertyCode: draft.propertyCode, transportId, memory: null, blockServiceWorkers: true, signal }) as { observations: ReservationWorkflowV2Observation[]; lookups: Record<string, unknown>[] };
}

export async function reservationWorkflowV2AmendLookup(ctx: ReadContext,
  input: ReservationWorkflowV2LookupInput): Promise<Outcome> {
  if (!paneStayLookupEnabled()) return { status: 'needs_input', issue: 'stay_lookup_disabled' };
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return loaded.result;
  if (!getPropertyRegistration(ctx.property.propertyCode)?.active || loaded.draft.propertyCode !== ctx.property.propertyCode) {
    return { status: 'unsupported', issue: 'property_not_supported' };
  }
  const requests = loaded.draft.proposal.content.requests.filter((request): request is AmendRequest =>
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
    const exclusionPath = `${targetsPath}/exclude`;
    const exclude = effectiveTree(loaded.draft, exclusionPath, targets?.exclude, unknownPaths);
    const unknownExclusionPaths = unknownTargetExclusionIdentityPaths(unknownPaths, exclusionPath);
    if (!body || !targets || include === UNKNOWN) {
      lookups.push({ requestId: request.id, status: 'needs_input', issue: 'amend_target_hints_unknown', fields: [...unknownPaths] });
      continue;
    }
    if (unknownExclusionPaths.length || !Array.isArray(exclude)) {
      lookups.push({ requestId: request.id, status: 'needs_input', issue: 'amend_target_exclusion_identity_unresolved',
        fields: [exclusionPath, ...unknownExclusionPaths] });
      continue;
    }
    const targetExclusions = resolveTargetExclusions(loaded.draft, exclusionPath, exclude, unknownPaths);
    if (targetExclusions.issue) {
      lookups.push({ requestId: request.id, status: 'needs_input', issue: 'amend_target_exclusion_identity_unresolved',
        fields: [exclusionPath, ...targetExclusions.fields] });
      continue;
    }
    const unknownOtherPaths = unknownPathsOutsideTargetExclusions(unknownPaths, exclusionPath);
    if (unknownOtherPaths.length) {
      lookups.push({ requestId: request.id, status: 'needs_input', issue: 'amend_target_hints_unknown', fields: unknownOtherPaths });
      continue;
    }
    if ((mode !== 'explicit' && mode !== 'unresolved') || !Array.isArray(include) || !include.length) {
      lookups.push({ requestId: request.id, status: 'needs_input', issue: 'amend_target_scope_unresolved' });
      continue;
    }
    for (const [index, value] of include.entries()) {
      const hintPath = `${includePath}/${index}`;
      const rawHint = record(effectiveLeaf(loaded.draft, hintPath, value));
      const hintUnknownPaths = new Set<string>();
      // Lookup consumes identity hints only. Candidate refs and change/pricing decisions
      // belong to later stages and must not prevent read-only native discovery.
      const hint = rawHint && normalizedTargetHint(Object.fromEntries(['id', 'confirmation', 'guestName', 'bookedArrival', 'bookedDeparture'].map((key) =>
        [key, effectiveTree(loaded.draft, `${hintPath}/${key}`, rawHint[key], hintUnknownPaths)])));
      const hintId = text(hint?.id);
      if (!hint || !hintId) { lookups.push({ requestId: request.id, status: 'needs_input', issue: 'saved_target_hint_invalid' }); continue; }
      const sameHintExclusion = targetExclusions.rows.find((row) => text(row.hint.id) === hintId);
      if (sameHintExclusion) {
        lookups.push({ requestId: request.id, hintId, status: 'needs_input', issue: 'amend_target_excluded_by_scope',
          fields: [exclusionPath, `${exclusionPath}/${sameHintExclusion.index}`] });
        continue;
      }
      if (hintUnknownPaths.size) {
        lookups.push({ requestId: request.id, hintId, status: 'needs_input', issue: 'amend_target_hints_unknown', fields: [...hintUnknownPaths] });
        continue;
      }
      const selectionPath = ptr('proposal', 'content', 'requests', request.id, 'body', 'targets', 'include', index, 'suggestedRef');
      const result = await lookupHint(loaded.draft, target, request.id, hintId, hint, selectionPath, ctx.nativeBatch?.signal, ctx.transport.id);
      const checkedRows = result.rows.map((row) => ({ row,
        issue: auditTargetExclusions(row.native as unknown as Record<string, unknown>, targetExclusions, exclusionPath) }));
      const safeRows = checkedRows.filter((entry) => !entry.issue).map((entry) => entry.row);
      const blockedRows = checkedRows.filter((entry) => Boolean(entry.issue));
      const firstBlocked = blockedRows[0]?.issue;
      if (!safeRows.length && firstBlocked) {
        const blocked = firstBlocked;
        lookups.push({ requestId: request.id, hintId, status: 'needs_input', issue: blocked.issue, fields: blocked.fields,
          ...(blocked.hintId ? { excludedHintId: blocked.hintId } : {}), selectionPath });
        continue;
      }
      observations.push(...safeRows.map((row) => row.observation));
      if (result.observation) observations.push(result.observation);
      lookups.push({ requestId: request.id, hintId, status: safeRows.length ? 'matches' : 'partial',
        ...(result.observation ? { issue: result.observation.result.issue } : {}),
        ...(result.observation?.result.issue === 'guest_name_hint_mismatch' ? { fields: [`${hintPath}/guestName`] } : {}),
        ...(blockedRows.length ? { excludedCandidateCount: blockedRows.length } : {}),
        selectionPath, candidates: safeRows.map(({ observation, native }) => ({ ref: observation.ref,
          confirmation: native.confirmation, guestName: `${native.firstName} ${native.lastName}`,
          bookedArrival: native.arrival, bookedDeparture: native.departure,
          roomType: native.roomType, ratePlan: native.ratePlan })) });
    }
  }
  try {
    const parties = await lookupAmendParties(loaded.draft, requests, ctx.transport.id, ctx.nativeBatch?.signal);
    observations.push(...parties.observations);
    lookups.push(...parties.lookups);
  } catch {
    return { status: 'failed', issue: 'native_amend_party_lookup_failed', lookups };
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

type CompiledAmend = Extract<Compile, { outcome: 'ok' }>;
const partyOrder = ['organization', 'bookingAgency', 'arAccount'] as const;
function callbackRequested(compiled: CompiledAmend) {
  return partyOrder.some(field => Object.hasOwn(compiled.baseChanges, field)) ||
    (typeof compiled.baseChanges.guaranteeType === 'string' && compiled.baseChanges.guaranteeType !== compiled.selected.guaranteeCode) ||
    (Object.hasOwn(compiled.baseChanges, 'children') && (compiled.target.children !== compiled.selected.children ||
      !sameChildAges(compiled.target.childAges, compiled.selected.childAges)));
}

/**
 * Guarantee, Organization, Primary Booking Agency, A/R Account and child-age changes fire saved-stay
 * callbacks that HMS may keep before Save, and HMS only shows the repriced total after them. Until a
 * no-persistence preview exists, Nava must not fire them before staff have seen HMS's price and pressed Go.
 */
function callbackPriceBeforeWriteAvailable(): boolean { return false; }
const CALLBACK_FINISH_IN_HMS = 'amend_callback_change_finish_in_hms';
function callbackFields(plan: { guarantee: unknown; parties: Array<Record<string, unknown>>; children: unknown }) {
  return [...(plan.guarantee ? ['guaranteeType'] : []), ...plan.parties.map(party => String(party.kind)),
    ...(plan.children ? ['childAges'] : [])];
}
function compiledCallbackFields(compiled: CompiledAmend) {
  return [...(typeof compiled.baseChanges.guaranteeType === 'string' &&
      compiled.baseChanges.guaranteeType !== compiled.selected.guaranteeCode ? ['guaranteeType'] : []),
    ...partyOrder.filter(field => Object.hasOwn(compiled.baseChanges, field)),
    ...(Object.hasOwn(compiled.baseChanges, 'children') && (compiled.target.children !== compiled.selected.children ||
      !sameChildAges(compiled.target.childAges, compiled.selected.childAges)) ? ['childAges'] : [])];
}

function portablePartyImage(value: unknown): Record<string, unknown> | null {
  const image = record(value), data = record(image?.data), values = record(image?.values);
  if (!data || !values) return null;
  return { data: Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'bookingsessionid')),
    values: Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'bookingsessionid')) };
}

/** Read the prospective native controls without dispatching any saved-stay callback. */
async function prepareCallbackAmend(ctx: ReadContext, input: ReservationWorkflowV2PrepareInput,
  draft: ReservationWorkflowV2Draft, compiled: CompiledAmend): Promise<Outcome> {
  const locked = targetWriteLock(ctx, compiled.selected);
  if (!locked?.lock) return { status: 'unsupported', issue: 'amend_target_lock_unavailable' };
  const native = await nativeModule(), dispatchKey = hmsDispatchTargetKey(locked.dispatchTarget);
  try {
    const prepared = await locked.lock.withLock(async () => {
      const common = { target: locked.target, transportId: ctx.transport.id, selected: compiled.selected, confirmation: compiled.selected.confirmation,
        arrival: compiled.selected.arrival, allowRealGuest: true, cloudTargetKey: dispatchKey,
        signal: ctx.nativeBatch?.signal ?? AbortSignal.timeout(8 * 60_000), capturePriceComponents: true, captureMealPlan: true };
      const read = await native.readCloudSavedChildAges(common);
      if (read.outcome !== 'ok' || !Array.isArray(read.ages) || read.ages.length !== compiled.selected.children ||
          read.ages.some(age => !Number.isInteger(age) || age < 0 || age > 17)) return { issue: 'amend_child_age_baseline_unavailable' };
      const beforeAges = read.ages as number[];
      if (Array.isArray(compiled.selected.childAges) &&
          canonicalJson([...compiled.selected.childAges].sort((a, b) => a - b)) !== canonicalJson([...beforeAges].sort((a, b) => a - b))) {
        return { issue: 'amend_child_age_baseline_changed' };
      }
      if (compiled.target.childAges === 'unknown') compiled.target.childAges = beforeAges;
      const safeBase = Object.fromEntries(Object.entries(compiled.baseChanges).filter(([field]) =>
        !['children', 'childAges', 'bookingAgency', 'organization', 'arAccount', 'guaranteeType',
          ...(Object.hasOwn(compiled.baseChanges, 'bookingAgency') ? ['taCommission'] : []),
          ...(Object.hasOwn(compiled.baseChanges, 'arAccount') ? ['billingReference'] : [])].includes(field)));
      const discoveryBase = Object.fromEntries(Object.entries(safeBase).filter(([field]) =>
        !['bookerEmail', 'bookerMobile', 'taCommission', 'guestOptIn', 'requestedMealPlan'].includes(field)));
      const discoveryChanges = { ...discoveryBase, ratePlan: String(safeBase.ratePlan ?? compiled.selected.ratePlan),
        retainRates: compiled.rateHandling === 'retain' ? 'yes' : 'no', cmsSend: false, cmsMessageId: '', cmsRecipient: '' };
      const guaranteeCode = typeof compiled.baseChanges.guaranteeType === 'string'
        ? compiled.baseChanges.guaranteeType : compiled.selected.guaranteeCode;
      if (typeof guaranteeCode !== 'string') return { issue: 'amend_guarantee_baseline_unavailable' };
      const discovery = await native.prepareCloudPaneAmend({ ...common, childAgePreimage: beforeAges,
        changes: discoveryChanges, discoveryOnly: true, guaranteeChoiceCode: guaranteeCode,
        captureCommissionBaseline: Object.hasOwn(safeBase, 'taCommission'),
        captureGuestOptInBaseline: Object.hasOwn(safeBase, 'guestOptIn') });
      const baseline = record(discovery.recoveryBaseline), preserved = record(discovery.preserved);
      if (discovery.outcome !== 'prepared' || !baseline || !preserved || typeof baseline.beforeNote !== 'string' ||
          typeof baseline.beforeGuaranteeCode !== 'string' || typeof baseline.beforeGuaranteeDisplay !== 'string' ||
          (typeof compiled.baseChanges.guaranteeType === 'string' && typeof baseline.requestedGuaranteeDisplay !== 'string')) {
        return { issue: 'native_amend_baseline_unavailable' };
      }
      if (Object.hasOwn(compiled.baseChanges, 'reservationNote')) {
        const observation = draft.observations.find(item => item.ref === compiled.selectedRef);
        const note = record(record(record(observation?.result)?.reservationObservations)?.reservationNote);
        if (!note || !['observed', 'blank'].includes(String(note.state)) || note.source !== 'record_view_raw_value' ||
            note.confirmation !== compiled.selected.confirmation || note.value !== baseline.beforeNote) {
          return { issue: 'native_amend_reservation_note_changed_or_unavailable' };
        }
      }
      const childrenChanged = Object.hasOwn(compiled.baseChanges, 'children') &&
        (compiled.target.children !== compiled.selected.children || !sameChildAges(compiled.target.childAges, beforeAges));
      const guaranteeChanged = typeof compiled.baseChanges.guaranteeType === 'string' &&
        compiled.baseChanges.guaranteeType !== baseline.beforeGuaranteeCode;
      if (compiled.rateHandling === 'retain' && (childrenChanged || guaranteeChanged)) {
        return { issue: 'retained_rate_not_supported_for_priced_amendment', retainCallback: true };
      }
      const safeCompiled = { ...compiled, baseChanges: safeBase }, safeChanges = normalizedChanges(safeCompiled, preserved, baseline);
      const allChanges = normalizedChanges(compiled, preserved, baseline);
      if (!safeChanges || !allChanges) return { issue: 'native_amend_contact_or_cms_baseline_unavailable' };
      const staged = await native.prepareCloudPaneAmend({ ...common, childAgePreimage: beforeAges, changes: safeChanges,
        captureCommissionBaseline: Object.hasOwn(safeBase, 'taCommission'),
        captureGuestOptInBaseline: Object.hasOwn(safeBase, 'guestOptIn') });
      const price = nativePrice(staged.approvedPrices), stagedBaseline = record(staged.recoveryBaseline), stagedPreserved = record(staged.preserved);
      if (staged.outcome !== 'prepared' || !price || !stagedBaseline || !stagedPreserved ||
          typeof staged.nativeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(staged.nativeDigest) ||
          canonicalJson(Object.fromEntries(Object.entries(stagedPreserved).filter(([key]) =>
            key !== 'bookerContact' || Object.hasOwn(preserved, key)))) !== canonicalJson(preserved) ||
          stagedBaseline.beforeNote !== baseline.beforeNote || stagedBaseline.beforeGuaranteeCode !== baseline.beforeGuaranteeCode ||
          canonicalJson(stagedBaseline.beforeParties) !== canonicalJson(baseline.beforeParties)) {
        return { issue: 'native_amend_prepare_unverified' };
      }
      const nextAges = childrenChanged && Array.isArray(compiled.target.childAges) ? compiled.target.childAges as number[] : null;
      if (childrenChanged) {
        if (!nextAges) return { issue: 'child_ages_required_for_occupancy_change' };
        const preview = await native.previewCloudPaneAmendChildren({ ...common, beforeChildAges: beforeAges, childAges: nextAges });
        if (preview.outcome !== 'ok' || canonicalJson(record(preview.before)?.ages) !== canonicalJson(beforeAges) ||
            canonicalJson(record(preview.requested)?.childAges) !== canonicalJson(nextAges)) {
          return { issue: 'native_child_age_preview_unavailable' };
        }
      }
      const requestedParties = partyOrder.flatMap(kind => {
        const item = record(compiled.baseChanges[kind]);
        return item ? [{ kind, nativeId: String(item.nativeId), name: String(item.name), query: String(item.query) }] : [];
      });
      let beforeImage: Record<string, unknown> | null = null;
      const parties: Array<Record<string, unknown>> = [];
      if (requestedParties.length) {
        const found = await native.inspectCloudPaneAmendParties({ ...common,
          queries: requestedParties.map(({ kind, query }) => ({ kind, query })) });
        if (found.outcome !== 'ok' || !Array.isArray(found.observations) || found.observations.length !== requestedParties.length) {
          return { issue: 'native_amend_party_preview_unavailable' };
        }
        for (const wanted of requestedParties) {
          const matches = found.observations.map(record).filter(item => item?.kind === wanted.kind && item.query === wanted.query);
          const observed = matches.length === 1 ? matches[0] : null, coverage = record(observed?.coverage);
          const choices = Array.isArray(observed?.candidates) ? observed.candidates.map(record).filter(item =>
            item?.nativeId === wanted.nativeId && item.name === wanted.name) : [];
          const image = portablePartyImage(observed?.beforeImage);
          if (!observed || coverage?.complete !== true || coverage.nativeResponseCorrelated !== true || choices.length !== 1 ||
              !image || (beforeImage && canonicalJson(beforeImage) !== canonicalJson(image))) {
            return { issue: 'native_amend_party_candidate_unavailable' };
          }
          beforeImage ??= image;
          const beforeParties = record(baseline.beforeParties);
          const fields = wanted.kind === 'organization' ? ['companyid', 'company'] : wanted.kind === 'bookingAgency'
            ? ['taid1', 'ta1'] : ['araccountid', 'araccountname'];
          if (beforeParties?.[fields[0]!] === wanted.nativeId && beforeParties[fields[1]!] === wanted.name) continue;
          const choice = choices[0]!;
          let expectedEffects: Record<string, string> | undefined;
          if (wanted.kind === 'bookingAgency' && choice.payCommissionFlag === '-1') {
            const percent = choice.commissionPercentage;
            if (typeof percent !== 'string' || !/^(?:0|[1-9]\d?)(?:\.\d+)?$|^100(?:\.0+)?$/.test(percent)) {
              return { issue: 'native_agency_commission_default_unverified' };
            }
            expectedEffects = { ta1commission: percent };
          }
          parties.push({ ...wanted, ...(expectedEffects ? { expectedEffects } : {}) });
        }
      }
      const guarantee = typeof compiled.baseChanges.guaranteeType === 'string' &&
        compiled.baseChanges.guaranteeType !== baseline.beforeGuaranteeCode ? { code: compiled.baseChanges.guaranteeType,
          display: baseline.requestedGuaranteeDisplay, before: { code: baseline.beforeGuaranteeCode, display: baseline.beforeGuaranteeDisplay } } : null;
      const expected = { propertyCode: compiled.selected.propertyCode, confirmation: compiled.selected.confirmation, guestId: compiled.selected.guestId,
        reservationStayId: compiled.selected.reservationStayId, reservationId: compiled.selected.reservationId,
        recordId: compiled.selected.recordId, firstName: compiled.selected.firstName, lastName: compiled.selected.lastName,
        arrival: compiled.selected.arrival, departure: compiled.selected.departure, roomType: compiled.selected.roomType,
        ratePlan: compiled.selected.ratePlan, note: baseline.beforeNote, adults: compiled.selected.adults,
        childCount: compiled.selected.children, childAges: beforeAges,
        expectedGuarantee: { code: baseline.beforeGuaranteeCode, display: baseline.beforeGuaranteeDisplay } };
      const plan = { selected: compiled.selected, expected, guarantee, parties,
        children: nextAges ? { beforeAges, nextAges } : null, beforeImage: parties.length ? beforeImage : null };
      if (!guarantee && parties.length === 0 && !nextAges) {
        const ordinaryBase = Object.fromEntries(Object.entries(compiled.baseChanges).filter(([field]) =>
          !['children', 'childAges', 'bookingAgency', 'organization', 'arAccount', 'guaranteeType'].includes(field)));
        const ordinaryChanges = normalizedChanges({ ...compiled, baseChanges: ordinaryBase }, preserved, baseline);
        if (!ordinaryChanges) return { issue: 'native_amend_contact_or_cms_baseline_unavailable' };
        const ordinary = await native.prepareCloudPaneAmend({ ...common, childAgePreimage: beforeAges, changes: ordinaryChanges,
          captureCommissionBaseline: Object.hasOwn(ordinaryBase, 'taCommission'),
          captureGuestOptInBaseline: Object.hasOwn(ordinaryBase, 'guestOptIn') });
        const ordinaryPrice = nativePrice(ordinary.approvedPrices), ordinaryBaseline = record(ordinary.recoveryBaseline),
          ordinaryPreserved = record(ordinary.preserved);
        if (ordinary.outcome !== 'prepared' || !ordinaryPrice || !ordinaryBaseline || !ordinaryPreserved ||
            typeof ordinary.nativeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(ordinary.nativeDigest) ||
            ordinaryBaseline.beforeNote !== baseline.beforeNote || ordinaryBaseline.beforeGuaranteeCode !== baseline.beforeGuaranteeCode ||
            canonicalJson(ordinaryBaseline.beforeParties) !== canonicalJson(baseline.beforeParties) ||
            canonicalJson(Object.fromEntries(Object.entries(ordinaryPreserved).filter(([key]) =>
              key !== 'bookerContact' || Object.hasOwn(preserved, key)))) !== canonicalJson(preserved) ||
            (Object.hasOwn(ordinaryChanges, 'taCommission') && (typeof ordinaryBaseline.beforeCommission !== 'number' ||
              !Number.isFinite(ordinaryBaseline.beforeCommission) || !record(ordinaryPreserved.bookingAgency)?.nativeId)) ||
            (Object.hasOwn(ordinaryChanges, 'guestOptIn') && typeof ordinaryBaseline.beforeGuestOptIn !== 'boolean')) {
          return { issue: 'native_amend_prepare_unverified' };
        }
        if (!mealPlanVerified(draft, compiled, ordinary)) return { issue: 'native_meal_plan_mismatch_or_unknown', mealObservation: mealMismatchObservation(draft, compiled, ordinary) };
        const recoveryBaseline = { ...ordinaryBaseline, beforeChildAges: beforeAges };
        const semanticDigest = sha256({ baseDigest: compiled.baseDigest, selectedRef: compiled.selectedRef,
          selected: compiled.selected, target: compiled.target, changes: ordinaryChanges, preserved: ordinaryPreserved,
          recoveryBaseline, nativeDigest: ordinary.nativeDigest, price: ordinaryPrice, appliedMealPlan: appliedMealPlan(ordinary) });
        const observation = preparationObservation(draft, compiled, ordinary, ordinaryChanges, ordinaryPreserved, ordinaryPrice, recoveryBaseline, semanticDigest);
        observation.result = { ...observation.result, callbackNoop: true };
        return { observation, price: ordinaryPrice, plan: null, semanticDigest, noop: true };
      }
      if (compiled.rateHandling === 'retain') return { issue: 'retained_rate_not_supported_for_priced_amendment', retainCallback: true };
      // Fail closed before any persistent callback can be authorized: the staged price above excludes them.
      if (!callbackPriceBeforeWriteAvailable()) return { issue: CALLBACK_FINISH_IN_HMS, finishInHmsFields: callbackFields(plan) };
      if (!mealPlanVerified(draft, compiled, staged)) return { issue: 'native_meal_plan_mismatch_or_unknown', mealObservation: mealMismatchObservation(draft, compiled, staged) };
      const planDigest = sha256(plan);
      const recoveryBaseline = { ...stagedBaseline, beforeChildAges: beforeAges,
        beforeGuaranteeDisplay: baseline.beforeGuaranteeDisplay, beforeGuaranteePrice: baseline.beforeGuaranteePrice,
        ...(typeof baseline.requestedGuaranteeDisplay === 'string' ? { requestedGuaranteeDisplay: baseline.requestedGuaranteeDisplay } : {}) };
      const semanticDigest = sha256({ baseDigest: compiled.baseDigest, selectedRef: compiled.selectedRef,
        selected: compiled.selected, target: compiled.target, changes: allChanges, safeChanges,
        preserved: stagedPreserved, recoveryBaseline, nativeDigest: staged.nativeDigest, price, planDigest, appliedMealPlan: appliedMealPlan(staged) });
      const observation = preparationObservation(draft, compiled, staged, allChanges, stagedPreserved, price, recoveryBaseline, semanticDigest);
      observation.result = { ...observation.result, callbackPriceReviewRequired: true, priceKind: 'indicative',
        callbackPlan: plan, callbackPlanDigest: planDigest, safeChanges };
      return { observation, price, plan, semanticDigest, noop: false };
    }, { ...acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS), signal: ctx.nativeBatch?.signal });
    if ('issue' in prepared) {
      if ('mealObservation' in prepared && prepared.mealObservation) return recordMealMismatch(ctx, input, compiled, prepared.mealObservation);
      if ('finishInHmsFields' in prepared && Array.isArray(prepared.finishInHmsFields)) {
        return { status: 'unsupported', issue: prepared.issue, fields: prepared.finishInHmsFields };
      }
      if ('retainCallback' in prepared && prepared.retainCallback === true) {
        const observation: ReservationWorkflowV2Observation = { ref: randomUUID(), generationId: draft.generationId,
          kind: 'rate_availability', status: 'complete', observedAt: new Date().toISOString(), propertyCode: draft.propertyCode,
          sourceMessageId: draft.source.messageId, sourceRefs: [], coverage: { complete: true, notes: [] },
          criteria: { workflow: 'amend', stage: 'retain_callback_unsupported', requestId: compiled.requestId,
            hintId: compiled.hintId, selectedRef: compiled.selectedRef, baseDigest: compiled.baseDigest },
          result: { outcome: 'retain_callback_unsupported' } };
        const recorded = await recordObservation(ctx, input, observation, 'failed',
          'Retaining rates is unavailable for this native amendment', randomUUID(), compiled.hintId);
        if (recorded.status !== 'ok') return recorded;
        return { status: 'unsupported', issue: prepared.issue, fields: ['rateHandling'] };
      }
      return { status: 'failed', issue: prepared.issue };
    }
    const recorded = await recordObservation(ctx, input, prepared.observation, 'prepared',
      prepared.noop ? 'HMS amendment staged unsaved; native price and baseline observed' :
        'Native controls checked; the first Go may apply details before price review', randomUUID(), compiled.hintId);
    if (recorded.status !== 'ok') return recorded;
    await appendSavedBaselineHints(ctx, input, compiled, prepared.observation.ref, recorded);
    if (prepared.noop) return { status: 'prepared', requestId: input.requestId, allocationId: compiled.hintId,
      observationRef: prepared.observation.ref, target: compiled.target, before: compiled.selected,
      price: prepared.price, semanticDigest: prepared.semanticDigest };
    return { status: 'prepared', requestId: input.requestId, allocationId: compiled.hintId,
      observationRef: prepared.observation.ref, target: compiled.target, before: compiled.selected,
      price: prepared.price, priceKind: 'indicative', callbackPriceReviewRequired: true,
      callbackPlan: prepared.plan, semanticDigest: prepared.semanticDigest };
  } catch (error) {
    return { status: 'failed', issue: isPropertyReadLockDeadline(error) ? 'amend_lock_busy' : 'native_amend_prepare_failed' };
  }
}

type CallbackReviewState = (Outcome & { status: 'needs_reconcile' }) | (Outcome & {
  status: 'needs_review';
  financialReview: { required: true; accepted: boolean; observationRef: string; approvalDigest: string;
    reviewFieldPath: string; reviewNote: string };
  observation: ReservationWorkflowV2Observation;
});

function callbackReviewState(draft: ReservationWorkflowV2Draft, compiled: CompiledAmend): CallbackReviewState | null {
  const reviewOperations = draft.operationResults.filter(operation => operation.workflow === 'amend' && operation.status === 'prepared' &&
    operation.generationId === draft.generationId && operation.requestId === compiled.requestId && operation.allocationId === compiled.hintId &&
    operation.summary === 'Native details may have changed; review the refreshed price before Save');
  const entries = reviewOperations
    .flatMap(operation => operation.observationRefs.flatMap(ref => {
      const observation = draft.observations.find(item => item.ref === ref && item.kind === 'rate_availability' &&
        item.criteria.workflow === 'amend' && item.criteria.stage === 'callback_price_review');
      return observation ? [{ operation, observation }] : [];
    }));
  if (!entries.length) return reviewOperations.length ? { status: 'needs_reconcile', operationId: reviewOperations[0]!.id,
    issue: 'amend_callback_review_unavailable' } : null;
  if (entries.length !== 1) return { status: 'needs_reconcile', issue: 'amend_multiple_callback_reviews' };
  const { operation, observation } = entries[0]!, result = record(observation.result), price = nativePrice(result?.price);
  if (observation.status !== 'complete' || !observation.coverage.complete || observation.generationId !== draft.generationId ||
      observation.propertyCode !== draft.propertyCode || observation.sourceMessageId !== draft.source.messageId ||
      observation.criteria.requestId !== compiled.requestId || observation.criteria.hintId !== compiled.hintId ||
      observation.criteria.selectedRef !== compiled.selectedRef || observation.criteria.baseDigest !== compiled.baseDigest ||
      result?.outcome !== 'callback_price_review' || result.ready !== true || !price || !appliedMealPlan(result) ||
      result.requestedMealPlan !== (compiled.baseChanges.requestedMealPlan ?? null) ||
      typeof result.approvalDigest !== 'string' || !/^[a-f0-9]{64}$/.test(result.approvalDigest) ||
      !record(result.callbackState) || !record(result.target) || !record(result.before) ||
      result.approvalDigest !== sha256({ stage: 'callback_price_review', requestId: compiled.requestId, hintId: compiled.hintId,
        selectedRef: compiled.selectedRef, baseDigest: compiled.baseDigest, semanticDigest: observation.criteria.semanticDigest,
        price, applied: result.applied, requestedMealPlan: result.requestedMealPlan, callbackState: result.callbackState, before: result.before, target: result.target,
        callbackPlanDigest: result.callbackPlanDigest, prepareObservationRef: result.prepareObservationRef,
        freshReadback: result.freshReadback })) {
    return { status: 'needs_reconcile', operationId: operation.id, issue: 'amend_callback_review_stale' };
  }
  const request = requestBody(draft, compiled.requestId)?.request;
  const perPath = `${compiled.requestPath}/perTarget`, rows = effectiveLeaf(draft, perPath, request?.body.perTarget);
  if (!Array.isArray(rows)) return { status: 'needs_reconcile', operationId: operation.id, issue: 'amend_callback_review_target_changed' };
  const index = rows.findIndex(row => record(row)?.hintId === compiled.hintId);
  if (index < 0) return { status: 'needs_reconcile', operationId: operation.id, issue: 'amend_callback_review_target_changed' };
  const refsPath = `${perPath}/${index}/currentObservationRefs`, row = record(rows[index]);
  const refs = effectiveRefList(draft, refsPath, row?.currentObservationRefs);
  if (!Array.isArray(refs) || refs.some(ref => typeof ref !== 'string')) {
    return { status: 'needs_reconcile', operationId: operation.id, issue: 'amend_callback_review_binding_invalid' };
  }
  const indexes = refs.flatMap((ref, i) => ref === observation.ref ? [i] : []);
  if (indexes.length > 1) return { status: 'needs_reconcile', operationId: operation.id, issue: 'amend_callback_review_binding_invalid' };
  const reviewFieldPath = `${refsPath}/${indexes[0] ?? refs.length}`;
  const reviewNote = `amend-price:${observation.ref}:${result.approvalDigest}`;
  const review = draft.staffReviews[reviewFieldPath];
  const accepted = indexes.length === 1 && review?.status === 'accepted' && review.note === reviewNote;
  return { status: 'needs_review', issue: 'amend_applied_price_requires_second_go', operationId: operation.id,
    requestId: compiled.requestId, allocationId: compiled.hintId, confirmation: compiled.selected.confirmation,
    price, callbackState: result.callbackState, financialReview: { required: true, accepted, observationRef: observation.ref,
      approvalDigest: result.approvalDigest, reviewFieldPath, reviewNote }, observation };
}

/** Project only a fully checked callback review, using the same selector as the second Go. */
export function reservationWorkflowV2AmendReviewView(draft: ReservationWorkflowV2Draft,
  requestId: string, allocationId: string) {
  const compiled = compileBase(draft, requestId, allocationId, 'prepare');
  return compiled.outcome === 'ok' ? callbackReviewState(draft, compiled) : null;
}

export async function reservationWorkflowV2AmendPrepare(ctx: ReadContext,
  input: ReservationWorkflowV2PrepareInput): Promise<Outcome> {
  if (!paneStayLookupEnabled()) return { status: 'needs_input', issue: 'stay_lookup_disabled' };
  if (!input.allocationId) return { status: 'needs_input', issue: 'amend_target_required' };
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return loaded.result;
  const compiled = compileBase(loaded.draft, input.requestId, input.allocationId, 'prepare');
  if (compiled.outcome !== 'ok') return { status: compiled.outcome, issue: compiled.issue, fields: compiled.fields ?? [] };
  const pending = callbackReviewState(loaded.draft, compiled);
  if (pending) return pending;
  const unresolved = loaded.draft.operationResults.find(item => item.workflow === 'amend' && item.requestId === compiled.requestId &&
    item.allocationId === compiled.hintId && item.status === 'unknown');
  if (unresolved) return { status: 'needs_reconcile', operationId: unresolved.id };
  if (typeof compiled.baseChanges.guaranteeType === 'string') {
    return { status: 'unsupported', issue: 'amend_guarantee_change_finish_in_hms', fields: ['guaranteeType'] };
  }
  if (callbackRequested(compiled)) return prepareCallbackAmend(ctx, input, loaded.draft, compiled);
  const locked = targetWriteLock(ctx, compiled.selected);
  if (!locked?.lock) return { status: 'unsupported', issue: 'amend_target_lock_unavailable' };
  const module = await nativeModule();
  const dispatchKey = hmsDispatchTargetKey(locked.dispatchTarget);
  const discoveryBase = Object.fromEntries(Object.entries(compiled.baseChanges)
    .filter(([field]) => !['bookerEmail', 'bookerMobile', 'taCommission', 'guestOptIn', 'guaranteeType', 'requestedMealPlan'].includes(field)));
  const discoveryChanges = { ...discoveryBase, ratePlan: String(compiled.baseChanges.ratePlan ?? compiled.selected.ratePlan),
    retainRates: compiled.rateHandling === 'retain' ? 'yes' : 'no', cmsSend: false, cmsMessageId: '', cmsRecipient: '' };
  try {
    const prepared = await locked.lock.withLock(async () => {
      ctx.nativeBatch?.signal.throwIfAborted();
      let childAgePreimage: number[] | undefined;
      {
        const read = await module.readCloudSavedChildAges({ target: locked.target, transportId: ctx.transport.id, selected: compiled.selected,
          confirmation: compiled.selected.confirmation, arrival: compiled.selected.arrival, allowRealGuest: true,
          cloudTargetKey: dispatchKey, signal: ctx.nativeBatch?.signal ?? AbortSignal.timeout(8 * 60_000) });
        if (read.outcome !== 'ok' || !Array.isArray(read.ages) || read.ages.length !== compiled.selected.children ||
            read.ages.some(age => !Number.isInteger(age) || age < 0 || age > 17)) return { issue: 'amend_child_age_baseline_unavailable' };
        childAgePreimage = read.ages as number[];
        if (Array.isArray(compiled.selected.childAges) &&
            canonicalJson([...compiled.selected.childAges].sort((a, b) => a - b)) !==
              canonicalJson([...childAgePreimage].sort((a, b) => a - b))) return { issue: 'amend_child_age_baseline_changed' };
        if (compiled.target.childAges === 'unknown') compiled.target.childAges = childAgePreimage;
      }
      const discovery = await module.prepareCloudPaneAmend({ target: locked.target, transportId: ctx.transport.id, selected: compiled.selected,
        ...(childAgePreimage ? { childAgePreimage } : {}),
        confirmation: compiled.selected.confirmation, arrival: compiled.selected.arrival, changes: discoveryChanges,
        discoveryOnly: true, ...(typeof compiled.baseChanges.guaranteeType === 'string'
          ? { guaranteeChoiceCode: compiled.baseChanges.guaranteeType } : {}),
        captureMealPlan: true, captureCommissionBaseline: Object.hasOwn(compiled.baseChanges, 'taCommission'),
        captureGuestOptInBaseline: Object.hasOwn(compiled.baseChanges, 'guestOptIn'),
        allowRealGuest: true, cloudTargetKey: dispatchKey, signal: ctx.nativeBatch?.signal ?? AbortSignal.timeout(8 * 60_000) });
      const discoveryBaseline = record(discovery.recoveryBaseline);
      if (discovery.outcome !== 'prepared' || !record(discovery.preserved) || !discoveryBaseline) {
        return { issue: nativeAmendFailure(discovery, discovery.issue === 'BILLING_REFERENCE_REQUIRES_VERIFIED_AR'
          ? 'billing_reference_requires_verified_ar' : 'native_amend_baseline_unavailable') };
      }
      if (Object.hasOwn(compiled.baseChanges, 'reservationNote')) {
        const selectedObservation = loaded.draft!.observations.find(item => item.ref === compiled.selectedRef);
        const note = record(record(record(selectedObservation?.result)?.reservationObservations)?.reservationNote);
        if (!note || !['observed', 'blank'].includes(String(note.state)) ||
            note.source !== 'record_view_raw_value' || note.confirmation !== compiled.selected.confirmation ||
            typeof note.value !== 'string' || note.value !== discoveryBaseline.beforeNote) {
          return { issue: 'native_amend_reservation_note_changed_or_unavailable' };
        }
      }
      const discoveryPreserved = record(discovery.preserved)!;
      const changes = normalizedChanges(compiled, discoveryPreserved, discoveryBaseline);
      if (!changes) return { issue: 'native_amend_contact_or_cms_baseline_unavailable' };
      if (childAgePreimage) {
        const current = await module.readCloudSavedChildAges({ target: locked.target, transportId: ctx.transport.id, selected: compiled.selected,
          confirmation: compiled.selected.confirmation, arrival: compiled.selected.arrival, allowRealGuest: true,
          cloudTargetKey: dispatchKey, signal: ctx.nativeBatch?.signal ?? AbortSignal.timeout(8 * 60_000) });
        if (current.outcome !== 'ok' || !Array.isArray(current.ages) ||
            canonicalJson([...current.ages].sort((a, b) => Number(a) - Number(b))) !==
              canonicalJson([...childAgePreimage].sort((a, b) => a - b))) return { issue: 'amend_child_age_baseline_changed' };
      }
      const native = await module.prepareCloudPaneAmend({ target: locked.target, transportId: ctx.transport.id, selected: compiled.selected,
        ...(childAgePreimage ? { childAgePreimage } : {}),
        ...(typeof compiled.baseChanges.guaranteeType === 'string' ? { guaranteeChoiceCode: compiled.baseChanges.guaranteeType } : {}),
        confirmation: compiled.selected.confirmation, arrival: compiled.selected.arrival, changes,
        captureMealPlan: true, captureCommissionBaseline: Object.hasOwn(compiled.baseChanges, 'taCommission'),
        captureGuestOptInBaseline: Object.hasOwn(compiled.baseChanges, 'guestOptIn'),
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
          (Object.hasOwn(changes, 'guaranteeType') && (typeof recoveryBaseline.beforeGuaranteeDisplay !== 'string' ||
            typeof recoveryBaseline.requestedGuaranteeDisplay !== 'string' || !nativePrice(recoveryBaseline.beforeGuaranteePrice))) ||
          (Object.hasOwn(changes, 'guestOptIn') && typeof recoveryBaseline.beforeGuestOptIn !== 'boolean') ||
          (Object.hasOwn(changes, 'taCommission') && (typeof recoveryBaseline.beforeCommission !== 'number' ||
            !Number.isFinite(recoveryBaseline.beforeCommission) || !record(afterPreserved.bookingAgency)?.nativeId)) ||
          typeof recoveryBaseline.beforeGuaranteeCode !== 'string' ||
          !/^[A-Z0-9]{1,40}$/.test(recoveryBaseline.beforeGuaranteeCode) ||
          !(recoveryBaseline.beforeSavedRates === null || record(recoveryBaseline.beforeSavedRates)) ||
          canonicalJson(Object.fromEntries(Object.entries(afterPreserved).filter(([key]) =>
            key !== 'bookerContact' || Object.hasOwn(discoveryPreserved, key)))) !== canonicalJson(discoveryPreserved) ||
          canonicalJson(recoveryBaseline) !== canonicalJson(discoveryBaseline)) return {
        issue: nativeAmendFailure(native, 'native_amend_prepare_unverified') };
      // A stale stay lookup can hide a live guarantee change; its Go-time callback is not in this staged price.
      if (typeof changes.guaranteeType === 'string' && changes.guaranteeType !== recoveryBaseline.beforeGuaranteeCode) {
        return { issue: CALLBACK_FINISH_IN_HMS, finishInHmsFields: ['guaranteeType'] };
      }
      if (!mealPlanVerified(loaded.draft!, compiled, native)) return { issue: 'native_meal_plan_mismatch_or_unknown', mealObservation: mealMismatchObservation(loaded.draft!, compiled, native) };
      const preserved = afterPreserved;
      const semanticDigest = sha256({ baseDigest: compiled.baseDigest, selectedRef: compiled.selectedRef,
        selected: compiled.selected, target: compiled.target, changes, preserved, recoveryBaseline,
        nativeDigest: native.nativeDigest, price, appliedMealPlan: appliedMealPlan(native) });
      return { observation: preparationObservation(loaded.draft!, compiled, native, changes, preserved, price,
        recoveryBaseline, semanticDigest), changes, preserved, price, recoveryBaseline, semanticDigest, nativeDigest: native.nativeDigest };
    }, { ...acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS), signal: ctx.nativeBatch?.signal });
    if ('issue' in prepared) {
      if ('mealObservation' in prepared && prepared.mealObservation) return recordMealMismatch(ctx, input, compiled, prepared.mealObservation);
      if ('finishInHmsFields' in prepared && Array.isArray(prepared.finishInHmsFields)) {
        return { status: 'unsupported', issue: prepared.issue, fields: prepared.finishInHmsFields };
      }
      return { status: 'failed', issue: prepared.issue };
    }
    const recorded = await recordObservation(ctx, input, prepared.observation, 'prepared',
      'HMS amendment staged unsaved; native price and baseline observed', randomUUID(), compiled.hintId);
    if (recorded.status !== 'ok') return recorded;
    await appendSavedBaselineHints(ctx, input, compiled, prepared.observation.ref, recorded);
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
    observedAt: new Date().toISOString(), propertyCode: draft.propertyCode, sourceMessageId: draft.source.messageId, sourceRefs: [],
    criteria: { workflow: 'amend', requestId: input.requestId, hintId, draftRevision: draft.revision,
      idempotencyKey: input.idempotencyKey },
    coverage: { complete: status === 'complete', notes: status === 'complete' ? [] : [String(record(result)?.issue ?? record(result)?.outcome ?? 'amend_save_unverified')] },
    result } satisfies ReservationWorkflowV2Observation;
}

async function persistResolvedResult(tx: WriteTx, ctx: ReservationWorkflowV2AmendContext, input: ReservationWorkflowV2ExecuteInput,
  hintId: string, observation: ReservationWorkflowV2Observation, summary: string, status: 'prepared' | 'succeeded' = 'succeeded') {
  const [item] = await tx.select({ state: workItem.state, revision: workItem.revision, revisionSeq: workItem.revisionSeq })
    .from(workItem).where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, ctx.transport.id))).limit(1).for('update');
  const draft = item && reservationWorkflowV2DraftOf(item.state as Record<string, unknown>);
  if (!item || !draft || item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq ||
      draft.revision !== input.expectedRevision || draft.source.sourceHash !== input.source.sourceHash ||
      draft.source.messageId !== input.source.messageId || draft.source.threadId !== input.source.threadId ||
      draft.propertyCode !== ctx.property.propertyCode || draft.transportId !== ctx.transport.id) throw new Error('reservation_workflow_v2_amend_result_scope_changed');
  const observations = draft.observations.some((row) => row.ref === observation.ref) ? draft.observations : [...draft.observations, observation];
  const nextResult = { id: input.idempotencyKey, requestId: input.requestId, allocationId: hintId,
    generationId: draft.generationId, workflow: 'amend' as const, status,
    draftRevision: draft.revision, observationRefs: [observation.ref], updatedAt: new Date().toISOString(), summary };
  const operationResults = [...draft.operationResults.filter((row) => row.id !== input.idempotencyKey), nextResult];
  const nextDraft = reservationWorkflowV2DraftSchema.parse({ ...draft, observations, operationResults });
  await tx.update(workItem).set({ state: withReservationWorkflowV2Draft(item.state as Record<string, unknown>, nextDraft),
    updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
  await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
    fieldPath: `${RESERVATION_WORKFLOW_V2_STATE_KEY}:operationResults:${nextResult.id}`,
    value: { id: nextResult.id, requestId: nextResult.requestId, allocationId: hintId, workflow: 'amend',
      status, observationRefs: nextResult.observationRefs },
    evidence: { sourceHash: input.source.sourceHash, seq: input.expectedSeq, summary } });
}

async function recordCallbackPartial(ctx: ReservationWorkflowV2AmendContext, input: ReservationWorkflowV2ExecuteInput,
  hintId: string, phase: 'first_go' | 'final_go', result: Record<string, unknown>) {
  try {
    await ctx.db.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
      fieldPath: 'nava.hms.amend.callback-partial.v1', value: { operationId: input.idempotencyKey, requestId: input.requestId,
        hintId, phase, sourceDigest: input.source.sourceHash, issue: text(result.issue),
        effects: Array.isArray(result.callbackEffects) ? result.callbackEffects : [],
        callbackTaskDrained: result.callbackTaskDrained === true }, evidence: { sourceHash: input.source.sourceHash } });
    return true;
  } catch { return false; }
}

async function authorizeCurrentAmend(tx: WriteTx, ctx: ReservationWorkflowV2AmendContext,
  input: ReservationWorkflowV2ExecuteInput, compiled: Compile & { outcome: 'ok' }, prepared: ReservationWorkflowV2Observation,
  approvedDigest: string, attempt: ReservationWorkflowV2Observation,
  expectedReview?: { operationId: string; observation: ReservationWorkflowV2Observation; approvalDigest: string }) {
  const [item] = await tx.select({ state: workItem.state, revision: workItem.revision, revisionSeq: workItem.revisionSeq,
    sourceMessageId: workItem.sourceMessageId, threadId: workItem.threadId })
    .from(workItem).where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, ctx.transport.id))).limit(1).for('update');
  const draft = item && reservationWorkflowV2DraftOf(item.state as Record<string, unknown>);
  if (!item || !draft || item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq ||
      item.sourceMessageId !== input.source.messageId || item.threadId !== input.source.threadId ||
      draft.revision !== input.expectedRevision || draft.propertyCode !== ctx.property.propertyCode || draft.transportId !== ctx.transport.id ||
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
  if (expectedReview) {
    const currentReview = live.outcome === 'ok' ? callbackReviewState(draft, live) : null;
    const financial = record(currentReview?.financialReview);
    const receipts = await tx.select({ value: workEvent.value }).from(workEvent).where(and(
      eq(workEvent.workItemId, input.workItemId), eq(workEvent.type, 'write.evidence'),
      eq(workEvent.fieldPath, 'nava.hms.amend.callback-review.v1'))).limit(2000);
    const matching = receipts.map(row => record(row.value)).filter(value => value?.operationId === expectedReview.operationId &&
      value.sourceDigest === input.source.sourceHash && canonicalJson(value.observation) === canonicalJson(expectedReview.observation));
    if (currentReview?.status !== 'needs_review' || currentReview.operationId !== expectedReview.operationId ||
        financial?.accepted !== true || financial.observationRef !== expectedReview.observation.ref ||
        financial.approvalDigest !== expectedReview.approvalDigest || matching.length !== 1) {
      throw new Error('reservation_workflow_v2_amend_review_stale');
    }
  }
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
      !hmsDispatchTargetSchema.safeParse({ propertyCode: ctx.property.propertyCode, kind: 'saved',
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
  await tx.update(workItem).set({ state: withReservationWorkflowV2Draft(item.state as Record<string, unknown>, nextDraft),
    updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
  await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
    fieldPath: `${RESERVATION_WORKFLOW_V2_STATE_KEY}:operationResults:${nextResult.id}`,
    value: { id: nextResult.id, requestId: nextResult.requestId, allocationId: nextResult.allocationId,
      workflow: 'amend', status: 'unknown', observationRefs: nextResult.observationRefs },
    evidence: { sourceHash: input.source.sourceHash, seq: input.expectedSeq, approvedDigest,
      prepareObservationRef: prepared.ref, summary: nextResult.summary } });
}

export function readbackMatches(readback: unknown, prepared: Record<string, unknown>): Record<string, unknown> | null {
  const actual = record(readback), target = record(prepared.target), changes = record(prepared.nativeChanges), preserved = record(prepared.preserved);
  const baseline = record(prepared.recoveryBaseline);
  const actualPrice = record(actual?.price), approvedPrice = record(prepared.approvedPrices);
  if (!actual || !target || !changes || !preserved || !baseline || actual.confirmation !== target.confirmation ||
      actual.nativeStayId !== target.nativeStayId || actual.arrival !== target.arrival || actual.departure !== target.departure ||
      actual.roomType !== target.roomType || actual.ratePlan !== target.ratePlan || actual.adults !== target.adults ||
      actual.children !== target.children || actual.firstName !== target.firstName || actual.lastName !== target.lastName ||
      actual.cmsSend !== changes.cmsSend || !actualPrice || !approvedPrice ||
      appliedMealPlan(prepared) === null || actual.mealPlan !== appliedMealPlan(prepared) ||
      actualPrice.version !== approvedPrice.version || actualPrice.currency !== approvedPrice.currency ||
      actualPrice.totalCents !== approvedPrice.totalCents || actualPrice.averageCents !== approvedPrice.averageCents) return null;
  if (Array.isArray(target.childAges) && (!Array.isArray(actual.childAges) ||
      canonicalJson([...actual.childAges].sort((a: number, b: number) => a - b) as unknown) !==
      canonicalJson([...target.childAges].sort((a: number, b: number) => a - b)))) return null;
  const beforeKeys = { guestEmail: 'beforeGuestEmail', bookerName: 'beforeBookerName', bookerContact: 'beforeBookerContact',
    billingReference: 'beforeBillingReference' } as const;
  if (actual.reservationNote !== (changes.reservationNote ?? baseline.beforeNote) ||
      (typeof (changes.roomTypeForCharge ?? baseline.beforeRoomTypeForCharge) === 'string' &&
        actual.roomTypeForCharge !== (changes.roomTypeForCharge ?? baseline.beforeRoomTypeForCharge))) return null;
  if (Object.hasOwn(changes, 'taCommission') && actual.taCommission !== changes.taCommission) return null;
  if (typeof prepared.expectedFinalCommission === 'number' && actual.taCommission !== prepared.expectedFinalCommission) return null;
  if (Object.hasOwn(changes, 'guestOptIn') && actual.guestOptIn !== changes.guestOptIn) return null;
  if (Object.hasOwn(changes, 'guaranteeType') && actual.guaranteeType !== changes.guaranteeType) return null;
  const track = record(changes.track);
  if ((track && actual.track !== track.display) ||
      (!track && typeof baseline.beforeTrack === 'string' && actual.track !== baseline.beforeTrack)) return null;
  for (const key of ['guestEmail', 'bookerName', 'bookerContact', 'billingReference'] as const) {
    if (Object.hasOwn(changes, key) && actual[key] !== changes[key]) return null;
    if (!Object.hasOwn(changes, key) && (key !== 'billingReference' || typeof baseline[beforeKeys[key]] === 'string') &&
        (typeof baseline[beforeKeys[key]] !== 'string' ||
        actual[key] !== baseline[beforeKeys[key]])) return null;
  }
  if (actual.cmsMessageId !== changes.cmsMessageId || actual.cmsRecipient !== changes.cmsRecipient) return null;
  return actual;
}

/** Claim the first Go before any callback, then record a fresh reviewed-price candidate. */
async function executeCallbackFirst(ctx: ReservationWorkflowV2AmendContext, input: ReservationWorkflowV2ExecuteInput,
  draft: ReservationWorkflowV2Draft, compiled: CompiledAmend): Promise<Outcome> {
  const prepared = preparedObservation(draft, compiled), result = record(prepared?.result);
  const changes = record(result?.nativeChanges), safeChanges = record(result?.safeChanges), preserved = record(result?.preserved),
    baseline = record(result?.recoveryBaseline), plan = record(result?.callbackPlan), indicativePrice = nativePrice(result?.approvedPrices);
  const planDigest = typeof result?.callbackPlanDigest === 'string' ? result.callbackPlanDigest : null;
  const semantic = prepared && result && planDigest ? sha256({ baseDigest: compiled.baseDigest,
    selectedRef: compiled.selectedRef, selected: compiled.selected, target: result.target, changes, safeChanges, preserved,
    recoveryBaseline: baseline, nativeDigest: result.nativeDigest, price: indicativePrice, planDigest, appliedMealPlan: appliedMealPlan(result) }) : null;
  if (!prepared || result?.callbackPriceReviewRequired !== true || !changes || !safeChanges || !preserved || !baseline || !plan ||
      !indicativePrice || !mealPlanVerified(draft, compiled, result) || !nativePrice(baseline.beforeGuaranteePrice) || !planDigest || planDigest !== sha256(plan) ||
      prepared.criteria.semanticDigest !== semantic || typeof result.nativeDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(result.nativeDigest) || !Array.isArray(baseline.beforeChildAges)) {
    return { status: 'needs_prepare', issue: 'prepared_amend_or_price_is_stale' };
  }
  if (!ctx.user.sessionId || !ctx.user.sessionProfile) return { status: 'refused', issue: 'authenticated_staff_session_required' };
  if (amendMode(ctx) === 'off') return { status: 'refused', issue: 'amend_save_unavailable' };
  const locked = targetWriteLock(ctx, compiled.selected);
  if (!locked?.lock) return { status: 'needs_reconcile', issue: 'amend_target_lock_unavailable' };
  let epoch: string;
  try { epoch = await captureHmsLabtestDispatchEpoch(ctx.db, locked.dispatchTarget, input.workItemId); }
  catch { return { status: 'needs_reconcile', issue: 'amend_dispatch_history_unavailable' }; }
  const native = await nativeModule(), targetDigest = sha256(locked.dispatchTarget), work = await mkdtemp(join(tmpdir(), 'reservation-v2-callback-'));
  const beforeScreenshot = join(work, 'before.png'), afterScreenshot = join(work, 'after.png'), runId = randomUUID();
  const state: { beforeEvidence: { eventId: string; sha256: string } | null; beforeShot: { runId: string; sha256: string } | null;
    afterShot: { runId: string; sha256: string } | null; handle: HmsLabtestWriteHandle | null; claimAttempted: boolean;
    reviewAuthority: VerifiedStaffGo | null } = {
    beforeEvidence: null, beforeShot: null, afterShot: null, handle: null, claimAttempted: false, reviewAuthority: null };
  const approvedDigest = prepared.criteria.semanticDigest as string;
  const callbackRecovery = structuredClone({ selected: compiled.selected, confirmation: compiled.selected.confirmation,
      reservationStayId: compiled.selected.reservationStayId, reservationId: compiled.selected.reservationId,
      recordId: compiled.selected.recordId, approved: changes, indicativePrice, preserved, recoveryBaseline: baseline,
      nativeDigest: result.nativeDigest, prepareObservationRef: prepared.ref, approvedAfter: result.target,
      callbackPlan: plan, callbackPlanDigest: planDigest, firstGo: true,
      requestId: input.requestId, hintId: compiled.hintId, operationId: input.idempotencyKey, draftRevision: input.expectedRevision });
  const claimBase = { workItemId: input.workItemId, transportId: ctx.transport.id, actorUserId: ctx.user.id,
    grantId: input.idempotencyKey, propertyCode: locked.dispatchTarget.propertyCode, firstName: compiled.selected.firstName,
    lastName: compiled.selected.lastName, nativeGuestId: compiled.selected.guestId, operation: 'amend' as const,
    sourceDigest: input.source.sourceHash, approvedDigest, target: locked.dispatchTarget,
    recovery: { confirmation: compiled.selected.confirmation, reservationStayId: compiled.selected.reservationStayId,
      prepareObservationRef: prepared.ref, requestId: input.requestId, hintId: compiled.hintId,
      operationId: input.idempotencyKey, draftRevision: input.expectedRevision, firstGo: true,
      recoveryEvidenceDigest: sha256(callbackRecovery) } };
  let approvedClaim = '';
  let lockSignal: AbortSignal | undefined;
  const authorizeFirst = async (raw: unknown) => {
    lockSignal?.throwIfAborted();
    const step = record(raw);
    if (state.claimAttempted || !step || !cloudWriterCurrent(step.writer) || step.operationDigest !== approvedDigest || step.sourceDigest !== input.source.sourceHash ||
        step.targetDigest !== targetDigest || step.approvedPlanDigest !== planDigest ||
        !['amend.guarantee', 'amend.party.organization', 'amend.party.bookingAgency', 'amend.party.arAccount',
          'amend.children', 'amend.availability'].includes(String(step.phase)) ||
        typeof step.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(step.requestDigest) || !state.beforeEvidence) {
      throw new Error('AMEND_CALLBACK_APPROVAL_INVALID');
    }
    const claim = normalizeHmsLabtestClaim({ ...claimBase, requestDigest: step.requestDigest,
      recovery: { ...claimBase.recovery, firstPhase: step.phase, runId, beforeShot: state.beforeShot, writer: step.writer } });
    approvedClaim = canonicalJson(claim);
    if (Buffer.byteLength(approvedClaim) > 16_384) throw new Error('AMEND_CALLBACK_CLAIM_TOO_LARGE');
    state.claimAttempted = true;
    const attempt = observationForWrite(draft, input, compiled.hintId, 'partial', { outcome: 'dispatch_pending',
      requestDigest: step.requestDigest, approvedDigest, prepareObservationRef: prepared.ref,
      target: result.target, before: compiled.selected, approvedPrices: indicativePrice,
      beforeShot: state.beforeShot, semanticInput: result.semanticInput });
    state.handle = await claimHmsLabtestDispatch(ctx.db, claim, async tx => {
      if (!ctx.writeRunFence) throw new Error('staff_go_required');
      const authority = await consumeStaffGoAtDispatch(tx, ctx.writeRunFence, lockSignal);
      if (authority.grant.grantId !== input.idempotencyKey || authority.grant.operation !== 'amend' ||
          authority.grant.propertyCode !== ctx.property.propertyCode) throw new Error('staff_go_mismatch');
      state.reviewAuthority = authority;
      await authorizeCurrentAmend(tx, ctx, input, compiled, prepared, approvedDigest, attempt);
      await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
        fieldPath: 'nava.hms.amend.callback-recovery.v1', value: { operationId: input.idempotencyKey,
          sourceDigest: input.source.sourceHash, recovery: callbackRecovery }, evidence: { sourceHash: input.source.sourceHash } });
    }, epoch);
    lockSignal?.throwIfAborted();
    if (!cloudWriterCurrent(step.writer)) throw new Error('AMEND_WRITER_LOST');
    return state.handle;
  };
  const sealBeforeEvidence = async () => {
    state.beforeShot = await persistAmendShot(ctx, input.workItemId, runId, beforeScreenshot, 'before.png');
    if (!state.beforeShot) throw new Error('AMEND_EVIDENCE_REQUIRED');
    state.beforeEvidence = { eventId: randomUUID(), sha256: state.beforeShot.sha256 };
    return state.beforeEvidence;
  };
  let staged: Record<string, unknown> = {}, fresh: Record<string, unknown> = {};
  try {
    try {
      const checked = await locked.lock.withLock(async (targetSignal) => {
        lockSignal = targetSignal && ctx.signal ? AbortSignal.any([targetSignal, ctx.signal]) : targetSignal ?? ctx.signal;
        return withCloudCredentialLease(locked.dispatchTarget.propertyCode, async (credentialLease) => {
        const current = await native.readCloudSavedChildAges({ target: locked.target, transportId: ctx.transport.id, credentialLease, selected: compiled.selected,
          confirmation: compiled.selected.confirmation, arrival: compiled.selected.arrival, allowRealGuest: true,
          cloudTargetKey: hmsDispatchTargetKey(locked.dispatchTarget), signal: AbortSignal.any([AbortSignal.timeout(8 * 60_000), ...(lockSignal ? [lockSignal] : [])]) });
        if (current.outcome !== 'ok' || !Array.isArray(current.ages) ||
            canonicalJson([...current.ages].sort((a, b) => Number(a) - Number(b))) !==
              canonicalJson([...(baseline.beforeChildAges as number[])].sort((a, b) => a - b))) {
          return { staged: { outcome: 'not_dispatched', issue: 'AMEND_CHILD_PREIMAGE_CHANGED' }, fresh: {} };
        }
        const nativeInput = { target: locked.target, transportId: ctx.transport.id, credentialLease, selected: compiled.selected, confirmation: compiled.selected.confirmation,
          arrival: compiled.selected.arrival, childAgePreimage: baseline.beforeChildAges, changes,
          callbackPlan: plan, callbackPlanDigest: planDigest, callbackBindingChanges: safeChanges,
          sourceDigest: input.source.sourceHash, targetDigest, nativeDigest: result.nativeDigest,
          approvedPrices: indicativePrice, approvedBeforeCallbackPrice: baseline.beforeGuaranteePrice, preserved,
          ...(typeof changes.guaranteeType === 'string' ? { guaranteeChoiceCode: changes.guaranteeType } : {}),
          capturePriceComponents: true, captureMealPlan: true, approvedMealPlan: appliedMealPlan(result),
          approvedBeforeMealPlan: baseline.beforeMealPlan, captureCommissionBaseline: Object.hasOwn(changes, 'taCommission'),
          captureGuestOptInBaseline: Object.hasOwn(safeChanges, 'guestOptIn'),
          allowRealGuest: amendMode(ctx) === 'on', allowChangedLabGuarantee: true,
          cloudTargetKey: hmsDispatchTargetKey(locked.dispatchTarget),
          beforeScreenshot, afterScreenshot, signal: AbortSignal.any([AbortSignal.timeout(20 * 60_000), ...(lockSignal ? [lockSignal] : [])]) };
        const staged = await native.reviewCloudPaneAmendCallbacks(nativeInput, { operationDigest: approvedDigest,
          authorizeFirst, sealBeforeEvidence, isEnabled: () => amendMode(ctx) !== 'off' });
        if (staged.outcome !== 'callback_review_ready' || staged.writerSessionClosed !== true ||
            staged.dispatchCallbacksDrained !== true || staged.callbackTaskDrained !== true || !record(staged.before) ||
            !Array.isArray(staged.callbackEffects)) return { staged, fresh: {} };
        const fresh = await native.readCloudCallbackReviewState({ ...nativeInput, before: staged.before,
          callbackEffects: staged.callbackEffects });
        lockSignal?.throwIfAborted();
        return { staged, fresh };
        }, { signal: lockSignal });
      }, acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
      staged = checked.staged; fresh = checked.fresh;
    } catch (error) { staged = { outcome: 'uncertain', issue: isPropertyReadLockDeadline(error) ? 'amend_lock_busy' : 'callback_invocation_failed' }; }
    try { state.afterShot = await persistAmendShot(ctx, input.workItemId, runId, afterScreenshot, 'saved.png'); }
    catch { /* A positive review requires durable screenshot evidence. */ }
  } finally { await rm(work, { recursive: true, force: true }).catch(() => {}); }
  if (!state.handle) return state.claimAttempted ? { status: 'needs_reconcile', operationId: input.idempotencyKey,
    issue: 'amend_dispatch_claim_unconfirmed' } : { status: 'failed', issue: text(staged.issue) ?? 'amend_callback_not_dispatched' };
  const reviewPrice = nativePrice(staged.approvedPrices), callbackState = record(fresh.callbackState), savedPrice = nativePrice(fresh.savedPrice);
  if (staged.outcome !== 'callback_review_ready' || staged.writerSessionClosed !== true ||
      staged.dispatchCallbacksDrained !== true || staged.callbackTaskDrained !== true ||
      fresh.outcome !== 'matched' || !reviewPrice || !record(reviewPrice.componentsTenThousandths) ||
      !savedPrice || !callbackState || !state.beforeShot || !state.afterShot || fresh.confirmation !== compiled.selected.confirmation ||
      fresh.nativeStayId !== compiled.selected.reservationStayId || reviewPrice.currency !== savedPrice.currency ||
      appliedMealPlan(staged) !== appliedMealPlan(result)) {
    const partialEvidenceRecorded = await recordCallbackPartial(ctx, input, compiled.hintId, 'first_go', staged);
    return { status: 'needs_reconcile', operationId: input.idempotencyKey, dispatchHoldId: state.handle.holdId,
      issue: 'amend_callback_readback_or_price_unverified', partialEffect: 'possible', partialEvidenceRecorded };
  }
  const approval = sha256({ stage: 'callback_price_review', requestId: compiled.requestId, hintId: compiled.hintId,
    selectedRef: compiled.selectedRef, baseDigest: compiled.baseDigest, semanticDigest: approvedDigest,
    price: reviewPrice, applied: { mealPlan: appliedMealPlan(staged) }, requestedMealPlan: compiled.baseChanges.requestedMealPlan ?? null,
    callbackState, before: compiled.selected, target: result.target,
    callbackPlanDigest: planDigest, prepareObservationRef: prepared.ref, freshReadback: fresh });
  const observation: ReservationWorkflowV2Observation = { ref: randomUUID(), generationId: draft.generationId,
    kind: 'rate_availability', status: 'complete', observedAt: new Date().toISOString(), propertyCode: draft.propertyCode,
    sourceMessageId: draft.source.messageId, sourceRefs: [], coverage: { complete: true, notes: [] },
    criteria: { workflow: 'amend', stage: 'callback_price_review', requestId: compiled.requestId, hintId: compiled.hintId,
      selectedRef: compiled.selectedRef, baseDigest: compiled.baseDigest, semanticDigest: approvedDigest },
    result: { outcome: 'callback_price_review', ready: true, approvalDigest: approval, price: reviewPrice, callbackState,
      applied: { mealPlan: appliedMealPlan(staged) }, requestedMealPlan: compiled.baseChanges.requestedMealPlan ?? null,
      before: compiled.selected, target: result.target, callbackPlanDigest: planDigest, prepareObservationRef: prepared.ref,
      freshReadback: fresh, callbackEffects: staged.callbackEffects, beforeShot: state.beforeShot, reviewShot: state.afterShot } };
  try {
    const owner = `${ctx.user.id}:${ctx.transport.id}`;
    if (!await verifyStoredHmsShot({ ...state.beforeShot, name: 'before.png', owner, propertyCode: ctx.property.propertyCode,
      workItemId: input.workItemId }, 'before.png') ||
        !await verifyStoredHmsShot({ ...state.afterShot, name: 'saved.png', owner, propertyCode: ctx.property.propertyCode,
          workItemId: input.workItemId }, 'saved.png')) throw new Error('reservation_v2_amend_screenshot_unverified');
    // The full readback is stored atomically in the review observation below.
    // Keep the dispatch receipt bounded while binding it to that exact evidence.
    const callbackReadback = { confirmation: compiled.selected.confirmation, nativeStayId: compiled.selected.reservationStayId,
      operationPhase: 'callback_review', finalSave: false, callbackReviewDigest: approval, freshReadbackDigest: sha256(fresh) };
    await resolveHmsLabtestDispatch(ctx.db, state.handle, { operation: 'amend', confirmation: compiled.selected.confirmation,
      nativeStayId: compiled.selected.reservationStayId, nativeReadback: callbackReadback,
      readbackDigest: sha256(callbackReadback), savedShot: state.afterShot },
    async (tx, intent) => {
      const { version: _version, kind: _kind, holdId: _holdId, ownerDigest: _ownerDigest, ...claimed } = intent;
      if (!approvedClaim || canonicalJson(claimed) !== approvedClaim) throw new Error('reservation_v2_amend_intent_changed');
      const authority = state.reviewAuthority;
      const fence = ctx.writeRunFence;
      if (!authority || !fence || authority.grant.grantId !== input.idempotencyKey ||
          authority.grant.workItemId !== input.workItemId || authority.grant.transportId !== ctx.transport.id ||
          authority.grant.propertyCode !== ctx.property.propertyCode || authority.grant.operation !== 'amend') {
        throw new Error('reservation_v2_amend_review_authority_missing');
      }
      const events = await tx.select({ actorKind: workEvent.actorKind, type: workEvent.type, value: workEvent.value })
        .from(workEvent).where(and(eq(workEvent.workItemId, input.workItemId),
          eq(workEvent.payloadHash, authority.payloadHash)));
      const consumed = events.some(event => {
        const value = record(event.value);
        return event.actorKind === 'system' && event.type === 'approval.consumed' &&
          value?.grantId === authority.grant.grantId && value.runId === fence.runId;
      });
      const started = events.some(event => {
        const value = record(event.value);
        return event.actorKind === 'system' && event.type === 'hms.dispatch.started' &&
          value?.grantId === authority.grant.grantId && value.preparedRef === authority.grant.preparedRef &&
          value.runId === fence.runId && value.propertyCode === authority.grant.propertyCode && value.operation === 'amend';
      });
      if (!consumed || !started) throw new Error('reservation_v2_amend_dispatch_evidence_missing');
      await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
        fieldPath: 'nava.hms.amend.callback-review.v1', value: { operationId: input.idempotencyKey,
          sourceDigest: input.source.sourceHash, observation }, evidence: { sourceHash: input.source.sourceHash } });
      await persistResolvedResult(tx, ctx, input, compiled.hintId, observation,
        'Native details may have changed; review the refreshed price before Save', 'prepared');
      await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system',
        type: 'hms.dispatch.reviewed', payloadHash: authority.payloadHash, value: {
          version: 1, runId: fence.runId, grantId: authority.grant.grantId,
          preparedRef: authority.grant.preparedRef, payloadHash: authority.payloadHash,
          propertyCode: authority.grant.propertyCode, observationRef: observation.ref,
          requestId: input.requestId, allocationId: compiled.hintId, holdId: intent.holdId,
          callbackReviewDigest: approval, freshReadbackDigest: sha256(fresh), finalSave: false,
        } });
    });
  } catch {
    const partialEvidenceRecorded = await recordCallbackPartial(ctx, input, compiled.hintId, 'first_go', staged);
    return { status: 'needs_reconcile', operationId: input.idempotencyKey, dispatchHoldId: state.handle.holdId,
      issue: 'amend_callback_durable_resolution_unconfirmed', partialEffect: 'possible', partialEvidenceRecorded };
  }
  const latest = await getReservationWorkflowV2Draft(stateContext(ctx), input);
  if (latest.status !== 'ok') return { status: 'needs_reconcile', operationId: input.idempotencyKey,
    issue: 'amend_callback_review_unavailable' };
  return callbackReviewState(latest.draft, compiled) ?? { status: 'needs_reconcile', operationId: input.idempotencyKey,
    issue: 'amend_callback_review_unavailable' };
}

/** Reconcile the first Go, replay only missing effects, and Save the exact accepted price. */
async function executeCallbackSecond(ctx: ReservationWorkflowV2AmendContext, input: ReservationWorkflowV2ExecuteInput,
  draft: ReservationWorkflowV2Draft, compiled: CompiledAmend, pending: Outcome): Promise<Outcome> {
  const financial = record(pending.financialReview), reviewRef = text(financial?.observationRef), reviewDigest = text(financial?.approvalDigest);
  const review = draft.observations.find(item => item.ref === reviewRef && item.kind === 'rate_availability');
  const reviewResult = record(review?.result), recordedFresh = record(reviewResult?.freshReadback);
  const prepared = preparedObservation(draft, compiled), original = record(prepared?.result), plan = record(original?.callbackPlan);
  const baseline = record(original?.recoveryBaseline), preserved = record(original?.preserved), changes = record(original?.nativeChanges),
    safeChanges = record(original?.safeChanges), price = nativePrice(reviewResult?.price);
  const firstOperationId = text(pending.operationId), originalDigest = text(prepared?.criteria.semanticDigest);
  const originalExpected = record(plan?.expected);
  if (financial?.accepted !== true || !review || !reviewDigest || !firstOperationId || !prepared || !originalDigest ||
      !reviewResult || !original || reviewResult.prepareObservationRef !== prepared.ref ||
      reviewResult.callbackPlanDigest !== original.callbackPlanDigest ||
      !plan || !baseline || !preserved || !changes || !safeChanges || !price || !record(price.componentsTenThousandths) ||
      !recordedFresh || !Array.isArray(reviewResult.callbackEffects) || !Array.isArray(plan.parties) ||
      !originalExpected || changes.retainRates !== 'no') return { status: 'needs_reconcile', issue: 'amend_callback_review_unverified' };
  const originalParties = plan.parties;
  const agency = originalParties.map(record).find(item => item?.kind === 'bookingAgency');
  const commissionEffect = record(agency?.expectedEffects)?.ta1commission;
  if (commissionEffect !== undefined && (typeof commissionEffect !== 'string' ||
      !/^(?:0|[1-9]\d?)(?:\.\d+)?$|^100(?:\.0+)?$/.test(commissionEffect))) {
    return { status: 'needs_reconcile', issue: 'amend_callback_commission_unverified' };
  }
  const expectedFinalCommission = typeof changes.taCommission === 'number' ? changes.taCommission :
    typeof commissionEffect === 'string' ? Number(commissionEffect) : null;
  const indicativePrice = nativePrice(original.approvedPrices);
  if (!indicativePrice || !mealPlanVerified(draft, compiled, original) || appliedMealPlan(reviewResult) !== appliedMealPlan(original) || original.callbackPlanDigest !== sha256(plan) || originalDigest !== sha256({
    baseDigest: compiled.baseDigest, selectedRef: compiled.selectedRef, selected: compiled.selected, target: original.target,
    changes, safeChanges, preserved, recoveryBaseline: baseline, nativeDigest: original.nativeDigest,
    price: indicativePrice, planDigest: original.callbackPlanDigest, appliedMealPlan: appliedMealPlan(original) })) {
    return { status: 'needs_reconcile', issue: 'amend_callback_review_unverified' };
  }
  if (input.idempotencyKey === firstOperationId) return { ...pending, issue: 'amend_second_go_requires_new_operation' };
  if (!ctx.user.sessionId || !ctx.user.sessionProfile) return { status: 'refused', issue: 'authenticated_staff_session_required' };
  if (amendMode(ctx) === 'off') return { status: 'refused', issue: 'amend_save_unavailable' };
  const receipts = await ctx.db.select({ value: workEvent.value }).from(workEvent).where(and(
    eq(workEvent.workItemId, input.workItemId), eq(workEvent.type, 'write.evidence'),
    eq(workEvent.fieldPath, 'nava.hms.amend.callback-review.v1'))).limit(2000);
  if (receipts.map(row => record(row.value)).filter(value => value?.operationId === firstOperationId &&
      value.sourceDigest === input.source.sourceHash && value.observation &&
      canonicalJson(value.observation) === canonicalJson(review)).length !== 1) {
    return { status: 'needs_reconcile', issue: 'amend_callback_receipt_unverified' };
  }
  const locked = targetWriteLock(ctx, compiled.selected);
  if (!locked?.lock) return { status: 'needs_reconcile', issue: 'amend_target_lock_unavailable' };
  let epoch: string;
  try { epoch = await captureHmsLabtestDispatchEpoch(ctx.db, locked.dispatchTarget, input.workItemId); }
  catch { return { status: 'needs_reconcile', issue: 'amend_dispatch_history_unavailable' }; }
  const native = await nativeModule(), work = await mkdtemp(join(tmpdir(), 'reservation-v2-final-')),
    beforeScreenshot = join(work, 'before.png'), afterScreenshot = join(work, 'after.png'), runId = randomUUID();
  const state: { beforeShot: { runId: string; sha256: string } | null; afterShot: { runId: string; sha256: string } | null;
    beforeEvidence: { eventId: string; sha256: string } | null; handle: HmsLabtestWriteHandle | null; claimAttempted: boolean } = {
    beforeShot: null, afterShot: null, beforeEvidence: null, handle: null, claimAttempted: false };
  let approvedClaim = '', result: Record<string, unknown> = {}, finalBaseline: Record<string, unknown> | null = null;
  try {
    try {
      result = await locked.lock.withLock(async (targetSignal) => {
        const lockSignal = targetSignal && ctx.signal ? AbortSignal.any([targetSignal, ctx.signal]) : targetSignal ?? ctx.signal;
        return withCloudCredentialLease(locked.dispatchTarget.propertyCode, async (credentialLease) => {
        const common = { target: locked.target, transportId: ctx.transport.id, credentialLease, selected: compiled.selected, confirmation: compiled.selected.confirmation,
          arrival: compiled.selected.arrival, allowRealGuest: true, cloudTargetKey: hmsDispatchTargetKey(locked.dispatchTarget),
          capturePriceComponents: true, captureMealPlan: true, signal: AbortSignal.any([AbortSignal.timeout(20 * 60_000), ...(lockSignal ? [lockSignal] : [])]) };
        const current = await native.readCloudCallbackReviewState({ ...common, callbackPlan: plan, before: baseline, changes,
          preserved, callbackEffects: reviewResult.callbackEffects });
        if (current.outcome !== 'matched' || canonicalJson(current) !== canonicalJson(recordedFresh) || !validNative(current.native, ctx.property.propertyCode) ||
            !Array.isArray(current.childAges) || !record(current.partyImage) || !record(current.guarantee) || !nativePrice(current.savedPrice)) {
          return { outcome: 'not_dispatched', issue: 'AMEND_CALLBACK_STATE_CHANGED' };
        }
        const effects = record(current.callbackState)?.effects;
        if (!Array.isArray(effects)) return { outcome: 'not_dispatched', issue: 'AMEND_CALLBACK_STATE_UNVERIFIED' };
        const statusFor = (field: string) => {
          const matching = effects.map(record).filter(effect => effect?.field === field);
          return matching.length === 1 && ['confirmed', 'not_observed'].includes(String(matching[0]?.persistence))
            ? matching[0]?.persistence : null;
        };
        const originalGuarantee = record(plan.guarantee), originalChildren = record(plan.children);
        if ((originalGuarantee && !statusFor('guaranteeType')) || (originalChildren && !statusFor('childAges')) ||
            originalParties.some(item => !record(item) || !statusFor(String(record(item)?.kind)))) {
          return { outcome: 'not_dispatched', issue: 'AMEND_CALLBACK_STATE_UNVERIFIED' };
        }
        const selected = current.native, guaranteeBefore = record(current.guarantee)!;
        const parties = originalParties.filter(item => statusFor(String(record(item)?.kind)) === 'not_observed');
        const guarantee = originalGuarantee && statusFor('guaranteeType') === 'not_observed'
          ? { ...originalGuarantee, before: guaranteeBefore } : null;
        const children = originalChildren && statusFor('childAges') === 'not_observed'
          ? { beforeAges: current.childAges, nextAges: originalChildren.nextAges } : null;
        const expected = { ...originalExpected, propertyCode: selected.propertyCode, confirmation: selected.confirmation, guestId: selected.guestId,
          reservationStayId: selected.reservationStayId, reservationId: selected.reservationId, recordId: selected.recordId,
          firstName: selected.firstName, lastName: selected.lastName, arrival: selected.arrival, departure: selected.departure,
          roomType: selected.roomType, ratePlan: selected.ratePlan, adults: selected.adults, childCount: selected.children,
          childAges: current.childAges, expectedGuarantee: guaranteeBefore, note: baseline.beforeNote };
        const nextPlan = { selected, expected, guarantee, parties, children, beforeImage: parties.length ? current.partyImage : null };
        const planDigest = sha256(nextPlan), targetDigest = sha256(locked.dispatchTarget);
        const nextCommon = { ...common, selected, arrival: selected.arrival, childAgePreimage: current.childAges };
        const preflight = await native.prepareCloudPaneAmend({ ...nextCommon, changes: safeChanges, captureBusinessImage: true,
          captureCommissionBaseline: Object.hasOwn(safeChanges, 'taCommission'),
          captureGuestOptInBaseline: Object.hasOwn(safeChanges, 'guestOptIn') });
        const preflightBaseline = record(preflight.recoveryBaseline), nextPreserved = record(preflight.preserved);
        if (preflight.outcome !== 'prepared' || !preflightBaseline || !nextPreserved || !record(preflight.sourceBusinessImage) ||
            appliedMealPlan(preflight) !== appliedMealPlan(reviewResult) || typeof preflightBaseline.beforeMealPlan !== 'string' ||
            typeof preflight.nativeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(preflight.nativeDigest) ||
            preflightBaseline.beforeNote !== baseline.beforeNote ||
            canonicalJson(preflightBaseline.beforeParties) !== canonicalJson(current.partyPreimage) ||
            canonicalJson(preflight.sourceBusinessImage) !== canonicalJson(current.partyImage)) {
          return { outcome: 'not_dispatched', issue: 'AMEND_CALLBACK_PREFLIGHT_CHANGED' };
        }
        finalBaseline = preflightBaseline;
        const callbackRecovery = structuredClone({ selected, confirmation: selected.confirmation, reservationStayId: selected.reservationStayId,
            reservationId: selected.reservationId, recordId: selected.recordId, approved: changes, approvedPrices: price,
            preserved: nextPreserved, recoveryBaseline: preflightBaseline, nativeDigest: preflight.nativeDigest,
            prepareObservationRef: prepared.ref, approvedAfter: original.target, callbackPlan: nextPlan,
            callbackPlanDigest: planDigest, reviewObservationRef: review.ref, reviewDigest, firstGoOperationId: firstOperationId,
            requestId: input.requestId, hintId: compiled.hintId, operationId: input.idempotencyKey, draftRevision: input.expectedRevision });
        const claimBase = { workItemId: input.workItemId, transportId: ctx.transport.id, actorUserId: ctx.user.id,
          grantId: input.idempotencyKey, propertyCode: locked.dispatchTarget.propertyCode, firstName: compiled.selected.firstName,
          lastName: compiled.selected.lastName, nativeGuestId: compiled.selected.guestId, operation: 'amend' as const,
          sourceDigest: input.source.sourceHash, approvedDigest: reviewDigest, target: locked.dispatchTarget,
          recovery: { confirmation: selected.confirmation, reservationStayId: selected.reservationStayId,
            prepareObservationRef: prepared.ref, reviewDigest, requestId: input.requestId, hintId: compiled.hintId,
            operationId: input.idempotencyKey, draftRevision: input.expectedRevision,
            recoveryEvidenceDigest: sha256(callbackRecovery) } };
        const authorizeFirst = async (raw: unknown) => {
          lockSignal?.throwIfAborted();
          const step = record(raw);
          if (state.claimAttempted || !step || !cloudWriterCurrent(step.writer) || step.operationDigest !== reviewDigest || step.sourceDigest !== input.source.sourceHash ||
              step.targetDigest !== targetDigest || step.approvedPlanDigest !== planDigest || step.reviewDigest !== reviewDigest ||
              !['amend.guarantee', 'amend.party.organization', 'amend.party.bookingAgency', 'amend.party.arAccount',
                'amend.children', 'amend.availability'].includes(String(step.phase)) ||
              typeof step.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(step.requestDigest) || !state.beforeEvidence) {
            throw new Error('AMEND_FINAL_APPROVAL_INVALID');
          }
          const claim = normalizeHmsLabtestClaim({ ...claimBase, requestDigest: step.requestDigest,
            recovery: { ...claimBase.recovery, firstPhase: step.phase, runId, beforeShot: state.beforeShot, writer: step.writer } });
          approvedClaim = canonicalJson(claim);
          if (Buffer.byteLength(approvedClaim) > 16_384) throw new Error('AMEND_CALLBACK_CLAIM_TOO_LARGE');
          state.claimAttempted = true;
          const attempt = observationForWrite(draft, input, compiled.hintId, 'partial', { outcome: 'dispatch_pending',
            requestDigest: step.requestDigest, approvedDigest: originalDigest, prepareObservationRef: prepared.ref,
            target: original.target, before: compiled.selected, approvedPrices: price, beforeShot: state.beforeShot,
            reviewObservationRef: review.ref, reviewDigest });
          state.handle = await claimHmsLabtestDispatch(ctx.db, claim, async tx => {
            if (!ctx.writeRunFence) throw new Error('staff_go_required');
            await consumeStaffGoAtDispatch(tx, ctx.writeRunFence, lockSignal);
            await authorizeCurrentAmend(tx, ctx, input, compiled, prepared, originalDigest, attempt,
              { operationId: firstOperationId, observation: review, approvalDigest: reviewDigest });
            await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
              fieldPath: 'nava.hms.amend.callback-recovery.v1', value: { operationId: input.idempotencyKey,
                sourceDigest: input.source.sourceHash, recovery: callbackRecovery }, evidence: { sourceHash: input.source.sourceHash } });
          }, epoch);
          lockSignal?.throwIfAborted();
          if (!cloudWriterCurrent(step.writer)) throw new Error('AMEND_WRITER_LOST');
          return state.handle;
        };
        const sealBeforeEvidence = async () => {
          state.beforeShot = await persistAmendShot(ctx, input.workItemId, runId, beforeScreenshot, 'before.png');
          if (!state.beforeShot) throw new Error('AMEND_EVIDENCE_REQUIRED');
          state.beforeEvidence = { eventId: randomUUID(), sha256: state.beforeShot.sha256 };
          return state.beforeEvidence;
        };
        return native.commitCloudPaneAmendReviewed({ ...nextCommon, changes, callbackPlan: nextPlan, callbackPlanDigest: planDigest,
          callbackBindingChanges: safeChanges, approvedBusinessImage: current.partyImage,
          approvedMealPlan: appliedMealPlan(reviewResult), approvedBeforeMealPlan: preflightBaseline.beforeMealPlan,
          ...(expectedFinalCommission !== null ? { expectedFinalCommission } : {}),
          sourceDigest: input.source.sourceHash, targetDigest, reviewDigest,
          nativeDigest: preflight.nativeDigest, approvedPrices: price, approvedBeforeCallbackPrice: current.savedPrice,
          preserved: nextPreserved, ...(typeof changes.guaranteeType === 'string' ? { guaranteeChoiceCode: changes.guaranteeType } : {}),
          captureCommissionBaseline: Object.hasOwn(changes, 'taCommission'), captureGuestOptInBaseline: Object.hasOwn(changes, 'guestOptIn'),
          allowRealGuest: amendMode(ctx) === 'on', allowChangedLabGuarantee: true, beforeScreenshot, afterScreenshot },
        { operationDigest: reviewDigest, authorizeFirst, sealBeforeEvidence,
          isEnabled: () => amendMode(ctx) !== 'off' });
        }, { signal: lockSignal });
      }, acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
    } catch (error) { result = { outcome: 'uncertain', issue: isPropertyReadLockDeadline(error) ? 'amend_lock_busy' : 'native_amend_invocation_failed' }; }
    try { state.afterShot = await persistAmendShot(ctx, input.workItemId, runId, afterScreenshot, 'saved.png'); }
    catch { /* No positive completion without durable readback evidence. */ }
  } finally { await rm(work, { recursive: true, force: true }).catch(() => {}); }
  if (!state.handle) return state.claimAttempted ? { status: 'needs_reconcile', operationId: input.idempotencyKey,
    issue: 'amend_dispatch_claim_unconfirmed' } : { status: 'failed', issue: text(result.issue) ?? 'amend_not_dispatched' };
  const actual = result.outcome === 'amended' && result.writerSessionClosed === true && result.dispatchCallbacksDrained === true &&
    result.businessFieldsMatched === true && finalBaseline ? readbackMatches(result.readback,
      { ...original, recoveryBaseline: finalBaseline, approvedPrices: price, expectedFinalCommission }) : null;
  if (!actual || !state.beforeShot || !state.afterShot || !state.beforeEvidence) {
    const partialEvidenceRecorded = await recordCallbackPartial(ctx, input, compiled.hintId, 'final_go', result);
    return { status: 'needs_reconcile', operationId: input.idempotencyKey, dispatchHoldId: state.handle.holdId,
      issue: 'amend_readback_or_durable_receipt_unverified', partialEffect: 'possible', partialEvidenceRecorded };
  }
  const success = observationForWrite(draft, input, compiled.hintId, 'complete', { nativeOutcome: result.outcome,
    target: original.target, before: compiled.selected, nativeReadback: actual, approvedPrices: price,
    prepareObservationRef: prepared.ref, reviewObservationRef: review.ref, reviewDigest,
    dispatchHoldId: state.handle.holdId, beforeShot: state.beforeShot, savedShot: state.afterShot });
  try {
    const owner = `${ctx.user.id}:${ctx.transport.id}`;
    if (!await verifyStoredHmsShot({ ...state.beforeShot, name: 'before.png', owner, propertyCode: ctx.property.propertyCode,
      workItemId: input.workItemId }, 'before.png') || !await verifyStoredHmsShot({ ...state.afterShot, name: 'saved.png', owner,
      propertyCode: ctx.property.propertyCode, workItemId: input.workItemId }, 'saved.png')) throw new Error('reservation_v2_amend_screenshot_unverified');
    const finalReceipt = { confirmation: actual.confirmation, nativeStayId: actual.nativeStayId,
      operationPhase: 'final_save', finalSave: true, freshReadbackDigest: sha256(actual) };
    await resolveHmsLabtestDispatch(ctx.db, state.handle, { operation: 'amend', confirmation: String(actual.confirmation),
      nativeStayId: String(actual.nativeStayId), nativeReadback: finalReceipt, readbackDigest: sha256(finalReceipt), savedShot: state.afterShot },
    async (tx, intent) => {
      const { version: _version, kind: _kind, holdId: _holdId, ownerDigest: _ownerDigest, ...claimed } = intent;
      if (!approvedClaim || canonicalJson(claimed) !== approvedClaim) throw new Error('reservation_v2_amend_intent_changed');
      await persistResolvedResult(tx, ctx, input, compiled.hintId, success,
        `Amended ${actual.confirmation}; HMS fresh readback matched`);
    });
  } catch {
    const partialEvidenceRecorded = await recordCallbackPartial(ctx, input, compiled.hintId, 'final_go', result);
    return { status: 'needs_reconcile', operationId: input.idempotencyKey, dispatchHoldId: state.handle.holdId,
      issue: 'amend_durable_resolution_unconfirmed', partialEffect: 'possible', partialEvidenceRecorded };
  }
  return { status: 'succeeded', operationId: input.idempotencyKey, requestId: input.requestId,
    allocationId: compiled.hintId, confirmation: actual.confirmation, price: actual.price, observationRef: success.ref };
}

/** Reuse the amendment compiler and the exact accepted native preview, including second-Go review. */
export async function reservationWorkflowV2AmendPreparation(ctx: ReservationWorkflowV2AmendContext,
  input: ReservationWorkflowV2PrepareInput) {
  if (!input.allocationId) return null;
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return null;
  const compiled = compileBase(loaded.draft, input.requestId, input.allocationId, 'prepare');
  if (compiled.outcome !== 'ok') return null;
  const original = preparedObservation(loaded.draft, compiled);
  if (!original || !original.coverage.complete || original.propertyCode !== ctx.property.propertyCode ||
      original.sourceMessageId !== input.source.messageId) return null;
  const pending = callbackReviewState(loaded.draft, compiled);
  let observation = original;
  if (pending) {
    if (pending.status !== 'needs_review' || !pending.financialReview.accepted) return null;
    observation = pending.observation;
  }
  const price = nativePrice(observation.result.price ?? observation.result.approvedPrices);
  const target = hmsDispatchTargetSchema.safeParse({ propertyCode: ctx.property.propertyCode, kind: 'saved',
    confirmation: compiled.selected.confirmation, nativeStayId: compiled.selected.reservationStayId });
  if (!price || !target.success || target.data.kind !== 'saved') return null;
  return { operation: 'amend' as const, targetAliases: hmsDispatchTargetKeys(target.data),
    nativeObservation: { beforeDigest: sha256(observation.result), capturedAt: observation.observedAt,
      price, warnings: observation.coverage.notes }, workflowContext: { endpoint: 'execute' as const, input } };
}

export async function reservationWorkflowV2AmendExecute(ctx: ReservationWorkflowV2AmendContext,
  input: ReservationWorkflowV2ExecuteInput): Promise<Outcome> {
  if (input.go !== true || !input.allocationId) return { status: 'needs_input', issue: 'amend_target_and_go_required' };
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return loaded.result;
  if (!getPropertyRegistration(ctx.property.propertyCode)?.active || loaded.draft.propertyCode !== ctx.property.propertyCode) {
    return { status: 'unsupported', issue: 'property_not_supported' };
  }
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
  const pendingReview = callbackReviewState(loaded.draft, compiled);
  if (pendingReview) {
    if (pendingReview.status === 'needs_review' && record(pendingReview.financialReview)?.accepted === true) {
      return executeCallbackSecond(ctx, input, loaded.draft, compiled, pendingReview);
    }
    return pendingReview;
  }
  if (typeof compiled.baseChanges.guaranteeType === 'string') {
    return { status: 'unsupported', issue: 'amend_guarantee_change_finish_in_hms', fields: ['guaranteeType'] };
  }
  const candidate = preparedObservation(loaded.draft, compiled);
  if (compiled.rateHandling === 'retain' && callbackRequested(compiled)) {
    const finding = loaded.draft.observations.findLast(observation => observation.kind === 'rate_availability' &&
      observation.status === 'complete' && observation.coverage.complete && observation.generationId === loaded.draft!.generationId &&
      observation.propertyCode === ctx.property.propertyCode && observation.sourceMessageId === loaded.draft!.source.messageId &&
      observation.criteria.workflow === 'amend' && observation.criteria.stage === 'retain_callback_unsupported' &&
      observation.criteria.requestId === compiled.requestId && observation.criteria.hintId === compiled.hintId &&
      observation.criteria.selectedRef === compiled.selectedRef && observation.criteria.baseDigest === compiled.baseDigest &&
      observation.result.outcome === 'retain_callback_unsupported');
    if (finding && (!candidate || loaded.draft.observations.indexOf(finding) > loaded.draft.observations.indexOf(candidate))) {
      return { status: 'unsupported', issue: 'retained_rate_not_supported_for_priced_amendment', fields: ['rateHandling'] };
    }
    if (record(candidate?.result)?.callbackNoop !== true) {
      return { status: 'needs_prepare', issue: 'prepared_amend_or_price_is_stale' };
    }
  }
  if (callbackRequested(compiled) && record(candidate?.result)?.callbackNoop !== true) {
    // Also covers callback previews recorded before this guard shipped.
    if (!callbackPriceBeforeWriteAvailable()) {
      return { status: 'unsupported', issue: CALLBACK_FINISH_IN_HMS, fields: compiledCallbackFields(compiled) };
    }
    return executeCallbackFirst(ctx, input, loaded.draft, compiled);
  }
  if (!ctx.user.sessionId || !ctx.user.sessionProfile) {
    return { status: 'refused', issue: 'authenticated_staff_session_required' };
  }
  const prepared = preparedObservation(loaded.draft, compiled), preparedResult = record(prepared?.result);
  const nativeChanges = record(preparedResult?.nativeChanges), preserved = record(preparedResult?.preserved),
    price = nativePrice(preparedResult?.approvedPrices);
  const expectedSemantic = preparedResult && prepared ? sha256({ baseDigest: compiled.baseDigest,
    selectedRef: compiled.selectedRef, selected: compiled.selected, target: preparedResult.target,
    changes: nativeChanges, preserved, recoveryBaseline: preparedResult.recoveryBaseline,
    nativeDigest: preparedResult.nativeDigest, price, appliedMealPlan: appliedMealPlan(preparedResult) }) : null;
  if (!prepared || !preparedResult || !record(preparedResult.recoveryBaseline) ||
      typeof prepared.criteria.draftRevision !== 'number' || prepared.criteria.draftRevision > input.expectedRevision ||
      prepared.criteria.semanticDigest !== expectedSemantic || !nativeChanges || !preserved || !price ||
      !mealPlanVerified(loaded.draft, compiled, preparedResult) ||
      typeof preparedResult.nativeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(preparedResult.nativeDigest)) {
    return { status: 'needs_prepare', issue: 'prepared_amend_or_price_is_stale' };
  }
  if (typeof nativeChanges.guaranteeType === 'string' &&
      nativeChanges.guaranteeType !== record(preparedResult.recoveryBaseline)?.beforeGuaranteeCode) {
    return { status: 'unsupported', issue: CALLBACK_FINISH_IN_HMS, fields: ['guaranteeType'] };
  }
  if (amendMode(ctx) === 'off') return { status: 'refused', issue: 'amend_save_unavailable' };
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
  const ordinaryRecovery = structuredClone({ selected: compiled.selected, confirmation: compiled.selected.confirmation,
    reservationStayId: compiled.selected.reservationStayId, reservationId: compiled.selected.reservationId,
    recordId: compiled.selected.recordId, approved: nativeChanges, approvedPrices: price, preserved,
    nativeDigest: preparedResult.nativeDigest, prepareObservationRef: prepared.ref, approvedAfter: preparedResult.target,
    recoveryBaseline: preparedResult.recoveryBaseline, applied: preparedResult.applied,
    ...(typeof preparedResult.expectedFinalCommission === 'number' ? { expectedFinalCommission: preparedResult.expectedFinalCommission } : {}),
    requestId: input.requestId, hintId: compiled.hintId,
    operationId: input.idempotencyKey, draftRevision: input.expectedRevision });
  const claimInputBase = {
    workItemId: input.workItemId, transportId: ctx.transport.id, actorUserId: ctx.user.id,
    grantId: input.idempotencyKey, propertyCode: locked.dispatchTarget.propertyCode,
    firstName: compiled.selected.firstName, lastName: compiled.selected.lastName,
    nativeGuestId: compiled.selected.guestId, operation: 'amend' as const,
    sourceDigest: input.source.sourceHash, approvedDigest: prepared.criteria.semanticDigest as string,
    recovery: { confirmation: compiled.selected.confirmation, reservationStayId: compiled.selected.reservationStayId,
      prepareObservationRef: prepared.ref, requestId: input.requestId, hintId: compiled.hintId,
      operationId: input.idempotencyKey, draftRevision: input.expectedRevision, recoveryEvidenceDigest: sha256(ordinaryRecovery) },
    target: locked.dispatchTarget,
  };
  let approvedClaim = '';
  let lockSignal: AbortSignal | undefined;
  const authorizeFirst = async (stepValue: unknown) => {
    lockSignal?.throwIfAborted();
    const step = record(stepValue);
    if (dispatchState.claimAttempted || !step || !cloudWriterCurrent(step.writer) || step.operationDigest !== prepared.criteria.semanticDigest ||
        !['amend.guarantee', 'amend.children', 'amend.availability', 'amend.save'].includes(String(step.phase)) ||
        typeof step.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(step.requestDigest) || !dispatchState.beforeEvidence) {
      throw new Error('AMEND_APPROVAL_INVALID');
    }
    const claimInput = normalizeHmsLabtestClaim({ ...claimInputBase, requestDigest: step.requestDigest,
      recovery: { ...claimInputBase.recovery, firstPhase: step.phase,
        runId, beforeShot: dispatchState.beforeShot, writer: step.writer } });
    approvedClaim = canonicalJson(claimInput);
    if (Buffer.byteLength(approvedClaim) > 16_384) throw new Error('AMEND_CLAIM_TOO_LARGE');
    dispatchState.claimAttempted = true;
    const attempt = observationForWrite(loaded.draft!, input, compiled.hintId, 'partial', {
      outcome: 'dispatch_pending', requestDigest: step.requestDigest,
      approvedDigest: prepared.criteria.semanticDigest, prepareObservationRef: prepared.ref,
      target: preparedResult.target, before: compiled.selected, approvedPrices: price,
      beforeShot: dispatchState.beforeShot, semanticInput: preparedResult.semanticInput,
    });
    dispatchState.handle = await claimHmsLabtestDispatch(ctx.db, claimInput, async tx => {
      if (!ctx.writeRunFence) throw new Error('staff_go_required');
      await consumeStaffGoAtDispatch(tx, ctx.writeRunFence, lockSignal);
      await authorizeCurrentAmend(tx, ctx, input, compiled, prepared, prepared.criteria.semanticDigest as string, attempt);
      await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
        fieldPath: 'nava.hms.amend.recovery.v1', value: { operationId: input.idempotencyKey,
          sourceDigest: input.source.sourceHash, recovery: ordinaryRecovery }, evidence: { sourceHash: input.source.sourceHash } });
    }, expectedEpoch);
    lockSignal?.throwIfAborted();
    if (!cloudWriterCurrent(step.writer)) throw new Error('AMEND_WRITER_LOST');
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
      result = await locked.lock.withLock(async (targetSignal) => {
        lockSignal = targetSignal && ctx.signal ? AbortSignal.any([targetSignal, ctx.signal]) : targetSignal ?? ctx.signal;
        return withCloudCredentialLease(locked.dispatchTarget.propertyCode, async (credentialLease) => {
        const childAgePreimage = record(preparedResult.recoveryBaseline)?.beforeChildAges;
        if (Array.isArray(childAgePreimage)) {
          const current = await native.readCloudSavedChildAges({ target: locked.target, transportId: ctx.transport.id, credentialLease, selected: compiled.selected,
            confirmation: compiled.selected.confirmation, arrival: compiled.selected.arrival, allowRealGuest: true,
            cloudTargetKey: hmsDispatchTargetKey(locked.dispatchTarget), signal: AbortSignal.any([AbortSignal.timeout(8 * 60_000), ...(lockSignal ? [lockSignal] : [])]) });
          if (current.outcome !== 'ok' || !Array.isArray(current.ages) ||
              canonicalJson([...current.ages].sort((a, b) => Number(a) - Number(b))) !==
                canonicalJson([...childAgePreimage].sort((a, b) => Number(a) - Number(b)))) {
            return { outcome: 'not_dispatched', issue: 'AMEND_CHILD_PREIMAGE_CHANGED' };
          }
        }
        return native.commitCloudPaneAmend({ target: locked.target, transportId: ctx.transport.id, credentialLease,
        selected: compiled.selected, confirmation: compiled.selected.confirmation, arrival: compiled.selected.arrival,
        ...(Array.isArray(childAgePreimage) ? { childAgePreimage } : {}), changes: nativeChanges,
        ...(typeof nativeChanges.guaranteeType === 'string' ? { guaranteeChoiceCode: nativeChanges.guaranteeType,
          approvedGuaranteeDisplay: record(preparedResult.recoveryBaseline)?.requestedGuaranteeDisplay,
          approvedBeforeGuaranteeDisplay: record(preparedResult.recoveryBaseline)?.beforeGuaranteeDisplay,
          approvedBeforeGuaranteePrice: record(preparedResult.recoveryBaseline)?.beforeGuaranteePrice } : {}), nativeDigest: preparedResult.nativeDigest, approvedPrices: price, preserved,
        captureMealPlan: true, approvedMealPlan: appliedMealPlan(preparedResult),
        approvedBeforeMealPlan: record(preparedResult.recoveryBaseline)?.beforeMealPlan,
        captureCommissionBaseline: Object.hasOwn(nativeChanges, 'taCommission'),
        captureGuestOptInBaseline: Object.hasOwn(nativeChanges, 'guestOptIn'),
        allowRealGuest: amendMode(ctx) === 'on', cloudTargetKey: hmsDispatchTargetKey(locked.dispatchTarget),
        beforeScreenshot, afterScreenshot, signal: AbortSignal.any([AbortSignal.timeout(20 * 60_000), ...(lockSignal ? [lockSignal] : [])]) },
      { operationDigest: prepared.criteria.semanticDigest as string, authorizeFirst, sealBeforeEvidence,
        isEnabled: () => amendMode(ctx) !== 'off' });
        }, { signal: lockSignal });
      }, acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
    } catch (error) {
      result = { outcome: 'uncertain', issue: isPropertyReadLockDeadline(error) ? 'amend_lock_busy' : 'native_amend_invocation_failed' };
    }
    try { dispatchState.afterShot = await persistAmendShot(ctx, input.workItemId, runId, afterScreenshot, 'saved.png'); }
    catch { /* No positive completion without the saved evidence. */ }
  } finally { await rm(work, { recursive: true, force: true }).catch(() => {}); }
  const intent = record(result.readback);
  const nativeChecksPassed = result.outcome === 'amended' && result.writerSessionClosed === true &&
    result.dispatchCallbacksDrained === true && result.businessFieldsMatched === true;
  const readback = nativeChecksPassed ? readbackMatches(intent, preparedResult) : null;
  if (!dispatchState.handle) {
    if (dispatchState.claimAttempted) return { status: 'needs_reconcile', operationId: input.idempotencyKey,
      issue: 'amend_dispatch_claim_unconfirmed' };
    return result.outcome === 'not_dispatched'
      ? { status: 'failed', operationId: input.idempotencyKey, issue: text(result.issue) ?? 'amend_not_dispatched' }
      : { status: 'refused', issue: text(result.issue) ?? 'amend_dispatch_not_authorized' };
  }
  if (!readback || !dispatchState.beforeEvidence || !dispatchState.beforeShot || !dispatchState.afterShot) {
    const reasonCodes: string[] = [];
    if (result.outcome !== 'amended') reasonCodes.push('native_outcome_not_amended');
    if (result.writerSessionClosed !== true) reasonCodes.push('writer_session_not_closed');
    if (result.dispatchCallbacksDrained !== true) reasonCodes.push('dispatch_callbacks_not_drained');
    if (result.businessFieldsMatched !== true) reasonCodes.push('native_business_fields_not_matched');
    if (nativeChecksPassed && !readback) reasonCodes.push('approved_readback_mismatch');
    if (!dispatchState.beforeEvidence) reasonCodes.push('before_evidence_missing');
    if (!dispatchState.beforeShot) reasonCodes.push('before_screenshot_receipt_missing');
    if (!dispatchState.afterShot) reasonCodes.push('after_screenshot_receipt_missing');
    return { status: 'needs_reconcile', operationId: input.idempotencyKey, dispatchHoldId: dispatchState.handle.holdId,
      issue: 'amend_readback_or_durable_receipt_unverified', reasonCodes,
      nativeIssue: typeof result.issue === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(result.issue) ? result.issue : undefined };
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
    if (!await verifyStoredHmsShot({ ...beforeShot, name: 'before.png', owner, propertyCode: ctx.property.propertyCode,
      workItemId: input.workItemId }, 'before.png') ||
      !await verifyStoredHmsShot({ ...afterShot, name: 'saved.png', owner, propertyCode: ctx.property.propertyCode,
        workItemId: input.workItemId }, 'saved.png')) throw new Error('reservation_v2_amend_screenshot_unverified');
    const finalReceipt = { confirmation: readback.confirmation, nativeStayId: readback.nativeStayId,
      operationPhase: 'final_save', finalSave: true, freshReadbackDigest: sha256(readback) };
    await resolveHmsLabtestDispatch(ctx.db, handle, { operation: 'amend', confirmation: String(readback.confirmation),
      nativeStayId: String(readback.nativeStayId), nativeReadback: finalReceipt,
      readbackDigest: sha256(finalReceipt), savedShot: afterShot }, async (tx, durableIntent) => {
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
  if (!getPropertyRegistration(ctx.property.propertyCode)?.active) return { status: 'unsupported', issue: 'property_not_supported' };
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
  const expectedTarget = before ? hmsDispatchTargetSchema.safeParse({ propertyCode: ctx.property.propertyCode, kind: 'saved',
    confirmation: before.confirmation, nativeStayId: before.reservationStayId }) : null;
  const intent = intents.find((row) => {
    const recovery = record(row.recovery), target = hmsDispatchTargetSchema.safeParse(row.target);
    if (row.workItemId !== input.workItemId || row.transportId !== ctx.transport.id || row.propertyCode !== ctx.property.propertyCode ||
        row.sourceDigest !== input.source.sourceHash || row.approvedDigest !== (attemptResult?.reviewDigest ?? attemptResult?.approvedDigest) ||
        recovery?.requestId !== operation.requestId || recovery.hintId !== operation.allocationId ||
        recovery.operationId !== operation.id || recovery.prepareObservationRef !== prepareObservationRef ||
        recovery.draftRevision !== operation.draftRevision || !expectedTarget?.success || !target.success) return false;
    return hmsDispatchTargetKey(target.data) === hmsDispatchTargetKey(expectedTarget.data);
  });
  if (!intent || typeof intent.holdId !== 'string' || !z.string().uuid().safeParse(intent.holdId).success) {
    return { status: 'needs_reconcile', operationId: input.operationId, issue: 'amend_dispatch_intent_scope_unverified' };
  }
  if (record(intent.recovery)?.firstGo === true || typeof record(intent.recovery)?.reviewDigest === 'string') {
    const claimRecovery = record(intent.recovery)!;
    if (!cloudWriterQuiesced(claimRecovery.writer)) return { status: 'needs_reconcile', operationId: input.operationId,
      dispatchHoldId: intent.holdId, issue: 'amend_writer_not_quiesced', partialEffect: 'possible' };
    const recoveryRows = await ctx.db.select({ value: workEvent.value }).from(workEvent).where(and(
      eq(workEvent.workItemId, input.workItemId), eq(workEvent.type, 'write.evidence'),
      eq(workEvent.fieldPath, 'nava.hms.amend.callback-recovery.v1'))).limit(2000);
    const matches = recoveryRows.map(row => record(row.value)).filter(row => row?.operationId === input.operationId &&
      row.sourceDigest === input.source.sourceHash && record(row.recovery) &&
      sha256(row.recovery) === claimRecovery.recoveryEvidenceDigest);
    const recovery = matches.length === 1 ? record(matches[0]?.recovery) : null;
    if (!recovery) return { status: 'needs_reconcile', operationId: input.operationId, dispatchHoldId: intent.holdId,
      issue: 'amend_callback_recovery_evidence_unavailable', partialEffect: 'possible',
      message: 'Details may have changed in HMS. Check the reservation and resolve this operation before retrying.' };
    const selected = recovery.selected, plan = record(recovery.callbackPlan),
      baseline = record(recovery.recoveryBaseline), preserved = record(recovery.preserved), changes = record(recovery.approved);
    let nativeState: Record<string, unknown> | null = null;
    if (validNative(selected, ctx.property.propertyCode) && plan && baseline && preserved && changes) {
      try {
        const partials = await ctx.db.select({ value: workEvent.value }).from(workEvent).where(and(
          eq(workEvent.workItemId, input.workItemId), eq(workEvent.type, 'write.evidence'),
          eq(workEvent.fieldPath, 'nava.hms.amend.callback-partial.v1'))).limit(2000);
        const matching = partials.map(row => record(row.value)).filter(row => row?.operationId === input.operationId &&
          row.sourceDigest === input.source.sourceHash);
        const callbackEffects = matching.length === 1 && Array.isArray(matching[0]?.effects) ? matching[0]?.effects : [];
        const locked = targetWriteLock(ctx, selected), native = await nativeModule();
        if (locked?.lock) {
          const fresh = await locked.lock.withLock((signal) => {
            signal?.throwIfAborted();
            if (!cloudWriterQuiesced(claimRecovery.writer)) throw new Error('amend_writer_not_quiesced');
            return native.readCloudCallbackReviewState({ target: locked.target, transportId: ctx.transport.id, selected,
            confirmation: selected.confirmation, arrival: selected.arrival, allowRealGuest: true,
            cloudTargetKey: hmsDispatchTargetKey(locked.dispatchTarget), callbackPlan: plan, before: baseline,
            preserved, changes, callbackEffects, capturePriceComponents: true,
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8 * 60_000)]) : AbortSignal.timeout(8 * 60_000) });
          },
          acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
          if (fresh.outcome === 'matched') nativeState = { callbackState: fresh.callbackState, savedPrice: fresh.savedPrice };
        }
      } catch { /* Keep the hold and report that fresh readback is unavailable. */ }
    }
    return { status: 'needs_reconcile', operationId: input.operationId, dispatchHoldId: intent.holdId,
      issue: 'amend_callback_partial_reconciliation_required', partialEffect: 'possible', nativeState,
      message: 'Details may have changed in HMS. Check the reservation and resolve this operation before retrying.' };
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
