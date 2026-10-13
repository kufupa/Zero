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
        const rateLabel = displayLabel(option.rateLabel) || option.rateCode;
        const boardLabel = displayLabel(option.boardLabel);
        const roomLabel = displayLabel(option.roomLabel);
        const boardRoomLabel = [boardLabel, roomLabel].filter(Boolean).join(' · ');
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
              className={`grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1 p-2.5 text-left transition-colors disabled:cursor-not-allowed ${
                selected
                  ? 'bg-[#eaf4ee]'
                  : mealPlanMatch
                    ? 'bg-[#f8fbff] hover:bg-[#eff6ff]'
                    : 'bg-white hover:bg-[#f8fafc]'
              } disabled:opacity-70`}
            >
              <span className="line-clamp-2 min-w-0 break-words text-[13px] font-bold leading-4 text-[#1e293b]">
                <span>{rateLabel}</span>
                {' '}
                <span className="whitespace-nowrap text-[11px] font-semibold leading-4 text-[#64748b]">
                  {option.rateCode}
                </span>
              </span>
              <span className={`whitespace-nowrap text-right text-[12.5px] font-extrabold text-[#1e293b] ${restricted ? 'line-through' : ''}`}>
                {`${from}${draftMoney(option.perNightMinor)} avg / room / night`}
              </span>
              <span className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-[#64748b]">
                {boardRoomLabel ? <span>{boardRoomLabel}</span> : null}
                {selected ? <RateTag tone="selected">Selected</RateTag> : null}
                {option.contract ? <RateTag>{partyName ? `${partyName} contract` : 'Contract'}</RateTag> : null}
                {mealPlanMatch && preferredBoard !== 'all' ? <RateTag>Meal plan match</RateTag> : null}
                {option.matchesRequest ? null : (
                  <RateTag tone="warning">{`Not what they asked: ${boardLabel}`}</RateTag>
                )}
                {restricted ? <span className="font-semibold text-amber-800">Restricted — find a company or agency in HMS first</span> : null}
              </span>
              {option.hint === 'event_rate' ? (
                <span className="col-span-2 text-[12.5px] text-[#475569]">{CRICKET_RATE_HINT}</span>
              ) : null}
            </button>
            {selected ? selectedControls : null}
          </div>
        );
      })}
    </div>
  );
}

function displayLabel(label: string): string {
  return label.replace(/&amp;/gi, '&').trim();
}

function RateTag({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'selected' | 'warning' }) {
  const classes = tone === 'selected'
    ? 'bg-[#1a4332] text-white'
    : tone === 'warning'
      ? 'bg-[#fef2f2] text-[#c01823]'
      : 'bg-[#eff6ff] text-[#0066cc]';
  return <span className={`rounded-[2px] px-1 py-px text-[10px] font-semibold ${classes}`}>{children}</span>;
}
