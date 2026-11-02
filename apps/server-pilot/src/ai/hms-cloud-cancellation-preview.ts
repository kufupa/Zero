import { CENTURION_HMS_READ_TARGET, type HmsReadTarget } from '../hms/hms-read-target.js';
import type { PaneStayFindInput } from './pane-stay-lookup.js';

type RecordValue = Record<string, unknown>;
type CancellationFact = { state: string; value: string | null };
type CancellationModuleStatus = { outcome: string | null; issue: string | null };
type CancellationPreviewFailureOutcome =
  | 'target_unverified' | 'refused_input_invalid' | 'refused_flag_off' | 'refused_lock_unavailable'
  | 'refused_lock_busy' | 'refused_unknown_transport' | 'refused_identity_mismatch'
  | 'refused_preview_unavailable' | 'execution_failure';
type CancellationPreviewCommon = {
  source: 'hms_cloud_cancellation_preflight';
  moduleStatus: CancellationModuleStatus;
  observedAt: string | null;
  reason: string | null;
};
export type HmsCloudCancellationPreviewResult = (CancellationPreviewCommon & {
  outcome: 'prepared_for_human_review';
  target: { confirmation: string; verified: true };
  stay: { status: CancellationFact; arrivalDate: CancellationFact; departureDate: CancellationFact };
  roomScope: { requested: 'unspecified'; state: 'unresolved'; complete: false };
  policy: { state: 'unknown' };
  fee: { state: 'unknown_precommit'; amount: null; currency: null };
  action: { actor: 'human'; cancellationStarted: false; commitAvailable: false };
}) | (CancellationPreviewCommon & { outcome: CancellationPreviewFailureOutcome });

export type CloudCancellationPreviewRunInput = {
  request: PaneStayFindInput;
  target: HmsReadTarget;
  signal?: AbortSignal;
};

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, 300) : null;
}

function realDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function parseDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const iso = value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:\s+\d{2}:\d{2})?$/);
  if (iso && realDay(iso[1])) return iso[1];
  const display = value.trim().match(/^(?:[A-Za-z]{3}\s+)?(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+\d{2}:\d{2})?$/);
  if (!display) return null;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(display[2]!.toLowerCase());
  if (month < 0) return null;
  const date = new Date(Date.UTC(Number(display[3]), month, Number(display[1])));
  return date.getUTCFullYear() === Number(display[3]) && date.getUTCMonth() === month && date.getUTCDate() === Number(display[1])
    ? date.toISOString().slice(0, 10)
    : null;
}

const FACT_STATES = new Set(['observed', 'observed_zero', 'blank', 'unavailable', 'ambiguous', 'conflict']);

function cancellationFact(value: unknown, date = false): CancellationFact {
  const source = record(value);
  const candidateState = text(source?.state);
  const state = candidateState && FACT_STATES.has(candidateState) ? candidateState : 'unknown';
  const rawValue = state === 'observed' || state === 'observed_zero' || state === 'blank'
    ? text(source?.value)
    : null;
  if (!date || rawValue === null) return { state, value: rawValue };
  const parsed = parseDate(rawValue);
  return parsed ? { state, value: parsed } : { state: 'unknown', value: null };
}

function cancellationStatus(value: unknown): CancellationModuleStatus {
  const source = record(value);
  const outcome = typeof source?.outcome === 'string' && /^[a-z][a-z0-9_]{1,80}$/.test(source.outcome)
    ? source.outcome
    : null;
  const issue = typeof source?.issue === 'string' && /^[A-Z0-9_]{2,100}$/.test(source.issue)
    ? source.issue
    : null;
  return { outcome, issue };
}

