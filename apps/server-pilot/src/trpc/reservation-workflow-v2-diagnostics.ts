import { z } from 'zod';
import { createHash } from 'node:crypto';

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

function failure(value: unknown) {
  const row = record(value);
  const status = label(row?.status ?? row?.outcome, 50);
  if (!status || nonFailures.has(status)) return undefined;
  const fields = Array.isArray(row?.fields) ? row.fields.map((field) => label(field, 300)).filter(Boolean).slice(0, 32) : [];
  const details = Array.isArray(row?.details) ? row.details.slice(0, 32).map((value) => {
    const detail = record(value);
    return { path: label(detail?.path, 300), code: label(detail?.code, 100),
      expected: typeof detail?.expected === 'number' ? detail.expected : undefined,
      actual: typeof detail?.actual === 'number' ? detail.actual : undefined };
  }) : [];
  const notes = record(row?.coverage)?.notes;
  return { status, issue: label(row?.issue ?? (Array.isArray(notes) ? notes[0] : undefined), 200),
    kind: label(row?.kind, 80), key: label(row?.key, 200), requestId: label(row?.requestId, 80),
    allocationId: label(row?.allocationId, 80), ...(fields.length ? { fields } : {}), ...(details.length ? { details } : {}) };
}

/** Record only bounded diagnostic metadata; draft state retains the underlying email and field values. */
export function logReservationWorkflowFailure(input: {
  path: string; rawInput: unknown; result?: unknown; error?: { code: string; cause?: unknown };
  userId: string; transportId: string; correlationId: string | null; elapsedMs: number;
}) {
  const response = record(input.result);
  const draft = record(response?.draft), prefill = record(draft?.prefill);
  const draftErrors = Array.isArray(draft?.errors) ? draft.errors.slice(0, 32).map((value) => {
    const error = record(value);
    return { stage: label(error?.stage, 50), code: label(error?.code, 100) };
  }).filter((error) => error.code) : [];
  const serviceObservations = input.path.endsWith('lookupServices') && Array.isArray(response?.observations)
    ? response.observations.map(failure) : [];
  const outcomes = [failure(response), ...(Array.isArray(response?.lookups) ? response.lookups.map(failure) : []),
    ...(Array.isArray(response?.quotes) ? response.quotes.map(failure) : []),
    ...(Array.isArray(prefill?.nativeChecks) ? prefill.nativeChecks.map(failure) : []),
    ...serviceObservations,
    ...(prefill?.status === 'failed' || draft?.status === 'prefill_failed' ? [{ status: 'prefill_failed' }] : [])]
    .filter((row) => row !== undefined).slice(0, 32);
  if (!input.error && outcomes.length === 0 && draftErrors.length === 0) return;
  const raw = record(input.rawInput), source = record(raw?.source);
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
  const serverBuild = process.env.NAVA_BUILD_COMMIT;
  console.info('reservation_workflow_failure', JSON.stringify({
    at: new Date().toISOString(), action: input.path, userId: label(input.userId), mailboxId: label(input.transportId),
    serverBuild: serverBuild && /^[a-f0-9]{40}$/.test(serverBuild) ? serverBuild : undefined,
    correlationId: correlationId.success ? correlationId.data : undefined,
    workItemId, messageId: label(source?.messageId), requestId: label(raw?.requestId, 80),
    sourceHash: typeof source?.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(source.sourceHash) ? source.sourceHash : undefined,
    allocationId: label(raw?.allocationId, 80), operationId: label(raw?.operationId),
    revision: typeof raw?.expectedRevision === 'number' ? raw.expectedRevision : undefined,
    seq: typeof raw?.expectedSeq === 'number' ? raw.expectedSeq : undefined,
    elapsedMs: input.elapsedMs, ...(input.error ? { errorCode: input.error.code, validation } : {}),
    ...(outcomes.length ? { outcomes } : {}),
    ...(draftErrors.length ? { draftErrors } : {}),
  }));
}
