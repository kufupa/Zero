import type { ReservationWorkflowV2SystemReadContext } from './reservation-workflow-v2-system-read-context.js';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import type { AiRunFence } from './run-ledger.js';
import { consumeStaffGoAtDispatch } from './hms-approval.js';
import { mailboxAccess, mailThread, message } from '../db/schema/mail.js';
import { workEvent, workItem } from '../db/schema/work.js';
import type { HmsReadTarget } from '../hms/hms-read-target.js';
import { getPropertyRegistration } from '../../tooling/hms-cloud/property-registry.mjs';
import { effectiveWorkflowPolicy } from '../../tooling/hms-cloud/hms-workflow-policy.mjs';
import { MESSAGE_ARRIVED_AT } from './message-arrival-time.js';
import { canonicalJson } from './draft-approval.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';
import { acquisitionWithin, isPropertyReadLockDeadline, PANE_PROPERTY_LOCK_WAIT_MS } from '../hms/property-read-lock.js';
import { paneStayCloudTargetLock, paneStayPropertyLock, paneWriteMode } from './pane-stay-save.js';
import { projectCloudStayFind, runCloudStayFind } from './hms-cloud-saved-stay-find.js';
import { savedTargetExclusionIssue } from './reservation-workflow-v2-services.js';
import { paneStayLookupEnabled } from './pane-stay-lookup.js';
import { lockCreateActorSession } from './pane-create-actor-lock.js';
import { hmsDispatchTargetKey, hmsDispatchTargetKeys, hmsDispatchTargetSchema, type HmsDispatchTarget } from './hms-dispatch-target.js';
import { captureHmsLabtestDispatchEpoch, claimHmsLabtestDispatch, HmsLabtestDispatchError,
  consumeNeverDispatchedCancelProof, resolveHmsLabtestDispatch, resolveNeverDispatchedCancel,
  type HmsLabtestIntent, type HmsLabtestWriteHandle } from './hms-labtest-dispatch.js';
import { persistHmsShots, verifyStoredHmsShot } from './hms-shots-store.js';
import { runCloudCancellation } from './pane-cloud-cancel.js';
import { cancellationPenaltyNotice } from '../../tooling/hms-cloud/cancel-penalty-notice.mjs';
import { projectCloudCancellationPreview } from './hms-cloud-cancellation-preview.js';
import {
  reservationWorkflowV2DraftSchema,
  type ReservationWorkflowV2Draft,
  type ReservationWorkflowV2ExecuteInput,
  type ReservationWorkflowV2LookupInput,
  type ReservationWorkflowV2Observation,
  type ReservationWorkflowV2PrepareInput,
  type ReservationWorkflowV2ReconcileInput,
  type ReservationWorkflowV2Source,
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

/** V2 cancellation is source-bound to one authenticated property and one saved-stay target. */
export type ReservationWorkflowV2CancelContext = {
  db: DB;
  transport: { id: string };
  user: { id: string; sessionId?: string; sessionProfile?: 'legacy' | 'remote' };
  property: { propertyCode: string };
  writeRunFence?: AiRunFence;
  signal?: AbortSignal;
  nativeBatch?: ReservationNativeCheckBatch;
  recovery?: ReservationWorkflowV2Context['recovery'];
};
type ReadContext = ReservationWorkflowV2CancelContext | ReservationWorkflowV2SystemReadContext;

type StateContext = ReservationWorkflowV2Context;
type CancelActorSession = { sessionId: string; sessionProfile: 'legacy' | 'remote' };
type CancelOutcome = { status: string; issue?: string; [key: string]: unknown };
type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
type NativeCancelResult = {
  outcome?: string; issue?: string; expected?: unknown; reasons?: unknown; policyFacts?: unknown; penaltyText?: unknown;
  requestDispatched?: boolean; writerSessionClosed?: boolean; dispatchCallbacksDrained?: boolean;
  nativeReadback?: unknown; runDir?: unknown; screenshots?: unknown; chargeApproved?: unknown; chargeDispatched?: unknown;
  staged?: unknown;
  zeroPenaltyNotice?: unknown; neverDispatchedProof?: unknown; penaltyAmount?: unknown; penaltyTiming?: unknown;
  penaltyNoticeAcknowledged?: unknown;
};
type CancelHint = {
  id: string; confirmation?: string; guestName?: string; bookedArrival?: string; bookedDeparture?: string;
  candidateRefs: string[]; suggestedRef: string | null; sourceRefs: string[];
};
type CancelCompile = {
  outcome: 'ok'; requestId: string; hintId: string; hintIndex: number; hint: CancelHint;
  selectionPath: string; selectionRef: string; selectedObservation: ReservationWorkflowV2Observation;
  sourceHintMismatchFields: string[];
  preimage: CancelPreimage; selectedPreflight: Record<string, unknown>;
  reasonText: string | null; cancellationNote: string; reasonSourceRefs: string[]; sourceRefs: string[];
  previewObservationRefs: string[]; semanticInput: Record<string, unknown>; semanticDigest: string;
  bodyPath: string; reviewPath: string;
} | { outcome: 'needs_input' | 'needs_review' | 'unsupported'; issue: string; fields?: string[]; hintId?: string };

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
// HMS dialogs break penalty text over several lines. Staff review and the second Go bind one-line text.
const penaltyLine = (value: unknown): unknown => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : value;
const ptr = (...parts: Array<string | number>) => `/${parts.map((part) => encodeURIComponent(String(part))).join('/')}`;
const sameName = (left: unknown, right: unknown): boolean => typeof left === 'string' && typeof right === 'string' &&
  left.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase() ===
  right.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
});
const cancelPreimageSchema = z.object({
  propertyCode: z.enum(['HRCEN', 'HRDAV', 'HRDAVS']).optional(),
  confirmation: z.string().regex(/^\d+-\d+$/), guestId: z.string().regex(/^\d{1,30}$/),
  nativeStayId: z.string().regex(/^\d{1,100}$/),
  firstName: z.string().trim().min(1).max(200).refine((name) => !/[\p{Cc}]/u.test(name)),
  lastName: z.string().trim().min(1).max(200).refine((name) => !/[\p{Cc}]/u.test(name)),
  arrival: day, departure: day, roomType: z.string().min(1).max(12), ratePlan: z.string().min(1).max(12),
  note: z.string().max(2000), depositReceived: z.string().nullable(),
  expectedGuarantee: z.object({ code: z.string().max(200), display: z.string().max(200) }).strict(),
  cmsSend: z.boolean(), allowRealGuest: z.boolean(),
}).strict();
type CancelPreimage = z.infer<typeof cancelPreimageSchema>;
const reasonOptionSchema = z.object({ value: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  display: z.string().trim().min(1).max(120).refine((value) => !/[\p{Cc}]/u.test(value)) }).strict();
const reasonOptionsSchema = z.array(reasonOptionSchema).min(1).max(100)
  .refine((rows) => new Set(rows.map((row) => row.value)).size === rows.length &&
    new Set(rows.map((row) => row.display)).size === rows.length);
/** The unsaved staged reason, note and dialog text staff reviewed. Dispatch must name the same reason and note. */
const stagedCancelSchema = z.object({ reasonCode: reasonOptionSchema.shape.value, reasonLabel: reasonOptionSchema.shape.display,
  cancellationNote: z.string().max(200).refine((value) => !/[\p{Cc}]/u.test(value)),
  dialogText: z.string().max(2000).nullable(),
  penaltyText: z.string().trim().min(1).max(2000).nullable() }).strict();
const reviewNote = (observationRef: string, approvalDigest: string) =>
  `cancel-preview:${observationRef}:${approvalDigest}`;

function stateContext(ctx: ReadContext): StateContext {
  return { db: ctx.db, transportId: ctx.transport.id, userId: 'system' in ctx || ctx.nativeBatch ? null : ctx.user.id,
    propertyCode: ctx.property.propertyCode, nativeBatch: ctx.nativeBatch, recovery: ctx.recovery };
}

function currentTarget(ctx: ReadContext): HmsReadTarget | null {
  const resolved = paneStayHmsTargetForTransport(ctx.transport.id, ctx.property.propertyCode);
  return resolved.ok && resolved.target.propertyCode === ctx.property.propertyCode
    ? resolved.target : null;
}

async function currentDraft(ctx: ReadContext, input: {
  workItemId: string; source: ReservationWorkflowV2Source; expectedRevision: number; expectedSeq: number;
}) {
  const result = await getReservationWorkflowV2Draft(stateContext(ctx), input);
  if (result.status !== 'ok') return { result, draft: null } as const;
  if (result.revision !== input.expectedRevision || result.seq !== input.expectedSeq ||
      result.draft.revision !== input.expectedRevision) return { result: { status: 'stale_revision' as const }, draft: null } as const;
  return { result, draft: reservationWorkflowV2DraftSchema.parse(result.draft) } as const;
}

type LeafValue = { value: unknown; path: string; unset?: boolean } | { issue: string };
function leaf(draft: ReservationWorkflowV2Draft, path: string, source: unknown): LeafValue {
  const override = draft.fieldOverrides[path];
  if (override) {
    if (override.state === 'unknown') return { issue: 'unknown_staff_value' };
    if (override.state === 'set') return { value: override.value, path };
    if (override.state === 'none' || override.state === 'clear') return { value: undefined, path, unset: true };
    if (override.state === 'inherit') return { value: source, path };
  }
  if (source && typeof source === 'object' && !Array.isArray(source) &&
      (source as { kind?: unknown }).kind === 'none') return { value: undefined, path, unset: true };
  return { value: source, path };
}

function effectiveSubtree(draft: ReservationWorkflowV2Draft, source: unknown, path: string, unknownPaths: Set<string>): unknown {
  const resolved = leaf(draft, path, source);
  if ('issue' in resolved) { unknownPaths.add(path); return null; }
  if (resolved.unset) return null;
  const value = resolved.value;
  if (Array.isArray(value)) return value.map((item, index) => effectiveSubtree(draft, item, `${path}/${index}`, unknownPaths));
  if (value && typeof value === 'object') {
    const fields = new Set(Object.keys(value));
    const prefix = `${path}/`;
    for (const fieldPath of Object.keys(draft.fieldOverrides)) {
      if (!fieldPath.startsWith(prefix)) continue;
      const rest = fieldPath.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      try { fields.add(decodeURIComponent(rest)); } catch { /* Ignore malformed paths; editable paths are validated. */ }
    }
    return Object.fromEntries([...fields].map((key) => [key, effectiveSubtree(draft,
      (value as Record<string, unknown>)[key], `${path}/${encodeURIComponent(key)}`, unknownPaths)]));
  }
  return value;
}

function uniqueRefs(values: unknown[]): string[] {
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : typeof value === 'string' ? [value] : []))]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/** Evidence refs are not observation refs; preserve them in the result and link their admitted source observation. */
function sourceObservationRefs(draft: ReservationWorkflowV2Draft, values: unknown[]): string[] {
  const refs = new Set(uniqueRefs(values));
  return draft.observations.filter((item) => item.generationId === draft.generationId &&
    item.propertyCode === draft.propertyCode && item.sourceMessageId === draft.source.messageId &&
    (refs.has(item.ref) || (item.kind === 'source' && Array.isArray(item.result.evidenceRefs) &&
      item.result.evidenceRefs.some((ref) => typeof ref === 'string' && refs.has(ref)))))
    .map((item) => item.ref);
}

function cancelRequest(draft: ReservationWorkflowV2Draft, requestId: string) {
  return draft.proposal.content.requests.find((request) => request.id === requestId && request.kind === 'cancel') ?? null;
}

function effectiveBody(draft: ReservationWorkflowV2Draft, requestId: string) {
  const request = cancelRequest(draft, requestId);
  if (!request || request.kind !== 'cancel') return null;
  const bodyPath = ptr('proposal', 'content', 'requests', requestId, 'body');
  const unknownPaths = new Set<string>();
  const body = effectiveSubtree(draft, request.body, bodyPath, unknownPaths);
  return { request, bodyPath, body: record(body), unknownPaths };
}

const identityHintFields = ['confirmation', 'guestName', 'bookedArrival', 'bookedDeparture'] as const;

