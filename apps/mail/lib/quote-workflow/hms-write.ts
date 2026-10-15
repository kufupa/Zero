import { formatStayDate } from './amend-find';

/**
 * The HMS write as the approve and review cards see it (U18). The wire types mirror hmsWriteStateOf and the hmsApproval
 * procedures on the server, which decide every outcome. This file only derives what each card shows from them. The types
 * are hand-written, as in the other *FromTrpc binds, so the mail app does not import server code.
 */

export type HmsWriteEvidence = { eventId: string; name: string; expired: boolean };

export type HmsWriteView = {
  status: string;
  /** The values she is approving: the stored state without the snapshot. */
  form: Record<string, unknown>;
  /** Digest of the stored form. Approve sends it back, so the server refuses values this card did not show. */
  formDigest: string;
  /** Display values of the HMS snapshot, keyed like the form. Null when none were stored. */
  before: Record<string, unknown> | null;
  snapshot: { readAt: string; stale: boolean } | null;
  grant: { grantId: string; consumed: boolean; fingerprintMatches: boolean } | null;
  run: {
    runId: string;
    state: string;
    failureClass: string | null;
    lastError: string | null;
    evidence: HmsWriteEvidence[];
    reviewed: 'ok' | 'flag' | null;
  } | null;
  needsCheck: boolean;
};

export type HmsApproved = { grantId: string; runId: string; hmsReadAt: string; expiresAt: string };

export type HmsReviewed = { runId: string; status: 'done' | 'needs_you' };

/** hmsApproval.reread: the fresh HMS read is stored as the snapshot, or the reason it was not. */
export type HmsReread =
  | { status: 'stored'; readAt: string }
  | { status: 'refused'; reason: string };

export type HmsEvidenceReply =
  | { status: 'ok'; dataUrl: string }
  | { status: 'unavailable'; reason: string };

/** A review names the run the card showed. The server refuses it once a newer write has run. */
export type HmsReviewInput =
  | { workItemId: string; runId: string; decision: 'ok' }
  | { workItemId: string; runId: string; decision: 'flag'; note: string };

export type HmsApprovalClient = {
  writeState: (input: { workItemId: string }) => Promise<HmsWriteView>;
  approve: (input: { workItemId: string; formDigest: string }) => Promise<HmsApproved>;
  review: (input: HmsReviewInput) => Promise<HmsReviewed>;
  resolveNeedsCheck: (input: { workItemId: string; note: string }) => Promise<unknown>;
  reread: (input: { workItemId: string }) => Promise<HmsReread>;
  evidence: (input: { workItemId: string; eventId: string }) => Promise<HmsEvidenceReply>;
};

type TrpcHmsApprovalRoutes = {
  hmsApproval?: {
    writeState?: { query: HmsApprovalClient['writeState'] };
    approve?: { mutate: HmsApprovalClient['approve'] };
    review?: { mutate: HmsApprovalClient['review'] };
    resolveNeedsCheck?: { mutate: HmsApprovalClient['resolveNeedsCheck'] };
    reread?: { mutate: HmsApprovalClient['reread'] };
    evidence?: { query: HmsApprovalClient['evidence'] };
  };
};

/** Binds the hmsApproval routes off a tRPC client. Null when one is missing, so no write card shows. */
export function hmsApprovalFromTrpc(trpc: unknown): HmsApprovalClient | null {
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const routes = (trpc as TrpcHmsApprovalRoutes).hmsApproval;
  const writeState = routes?.writeState;
  const approve = routes?.approve;
  const review = routes?.review;
  const resolve = routes?.resolveNeedsCheck;
  const reread = routes?.reread;
  const evidence = routes?.evidence;
  if (!writeState || !approve || !review || !resolve || !reread || !evidence) return null;
  return {
    writeState: (input) => writeState.query(input),
    approve: (input) => approve.mutate(input),
    review: (input) => review.mutate(input),
    resolveNeedsCheck: (input) => resolve.mutate(input),
    reread: (input) => reread.mutate(input),
    evidence: (input) => evidence.query(input),
  };
}

