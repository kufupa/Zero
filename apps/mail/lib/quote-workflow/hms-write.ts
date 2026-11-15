import { formatStayDate } from './amend-find';
import { inMailbox } from '@/lib/mail/mail-cache-scope';
import { cancelChargeClientFromTrpc, type CancelChargeClient, type CancelRun } from './amend-cancel';
import type { PropertySwitch } from '@/lib/reservation-workflow/types';
import { knownFailureCopy } from '@/lib/reservation-workflow/failure-copy';

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
    cancelNotice?: string;
    evidence: HmsWriteEvidence[];
    reviewed: 'ok' | 'flag' | null;
  } | null;
  needsCheck: boolean;
  filingAvailable?: boolean;
  cancelAvailable?: boolean;
  manualResolve?: boolean;
};

export type HmsApproved = { grantId: string; runId: string; hmsReadAt: string; expiresAt: string };
export type HmsPreparedReceipt = { preparedRef: string; expectedRevision: number; generationId: string;
  expiresAtIso: string; warnings: string[] };

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

export type HmsCancelPreviewInput = { workItemId: string; formDigest: string; confirmation: string; arrival: string };
export type HmsCancelGoInput = HmsCancelPreviewInput & { reason: string; previewDigest: string; cancellationNote: string };
type CancelSource = { threadId: string; messageId: string; sourceHash: string };

export type HmsApprovalClient = {
  writeState: (input: { workItemId: string }) => Promise<HmsWriteView>;
  approve: (input: { workItemId: string; formDigest: string; preparedRef?: string; expectedRevision?: number }) => Promise<HmsApproved>;
  review: (input: HmsReviewInput) => Promise<HmsReviewed>;
  resolveNeedsCheck: (input: { workItemId: string; note: string }) => Promise<unknown>;
  reread: (input: { workItemId: string }) => Promise<HmsReread>;
  evidence: (input: { workItemId: string; eventId: string }) => Promise<HmsEvidenceReply>;
  previewCancel?: (input: HmsCancelPreviewInput) => Promise<CancelRun>;
  approveCancel?: (input: HmsCancelGoInput) => Promise<CancelRun>;
  cancelCharge?: CancelChargeClient;
};

type MailboxOptions = NonNullable<ReturnType<typeof inMailbox>>;
type MailboxCall<T> = T extends (input: infer Input) => infer Result
  ? (input: Input & { internetMessageId: string; selectedSource?: CancelSource }, options: MailboxOptions) => Result
  : never;

type TrpcHmsApprovalRoutes = {
  hmsApproval?: {
    writeState?: { query: (input: { workItemId: string; internetMessageId: string;
      selectedSource?: CancelSource; cancelSource?: CancelSource; propertySwitch?: PropertySwitch },
      options: MailboxOptions) => Promise<HmsWriteView> };
    approve?: { mutate: (input: { workItemId: string; formDigest: string; internetMessageId: string;
      selectedSource?: CancelSource; propertySwitch?: PropertySwitch; preparedRef?: string; expectedRevision?: number;
      cancel?: Omit<HmsCancelGoInput, 'workItemId' | 'formDigest'> & { source: CancelSource } },
      options: MailboxOptions) => Promise<HmsApproved | CancelRun> };
    previewCancel?: { mutate: (input: HmsCancelPreviewInput & { source: CancelSource; internetMessageId: string },
      options: MailboxOptions) => Promise<CancelRun> };
    review?: { mutate: MailboxCall<HmsApprovalClient['review']> };
    resolveNeedsCheck?: { mutate: MailboxCall<HmsApprovalClient['resolveNeedsCheck']> };
    reread?: { mutate: MailboxCall<HmsApprovalClient['reread']> };
    evidence?: { query: MailboxCall<HmsApprovalClient['evidence']> };
  };
};