function unknownHintPaths(unknownPaths: Set<string>, bodyPath: string, index: number): string[] {
  const path = `${bodyPath}/targets/include/${index}`;
  return identityHintFields.map((field) => `${path}/${field}`).filter((fieldPath) => unknownPaths.has(fieldPath));
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
    for (const field of identityHintFields) {
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
  if (exclusions.issue) return { issue: 'cancel_target_exclusion_identity_unresolved', fields: [path, ...exclusions.fields] };
  for (const row of exclusions.rows) {
    if (row.unresolved) return { issue: 'cancel_target_exclusion_identity_unresolved', hintId: text(row.hint.id) ?? undefined,
      fields: [path, ...row.fields] };
    const issue = savedTargetExclusionIssue(stay, [row.hint], false);
    if (issue) return { issue: issue === 'saved_target_exclusion_overlaps_native_stay'
      ? 'cancel_target_exclusion_overlaps_native_stay' : 'cancel_target_exclusion_identity_unresolved',
    hintId: text(row.hint.id) ?? undefined, fields: [path, `${path}/${row.index}`] };
  }
  return null;
}

function targetHintRows(body: Record<string, unknown> | null): CancelHint[] | null {
  const targets = record(body?.targets);
  if (!Array.isArray(targets?.include)) return null;
  const rows = targets.include.map(record);
  if (rows.some((row) => !row)) return null;
  return (rows as Record<string, unknown>[]).map((row) => {
    const hint = { ...row };
    for (const field of identityHintFields) {
      const value = hint[field];
      if (value === null || (typeof value === 'string' && !value.trim())) delete hint[field];
      else if (typeof value === 'string') hint[field] = value.trim();
    }
    return hint as unknown as CancelHint;
  });
}

function requestedHint(body: Record<string, unknown>, allocationId?: string): { hint: CancelHint; index: number } | null {
  const targets = record(body.targets), rows = targetHintRows(body);
  if (!targets || !rows || targets.mode !== 'explicit' || !Array.isArray(targets.exclude)) return null;
  const hintId = allocationId ?? (rows.length === 1 ? rows[0]?.id : undefined);
  if (!hintId) return null;
  const index = rows.findIndex((hint) => hint.id === hintId);
  return index >= 0 ? { hint: rows[index]!, index } : null;
}

function expectedTargetIdentity(preimage: CancelPreimage) {
  return { confirmation: preimage.confirmation, nativeStayId: preimage.nativeStayId, guestId: preimage.guestId,
    firstName: preimage.firstName, lastName: preimage.lastName, arrival: preimage.arrival, departure: preimage.departure };
}

function matchesHint(preimage: CancelPreimage, hint: CancelHint): boolean {
  return (!hint.confirmation || hint.confirmation === preimage.confirmation) &&
    (!hint.guestName || sameName(hint.guestName, `${preimage.firstName} ${preimage.lastName}`)) &&
    (!hint.bookedArrival || hint.bookedArrival === preimage.arrival) &&
    (!hint.bookedDeparture || hint.bookedDeparture === preimage.departure);
}

function sourceHintMismatchFields(current: Record<string, unknown>, hint: CancelHint): string[] {
  const fields: string[] = [];
  const currentName = `${text(current.firstName) ?? ''} ${text(current.lastName) ?? ''}`.trim();
  if (hint.guestName && !sameName(hint.guestName, currentName) && !sameName(hint.guestName, current.lastName)) fields.push('guestName');
  if (hint.bookedArrival && hint.bookedArrival !== current.arrival) fields.push('bookedArrival');
  if (hint.bookedDeparture && hint.bookedDeparture !== current.departure) fields.push('bookedDeparture');
  return fields;
}

function observation(draft: ReservationWorkflowV2Draft, input: ReservationWorkflowV2LookupInput | ReservationWorkflowV2PrepareInput |
  ReservationWorkflowV2ExecuteInput, requestId: string, hintId: string, stage: string, status: ReservationWorkflowV2Observation['status'],
  criteria: Record<string, unknown>, result: Record<string, unknown>, notes: string[] = []): ReservationWorkflowV2Observation {
  return { ref: randomUUID(), generationId: draft.generationId, kind: 'stay_candidate', status,
    observedAt: new Date().toISOString(), propertyCode: draft.propertyCode, sourceMessageId: draft.source.messageId,
    sourceRefs: sourceObservationRefs(draft, [criteria.sourceRefs, result.sourceRefs]),
    criteria: { workflow: 'cancel', stage, requestId, hintId, draftRevision: input.expectedRevision, ...criteria },
    coverage: { complete: status === 'complete', notes: status === 'complete' ? [] : notes }, result };
}

function safeRunDir(path: unknown): path is string {
  return typeof path === 'string' && dirname(path) === tmpdir() && basename(path).startsWith('pane-cloud-cancel-');
}

async function removeNativeRunDir(path: unknown): Promise<void> {
  if (safeRunDir(path)) await rm(path, { recursive: true, force: true }).catch(() => {});
}

type PreflightResult = { outcome: 'ok'; facts: Record<string, unknown>; observedAt: string | null } |
  { outcome: 'failed'; issue: string };

/** A display-only received deposit can establish payment, but a blank or zero
 * display and a zero balance cannot establish that the reservation is unpaid. */
export function cancellationFinancialHandling(money: unknown, folio: unknown): {
  paymentStatus: 'paid' | 'unknown'; authority: 'paid'; evidence: string;
} {
  const received = record(record(record(money)?.depositReceived)?.amount);
  const folioReceived = record(record(folio)?.depositReceived);
  const display = typeof received?.value === 'string' ? received.value.trim() : '';
  const amount = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(display)
    ? display.replace(/[,.0]/g, '') : '';
  const conflictingFolio = ['observed_zero', 'ambiguous', 'conflict'].includes(String(folioReceived?.state));
  if (received?.state === 'observed' && amount && !conflictingFolio) {
    return { paymentStatus: 'paid', authority: 'paid', evidence: 'native_deposit_received_display' };
  }
  return { paymentStatus: 'unknown', authority: 'paid', evidence: 'payment_not_established_by_native_display' };
}

/** Run only the existing restricted read → prepareCancellation native sequence, then close its browser. */
async function cancellationPreflight(target: HmsReadTarget, transportId: string, confirmation: string,
  arrival?: string, signal?: AbortSignal, cloudTargetKey?: string): Promise<PreflightResult> {
  try {
    const module = await import(new URL('../../tooling/hms-cloud/cancellation-preflight-session.mjs', import.meta.url).href) as {
      withCancellationPreflightSession: <T>(
        operation: (session: { runTool: (request: Record<string, unknown>) => Promise<unknown> }) => Promise<T>,
        options: { propertyCode: string; transportId: string; confirmation: string; signal?: AbortSignal; cloudTargetKey?: string },
      ) => Promise<T>;
    };
    const raw = record(await module.withCancellationPreflightSession(async ({ runTool }) => {
      const read = await runTool({ tool: 'read', confirmation, ...(arrival ? { arrivalDate: arrival } : {}), view: 'record' });
      if (record(read)?.outcome !== 'ok') return { outcome: 'read_failed', issue: 'CANCELLATION_PREFLIGHT_READ_FAILED' };
      return runTool({ tool: 'prepareCancellation', requestedScope: 'unspecified' });
    }, { propertyCode: target.propertyCode, transportId, confirmation, cloudTargetKey,
      signal: signal ?? AbortSignal.timeout(15 * 60_000) }));
    const projected = projectCloudCancellationPreview({ confirmation, ...(arrival ? { arrival } : {}) }, raw);
    if (!raw || projected.outcome !== 'prepared_for_human_review' || raw.outcome !== 'prepared_for_human_review') {
      return { outcome: 'failed', issue: projected.reason ?? (typeof raw?.issue === 'string' ? raw.issue : 'CANCELLATION_PREFLIGHT_UNAVAILABLE') };
    }
    const facts = {
      target: raw.target, stay: { ...record(raw.stay), arrivalDate: projected.stay.arrivalDate,
        departureDate: projected.stay.departureDate }, roomScope: raw.roomScope, money: raw.money, folio: raw.folio,
      policy: raw.policy, fee: raw.fee, action: raw.action,
      financialHandling: cancellationFinancialHandling(raw.money, raw.folio),
    };
    const stay = record(raw.stay), status = record(stay?.status), actualArrival = projected.stay.arrivalDate,
      actualDeparture = projected.stay.departureDate, roomScope = record(raw.roomScope), fee = record(raw.fee),
      policy = record(raw.policy), action = record(raw.action), nativeTarget = record(raw.target);
    if (nativeTarget?.confirmation !== confirmation || nativeTarget.verified !== true ||
        status?.state !== 'observed' || status.value !== 'Reserved' || actualArrival?.state !== 'observed' ||
        actualDeparture?.state !== 'observed' || typeof actualArrival.value !== 'string' || typeof actualDeparture.value !== 'string' ||
        !day.safeParse(actualArrival.value).success || !day.safeParse(actualDeparture.value).success ||
        (arrival !== undefined && actualArrival.value !== arrival) || roomScope?.requested !== 'unspecified' ||
        roomScope.state !== 'unresolved' || roomScope.complete !== false || policy?.state !== 'unknown' ||
        fee?.state !== 'unknown_precommit' || fee.amount !== null || fee.currency !== null ||
        action?.actor !== 'human' || action.cancellationStarted !== false || action.commitAvailable !== false) {
      return { outcome: 'failed', issue: 'CANCELLATION_PREFLIGHT_SHAPE_UNVERIFIED' };
    }
    return { outcome: 'ok', facts, observedAt: typeof raw.observedAt === 'string' ? raw.observedAt : null };
  } catch { return { outcome: 'failed', issue: 'CANCELLATION_PREFLIGHT_UNAVAILABLE' }; }
}

async function nativeCancelRead(target: HmsReadTarget, confirmation: string, arrival: string, transportId: string,
  signal?: AbortSignal): Promise<CancelPreimage | null> {
  let native: NativeCancelResult | null = null;
  try {
    native = await runCloudCancellation({ mode: 'read', target, transportId, signal, confirmation, arrival, allowRealGuest: true }) as NativeCancelResult;
    const expected = cancelPreimageSchema.safeParse(native.expected);
    return native.outcome === 'read' && expected.success && expected.data.propertyCode === target.propertyCode && expected.data.confirmation === confirmation &&
      expected.data.arrival === arrival ? expected.data : null;
  } catch { return null; }
  finally { await removeNativeRunDir(native?.runDir); }
}

async function safeCancelTargetRead(target: HmsReadTarget, confirmation: string, arrival?: string, signal?: AbortSignal, transportId?: string) {
  if (!paneStayLookupEnabled()) return null;
  const request = { confirmation, ...(arrival ? { arrival } : {}) };
  const lock = paneStayPropertyLock(target);
  if (!lock) return null;
  const readSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]) : AbortSignal.timeout(5 * 60_000);
  try {
    return await lock.withLock(async () => projectCloudStayFind(request,
      await runCloudStayFind({ request, target, transportId, signal: readSignal, nativeIdentityOnly: true })),
    { ...acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS), ...(signal ? { signal } : {}) });
  } catch { return null; }
}

type FreshPreview = {
  outcome: 'ok'; preimage: CancelPreimage; preflight: Record<string, unknown>;
  reasons: z.infer<typeof reasonOptionsSchema>; policyFacts: string[]; penaltyText: string | null;
  staged: z.infer<typeof stagedCancelSchema> | null;
  observedAt: string | null; screenshots: string[]; runDir: string | null;
} | { outcome: 'failed'; issue: string; reasons?: z.infer<typeof reasonOptionsSchema>;
  preimage?: CancelPreimage; preflight?: Record<string, unknown>; policyFacts?: string[];
  penaltyText?: string | null; observedAt?: string | null; runDir?: string | null };

async function freshPreview(target: HmsReadTarget, confirmation: string, hint: CancelHint, allowPreviewCharge = true,
  cloudTargetKey?: string, signal?: AbortSignal, allowReviewedSourceMismatch = false, transportId?: string,
  stage?: { reasonLabel: string; cancellationNote: string }): Promise<FreshPreview> {
  if (!transportId) return { outcome: 'failed', issue: 'cancel_transport_unavailable' };
  const initial = await cancellationPreflight(target, transportId, confirmation,
    allowReviewedSourceMismatch ? undefined : hint.bookedArrival, signal, cloudTargetKey);
  if (initial.outcome !== 'ok') return initial;
  const stay = record(initial.facts.stay), arrivalFact = record(stay?.arrivalDate), departureFact = record(stay?.departureDate);
  const arrival = text(arrivalFact?.value), departure = text(departureFact?.value);
  if (!arrival || !departure || (!allowReviewedSourceMismatch && hint.bookedDeparture && hint.bookedDeparture !== departure)) {
    return { outcome: 'failed', issue: 'CANCELLATION_TARGET_DATE_MISMATCH' };
  }
  let native: NativeCancelResult | null = null;
  try {
    native = await runCloudCancellation({ mode: 'preview', target, transportId, confirmation, arrival, allowRealGuest: true,
      ...(cloudTargetKey ? { cloudTargetKey } : {}), ...(signal ? { signal } : {}),
      ...(stage ? { previewStage: stage } : {}) }) as NativeCancelResult;
    const expected = cancelPreimageSchema.safeParse(native.expected), reasons = reasonOptionsSchema.safeParse(native.reasons),
      policyFacts = z.array(z.string().trim().min(1).max(260)).max(12).safeParse(native.policyFacts ?? []),
      penaltyText = z.string().trim().min(1).max(2000).nullable().safeParse(penaltyLine(native.penaltyText ?? null)),
      staged = stagedCancelSchema.safeParse(native.staged);
    if (native.outcome === 'refused_reason_missing' && stage) {
      // The refused dialog still reports the verified stay and its native reason list. Reattach
      // them only when the run proves nothing was dispatched and its writer session closed, and
      // the identity matches this preview's stay, so prepare can persist the options for staff
      // instead of returning them in the transient reply alone.
      if (native.requestDispatched !== false || native.writerSessionClosed !== true) {
        return { outcome: 'failed', issue: 'CANCEL_REASON_MISMATCH_UNVERIFIED',
          runDir: safeRunDir(native.runDir) ? native.runDir : null };
      }
      const verifiedPreimage = expected.success && expected.data.propertyCode === target.propertyCode &&
        expected.data.confirmation === confirmation && expected.data.arrival === arrival &&
        expected.data.departure === departure &&
        (expected.data.allowRealGuest || (expected.data.firstName === 'Proof' && expected.data.lastName === 'Labtest' &&
          expected.data.arrival >= '2027-01-01' && expected.data.cmsSend === false)) &&
        (matchesHint(expected.data, hint) ||
          (allowReviewedSourceMismatch && expected.data.confirmation === hint.confirmation))
        ? expected.data : null;
      return { outcome: 'failed', issue: 'CANCEL_REASON_MISMATCH',
        ...(reasons.success ? { reasons: reasons.data } : {}),
        ...(verifiedPreimage ? { preimage: verifiedPreimage, preflight: initial.facts, observedAt: initial.observedAt,
          ...(policyFacts.success ? { policyFacts: policyFacts.data } : {}),
          ...(penaltyText.success ? { penaltyText: penaltyText.data } : {}) } : {}),
        runDir: safeRunDir(native.runDir) ? native.runDir : null };
    }
    if (native.outcome !== 'preview_ok' || native.requestDispatched !== false || native.writerSessionClosed !== true ||
        !expected.success || !reasons.success || !policyFacts.success || !penaltyText.success ||
        expected.data.propertyCode !== target.propertyCode || expected.data.confirmation !== confirmation || expected.data.arrival !== arrival || expected.data.departure !== departure ||
        (!expected.data.allowRealGuest && (expected.data.firstName !== 'Proof' || expected.data.lastName !== 'Labtest' ||
          expected.data.arrival < '2027-01-01' || expected.data.cmsSend !== false))) {
      return { outcome: 'failed', issue: native.outcome === 'refused_scope_unverified' ? 'CANCELLATION_SCOPE_UNVERIFIED' :
        native.issue ?? native.outcome ?? 'CANCELLATION_PREVIEW_UNAVAILABLE', runDir: safeRunDir(native.runDir) ? native.runDir : null };
    }
    if (!matchesHint(expected.data, hint) && !(allowReviewedSourceMismatch && expected.data.confirmation === hint.confirmation)) {
      return { outcome: 'failed', issue: 'CANCELLATION_TARGET_HINT_MISMATCH', runDir: safeRunDir(native.runDir) ? native.runDir : null };
    }
    // A staged request must come back bound to that exact reason and note. An absent staged result is
    // only a pre-reason fee dialog that pre-empted staging; a silent or mismatched stage never counts.
    const stagedResult = !stage ? null : staged.success && staged.data.reasonLabel === stage.reasonLabel &&
        staged.data.cancellationNote === stage.cancellationNote &&
        reasons.data.some((reason) => reason.value === staged.data.reasonCode && reason.display === staged.data.reasonLabel)
      ? staged.data : null;
    if (stage && !stagedResult && !(native.staged === undefined && penaltyText.data !== null)) {
      return { outcome: 'failed', issue: 'CANCEL_STAGE_UNVERIFIED', runDir: safeRunDir(native.runDir) ? native.runDir : null };
    }
    const financialHandling = record(initial.facts.financialHandling);
    const received = record(record(record(initial.facts.money)?.depositReceived)?.amount);
    if (financialHandling?.paymentStatus === 'paid' &&
        (typeof received?.value !== 'string' || received.value.trim() !== expected.data.depositReceived?.trim())) {
      initial.facts.financialHandling = { paymentStatus: 'unknown', authority: 'paid',
        evidence: 'native_deposit_display_changed_between_reads' };
    }
    if (!allowPreviewCharge && penaltyText.data !== null) {
      return { outcome: 'failed', issue: 'CANCELLATION_PENALTY_CHANGED', runDir: safeRunDir(native.runDir) ? native.runDir : null };
    }
    return { outcome: 'ok', preimage: expected.data, preflight: initial.facts, reasons: reasons.data,
      policyFacts: policyFacts.data, penaltyText: penaltyText.data, staged: stagedResult, observedAt: initial.observedAt,
      screenshots: Array.isArray(native.screenshots) ? native.screenshots.filter((path): path is string => typeof path === 'string') : [],
      runDir: safeRunDir(native.runDir) ? native.runDir : null };
  } catch { return { outcome: 'failed', issue: 'CANCELLATION_PREVIEW_UNAVAILABLE', runDir: safeRunDir(native?.runDir) ? native!.runDir as string : null }; }
}

