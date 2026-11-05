import { AMEND_FIND_COPY, type ScreenshotInput, type ScreenshotReply } from './amend-find';
import { inMailbox } from '@/lib/mail/mail-cache-scope';

/**
 * Cancel from the pane for amend and cancel mail. Luna opens the HMS cancel screen through the
 * paneStayCancel routes: preview reads available reasons, commit cancels the booking.
 * This module holds the copy, the outcome mapping and the tRPC binding. The panel owns the UI state.
 */

export const AMEND_CANCEL_COPY = {
  preview: 'Preview cancellation',
  previewHint:
    'Nava checks the booking and available cancellation reasons. Nothing is cancelled.',
  footerPreview:
    'Nava can preview the cancellation for you. Nothing is cancelled until you press Cancel booking in HMS.',
  previewing: 'Nava is reading the cancel screen in HMS… (usually under a minute)',
  reasonLabel: 'Cancellation reason',
  reasonPlaceholder: 'Choose a reason',
  commit: 'Cancel booking in HMS',
  committing: 'Nava is cancelling the booking in HMS… (usually under a minute)',
  seeScreenshot: 'See what Nava saw in HMS',
  alreadyCancelled: 'This booking is already cancelled in HMS.',
  switchedOff: 'Cancelling from here is switched off for now.',
  testOnly: 'Cancelling from here only works on test bookings right now.',
  reasonRefused: 'HMS did not accept that reason. Pick another and try again.',
  previewAgain: 'Preview the cancellation again first.',
  unconfirmed: 'HMS may have cancelled this booking. Check HMS before trying again.',
  penaltyPending: 'A cancellation penalty is pending on this booking. Check HMS before anything else.',
  failed: "Nava couldn't finish in HMS. Check HMS yourself.",
} as const;

/** The plain HMS steps for cancelling by hand. */
export function cancelManualSteps(confirmation: string): string {
  return `Cancel it in HMS: open ${confirmation}, Actions → Cancel Reservation.`;
}

/** Shown when cancelling from the pane is off: says so, then gives the HMS steps. */
export function cancelSwitchedOffNote(confirmation: string): string {
  return `${AMEND_CANCEL_COPY.switchedOff} ${cancelManualSteps(confirmation)}`;
}