/** Pure allowlist projection; raw shallow/record data and all party/money fields stay private. */
export function projectCloudCancellationPreview(
  request: PaneStayFindInput,
  raw: unknown,
): HmsCloudCancellationPreviewResult {
  const root = record(raw);
  const moduleStatus = cancellationStatus(root);
  const observedAt = text(root?.observedAt);
  const failure = (
    outcome: CancellationPreviewFailureOutcome,
    reason: string | null = moduleStatus.issue,
  ): HmsCloudCancellationPreviewResult => ({
    outcome, source: 'hms_cloud_cancellation_preflight', moduleStatus, observedAt, reason,
  });
  const confirmation = typeof request.confirmation === 'string' ? request.confirmation.trim() : '';
  if (!/^\d+-\d+$/.test(confirmation) || confirmation.length > 128 ||
      (request.arrival !== undefined && !realDay(request.arrival))) {
    return failure('refused_input_invalid', 'CONFIRMATION_OR_ARRIVAL_INVALID');
  }
  if (!root) return failure('execution_failure', 'CANCELLATION_PREVIEW_RESULT_INVALID');
  if (root.outcome !== 'prepared_for_human_review') {
    if (root.outcome === 'input_gap') return failure('refused_input_invalid');
    if (root.outcome === 'target_unverified') return failure('target_unverified');
    if (root.outcome === 'refused') return failure('refused_preview_unavailable');
    if (root.outcome === 'fee_dialog_pending' || root.outcome === 'unexpected_dialog') {
      return failure('refused_preview_unavailable');
    }
    if (root.outcome === 'read_failed' && moduleStatus.issue === 'CONFIRMATION_HINT_MISMATCH') {
      return failure('refused_identity_mismatch', 'CONFIRMATION_HINT_MISMATCH');
    }
    if (root.outcome === 'read_failed' || root.outcome === 'execution_failure') {
      return failure('execution_failure');
    }
    return failure('target_unverified', moduleStatus.issue ?? 'CANCELLATION_PREVIEW_NOT_PREPARED');
  }

  const target = record(root.target);
  const stay = record(root.stay);
  const roomScope = record(root.roomScope);
  const policy = record(root.policy);
  const fee = record(root.fee);
  const action = record(root.action);
  const status = cancellationFact(stay?.status);
  const arrivalDate = cancellationFact(stay?.arrivalDate, true);
  const departureDate = cancellationFact(stay?.departureDate, true);
  if (target?.confirmation !== confirmation || target.verified !== true ||
      roomScope?.requested !== 'unspecified' || roomScope.state !== 'unresolved' || roomScope.complete !== false ||
      policy?.state !== 'unknown' || fee?.state !== 'unknown_precommit' || fee.amount !== null || fee.currency !== null ||
      action?.actor !== 'human' || action.cancellationStarted !== false || action.commitAvailable !== false) {
    return failure('target_unverified', 'CANCELLATION_PREVIEW_SHAPE_UNVERIFIED');
  }
  if (request.arrival && arrivalDate.state !== 'observed') {
    return failure('target_unverified', 'REQUESTED_ARRIVAL_NOT_VERIFIED');
  }
  if (request.arrival && arrivalDate.value !== request.arrival) {
    return failure('refused_identity_mismatch', 'REQUESTED_ARRIVAL_MISMATCH');
  }
  return {
    outcome: 'prepared_for_human_review',
    source: 'hms_cloud_cancellation_preflight',
    moduleStatus,
    reason: null,
    target: { confirmation, verified: true },
    stay: { status, arrivalDate, departureDate },
    roomScope: { requested: 'unspecified', state: 'unresolved', complete: false },
    policy: { state: 'unknown' },
    fee: { state: 'unknown_precommit', amount: null, currency: null },
    action: { actor: 'human', cancellationStarted: false, commitAvailable: false },
    observedAt,
  };
}

function supportedCenturionTarget(target: HmsReadTarget): boolean {
  const expected = CENTURION_HMS_READ_TARGET;
  return Boolean(target) && target.propertyCode === expected.propertyCode &&
    target.secretId === expected.secretId && target.browserSlot === expected.browserSlot &&
    target.origin === expected.origin && target.installationEnvName === expected.installationEnvName;
}

/** Uses a runtime-restricted session; it exposes only exact read then pure cancellation preparation. */
export async function runCloudCancellationPreview(input: CloudCancellationPreviewRunInput): Promise<unknown> {
  if (!supportedCenturionTarget(input.target)) {
    return { outcome: 'target_unverified', issue: 'CLOUD_READ_TARGET_UNSUPPORTED' };
  }
  const sessionUrl = new URL('../../tooling/hms-cloud/cancellation-preflight-session.mjs', import.meta.url);
  const module = await import(sessionUrl.href) as {
    withCancellationPreflightSession: <T>(
      operation: (session: { runTool: (request: Record<string, unknown>) => Promise<unknown> }) => Promise<T>,
      options?: { signal?: AbortSignal },
    ) => Promise<T>;
  };
  return module.withCancellationPreflightSession(async ({ runTool }) => {
    const read = await runTool({
      tool: 'read',
      confirmation: input.request.confirmation,
      ...(input.request.arrival ? { arrivalDate: input.request.arrival } : {}),
      view: 'record',
    });
    if (record(read)?.outcome !== 'ok') return read;
    return runTool({ tool: 'prepareCancellation', requestedScope: 'unspecified' });
  }, { signal: input.signal });
}