function stablePreflight(facts: Record<string, unknown>): unknown {
  return { target: facts.target, stay: facts.stay, roomScope: facts.roomScope, money: facts.money, folio: facts.folio,
    policy: facts.policy, fee: facts.fee, action: facts.action, financialHandling: facts.financialHandling };
}

function approvalDigest(compiled: Extract<CancelCompile, { outcome: 'ok' }>, fresh: Extract<FreshPreview, { outcome: 'ok' }>): string {
  return sha256({ workflow: 'cancel', requestId: compiled.requestId, hintId: compiled.hintId,
    semanticDigest: compiled.semanticDigest, sourceRefs: compiled.sourceRefs, target: expectedTargetIdentity(fresh.preimage),
    baseline: fresh.preimage, preflight: stablePreflight(fresh.preflight),
    native: { reasons: fresh.reasons, policyFacts: fresh.policyFacts, penaltyText: fresh.penaltyText,
      staged: fresh.staged } });
}

function supportedCancelOverride(path: string, bodyPath: string, body: Record<string, unknown>): boolean {
  const prefix = `${bodyPath}/`;
  if (!path.startsWith(prefix)) return false;
  let parts: string[];
  try { parts = path.slice(prefix.length).split('/').map(decodeURIComponent); }
  catch { return false; }
  if (parts.length === 1 && parts[0] === 'cancellationNote') return true;
  if (parts.length === 2 && parts[0] === 'reason' && parts[1] === 'text') return true;
  if (parts.length === 2 && parts[0] === 'targets' && ['mode', 'include', 'exclude'].includes(parts[1] ?? '')) return true;
  if (parts[0] === 'previewObservationRefs' && (parts.length === 1 ||
      (parts.length === 2 && /^(?:0|[1-9]\d*)$/.test(parts[1] ?? '')))) return true;
  if (parts.length !== 4 || parts[0] !== 'targets' || !['include', 'exclude'].includes(parts[1] ?? '') ||
      !['confirmation', 'guestName', 'bookedArrival', 'bookedDeparture', ...(parts[1] === 'include' ? ['suggestedRef'] : [])].includes(parts[3] ?? '')) return false;
  const targets = record(body.targets), rows = targets?.[parts[1] ?? ''];
  if (!Array.isArray(rows)) return false;
  if (parts[1] === 'include' && !/^(?:0|[1-9]\d*)$/.test(parts[2] ?? '')) return false;
  const row = /^(?:0|[1-9]\d*)$/.test(parts[2] ?? '') ? record(rows[Number(parts[2])])
    : rows.map(record).find((value) => value?.id === parts[2]);
  return Boolean(row?.id);
}

function resolvedSelection(draft: ReservationWorkflowV2Draft, requestId: string, hint: CancelHint, hintIndex: number):
  { path: string; ref: string; observation: ReservationWorkflowV2Observation; preimage: CancelPreimage;
    sourceHintMismatchFields: string[];
    preflight: Record<string, unknown> } | { issue: string } {
  const path = ptr('proposal', 'content', 'requests', requestId, 'body', 'targets', 'include', hintIndex, 'suggestedRef');
  const override = draft.fieldOverrides[path];
  if (!override || override.state !== 'set' || typeof override.value !== 'string') return { issue: 'cancel_native_target_selection_required' };
  const ref = override.value;
  const selected = draft.observations.find((item) => item.ref === ref && item.kind === 'stay_candidate' && item.status === 'complete');
  const criteria = record(selected?.criteria), result = record(selected?.result), preimage = cancelPreimageSchema.safeParse(result?.preimage);
  const mismatches = preimage.success ? sourceHintMismatchFields(preimage.data, hint) : [];
  const recordedMismatches = Array.isArray(result?.sourceHintMismatchFields)
    ? result.sourceHintMismatchFields.filter((field): field is string => typeof field === 'string') : [];
  const reviewedMismatch = preimage.success && preimage.data.confirmation === hint.confirmation &&
    result?.sourceHintMismatchReviewRequired === true && canonicalJson(recordedMismatches) === canonicalJson(mismatches);
  if (!selected || !criteria || criteria.workflow !== 'cancel' || criteria.stage !== 'lookup' ||
      criteria.requestId !== requestId || criteria.hintId !== hint.id || criteria.fieldPath !== path ||
      criteria.propertyCode !== draft.propertyCode || !preimage.success ||
      (preimage.data.propertyCode ?? 'HRCEN') !== draft.propertyCode ||
      (!matchesHint(preimage.data, hint) && !reviewedMismatch)) {
    return { issue: 'cancel_native_target_selection_stale' };
  }
  const preflight = record(result?.preflight);
  if (!preflight || preflight.outcome !== 'prepared_for_human_review') return { issue: 'cancel_target_preflight_missing' };
  return { path, ref, observation: selected, preimage: preimage.data,
    sourceHintMismatchFields: mismatches, preflight };
}

function compileCancel(draft: ReservationWorkflowV2Draft, requestId: string, hintId: string | undefined,
  propertyCode: string): CancelCompile {
  if (!getPropertyRegistration(propertyCode)?.active || draft.propertyCode !== propertyCode) {
    return { outcome: 'unsupported', issue: 'cancel_property_not_supported' };
  }
  const loaded = effectiveBody(draft, requestId);
  if (!loaded || !loaded.body) return { outcome: 'needs_input', issue: 'cancel_request_not_found' };
  if (Object.keys(loaded.body).some((key) => !['targets', 'reason', 'cancellationNote', 'previewObservationRefs'].includes(key))) {
    return { outcome: 'unsupported', issue: 'cancel_body_contains_unsupported_fields', fields: Object.keys(loaded.body) };
  }
  const bodyOverridePrefix = `${loaded.bodyPath}/`;
  const unsupportedOverrides = Object.keys(draft.fieldOverrides).filter((path) =>
    path === loaded.bodyPath || (path.startsWith(bodyOverridePrefix) && !supportedCancelOverride(path, loaded.bodyPath, loaded.body!)));
  if (unsupportedOverrides.length) return { outcome: 'unsupported', issue: 'cancel_contains_unsupported_staff_overrides',
    fields: unsupportedOverrides };
  const targets = record(loaded.body.targets), rows = targetHintRows(loaded.body);
  if (!targets || Object.keys(targets).some((key) => !['mode', 'include', 'exclude', 'sourceRefs'].includes(key))) {
    return { outcome: 'unsupported', issue: 'cancel_scope_contains_unsupported_fields', fields: Object.keys(targets ?? {}) };
  }
  const reasonBody = record(loaded.body.reason);
  if (!reasonBody || Object.keys(reasonBody).some((key) => !['text', 'candidateRefs', 'suggestedRef'].includes(key))) {
    return { outcome: 'unsupported', issue: 'cancel_reason_contains_unsupported_fields', fields: Object.keys(reasonBody ?? {}) };
  }
  if (rows?.some((hint) => Object.keys(hint).some((key) => !['id', 'confirmation', 'guestName', 'bookedArrival',
    'bookedDeparture', 'candidateRefs', 'suggestedRef', 'sourceRefs'].includes(key)))) {
    return { outcome: 'unsupported', issue: 'cancel_target_hint_contains_unsupported_fields' };
  }
  if (!targets || targets.mode !== 'explicit' || !rows) {
    return { outcome: 'needs_input', issue: 'cancel_scope_must_be_explicit' };
  }
  const exclusionPath = ptr('proposal', 'content', 'requests', requestId, 'body', 'targets', 'exclude');
  if (!Array.isArray(targets.exclude)) return { outcome: 'needs_input', issue: 'cancel_target_exclusion_identity_unresolved',
    fields: [exclusionPath] };
  const chosen = requestedHint(loaded.body, hintId);
  if (!chosen) return { outcome: 'needs_input', issue: rows.length > 1 ? 'cancel_target_hint_required' : 'cancel_target_hint_missing' };
  const { hint, index } = chosen;
  const targetExclusions = resolveTargetExclusions(draft, exclusionPath, targets.exclude, loaded.unknownPaths);
  if (targetExclusions.issue) return { outcome: 'needs_input', issue: 'cancel_target_exclusion_identity_unresolved',
    fields: [exclusionPath, ...targetExclusions.fields], hintId: hint.id };
  const sameHintExclusion = targetExclusions.rows.find((row) => text(row.hint.id) === hint.id);
  if (sameHintExclusion) {
    return { outcome: 'needs_input', issue: 'cancel_target_excluded_by_scope',
      fields: [exclusionPath, `${exclusionPath}/${sameHintExclusion.index}`], hintId: hint.id };
  }
  const unknownHints = unknownHintPaths(loaded.unknownPaths, loaded.bodyPath, index);
  if (unknownHints.length) return { outcome: 'needs_input', issue: 'cancel_target_hints_unknown', fields: unknownHints, hintId: hint.id };
  if (!/^\d+-\d+$/.test(hint.confirmation ?? '')) {
    return { outcome: 'needs_input', issue: 'exact_confirmation_and_valid_dates_required', hintId: hint.id };
  }
  // Linked documents/Add-Ons are separate context/actions in this case. This write is bound only
  // to the selected stay; preserve those refs instead of turning context into a blocker or deleting work.
  const selection = resolvedSelection(draft, requestId, hint, index);
  if ('issue' in selection) return { outcome: 'needs_input', issue: selection.issue, hintId: hint.id };
  const exclusionIssue = auditTargetExclusions(selection.preimage as unknown as Record<string, unknown>, targetExclusions, exclusionPath);
  if (exclusionIssue) return { outcome: 'needs_input', issue: exclusionIssue.issue, fields: exclusionIssue.fields, hintId: hint.id };
  const basePath = ptr('proposal', 'content', 'requests', requestId, 'body');
  const reasonPath = ptr('proposal', 'content', 'requests', requestId, 'body', 'reason', 'text');
  const reason = leaf(draft, reasonPath, record(loaded.body.reason)?.text);
  const notePath = ptr('proposal', 'content', 'requests', requestId, 'body', 'cancellationNote');
  const note = leaf(draft, notePath, loaded.body.cancellationNote);
  if ('issue' in reason || 'issue' in note) return { outcome: 'needs_input', issue: 'cancel_staff_value_unknown' };
  const reasonText = reason.unset || reason.value == null ? null : typeof reason.value === 'string' ? reason.value : null;
  const noteText = note.unset || note.value == null ? '' : typeof note.value === 'string' ? note.value : null;
  if (noteText === null || noteText.length > 200 || /[\p{Cc}]/u.test(noteText)) {
    return { outcome: 'unsupported', issue: 'cancel_note_not_supported_by_native_tool', fields: [notePath], hintId: hint.id };
  }
  if (reasonText !== null && (reasonText.length > 120 || /[\p{Cc}]/u.test(reasonText))) {
    return { outcome: 'unsupported', issue: 'cancel_reason_not_supported_by_native_tool', fields: [reasonPath], hintId: hint.id };
  }
  const reasonSourceRefs = uniqueRefs([record(loaded.body.reason)?.candidateRefs, record(loaded.body.reason)?.suggestedRef]);
  const sourceRefs = uniqueRefs([loaded.request.sourceRefs, targets.sourceRefs, hint.sourceRefs,
    hint.candidateRefs, hint.suggestedRef, reasonSourceRefs]);
  const previewObservationRefsPath = `${basePath}/previewObservationRefs`;
  const previewLeaf = leaf(draft, previewObservationRefsPath, loaded.body.previewObservationRefs);
  if ('issue' in previewLeaf || (!previewLeaf.unset && !Array.isArray(previewLeaf.value)) ||
      (Array.isArray(previewLeaf.value) && !previewLeaf.value.every((ref) => typeof ref === 'string'))) {
    return { outcome: 'needs_input', issue: 'cancel_preview_reference_state_invalid', hintId: hint.id };
  }
  const previewObservationRefs = previewLeaf.unset ? [] : previewLeaf.value as string[];
  const semanticInput = { requestId, hintId: hint.id, targetSelectionRef: selection.ref,
    sourceHintMismatchFields: selection.sourceHintMismatchFields,
    targetHint: { confirmation: hint.confirmation ?? null, guestName: hint.guestName ?? null,
      bookedArrival: hint.bookedArrival ?? null, bookedDeparture: hint.bookedDeparture ?? null },
    scope: { mode: targets.mode, include: rows.map((row) => row.id), exclude: targetExclusions.rows.map(({ hint: excluded }) => ({
      id: excluded.id ?? null, confirmation: excluded.confirmation ?? null, guestName: excluded.guestName ?? null,
      bookedArrival: excluded.bookedArrival ?? null, bookedDeparture: excluded.bookedDeparture ?? null,
    })) },
    reason: { text: reasonText, candidateRefs: reasonSourceRefs }, cancellationNote: noteText, sourceRefs,
    selectedPreflightDigest: sha256(selection.preflight) };
  return { outcome: 'ok', requestId, hintId: hint.id, hintIndex: index, hint, selectionPath: selection.path,
    selectionRef: selection.ref, selectedObservation: selection.observation, preimage: selection.preimage,
    sourceHintMismatchFields: selection.sourceHintMismatchFields,
    selectedPreflight: selection.preflight, reasonText, cancellationNote: noteText, reasonSourceRefs, sourceRefs,
    previewObservationRefs, semanticInput, semanticDigest: sha256(semanticInput), bodyPath: loaded.bodyPath,
    reviewPath: previewObservationRefsPath };
}

async function recordOperation(ctx: ReservationWorkflowV2CancelContext,
  input: ReservationWorkflowV2PrepareInput | ReservationWorkflowV2ExecuteInput | ReservationWorkflowV2ReconcileInput,
  requestId: string, hintId: string,
  item: ReservationWorkflowV2Observation, status: 'prepared' | 'succeeded' | 'failed' | 'unknown', summary: string,
  operationId = item.ref) {
  const base = { workItemId: input.workItemId, source: input.source, expectedRevision: input.expectedRevision,
    expectedSeq: input.expectedSeq };
  const appended = await appendReservationWorkflowV2Observation(stateContext(ctx), { ...base, observation: item });
  if (appended.status !== 'ok') return appended;
  return recordReservationWorkflowV2Result(stateContext(ctx), { workItemId: input.workItemId, source: input.source,
    result: { id: operationId, generationId: item.generationId, requestId, allocationId: hintId, workflow: 'cancel',
      status, draftRevision: input.expectedRevision, observationRefs: [item.ref], updatedAt: new Date().toISOString(),
      summary: summary.slice(0, 2000) } });
}

function lookupHintPath(requestId: string, index: number): string {
  return ptr('proposal', 'content', 'requests', requestId, 'body', 'targets', 'include', index, 'suggestedRef');
}

