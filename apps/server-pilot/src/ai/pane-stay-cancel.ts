import { PANE_PAID_BOOKING_COPY, paneStayTransportIdFromOwner, paneWriteMode,
  type PaneSaveMode, type PaneStayLock, type PaneWriteMoneyState } from './pane-stay-save.js';
import { createHash } from 'node:crypto';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';
import type { HmsReadTarget } from '../hms/hms-read-target.js';
import type { PropertyCode } from '../hms/property-registry.js';
import type { CancelRequestBinding } from './pane-cloud-cancel.js';
import type { AmendPaymentStay } from './pane-stay-lookup.js';
const LAB_ARRIVAL_FLOOR = '2027-01-01';

export type PaneStayCancelMode = 'preview' | 'commit';

export type PaneStayCancelPreviewInput = CancelRequestBinding & { confirmation: string; arrival: string; propertyCode?: PropertyCode; workItemId?: string;
  source?: { threadId: string; messageId: string; sourceHash: string } };
export type PaneStayCancelCommitInput = PaneStayCancelPreviewInput & {
  reason: string;
  /** Digest the preview returned for this same stay. Absent means no preview was run. */
  previewDigest?: string;
  cancellationNote?: string;
};
// Owner scope of runs and grants: `${userId}:${transportId}`, the same string the save path uses.
// transportId from the route wins; a caller-supplied property never selects the hotel.
type OwnedInput<T> = T & { owner: string; transportId?: string; actorUserId?: string;
  sessionId?: string; sessionProfile?: 'legacy' | 'remote' };

export type PaneStayCancelResult = {
  outcome: string;
  statusBefore: string | null;
  statusAfter: string | null;
  reasons: string[];
  penaltyText: string | null;
  /** Facts supplied by HMS, without inferring whether a charge will be applied. */
  policyFacts?: string[];
  /** Operator-facing line for outcomes that need one (see PANE_CANCEL_MESSAGES), or a notice-window warning. */
  message: string | null;
  /** The arrival was a hint: HMS holds another date for this booking. Both dates are returned for the pane's text. */
  arrivalMismatch: boolean;
  requestedArrival: string | null;
  hmsArrival: string | null;
  /** PNG file names only. The files stay in the CLI run directory. Fetch the bytes with paneStayCancel.paneStayScreenshot({ runId, name }). */
  screenshots: string[];
  /** Screenshot directory id for paneStayScreenshot. Null when no CLI run wrote files. */
  runId: string | null;
  /** Set only when a preview finished as preview_ok. Commit sends it back with the same stay. */
  previewDigest: string | null;
  /** Public target details from the independently read native record, shown before staff Go. */
  previewStay?: { confirmation: string; firstName: string; lastName: string; arrival: string; departure: string; roomType: string;
    guarantee?: string; depositReceived?: string | null };
};

// Operator-facing text per outcome. cancel_unconfirmed: the status did not read Cancelled within 60 s after OK, but HMS
// may have applied the cancel, so the operator checks HMS before anything else.
// cancel_penalty_pending: a charge opened after the OK. It is needs check, so the operator reads the charge in HMS first.
export const PANE_CANCEL_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['cancel_unconfirmed', 'HMS may have cancelled this booking. Check HMS before trying again.'],
  [
    'cancel_penalty_pending',
    'A cancellation penalty is pending on this booking. Check HMS before anything else.',
  ],
  ['refused_not_unpaid', PANE_PAID_BOOKING_COPY],
]);

export function paneCancelMessage(outcome: string): string | null {
  return PANE_CANCEL_MESSAGES.get(outcome) ?? null;
}

export type PaneStayCancelSpawnInput = {
  mode: PaneStayCancelMode;
  confirmation: string;
  arrival: string;
  reason: string | null;
  /** True only in on mode. The approved worker admits the selected native guest. */
  allowRealGuest: boolean;
  /**
   * Commit only: the stay the write's approval was checked against. The CLI reads the record it opens again and refuses
   * (refused_stay_changed, nothing clicked) when any of these fields differ.
   */
  expectStay?: Record<string, unknown>;
  /** Required on the production spawn; tests that inject spawn may omit it. */
  target?: HmsReadTarget;
  /** Optional surname for the CLI header-search retry (`--last-name`). */
  lastName?: string;
};

/** The native cancellation preparation result. Screenshots are absolute paths. */
export type PaneStayCancelSpawnResult = {
  outcome: string;
  statusBefore: string | null;
  statusAfter: string | null;
  reasons: string[];
  penaltyText: string | null;
  arrivalMismatch?: boolean;
  requestedArrival?: string | null;
  hmsArrival?: string | null;
  screenshots: string[];
  /** Absolute directory the CLI wrote result.json and the PNGs to. Absent when no run wrote files. */
  runDir?: string;
  /** True once the reason dialog's OK was clicked. A failure after that leaves the cancel unconfirmed. */
  clickedOk?: boolean;
  /** Notice-window warning from the CLI. Absent or blank stays silent. */
  warning?: string | null;
};

