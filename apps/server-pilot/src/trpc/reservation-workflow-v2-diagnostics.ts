import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { workItem } from '../db/schema/work.js';
import { recordHmsPrepareFailure, type HmsPrepareFailedValue } from '../ai/work-events.js';

const nonFailures = new Set([
  'ok', 'ready', 'complete', 'prepared', 'succeeded', 'already_succeeded', 'priced', 'linked', 'verified',
  'matches', 'found', 'candidate',
  'queued', 'running', 'pending', 'idle', 'superseded', 'accepted', 'at_boundary', 'skipped',
  'not_applicable', 'not_requested',
]);
const recentPollFailures = new Map<string, number>();

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function label(value: unknown, max = 200): string | undefined {
  return typeof value === 'string' && value.length <= max && /^[A-Za-z0-9_./:-]+$/.test(value) ? value : undefined;
}

function pathLabel(value: unknown, max = 300): string | undefined {
  return typeof value === 'string' && value.length <= max && /^[A-Za-z0-9_./:%~-]+$/.test(value) ? value : undefined;
}

function targetReference(value: unknown) {
  if (typeof value === 'string') return label(value, 200);
  const row = record(value);
  if (!row) return undefined;
  const target = {
    kind: label(row.kind, 50), requestId: label(row.requestId, 80),
    allocationId: label(row.allocationId, 80), hintId: label(row.hintId, 80),
  };
  return Object.values(target).some(Boolean) ? target : undefined;
}

function failure(value: unknown) {
  const row = record(value);
  const status = label(row?.status ?? row?.outcome, 50);
  if (!status || (nonFailures.has(status) && row?.issue !== 'batch_preparations_incomplete')) return undefined;
  const fields = Array.isArray(row?.fields)
    ? row.fields.map((field) => pathLabel(field)).filter((field): field is string => Boolean(field)).slice(0, 32)
    : [];
  const details = Array.isArray(row?.details) ? row.details.slice(0, 32).map((value) => {
    const detail = record(value);
    return { path: pathLabel(detail?.path), code: label(detail?.code, 100),
      expected: typeof detail?.expected === 'number' ? detail.expected : undefined,
      actual: typeof detail?.actual === 'number' ? detail.actual : undefined };
  }) : [];
  const notes = record(row?.coverage)?.notes;
  return { status, issue: label(row?.issue ?? (Array.isArray(notes) ? notes[0] : undefined), 200),
    kind: label(row?.kind, 80), key: label(row?.key, 200), requestId: label(row?.requestId, 80),
    allocationId: label(row?.allocationId, 80), serviceId: label(row?.serviceId, 80),
    observationRef: label(row?.observationRef, 100),
    ...(fields.length ? { fields } : {}), ...(details.length ? { details } : {}) };
}

function buildCommit() {
  const value = process.env.NAVA_BUILD_COMMIT;
  return value && /^[a-f0-9]{40}$/.test(value) ? value : undefined;
}

function reproAction(path: string) {
  return /(?:^|\.)(?:prepare|prepareServices|prepareGuestProfile|execute|executeServices|createGuestProfile)$/.test(path);
}

function structuredPath(value: unknown) {
  const field = pathLabel(value);
  if (!field) return undefined;
  const separator = field.lastIndexOf(':');
  const path = separator > 0 ? field.slice(0, separator) : field;
  const code = separator > 0 ? label(field.slice(separator + 1), 100) : undefined;
  const segments = (path.startsWith('/') ? path.slice(1).split('/') : path.split('.'))
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .map((segment) => pathLabel(segment, 100)).filter((segment): segment is string => Boolean(segment));
  return { path, segments, ...(code ? { code } : {}) };
}