/** Resolve target hints to fresh native identities; only a staff-set suggestedRef becomes an action binding. */
export async function reservationWorkflowV2CancelLookup(ctx: ReadContext,
  input: ReservationWorkflowV2LookupInput): Promise<CancelOutcome> {
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return loaded.result;
  const target = currentTarget(ctx);
  if (!target) return { status: 'unsupported', issue: 'cancel_property_session_unavailable' };
  const requests = loaded.draft.proposal.content.requests.filter((request) =>
    request.kind === 'cancel' && (!input.requestId || request.id === input.requestId));
  if (input.requestId && !requests.length) return { status: 'not_found' };
  if (!requests.length) return { status: 'unsupported', issue: 'cancel_lookup_not_applicable' };
  const lookups: Record<string, unknown>[] = [], observations: ReservationWorkflowV2Observation[] = [];
  for (const request of requests) {
    if (request.kind !== 'cancel') continue;
    const effective = effectiveBody(loaded.draft, request.id), rows = targetHintRows(effective?.body ?? null);
    const targets = record(effective?.body?.targets);
    if (!effective?.body || !targets || targets.mode !== 'explicit' || !rows?.length) {
      lookups.push({ status: 'needs_input', requestId: request.id, issue: 'cancel_confirmation_target_required' });
      continue;
    }
    if (rows.length > 100) {
      lookups.push({ status: 'unsupported', requestId: request.id, issue: 'cancel_target_limit' });
      continue;
    }
    const exclusionPath = ptr('proposal', 'content', 'requests', request.id, 'body', 'targets', 'exclude');
    if (!Array.isArray(targets.exclude)) {
      lookups.push({ status: 'needs_input', requestId: request.id, issue: 'cancel_target_exclusion_identity_unresolved',
        fields: [exclusionPath] });
      continue;
    }
    const targetExclusions = resolveTargetExclusions(loaded.draft, exclusionPath, targets.exclude, effective.unknownPaths);
    if (targetExclusions.issue) {
      lookups.push({ status: 'needs_input', requestId: request.id, issue: 'cancel_target_exclusion_identity_unresolved',
        fields: [exclusionPath, ...targetExclusions.fields] });
      continue;
    }
    for (const [index, hint] of rows.entries()) {
      const fieldPath = lookupHintPath(request.id, index);
      const sameHintExclusion = targetExclusions.rows.find((row) => text(row.hint.id) === hint.id);
      if (sameHintExclusion) {
        lookups.push({ status: 'needs_input', requestId: request.id, hintId: hint.id,
          issue: 'cancel_target_excluded_by_scope', fields: [exclusionPath, `${exclusionPath}/${sameHintExclusion.index}`],
          selectionPath: fieldPath });
        continue;
      }
      const unknownHints = unknownHintPaths(effective.unknownPaths, effective.bodyPath, index);
      if (unknownHints.length) {
        lookups.push({ status: 'needs_input', requestId: request.id, hintId: hint.id, selectionPath: fieldPath,
          issue: 'cancel_target_hints_unknown', fields: unknownHints });
        continue;
      }
      const confirmation = typeof hint.confirmation === 'string' ? hint.confirmation : '';
      const arrival = typeof hint.bookedArrival === 'string' ? hint.bookedArrival : undefined;
      const valid = /^\d+-\d+$/.test(confirmation) && (!arrival || day.safeParse(arrival).success) &&
        (!hint.bookedDeparture || day.safeParse(hint.bookedDeparture).success);
      if (!valid) {
        lookups.push({ status: 'needs_input', requestId: request.id, hintId: hint.id, selectionPath: fieldPath,
          issue: 'exact_confirmation_and_valid_dates_required' });
        continue;
      }
      let preimage: CancelPreimage | null = null, reason: string | null = null;
      let preflightFacts: Record<string, unknown> | null = null, preflightObservedAt: string | null = null;
      let warmCancellationCheck: Record<string, unknown> | null = null;
      const currentRead = await safeCancelTargetRead(target, confirmation, arrival, ctx.nativeBatch?.signal, ctx.transport.id);
      const current = currentRead?.outcome === 'found' ? record(currentRead.stay) : null;
      const currentStay = current ? { confirmation: current.confirmation, status: current.status,
        firstName: current.firstName, lastName: current.lastName, guestName: currentRead?.guestName ?? null,
        arrival: current.arrival, departure: current.departure, roomType: current.roomType, ratePlan: current.ratePlan } : null;
      const currentMismatchFields = current ? sourceHintMismatchFields(current, hint) : [];
      const exactCurrent = currentRead?.outcome === 'found' && current?.confirmation === confirmation;
      const exclusionIssue = exactCurrent && current
        ? auditTargetExclusions(current, targetExclusions, exclusionPath) : null;
      if (exclusionIssue) {
        const item = observation(loaded.draft, input, request.id, hint.id, 'lookup', 'partial',
          { fieldPath, propertyCode: ctx.property.propertyCode, query: { confirmation, guestName: hint.guestName ?? null,
            arrival: arrival ?? null, departure: hint.bookedDeparture ?? null } },
          { outcome: 'needs_input', issue: exclusionIssue.issue, fields: exclusionIssue.fields,
            ...(exclusionIssue.hintId ? { excludedHintId: exclusionIssue.hintId } : {}),
            ...(currentStay ? { currentStay } : {}), ...(currentMismatchFields.length ? { sourceHintMismatchFields: currentMismatchFields } : {}),
            sourceRefs: uniqueRefs([request.sourceRefs, targets.sourceRefs, hint.sourceRefs, hint.candidateRefs, hint.suggestedRef]) },
          [exclusionIssue.issue]);
        observations.push(item);
        lookups.push({ status: 'needs_input', requestId: request.id, hintId: hint.id, selectionPath: fieldPath,
          issue: exclusionIssue.issue, fields: exclusionIssue.fields,
          ...(exclusionIssue.hintId ? { excludedHintId: exclusionIssue.hintId } : {}), ...(currentStay ? { currentStay } : {}) });
        continue;
      }
      if (!exactCurrent) reason = currentRead?.reason ?? 'cancel_target_current_record_unverified';
      else if (current?.status !== 'Reserved') reason = 'cancel_target_status_not_reserved';
      else if (currentMismatchFields.length) reason = 'cancel_source_hints_mismatch';

      if (exactCurrent && current?.status === 'Reserved') {
        const nativeArrival = text(current.arrival);
        const preflight = nativeArrival
          ? await cancellationPreflight(target, ctx.transport.id, confirmation, nativeArrival, ctx.nativeBatch?.signal)
          : { outcome: 'failed' as const, issue: 'cancel_current_arrival_unavailable' };
        if (preflight.outcome === 'ok') {
          preflightFacts = preflight.facts;
          preflightObservedAt = preflight.observedAt;
          const preflightStay = record(preflight.facts.stay);
          const observedArrival = text(record(preflightStay?.arrivalDate)?.value);
          preimage = observedArrival ? await nativeCancelRead(target, confirmation, observedArrival, ctx.transport.id, ctx.nativeBatch?.signal) : null;
          if (!preimage) reason ??= 'native_cancel_target_unavailable';
          else if (preimage.confirmation !== confirmation || preimage.arrival !== observedArrival ||
              preimage.departure !== text(record(preflightStay?.departureDate)?.value)) reason = 'cancel_preflight_identity_mismatch';
          else if (canonicalJson(sourceHintMismatchFields(preimage, hint)) !== canonicalJson(currentMismatchFields)) {
            reason = 'cancel_source_hints_changed_during_lookup';
          }
        } else reason ??= preflight.issue;
      }

      if (ctx.nativeBatch && exactCurrent && current?.status === 'Reserved' && !currentMismatchFields.length && preimage && preflightFacts) {
        // Warm options with the same no-Save preview used by staff Prepare. This lookup evidence
        // grants no review, preview admission, write claim or Go; a failed preview leaves the
        // independently verified Reserved target available for staff to Prepare again.
        const warm = await freshPreview(target, confirmation, hint, true, undefined, ctx.nativeBatch.signal, false, ctx.transport.id);
        if (warm.outcome === 'ok') {
          preimage = warm.preimage; preflightFacts = warm.preflight; preflightObservedAt = warm.observedAt;
          warmCancellationCheck = { status: 'ready', observedAt: warm.observedAt, reasons: warm.reasons,
            policyFacts: warm.policyFacts, penaltyText: warm.penaltyText,
            feeState: text(record(warm.preflight.fee)?.state) ?? 'unknown_precommit', readOnly: true };
        } else {
          reason ??= warm.issue;
          warmCancellationCheck = { status: 'unavailable', issue: warm.issue, readOnly: true };
        }
        await removeNativeRunDir(warm.runDir);
      }
      const complete = Boolean(preimage && preflightFacts && exactCurrent && current?.status === 'Reserved');
      const item = observation(loaded.draft, input, request.id, hint.id, 'lookup', complete ? 'complete' : 'partial',
        { fieldPath, propertyCode: ctx.property.propertyCode, query: { confirmation, guestName: hint.guestName ?? null,
          arrival: arrival ?? null, departure: hint.bookedDeparture ?? null } },
        { outcome: complete ? (currentMismatchFields.length || reason ? 'needs_review' : 'found') : 'needs_review',
          ...(reason ? { issue: reason } : {}), ...(currentStay ? { currentStay } : {}),
          ...(currentMismatchFields.length ? { sourceHintMismatchFields: currentMismatchFields,
            sourceHintMismatchReviewRequired: true } : {}),
          ...(preimage ? { preimage, target: expectedTargetIdentity(preimage) } : {}),
          ...(preflightFacts ? { preflight: { outcome: 'prepared_for_human_review', ...preflightFacts },
            preflightObservedAt } : {}),
          ...(warmCancellationCheck ? { warmCancellationCheck } : {}),
          sourceRefs: uniqueRefs([request.sourceRefs, targets.sourceRefs, hint.sourceRefs, hint.candidateRefs, hint.suggestedRef]) },
        complete && !currentMismatchFields.length && !reason ? [] : [reason ?? 'cancel_lookup_incomplete']);
      observations.push(item);
      lookups.push({ status: complete ? (currentMismatchFields.length ? 'needs_review' : reason ? 'needs_review' : 'found') : 'partial',
        requestId: request.id, hintId: hint.id,
        selectionPath: fieldPath,
        ...(preimage ? { candidate: { observationRef: item.ref, confirmation: preimage.confirmation,
          guestName: `${preimage.firstName} ${preimage.lastName}`, arrival: preimage.arrival,
          departure: preimage.departure, nativeStayId: preimage.nativeStayId } } : {}),
        ...(currentStay ? { currentStay } : {}),
        ...(currentMismatchFields.length ? { sourceHintMismatchFields: currentMismatchFields } : {}),
        ...(reason ? { issue: reason } : {}) });
    }
  }
  for (const item of observations) {
    const saved = await appendReservationWorkflowV2Observation(stateContext(ctx), { workItemId: input.workItemId,
      source: input.source, observation: item });
    if (saved.status !== 'ok') return saved;
  }
  return { status: 'ok', revision: input.expectedRevision, seq: input.expectedSeq, requests,
    lookups, observations: [...loaded.draft.observations, ...observations], operationResults: loaded.draft.operationResults };
}

function preparedPreview(draft: ReservationWorkflowV2Draft, compiled: Extract<CancelCompile, { outcome: 'ok' }>) {
  const candidates = draft.operationResults.toReversed().flatMap((entry) => {
    if (entry.requestId !== compiled.requestId || entry.allocationId !== compiled.hintId || entry.workflow !== 'cancel' ||
        entry.status !== 'prepared' || entry.generationId !== draft.generationId || entry.draftRevision > draft.revision) return [];
    return entry.observationRefs.flatMap((ref) => {
      const item = draft.observations.find((candidate) => candidate.ref === ref && candidate.kind === 'stay_candidate' &&
        candidate.status === 'complete' && candidate.generationId === draft.generationId);
      const criteria = record(item?.criteria), result = record(item?.result);
      // A ready preview must carry the exact reason and note HMS staged unsaved. A historically
      // recorded preview without staged data can never qualify for Go, and neither can one that
      // observed a cancellation charge: any fee is finished in HMS, never accepted under one Go.
      const staged = stagedCancelSchema.safeParse(result?.staged);
      return item && criteria?.stage === 'prepare' && criteria.semanticDigest === compiled.semanticDigest &&
        result?.ready === true && typeof result.approvalDigest === 'string' && staged.success &&
        result?.penaltyText === null && staged.data.penaltyText === null &&
        staged.data.reasonLabel === compiled.reasonText && staged.data.cancellationNote === compiled.cancellationNote
        ? [{ item, result, criteria }] : [];
    });
  });
  return candidates[0] ?? null;
}

function reviewBinding(draft: ReservationWorkflowV2Draft, compiled: Extract<CancelCompile, { outcome: 'ok' }>,
  item: ReservationWorkflowV2Observation, approval: string) {
  const indexes = compiled.previewObservationRefs.flatMap((ref, index) => ref === item.ref ? [index] : []);
  if (indexes.length !== 1) return { accepted: false, index: null, note: reviewNote(item.ref, approval) };
  const path = `${compiled.reviewPath}/${indexes[0]}`;
  const review = draft.staffReviews[path];
  return { accepted: review?.status === 'accepted' && review.note === reviewNote(item.ref, approval), index: indexes[0]!,
    path, note: reviewNote(item.ref, approval) };
}

