import { Send } from 'lucide-react';
import { isMultiStay, optionLetter, requestedQuoteKeys } from '@/lib/quote-workflow/session';
import {
  multiOptionSignature,
  requireMultiOptionDraft,
  type CombinedReplyEdit,
} from '@/lib/quote-workflow/multi-option-draft';
import { ratedStaysReason } from '@/components/quote-workflow/document-review';
import { requireReviewedNativeDraft } from '@/lib/quote-workflow/native-draft';
import type { QuoteSession } from '@/lib/quote-workflow/types';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import { PREVIEW_ONLY_MESSAGE } from '@/lib/workstation/web-pane-bridge';
import { PrimaryButton, SecondaryButton } from './pane-ui';
import { singleReplyDraft, type ReplyDraftScope } from './use-insert-ai-draft';

type ReplyBodyProps = {
  activeEmail: PaneBridge['activeEmail'];
  supportsAction: PaneBridge['supportsAction'];
  quoteSession: QuoteSession;
  combinedEdit: CombinedReplyEdit | null;
  onCombinedEditChange: (edit: CombinedReplyEdit) => void;
  quoteOrBookingEmail: boolean;
  isDraftPending: boolean;
  statusMessage: string | null;
  onDraft: (scope: ReplyDraftScope) => void;
  /** Webmail: saves the reply as the thread's draft instead of inserting it into Outlook. */
  onSaveReply?: (scope: ReplyDraftScope) => void;
  /** Outlook: inserts the thread's saved reply with its PDFs. Null when the thread has none. */
  onInsertSaved?: (() => void) | null;
  /** The webmail preview. It cannot create a draft, so the reason says so instead of blaming the add-in. */
  preview?: boolean;
};

/**
 * The reply step: the Insert draft button, the combined reply when two or more date options are complete,
 * and the status line. The shell decides where this block sits in the fixed block order.
 * On the webmail panel the same step saves the reply as the thread's draft; in Outlook it can insert a saved one.
 */
