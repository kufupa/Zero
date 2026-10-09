import { canCreateNativeDraft, canCreatePdf } from '@/lib/quote-workflow/session';
import { staffHeaderFieldProblem, type QuoteSession } from '@/lib/quote-workflow/types';

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
  const amountProblem = staffHeaderFieldProblem(session.staffHeader);
  return (
    <section className="shadow-xs flex flex-col gap-2 rounded-xs border border-[#e2e8f0] bg-white p-3">
      <h3 className="text-xs font-bold uppercase tracking-wider text-[#475569]">Quotation and reply</h3>
      <label className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
        Reply to the client (you can edit it)
        <textarea
          id="quote-reviewed-reply"
          aria-label="Reviewed reply"
          className="outline-hidden min-h-28 w-full rounded-xs border border-[#cbd5e1] bg-white px-2 py-1 text-[12.5px] text-[#1e293b] focus:border-[#0066cc]"
          value={session.reviewedReplyHtml}
          onChange={(event) => onReplyChange?.(event.target.value)}
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!pdfReady}
          onClick={onPreparePdf}
          className="flex h-9 flex-1 items-center justify-center rounded-xs bg-[#1a4332] text-xs font-bold text-white hover:bg-[#123023] disabled:bg-slate-300"
        >
          Prepare quotation PDF
        </button>
        <button
          type="button"
          disabled={!pdfReady || !onDownloadWorkbook || workbookPending}
          onClick={onDownloadWorkbook}
          className="flex h-9 flex-1 items-center justify-center rounded-xs border border-[#1a4332] bg-white text-xs font-bold text-[#1a4332] hover:bg-[#f1f5f2] disabled:border-slate-300 disabled:text-slate-400"
        >
          Download Excel
        </button>
      </div>
      {!pdfReady ? (
        <p className="text-[11px] text-[#64748b]">
          {amountProblem
            ? `Fix the amounts before making the PDF or Excel. ${amountProblem}`
            : 'Pick a room option for every stay before making the PDF. Separate date searches do not prove that all stays are available together.'}
        </p>
      ) : null}
      {session.pdf ? (
        <p className="text-[11px] text-[#1e293b]">
          Prepared PDF {session.pdf.fileName}. The Outlook draft will attach this exact file. For several date options, Create one reply with all date options attaches each option&apos;s PDF.
        </p>
      ) : null}
      {nativeReady ? (
        <p className="text-[11px] text-emerald-800">Reply and PDF are ready. Next, create the Outlook draft. It is not sent.</p>
      ) : null}
    </section>
  );
}
