import { canCreateNativeDraft, canCreatePdf } from '@/lib/quote-workflow/session';
import type { QuoteSession } from '@/lib/quote-workflow/types';

export function DocumentReview({
  session,
  onReplyChange,
  onPreparePdf,
}: {
  session: QuoteSession;
  onReplyChange?: (html: string) => void;
  onPreparePdf?: () => void;
}) {
  const pdfReady = canCreatePdf(session);
  const nativeReady = canCreateNativeDraft(session);
  return (
    <section className="shadow-xs flex flex-col gap-2 rounded-xs border border-[#e2e8f0] bg-white p-3">
      <h3 className="text-xs font-bold uppercase tracking-wider text-[#475569]">Quotation and reply</h3>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        Complete reply (staff-editable)
        <textarea
          id="quote-reviewed-reply"
          aria-label="Reviewed reply"
          className="outline-hidden min-h-28 w-full rounded-xs border border-[#cbd5e1] bg-white px-2 py-1 text-[12.5px] text-[#1e293b] focus:border-[#0066cc]"
          value={session.reviewedReplyHtml}
          onChange={(event) => onReplyChange?.(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={!pdfReady}
        onClick={onPreparePdf}
        className="flex h-9 w-full items-center justify-center rounded-xs bg-[#1a4332] text-xs font-bold text-white hover:bg-[#123023] disabled:bg-slate-300"
      >
        Prepare quotation PDF
      </button>
      {!pdfReady ? (
        <p className="text-[11px] text-[#64748b]">
          Select an authorised allocation for every stay group before generating a PDF. Separate date
          searches do not prove joint availability.
        </p>
      ) : null}
      {session.pdf ? (
        <p className="text-[11px] text-[#1e293b]">
          Prepared PDF {session.pdf.fileName}. Native insert will attach these exact bytes.
        </p>
      ) : null}
      {nativeReady ? (
        <p className="text-[11px] text-emerald-800">Reviewed reply and selected PDF are ready for an unsent Outlook draft.</p>
      ) : null}
    </section>
  );
}
