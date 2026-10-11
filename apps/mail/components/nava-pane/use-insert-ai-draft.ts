import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { createOperationId, type MailLocation, type WorkstationEmailPayload } from '@/lib/workstation/bridge-protocol';
import { beginMutation, endMutation } from '@/lib/workstation/mutations-in-flight';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import { requireMultiOptionDraft, type CombinedReplyEdit } from '@/lib/quote-workflow/multi-option-draft';
import { requireReviewedNativeDraft } from '@/lib/quote-workflow/native-draft';
import { currentPaneOwner, trackPaneAction } from '@/lib/quote-workflow/pane-telemetry';
import type { QuoteSession } from '@/lib/quote-workflow/types';
import { trpcClient } from '@/providers/query-provider';

const MAX_UNRESOLVED_REPLY_OPERATIONS = 256;
const MAX_EXPIRED_REPLY_OUTCOMES = 256;
const REPLY_OPERATION_CACHE_TTL_MS = 15 * 60 * 1000;
const UNRESOLVED_REPLY_MARKER = 'nava_outlook_unresolved_reply_v1';

// A generic marker survives re-login/reload without storing mail IDs or PDF bytes.
// A fresh pane cannot replay the old native operation ID, so ask staff to check
// Drafts before intentionally starting another operation.
function hasUnresolvedReplyMarker(): boolean {
  try { return sessionStorage.getItem(UNRESOLVED_REPLY_MARKER) === '1'; }
  catch { return false; }
}

function setUnresolvedReplyMarker(unresolved: boolean): void {
  try {
    if (unresolved) sessionStorage.setItem(UNRESOLVED_REPLY_MARKER, '1');
    else sessionStorage.removeItem(UNRESOLVED_REPLY_MARKER);
  } catch { /* Restricted WebView storage: in-memory retries still work. */ }
}

function confirmNewReplyAfterUncertainOutcome(): boolean {
  try {
    // Intentional blocking acknowledgment: unlike a toast, another click
    // cannot silently create a second Outlook draft after an unknown outcome.
    // oxlint-disable-next-line no-alert
    return window.confirm(
      'Check Outlook Drafts for the earlier reply. Have you checked Drafts and do you want to start a new draft?',
    );
  } catch { return false; }
}

function confirmReplaceDraft(): boolean {
  try {
    // Intentional blocking question: a saved reply must not silently replace an AI, someone else's or a hand-edited draft.
    // oxlint-disable-next-line no-alert
    return window.confirm(
      'Replace current draft? This thread already has a draft: an AI draft, one someone else wrote, or one edited by hand. It is set aside, not deleted.',
    );
  } catch { return false; }
}

const REPLACE_CONFIRM_PREFIX = 'DRAFT_REPLACE_CONFIRM_REQUIRED:';

/**
 * The server's refusal to replace an AI, other-person or hand-edited draft without a confirm (see drafts.saveReply).
 * Returns the token naming that draft as it is now, which the confirmed save sends back; null for any other error.
 */
function replaceDraftToken(error: unknown): string | null {
  const maybe = error as { data?: { code?: string }; message?: string };
  if (maybe.data?.code !== 'CONFLICT' || !maybe.message?.startsWith(REPLACE_CONFIRM_PREFIX)) return null;
  return maybe.message.slice(REPLACE_CONFIRM_PREFIX.length);
}

/** 'selected' is one date option's reply; 'all' is one reply carrying every completed option; 'saved' is the thread's saved reply. */
export type ReplyDraftScope = 'selected' | 'all' | 'saved';

/** A reply and its PDFs: what Insert puts into Outlook and what Save reply stores as the thread's draft. */
export type ReviewedReply = { html: string; attachments: Array<{ fileName: string; pdfBase64: string }> };