/** Stage a fresh no-Save scoped native preview, including HMS financial facts and its current penalty dialog. */
export async function reservationWorkflowV2CancelPrepare(ctx: ReservationWorkflowV2CancelContext,
  input: ReservationWorkflowV2PrepareInput): Promise<CancelOutcome> {
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return loaded.result;
  const target = currentTarget(ctx);
  if (!target) return { status: 'unsupported', issue: 'cancel_property_session_unavailable' };
  const compiled = compileCancel(loaded.draft, input.requestId, input.allocationId, ctx.property.propertyCode);
  if (compiled.outcome !== 'ok') return { status: compiled.outcome, issue: compiled.issue, fields: compiled.fields ?? [] };
  const policyProperty = z.enum(['HRCEN', 'HRDAV', 'HRDAVS']).safeParse(ctx.property.propertyCode);
  if (!policyProperty.success || !effectiveWorkflowPolicy(process.env, policyProperty.data, 'cancel').readEnabled) {
    return { status: 'unsupported', issue: 'cancel_preview_flag_off' };
  }
  const fresh = await freshPreview(target, compiled.preimage.confirmation, compiled.hint, true,
    hmsDispatchTargetKey(dispatchTarget(compiled.preimage)), ctx.signal, compiled.sourceHintMismatchFields.length > 0, ctx.transport.id,
    compiled.reasonText === null ? undefined : { reasonLabel: compiled.reasonText, cancellationNote: compiled.cancellationNote });
  if (fresh.outcome !== 'ok') {
    await removeNativeRunDir(fresh.runDir);
    if (fresh.issue === 'CANCEL_REASON_MISMATCH') {
      // A manual lookup never warms native options, so the editor reads reasons only from a
      // saved prepare observation. Persist them bound to this exact selection and digest as a
      // non-ready observation: nothing was staged, and `ready: false` keeps it away from
      // review, Go authorization and `preparedPreview`.
      if (fresh.preimage && fresh.reasons) {
        const mismatch = observation(loaded.draft, input, compiled.requestId, compiled.hintId, 'prepare', 'complete',
          { semanticDigest: compiled.semanticDigest, selectionRef: compiled.selectionRef, sourceRefs: compiled.sourceRefs },
          { ready: false, staged: null, issue: 'cancel_reason_must_match_native_option',
            target: expectedTargetIdentity(fresh.preimage), preimage: fresh.preimage,
            semanticInput: compiled.semanticInput, requestedReason: compiled.reasonText,
            reasons: fresh.reasons, sourceRefs: compiled.sourceRefs,
            ...(fresh.preflight ? { preflight: fresh.preflight,
              feeState: record(fresh.preflight.fee)?.state ?? 'unknown_precommit',
              roomScope: fresh.preflight.roomScope } : {}),
            ...(fresh.observedAt ? { preflightObservedAt: fresh.observedAt } : {}),
            ...(fresh.policyFacts ? { policyFacts: fresh.policyFacts } : {}),
            penaltyText: fresh.penaltyText ?? null,
            baselineChangedSinceLookup: canonicalJson(compiled.preimage) !== canonicalJson(fresh.preimage) });
        const recorded = await recordOperation(ctx, input, compiled.requestId, compiled.hintId, mismatch, 'prepared',
          'HMS could not stage the requested reason; its current cancellation options were recorded for staff');
        if (recorded.status !== 'ok') return recorded;
        return { status: 'needs_input', issue: 'cancel_reason_must_match_native_option',
          observationRef: mismatch.ref, reasons: fresh.reasons };
      }
      return { status: 'needs_input', issue: 'cancel_reason_must_match_native_option',
        ...(fresh.reasons ? { reasons: fresh.reasons } : {}) };
    }
    return { status: 'needs_review', issue: fresh.issue };
  }
  const sameNativeIdentity = canonicalJson(expectedTargetIdentity(fresh.preimage)) ===
    canonicalJson(expectedTargetIdentity(compiled.preimage));
  if (!sameNativeIdentity) {
    await removeNativeRunDir(fresh.runDir);
    const stale = observation(loaded.draft, input, compiled.requestId, compiled.hintId, 'prepare', 'partial',
      { semanticDigest: compiled.semanticDigest, selectionRef: compiled.selectionRef },
      { ready: false, issue: 'cancel_selected_native_target_changed', previousTarget: expectedTargetIdentity(compiled.preimage),
        currentTarget: expectedTargetIdentity(fresh.preimage) }, ['native_target_identity_changed']);
    const recorded = await recordOperation(ctx, input, compiled.requestId, compiled.hintId, stale, 'failed',
      'Selected native target changed; lookup and staff selection are required');
    if (recorded.status !== 'ok') return recorded;
    return { status: 'needs_review', issue: 'cancel_selected_native_target_changed', observationRef: stale.ref };
  }
  const matchingReason = compiled.reasonText === null ? [] : fresh.reasons.filter((item) => item.display === compiled.reasonText);
  const reasonReady = matchingReason.length === 1;
  // Any HMS cancellation charge keeps the preview non-ready whether a pre-reason fee dialog
  // pre-empted staging or the staged dialog carries the charge: staff finish it in HMS.
  // Only an HMS-staged reason and note with no reported charge qualify for a reviewed Go.
  const charge = fresh.penaltyText !== null;
  const ready = !charge && reasonReady && compiled.reasonText !== null && fresh.staged !== null;
  const approval = approvalDigest(compiled, fresh);
  const item = preparedObservation(loaded.draft, input, compiled, fresh, approval, ready);
  const recorded = await recordOperation(ctx, input, compiled.requestId, compiled.hintId, item, 'prepared',
    ready ? 'HMS cancellation preview is fresh and unsaved' : charge
      ? 'HMS reported a cancellation charge; staff must finish this cancellation in HMS'
      : 'HMS preview is ready; staff must choose a listed cancellation reason');
  if (recorded.status !== 'ok') return recorded;
  const binding = reviewBinding(loaded.draft, compiled, item, approval);
  const index = compiled.previewObservationRefs.length;
  await removeNativeRunDir(fresh.runDir);
  return { status: ready ? 'prepared' : charge ? 'needs_review' : 'needs_input', requestId: compiled.requestId, hintId: compiled.hintId,
    observationRef: item.ref, target: expectedTargetIdentity(fresh.preimage), reasons: fresh.reasons,
    selectedReason: matchingReason[0] ?? null, cancellationNote: compiled.cancellationNote, staged: fresh.staged,
    preflight: fresh.preflight, policyFacts: fresh.policyFacts, penaltyText: fresh.penaltyText,
    financialHandling: fresh.preflight.financialHandling,
    feeState: record(fresh.preflight.fee)?.state ?? 'unknown_precommit', scope: fresh.preflight.roomScope,
    sourceRefs: compiled.sourceRefs, approvalDigest: approval,
    financialReview: { required: true, accepted: binding.accepted, observationRef: item.ref,
      approvalDigest: approval, reviewFieldPath: `${compiled.reviewPath}/${index}`, reviewNote: reviewNote(item.ref, approval) },
    ...(!ready ? { issue: charge ? 'cancel_charge_finish_in_hms' :
      compiled.reasonText === null ? 'cancel_reason_required' : 'cancel_reason_must_match_native_option' } : {}) };
}

const CANCEL_DISPATCH_FIELD = 'nava.hms.labtest.dispatch.v1';

function dispatchTarget(preimage: CancelPreimage): HmsDispatchTarget {
  return hmsDispatchTargetSchema.parse({ propertyCode: preimage.propertyCode ?? 'HRCEN', kind: 'saved',
    confirmation: preimage.confirmation, nativeStayId: preimage.nativeStayId });
}

function operationById(draft: ReservationWorkflowV2Draft, operationId: string) {
  return draft.operationResults.find((item) => item.id === operationId && item.workflow === 'cancel') ?? null;
}

async function assertCurrentCancel(tx: Tx, ctx: ReservationWorkflowV2CancelContext, input: ReservationWorkflowV2ExecuteInput,
  compiled: Extract<CancelCompile, { outcome: 'ok' }>, preparedRef: string, approval: string,
  actorSession: CancelActorSession, attempt?: ReservationWorkflowV2Observation): Promise<void> {
  const [item] = await tx.select({ state: workItem.state, revision: workItem.revision, revisionSeq: workItem.revisionSeq,
    sourceMessageId: workItem.sourceMessageId, threadId: workItem.threadId })
    .from(workItem).where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, ctx.transport.id)))
    .limit(1).for('update');
  const draft = item && reservationWorkflowV2DraftOf(item.state as Record<string, unknown>);
  if (!item || !draft || item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq ||
      item.sourceMessageId !== input.source.messageId || item.threadId !== input.source.threadId ||
      draft.revision !== input.expectedRevision || draft.propertyCode !== ctx.property.propertyCode || draft.transportId !== ctx.transport.id ||
      draft.source.sourceHash !== input.source.sourceHash || draft.source.arrivedAt !== input.source.arrivedAt ||
      draft.source.messageId !== input.source.messageId || draft.source.threadId !== input.source.threadId) {
    throw new Error('reservation_workflow_v2_cancel_stale');
  }
  const [source] = await tx.select({ id: message.id, threadId: message.threadId, direction: message.direction,
    historyOnly: message.historyOnly, sourceProvenance: message.sourceProvenance, subject: message.subject,
    textBody: message.textBody, htmlBody: message.htmlBody, arrivedAt: MESSAGE_ARRIVED_AT })
    .from(message).innerJoin(mailThread, and(eq(mailThread.id, message.threadId), eq(mailThread.transportId, message.transportId)))
    .where(and(eq(message.id, input.source.messageId), eq(message.threadId, input.source.threadId),
      eq(message.transportId, ctx.transport.id), eq(message.direction, 'inbound'), eq(message.historyOnly, false),
      eq(mailThread.historyOnly, false), isNull(mailThread.trashedAt), isNull(mailThread.spamAt))).limit(1).for('share');
  const [access] = await tx.select({ id: mailboxAccess.id }).from(mailboxAccess)
    .where(and(eq(mailboxAccess.userId, ctx.user.id), eq(mailboxAccess.transportId, ctx.transport.id))).limit(1).for('share');
  const op = draft.operationResults.find((entry) => entry.id === input.idempotencyKey);
  const competingOperation = draft.operationResults.some((entry) => entry.requestId === compiled.requestId &&
    entry.allocationId === compiled.hintId && entry.workflow === 'cancel' &&
    (entry.status === 'succeeded' || entry.status === 'unknown'));
  const live = compileCancel(draft, compiled.requestId, compiled.hintId, ctx.property.propertyCode);
  const livePrepared = live.outcome === 'ok' ? preparedPreview(draft, live) : null;
  const review = live.outcome === 'ok' && livePrepared ? reviewBinding(draft, live, livePrepared.item, approval) : null;
  if (!source || !access || source.sourceProvenance?.attention != null ||
      staffQuoteSourceHash(source) !== input.source.sourceHash || !(source.arrivedAt instanceof Date) ||
      source.arrivedAt.toISOString() !== input.source.arrivedAt || live.outcome !== 'ok' ||
      live.semanticDigest !== compiled.semanticDigest || livePrepared?.item.ref !== preparedRef ||
      record(livePrepared?.result)?.approvalDigest !== approval || !review?.accepted || op || competingOperation ||
      (attempt !== undefined && (attempt.generationId !== draft.generationId || attempt.sourceMessageId !== draft.source.messageId ||
        draft.observations.some((entry) => entry.ref === attempt.ref) ||
        attempt.sourceRefs.some((ref) => !draft.observations.some((entry) => entry.ref === ref))))) {
    throw new Error('reservation_workflow_v2_cancel_authorization_changed');
  }
  await lockCreateActorSession(tx, { actorUserId: ctx.user.id, ...actorSession });
  if (attempt) {
    const result = { id: input.idempotencyKey, generationId: draft.generationId, requestId: compiled.requestId,
      allocationId: compiled.hintId, workflow: 'cancel' as const, status: 'unknown' as const,
      draftRevision: draft.revision, observationRefs: [attempt.ref], updatedAt: new Date().toISOString(),
      summary: 'Native cancellation claimed; outcome pending reconciliation' };
    const nextDraft = reservationWorkflowV2DraftSchema.parse({ ...draft,
      observations: [...draft.observations, attempt], operationResults: [...draft.operationResults, result] });
    await tx.update(workItem).set({ state: { ...(item.state as Record<string, unknown>),
      [RESERVATION_WORKFLOW_V2_STATE_KEY]: nextDraft }, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
    await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
      fieldPath: `${RESERVATION_WORKFLOW_V2_STATE_KEY}:operationResults:${result.id}`,
      value: { id: result.id, requestId: result.requestId, allocationId: result.allocationId,
        workflow: 'cancel', status: result.status, observationRefs: result.observationRefs },
      evidence: { sourceHash: input.source.sourceHash, seq: input.expectedSeq, summary: result.summary } });
  }
}

async function persistCancelResolution(tx: Tx, ctx: ReservationWorkflowV2CancelContext,
  input: ReservationWorkflowV2ExecuteInput, compiled: Extract<CancelCompile, { outcome: 'ok' }>,
  result: ReservationWorkflowV2Observation, summary: string): Promise<void> {
  const [item] = await tx.select({ state: workItem.state, revision: workItem.revision, revisionSeq: workItem.revisionSeq,
    sourceMessageId: workItem.sourceMessageId, threadId: workItem.threadId })
    .from(workItem).where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, ctx.transport.id)))
    .limit(1).for('update');
  const draft = item && reservationWorkflowV2DraftOf(item.state as Record<string, unknown>);
  if (!item || !draft || item.revision !== input.expectedRevision || item.revisionSeq !== input.expectedSeq ||
      item.sourceMessageId !== input.source.messageId || item.threadId !== input.source.threadId ||
      draft.source.sourceHash !== input.source.sourceHash || draft.source.arrivedAt !== input.source.arrivedAt ||
      draft.transportId !== ctx.transport.id || draft.propertyCode !== ctx.property.propertyCode ||
      operationById(draft, input.idempotencyKey)?.status !== 'unknown' ||
      result.generationId !== draft.generationId || result.sourceMessageId !== draft.source.messageId ||
      result.sourceRefs.some((ref) => !draft.observations.some((entry) => entry.ref === ref))) {
    throw new Error('reservation_workflow_v2_cancel_resolution_changed');
  }
  const observations = draft.observations.some((entry) => entry.ref === result.ref)
    ? draft.observations : [...draft.observations, result];
  const operation = { id: input.idempotencyKey, generationId: draft.generationId,
    requestId: compiled.requestId, allocationId: compiled.hintId, workflow: 'cancel' as const,
    status: 'succeeded' as const, draftRevision: input.expectedRevision, observationRefs: [result.ref],
    updatedAt: new Date().toISOString(), summary: summary.slice(0, 2000) };
  const nextDraft = reservationWorkflowV2DraftSchema.parse({ ...draft, observations,
    operationResults: [...draft.operationResults.filter((entry) => entry.id !== operation.id), operation] });
  await tx.update(workItem).set({ state: { ...(item.state as Record<string, unknown>),
    [RESERVATION_WORKFLOW_V2_STATE_KEY]: nextDraft }, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
  await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
    fieldPath: `reservationWorkflowV2:operationResults:${operation.id}`,
    value: { id: operation.id, requestId: operation.requestId, allocationId: operation.allocationId,
      workflow: 'cancel', status: operation.status, observationRefs: operation.observationRefs },
    evidence: { sourceHash: input.source.sourceHash, seq: input.expectedSeq, summary } });
}

async function persistCancelNotDispatched(tx: Tx, ctx: ReservationWorkflowV2CancelContext,
  input: ReservationWorkflowV2ExecuteInput, compiled: Extract<CancelCompile, { outcome: 'ok' }>,
  result: ReservationWorkflowV2Observation, summary: string): Promise<void> {
  const [item] = await tx.select({ state: workItem.state })
    .from(workItem).where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, ctx.transport.id)))
    .limit(1).for('update');
  const draft = item && reservationWorkflowV2DraftOf(item.state as Record<string, unknown>);
  const operation = draft && operationById(draft, input.idempotencyKey);
  if (!item || !draft || !operation || draft.workItemId !== input.workItemId ||
      draft.source.messageId !== input.source.messageId || draft.source.threadId !== input.source.threadId ||
      draft.source.sourceHash !== input.source.sourceHash || draft.source.arrivedAt !== input.source.arrivedAt ||
      draft.transportId !== ctx.transport.id || draft.propertyCode !== ctx.property.propertyCode ||
      operation.status !== 'unknown' || operation.requestId !== compiled.requestId ||
      operation.allocationId !== compiled.hintId || operation.draftRevision !== input.expectedRevision ||
      operation.generationId !== draft.generationId || result.generationId !== draft.generationId ||
      result.sourceMessageId !== draft.source.messageId) {
    throw new Error('reservation_workflow_v2_cancel_no_dispatch_changed');
  }
  const failure = { ...result, sourceRefs: result.sourceRefs.filter((ref) => draft.observations.some((entry) => entry.ref === ref)) };
  const failed = { ...operation, status: 'failed' as const,
    observationRefs: [failure.ref], updatedAt: new Date().toISOString(),
    summary: summary.slice(0, 2000) };
  const nextDraft = reservationWorkflowV2DraftSchema.parse({ ...draft,
    observations: [...draft.observations, failure],
    operationResults: [...draft.operationResults.filter((entry) => entry.id !== failed.id), failed] });
  await tx.update(workItem).set({ state: { ...(item.state as Record<string, unknown>),
    [RESERVATION_WORKFLOW_V2_STATE_KEY]: nextDraft }, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
  await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'write.evidence',
    fieldPath: `${RESERVATION_WORKFLOW_V2_STATE_KEY}:operationResults:${failed.id}`,
    value: { id: failed.id, requestId: failed.requestId, allocationId: failed.allocationId,
      workflow: 'cancel', status: failed.status, observationRefs: failed.observationRefs },
    evidence: { sourceHash: input.source.sourceHash, seq: input.expectedSeq, summary } });
}