/** How often the card re-reads a write that is still running. */
export const HMS_WRITE_POLL_MS = 4000;
/** How often a hidden card (no stored write yet, on mail that is not an amend) checks for one prepared meanwhile. */
export const HMS_WRITE_IDLE_POLL_MS = 30_000;
/** The note a flag or a needs-check takes. The server bounds it the same way. */
export const HMS_NOTE_MIN = 3;
export const HMS_NOTE_MAX = 500;

export const HMS_WRITE_COPY = {
  heading: 'Booking in HMS',
  loading: 'Loading the HMS write…',
  loadFailed: 'Nava could not load this write.',
  retry: 'Try again',
  running: 'Nava is working through these values. This can take a minute.',
  written: 'Written in HMS. Check the screenshots against the values, then confirm or flag.',
  partial: 'Confirmed in HMS: the screenshots below. Check them, then confirm or flag.',
  stopped: 'Nothing was confirmed in HMS. Check HMS before you approve again.',
  noChange: 'No values change in HMS.',
  approve: 'Approve these values',
  approveAgain: 'Approve again',
  approved: 'Approved. Nava will write these values in HMS.',
  changed: 'Changed since approval — approve again',
  rereadFirst:
    'Re-read HMS first. The last read of this booking is missing or more than 30 minutes old.',
  reread: 'Re-read HMS',
  rereadFailed: 'Nava could not read HMS again. Try again.',
  rereading: 'Reading the booking in HMS again…',
  rereadDone: 'HMS read again. Check the values, then approve again.',
  needsCheckIntro:
    'Nava cannot tell what HMS holds now. Check the booking in HMS, then say what you checked.',
  checkLabel: 'What did you check in HMS?',
  checkButton: 'I checked in HMS',
  checkSaved: 'Check saved.',
  noteNeeded: 'Say what you checked in HMS first.',
  reviewLabel: 'What is wrong? A note is needed to flag.',
  reviewOk: 'Review OK',
  flag: 'Flag',
  reviewedOk: 'Reviewed OK. This item is done.',
  flagged: 'Flagged. This item is back in Needs you.',
  flagNoteNeeded: 'Add a note saying what is wrong before you flag this write.',
  rereadNeeded: 'HMS was not read again. Re-read HMS before you approve.',
  changedQueued: 'The values changed after you approved them, so the queued write will not run.',
  expired: 'Screenshots expired. HMS screenshots are kept for 90 days.',
  someExpired: 'Some screenshots expired and are no longer shown.',
} as const;

// Non-terminal run states, as the server lists them (NONTERMINAL_AI_RUN_STATES). The rest end a run.
const IN_FLIGHT = new Set(['queued', 'claimed', 'running', 'retry_wait']);
const RUN_LABEL: Record<string, string> = {
  queued: 'Queued',
  claimed: 'Running',
  running: 'Running',
  retry_wait: 'Retrying',
};

const NEEDS_CHECK_REASON: Record<string, string> = {
  hms_changed: 'HMS changed after Nava read the booking. Nothing was written.',
  form_changed: 'The values changed after you approved them. Nothing was written.',
  reread_failed: 'Nava could not read HMS again before saving. Nothing was written.',
  LEASE_LOST: 'Nava lost its hold on the write, so the outcome is not known.',
};

const STOP_REASON: Record<string, string> = {
  POLICY_BLOCK: 'Nava is not allowed to write this kind of change yet.',
  AUTH: 'Nava could not sign in to HMS.',
  RUN_DEADLINE: 'The write ran out of time.',
  HMS_LOCK_BUSY: 'HMS was busy with another change.',
  TRANSIENT_NETWORK: 'A connection problem stopped the write.',
  PROPERTY_MISMATCH: 'The HMS property did not match the booking.',
  SCHEMA_DRIFT: 'The HMS screen changed, so Nava stopped.',
};