/** Reply subject as the webmail composer makes it: "Re: " once, never "Re: Re:". */
function replySubject(subject: string): string {
  const base = subject.replace(/\s+/g, ' ').trim() || 'Quotation';
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

/** One PDF in the shape drafts.saveReply takes, the same upload the composer sends. */
function pdfUploadInput(pdf: { fileName: string; pdfBase64: string }) {
  const padding = pdf.pdfBase64.endsWith('==') ? 2 : pdf.pdfBase64.endsWith('=') ? 1 : 0;
  return {
    name: pdf.fileName,
    type: 'application/pdf',
    size: (pdf.pdfBase64.length / 4) * 3 - padding,
    lastModified: Date.now(),
    base64: pdf.pdfBase64,
  };
}

type PendingReplyOperation = {
  operationId: string;
  startedAt: number;
  scope: ReplyDraftScope;
  pdfs?: Array<{ fileName: string; pdfBase64: string }>;
  reviewedHtml?: string;
  replyPayload?: {
    operationId: string;
    entryId: string;
    storeId: string;
    folderEntryId: string;
    htmlBody: string;
    replyAll: boolean;
    openInComposer: boolean;
  };
  draftLocation?: MailLocation;
  attachmentPayloads?: Array<{
    operationId: string;
    entryId: string;
    storeId: string;
    folderEntryId: string;
    fileName: string;
    base64Data: string;
  }>;
  attachmentsAdded?: number;
};

export function singleReplyDraft(draft: ReturnType<typeof requireReviewedNativeDraft>) {
  return draft
    ? {
        html: draft.html,
        attachments: [{ fileName: draft.pdf.fileName, pdfBase64: draft.pdf.pdfBase64 }],
      }
    : null;
}

/** The reply that was just inserted. The review block shows it until staff dismiss it. */
export type DraftedDetails = {
  entryId: string;
  subject: string;
  sender: string;
  senderEmail: string;
  planName: string;
  previewHtml?: string;
};

/**
 * Inserts the reviewed quotation as an unsent Outlook reply. Retry bookkeeping lives in refs, so a retry replays
 * the same operation IDs. resetReplyDraft drops that bookkeeping when the signed-in scope changes.
 */
export function useInsertAiDraft({
  activeEmail,
  mailboxEmail,
  transportLoading,
  currentScope,
  contextRevision,
  quoteSession,
  combinedEdit,
  sendCommand,
  supportsAction,
}: {
  activeEmail: PaneBridge['activeEmail'];
  mailboxEmail: string | null | undefined;
  transportLoading: boolean;
  currentScope: string | null;
  contextRevision: { readonly current: { scopeEpoch: number; selectionEpoch: number } };
  quoteSession: QuoteSession;
  combinedEdit: CombinedReplyEdit | null;
  sendCommand: PaneBridge['sendCommand'];
  supportsAction: PaneBridge['supportsAction'];
}) {
  const replyRetries = useRef(new Map<string, PendingReplyOperation>());
  const expiredReplyOutcomes = useRef(new Set<string>());
  const hasUntrackedExpiredReplyOutcomes = useRef(false);
  const expiredOutcomeConfirmationKey = useRef<string | null>(null);
  const unresolvedReplyConfirmationKey = useRef<string | null>(null);
  const replyMarkerBelongsToCurrentScope = useRef(false);
  const replyInFlight = useRef(false);
  const saveInFlight = useRef(false);
  const scopeRef = useRef(currentScope);
  scopeRef.current = currentScope;
  const [isDraftPending, setIsDraftPending] = useState(false);
  const [draftStatus, setDraftStatus] = useState<{ key: string; message: string } | null>(null);
  const [draftedDetails, setDraftedDetails] = useState<DraftedDetails | null>(null);

  const currentSubject = activeEmail?.subject || 'Suite Availability Request';
  const currentSender = activeEmail?.senderName || 'David Miller';
  const currentSenderEmail = activeEmail?.senderEmail || 'guest@example.com';

  // The reply draft is a write to Outlook. It counts as in flight until it settles, like a tRPC mutation.
  const trackedDraft = (scope: ReplyDraftScope, saved?: ReviewedReply) => {
    beginMutation();
    void handleInsertAiDraft(scope, saved).finally(endMutation);
  };

  /**
   * Insert saved reply: reads the thread's saved reply, then inserts it. The insert is in flight from the click, so a
   * second click while the read is out does nothing and the button stays off. `read` returns null to stop (it says why).
   */
  const trackedInsertSaved = (read: () => Promise<ReviewedReply | null>) => {
    if (replyInFlight.current) return;
    const startedScopeEpoch = contextRevision.current.scopeEpoch;
    replyInFlight.current = true;
    setIsDraftPending(true);
    beginMutation();
    void read()
      .catch(() => null)
      .then((saved) => {
        // A scope change already cleared the flag, and a reply in the new scope may hold it now.
        if (contextRevision.current.scopeEpoch !== startedScopeEpoch) return;
        // Handed straight to the insert, which takes the flag back before anything else can run.
        replyInFlight.current = false;
        setIsDraftPending(false);
        if (saved) return handleInsertAiDraft('saved', saved);
      })
      .finally(endMutation);
  };

  const handleInsertAiDraft = async (scope: ReplyDraftScope = 'selected', saved?: ReviewedReply) => {
    if (replyInFlight.current || !activeEmail?.entryId) return;
    const owner = currentPaneOwner();
    const startedScope = currentScope;
    const startedScopeEpoch = contextRevision.current.scopeEpoch;
    const startedSelectionEpoch = contextRevision.current.selectionEpoch;
    const sameStaffScope = () => scopeRef.current === startedScope &&
      contextRevision.current.scopeEpoch === startedScopeEpoch;
    const key = `${activeEmail.storeId ?? ''}:${activeEmail.entryId}`;
    const subject =
      activeEmail.subject.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Untitled email';
    const replyLabel = `Reply to “${subject}”: `;
    let previousAttempt = replyRetries.current.get(key);
    const now = Date.now();
    const rememberExpiredOutcome = (expiredKey: string) => {
      if (expiredReplyOutcomes.current.has(expiredKey)) return;
      if (expiredReplyOutcomes.current.size >= MAX_EXPIRED_REPLY_OUTCOMES) {
        hasUntrackedExpiredReplyOutcomes.current = true;
        return;
      }
      expiredReplyOutcomes.current.add(expiredKey);
    };

    if (previousAttempt && now - previousAttempt.startedAt >= REPLY_OPERATION_CACHE_TTL_MS) {
      replyRetries.current.delete(key);
      rememberExpiredOutcome(key);
      // Even after staff acknowledges an expired outcome, its old operation
      // ID must never be retried against a server window that has closed.
      previousAttempt = undefined;
    }
    for (const [retryKey, attempt] of replyRetries.current) {
      if (now - attempt.startedAt >= REPLY_OPERATION_CACHE_TTL_MS) {
        replyRetries.current.delete(retryKey);
        rememberExpiredOutcome(retryKey);
      }
    }
    let acknowledgedExpiredOutcome = false;
    if (expiredReplyOutcomes.current.has(key)) {
      if (expiredOutcomeConfirmationKey.current !== key) {
        expiredOutcomeConfirmationKey.current = key;
        toast.error(
          `${replyLabel}The retry window has closed. Check Outlook Drafts, then click again to continue.`,
        );
        return;
      }
      if (!confirmNewReplyAfterUncertainOutcome()) return;
      expiredReplyOutcomes.current.delete(key);
      expiredOutcomeConfirmationKey.current = null;
      acknowledgedExpiredOutcome = true;
    }
    if (hasUntrackedExpiredReplyOutcomes.current && !acknowledgedExpiredOutcome) {
      if (expiredOutcomeConfirmationKey.current !== key) {
        expiredOutcomeConfirmationKey.current = key;
        toast.error(
          `${replyLabel}Too many earlier replies have an unknown result. Check Outlook Drafts, then click again to continue.`,
        );
        return;
      }
      if (!confirmNewReplyAfterUncertainOutcome()) return;
      expiredOutcomeConfirmationKey.current = null;
    }
    // In a live pane another message may have an unresolved, safely retryable
    // operation. The generic reload marker only gates a fresh pane with no IDs.
    if (!previousAttempt && replyRetries.current.size === 0 &&
      !replyMarkerBelongsToCurrentScope.current && hasUnresolvedReplyMarker()) {
      if (unresolvedReplyConfirmationKey.current !== key) {
        unresolvedReplyConfirmationKey.current = key;
        toast.error(
          `${replyLabel}An earlier draft may have been created before the pane changed. Check Outlook Drafts, then click again to start a new draft.`,
        );
        return;
      }
      if (!confirmNewReplyAfterUncertainOutcome()) return;
      unresolvedReplyConfirmationKey.current = null;
      // Keep the prior unknown outcome recorded until this attempt actually
      // reaches native Outlook and succeeds. PDF generation may still abort.
    }
    if (!previousAttempt && replyRetries.current.size >= MAX_UNRESOLVED_REPLY_OPERATIONS) {
      toast.error(
        `${replyLabel}Too many replies have an unknown result. Check Outlook Drafts before refreshing the pane or starting another reply.`,
      );
      return;
    }

    if (!startedScope || transportLoading || !mailboxEmail) {
      toast.error('Sign in and select your mailbox before creating the draft.');
      return;
    }
    if (!activeEmail.storeId || !activeEmail.folderEntryId) {
      toast.error(
        'Outlook did not provide the selected message and source folder. Select it again.',
      );
      return;
    }

    if (!supportsAction('ADD_ATTACHMENT_TO_DRAFT')) {
      toast.error('This Outlook add-in is too old to attach the PDF. Update the Nava Outlook add-in, then try again.');
      return;
    }

    if (previousAttempt && previousAttempt.scope !== scope) {
      // An attempt that may already have reached Outlook is retried with its own scope only.
      if (previousAttempt.replyPayload) {
        toast.error(
          `${replyLabel}An earlier reply for this email may already be in Outlook Drafts. Check Drafts before creating another reply.`,
        );
        return;
      }
      replyRetries.current.delete(key);
      previousAttempt = undefined;
    }
    const reviewedDraft =
      scope === 'saved'
        ? saved ?? null
        : scope === 'all'
          ? requireMultiOptionDraft(quoteSession, combinedEdit)
          : singleReplyDraft(requireReviewedNativeDraft(quoteSession));
    if (!reviewedDraft) {
      toast.error(
        scope === 'saved'
          ? `${replyLabel}The saved reply could not be loaded. Select the email again.`
          : scope === 'all'
            ? `${replyLabel}Rate every stay and prepare the quote first. The quote must match every stay's run.`
            : 'Make the PDF and finish the reply before creating the draft. Sample rates are never used.',
      );
      return;
    }

    replyInFlight.current = true;
    setIsDraftPending(true);
    setDraftStatus(null);
    const attempt: PendingReplyOperation = previousAttempt ?? {
      operationId: createOperationId(),
      startedAt: now,
      scope,
    };
    replyRetries.current.set(key, attempt);

    // Before CREATE is submitted, staff may update the review. Once it may
    // have reached Outlook, retries must replay the exact original pair.
    if (!attempt.replyPayload) {
      attempt.reviewedHtml = reviewedDraft.html;
      attempt.pdfs = reviewedDraft.attachments.map((item) => ({
        fileName: item.fileName,
        pdfBase64: item.pdfBase64,
      }));
    }
    const quotationHtml = attempt.reviewedHtml ?? reviewedDraft.html;
    let draftCreated = false;

    try {
      const pdfs = attempt.pdfs ?? reviewedDraft.attachments;
      if (!sameStaffScope() || contextRevision.current.selectionEpoch !== startedSelectionEpoch) {
        // No new Outlook command has started for this click. A delayed quotation
        // cannot create or retry a reply for a selection that changed away
        // and back, even when its current EntryID and session string match.
        if (sameStaffScope() && !attempt.replyPayload) replyRetries.current.delete(key);
        return;
      }
      attempt.pdfs = pdfs;
      if (!attempt.draftLocation) {
        // Renewal may suppress selection events while Outlook is busy. A PDF
        // generated for A must not turn into a reply to A after staff select B.
        const selected = await sendCommand<Record<string, never>, WorkstationEmailPayload | null>(
          'GET_ACTIVE_EMAIL', {},
        );
        if (!sameStaffScope() || contextRevision.current.selectionEpoch !== startedSelectionEpoch) {
          if (sameStaffScope() && !attempt.replyPayload) replyRetries.current.delete(key);
          return;
        }
        if (!selected || selected.entryId !== activeEmail.entryId ||
          selected.storeId !== activeEmail.storeId ||
          selected.folderEntryId !== activeEmail.folderEntryId) {
          if (!attempt.replyPayload) replyRetries.current.delete(key);
          toast.error('You switched emails while the PDF was being made. Select the email again, then retry.');
          return;
        }
      }
      const replyPayload = attempt.replyPayload ?? {
        operationId: attempt.operationId,
        entryId: activeEmail.entryId,
        storeId: activeEmail.storeId,
        folderEntryId: activeEmail.folderEntryId,
        htmlBody: quotationHtml,
        replyAll: false,
        openInComposer: false,
      };
      attempt.replyPayload = replyPayload;
      if (!attempt.draftLocation) {
        replyMarkerBelongsToCurrentScope.current = true;
        setUnresolvedReplyMarker(true);
      }
      const result =
        attempt.draftLocation ??
        (await sendCommand<typeof replyPayload, MailLocation>('CREATE_REPLY_DRAFT', replyPayload));
      if (!sameStaffScope()) return;
      if (!result || typeof result !== 'object')
        throw new Error('Outlook did not confirm the reply draft.');
      draftCreated = true;
      const replyResult = result;
      if (!replyResult.entryId || !replyResult.storeId || !replyResult.folderEntryId) {
        throw new Error(
          'Outlook did not confirm the draft and its source folder. Inspect Drafts before retrying.',
        );
      }
      attempt.draftLocation = replyResult;
      const attachmentPayloads =
        attempt.attachmentPayloads ??
        pdfs.map((item) => ({
          operationId: createOperationId(),
          entryId: replyResult.entryId,
          storeId: replyResult.storeId,
          folderEntryId: replyResult.folderEntryId,
          fileName: item.fileName,
          base64Data: item.pdfBase64,
        }));
      attempt.attachmentPayloads = attachmentPayloads;
      // Each PDF keeps its own operation ID. A retry resumes at the first PDF Outlook has not confirmed.
      const alreadyAdded = attempt.attachmentsAdded ?? 0;
      for (const [index, payload] of attachmentPayloads.entries()) {
        if (index < alreadyAdded) continue;
        await sendCommand('ADD_ATTACHMENT_TO_DRAFT', payload);
        attempt.attachmentsAdded = index + 1;
        if (!sameStaffScope()) return;
      }
      replyRetries.current.delete(key);
      // A successful draft for B does not resolve an expired or unknown
      // outcome for A. Those per-message sets are in memory only; preserve
      // the generic warning across reloads until every outcome is resolved.
      if (!expiredReplyOutcomes.current.size && !hasUntrackedExpiredReplyOutcomes.current &&
        ![...replyRetries.current.values()].some((pending) => pending.replyPayload)) {
        setUnresolvedReplyMarker(false);
      }
      setDraftedDetails({
        entryId: activeEmail.entryId,
        subject: currentSubject,
        sender: currentSender,
        senderEmail: currentSenderEmail,
        planName: pdfs.map((item) => item.fileName).join(', '),
        ...(attempt.scope === 'all' || attempt.scope === 'saved' ? { previewHtml: quotationHtml } : {}),
      });
      const opened = replyResult.displayed === true;
      const details = [
        replyResult?.composerWarning,
        replyResult?.draftPlacementWarning,
        replyResult?.folderPlacementWarning,
        replyResult?.locationUnverified ? 'Could not confirm which folder the draft is in.' : null,
      ].filter(Boolean);
      const summary = opened
        ? 'Draft opened in Outlook. Check it, then send it yourself.'
        : replyResult?.entryId
          ? 'Draft saved in Outlook but did not open. Find it in Outlook Drafts.'
          : 'Outlook accepted the request, but could not confirm the draft. Check Outlook Drafts before trying again.';
      const message = [summary, ...details].join(' ');
      setDraftStatus({ key, message });
      trackPaneAction({ type: 'reply.inserted', kind: attempt.scope }, owner);
      if (details.length || !opened) toast.warning(`${replyLabel}${message}`);
      else toast.success(`${replyLabel}${message}`);
    } catch (err) {
      if (!sameStaffScope()) return;
      if (contextRevision.current.selectionEpoch !== startedSelectionEpoch && !attempt.replyPayload) {
        replyRetries.current.delete(key);
        return;
      }
      const errorCode =
        err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : null;
      const hasUnknownOutcome = errorCode === 'OPERATION_OUTCOME_UNKNOWN';
      const timedOut = err instanceof Error && err.message.includes('timed out');
      const navigationInterrupted =
        err instanceof Error && err.message.includes('Outlook navigation changed');
      const mayHaveReachedOutlook = Boolean(attempt.replyPayload);
      if (!timedOut && !hasUnknownOutcome && !draftCreated && !mayHaveReachedOutlook) {
        replyRetries.current.delete(key);
      }
      if (
        hasUnknownOutcome ||
        (timedOut && draftCreated) ||
        ((timedOut || navigationInterrupted) && mayHaveReachedOutlook)
      ) {
        const message =
          'Outlook may have created the draft but did not confirm it. Check Outlook Drafts before retrying. A retry reuses the same PDF.';
        setDraftStatus({ key, message });
        toast.error(`${replyLabel}${message}`);
      } else {
        toast.error(
          `${replyLabel}Could not create the draft: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      }
    } finally {
      if (sameStaffScope()) {
        replyInFlight.current = false;
        setIsDraftPending(false);
      }
    }
  };

  // Webmail Save reply: the same reply and PDFs become the thread's one active draft (drafts.saveReply).
  // Nothing is sent and nothing goes to Outlook. Another person's or a hand-edited draft needs a confirm.
  const trackedSave = (scope: ReplyDraftScope) => {
    beginMutation();
    void handleSaveReply(scope).finally(endMutation);
  };

  const handleSaveReply = async (scope: ReplyDraftScope) => {
    const staffSource = quoteSession.staffSource;
    if (saveInFlight.current || !activeEmail?.entryId) return;
    const owner = currentPaneOwner();
    const key = `${activeEmail.storeId ?? ''}:${activeEmail.entryId}`;
    if (!staffSource) {
      toast.error('This email is not ready to save yet. Select it again.');
      return;
    }
    const reviewedDraft =
      scope === 'all'
        ? requireMultiOptionDraft(quoteSession, combinedEdit)
        : singleReplyDraft(requireReviewedNativeDraft(quoteSession));
    if (!reviewedDraft) {
      toast.error('Make the PDF and finish the reply before saving it. Sample rates are never used.');
      return;
    }
    const saveDraft = (replaceDraft?: string) =>
      trpcClient.drafts.saveReply.mutate({
        threadId: staffSource.threadId,
        replyToMessageId: staffSource.messageId,
        to: activeEmail.senderEmail ? [activeEmail.senderEmail] : [],
        subject: replySubject(activeEmail.subject),
        html: reviewedDraft.html,
        attachments: reviewedDraft.attachments.map(pdfUploadInput),
        ...(replaceDraft === undefined ? {} : { replaceDraft }),
      });
    saveInFlight.current = true;
    setIsDraftPending(true);
    setDraftStatus(null);
    try {
      let saved: Awaited<ReturnType<typeof saveDraft>>;
      try {
        saved = await saveDraft();
      } catch (error) {
        const token = replaceDraftToken(error);
        if (token === null) throw error;
        if (!confirmReplaceDraft()) return;
        // Replaces only the draft the prompt was about. If it changed meanwhile the server says DRAFT_CHANGED.
        saved = await saveDraft(token);
      }
      const message = saved.replaced
        ? 'Replaced this thread\'s draft with the reply and PDF. Nothing is sent.'
        : 'Saved the reply and PDF as this thread\'s draft. Nothing is sent.';
      setDraftStatus({ key, message });
      trackPaneAction({ type: 'reply.saved', kind: scope }, owner);
      toast.success(message);
    } catch (error) {
      const draftChanged = (error as { message?: string }).message === 'DRAFT_CHANGED';
      toast.error(
        draftChanged
          ? 'The draft changed while saving. Save the reply again.'
          : 'Could not save the reply. Try again.',
      );
    } finally {
      saveInFlight.current = false;
      setIsDraftPending(false);
    }
  };

  // A scope change (sign-in or mailbox switch) drops every in-memory reply operation and its prompts.
  const resetReplyDraft = () => {
    replyRetries.current.clear();
    expiredReplyOutcomes.current.clear();
    hasUntrackedExpiredReplyOutcomes.current = false;
    expiredOutcomeConfirmationKey.current = null;
    unresolvedReplyConfirmationKey.current = null;
    replyMarkerBelongsToCurrentScope.current = false;
    replyInFlight.current = false;
    setIsDraftPending(false);
    setDraftedDetails(null);
    setDraftStatus(null);
  };

  return {
    trackedDraft,
    trackedInsertSaved,
    trackedSave,
    isDraftPending,
    draftStatus,
    draftedDetails,
    dismissDraftedDetails: () => setDraftedDetails(null),
    resetReplyDraft,
  };
}
