import type { QuoteReviewItem } from '@/lib/quote-workflow/types';

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
    <section className="shadow-xs flex flex-col gap-2 rounded-sm border border-[#e2e8f0] bg-white p-3" aria-label="Items for you">
      <h3 className="text-xs font-bold uppercase tracking-wider text-[#475569]">Items for you</h3>
      {openItems.map((item) => (
        <div key={item.id} className="flex flex-col gap-1 border-t border-[#e2e8f0] pt-2">
          <p className="text-[12.5px] font-semibold text-[#1e293b]">{item.text}</p>
          {item.reason ? <p className="text-[11px] text-[#475569]">{item.reason}</p> : null}
          <p className="text-[11px] text-[#64748b]">
            {item.sourceLabel}
            {item.filename ? ` · ${item.filename}` : ''}
          </p>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[#64748b]">
            {item.blocking ? 'Pricing block — correct the stay facts' : 'Needs a reply, not a pricing approval'}
          </p>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              className="h-7 rounded-sm border border-[#cbd5e1] px-2 text-[11px] font-semibold text-[#1e293b]"
              aria-label={`View source for ${item.text}`}
              onClick={() => onViewSource?.(item)}
            >
              View source
            </button>
            {item.kind === 'question' || item.kind === 'analysis_failure' ? (
              <button
                type="button"
                className="h-7 rounded-sm border border-[#cbd5e1] px-2 text-[11px] font-semibold text-[#1e293b]"
                aria-label={`Edit reply for ${item.text}`}
                onClick={() => onEditReply?.()}
              >
                Edit reply
              </button>
            ) : null}
            {!item.blocking && item.kind !== 'pricing_fact' ? (
              <button
                type="button"
                className="h-7 rounded-sm border border-[#cbd5e1] px-2 text-[11px] font-semibold text-[#1e293b]"
                aria-label={`Mark handled: ${item.text}`}
                onClick={() => onHandle?.(item.id)}
              >
                Mark handled
              </button>
            ) : null}
          </div>
        </div>
      ))}
      {handledItems.map((item) => (
        <div key={`handled-${item.id}`} className="flex flex-col gap-1 border-t border-[#e2e8f0] pt-2">
          <p className="text-[11px] text-[#64748b]">Handled: {item.text}</p>
          <button
            type="button"
            className="h-7 self-start rounded-sm border border-[#cbd5e1] px-2 text-[11px] font-semibold text-[#1e293b]"
            aria-label={`Undo mark handled: ${item.text}`}
            onClick={() => onUndo?.(item.id)}
          >
            Undo
          </button>
        </div>
      ))}
    </section>
  );
}
