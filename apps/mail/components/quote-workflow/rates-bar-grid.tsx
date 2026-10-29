import { draftMoney } from '@/lib/quote-workflow/multi-option-draft';
import type { RatePlanCategory, RatePlanChoice } from './rate-plan-select';
import type { BarGridCell } from './rate-cards';

const PUBLIC_RATE_CODES = new Set(['BAR', 'BARRO']);
export const GRID_TAG_LABEL: Record<Exclude<RatePlanCategory, 'other'>, string> = {
  public: 'Public',
  government: 'Government',
  contract: 'Contract',
};

/**
 * Grid tag from facts already on the board cell. Contract only when the party read ran and this
 * cell's rateScope is contextual. Never from a public code or the catalogue contract flag.
 */
export function gridRateTag(
  rateCode: string,
  rateScope: BarGridCell['rateScope'],
  args: {
    contractChecked: boolean;
    plans: readonly RatePlanChoice[];
  },
): Exclude<RatePlanCategory, 'other'> | null {
  const code = rateCode.trim().toUpperCase();
  if (!code) return null;
  const plan = args.plans.find((item) => item.code === code);
  if (args.contractChecked && rateScope === 'contextual') return 'contract';
  if (plan?.category === 'government') return 'government';
  if (rateScope === 'public' || PUBLIC_RATE_CODES.has(code) || plan?.category === 'public') return 'public';
  return null;
}

export type RatesBarGridProps = {
  cells: BarGridCell[];
  contractChecked: boolean;
  plans: readonly RatePlanChoice[];
  /** Inert extension seam; this display does not select plans. */
  onPlanSelect?: (plan: RatePlanChoice) => void;
  /** Inert extension seam; this display does not select cells. */
  onCellSelect?: (cell: BarGridCell) => void;
};

/** Read-only BAR table with public / government / contract tags from the existing read. */
export function RatesBarGrid({
  cells,
  contractChecked,
  plans,
}: RatesBarGridProps) {
  if (!cells.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <h5 className="text-[13px] font-semibold text-[#475569]">BAR by room, rate and board</h5>
      {contractChecked ? null : (
        <p className="text-[12px] text-[#64748b]">Public rates — contract not checked</p>
      )}
      <table className="w-full border-collapse text-[12px]" aria-label="BAR by room, rate and board">
        <thead>
          <tr className="border-b border-[#e2e8f0] text-left text-[11px] font-semibold uppercase tracking-wide text-[#64748b]">
            <th className="py-1 pr-2 font-semibold">Room</th>
            <th className="py-1 pr-2 font-semibold">Rate</th>
            <th className="py-1 pr-2 font-semibold">Board</th>
            <th className="py-1 pr-2 font-semibold">Avg / room / night</th>
            <th className="py-1 pr-2 font-semibold">Rooms left</th>
            <th className="py-1 font-semibold">Tag</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((cell) => {
            const tag = gridRateTag(cell.rateCode, cell.rateScope, { contractChecked, plans });
            return (
              <tr
                key={`${cell.groupId}|${cell.roomCode}|${cell.rateCode}|${cell.board}`}
                className="border-b border-[#f1f5f9] text-[#1e293b]"
              >
                <td className="py-1 pr-2">{`${cell.roomLabel} (${cell.roomCode})`}</td>
                <td className="py-1 pr-2">{cell.rateCode}</td>
                <td className="py-1 pr-2">{cell.boardLabel}</td>
                <td className="py-1 pr-2">
                  {cell.nightlyPriceMinor === null ? 'not checked' : draftMoney(cell.nightlyPriceMinor)}
                </td>
                <td className="py-1 pr-2">{cell.roomsLeft === null ? 'not checked' : String(cell.roomsLeft)}</td>
                <td className="py-1">
                  {tag ? (
                    <span className="rounded-[2px] bg-[#eff6ff] px-1 py-px text-[10px] font-semibold text-[#0066cc]">
                      {GRID_TAG_LABEL[tag]}
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
