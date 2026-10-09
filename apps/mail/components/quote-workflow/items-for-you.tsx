import type { QuoteReviewItem } from '@/lib/quote-workflow/types';
import { Notice } from '@/components/nava-pane/pane-ui';

export function ItemsForYou({
  openItems,
  handledItems,
  onViewSource,
  onEditReply,
  onHandle,
  onUndo,
}: {
  openItems: QuoteReviewItem[];
  handledItems: QuoteReviewItem[];
  onViewSource?: (item: QuoteReviewItem) => void;
  onEditReply?: () => void;
  onHandle?: (itemId: string) => void;
  onUndo?: (itemId: string) => void;
}) {
  if (!openItems.length && !handledItems.length) return null;
  return (
    <section className="flex flex-col gap-1.5" aria-label="Check before sending">
      <Notice tone="warn">
        <p className="font-semibold">Check before sending</p>
        <p>
          Nava found these. Clear each one before you send the reply. Show in email finds the line in the email.
          Edit reply opens the reply box. Mark as done hides the item here only.
        </p>
      </Notice>
      {openItems.map((item) => (
        <div key={item.id} className="flex flex-col gap-1 rounded-[3px] border border-[#e2e8f0] bg-white p-2.5">
          <p className="text-[12px] font-semibold text-[#1e293b]">{item.text}</p>
          {item.reason ? <p className="text-[11px] text-[#475569]">{item.reason}</p> : null}
          <p className="text-[11px] text-[#64748b]">
            {item.sourceLabel}
            {item.filename ? ` · ${item.filename}` : ''}
          </p>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[#64748b]">
            {item.blocking
              ? 'Blocks the quote — fix the stay details first'
              : item.kind === 'document_failure'
                ? 'Needs review. Nava did not read this file.'
                : 'Needs a reply. Not a price decision.'}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className="h-7 rounded-[3px] border border-[#cbd5e1] px-2 text-[11px] font-semibold text-[#1e293b]"
              aria-label={`Show in email: ${item.text}`}
              onClick={() => onViewSource?.(item)}
            >
              Show in email
            </button>
            {item.kind === 'question' || item.kind === 'analysis_failure' ? (
              <button
                type="button"
                className="h-7 rounded-[3px] border border-[#cbd5e1] px-2 text-[11px] font-semibold text-[#1e293b]"
                aria-label={`Edit reply for ${item.text}`}
                onClick={() => onEditReply?.()}
              >
                Edit reply
              </button>
            ) : null}
            {!item.blocking && item.kind !== 'pricing_fact' ? (
              <button
                type="button"
                className="h-7 rounded-[3px] border border-[#cbd5e1] px-2 text-[11px] font-semibold text-[#1e293b]"
                aria-label={`Mark as done: ${item.text}`}
                onClick={() => onHandle?.(item.id)}
              >
                Mark as done
              </button>
            ) : null}
          </div>
        </div>
      ))}
      {handledItems.map((item) => (
        <div key={`handled-${item.id}`} className="flex flex-col gap-1 rounded-[3px] border border-[#e2e8f0] bg-white p-2.5">
          <p className="text-[11px] text-[#64748b]">Done: {item.text}</p>
          <button
            type="button"
            className="h-7 self-start rounded-[3px] border border-[#cbd5e1] px-2 text-[11px] font-semibold text-[#1e293b]"
            aria-label={`Undo mark as done: ${item.text}`}
            onClick={() => onUndo?.(item.id)}
          >
            Undo
          </button>
        </div>
      ))}
    </section>
  );
}
