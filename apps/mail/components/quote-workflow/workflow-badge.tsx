import type { QuoteAmendment, QuoteAnalysis } from '@/lib/quote-workflow/types';

/** The amendment kinds Nava can report. */
export type AmendmentKind = QuoteAmendment['kind'];

const chipClass =
  'rounded-sm bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700';
const mutedChipClass =
  'rounded-xs bg-[#f1f5f9] px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#64748b]';

const AMENDMENT_CHIP: Record<AmendmentKind, { label: string; hint: string; className: string }> = {
  amend: {
    label: 'Change to booking',
    hint: 'Nava thinks the guest wants to change an existing booking.',
    className: 'rounded-sm bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-900',
  },
  cancel: {
    label: 'Cancellation',
    hint: 'Nava thinks the guest wants to cancel an existing booking.',
    className: 'rounded-sm bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-800',
  },
};

function workflowLabel(workflow: string | undefined): string | null {
  if (workflow === 'create_booking') return 'Booking';
  if (workflow === 'quote') return 'Quote';
  if (workflow === 'other') return 'Other';
  return null;
}

export function WorkflowBadge({
  analysis,
  amendmentKind,
}: {
  analysis: QuoteAnalysis | null;
  /** Optional. When set, its chip replaces the workflow label. Absent or null keeps the normal badge. */
  amendmentKind?: AmendmentKind | null;
}) {
  if (!analysis) return null;
  const amendment = amendmentKind ? AMENDMENT_CHIP[amendmentKind] : undefined;
  const label = amendment ? null : workflowLabel(analysis.luna?.workflow);
  if (!amendment && !label && !analysis.aiUnavailable) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {amendment ? (
        <>
          <span className="text-[10.5px] text-[#64748b]">Nava reads this as</span>
          <span
            className={amendment.className}
            title={amendment.hint}
            data-amendment-kind={amendmentKind}
          >
            {amendment.label}
          </span>
        </>
      ) : label ? (
        <>
          <span className="text-[10.5px] text-[#64748b]">Nava reads this as</span>
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
