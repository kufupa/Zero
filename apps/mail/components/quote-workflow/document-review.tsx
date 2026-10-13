import { canCreateNativeDraft, canCreatePdf, isMultiStay, pdfBlocker, ratedStayCount } from '@/lib/quote-workflow/session';
import type { QuoteSession } from '@/lib/quote-workflow/types';
import { Field, PrimaryButton, SecondaryButton } from '@/components/nava-pane/pane-ui';

/** "1 of 2 stays rated" while a multi-stay quote still lacks a stay's run. Null once every stay is rated. */
export function ratedStaysReason(session: QuoteSession): string | null {
  const { rated, total } = ratedStayCount(session);
  return rated < total ? `${rated} of ${total} stays rated` : null;
}

/** Why the PDF cannot be made yet, or null when it can. Shown under the disabled PDF button. Names the check that failed. */
export function pdfBlockReason(session: QuoteSession): string | null {
  const blocker = pdfBlocker(session);
  if (!blocker) return null;
  switch (blocker.kind) {
    case 'amounts':
      return `Fix the amounts first. ${blocker.problem}`;
    case 'dinner_add_on':
      return blocker.problem;
    case 'missing_stay_details':
      return 'Add the missing arrival and departure dates before preparing quote documents.';
    case 'source_not_ready':
      return blocker.unsynced
        ? 'Waiting for this email to finish syncing.'
        : 'Nava is still loading this email. If this does not clear, select the email again.';
    case 'no_rates':
      return 'Search availability first.';
    case 'sample_rates':
      return 'These are sample rates, so no PDF can be made. Open a live email to continue.';
    case 'rates_stale':
      return 'The rates are out of date. The details changed after they were found. Search availability again.';
    case 'stays_unrated':
      return `${blocker.rated} of ${blocker.total} stays rated`;
    case 'mixed_stays':
      return 'Pick room options from one stay only. Separate date searches do not prove that all stays are available together.';
    case 'rated_option_not_picked':
      return 'Pick the room option the rates were found for, or get rates again.';
    case 'no_stay':
      return session.groups.length ? 'Pick the stay to quote first.' : 'Add a stay first.';
    case 'nothing_picked':
      return 'Pick a room option first.';
    case 'pick_gone':
      return 'A picked room option is no longer in the results. Pick again.';
    case 'occupancy':
      return 'The picked rooms do not match the rooms and guests asked for. Pick rooms that match.';
  }
}

/** The quote documents: the PDF, the Excel export and the reply text that goes with them. The pane frames it as a step. */
export function DocumentReview({
  session,
  onReplyChange,
  onPreparePdf,
  onDownloadWorkbook,
  workbookPending,
}: {
  session: QuoteSession;
  onReplyChange?: (html: string) => void;
  onPreparePdf?: () => void;
  onDownloadWorkbook?: () => void;
  /** An Excel export is being made. The button stays disabled until it settles. */
  workbookPending?: boolean;
}) {
  const pdfReady = canCreatePdf(session);
  const nativeReady = canCreateNativeDraft(session);
  const pdfReason = pdfBlockReason(session);
  const excelDisabled = !pdfReady || !onDownloadWorkbook || Boolean(workbookPending);
  const excelReason = !pdfReady
    ? 'Excel needs the same checks as the PDF.'
    : workbookPending
      ? 'Making the Excel file…'
      : !onDownloadWorkbook
        ? 'Excel is not available here.'
        : null;
  const pdfButtonLabel = isMultiStay(session) ? 'Prepare quote' : 'Prepare PDF';
  return (
    <div className="flex flex-col gap-3.5">
      {session.pdf ? (
        <SecondaryButton className="w-full" disabled={!pdfReady} disabledReason={pdfReason} onClick={onPreparePdf}>
          {pdfButtonLabel}
        </SecondaryButton>
      ) : (
        <PrimaryButton disabled={!pdfReady} disabledReason={pdfReason} onClick={onPreparePdf}>
          {pdfButtonLabel}
        </PrimaryButton>
      )}
      {session.pdf ? (
        <p className="text-[12.5px] text-[#1e293b]">
          {isMultiStay(session)
            ? `Prepared quote ${session.pdf.fileName} for all stays. The Outlook draft will attach this exact file.`
            : `Prepared PDF ${session.pdf.fileName}. The Outlook draft will attach this exact file.`}
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <SecondaryButton className="w-full" disabled={excelDisabled} onClick={onDownloadWorkbook}>
          Download Excel
        </SecondaryButton>
        {excelDisabled && excelReason ? <p className="text-center text-[12.5px] text-[#64748b]">{excelReason}</p> : null}
      </div>
      {/* A combined reply is built from every stay's quote, so the one-stay reply box would be ignored. */}
      {isMultiStay(session) ? null : (
        <Field label="Reply to the client (you can edit it)" htmlFor="quote-reviewed-reply">
          <textarea
            id="quote-reviewed-reply"
            aria-label="Reviewed reply"
            className="min-h-28 w-full rounded-[3px] border border-[#cbd5e1] bg-white px-2.5 py-1.5 text-[13px] text-[#1e293b] outline-none transition-colors focus:border-[#0066cc]"
            value={session.reviewedReplyHtml}
            onChange={(event) => onReplyChange?.(event.target.value)}
          />
        </Field>
      )}
      {nativeReady ? (
        <p className="text-[12.5px] text-emerald-800">Reply and PDF are ready. Next, create the Outlook draft. It is not sent.</p>
      ) : null}
    </div>
  );
}
