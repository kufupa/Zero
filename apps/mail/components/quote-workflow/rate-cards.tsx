import type { ReactNode } from 'react';

import { draftMoney } from '@/lib/quote-workflow/multi-option-draft';
import type { QuoteBoard, RateOption } from '@/lib/quote-workflow/types';

/** Shown on GNC3B and GNC4B. The server marks these as event rates; they are never matched, ranked or priced differently. */
export const CRICKET_RATE_HINT = 'Cricket event rate. Shown for reference: never matched, ranked or priced differently.';

/**
 * Every HMS rate for one room row stays visible in server order, including a single result. The quoted rate has a green
 * ring; the stay's local meal-plan selection highlights matching cards without filtering other rate codes out.
 */
export function RateCards({
  options,
  partyName,
  disabled,
  pendingRateCode,
  preferredBoard = 'all',
  selectedControls,
  onPick,
}: {
  options: RateOption[];
  /** The company or agency staff picked. Names the contract badge. */
  partyName?: string;
  /** Every card is off while a run is in flight, or while this group cannot run yet. */
  disabled: boolean;
  /** The rate being re-run. Its card shows as selected and loading until the new result lands. */
  pendingRateCode: string | null;
  /** A display-only highlight selected on the stay card. */
  preferredBoard?: QuoteBoard | 'all';
  /** Rate controls render inside the selected card, after its non-interactive choice button. */
  selectedControls?: ReactNode;
  onPick: (option: RateOption) => void;
}) {
  const loading = pendingRateCode !== null;
  return (
    <div role="group" aria-label="Room rates from HMS" aria-busy={loading} className="flex flex-col gap-2">
      {options.map((option) => {
        const selected = loading ? option.rateCode === pendingRateCode : option.selected;
        const restricted = option.onlyContract && !partyName;
        const mealPlanMatch = preferredBoard === 'all' || option.board === preferredBoard;
        const from = option.priced === 'summary' && !selected ? 'from ' : '';
        const rateLabel = option.rateLabel.trim() || option.rateCode;
        return (
          <div
            key={option.id}
            className={`overflow-hidden rounded-[3px] border bg-white transition-colors ${
              selected
                ? 'border-[#1a4332] shadow-[0_0_0_1px_#1a4332]'
                : mealPlanMatch
                  ? 'border-[#93c5fd] ring-1 ring-[#dbeafe]'
                  : 'border-[#cbd5e1]'
            }`}
          >
            <button
              type="button"
              aria-pressed={selected}
              disabled={disabled || restricted}
              onClick={() => {
                if (!selected && !restricted) onPick(option);
              }}
              className={`flex w-full items-center justify-between gap-2 p-2.5 text-left transition-colors disabled:cursor-not-allowed ${
                selected
                  ? 'bg-[#eaf4ee]'
                  : mealPlanMatch
                    ? 'bg-[#f8fbff] hover:bg-[#eff6ff]'
                    : 'bg-white hover:bg-[#f8fafc]'
              } disabled:opacity-70`}
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className={`flex flex-wrap items-center gap-1.5 text-[13px] font-bold text-[#1e293b] ${restricted ? 'line-through text-[#64748b]' : ''}`}>
                  {`${option.rateCode}: ${rateLabel}`}
                  {selected ? (
                    <span className="rounded-[2px] bg-[#1a4332] px-1 py-px text-[10px] font-semibold text-white">Selected</span>
                  ) : null}
                  {mealPlanMatch && preferredBoard !== 'all' ? <RateTag>Meal plan match</RateTag> : null}
                </span>
                <span className="text-[12.5px] text-[#64748b]">{`${option.roomLabel} · ${option.boardLabel}`}</span>
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
                {restricted ? (
                  <span className="text-[12.5px] font-semibold text-amber-800">Restricted — find a company or agency in HMS first</span>
                ) : null}
                {option.hint === 'event_rate' ? <span className="text-[12.5px] text-[#475569]">{CRICKET_RATE_HINT}</span> : null}
                {loading && selected ? (
                  <span role="status" className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[#0066cc]">
                    <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-2 border-[#0066cc] border-t-transparent" />
                    Getting rates from HMS…
                  </span>
                ) : null}
              </span>
              <span className="flex shrink-0 flex-col items-end gap-px text-right">
                <span className={`text-[13px] font-extrabold text-[#1e293b] ${restricted ? 'line-through' : ''}`}>
                  {`${from}${draftMoney(option.perNightMinor)} avg / room / night`}
                </span>
                <span className={`text-[12.5px] text-[#475569] ${restricted ? 'line-through' : ''}`}>
                  {`Total ${from}${draftMoney(option.totalMinor)}`}
                </span>
              </span>
            </button>
            {selected ? selectedControls : null}
          </div>
        );
      })}
    </div>
  );
}

function RateTag({ children }: { children: ReactNode }) {
  return <span className="rounded-[2px] bg-[#eff6ff] px-1 py-px text-[10px] font-semibold text-[#0066cc]">{children}</span>;
}