export function ReplyBody({
  activeEmail,
  supportsAction,
  quoteSession,
  combinedEdit,
  onCombinedEditChange,
  quoteOrBookingEmail,
  isDraftPending,
  statusMessage,
  onDraft,
  onSaveReply,
  onInsertSaved = null,
  preview = false,
}: ReplyBodyProps) {
  const saving = onSaveReply !== undefined;
  const reply = onSaveReply ?? onDraft;
  // A no-reply sender (an automated mailbox) gets no insert actions. The reply text stays for copying.
  const noReplySender = quoteSession.analysis?.noReplySender === true;
  // A multi-stay quote is one combined PDF, so its one reply covers every date option. A single stay keeps its own reply.
  const allOptionsDraft = isMultiStay(quoteSession);
  const dateOptionLetters = requestedQuoteKeys(quoteSession.groups).map((_, index) => optionLetter(index));
  const allOptionsLabel = `Create one reply with all date options (${dateOptionLetters.join(', ')})`;

  // Why the reply button is off, or null when it can make the draft. A click that still gets through toasts the same reason.
  const draftBlockedReason: string | null = !activeEmail
    ? 'Select an email first'
    : preview
      ? PREVIEW_ONLY_MESSAGE
      : !supportsAction('CREATE_REPLY_DRAFT') || !supportsAction('ADD_ATTACHMENT_TO_DRAFT')
        ? 'This Outlook add-in is too old to attach the PDF. Update the Nava Outlook add-in, then try again.'
        : allOptionsDraft
          ? requireMultiOptionDraft(quoteSession, combinedEdit)
            ? null
            : (ratedStaysReason(quoteSession) ?? 'Prepare the quote first')
          : singleReplyDraft(requireReviewedNativeDraft(quoteSession))
          ? null
          : quoteSession.pdf
            ? 'Finish the reply and PDF first'
            : 'Prepare the quote PDF first';
  // Saving needs the same reviewed reply and PDF, but no Outlook add-in and no selection in Outlook.
  const saveBlockedReason: string | null = !activeEmail
    ? 'Select an email first'
    : !quoteSession.staffSource
      ? 'Wait for this email to sync, then select it again'
      : allOptionsDraft
        ? requireMultiOptionDraft(quoteSession, combinedEdit)
          ? null
          : (ratedStaysReason(quoteSession) ?? 'Prepare the quote first')
        : singleReplyDraft(requireReviewedNativeDraft(quoteSession))
          ? null
          : quoteSession.pdf
            ? 'Finish the reply and PDF first'
            : 'Prepare the quote PDF first';
  const blockedReason = saving ? saveBlockedReason : draftBlockedReason;
  const insertAddInReady = saving || supportsAction('CREATE_REPLY_DRAFT');
  return (
    <>
      {noReplySender ? null : onInsertSaved ? (
        <>
          <SecondaryButton
            onClick={onInsertSaved}
            disabled={
              isDraftPending ||
              !activeEmail ||
              !supportsAction('CREATE_REPLY_DRAFT') ||
              !supportsAction('ADD_ATTACHMENT_TO_DRAFT')
            }
            icon={<Send className="h-3.5 w-3.5" />}
          >
            Insert saved reply
          </SecondaryButton>
          <p className="text-[11px] text-[#64748b]">
            Saved from the webmail panel. Inserts the same reply and PDF.
          </p>
        </>
      ) : null}
      {noReplySender ? null : quoteOrBookingEmail || saving ? (
        <PrimaryButton
          onClick={() => reply(allOptionsDraft ? 'all' : 'selected')}
          disabled={isDraftPending || blockedReason !== null}
          disabledReason={isDraftPending ? null : blockedReason}
          icon={<Send className="h-3.5 w-3.5" />}
          tone="green"
        >
          {saving
            ? isDraftPending
              ? 'Saving the reply…'
              : 'Save reply'
            : isDraftPending
              ? 'Creating the draft in Outlook…'
              : allOptionsDraft
                ? allOptionsLabel
                : 'Insert draft in Outlook'}
        </PrimaryButton>
      ) : (
        <SecondaryButton
          onClick={() => reply(allOptionsDraft ? 'all' : 'selected')}
          disabled={!activeEmail || !insertAddInReady || isDraftPending}
          icon={<Send className="h-3.5 w-3.5" />}
        >
          {isDraftPending
            ? 'Creating the Outlook draft. Please wait…'
            : allOptionsDraft
              ? allOptionsLabel
              : 'Insert draft in Outlook'}
        </SecondaryButton>
      )}
      {allOptionsDraft ? (
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
          Combined reply (you can edit it)
          <textarea
            aria-label="Combined reply"
            className="outline-hidden min-h-28 w-full rounded-xs border border-[#cbd5e1] bg-white px-2 py-1 text-[12.5px] text-[#1e293b] focus:border-[#0066cc]"
            value={requireMultiOptionDraft(quoteSession, combinedEdit)?.html ?? ''}
            onChange={(event) =>
              onCombinedEditChange({
                signature: multiOptionSignature(quoteSession) ?? '',
                html: event.target.value,
              })
            }
          />
        </label>
      ) : null}
      {allOptionsDraft && !noReplySender ? (
        <p className="text-center text-[11px] text-[#64748b]">
          Puts the quote for every date option into one email draft. Nothing is sent.
        </p>
      ) : null}
      {noReplySender ? null : (
        <p className="text-[11px] text-[#64748b]">
          {saving
            ? 'Saves one unsent draft for this thread with the PDF attached. Nothing is sent.'
            : 'Creates an unsent reply with the PDF attached. Review it, then Send manually in Outlook. Nava never sends from this pane.'}
        </p>
      )}
      {/* Status Message */}
      {statusMessage !== null && (
        <p role="status" className="text-xs text-amber-700">
          {statusMessage}
        </p>
      )}
    </>
  );
}