const REFUSAL_COPY: Record<string, string> = {
  not_found: 'This item is no longer here. Reopen the email and try again.',
  not_open: 'This item is already closed.',
  source_mail_missing: 'Nava cannot find the email this item came from.',
  write_in_flight: 'A write for this item is still running. Wait for it to finish.',
  needs_check_open: 'Check HMS first. The last write needs a check.',
  snapshot_missing: 'Re-read HMS first.',
  snapshot_stale: 'Re-read HMS first. The last read is more than 30 minutes old.',
  no_grant: 'Approve the values first.',
  state_changed: 'Changed since approval — approve again.',
  already_consumed: 'This approval was already used. Approve again.',
  lease_lost: 'Nava lost its hold on the write. Check HMS before you approve again.',
  no_needs_check: 'Nothing needs a check.',
  note_required: 'Add a note first.',
  no_executed_write: 'Nothing was written, so there is nothing to review.',
  already_reviewed: 'This write is already reviewed.',
  form_outdated: 'The values changed since this card loaded. Check them, then approve again.',
  run_changed: 'Another write ran since this one loaded. Check the latest write, then review it.',
};

/** The words for a refused procedure. The server sends the refusal name as the error message. */
export function refusalCopy(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  return REFUSAL_COPY[message] ?? 'Nava could not do that. Try again.';
}

type Run = NonNullable<HmsWriteView['run']>;

/** True when the work item holds an HMS write: an action form (attach, cancel) or a write run. */
export function isStoredWrite(view: Pick<HmsWriteView, 'form' | 'run'>): boolean {
  return view.run !== null || typeof view.form.action === 'string';
}

/**
 * Where the write is, and what the cards offer. `message` is the one line the card shows as its status.
 * `approve` opens the approve section, `review` the review card. Approval is shut while a run is moving, while a
 * needs-check is open, and while an executed write waits for review.
 */
export type WritePhase = 'idle' | 'running' | 'written' | 'partial' | 'stopped' | 'needs_check';

export type WriteStatus = {
  phase: WritePhase;
  message: string | null;
  review: boolean;
  approve: boolean;
  /** The HMS read is missing (null snapshot) or older than 30 minutes. Approval waits for a fresh read. */
  reread: 'missing' | 'stale' | null;
  /** The form changed after the latest approval. */
  changed: boolean;
  reviewed: 'ok' | 'flag' | null;
};

function needsCheckWords(run: Run): string {
  return NEEDS_CHECK_REASON[run.lastError ?? ''] ?? 'The outcome is not known. Check HMS.';
}

function stopWords(run: Run): string {
  if (run.state === 'superseded' && run.failureClass == null) {
    return 'A newer approval replaced this write.';
  }
  return STOP_REASON[run.failureClass ?? ''] ?? 'Nava stopped the write.';
}

export function writeStatusOf(view: HmsWriteView): WriteStatus {
  const run = view.run;
  const closed = view.status === 'done' || view.status === 'dismissed';
  const base = {
    reread:
      view.snapshot === null
        ? ('missing' as const)
        : view.snapshot.stale
          ? ('stale' as const)
          : null,
    changed: Boolean(view.grant && !view.grant.fingerprintMatches),
    reviewed: run?.reviewed ?? null,
  };
  if (!run) {
    return { ...base, phase: 'idle', message: null, review: false, approve: !closed };
  }
  if (IN_FLIGHT.has(run.state)) {
    // A queued write whose form changed can never run (the server refuses its approval). Approving again replaces it.
    if (run.state === 'queued' && base.changed) {
      return {
        ...base,
        phase: 'running',
        message: HMS_WRITE_COPY.changedQueued,
        review: false,
        approve: !closed,
      };
    }
    const label = RUN_LABEL[run.state] ?? 'Running';
    return {
      ...base,
      phase: 'running',
      message: `${label} in HMS. ${HMS_WRITE_COPY.running}`,
      review: false,
      approve: false,
    };
  }
  if (view.needsCheck) {
    return {
      ...base,
      phase: 'needs_check',
      message: needsCheckWords(run),
      review: false,
      approve: false,
    };
  }
  if (run.state === 'succeeded') {
    return {
      ...base,
      phase: 'written',
      message: HMS_WRITE_COPY.written,
      review: true,
      // A form edited after the write was never written: review OK is refused, so approving again is offered.
      approve: !closed && (base.reviewed === 'flag' || base.changed),
    };
  }
  const reason = stopWords(run);
  if (run.evidence.length > 0) {
    return {
      ...base,
      phase: 'partial',
      message: `Stopped part way. ${reason} ${HMS_WRITE_COPY.partial}`,
      review: true,
      approve: !closed && (base.reviewed === 'flag' || base.changed),
    };
  }
  return {
    ...base,
    phase: 'stopped',
    message: `${reason} ${HMS_WRITE_COPY.stopped}`,
    review: false,
    approve: !closed,
  };
}