function screenshotPath(result: NativeCancelResult | null, name: 'before.png' | 'after.png'): string | null {
  if (!result || !safeRunDir(result.runDir)) return null;
  const screenshots = Array.isArray(result.screenshots) ? result.screenshots : [];
  return screenshots.find((path): path is string => typeof path === 'string' && path === join(result!.runDir as string, name)) ?? null;
}

async function storeCancelScreenshot(ctx: ReservationWorkflowV2CancelContext, workItemId: string, runId: string,
  name: 'before.png' | 'saved.png', source: { path: string; sourceDir: string } | { bytes: Buffer },
  owner = `${ctx.user.id}:${ctx.transport.id}`) {
  const stage = await mkdtemp(join(tmpdir(), 'reservation-v2-cancel-shots-'));
  try {
    const destination = join(stage, name);
    if ('path' in source) {
      const expectedNativeName = name === 'before.png' ? 'before.png' : 'after.png';
      if (!safeRunDir(source.sourceDir) || dirname(source.path) !== source.sourceDir ||
          source.path !== join(source.sourceDir, expectedNativeName)) return null;
      const [directory, file] = await Promise.all([lstat(source.sourceDir).catch(() => null),
        lstat(source.path).catch(() => null)]);
      if (!directory?.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0 ||
          !file?.isFile() || file.uid !== process.getuid?.()) return null;
      await copyFile(source.path, destination);
    } else {
      if (!Buffer.isBuffer(source.bytes) || !source.bytes.length) return null;
      await writeFile(destination, source.bytes, { mode: 0o600 });
    }
    const shots = await persistHmsShots({ propertyCode: ctx.property.propertyCode, workItemId, runId, sourceDir: stage, owner, now: Date.now() });
    const shot = shots?.find((item) => item.name === name);
    if (!shot || !await verifyStoredHmsShot({ runId, name, sha256: shot.sha256, owner, propertyCode: ctx.property.propertyCode, workItemId }, name)) {
      return null;
    }
    return { runId, sha256: shot.sha256 };
  } catch { return null; }
  finally { await rm(stage, { recursive: true, force: true }).catch(() => {}); }
}

function preparedObservation(draft: ReservationWorkflowV2Draft, input: ReservationWorkflowV2PrepareInput |
  ReservationWorkflowV2ExecuteInput, compiled: Extract<CancelCompile, { outcome: 'ok' }>, fresh: Extract<FreshPreview, { outcome: 'ok' }>,
  approval: string, ready: boolean): ReservationWorkflowV2Observation {
  return { ...observation(draft, input, compiled.requestId, compiled.hintId, 'prepare', 'complete',
    { semanticDigest: compiled.semanticDigest, selectionRef: compiled.selectionRef,
      sourceRefs: compiled.sourceRefs, approvalDigest: approval, baselineDigest: sha256(fresh.preimage),
      financialDigest: sha256({ preflight: stablePreflight(fresh.preflight), penaltyText: fresh.penaltyText,
        policyFacts: fresh.policyFacts }) },
    { ready, approvalDigest: approval, semanticInput: compiled.semanticInput, sourceRefs: compiled.sourceRefs,
      target: expectedTargetIdentity(fresh.preimage), preimage: fresh.preimage, preflight: fresh.preflight,
      preflightObservedAt: fresh.observedAt, reasons: fresh.reasons, policyFacts: fresh.policyFacts,
      penaltyText: fresh.penaltyText, staged: fresh.staged,
      feeState: record(fresh.preflight.fee)?.state ?? 'unknown_precommit',
      roomScope: fresh.preflight.roomScope, baselineChangedSinceLookup: canonicalJson(compiled.preimage) !== canonicalJson(fresh.preimage) }),
    sourceRefs: sourceObservationRefs(draft, [compiled.sourceRefs]) };
}

function reviewRequestFor(previewRefs: string[], reviewPath: string, item: ReservationWorkflowV2Observation,
  approval: string, note: string) {
  const index = previewRefs.length;
  return { required: true, accepted: false, observationRef: item.ref, approvalDigest: approval,
    reviewFieldPath: `${reviewPath}/${index}`, reviewNote: reviewNote(item.ref, approval), issue: note };
}

/** Recheck one reviewed cancellation; a native fee prompt is accepted only when it matches that reviewed preview. */
/** Only the cancellation preview accepted by staff can become a durable Go receipt. */
export async function reservationWorkflowV2CancelPreparation(ctx: ReservationWorkflowV2CancelContext,
  input: ReservationWorkflowV2PrepareInput) {
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return null;
  const compiled = compileCancel(loaded.draft, input.requestId, input.allocationId, ctx.property.propertyCode);
  if (compiled.outcome !== 'ok') return null;
  const prepared = preparedPreview(loaded.draft, compiled);
  if (!prepared || !prepared.item.coverage.complete || prepared.item.propertyCode !== ctx.property.propertyCode ||
      prepared.item.sourceMessageId !== input.source.messageId ||
      !reviewBinding(loaded.draft, compiled, prepared.item, String(prepared.result.approvalDigest)).accepted) return null;
  const preimage = record(prepared.result.preimage);
  if (!preimage || preimage.confirmation !== compiled.preimage.confirmation ||
      preimage.nativeStayId !== compiled.preimage.nativeStayId) return null;
  return { operation: 'cancel' as const, targetAliases: hmsDispatchTargetKeys(dispatchTarget(compiled.preimage)),
    nativeObservation: { beforeDigest: sha256(preimage), capturedAt: prepared.item.observedAt,
      price: prepared.result.preflight ?? null, warnings: prepared.item.coverage.notes },
    workflowContext: { endpoint: 'execute' as const, input } };
}

