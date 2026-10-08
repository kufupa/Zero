import type { QuoteAnalysis } from '@/lib/quote-workflow/types';

const chipClass =
  'rounded-sm bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700';
const mutedChipClass =
  'rounded-xs bg-[#f1f5f9] px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#64748b]';

function workflowLabel(workflow: string | undefined): string | null {
  if (workflow === 'create_booking') return 'Booking';
  if (workflow === 'quote') return 'Quote';
  if (workflow === 'other') return 'Other';
  return null;
}

export function WorkflowBadge({ analysis }: { analysis: QuoteAnalysis | null }) {
  if (!analysis) return null;
  const label = workflowLabel(analysis.luna?.workflow);
  if (!label && !analysis.aiUnavailable) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {label ? (
        <>
          <span className="text-[10.5px] text-[#64748b]">Luna reads this as</span>
          <span className={chipClass}>{label}</span>
        </>
      ) : null}
      {analysis.aiUnavailable ? <span className={mutedChipClass}>Read without AI</span> : null}
      {analysis.aiUnavailable ? (
        <span className="text-[10.5px] text-[#64748b]">Check every field by hand.</span>
      ) : null}
    </div>
  );
}
