import type { QuoteSession } from '@/lib/quote-workflow/types';
import type { DraftedDetails } from '../use-insert-ai-draft';

/** Review block: the reply just inserted, with its reviewed quotation and the attachment names. */
export function DraftPreviewBlock({
  details,
  reviewedReplyHtml,
  onDismiss,
}: {
  details: DraftedDetails;
  reviewedReplyHtml: QuoteSession['reviewedReplyHtml'];
  onDismiss: () => void;
}) {
  return (
    <div className="animate-in fade-in rounded-sm border border-[#cbd5e1] bg-white p-3 text-xs leading-relaxed text-[#1e293b] duration-200">
      <div className="mb-2 flex items-start justify-between border-b border-[#e2e8f0] pb-2 text-[11px] text-[#64748b]">
        <div>
          <strong>To:</strong> {details.sender} &lt;
          {details.senderEmail}&gt;
          <br />
          <strong>Subject:</strong> RE: {details.subject} — Quotation
        </div>
        <button
          type="button"
          onClick={() => onDismiss()}
          className="text-[10px] text-slate-400 hover:text-slate-600"
        >
          Dismiss
        </button>
      </div>
      {details.previewHtml ? (
        <div dangerouslySetInnerHTML={{ __html: details.previewHtml }} />
      ) : reviewedReplyHtml ? (
        <div dangerouslySetInnerHTML={{ __html: reviewedReplyHtml }} />
      ) : (
        <p>No reviewed reply HTML. Insert uses only a staff-reviewed reply.</p>
      )}
      {details.planName ? (
        <p className="mt-2 text-[11px] text-[#64748b]">Attached: {details.planName}</p>
      ) : null}
    </div>
  );
}