export async function reservationWorkflowV2CancelExecute(ctx: ReservationWorkflowV2CancelContext,
  input: ReservationWorkflowV2ExecuteInput): Promise<CancelOutcome> {
  if (!z.string().uuid().safeParse(input.idempotencyKey).success) return { status: 'invalid_input', issue: 'cancel_idempotency_key_invalid' };
  const actorSession = z.object({ sessionId: z.string().min(1).max(512).refine((value) => value === value.trim() &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)),
    sessionProfile: z.enum(['legacy', 'remote']) }).safeParse(ctx.user);
  if (!actorSession.success) return { status: 'unauthenticated', issue: 'cancel_authenticated_session_required' };
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return loaded.result;
  const prior = operationById(loaded.draft, input.idempotencyKey);
  if (prior) return { status: prior.status === 'succeeded' ? 'succeeded' : prior.status === 'unknown' ? 'needs_reconcile' : 'already_used',
    operationId: prior.id, issue: prior.status === 'unknown' ? 'cancel_go_already_consumed' : 'cancel_idempotency_key_already_used' };
  const target = currentTarget(ctx);
  if (!target) return { status: 'unsupported', issue: 'cancel_property_session_unavailable' };
  const compiled = compileCancel(loaded.draft, input.requestId, input.allocationId, ctx.property.propertyCode);
  if (compiled.outcome !== 'ok') return { status: compiled.outcome, issue: compiled.issue, fields: compiled.fields ?? [] };
  const consumed = loaded.draft.operationResults.find((entry) => entry.workflow === 'cancel' &&
    entry.requestId === compiled.requestId && entry.allocationId === compiled.hintId &&
    (entry.status === 'unknown' || entry.status === 'succeeded'));
  if (consumed) return { status: consumed.status === 'succeeded' ? 'succeeded' : 'needs_reconcile',
    operationId: consumed.id, ...(consumed.status === 'unknown' ? { issue: 'cancel_target_go_already_consumed' } : {}) };
  const prepared = preparedPreview(loaded.draft, compiled);
  if (!prepared) return { status: 'needs_review', issue: 'cancel_fresh_prepare_required' };
  const approval = String(prepared.result.approvalDigest);
  const reviewed = reviewBinding(loaded.draft, compiled, prepared.item, approval);
  if (!reviewed.accepted) return { status: 'needs_review', issue: 'cancel_preview_staff_acceptance_required',
    financialReview: { required: true, accepted: false, observationRef: prepared.item.ref, approvalDigest: approval,
      reviewFieldPath: reviewed.path ?? `${compiled.reviewPath}/${compiled.previewObservationRefs.length}`,
      reviewNote: reviewed.note } };
  const expectedTarget = dispatchTarget(compiled.preimage);
  const targetLock = paneStayCloudTargetLock(target, expectedTarget, { kind: 'independent_cloud' });
  if (!targetLock) return { status: 'unsupported', issue: 'cancel_target_lock_unavailable' };
  let lockResult: CancelOutcome;
  try {
    lockResult = await targetLock.withLock(async (targetSignal) => {
      const lockSignal = targetSignal && ctx.signal ? AbortSignal.any([targetSignal, ctx.signal]) : targetSignal ?? ctx.signal;
      const labtest = !compiled.preimage.allowRealGuest && compiled.preimage.firstName === 'Proof' &&
        compiled.preimage.lastName === 'Labtest' && compiled.preimage.arrival >= '2027-01-01' && !compiled.preimage.cmsSend;
      const epoch = await captureHmsLabtestDispatchEpoch(ctx.db, expectedTarget, input.workItemId)
        .catch(() => null);
      if (!epoch) return { status: 'needs_reconcile', issue: 'cancel_dispatch_history_unavailable' };
      let fresh: FreshPreview;
      try { fresh = await freshPreview(target, compiled.preimage.confirmation, compiled.hint, true,
        hmsDispatchTargetKey(expectedTarget), lockSignal, compiled.sourceHintMismatchFields.length > 0, ctx.transport.id,
        compiled.reasonText === null ? undefined : { reasonLabel: compiled.reasonText, cancellationNote: compiled.cancellationNote }); }
      catch { return { status: 'needs_review', issue: 'cancel_fresh_preview_unavailable' }; }
      if (fresh.outcome !== 'ok') {
        await removeNativeRunDir(fresh.runDir);
        return { status: 'needs_review', issue: fresh.issue };
      }
      const identityMatches = canonicalJson(expectedTargetIdentity(fresh.preimage)) ===
        canonicalJson(expectedTargetIdentity(compiled.preimage));
      if (!identityMatches) {
        const changed = observation(loaded.draft, input, compiled.requestId, compiled.hintId, 'execute', 'partial',
          { semanticDigest: compiled.semanticDigest, preparedObservationRef: prepared.item.ref },
          { ready: false, issue: 'cancel_selected_native_target_changed', previousTarget: expectedTargetIdentity(compiled.preimage),
            currentTarget: expectedTargetIdentity(fresh.preimage), preflight: fresh.preflight }, ['native_target_identity_changed']);
        await removeNativeRunDir(fresh.runDir);
        const recorded = await recordOperation(ctx, input, compiled.requestId, compiled.hintId, changed, 'failed',
          'Target identity changed; staff must perform a new lookup and select the current saved stay', changed.ref);
        return recorded.status === 'ok' ? { status: 'needs_review', issue: 'cancel_selected_native_target_changed',
          observationRef: changed.ref } : recorded;
      }
      // A charge reported at the Go recheck is never accepted under this Go: the booking
      // keeps a non-ready observation with the native text and staff finish it in HMS.
      if (fresh.penaltyText !== null) {
        const chargeApproval = approvalDigest(compiled, fresh);
        const changed = preparedObservation(loaded.draft, input, compiled, fresh, chargeApproval, false);
        await removeNativeRunDir(fresh.runDir);
        const recorded = await recordOperation(ctx, input, compiled.requestId, compiled.hintId, changed, 'prepared',
          'HMS reported a cancellation charge; staff must finish this cancellation in HMS', changed.ref);
        if (recorded.status !== 'ok') return recorded;
        return { status: 'needs_review', issue: 'cancel_charge_finish_in_hms', requestId: compiled.requestId,
          hintId: compiled.hintId, observationRef: changed.ref, target: expectedTargetIdentity(fresh.preimage),
          preflight: fresh.preflight, penaltyText: fresh.penaltyText,
          feeState: record(fresh.preflight.fee)?.state ?? 'unknown_precommit' };
      }
      const liveApproval = approvalDigest(compiled, fresh);
      if (liveApproval !== approval) {
        const changed = preparedObservation(loaded.draft, input, compiled, fresh, liveApproval,
          compiled.reasonText !== null && fresh.staged !== null &&
          fresh.reasons.some((reason) => reason.display === compiled.reasonText));
        await removeNativeRunDir(fresh.runDir);
        const recorded = await recordOperation(ctx, input, compiled.requestId, compiled.hintId, changed, 'prepared',
          'Fresh HMS baseline or cancellation financial facts differ; another staff review and Go are required', changed.ref);
        if (recorded.status !== 'ok') return recorded;
        const financialReview = reviewRequestFor(compiled.previewObservationRefs, compiled.reviewPath, changed,
          liveApproval, 'fresh_HMS_baseline_or_financial_facts_changed');
        return { status: 'needs_review', issue: 'cancel_preview_changed_requires_second_go', requestId: compiled.requestId,
          hintId: compiled.hintId, observationRef: changed.ref, target: expectedTargetIdentity(fresh.preimage),
          preflight: fresh.preflight, penaltyText: fresh.penaltyText,
          feeState: record(fresh.preflight.fee)?.state ?? 'unknown_precommit', financialReview };
      }
      const matchingReason = compiled.reasonText === null ? null : fresh.reasons.find((reason) => reason.display === compiled.reasonText);
      if (!matchingReason) {
        const changed = preparedObservation(loaded.draft, input, compiled, fresh, liveApproval, false);
        await removeNativeRunDir(fresh.runDir);
        const recorded = await recordOperation(ctx, input, compiled.requestId, compiled.hintId, changed, 'prepared',
          'Staff cancellation reason no longer matches a native HMS option', changed.ref);
        return recorded.status === 'ok' ? { status: 'needs_input', issue: 'cancel_reason_must_match_native_option',
          observationRef: changed.ref, reasons: fresh.reasons } : recorded;
      }
      // Both positively paid and unknown require the broader paid authority.
      // Reuse this same classification when the native request is dispatched.
      const moneyState = record(fresh.preflight.financialHandling)?.paymentStatus === 'paid' ? 'paid' : 'unknown';
      const cancelMode = () => expectedTarget.propertyCode === 'HRCEN' ? paneWriteMode('cancel', moneyState)
        : effectiveWorkflowPolicy(process.env, expectedTarget.propertyCode, 'cancel').mode;
      const mode = cancelMode();
      if (mode !== 'on' && !(mode === 'lab' && labtest)) {
        await removeNativeRunDir(fresh.runDir);
        return { status: 'unsupported', issue: 'cancel_financial_authority_flag_off',
          financialHandling: fresh.preflight.financialHandling };
      }
      await removeNativeRunDir(fresh.runDir);
      const runId = randomUUID();
      let handle: HmsLabtestWriteHandle | null = null, native: NativeCancelResult | null = null;
      let claimError: string | null = null;
      let beforeReceipt: { runId: string; name: 'before.png'; sha256: string } | null = null;
      let nativeRequestDigest: string | null = null, claimRequestDigest: string | null = null, claimDigest: string | null = null;
      let beforeScreenshotPath: string | null = null, acceptedPenaltyText: string | null = null;
      const continuationAllowed = () => {
        const currentMode = cancelMode();
        return !lockSignal?.aborted && (currentMode === 'on' || (currentMode === 'lab' && labtest));
      };
      const acquireClaim = async (requestDigest: string, beforePath: string) => {
        lockSignal?.throwIfAborted();
        if (handle || !z.string().regex(/^[a-f0-9]{64}$/).safeParse(requestDigest).success ||
            !safeRunDir(dirname(beforePath)) || beforePath !== join(dirname(beforePath), 'before.png')) {
          throw new Error('cancel_native_dispatch_binding_invalid');
        }
        const before = await storeCancelScreenshot(ctx, input.workItemId, runId, 'before.png',
          { path: beforePath, sourceDir: dirname(beforePath) });
        if (!before) throw new Error('cancel_before_evidence_unavailable');
        const beforeEvidenceReceipt = { runId, name: 'before.png' as const, sha256: before.sha256 };
        beforeReceipt = beforeEvidenceReceipt;
        beforeScreenshotPath = beforePath;
        const intentDigest = sha256({ semanticDigest: compiled.semanticDigest, approval, idempotencyKey: input.idempotencyKey,
          requestDigest });
        claimRequestDigest = requestDigest;
        claimDigest = intentDigest;
        const recovery = { confirmation: fresh.preimage.confirmation, nativeStayId: fresh.preimage.nativeStayId,
          preimage: fresh.preimage, reasonCode: matchingReason.value, reasonLabel: matchingReason.display,
          cancellationNote: compiled.cancellationNote, cloudTargetKey: hmsDispatchTargetKey(expectedTarget), runId,
          claimDigest: intentDigest, before: beforeEvidenceReceipt };
        const attempt = observation(loaded.draft, input, compiled.requestId, compiled.hintId, 'execute', 'partial',
          { semanticDigest: compiled.semanticDigest, approvedDigest: approval, prepareObservationRef: prepared.item.ref,
            claimRequestDigest: requestDigest, requestDigest, target: expectedTargetIdentity(fresh.preimage) },
          { outcome: 'dispatch_claimed', claimRequestDigest: requestDigest, requestDigest, runId,
            chargePreapproved: Boolean(acceptedPenaltyText), sourceRefs: compiled.sourceRefs,
            preflight: fresh.preflight, penaltyText: fresh.penaltyText,
            feeState: record(fresh.preflight.fee)?.state ?? 'unknown_precommit' }, ['native_cancel_outcome_pending']);
        try {
          handle = await claimHmsLabtestDispatch(ctx.db, { workItemId: input.workItemId, transportId: ctx.transport.id,
            actorUserId: ctx.user.id, grantId: input.idempotencyKey, propertyCode: expectedTarget.propertyCode,
            firstName: fresh.preimage.firstName, lastName: fresh.preimage.lastName,
            nativeGuestId: fresh.preimage.guestId, operation: 'cancel', target: expectedTarget,
            sourceDigest: input.source.sourceHash, approvedDigest: approval, requestDigest, recovery },
          async (tx) => {
            if (!ctx.writeRunFence) throw new Error('staff_go_required');
            await consumeStaffGoAtDispatch(tx, ctx.writeRunFence, lockSignal);
            await assertCurrentCancel(tx, ctx, input, compiled, prepared.item.ref, approval, actorSession.data, attempt);
          }, epoch);
        } catch (error) {
          claimError = error instanceof HmsLabtestDispatchError ? `cancel_dispatch_${error.reason}` : 'cancel_dispatch_claim_failed';
          throw error;
        }
      };
      try {
        native = await runCloudCancellation({ mode: 'commit', target, transportId: ctx.transport.id, signal: lockSignal, confirmation: compiled.preimage.confirmation,
          arrival: compiled.preimage.arrival, allowRealGuest: true, cloudTargetKey: hmsDispatchTargetKey(expectedTarget),
          expected: fresh.preimage, bindDepositReceived: true, runId, reasonCode: matchingReason.value, reasonLabel: matchingReason.display,
          cancellationNote: compiled.cancellationNote, continuationAllowed, commitBudgetMs: 15 * 60_000,
          beforeDispatch: async () => continuationAllowed(),
          awaitChargeApproval: async (dialog: { text: string; button: string }) => {
            const dialogText = typeof dialog?.text === 'string' ? penaltyLine(dialog.text) as string : '';
            const button = typeof dialog?.button === 'string' ? dialog.button.trim() : '';
            if (!fresh.penaltyText || dialogText !== fresh.penaltyText || !/^(?:OK|Yes|Accept)$/i.test(button) ||
                !continuationAllowed()) return false;
            try {
              await ctx.db.transaction((tx) => assertCurrentCancel(tx, ctx, input, compiled, prepared.item.ref,
                approval, actorSession.data));
              acceptedPenaltyText = dialogText;
              return true;
            } catch { return false; }
          },
          prepareChargeWithAuthority: async (beforePath: string) => {
            if (!acceptedPenaltyText || acceptedPenaltyText !== fresh.penaltyText) throw new Error('cancel_fee_review_binding_missing');
            const chargeApprovalDigest = sha256({ action: 'cancel_charge_dialog', approval, penaltyText: acceptedPenaltyText,
              idempotencyKey: input.idempotencyKey });
            await acquireClaim(chargeApprovalDigest, beforePath);
          },
          dispatchWithAuthority: async (send: () => Promise<unknown>, requestDigest: string, _request: unknown,
            beforePath: string) => {
            if (!z.string().regex(/^[a-f0-9]{64}$/).safeParse(requestDigest).success ||
                !safeRunDir(dirname(beforePath)) || beforePath !== join(dirname(beforePath), 'before.png')) {
              throw new Error('cancel_native_dispatch_binding_invalid');
            }
            if (!handle) await acquireClaim(requestDigest, beforePath);
            else if (beforeScreenshotPath !== beforePath) throw new Error('cancel_fee_evidence_scope_changed');
            nativeRequestDigest = requestDigest;
            if (handle && claimRequestDigest !== requestDigest) {
              const boundRequest = observation(loaded.draft, input, compiled.requestId, compiled.hintId, 'execute', 'partial',
                { semanticDigest: compiled.semanticDigest, approvedDigest: approval, dispatchHoldId: handle.holdId,
                  claimRequestDigest, requestDigest, prepareObservationRef: prepared.item.ref },
                { outcome: 'cancel_request_bound', dispatchHoldId: handle.holdId, requestDigest,
                  claimRequestDigest, penaltyText: acceptedPenaltyText }, ['native_cancel_request_bound']);
              const recorded = await recordOperation(ctx, input, compiled.requestId, compiled.hintId, boundRequest, 'unknown',
                'Exact native cancellation request bound to the reviewed target claim', input.idempotencyKey);
              if (recorded.status !== 'ok') throw new Error('reservation_workflow_v2_cancel_request_receipt_unavailable');
            }
            lockSignal?.throwIfAborted();
            return send();
          } });
      } catch {
        native = native ?? { outcome: 'execution_failure', issue: claimError ?? 'cancel_native_runner_failed', requestDispatched: false };
      }
      const activeHandle = handle as HmsLabtestWriteHandle | null;
      try {
      const readback = z.object({ confirmation: z.string(), nativeStayId: z.string().regex(/^\d{1,100}$/),
        nativeGuestId: z.string().regex(/^\d{1,30}$/), status: z.string().regex(/^cancel(?:l)?ed$/i),
        reasonCode: z.string(), cancellationNote: z.string() }).passthrough().safeParse(native.nativeReadback);
      const exactReadback = readback.success && readback.data.confirmation === fresh.preimage.confirmation &&
        readback.data.nativeStayId === fresh.preimage.nativeStayId && readback.data.nativeGuestId === fresh.preimage.guestId &&
        readback.data.reasonCode === matchingReason.value && readback.data.cancellationNote === compiled.cancellationNote;
      const financialStateMatches = fresh.penaltyText === null ?
        native.chargeApproved === false && native.chargeDispatched === false :
        acceptedPenaltyText === fresh.penaltyText && native.chargeApproved === true && native.chargeDispatched === false;
      const nativePenaltyText = penaltyLine(native.penaltyText);
      const zeroNotice = native.zeroPenaltyNotice === 'Cancellation Penalty of 0.00 may be added to account.' &&
        cancellationPenaltyNotice(native.penaltyText)?.amount === '0.00' && fresh.penaltyText === null &&
        native.chargeApproved === false && native.chargeDispatched === false;
      const noNewFinancialState = (zeroNotice || nativePenaltyText === fresh.penaltyText && native.zeroPenaltyNotice == null) &&
        financialStateMatches && native.outcome !== 'cancel_penalty_pending';
      const completed = Boolean(activeHandle && native.outcome === 'cancelled' && native.requestDispatched === true &&
        native.writerSessionClosed === true && native.dispatchCallbacksDrained === true && exactReadback && noNewFinancialState);
      if (!completed || !activeHandle) {
        const nativePenaltyObserved = Object.prototype.hasOwnProperty.call(native, 'penaltyText') &&
          (nativePenaltyText === null || (typeof nativePenaltyText === 'string' && nativePenaltyText.length <= 2000 &&
            !/[\p{Cc}]/u.test(nativePenaltyText)));
        if (!activeHandle && !claimError && native.requestDispatched === false && native.writerSessionClosed === true &&
            native.dispatchCallbacksDrained === true && nativePenaltyObserved && nativePenaltyText !== fresh.penaltyText) {
          // A charge dialog appeared between the recheck and Save; the refused session closed
          // without a dispatch. Staff finish this cancellation in HMS, never by another Go.
          const changedFresh = { ...fresh, penaltyText: nativePenaltyText as string | null };
          const changedApproval = approvalDigest(compiled, changedFresh);
          const changed = preparedObservation(loaded.draft, input, compiled, changedFresh, changedApproval, false);
          const recorded = await recordOperation(ctx, input, compiled.requestId, compiled.hintId, changed, 'prepared',
            'Native reported a cancellation charge before Save; staff must finish this cancellation in HMS', changed.ref);
          if (recorded.status !== 'ok') return recorded;
          return { status: 'needs_review', issue: 'cancel_charge_finish_in_hms', requestId: compiled.requestId,
            hintId: compiled.hintId, observationRef: changed.ref, target: expectedTargetIdentity(fresh.preimage),
            preflight: fresh.preflight, penaltyText: changedFresh.penaltyText,
            feeState: record(fresh.preflight.fee)?.state ?? 'unknown_precommit' };
        }
        if (activeHandle && native.neverDispatchedProof && native.requestDispatched === false &&
            native.writerSessionClosed === true && native.dispatchCallbacksDrained === true &&
            native.chargeApproved !== true && native.zeroPenaltyNotice == null && acceptedPenaltyText === null) {
          const notDispatched = observation(loaded.draft, input, compiled.requestId, compiled.hintId, 'execute', 'failed',
            { semanticDigest: compiled.semanticDigest, approvedDigest: approval, prepareObservationRef: prepared.item.ref,
              dispatchHoldId: activeHandle.holdId, claimRequestDigest, requestDigest: claimRequestDigest,
              target: expectedTargetIdentity(fresh.preimage) },
            { outcome: 'not_dispatched', issue: native.issue ?? 'cancel_native_request_not_continued', requestDispatched: false,
              dispatchHoldId: activeHandle.holdId, claimRequestDigest, requestDigest: claimRequestDigest, runId,
              sourceRefs: compiled.sourceRefs }, ['closed_cancel_session_proved_request_never_dispatched']);
          try {
            await resolveNeverDispatchedCancel(ctx.db, activeHandle, native.neverDispatchedProof, async (tx, intent) => {
              const recovery = record(intent.recovery), intentTarget = hmsDispatchTargetSchema.safeParse(intent.target);
              if (intent.transportId !== ctx.transport.id || intent.workItemId !== input.workItemId ||
                  intent.actorUserId !== ctx.user.id || intent.grantId !== input.idempotencyKey ||
                  intent.operation !== 'cancel' || intent.propertyCode !== ctx.property.propertyCode ||
                  intent.approvedDigest !== approval || intent.sourceDigest !== input.source.sourceHash ||
                  intent.requestDigest !== claimRequestDigest || recovery?.claimDigest !== claimDigest ||
                  canonicalJson(recovery?.before) !== canonicalJson(beforeReceipt) || recovery?.runId !== runId ||
                  recovery?.confirmation !== compiled.preimage.confirmation ||
                  recovery?.nativeStayId !== compiled.preimage.nativeStayId ||
                  recovery?.reasonCode !== matchingReason.value || recovery?.reasonLabel !== matchingReason.display ||
                  recovery?.cancellationNote !== compiled.cancellationNote ||
                  canonicalJson(recovery?.preimage) !== canonicalJson(fresh.preimage) ||
                  intent.nativeGuestId !== fresh.preimage.guestId || intent.firstName !== fresh.preimage.firstName ||
                  intent.lastName !== fresh.preimage.lastName || !intentTarget.success ||
                  intentTarget.data.kind !== 'saved' || intentTarget.data.confirmation !== compiled.preimage.confirmation ||
                  intentTarget.data.nativeStayId !== compiled.preimage.nativeStayId ||
                  recovery?.cloudTargetKey !== hmsDispatchTargetKey(expectedTarget)) {
                throw new Error('reservation_workflow_v2_cancel_no_dispatch_scope_changed');
              }
              await persistCancelNotDispatched(tx, ctx, input, compiled, notDispatched,
                'Native cancellation session proved the request was never dispatched');
            });
            return { status: 'failed', operationId: input.idempotencyKey, issue: 'cancel_native_not_dispatched' };
          } catch {
            return { status: 'needs_reconcile', operationId: input.idempotencyKey, dispatchHoldId: activeHandle.holdId,
              issue: 'cancel_no_dispatch_release_unconfirmed' };
          }
        }
        if (!activeHandle && claimError) return { status: 'needs_reconcile', operationId: input.idempotencyKey,
          issue: 'cancel_dispatch_claim_outcome_unknown' };
        if (!activeHandle && native.neverDispatchedProof && native.requestDispatched === false &&
            native.writerSessionClosed === true && native.dispatchCallbacksDrained === true &&
            native.chargeApproved !== true && native.zeroPenaltyNotice == null && acceptedPenaltyText === null &&
            await consumeNeverDispatchedCancelProof(native.neverDispatchedProof, { runId, target: expectedTarget,
              cloudTargetKey: hmsDispatchTargetKey(expectedTarget) })) {
          const notDispatched = observation(loaded.draft, input, compiled.requestId, compiled.hintId, 'execute', 'failed',
            { semanticDigest: compiled.semanticDigest, approvedDigest: approval, prepareObservationRef: prepared.item.ref,
              target: expectedTargetIdentity(fresh.preimage) },
            { outcome: 'not_dispatched', issue: native.issue ?? 'cancel_native_request_not_started', requestDispatched: false,
              runId, sourceRefs: compiled.sourceRefs }, ['closed_cancel_session_proved_request_never_dispatched']);
          const saved = await recordOperation(ctx, input, compiled.requestId, compiled.hintId, notDispatched, 'failed',
            'Native cancellation session proved the request was never dispatched', input.idempotencyKey);
          return saved.status === 'ok' ? { status: 'failed', operationId: input.idempotencyKey,
            issue: 'cancel_native_not_dispatched' } : saved;
        }
        if (!activeHandle) return { status: 'needs_reconcile', operationId: input.idempotencyKey,
          issue: 'cancel_no_dispatch_unverified' };
        const issue = activeHandle ? (native.zeroPenaltyNotice != null || !financialStateMatches || !noNewFinancialState
          ? 'cancel_financial_state_unverified' : 'cancel_native_outcome_unconfirmed') : claimError ?? native.issue ?? native.outcome;
        const uncertain = observation(loaded.draft, input, compiled.requestId, compiled.hintId, 'execute',
          'partial', { semanticDigest: compiled.semanticDigest, approvedDigest: approval,
            prepareObservationRef: prepared.item.ref, dispatchHoldId: activeHandle.holdId },
          { outcome: native.outcome ?? 'unknown', issue, requestDispatched: native.requestDispatched ?? false,
            nativeReadback: native.nativeReadback ?? null, penaltyText: native.penaltyText ?? null,
            penaltyAmount: cancellationPenaltyNotice(native.penaltyText)?.amount ?? null,
            penaltyTiming: native.penaltyTiming ?? null, penaltyApprovalRequired: native.chargeApproved !== true,
            zeroPenaltyNotice: native.zeroPenaltyNotice ?? null, dispatchHoldId: activeHandle.holdId,
            claimRequestDigest, requestDigest: nativeRequestDigest, sourceRefs: compiled.sourceRefs },
          ['durable_cancel_hold_requires_reconciliation']);
        const saved = await recordOperation(ctx, input, compiled.requestId, compiled.hintId, uncertain,
          'unknown', 'Native cancel may have dispatched; do not retry before reconciliation', input.idempotencyKey);
        return { status: 'needs_reconcile', operationId: input.idempotencyKey, dispatchHoldId: activeHandle.holdId,
          penaltyText: native.penaltyText ?? null, penaltyAmount: cancellationPenaltyNotice(native.penaltyText)?.amount ?? null,
          penaltyTiming: native.penaltyTiming ?? null, penaltyApprovalRequired: native.chargeApproved !== true,
          cancellationStatus: readback.success ? readback.data.status : null,
          issue: saved.status === 'ok' ? issue : 'cancel_unknown_receipt_unavailable' };
      }
      const afterPath = screenshotPath(native, 'after.png');
      const runDir = afterPath ? dirname(afterPath) : null;
      const savedShot = runDir ? await storeCancelScreenshot(ctx, input.workItemId, runId, 'saved.png',
        { path: afterPath!, sourceDir: runDir }) : null;
      if (!savedShot || !readback.success) {
        const unresolved = observation(loaded.draft, input, compiled.requestId, compiled.hintId, 'execute', 'partial',
          { semanticDigest: compiled.semanticDigest, approvedDigest: approval, dispatchHoldId: activeHandle.holdId },
          { outcome: 'cancelled', issue: 'cancel_readback_evidence_unavailable', nativeReadback: native.nativeReadback ?? null },
          ['positive_cancel_readback_evidence_missing']);
        await recordOperation(ctx, input, compiled.requestId, compiled.hintId, unresolved, 'unknown',
          'HMS reported a possible cancellation but durable readback evidence is missing', input.idempotencyKey);
        return { status: 'needs_reconcile', operationId: input.idempotencyKey, dispatchHoldId: activeHandle.holdId,
          issue: 'cancel_readback_evidence_unavailable' };
      }
      const success = observation(loaded.draft, input, compiled.requestId, compiled.hintId, 'execute', 'complete',
        { semanticDigest: compiled.semanticDigest, approvedDigest: approval, prepareObservationRef: prepared.item.ref,
          dispatchHoldId: activeHandle.holdId, target: expectedTargetIdentity(fresh.preimage), baselineDigest: sha256(fresh.preimage),
          financialDigest: sha256({ preflight: stablePreflight(fresh.preflight), penaltyText: fresh.penaltyText }) },
        { outcome: 'cancelled', sourceRefs: compiled.sourceRefs, preimage: fresh.preimage,
          preflight: fresh.preflight, penaltyText: fresh.penaltyText, nativeReadback: readback.data,
          readbackDigest: sha256(readback.data), savedShot: { runId, sha256: savedShot.sha256 } });
      success.sourceRefs = sourceObservationRefs(loaded.draft, [compiled.sourceRefs]);
      try {
        await resolveHmsLabtestDispatch(ctx.db, activeHandle, { operation: 'cancel', confirmation: readback.data.confirmation,
          nativeStayId: readback.data.nativeStayId, nativeReadback: readback.data,
          readbackDigest: sha256(readback.data), savedShot: { runId, sha256: savedShot.sha256 } }, async (tx, intent) => {
          if (intent.transportId !== ctx.transport.id || intent.workItemId !== input.workItemId ||
              intent.actorUserId !== ctx.user.id || intent.grantId !== input.idempotencyKey ||
              intent.operation !== 'cancel' || intent.approvedDigest !== approval || intent.sourceDigest !== input.source.sourceHash ||
              intent.requestDigest !== claimRequestDigest || record(intent.recovery)?.claimDigest !== claimDigest ||
              canonicalJson(record(intent.recovery)?.before) !== canonicalJson(beforeReceipt) ||
              record(intent.recovery)?.confirmation !== compiled.preimage.confirmation ||
              record(intent.recovery)?.nativeStayId !== compiled.preimage.nativeStayId ||
              record(intent.recovery)?.runId !== runId) throw new Error('reservation_workflow_v2_cancel_resolution_scope_changed');
          await persistCancelResolution(tx, ctx, input, compiled, success,
            `Cancelled ${fresh.preimage.firstName} ${fresh.preimage.lastName}; HMS cancellation readback verified`);
        });
      } catch {
        const unresolved = observation(loaded.draft, input, compiled.requestId, compiled.hintId, 'execute', 'partial',
          { semanticDigest: compiled.semanticDigest, approvedDigest: approval, dispatchHoldId: activeHandle.holdId },
          { outcome: 'cancelled', issue: 'cancel_durable_resolution_unconfirmed', nativeReadback: readback.data,
            savedShot: { runId, sha256: savedShot.sha256 } }, ['durable_cancel_hold_unresolved']);
        await recordOperation(ctx, input, compiled.requestId, compiled.hintId, unresolved, 'unknown',
          'Cancellation readback passed but durable hold resolution is unresolved', input.idempotencyKey);
        return { status: 'needs_reconcile', operationId: input.idempotencyKey, dispatchHoldId: activeHandle.holdId,
          issue: 'cancel_durable_resolution_unconfirmed' };
      }
      return { status: 'succeeded', operationId: input.idempotencyKey, requestId: compiled.requestId,
        hintId: compiled.hintId, confirmation: readback.data.confirmation, observationRef: success.ref };
      } finally {
        await removeNativeRunDir(native?.runDir);
      }
    }, acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
  } catch (error) {
    return { status: 'needs_reconcile', issue: isPropertyReadLockDeadline(error) ? 'cancel_target_lock_busy' : 'cancel_target_lock_failed' };
  }
  return lockResult;
}

