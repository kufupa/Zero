import type { ReactNode } from 'react';

import { draftMoney } from '@/lib/quote-workflow/multi-option-draft';
import { HRDAV_ROOM_NAMES, type AvailabilityBoardRow, type QuoteBoard, type RateOption } from '@/lib/quote-workflow/types';

/** Shown on GNC3B and GNC4B. The server marks these as event rates; they are never matched, ranked or priced differently. */
export const CRICKET_RATE_HINT = 'Cricket event rate. Shown for reference: never matched, ranked or priced differently.';

function displayLabel(label: string): string {
  return label.replace(/&amp;/gi, '&').trim();
}

function hrdavOnlyRoomName(code: string): string {
  if (code === 'DLXKNG' || code === 'STWN' || !(code in HRDAV_ROOM_NAMES)) return '';
  return HRDAV_ROOM_NAMES[code as keyof typeof HRDAV_ROOM_NAMES];
}

/** One read-only BAR cell. Local projection only — not stored on QuoteSession. */
export type BarGridCell = {
  groupId: string;
  roomCode: string;
  roomLabel: string;
  rateCode: string;
  rateLabel: string;
  board: string;
  boardLabel: string;
  nightlyPriceMinor: number | null;
  roomsLeft: number | null;
  rateScope?: 'public' | 'contextual' | 'unknown';
};

function barGridKey(groupId: string, roomCode: string, rateCode: string, board: string): string {
  return `${groupId}|${roomCode}|${rateCode}|${board}`;
}

/**
 * Stay-group × room × rate × board projection. Occupancy groups keep separate cells.
 * Pass the raw availability board, not `buildRateOptions` cards. Unpriced rows stay "not checked".
 */
export function projectBarGrid(options: readonly AvailabilityBoardRow[]): BarGridCell[] {
  const byKey = new Map<string, BarGridCell>();
  for (const option of options) {
    const key = barGridKey(option.groupId, option.roomCode, option.rateCode, option.board);
    const nightlyPriceMinor =
      option.nightlyPriceMinor !== null && option.nightlyPriceMinor > 0 ? option.nightlyPriceMinor : null;
    const roomsLeft = option.roomsLeft;
    const next: BarGridCell = {
      groupId: option.groupId,
      roomCode: option.roomCode,
      roomLabel: displayLabel(option.roomLabel) || hrdavOnlyRoomName(option.roomCode) || option.roomCode,
      rateCode: option.rateCode,
      rateLabel: displayLabel(option.rateLabel) || option.rateCode,
      board: option.board,
      boardLabel: displayLabel(option.boardLabel) || option.board,
      nightlyPriceMinor,
      roomsLeft,
      ...(option.rateScope ? { rateScope: option.rateScope } : {}),
    };
    const held = byKey.get(key);
    if (!held) {
      byKey.set(key, next);
      continue;
    }
    const preferNext =
      (held.nightlyPriceMinor === null && next.nightlyPriceMinor !== null) ||
      (held.roomsLeft === null && next.roomsLeft !== null && next.nightlyPriceMinor !== null);
    if (preferNext) byKey.set(key, next);
  }
  return [...byKey.values()];
}

/** Read-only BAR table. Rate choice and pinning stay on the room cards below. */
export function BarAvailabilityGrid({
  cells,
  truncated = false,
}: {
  cells: BarGridCell[];
  truncated?: boolean;
}) {
  if (!cells.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <h5 className="text-[13px] font-semibold text-[#475569]">BAR by room, rate and board</h5>
      {truncated ? (
        <p className="text-[12px] text-[#64748b]">More room options exist than this grid shows.</p>
      ) : null}
      <table className="w-full border-collapse text-[12px]" aria-label="BAR by room, rate and board">
        <thead>
          <tr className="border-b border-[#e2e8f0] text-left text-[11px] font-semibold uppercase tracking-wide text-[#64748b]">
            <th className="py-1 pr-2 font-semibold">Room</th>
            <th className="py-1 pr-2 font-semibold">Rate</th>
            <th className="py-1 pr-2 font-semibold">Board</th>
            <th className="py-1 pr-2 font-semibold">Avg / room / night</th>
            <th className="py-1 font-semibold">Rooms left</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((cell) => (
            <tr key={barGridKey(cell.groupId, cell.roomCode, cell.rateCode, cell.board)} className="border-b border-[#f1f5f9] text-[#1e293b]">
              <td className="py-1 pr-2">{`${cell.roomLabel} (${cell.roomCode})`}</td>
              <td className="py-1 pr-2">{cell.rateCode}</td>
              <td className="py-1 pr-2">{cell.boardLabel}</td>
              <td className="py-1 pr-2">
                {cell.nightlyPriceMinor === null ? 'not checked' : draftMoney(cell.nightlyPriceMinor)}
              </td>
              <td className="py-1">{cell.roomsLeft === null ? 'not checked' : String(cell.roomsLeft)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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
  const cards = options.filter((option) => option.incomplete !== true);
  return (
    <div role="group" aria-label="Room rates from HMS" aria-busy={loading} className="flex flex-col gap-2">
      {cards.map((option) => {
        const selected = loading ? option.rateCode === pendingRateCode : option.selected;
        const restricted = option.onlyContract && !partyName;
        const mealPlanMatch = preferredBoard === 'all' || option.board === preferredBoard;
        const from = option.priced === 'summary' && !selected ? 'from ' : '';
        const rateLabel = displayLabel(option.rateLabel) || option.rateCode;
        const boardLabel = displayLabel(option.boardLabel);
        const roomLabel = displayLabel(option.roomLabel) || hrdavOnlyRoomName(option.roomCode);
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
              <span className="inline-flex items-baseline justify-end gap-x-2 whitespace-nowrap text-right text-[12.5px] font-extrabold text-[#1e293b]">
                <span className={`whitespace-nowrap ${restricted ? 'line-through' : ''}`}>
                  {`${from}${draftMoney(option.perNightMinor)} avg / room / night`}
                </span>
                {option.roomsLeft !== undefined ? (
                  <span className={`font-semibold ${option.roomsLeft <= 3 ? 'text-amber-700' : 'text-[#64748b]'}`}>
                    {option.roomsLeft <= 3 ? `Only ${option.roomsLeft} left` : `${option.roomsLeft} left`}
                  </span>
                ) : null}
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

function RateTag({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'selected' | 'warning' }) {
  const classes = tone === 'selected'
    ? 'bg-[#1a4332] text-white'
    : tone === 'warning'
      ? 'bg-[#fef2f2] text-[#c01823]'
      : 'bg-[#eff6ff] text-[#0066cc]';
  return <span className={`rounded-[2px] px-1 py-px text-[10px] font-semibold ${classes}`}>{children}</span>;
}