export type WriteRow = { key: string; label: string; before: string; after: string };

const NOT_READ = 'Not read';
const NONE = 'None';
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const BOARD_LABELS: Record<string, string> = {
  room_only: 'Room only',
  bb: 'Bed & breakfast',
  dinner_bb: 'Dinner, bed & breakfast',
};
const LEAF_LABELS: Record<string, string> = {
  arrival: 'Arrival',
  departure: 'Departure',
  count: 'Rooms',
  adults: 'Adults',
  childAges: 'Child ages',
  roomType: 'Room type',
  board: 'Board',
  removed: 'Removed',
};

/** Scalar leaves of a nested form, keyed by dotted path. Arrays of scalars are one leaf. */
function leavesOf(
  value: unknown,
  prefix = '',
  out = new Map<string, unknown>(),
): Map<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) leavesOf(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  if (prefix) out.set(prefix, value);
  return out;
}

function leafName(key: string): string {
  return (key.split('.').pop() ?? key).replace(/\[[^\]]*\]$/, '');
}

function scalarText(value: unknown): string {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

function valueText(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return NONE;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length > 0 ? value.map(scalarText).join(', ') : NONE;
  const text = scalarText(value);
  if (leafName(key) === 'board') return BOARD_LABELS[text] ?? text;
  return ISO_DAY.test(text) ? formatStayDate(text) : text;
}

function humanize(name: string): string {
  const spaced = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** "Arrival", or "Stay 2: Arrival" when the form holds more than one stay, so the rows say which stay they are. */
function labelsOf(keys: readonly string[]): Map<string, string> {
  const stayNumbers = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const key of keys) {
    const stay = /^stays[.[]([^.\]]+)/.exec(key)?.[1];
    if (stay && !stayNumbers.has(stay)) stayNumbers.set(stay, stayNumbers.size + 1);
    const name = LEAF_LABELS[leafName(key)] ?? humanize(leafName(key));
    labels.set(key, stay ? `Stay ${stayNumbers.get(stay)}: ${name}` : name);
  }
  return labels;
}

/** Leaves that name the guest or their booking (a confirmation, a name, a file name). The preview gate masks them. */
const GUEST_LEAF = /^confirmation$|name$|email$|phone$|^guest/i;

/** True when a write row shows a guest detail, so the pane marks it data-pii. */
export function isGuestWriteRow(key: string): boolean {
  return GUEST_LEAF.test(leafName(key));
}

/**
 * The values the write changes, as before → after rows. A value that is the same before and after is left out. With no
 * stored read, the before side reads "Not read", so approval still shows what would be written.
 */
export function writeRowsOf(view: Pick<HmsWriteView, 'form' | 'before'>): WriteRow[] {
  const after = leavesOf(view.form);
  const before = view.before ? leavesOf(view.before) : null;
  const labels = labelsOf([...after.keys()]);
  const rows: WriteRow[] = [];
  for (const [key, value] of after) {
    const beforeText =
      before === null ? NOT_READ : before.has(key) ? valueText(key, before.get(key)) : NONE;
    const afterText = valueText(key, value);
    if (beforeText !== afterText) {
      rows.push({ key, label: labels.get(key) ?? key, before: beforeText, after: afterText });
    }
  }
  return rows;
}