/** The ISO day at the start of a date, or null when it has none. */
export function isoDayOf(value: string | null | undefined): string | null {
  const match = /^\d{4}-\d{2}-\d{2}/.exec((value ?? '').trim());
  return match ? match[0] : null;
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** What HMS said about a cancellation fee, as one full sentence. */
export function cancelFeeSentence(penaltyText: string | null): string {
  const phrase = penaltyText ? `HMS says: ${penaltyText.trim()}` : 'Check any cancellation charge in HMS';
  return sentence(phrase);
}

export function cancelConfirmLine(input: {
  confirmation: string;
  guest: string;
  penaltyText: string | null;
  policyFacts?: string[];
}): string {
  return `Nava will cancel ${input.confirmation} for ${input.guest}. ${cancelFeeSentence(input.penaltyText)} This can't be undone from here.`;
}

// HMS charge text without a trailing full stop, so the copy does not end in two.
function chargeText(penaltyText: string): string {
  return penaltyText.trim().replace(/[.!?]+$/, '');
}

/** A warning does not establish whether HMS already changed the booking. */
export function cancellationChargeCopy(penaltyText: string | null): string {
  const instruction = 'Check the booking status and charge in HMS before taking further action.';
  if (!penaltyText) return `HMS showed a possible cancellation charge. ${instruction}`;
  return `HMS says: ${chargeText(penaltyText)}. ${instruction}`;
}

/** The note for a cancel attempt that did not go through. Commit reason refusals are handled by viewAfterCommit. */
export function cancelOutcomeNote(
  outcome: string,
  confirmation: string,
  penaltyText: string | null = null,
): string {
  switch (outcome) {
    case 'refused_flag_off':
      return cancelSwitchedOffNote(confirmation);
    case 'refused_legacy_cancel_unavailable':
      return `Nava cannot cancel ${confirmation} yet. Check any earlier HMS write before changing the booking.`;
    case 'refused_penalty':
      return cancellationChargeCopy(penaltyText);
    case 'refused_not_lab':
      return AMEND_CANCEL_COPY.testOnly;
    case 'refused_not_unpaid':
      return AMEND_SAVE_COPY.handleInHms;
    case 'refused_target_unverified':
      return 'Nava could not verify this booking in HMS. Check the booking before cancelling.';
    case 'refused_scope_unverified':
      return 'The booking may have linked rooms or reservations. Check the full scope in HMS.';
    case 'refused_lock_busy':
      return AMEND_FIND_COPY.busy;
    case 'refused_lock_unavailable':
      return AMEND_FIND_COPY.unreachable;
    case 'cancel_unconfirmed':
      return AMEND_CANCEL_COPY.unconfirmed;
    case 'cancel_penalty_pending':
      if (!penaltyText) return AMEND_CANCEL_COPY.penaltyPending;
      return `A cancellation penalty is pending on this booking: ${chargeText(penaltyText)}. Check HMS before anything else.`;
    default:
      return AMEND_CANCEL_COPY.failed;
  }
}

export function cancelledText(statusAfter: string | null, penaltyText: string | null = null): string {
  const done = `Cancelled in HMS – status now ${statusAfter ?? 'unknown'}`;
  // A reported charge is not proof of a posted fee.
  if (!penaltyText) return done;
  return `${done}. HMS shows a cancellation charge: ${chargeText(penaltyText)}. Check HMS and deal with that charge there.`;
}

export type CancelInput = { confirmation: string; arrival: string; workItemId?: string;
  source?: { threadId: string; messageId: string; sourceHash: string };
  requestId?: string; expectedSeq?: number; expectedExtractionId?: string };
/** The previewDigest of the preview that must come back with the commit. The server refuses without it. */
export type CancelCommitInput = CancelInput & { reason: string; previewDigest: string; cancellationNote?: string };

/** One paneStayCancel result. previewDigest is set only by a preview_ok, and a commit must send it back. */
export type CancelRun = {
  outcome: string;
  statusBefore: string | null;
  statusAfter: string | null;
  reasons: string[];
  penaltyText: string | null;
  policyFacts?: string[];
  screenshots: string[];
  runId: string | null;
  previewDigest: string | null;
  /** Notice-window warning from the cancel result, shown as a plain staff line. */
  message?: string | null;
  /** Details independently read from the native stay before staff approve cancellation. */
  previewStay?: { confirmation: string; firstName: string; lastName: string; arrival: string; departure: string;
    roomType: string; guarantee?: string; depositReceived?: string | null };
};

export type CancelChargeTarget = { workItemId: string; runId: string; confirmation: string; arrival: string };
export type CancelChargeState = { status: 'none' } | { status: 'pending' | 'submitted' | 'expired'; challengeId: string;
  dialogDigest: string; penaltyText: string; expiresAt: string; cancellationStatus?: 'Cancelled' };
export type CancelChargeClient = {
  pendingCharge: (input: CancelChargeTarget) => Promise<CancelChargeState>;
  acceptCharge: (input: CancelChargeTarget & { challengeId: string; dialogDigest: string }) =>
    Promise<{ status: 'accepted' | 'unavailable' }>;
};

export type CancelView =
  | { kind: 'idle'; note: string | null; run?: CancelRun }
  | { kind: 'previewing' }
  | { kind: 'ready'; run: CancelRun; reason: string; note: string | null }
  | { kind: 'checking'; run: CancelRun; reason: string }
  | { kind: 'committing'; run: CancelRun; reason: string }
  | { kind: 'done'; run: CancelRun; text: string };

export function viewAfterPreview(run: CancelRun, confirmation: string): CancelView {
  switch (run.outcome) {
    case 'preview_ok':
      if (run.previewDigest) {
        const note = typeof run.message === 'string' && run.message.trim() ? run.message.trim() : null;
        return { kind: 'ready', run, reason: '', note };
      }
      return { kind: 'idle', note: AMEND_CANCEL_COPY.failed, run };
    case 'already_cancelled':
      return { kind: 'done', run, text: AMEND_CANCEL_COPY.alreadyCancelled };
    default:
      return { kind: 'idle', note: cancelOutcomeNote(run.outcome, confirmation, run.penaltyText), run };
  }
}

export function viewAfterCommit(
  run: CancelRun,
  preview: CancelRun,
  confirmation: string,
): CancelView {
  switch (run.outcome) {
    case 'cancelled':
      return { kind: 'done', run, text: cancelledText(run.statusAfter, run.penaltyText) };
    case 'already_cancelled':
      return { kind: 'done', run, text: AMEND_CANCEL_COPY.alreadyCancelled };
    case 'cancel_penalty_pending':
      return { kind: 'done', run, text: cancelOutcomeNote(run.outcome, confirmation, run.penaltyText) };
    case 'refused_penalty':
      return { kind: 'done', run, text: cancellationChargeCopy(run.penaltyText) };
    case 'cancel_unconfirmed':
      return { kind: 'done', run, text: AMEND_CANCEL_COPY.unconfirmed };
    case 'cancel_queued':
      return { kind: 'committing', run, reason: '' };
    case 'refused_reason_missing':
      return { kind: 'ready', run: preview, reason: '', note: AMEND_CANCEL_COPY.reasonRefused };
    case 'cancel_preview_required':
    case 'cancel_digest_mismatch':
      return { kind: 'idle', note: AMEND_CANCEL_COPY.previewAgain };
    default:
      return { kind: 'idle', note: cancelOutcomeNote(run.outcome, confirmation, run.penaltyText), run };
  }
}

export type AmendCancelClient = {
  previewCancel: (input: CancelInput) => Promise<CancelRun>;
  commitCancel: (input: CancelCommitInput) => Promise<CancelRun>;
  paneStayScreenshot: (input: ScreenshotInput) => Promise<ScreenshotReply>;
};

type TrpcPaneStayCancelRoutes = {
  paneStayCancel?: {
    previewCancel?: { mutate: (input: CancelInput, options?: NonNullable<ReturnType<typeof inMailbox>>) => Promise<CancelRun> };
    commitCancel?: { mutate: (input: CancelCommitInput, options?: NonNullable<ReturnType<typeof inMailbox>>) => Promise<CancelRun> };
    paneStayScreenshot?: {
      query: (input: ScreenshotInput, options?: NonNullable<ReturnType<typeof inMailbox>>) => Promise<ScreenshotReply>;
    };
    pendingCharge?: { query: (input: CancelChargeTarget & { source: NonNullable<CancelInput['source']>;
      internetMessageId?: string }, options: NonNullable<ReturnType<typeof inMailbox>>) => Promise<CancelChargeState> };
    acceptCharge?: { mutate: (input: CancelChargeTarget & { source: NonNullable<CancelInput['source']>;
      internetMessageId?: string; challengeId: string; dialogDigest: string },
      options: NonNullable<ReturnType<typeof inMailbox>>) => Promise<{ status: 'accepted' | 'unavailable' }> };
  };
};

/** Pin both charge calls to the same mailbox and selected email as the first Go. */
export function cancelChargeClientFromTrpc(trpc: unknown, transportId: string | null,
  source: CancelInput['source'], internetMessageId?: string | null): CancelChargeClient | null {
  const mailbox = inMailbox(transportId);
  if (!mailbox || !source || !source.threadId.trim() || !source.messageId.trim() ||
      !/^[a-f0-9]{64}$/.test(source.sourceHash) || !trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const routes = (trpc as TrpcPaneStayCancelRoutes).paneStayCancel;
  if (!routes?.pendingCharge || !routes.acceptCharge) return null;
  const bound = { source: { ...source }, ...(internetMessageId?.trim() ? { internetMessageId: internetMessageId.trim() } : {}) };
  return {
    pendingCharge: (input) => routes.pendingCharge!.query({ ...input, ...bound }, mailbox),
    acceptCharge: (input) => routes.acceptCharge!.mutate({ ...input, ...bound }, mailbox),
  };
}

export type PaneWriteCapabilityReply = {
  create?: unknown;
  amendUnpaid?: unknown;
  amendPaid?: unknown;
  cancelUnpaid?: unknown;
  cancelPaid?: unknown;
};

export type PaneCapabilitiesReply = {
  paneSave?: boolean;
  paneSaveMode?: unknown;
  paneWrite?: PaneWriteCapabilityReply;
};

function writeSwitchOn(value: unknown): boolean {
  return value === 'lab' || value === 'on';
}

/** Cancel follows PANE_WRITE_CANCEL_*. Create mode never enables it. Old servers without paneWrite still use paneSave. */
export function canPreviewCancelFromCapabilities(
  capabilities: PaneCapabilitiesReply | null | undefined,
): boolean {
  if (capabilities?.paneWrite) {
    return writeSwitchOn(capabilities.paneWrite.cancelUnpaid) || writeSwitchOn(capabilities.paneWrite.cancelPaid);
  }
  return capabilities?.paneSave === true;
}

/** Amend follows PANE_WRITE_AMEND_*. Create mode never enables it. Old servers without paneWrite still need paneSave lab. */
export function canPreviewAmendFromCapabilities(
  capabilities: PaneCapabilitiesReply | null | undefined,
): boolean {
  if (capabilities?.paneWrite) {
    return (
      writeSwitchOn(capabilities.paneWrite.amendUnpaid) || writeSwitchOn(capabilities.paneWrite.amendPaid)
    );
  }
  return capabilities?.paneSave === true && capabilities.paneSaveMode === 'lab';
}

export const AMEND_SAVE_COPY = {
  preview: 'Preview',
  previewing: 'Nava is reading the change in HMS… (a few minutes)',
  commit: 'Approve',
  committing: 'Nava is saving the change in HMS… (a few minutes)',
  seeScreenshot: 'See what Nava saw in HMS',
  switchedOff: 'Changing this booking from here is switched off for now.',
  testOnly: 'Changing this booking from here only works on test bookings right now.',
  previewAgain: 'Preview the change again first.',
  unconfirmed: 'HMS may have saved this change. Check HMS before trying again.',
  failed: "Nava couldn't finish in HMS. Check HMS yourself.",
  done: 'Saved in HMS.',
  handleInHms: 'Paid or guaranteed booking: handle in HMS (Nava only changes unpaid bookings for now)',
} as const;

export type AmendPaymentClass = 'unpaid' | 'paid' | 'guaranteed' | 'unknown';

export type AmendPaymentStay = {
  status?: string | null;
  guaranteeType?: string | null;
  depositReceived?: string | null;
};

function paymentText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export function parseDepositReceived(value: unknown): number | null {
  const text = paymentText(value);
  if (!text) return null;
  const cleaned = text.replace(/[^\d.,-]/g, '');
  if (!cleaned) return null;
  const normalized = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(cleaned)
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned.includes(',') && !cleaned.includes('.')
      ? cleaned.replace(',', '.')
      : cleaned.replace(/,/g, '');
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function guaranteeKind(guaranteeType: unknown): 'non_paying' | 'paying' | 'missing' | 'unknown' {
  const text = paymentText(guaranteeType).toLowerCase();
  if (!text) return 'missing';
  if (/^non[-\s]?guaranteed/.test(text) || text === 'none') return 'non_paying';
  if (
    /guaranteed/.test(text) ||
    /confirmation received/.test(text) ||
    /awaiting voucher/.test(text) ||
    /deposit requested/.test(text) ||
    /group definite/.test(text) ||
    /credit card/.test(text)
  ) {
    return 'paying';
  }
  return 'unknown';
}

function isProvisionalStatus(status: unknown): boolean {
  const text = paymentText(status).toLowerCase();
  return text === 'reserved' || text === 'provisional';
}

/** R7: unpaid = provisional + deposit 0 + non-paying guarantee. Confirmed blank string is 0 then; unread null is unknown. */
export function classifyAmendPayment(stay: AmendPaymentStay | null | undefined): AmendPaymentClass {
  if (!stay) return 'unknown';
  if (!paymentText(stay.status) || !paymentText(stay.guaranteeType)) return 'unknown';
  const guarantee = guaranteeKind(stay.guaranteeType);
  if (guarantee === 'missing' || guarantee === 'unknown') return 'unknown';
  const depositRaw = stay.depositReceived;
  if (depositRaw == null) return guarantee === 'paying' ? 'guaranteed' : 'unknown';
  const depositText = paymentText(depositRaw);
  const confirmedBlank = typeof depositRaw === 'string' && depositText === '';
  const deposit = depositText ? parseDepositReceived(depositRaw) : null;
  if (depositText && deposit == null) return 'unknown';
  if (deposit != null && deposit > 0) return 'paid';
  if (guarantee === 'paying') return 'guaranteed';
  const depositIsZero = deposit === 0 || confirmedBlank;
  if (isProvisionalStatus(stay.status) && depositIsZero && guarantee === 'non_paying') return 'unpaid';
  return 'unknown';
}

export function paymentStayFromRecord(
  stay: { status?: string | null; guaranteeType?: string | null } | null,
): AmendPaymentStay | null {
  if (!stay) return null;
  const extra = stay as { depositReceived?: string | null };
  return {
    status: stay.status ?? null,
    guaranteeType: stay.guaranteeType ?? null,
    depositReceived: extra.depositReceived ?? null,
  };
}

export const AMEND_FORM_FIELDS = ['arrival', 'departure', 'roomType', 'adults', 'children'] as const;
export type AmendFormField = (typeof AMEND_FORM_FIELDS)[number];
export type AmendFormValues = Partial<Record<AmendFormField, string | number>>;
export const AMEND_FIELD_LABEL: Record<AmendFormField, string> = {
  arrival: 'Arrival', departure: 'Departure', roomType: 'Room', adults: 'Adults', children: 'Children',
};

export function changedAmendRows(
  current: Record<string, string | number | null | undefined>,
  requested: AmendFormValues,
) {
  return AMEND_FORM_FIELDS.flatMap((field) => {
    const to = requested[field];
    if (to === undefined || to === '') return [];
    const from = current[field];
    if (String(from ?? '') === String(to)) return [];
    return [{ field, label: AMEND_FIELD_LABEL[field], from: from == null || from === '' ? 'HMS: —' : String(from), to: String(to) }];
  });
}

export type AmendRun = {
  outcome: string;
  screenshots: string[];
  runId: string | null;
  previewDigest: string | null;
  changedFieldsReadback: Record<string, unknown> | null;
};
export type AmendView =
  | { kind: 'idle'; note: string | null }
  | { kind: 'previewing' }
  | { kind: 'ready'; run: AmendRun; note: string | null }
  | { kind: 'committing'; run: AmendRun }
  | { kind: 'done'; run: AmendRun; text: string };

function amendOutcomeNote(outcome: string, confirmation: string): string {
  if (outcome === 'refused_legacy_amend_unavailable') return `Nava cannot change ${confirmation} yet. Check any earlier HMS write before changing the booking.`;
  if (outcome === 'refused_flag_off') return `${AMEND_SAVE_COPY.switchedOff} Open ${confirmation} in HMS and save the change there.`;
  if (outcome === 'refused_not_lab') return AMEND_SAVE_COPY.testOnly;
  if (outcome === 'refused_payment_unknown') return AMEND_SAVE_COPY.handleInHms;
  if (outcome === 'refused_lock_busy') return AMEND_FIND_COPY.busy;
  if (outcome === 'refused_lock_unavailable') return AMEND_FIND_COPY.unreachable;
  if (outcome === 'amend_preview_required' || outcome === 'amend_digest_mismatch' || outcome === 'refused_digest_mismatch') {
    return AMEND_SAVE_COPY.previewAgain;
  }
  return outcome === 'save_not_confirmed' ? AMEND_SAVE_COPY.unconfirmed : AMEND_SAVE_COPY.failed;
}

export function viewAfterAmendPreview(run: AmendRun, confirmation: string): AmendView {
  return run.outcome === 'previewed' && run.previewDigest
    ? { kind: 'ready', run, note: null }
    : { kind: 'idle', note: amendOutcomeNote(run.outcome, confirmation) };
}
export function viewAfterAmendCommit(run: AmendRun, confirmation: string): AmendView {
  return run.outcome === 'amended'
    ? { kind: 'done', run, text: AMEND_SAVE_COPY.done }
    : { kind: 'idle', note: amendOutcomeNote(run.outcome, confirmation) };
}

export type AmendStayClient = {
  previewAmend: (input: { confirmation: string; arrival: string; lastName: string; fields: AmendFormValues }) => Promise<AmendRun>;
  commitAmend: (input: {
    confirmation: string; arrival: string; lastName: string; fields: AmendFormValues; previewDigest: string;
  }) => Promise<AmendRun>;
  paneStayScreenshot: (input: ScreenshotInput) => Promise<ScreenshotReply>;
};

export function amendStayClientFromTrpc(trpc: unknown): AmendStayClient | null {
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const routes = (
    trpc as {
      paneStayAmend?: {
        previewAmend?: { mutate: AmendStayClient['previewAmend'] };
        commitAmend?: { mutate: AmendStayClient['commitAmend'] };
        paneStayScreenshot?: { query: AmendStayClient['paneStayScreenshot'] };
      };
    }
  ).paneStayAmend;
  if (!routes?.previewAmend || !routes.commitAmend || !routes.paneStayScreenshot) return null;
  return {
    previewAmend: (input) => routes.previewAmend!.mutate(input),
    commitAmend: (input) => routes.commitAmend!.mutate(input),
    paneStayScreenshot: (input) => routes.paneStayScreenshot!.query(input),
  };
}

type TrpcCapabilityRoutes = {
  brain?: { getCapabilities?: { query: () => Promise<PaneCapabilitiesReply> } };
};

/**
 * Reads brain.getCapabilities off the tRPC client the panel already receives, so the panel needs no
 * react-query context. Null when the route is missing; cancelling then stays switched off.
 */
export function amendCapabilitiesFromTrpc(trpc: unknown): (() => Promise<PaneCapabilitiesReply>) | null {
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const route = (trpc as TrpcCapabilityRoutes).brain?.getCapabilities;
  if (!route) return null;
  return () => route.query();
}

/** Binds the three paneStayCancel routes off a tRPC client. Null when any of them is missing. */
export function amendCancelClientFromTrpc(trpc: unknown, transportId?: string | null): AmendCancelClient | null {
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const routes = (trpc as TrpcPaneStayCancelRoutes).paneStayCancel;
  const preview = routes?.previewCancel;
  const commit = routes?.commitCancel;
  const screenshot = routes?.paneStayScreenshot;
  if (!preview || !commit || !screenshot) return null;
  const pinned = inMailbox(transportId ?? null);
  return {
    previewCancel: (input) => pinned ? preview.mutate(input, pinned) : preview.mutate(input),
    commitCancel: (input) => pinned ? commit.mutate(input, pinned) : commit.mutate(input),
    paneStayScreenshot: (input) => pinned ? screenshot.query(input, pinned) : screenshot.query(input),
  };
}