/** Positive-only recovery; a cancelled-status read cannot clear a hold while the fee/penalty result is unknown. */
export async function reservationWorkflowV2CancelReconcile(ctx: ReservationWorkflowV2CancelContext,
  input: ReservationWorkflowV2ReconcileInput): Promise<CancelOutcome> {
  if (!z.string().uuid().safeParse(input.operationId).success) return { status: 'invalid_input', issue: 'cancel_operation_id_invalid' };
  const initial = await getReservationWorkflowV2Draft(stateContext(ctx), input);
  if (initial.status !== 'ok') return initial;
  const operation = operationById(initial.draft, input.operationId);
  if (!operation) return { status: 'not_found' };
  if (operation.status === 'succeeded') return { status: 'succeeded', operationId: operation.id,
    summary: operation.summary, observationRefs: operation.observationRefs };
  if (operation.status === 'failed') return { status: 'failed', operationId: operation.id, summary: operation.summary };
  if (operation.status !== 'unknown') return { status: 'not_reconcilable', operationId: operation.id };
  const sourceObservation = operation.observationRefs.map((ref) => initial.draft.observations.find((item) => item.ref === ref))
    .find((item): item is ReservationWorkflowV2Observation => Boolean(item));
  const sourceResult = record(sourceObservation?.result);
  const holdId = text(sourceResult?.dispatchHoldId);
  const claimRequestDigest = text(sourceResult?.claimRequestDigest);
  const exactCancelRequestDigest = text(sourceResult?.requestDigest);
  const rows = await ctx.db.select({ id: workEvent.id, value: workEvent.value }).from(workEvent)
    .where(and(eq(workEvent.workItemId, input.workItemId), eq(workEvent.type, 'write.evidence'),
      eq(workEvent.fieldPath, CANCEL_DISPATCH_FIELD))).limit(5000);
  if (rows.length === 5000) return { status: 'needs_reconcile', operationId: input.operationId,
    issue: 'cancel_dispatch_evidence_scan_truncated' };
  const intents = rows.map((row) => ({ id: row.id, value: record(row.value) })).filter((row) =>
    row.value?.kind === 'intent' && row.value.operation === 'cancel' && row.value.grantId === input.operationId &&
    row.value.workItemId === input.workItemId && row.value.transportId === ctx.transport.id);
  if (!intents.length) {
    return { status: 'needs_reconcile', operationId: input.operationId, holdReleased: false,
      issue: 'cancel_unknown_receipt_has_no_dispatch_proof' };
  }
  const matched = holdId ? intents.find((entry) => entry.value?.holdId === holdId) : intents.length === 1 ? intents[0] : null;
  if (!matched || intents.length !== 1 || !matched.value) return { status: 'needs_reconcile', operationId: input.operationId,
    issue: 'cancel_dispatch_intent_scope_unverified' };
  const intent = matched.value as unknown as HmsLabtestIntent;
  if (intent.approvedDigest !== record(sourceObservation?.criteria)?.approvedDigest ||
      intent.sourceDigest !== input.source.sourceHash || intent.propertyCode !== ctx.property.propertyCode ||
      (claimRequestDigest !== null && intent.requestDigest !== claimRequestDigest)) {
    return { status: 'needs_reconcile', operationId: input.operationId, dispatchHoldId: intent.holdId,
      issue: 'cancel_dispatch_intent_scope_changed' };
  }
  const recovery = record(intent.recovery), before = record(recovery?.before), target = currentTarget(ctx);
  const boundTarget = hmsDispatchTargetSchema.safeParse(intent.target);
  const preimage = cancelPreimageSchema.safeParse(recovery?.preimage);
  if (!recovery || !before || !target || !boundTarget.success || boundTarget.data.kind !== 'saved' ||
      !boundTarget.data.nativeStayId || !boundTarget.data.confirmation || !preimage.success ||
      boundTarget.data.propertyCode !== ctx.property.propertyCode || (preimage.data.propertyCode ?? 'HRCEN') !== ctx.property.propertyCode ||
      recovery.runId !== before.runId || before.name !== 'before.png' ||
      recovery.confirmation !== boundTarget.data.confirmation || recovery.nativeStayId !== boundTarget.data.nativeStayId ||
      preimage.data.confirmation !== boundTarget.data.confirmation || preimage.data.nativeStayId !== boundTarget.data.nativeStayId ||
      typeof before.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(before.sha256)) {
    return { status: 'needs_reconcile', operationId: input.operationId, dispatchHoldId: intent.holdId,
      issue: 'cancel_recovery_evidence_scope_unverified', holdReleased: false };
  }
  const savedTarget = boundTarget.data;
  const owner = `${intent.actorUserId}:${intent.transportId}`;
  const targetLock = paneStayCloudTargetLock(target, savedTarget, { kind: 'independent_cloud' });
  if (!targetLock) return { status: 'needs_reconcile', operationId: input.operationId, dispatchHoldId: intent.holdId,
    issue: 'cancel_target_lock_unavailable', holdReleased: false };
  try {
    const proof = await targetLock.withLock(async (targetSignal) => {
      const signal = targetSignal && ctx.signal ? AbortSignal.any([targetSignal, ctx.signal]) : targetSignal ?? ctx.signal;
      if (!await verifyStoredHmsShot({ runId: String(recovery.runId), name: 'before.png', sha256: before.sha256 as string,
        owner, propertyCode: ctx.property.propertyCode, workItemId: input.workItemId }, 'before.png')) throw new Error('cancel_before_shot_unavailable');
      const native = await import(new URL('../../tooling/hms-cloud/pane-cancel-session.mjs', import.meta.url).href) as {
        provePositiveCancelRecovery(intent: HmsLabtestIntent, options: { signal?: AbortSignal }): Promise<{ outcome: string; confirmation?: unknown;
          readback?: unknown; screenshot?: unknown }>;
      };
      const observed = await native.provePositiveCancelRecovery(intent, { signal });
      signal?.throwIfAborted();
      const readback = z.object({ confirmation: z.string(), nativeStayId: z.string().regex(/^\d{1,100}$/),
        nativeGuestId: z.string().regex(/^\d{1,30}$/), status: z.string().regex(/^cancel(?:l)?ed$/i),
        reasonCode: z.string(), cancellationNote: z.string() }).passthrough().safeParse(observed.readback);
      if (observed.outcome !== 'verified' || !readback.success || !Buffer.isBuffer(observed.screenshot) ||
          observed.confirmation !== savedTarget.confirmation || readback.data.confirmation !== savedTarget.confirmation ||
          readback.data.nativeStayId !== savedTarget.nativeStayId || readback.data.nativeGuestId !== intent.nativeGuestId ||
          readback.data.reasonCode !== recovery.reasonCode || readback.data.cancellationNote !== recovery.cancellationNote) {
        throw new Error('cancel_recovery_readback_unavailable');
      }
      const screenshot = await storeCancelScreenshot(ctx, input.workItemId, String(recovery.runId), 'saved.png',
        { bytes: observed.screenshot }, owner);
      if (!screenshot) throw new Error('cancel_recovery_screenshot_unavailable');
      return { readback: readback.data, screenshot };
    }, acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
    const positive = observation(initial.draft, input, operation.requestId, operation.allocationId ?? 'cancel',
      'reconcile', 'partial', { operationId: input.operationId, dispatchHoldId: intent.holdId,
        approvedDigest: intent.approvedDigest,
        positiveReadbackDigest: sha256(proof.readback) },
      { outcome: 'cancelled_readback_verified', confirmation: proof.readback.confirmation,
        nativeStayId: proof.readback.nativeStayId, nativeReadback: proof.readback, savedShot: proof.screenshot,
        dispatchHoldId: intent.holdId, claimRequestDigest, requestDigest: exactCancelRequestDigest,
        financialState: 'unknown_after_interrupted_cancel', holdReleased: false },
      ['penalty_or_fee_state_cannot_be_recovered_from_status_readback']);
    await recordOperation(ctx, input, operation.requestId, operation.allocationId ?? 'cancel', positive, 'unknown',
      'Cancellation status readback is positive, but interrupted penalty state keeps the durable hold active', input.operationId);
    return { status: 'needs_reconcile', operationId: input.operationId, dispatchHoldId: intent.holdId,
      confirmedCancelled: true, financialState: 'unknown', holdReleased: false,
      financialReviewRequired: true,
      nextAction: 'Review the current HMS deposit and cancellation fee activity; do not retry cancellation.',
      ...(exactCancelRequestDigest ? { exactCancelRequestDigest } : {}),
      issue: 'cancel_recovery_penalty_unverified' };
  } catch {
    return { status: 'needs_reconcile', operationId: input.operationId, dispatchHoldId: intent.holdId,
      issue: 'fresh_positive_cancel_readback_unavailable', holdReleased: false };
  }
}
