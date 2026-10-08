import { AMEND_FIND_COPY, type ScreenshotInput, type ScreenshotReply } from './amend-find';

/**
 * Cancel from the pane for amend and cancel mail. Luna opens the HMS cancel screen through the
 * paneStayCancel routes: preview reads the reasons and any cancellation fee, commit cancels the booking.
 * This module holds the copy, the outcome mapping and the tRPC binding. The panel owns the UI state.
 */

export const AMEND_CANCEL_COPY = {
  preview: 'Preview cancellation',
  previewHint:
    'Luna opens the cancel screen in HMS and reads any cancellation fee. Nothing is cancelled.',
  footerPreview:
    'Luna can preview the cancellation for you. Nothing is cancelled until you press Cancel booking in HMS.',
  previewing: 'Luna is reading the cancel screen in HMS… (usually under a minute)',
  reasonLabel: 'Cancellation reason',
  reasonPlaceholder: 'Choose a reason',
  commit: 'Cancel booking in HMS',
  committing: 'Luna is cancelling the booking in HMS… (usually under a minute)',
  seeScreenshot: 'See what Luna saw in HMS',
  alreadyCancelled: 'This booking is already cancelled in HMS.',
  switchedOff: 'Cancelling from here is switched off for now.',
  testOnly: 'Cancelling from here only works on test bookings right now.',
  reasonRefused: 'HMS did not accept that reason. Pick another and try again.',
  previewAgain: 'Preview the cancellation again first.',
  unconfirmed: 'HMS may have cancelled this booking. Check HMS before trying again.',
  failed: "Luna couldn't finish in HMS. Check HMS yourself.",
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
  return `Luna will cancel ${input.confirmation} for ${input.guest}. ${cancelFeeSentence(input.penaltyText)} This can't be undone from here.`;
}

/** The note for a cancel attempt that did not go through. Commit reason refusals are handled by viewAfterCommit. */
export function cancelOutcomeNote(outcome: string, confirmation: string): string {
  switch (outcome) {
    case 'refused_flag_off':
      return cancelSwitchedOffNote(confirmation);
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

export function cancelledText(statusAfter: string | null): string {
  return `Cancelled in HMS – status now ${statusAfter ?? 'unknown'}`;
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
      return { kind: 'idle', note: cancelOutcomeNote(run.outcome, confirmation) };
  }
}

export function viewAfterCommit(
  run: CancelRun,
  preview: CancelRun,
  confirmation: string,
): CancelView {
  switch (run.outcome) {
    case 'cancelled':
      return { kind: 'done', run, text: cancelledText(run.statusAfter) };
    case 'already_cancelled':
      return { kind: 'done', run, text: AMEND_CANCEL_COPY.alreadyCancelled };
    case 'refused_reason_missing':
      return { kind: 'ready', run: preview, reason: '', note: AMEND_CANCEL_COPY.reasonRefused };
    case 'cancel_preview_required':
    case 'cancel_digest_mismatch':
      return { kind: 'idle', note: AMEND_CANCEL_COPY.previewAgain };
    default:
      return { kind: 'idle', note: cancelOutcomeNote(run.outcome, confirmation) };
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

export type PaneCapabilitiesReply = { paneSave?: boolean };

type TrpcCapabilityRoutes = {
  brain?: { getCapabilities?: { query: () => Promise<PaneCapabilitiesReply> } };
};

/**
 * Reads brain.getCapabilities off the tRPC client the panel already receives, so the panel needs no
 * react-query context. Null when the route is missing; cancelling then stays switched off.
 */
export function amendCapabilitiesFromTrpc(trpc: unknown): (() => Promise<PaneCapabilitiesReply>) | null {
  if (!trpc || typeof trpc !== 'object') return null;
  const route = (trpc as TrpcCapabilityRoutes).brain?.getCapabilities;
  if (!route) return null;
  return () => route.query();
}

/** Binds the three paneStayCancel routes off a tRPC client. Null when any of them is missing. */
export function amendCancelClientFromTrpc(trpc: unknown): AmendCancelClient | null {
  if (!trpc || typeof trpc !== 'object') return null;
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