/** Pin every request to the mailbox and selected email the card belongs to. */
export function hmsApprovalFromTrpc(
  trpc: unknown, transportId: string | null, internetMessageId: string | null, source: CancelSource | null = null,
  propertySwitch?: PropertySwitch,
): HmsApprovalClient | null {
  const mailbox = inMailbox(transportId);
  if (!mailbox || !internetMessageId?.trim() || !trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const routes = (trpc as TrpcHmsApprovalRoutes).hmsApproval;
  const writeState = routes?.writeState;
  const approve = routes?.approve;
  const review = routes?.review;
  const resolve = routes?.resolveNeedsCheck;
  const reread = routes?.reread;
  const evidence = routes?.evidence;
  const previewCancel = routes?.previewCancel;
  if (!writeState || !approve || !review || !resolve || !reread || !evidence) return null;
  const selectedSource = source && source.threadId.trim() && source.messageId.trim() && /^[a-f0-9]{64}$/.test(source.sourceHash)
    ? { threadId: source.threadId, messageId: source.messageId, sourceHash: source.sourceHash } : null;
  const selection = selectedSource ? { selectedSource } : {};
  const property = propertySwitch ? { propertySwitch } : {};
  const charge = cancelChargeClientFromTrpc(trpc, transportId, selectedSource ?? undefined, internetMessageId);
  return {
    writeState: async (input) => {
      const view = await writeState.query({ ...input, internetMessageId, ...selection, ...property }, mailbox);
      if (view.form.action !== 'cancel' || view.cancelAvailable === undefined) return view;
      if (!selectedSource) throw new Error('cancel_source_unavailable');
      return writeState.query({ ...input, internetMessageId, ...selection, cancelSource: selectedSource, ...property }, mailbox);
    },
    approve: (input) => approve.mutate({ ...input, internetMessageId,
      ...(selectedSource ? { selectedSource } : {}), ...property }, mailbox) as Promise<HmsApproved>,
    review: (input) => review.mutate({ ...input, internetMessageId, ...selection }, mailbox),
    resolveNeedsCheck: (input) => resolve.mutate({ ...input, internetMessageId, ...selection }, mailbox),
    reread: (input) => reread.mutate({ ...input, internetMessageId, ...selection }, mailbox),
    evidence: (input) => evidence.query({ ...input, internetMessageId, ...selection }, mailbox),
    ...(charge ? { cancelCharge: charge } : {}),
    ...(selectedSource && previewCancel ? {
      previewCancel: (input: HmsCancelPreviewInput) => previewCancel.mutate({ ...input, source: selectedSource, internetMessageId }, mailbox),
      approveCancel: ({ workItemId, formDigest, ...cancel }: HmsCancelGoInput) =>
        approve.mutate({ workItemId, formDigest, internetMessageId, selectedSource,
          cancel: { ...cancel, source: selectedSource } }, mailbox) as Promise<CancelRun>,
    } : {}),
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
  reviewedOk: 'HMS write reviewed.',
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
  confirmed_hold_unsettled: 'HMS lists the document by its code and name. The write still needs a safety check before another upload.',
  cancel_penalty_pending: 'A cancellation penalty is pending. Check HMS before anything else.',
  cancel_unconfirmed: 'HMS may have cancelled this booking. Check HMS before trying again.',
  cancel_dispatch_unresolved: 'HMS may have cancelled this booking. Check HMS before trying again.',
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
  source_mail_changed: 'This write belongs to another email. Reopen the selected email.',
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
  amend_save_unavailable: 'Nava cannot save this change yet. Complete it in HMS.',
  amend_reconciliation_required: 'The previous HMS outcome needs a verified readback before another change.',
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
  return NEEDS_CHECK_REASON[run.lastError ?? ''] ?? knownFailureCopy(run.failureClass, true) ?? 'The outcome is not known. Check HMS.';
}

function stopWords(run: Run): string {
  if (run.state === 'superseded' && run.failureClass == null) {
    return 'A newer approval replaced this write.';
  }
  return knownFailureCopy(run.failureClass, true) ?? STOP_REASON[run.failureClass ?? ''] ?? 'Nava stopped the write.';
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
      message: view.form.action === 'cancel' ? 'Cancelled in HMS. Check the screenshots.' : HMS_WRITE_COPY.written,
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

export type WriteRow = { key: string; label: string; before: string; after: string; displayOnly?: boolean };

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
  children: 'Children',
  childAges: 'Child ages',
  roomType: 'Room type',
  ratePlan: 'Rate plan',
  retainRates: 'Retain current rates',
  mealPlan: 'Board',
  removed: 'Removed',
  confirmation: 'Booking',
  firstName: 'Guest first name',
  lastName: 'Guest surname',
  documentName: 'Document',
  cmsSend: 'Send confirmation',
  cmsMessageId: 'CMS message',
  cmsRecipient: 'Confirmation recipient',
  guestEmail: 'Guest email',
  bookerName: 'Booker name',
  bookerContact: 'Booker contact',
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
  if (leafName(key) === 'mealPlan' || leafName(key) === 'board') return BOARD_LABELS[text] ?? text;
  if (leafName(key) === 'retainRates' && (text === 'yes' || text === 'no')) return text === 'yes' ? 'Yes' : 'No';
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
const GUEST_LEAF = /^confirmation$|name$|email$|phone$|contact$|^guest|^cmsRecipient$/i;

/** True when a write row shows a guest detail, so the pane marks it data-pii. */
export function isGuestWriteRow(key: string): boolean {
  return GUEST_LEAF.test(leafName(key));
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Display actual saved amounts and native availability quotes with their own labels. */
function retainedPriceRows(form: Record<string, unknown>): WriteRow[] {
  const prices = record(record(form.cloudAmend)?.approvedPrices);
  const currency = prices?.currency;
  if (prices?.version !== 2 || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return [];
  const rows: WriteRow[] = [];
  const formatted = (cents: unknown, unit: unknown = currency): string | null => {
    if (typeof unit !== 'string' || !/^[A-Z]{3}$/.test(unit) ||
        typeof cents !== 'string' || !/^\d{1,17}$/.test(cents)) return null;
    const padded = cents.replace(/^0+(?=\d)/, '').padStart(3, '0');
    return `${unit} ${padded.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${padded.slice(-2)}`;
  };
  const add = (key: string, label: string, value: string | null) => {
    if (!value) return;
    rows.push({ key: `cloudAmend.approvedPrices.${key}`, label, before: value, after: value, displayOnly: true });
  };
  add('total', 'HMS stay total', formatted(prices.totalCents));
  add('average', 'HMS average nightly rate', formatted(prices.averageCents));
  if (Array.isArray(prices.options)) for (const [index, raw] of prices.options.entries()) {
    const option = record(raw);
    if (!option || typeof option.ratePlan !== 'string' || typeof option.roomType !== 'string' ||
        !Array.isArray(option.nightly)) continue;
    const nights = option.nightly.map(record).filter((night): night is Record<string, unknown> => night !== null)
      .map((night) => typeof night.date === 'string' && formatted(night.amountCents, option.currency)
        ? `${night.date}: ${formatted(night.amountCents, option.currency)}` : null).filter(Boolean);
    if (nights.length) add(`option.${index}`, `${option.ratePlan} · ${option.roomType}`, nights.join(', '));
  }
  return rows;
}

export function cloudAmendApprovalHasPrices(form: Record<string, unknown>): boolean {
  return !(form.action === 'amend' && record(form.cloudAmend)) ||
    retainedPriceRows(form).some((row) => row.key === 'cloudAmend.approvedPrices.total');
}

/** The saved-record form also carries these unchanged values; show them before Go. */
function preservedAmendRows(form: Record<string, unknown>): WriteRow[] {
  const value = record(record(form.cloudAmend)?.preserved);
  if (!value || !(value.bookingAgency === null || typeof value.bookingAgency === 'string') ||
      !(value.organization === null || typeof value.organization === 'string')) return [];
  return [
    ['bookingAgency', 'Travel agency', value.bookingAgency || NONE],
    ['organization', 'Company', value.organization || NONE],
  ].map(([key, label, text]) => ({ key: `cloudAmend.preserved.${key}`, label, before: text, after: text, displayOnly: true }));
}

/**
 * The values the write changes, as before → after rows. Explicit rate and confirmation choices remain visible even
 * when unchanged. With no stored read, the before side reads "Not read".
 */
export function writeRowsOf(view: Pick<HmsWriteView, 'form' | 'before'>): WriteRow[] {
  // Only the reviewed amendment choices belong on this card. Source/native
  // digests and unrelated work-item state are not staff decisions.
  const cloudAmend = view.form.action === 'amend' && typeof view.form.cloudAmend === 'object' && view.form.cloudAmend !== null;
  const amendFields = record(view.form.fields);
  const shownFields = amendFields?.cmsSend === false
    ? Object.fromEntries(Object.entries(amendFields).filter(([key]) => key !== 'cmsMessageId' && key !== 'cmsRecipient'))
    : amendFields;
  const after = leavesOf(cloudAmend ? { fields: shownFields } : view.form);
  const filing = view.form.action === 'attach_document';
  const filingFields = new Set(['documentName', 'confirmation', 'lastName', 'arrival']);
  const before = view.before ? leavesOf(view.before) : null;
  const labels = labelsOf([...after.keys()]);
  const rows: WriteRow[] = [];
  for (const [key, value] of after) {
    if (filing && !filingFields.has(key)) continue;
    const beforeText =
      before === null ? NOT_READ : before.has(key) ? valueText(key, before.get(key)) : cloudAmend ? NOT_READ : NONE;
    const afterText = valueText(key, value);
    const amendChoice = cloudAmend && (key === 'fields.ratePlan' || key === 'fields.cmsSend' ||
      (amendFields?.cmsSend === true && (key === 'fields.cmsMessageId' || key === 'fields.cmsRecipient')));
    if (filing || beforeText !== afterText || amendChoice) {
      rows.push({ key, label: labels.get(key) ?? key, before: beforeText, after: afterText });
    }
  }
  if (cloudAmend) rows.push(...retainedPriceRows(view.form), ...preservedAmendRows(view.form));
  return rows;
}
