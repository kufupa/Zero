import { AMEND_FIND_COPY, type ScreenshotInput, type ScreenshotReply } from './amend-find';

/**
 * Cancel from the pane for amend and cancel mail. Luna opens the HMS cancel screen through the
 * paneStayCancel routes: preview reads the reasons and any cancellation fee, commit cancels the booking.
 * This module holds the copy, the outcome mapping and the tRPC binding. The panel owns the UI state.
 */

export const AMEND_CANCEL_COPY = {
  preview: 'Preview cancellation',
  previewHint:
    'Nava opens the cancel screen in HMS and reads any cancellation fee. Nothing is cancelled.',
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
  const phrase = penaltyText ? `HMS says: ${penaltyText.trim()}` : 'HMS showed no cancellation fee';
  return sentence(phrase);
}

export function cancelConfirmLine(input: {
  confirmation: string;
  guest: string;
  penaltyText: string | null;
}): string {
  return `Nava will cancel ${input.confirmation} for ${input.guest}. ${cancelFeeSentence(input.penaltyText)} This can't be undone from here.`;
}

// HMS charge text without a trailing full stop, so the copy does not end in two.
function chargeText(penaltyText: string): string {
  return penaltyText.trim().replace(/[.!?]+$/, '');
}

/** Shown when HMS opens a cancellation charge before the cancel. The cancel did not run; staff cancel it in HMS. */
export function cancellationChargeCopy(penaltyText: string | null): string {
  if (!penaltyText) return 'HMS shows a cancellation charge. Cancel this one in HMS yourself.';
  return `HMS shows a cancellation charge: ${chargeText(penaltyText)}. Cancel this one in HMS yourself.`;
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
    case 'refused_penalty':
      return cancellationChargeCopy(penaltyText);
    case 'refused_not_lab':
      return AMEND_CANCEL_COPY.testOnly;
    case 'refused_lock_busy':
      return AMEND_FIND_COPY.busy;
    case 'refused_lock_unavailable':
      return AMEND_FIND_COPY.unreachable;
    case 'cancel_unconfirmed':
      return AMEND_CANCEL_COPY.unconfirmed;
    default:
      return AMEND_CANCEL_COPY.failed;
  }
}

export function cancelledText(statusAfter: string | null, penaltyText: string | null = null): string {
  const done = `Cancelled in HMS – status now ${statusAfter ?? 'unknown'}`;
  // A charge that opened after the OK is never clicked by Luna. Staff deal with it in HMS.
  if (!penaltyText) return done;
  return `${done}. HMS shows a cancellation charge: ${chargeText(penaltyText)}. Check HMS and deal with that charge there.`;
}

export type CancelInput = { confirmation: string; arrival: string };
/** The previewDigest of the preview that must come back with the commit. The server refuses without it. */
export type CancelCommitInput = CancelInput & { reason: string; previewDigest: string };

/** One paneStayCancel result. previewDigest is set only by a preview_ok, and a commit must send it back. */
export type CancelRun = {
  outcome: string;
  statusBefore: string | null;
  statusAfter: string | null;
  reasons: string[];
  penaltyText: string | null;
  screenshots: string[];
  runId: string | null;
  previewDigest: string | null;
};

export type CancelView =
  | { kind: 'idle'; note: string | null }
  | { kind: 'previewing' }
  | { kind: 'ready'; run: CancelRun; reason: string; note: string | null }
  | { kind: 'committing'; run: CancelRun; reason: string }
  | { kind: 'done'; run: CancelRun; text: string };

export function viewAfterPreview(run: CancelRun, confirmation: string): CancelView {
  switch (run.outcome) {
    case 'preview_ok':
      if (run.previewDigest) return { kind: 'ready', run, reason: '', note: null };
      return { kind: 'idle', note: AMEND_CANCEL_COPY.failed };
    case 'already_cancelled':
      return { kind: 'done', run, text: AMEND_CANCEL_COPY.alreadyCancelled };
    default:
      return { kind: 'idle', note: cancelOutcomeNote(run.outcome, confirmation, run.penaltyText) };
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
    case 'refused_reason_missing':
      return { kind: 'ready', run: preview, reason: '', note: AMEND_CANCEL_COPY.reasonRefused };
    case 'cancel_preview_required':
    case 'cancel_digest_mismatch':
      return { kind: 'idle', note: AMEND_CANCEL_COPY.previewAgain };
    default:
      return { kind: 'idle', note: cancelOutcomeNote(run.outcome, confirmation, run.penaltyText) };
  }
}

export type AmendCancelClient = {
  previewCancel: (input: CancelInput) => Promise<CancelRun>;
  commitCancel: (input: CancelCommitInput) => Promise<CancelRun>;
  paneStayScreenshot: (input: ScreenshotInput) => Promise<ScreenshotReply>;
};

type TrpcPaneStayCancelRoutes = {
  paneStayCancel?: {
    previewCancel?: { mutate: (input: CancelInput) => Promise<CancelRun> };
    commitCancel?: { mutate: (input: CancelCommitInput) => Promise<CancelRun> };
    paneStayScreenshot?: {
      query: (input: ScreenshotInput) => Promise<ScreenshotReply>;
    };
  };
};

export type PaneCapabilitiesReply = { paneSave?: boolean; paneSaveMode?: unknown };

/** True when brain.getCapabilities.paneSave is on — lab or on. Missing and off stay false. */
export function canPreviewCancelFromCapabilities(
  capabilities: PaneCapabilitiesReply | null | undefined,
): boolean {
  return capabilities?.paneSave === true;
}

export function canPreviewAmendFromCapabilities(
  capabilities: PaneCapabilitiesReply | null | undefined,
): boolean {
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
} as const;

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
  if (outcome === 'refused_flag_off') return `${AMEND_SAVE_COPY.switchedOff} Open ${confirmation} in HMS and save the change there.`;
  if (outcome === 'refused_not_lab') return AMEND_SAVE_COPY.testOnly;
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
export function amendCancelClientFromTrpc(trpc: unknown): AmendCancelClient | null {
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const routes = (trpc as TrpcPaneStayCancelRoutes).paneStayCancel;
  const preview = routes?.previewCancel;
  const commit = routes?.commitCancel;
  const screenshot = routes?.paneStayScreenshot;
  if (!preview || !commit || !screenshot) return null;
  return {
    previewCancel: (input) => preview.mutate(input),
    commitCancel: (input) => commit.mutate(input),
    paneStayScreenshot: (input) => screenshot.query(input),
  };
}
