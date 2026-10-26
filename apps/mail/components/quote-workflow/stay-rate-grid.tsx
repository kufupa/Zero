import { draftMoney } from '@/lib/quote-workflow/multi-option-draft';
import type { QuoteRoomRateBoardSelection } from '@/lib/quote-workflow/types';
import type { BarGridCell } from './rate-cards';

export type StayRateGridProps = {
  groupId: string;
  cells: readonly BarGridCell[];
  selection?: QuoteRoomRateBoardSelection | null;
  /** Emits staff intent only; price and inventory are not quote evidence. */
  onSelect: (selection: QuoteRoomRateBoardSelection) => void;
};

function rowKey(cell: BarGridCell): string {
  return [
    cell.groupId,
    cell.roomCode,
    cell.rateCode,
    cell.board,
  ].join('|');
}

function isSelected(cell: BarGridCell, selection?: QuoteRoomRateBoardSelection | null): boolean {
  return Boolean(
    selection &&
      cell.roomCode === selection.roomCode &&
      cell.rateCode === selection.rateCode &&
      cell.board === selection.board,
  );
}

/** Selects one admitted room/rate/board tuple; displayed availability never confirms a quote. */
export function StayRateGrid({ groupId, cells, selection, onSelect }: StayRateGridProps) {
  const rows = cells.filter((cell) => cell.groupId === groupId);
  if (!rows.length) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <h5 className="text-[13px] font-semibold text-[#475569]">Room, rate and board</h5>
      <p className="text-[12px] text-[#64748b]">
        Price and rooms left are reference only. Run a quote search to confirm them.
      </p>
      <div role="group" aria-label="Room, rate and board choices" className="flex flex-col gap-1">
        {rows.map((cell) => {
          const selected = isSelected(cell, selection);
          const roomLabel = cell.roomLabel.trim() || cell.roomCode;
          const rateLabel = cell.rateLabel.trim() || cell.rateCode;
          const boardLabel = cell.boardLabel.trim() || cell.board;
          const nightlyLabel = cell.nightlyPriceMinor === null
            ? 'Nightly price not checked'
            : `Nightly price ${draftMoney(cell.nightlyPriceMinor)}`;
          const inventoryLabel = cell.roomsLeft === null
            ? 'Rooms left not checked'
            : `Rooms left ${cell.roomsLeft}`;
          const selectionLabel = [
            `Select ${roomLabel} (${cell.roomCode})`,
            `${rateLabel} (${cell.rateCode})`,
            boardLabel,
            nightlyLabel,
            inventoryLabel,
          ].join(', ');
          const cellClassName = [
            'grid w-full min-w-0 grid-cols-2 gap-x-2 gap-y-1 rounded-[3px] border p-2',
            'text-left text-[12px]',
            selected
              ? 'border-[#1a4332] bg-[#eaf4ee] shadow-[0_0_0_1px_#1a4332]'
              : 'border-[#cbd5e1] bg-white hover:bg-[#f8fafc]',
          ].join(' ');

          return (
            <button
              key={rowKey(cell)}
              type="button"
              aria-pressed={selected}
              aria-label={selectionLabel}
              onClick={() =>
                onSelect({ roomCode: cell.roomCode, rateCode: cell.rateCode, board: cell.board })
              }
              className={cellClassName}
            >
              <span className="min-w-0 break-words font-semibold text-[#1e293b]">
                {`${roomLabel} (${cell.roomCode})`}
              </span>
              <span className="min-w-0 break-words text-right text-[#1e293b]">
                {`${rateLabel} (${cell.rateCode})`}
              </span>
              <span className="min-w-0 break-words text-[#64748b]">{boardLabel}</span>
              <span className="text-right font-semibold text-[#1e293b]">
                <span className="font-normal text-[#64748b]">Nightly: </span>
                {cell.nightlyPriceMinor === null
                  ? 'Not checked'
                  : draftMoney(cell.nightlyPriceMinor)}
              </span>
              <span className="col-span-2 text-[#64748b]">
                {`Rooms left: ${cell.roomsLeft === null ? 'Not checked' : String(cell.roomsLeft)}`}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
