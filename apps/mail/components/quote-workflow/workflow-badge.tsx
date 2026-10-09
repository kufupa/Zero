import type { QuoteAmendment, QuoteAnalysis } from '@/lib/quote-workflow/types';
import { paneFieldClass } from '@/components/nava-pane/pane-ui';

/** The amendment kinds Nava can report. */
export type AmendmentKind = QuoteAmendment['kind'];

/** The type Nava reads the email as. Other means it is not a quote or a booking. */
export type QuoteIntent = 'quote' | 'create_booking' | 'other';

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

const INTENT_LABEL: Record<QuoteIntent, string> = {
  quote: 'Quote request',
  create_booking: 'Booking',
  other: 'Other',
};

/**
 * The type picker. Changing it to a quote or a booking runs the same action as before. Other has no action of its
 * own, so it is listed only while it is the current reading.
 */
export function WorkflowBadge({
  analysis,
  amendmentKind,
  intent,
  onIntentChange,
}: {
  analysis: QuoteAnalysis | null;
  /** Optional. Its chip is shown next to the type picker. Absent or null shows no chip. */
  amendmentKind?: AmendmentKind | null;
  /** The current reading. Null shows a prompt to choose. */
  intent?: QuoteIntent | null;
  onIntentChange?: (intent: 'quote' | 'create_booking') => void;
}) {
  if (!analysis) return null;
  const amendment = amendmentKind ? AMENDMENT_CHIP[amendmentKind] : undefined;
  const current = intent ?? null;
  const options = (['quote', 'create_booking', 'other'] as const).filter(
    (value) => value !== 'other' || current === 'other',
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] font-semibold text-[#475569]">Nava reads this as</span>
        <div className="w-40">
          <select
            aria-label="Nava reads this as"
            className={paneFieldClass}
            value={current ?? ''}
            onChange={(event) => {
              const next = event.target.value;
              if (next === 'quote' || next === 'create_booking') onIntentChange?.(next);
            }}
          >
            {current === null ? (
              <option value="" disabled>
                Choose a type
              </option>
            ) : null}
            {options.map((value) => (
              <option key={value} value={value}>
                {INTENT_LABEL[value]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {amendment ? (
        <span className={amendment.className} title={amendment.hint} data-amendment-kind={amendmentKind}>
          {amendment.label}
        </span>
      ) : null}
      {analysis.aiUnavailable ? <span className={mutedChipClass}>Read without AI</span> : null}
      {analysis.aiUnavailable ? (
        <span className="text-[10.5px] text-[#64748b]">Check every field by hand.</span>
      ) : null}
    </div>
  );
}