export const paneStayCancelLoaders: {
  spawn: ((input: PaneStayCancelSpawnInput) => Promise<PaneStayCancelSpawnResult>) | null;
  lock: PaneStayLock | null;
  mode: (() => PaneSaveMode) | null;
  moneyState: (() => PaneWriteMoneyState) | null;
  /** Commit only. Tests inject a folio snapshot; production leaves this null and the approved Cloud worker re-reads. */
  folio: ((input: PaneStayCancelPreviewInput) => Promise<AmendPaymentStay | null>) | null;
} = {
  spawn: null,
  lock: null,
  mode: null,
  moneyState: null,
  folio: null,
};

// Cancel uses PANE_WRITE_CANCEL_*; create mode never enables it. Legacy SAVE still opens cancel when all five are unset.
export function paneStayCancelEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return (
    paneWriteMode('cancel', 'unpaid', env) !== 'off' || paneWriteMode('cancel', 'paid', env) !== 'off'
  );
}

function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Server-side input checks. The cancel input has no guest name, so in lab mode the Labtest identity is enforced by the
// CLI on the stay it opens (refused_not_lab). The 2027 floor is enforced here, before any browser work. On mode
// (allowRealGuest) real guests are allowed, so the floor does not apply.
export function checkCancelInput(
  input: PaneStayCancelPreviewInput,
  { allowRealGuest = false }: { allowRealGuest?: boolean } = {},
): 'refused_input_invalid' | 'refused_not_lab' | null {
  if (!/^\d+-\d+$/.test(input.confirmation) || !isRealIsoDate(input.arrival)) {
    return 'refused_input_invalid';
  }
  if (!allowRealGuest && input.arrival < LAB_ARRIVAL_FLOOR) return 'refused_not_lab';
  return null;
}

// sha256 of the stay as canonical JSON, keys in fixed order: {"arrival":...,"confirmation":...}.
// A commit must send back the digest of its own confirmation and arrival.
export function paneCancelDigest(stay: PaneStayCancelPreviewInput): string {
  const canonical = JSON.stringify({ arrival: stay.arrival, confirmation: stay.confirmation });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function refused(outcome: string): PaneStayCancelResult {
  return {
    outcome,
    statusBefore: null,
    statusAfter: null,
    reasons: [],
    penaltyText: null,
    message: paneCancelMessage(outcome),
    arrivalMismatch: false,
    requestedArrival: null,
    hmsArrival: null,
    screenshots: [],
    runId: null,
    previewDigest: null,
  };
}

async function runPaneStayCancel(
  mode: PaneStayCancelMode,
  input: OwnedInput<PaneStayCancelPreviewInput & { reason?: string; previewDigest?: string; cancellationNote?: string }>,
): Promise<PaneStayCancelResult> {
  if (!/^\d+-\d+$/.test(input.confirmation) || !isRealIsoDate(input.arrival)) return refused('refused_input_invalid');
  const reason = mode === 'commit' ? (input.reason ?? '').replace(/\s+/g, ' ').trim() : null;
  if (mode === 'commit' && (!reason || reason.startsWith('-'))) return refused('refused_reason_missing');
  const transportId = input.transportId ?? paneStayTransportIdFromOwner(input.owner);
  const resolved = paneStayHmsTargetForTransport(transportId, input.propertyCode);
  if (!resolved.ok) return refused('refused_unknown_transport');
  if (!input.transportId || !input.actorUserId || !input.workItemId || !input.source ||
      !input.sessionId || !input.sessionProfile || input.owner !== `${input.actorUserId}:${input.transportId}`) {
    return refused('refused_source_changed');
  }
  const cloud = await import('./pane-cloud-cancel.js');
  const context = { transportId: input.transportId, actorUserId: input.actorUserId, sessionId: input.sessionId,
    sessionProfile: input.sessionProfile, workItemId: input.workItemId, source: input.source,
    confirmation: input.confirmation, arrival: input.arrival, target: resolved.target, requestId: input.requestId,
    expectedSeq: input.expectedSeq, expectedExtractionId: input.expectedExtractionId };
  if (mode === 'preview') return cloud.previewCloudCancel(context);
  if (!input.previewDigest || !reason) return refused('cancel_preview_required');
  return cloud.commitCloudCancel({ ...context, reason, previewDigest: input.previewDigest,
    cancellationNote: input.cancellationNote });
}

export function previewCancel(
  input: OwnedInput<PaneStayCancelPreviewInput>,
): Promise<PaneStayCancelResult> {
  return runPaneStayCancel('preview', input);
}

export function commitCancel(
  input: OwnedInput<PaneStayCancelCommitInput>,
): Promise<PaneStayCancelResult> {
  return runPaneStayCancel('commit', input);
}