async function writeReproBundle(input: {
  path: string; raw: Record<string, unknown> | undefined; response: Record<string, unknown>;
  outcomes: Array<{ status: string; issue?: string; fields?: string[];
    observationRef?: string; details?: Array<{
      path?: string; code?: string; expected?: number; actual?: number;
    }> }>;
  draftErrors: Array<{ stage?: string; code?: string }>;
}) {
  const directory = process.env.NAVA_WORKFLOW_REPRO_DIR?.trim();
  const status = label(input.response.status ?? input.response.outcome, 50);
  const hasNestedBlocker = input.outcomes.some((item) => item.status === 'needs_input' || item.status === 'failed');
  if (!directory || !reproAction(input.path) ||
    (status !== 'needs_input' && status !== 'failed' && !hasNestedBlocker)) return;
  const source = record(input.raw?.source);
  const responseFields = Array.isArray(input.response.fields) ? input.response.fields : [];
  const blockerFields = [...new Set([...responseFields, ...input.outcomes.flatMap((item) => item.fields ?? []),
    ...input.outcomes.flatMap((item) => item.details?.map((detail) => detail.path) ?? [])]
    .map((field) => pathLabel(field)).filter((field): field is string => Boolean(field)))].slice(0, 64);
  const blockerCodes = [...new Set([input.response.issue, ...input.outcomes.map((item) => item.issue),
    ...input.outcomes.flatMap((item) => item.details?.map((detail) => detail.code) ?? []),
    ...input.draftErrors.map((item) => item.code)]
    .map((code) => label(code, 100)).filter((code): code is string => Boolean(code)))].slice(0, 64);
  const observationRefs = [...new Set([input.response.observationRef,
    ...(Array.isArray(input.response.observationRefs) ? input.response.observationRefs : []),
    ...input.outcomes.map((item) => item.observationRef)]
    .map((ref) => label(ref, 100)).filter((ref): ref is string => Boolean(ref)))].slice(0, 32);
  const bundle = {
    schemaVersion: 1, at: new Date().toISOString(), action: input.path, status,
    workItemId: label(input.raw?.workItemId),
    revision: typeof input.raw?.expectedRevision === 'number' ? input.raw.expectedRevision : undefined,
    seq: typeof input.raw?.expectedSeq === 'number' ? input.raw.expectedSeq : undefined,
    requestId: label(input.raw?.requestId, 80),
    allocationId: label(input.raw?.allocationId, 80), serviceId: label(input.raw?.serviceId, 80),
    targetRef: targetReference(input.raw?.targetRef),
    sourceHash: typeof source?.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(source.sourceHash) ? source.sourceHash : undefined,
    serverBuild: buildCommit(), blockerCodes, blockerFields,
    missingControls: blockerFields.map(structuredPath).filter((item) => item !== undefined),
    offlineReload: { mode: 'metadata_only', limitation: 'draft_and_overrides_not_captured' },
    ...(observationRefs.length ? { observationRefs } : {}),
  };
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(resolve(root, `${Date.now()}-${randomUUID()}.json`), `${JSON.stringify(bundle, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

/** Only Prepare calls count; lookup and Go failures are different funnel stages. */
const prepareFailureActions: Record<string, { stage: HmsPrepareFailedValue['stage'];
  workflow?: HmsPrepareFailedValue['workflow'] }> = {
  prepare: { stage: 'prepare' }, prepareServices: { stage: 'prepare', workflow: 'addons' },
  prepareGuestProfile: { stage: 'prepare', workflow: 'guest_profile' },
};

type PrepareFailureOutcome = { status: string; issue?: string; details?: Array<{ code?: string }> };

/** Keep one hms.prepare.failed event for a failed or blocked call, bound to the mailbox's own work item. */
async function recordPrepareFailure(db: DB, input: {
  action: string; raw: Record<string, unknown> | undefined; userId: string; transportId: string;
  elapsedMs: number; errorCode?: string;
  primary: PrepareFailureOutcome | undefined; nested: PrepareFailureOutcome[];
}) {
  const scope = prepareFailureActions[input.action];
  const workItemId = input.raw?.workItemId;
  const outcomes = [...(input.primary ? [input.primary] : []), ...input.nested];
  if (!scope || (!input.errorCode && !outcomes.length) ||
      typeof workItemId !== 'string' || !z.string().uuid().safeParse(workItemId).success) return;
  const [item] = await db.select({ state: workItem.state }).from(workItem)
    .where(and(eq(workItem.id, workItemId), eq(workItem.transportId, input.transportId))).limit(1);
  if (!item) return;
  const state = record(item.state);
  const draft = record(state?.reservationWorkflowV2);
  const requests = record(record(draft?.proposal)?.content)?.requests;
  const requestId = input.raw?.requestId;
  const request = typeof requestId === 'string' && Array.isArray(requests)
    ? requests.map(record).find((row) => row?.id === requestId)
    : Array.isArray(requests) && requests.length === 1 ? record(requests[0]) : undefined;
  await recordHmsPrepareFailure(db, {
    workItemId, actorUserId: input.userId,
    workflow: scope.workflow ?? label(request?.kind, 50),
    stage: scope.stage,
    status: input.primary?.status ?? input.nested[0]?.status,
    codes: [input.errorCode, ...outcomes.flatMap((outcome) =>
      [outcome.issue, ...(outcome.details?.map((detail) => detail.code) ?? [])])],
    propertyCode: label(draft?.propertyCode ?? state?.propertyCode, 10), durationMs: input.elapsedMs,
  });
}

/** Record only bounded diagnostic metadata; draft state retains the underlying email and field values. */
export async function logReservationWorkflowFailure(input: {
  path: string; rawInput: unknown; result?: unknown; error?: { code: string; cause?: unknown };
  userId: string; transportId: string; correlationId: string | null; elapsedMs: number;
  /** When given, a failed Prepare is also kept as a bounded work event. */
  db?: () => DB;
}) {
  const response = record(input.result);
  const draft = record(response?.draft), prefill = record(draft?.prefill);
  const draftErrors = Array.isArray(draft?.errors) ? draft.errors.slice(0, 32).map((value) => {
    const error = record(value);
    return { stage: label(error?.stage, 50), code: label(error?.code, 100) };
  }).filter((error) => error.code) : [];
  const serviceObservations = input.path.endsWith('lookupServices') && Array.isArray(response?.observations)
    ? response.observations.map(failure) : [];
  const serviceOutcomes = input.path.endsWith('prepareServices') && Array.isArray(response?.services)
    ? response.services.map(failure) : [];
  const outcomes = [failure(response), ...(Array.isArray(response?.lookups) ? response.lookups.map(failure) : []),
    ...(Array.isArray(response?.quotes) ? response.quotes.map(failure) : []),
    ...(Array.isArray(prefill?.nativeChecks) ? prefill.nativeChecks.map(failure) : []),
    ...serviceObservations, ...serviceOutcomes,
    ...(prefill?.status === 'failed' || draft?.status === 'prefill_failed' ? [{ status: 'prefill_failed' }] : [])]
    .filter((row) => row !== undefined).slice(0, 32);
  if (!input.error && outcomes.length === 0 && draftErrors.length === 0) return;
  const raw = record(input.rawInput), source = record(raw?.source);
  // The draft's earlier arrival checks and errors are not this call's failure.
  const nestedOutcomes = [...(Array.isArray(response?.lookups) ? response.lookups.map(failure) : []),
    ...(Array.isArray(response?.quotes) ? response.quotes.map(failure) : []), ...serviceObservations, ...serviceOutcomes]
    .filter((row) => row !== undefined && row.status !== 'excluded').slice(0, 32);
  if (input.db) {
    try {
      await recordPrepareFailure(input.db(), { action: input.path.slice(input.path.lastIndexOf('.') + 1), raw,
        userId: input.userId, transportId: input.transportId, elapsedMs: input.elapsedMs,
        errorCode: input.error?.code, primary: failure(response), nested: nestedOutcomes });
    } catch {
      console.warn('hms_prepare_failed_event_skipped', 'lookup');
    }
  }
  const workItemId = label(raw?.workItemId);
  if (input.path.endsWith('.get') && !input.error && workItemId) {
    const key = createHash('sha256').update(JSON.stringify([workItemId, raw?.expectedRevision, raw?.expectedSeq,
      outcomes, draftErrors])).digest('hex');
    const now = Date.now();
    if (now - (recentPollFailures.get(key) ?? 0) < 60_000) return;
    if (recentPollFailures.size >= 1000) recentPollFailures.delete(recentPollFailures.keys().next().value!);
    recentPollFailures.set(key, now);
  }
  const validation = input.error?.cause instanceof z.ZodError
    ? input.error.cause.issues.slice(0, 32).map((issue) => ({ code: issue.code,
      path: issue.path.map((segment) => label(String(segment), 100) ?? '?').join('.') })) : undefined;
  const correlationId = z.string().uuid().safeParse(input.correlationId);
  const serverBuild = buildCommit();
  console.info('reservation_workflow_failure', JSON.stringify({
    at: new Date().toISOString(), action: input.path, userId: label(input.userId), mailboxId: label(input.transportId),
    serverBuild,
    correlationId: correlationId.success ? correlationId.data : undefined,
    workItemId, messageId: label(source?.messageId), requestId: label(raw?.requestId, 80),
    sourceHash: typeof source?.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(source.sourceHash) ? source.sourceHash : undefined,
    allocationId: label(raw?.allocationId, 80), serviceId: label(raw?.serviceId, 80),
    targetRef: targetReference(raw?.targetRef), operationId: label(raw?.operationId),
    revision: typeof raw?.expectedRevision === 'number' ? raw.expectedRevision : undefined,
    seq: typeof raw?.expectedSeq === 'number' ? raw.expectedSeq : undefined,
    elapsedMs: input.elapsedMs, ...(input.error ? { errorCode: input.error.code, validation } : {}),
    ...(outcomes.length ? { outcomes } : {}),
    ...(draftErrors.length ? { draftErrors } : {}),
  }));
  if (response || input.error) await writeReproBundle({ path: input.path, raw,
    response: response ?? { status: 'failed', issue: input.error?.code }, outcomes, draftErrors });
}
