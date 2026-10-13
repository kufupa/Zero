import type { QuoteAnalysis } from '@/lib/quote-workflow/types';
import {
  NAVA_READ_AS_LABEL,
  NAVA_WORK_STATE_LABEL,
  readAsForAnalysis,
  type NavaReadAs,
  type NavaWorkState,
} from '@/lib/quote-workflow/workflow-vocabulary';
import { paneFieldClass } from '@/components/nava-pane/pane-ui';

export type QuoteIntent = 'quote' | 'create_booking' | 'other';

const SPECIAL_READ_HINT: Partial<Record<NavaReadAs, string>> = {
  amendment: 'Nava thinks the guest wants to change an existing booking.',
  cancellation: 'Nava thinks the guest wants to cancel an existing booking.',
};

/** One selected-email classification banner. Work state is deliberately a separate, optional chip. */
export function WorkflowBadge({
  analysis,
  kind,
  readAs,
  treatAs,
  workState,
  onIntentChange,
}: {
  analysis: QuoteAnalysis | null;
  kind?: string | null;
  readAs?: NavaReadAs | null;
  treatAs?: 'quote' | 'create_booking' | null;
  workState?: NavaWorkState | null;
  onIntentChange?: (intent: 'quote' | 'create_booking') => void;
}) {
  const current = readAs ?? readAsForAnalysis(analysis, { kind, treatAs });
  if (!current) return null;

  const label = NAVA_READ_AS_LABEL[current];
  const changeable = Boolean(onIntentChange) && ['quote', 'new_booking', 'not_for_nava'].includes(current);
  const selectorValue =
    treatAs ?? (current === 'quote' ? 'quote' : current === 'new_booking' ? 'create_booking' : 'other');
  return (
    <section
      role="status"
      aria-label={`Nava reads this as: ${label}`}
      className="flex shrink-0 flex-col gap-2 rounded-[4px] border border-[#bfdbfe] bg-[#eff6ff] px-3 py-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] text-[#1e293b]">
          <span className="font-semibold">Nava reads this as:</span>
          <span
            data-read-as={current}
            title={SPECIAL_READ_HINT[current]}
            className="rounded-full bg-white px-2 py-0.5 text-[11.5px] font-bold text-[#1d4ed8]"
          >
            {label}
          </span>
          {analysis?.aiUnavailable ? (
            <span className="rounded-full bg-white px-2 py-0.5 text-[10.5px] font-semibold text-[#64748b]">
              Read without AI
            </span>
          ) : null}
        </div>
        {workState ? (
          <span
            data-work-state={workState}
            className="whitespace-nowrap rounded-full border border-[#cbd5e1] bg-white px-2 py-0.5 text-[10.5px] font-semibold text-[#475569]"
          >
            {NAVA_WORK_STATE_LABEL[workState]}
          </span>
        ) : null}
      </div>
      {analysis?.aiUnavailable ? (
        <p className="text-[11px] text-[#64748b]">Check every field by hand.</p>
      ) : null}
      {changeable ? (
        <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#475569]">
          Change how Nava reads this email
          <select
            aria-label="Change how Nava reads this email"
            className={`${paneFieldClass} max-w-[15rem] bg-white`}
            value={selectorValue}
            onChange={(event) => {
              if (event.target.value === 'quote' || event.target.value === 'create_booking') {
                onIntentChange?.(event.target.value);
              }
            }}
          >
            <option value="quote">Quote</option>
            <option value="create_booking">New booking</option>
            {current === 'not_for_nava' ? <option value="other">Not for Nava</option> : null}
          </select>
        </label>
      ) : null}
    </section>
  );
}
