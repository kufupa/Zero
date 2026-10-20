import {
  canCreateNativeDraft,
  canCreatePdf,
  isMultiStay,
  missingQuoteDetailsReplyOnly,
  pdfBlocker,
  quoteDeclineReplyOnly,
  ratedStayCount,
} from '@/lib/quote-workflow/session';
import type { QuoteSession } from '@/lib/quote-workflow/types';
import { Field, PrimaryButton, SecondaryButton } from '@/components/nava-pane/pane-ui';
import { useLayoutEffect, useRef } from 'react';

function reviewedReplyValue(html: string): string {
  const text = html.replace(/<br\s*\/?>/gi, '').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim();
  return text ? html : '';
}

/** Same HTML as the session; shown as formatted text, not tags. */
function ReviewedReplyEditor({
  html,
  onChange,
}: {
  html: string;
  onChange?: (html: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lastHtml = useRef(html);
  const skipInput = useRef(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || node.innerHTML === html) {
      lastHtml.current = html;
      return;
    }
    skipInput.current = true;
    node.innerHTML = html;
    lastHtml.current = html;
    skipInput.current = false;
  }, [html]);
  return (
    <div
      id="quote-reviewed-reply"
      ref={ref}
      role="textbox"
      aria-label="Reviewed reply"
      contentEditable={Boolean(onChange)}
      suppressContentEditableWarning
      className="min-h-28 w-full rounded-[3px] border border-[#cbd5e1] bg-white px-2.5 py-1.5 text-[13px] text-[#1e293b] outline-none transition-colors focus:border-[#0066cc] [&_p]:m-0 [&_p+p]:mt-2"
      onInput={(event) => {
        if (skipInput.current) return;
        const next = reviewedReplyValue(event.currentTarget.innerHTML);
        lastHtml.current = next;
        onChange?.(next);
      }}
    />
  );
}

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
  pdfPending,
  primaryAction,
}: {
  session: QuoteSession;
  onReplyChange?: (html: string) => void;
  onPreparePdf?: () => void;
  onDownloadWorkbook?: () => void;
  /** An Excel export is being made. The button stays disabled until it settles. */
  workbookPending?: boolean;
  /** A PDF is being prepared; the action stays disabled until it settles. */
  pdfPending?: boolean;
  /** Set false when another primary PDF action is shown above the panel. */
  primaryAction?: boolean;
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
  const replyOnly = missingQuoteDetailsReplyOnly(session) || quoteDeclineReplyOnly(session);
  const PdfActionButton = (primaryAction ?? !session.pdf) ? PrimaryButton : SecondaryButton;
  return (
    <div className="flex flex-col gap-3.5">
      <PdfActionButton
        className="w-full"
        disabled={Boolean(pdfPending) || !pdfReady || !onPreparePdf}
        disabledReason={
          pdfPending
            ? 'Preparing PDF…'
            : pdfReason ?? (!onPreparePdf ? 'PDF preparation is not available in this view.' : null)
        }
        onClick={onPreparePdf}
      >
        {pdfPending ? 'Preparing PDF…' : pdfButtonLabel}
      </PdfActionButton>
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
      {/* A combined reply is built from every stay's quote; request-only replies still need the ordinary editor. */}
      {!isMultiStay(session) || replyOnly ? (
        <Field label="Reply to the client (you can edit it)" htmlFor="quote-reviewed-reply">
          <ReviewedReplyEditor html={session.reviewedReplyHtml} onChange={onReplyChange} />
        </Field>
      ) : null}
      {nativeReady ? (
        <p className="text-[12.5px] text-emerald-800">Reply and PDF are ready. Next, create the Outlook draft. It is not sent.</p>
      ) : null}
    </div>
  );
}
