import { draftMoney } from '@/lib/quote-workflow/multi-option-draft';
import type { RateOption } from '@/lib/quote-workflow/types';

/** Shown on GNC3B and GNC4B. The server marks these as event rates; they are never matched, ranked or priced differently. */
export const CRICKET_RATE_HINT = 'Cricket event rate. Shown for reference: never matched, ranked or priced differently.';

/**
 * The rate cards for one room group: the options HMS returned, in its order. The quoted one is green. Tapping another
 * pins that rate and re-runs the quote for it, so the PDF follows the pick. The panel shows these for two or more options.
 */
export function RateCards({
  options,
  partyName,
  disabled,
  pendingRateCode,
  onPick,
}: {
  options: RateOption[];
  /** The company or agency staff picked. Names the contract badge. */
  partyName?: string;
  /** Every card is off while a run is in flight, or while this group cannot run yet. */
  disabled: boolean;
  /** The rate being re-run. Its card shows as selected and loading until the new result lands. */
  pendingRateCode: string | null;
  onPick: (option: RateOption) => void;
}) {
  const loading = pendingRateCode !== null;
  return (
    <div role="group" aria-label="Room rates from HMS" aria-busy={loading} className="flex flex-col gap-1.5">
      {options.map((option) => {
        const selected = loading ? option.rateCode === pendingRateCode : option.selected;
        const from = option.priced === 'summary' && !selected ? 'from ' : '';
        const rateLabel = option.rateLabel.trim() || option.rateCode;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => {
              if (!selected) onPick(option);
            }}
            className={`flex w-full items-center justify-between gap-2 rounded-[3px] border p-2.5 text-left transition-colors disabled:cursor-not-allowed ${
              selected
                ? 'border-[#1a4332] bg-[#eaf4ee] shadow-[0_0_0_1px_#1a4332]'
                : 'border-[#cbd5e1] bg-white hover:border-[#0066cc] hover:bg-[#f8fafc] disabled:opacity-60'
            }`}
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-1.5 text-[12.5px] font-bold text-[#1e293b]">
                {`${option.rateCode}: ${rateLabel}`}
                {selected ? (
                  <span className="rounded-[2px] bg-[#1a4332] px-1 text-[10px] font-semibold text-white">Selected</span>
                ) : null}
              </span>
              <span className="text-[11px] text-[#64748b]">{`${option.roomLabel} · ${option.boardLabel}`}</span>
              {option.contract ? (
                <span className="flex flex-wrap gap-1">
                  <RateTag>{partyName ? `${partyName} contract` : 'Contract'}</RateTag>
                  {option.onlyContract ? <RateTag>only contract rate</RateTag> : null}
                </span>
              ) : null}
              {option.matchesRequest ? null : (
                <span className="w-fit rounded-[2px] bg-[#fef2f2] px-1 py-px text-[10.5px] font-semibold text-[#c01823]">
                  {`Not what they asked: ${option.boardLabel}`}
                </span>
              )}
              {option.hint === 'event_rate' ? <span className="text-[11px] text-[#475569]">{CRICKET_RATE_HINT}</span> : null}
              {loading && selected ? (
                <span role="status" className="flex items-center gap-1.5 text-[11px] font-semibold text-[#0066cc]">
                  <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-2 border-[#0066cc] border-t-transparent" />
                  Getting rates from HMS…
                </span>
              ) : null}
            </span>
            <span className="flex shrink-0 flex-col items-end gap-px text-right">
              <span className="text-[13.5px] font-extrabold text-[#1e293b]">{`${from}${draftMoney(option.perNightMinor)} a night`}</span>
              <span className="text-[11px] text-[#475569]">{`Total ${from}${draftMoney(option.totalMinor)}`}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function RateTag({ children }: { children: string }) {
  return <span className="rounded-[2px] bg-[#eff6ff] px-1 py-px text-[10px] font-semibold text-[#0066cc]">{children}</span>;
}
