import type { StayGroupRequirement } from '@/lib/quote-workflow/types';

const fieldClass =
  'outline-hidden h-8 w-full rounded-sm border border-[#cbd5e1] bg-white px-2 text-[12.5px] text-[#1e293b] focus:border-[#0066cc]';

function Provenance({ value }: { value?: string }) {
  if (!value) return null;
  const label = value === 'staff_corrected' ? 'Staff' : value === 'missing' ? 'Missing' : 'Extracted';
  return (
    <span className="ml-1 rounded-sm bg-[#f1f5f9] px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#64748b]">
      {label}
    </span>
  );
}

export function RequirementCard({
  group,
  index,
  onPatch,
}: {
  group: StayGroupRequirement;
  index: number;
  onPatch?: (groupId: string, patch: Partial<StayGroupRequirement>) => void;
}) {
  return (
    <section className="shadow-xs flex flex-col gap-2 rounded-sm border border-[#e2e8f0] bg-white p-3">
      <h3 className="text-xs font-bold uppercase tracking-wider text-[#475569]">
        Stay group {index + 1}
      </h3>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        <span>
          Arrival
          <Provenance value={group.fields.arrivalDate} />
        </span>
        <input
          type="date"
          aria-label="Arrival"
          className={fieldClass}
          value={group.arrivalDate ?? ''}
          onChange={(event) => onPatch?.(group.id, { arrivalDate: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        <span>
          Departure
          <Provenance value={group.fields.departureDate} />
        </span>
        <input
          type="date"
          aria-label="Departure"
          className={fieldClass}
          value={group.departureDate ?? ''}
          onChange={(event) => onPatch?.(group.id, { departureDate: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        Quantity
        <input
          type="number"
          min={1}
          className={fieldClass}
          value={group.quantity ?? ''}
          onChange={(event) => onPatch?.(group.id, { quantity: Number(event.target.value) })}
        />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        Room preference
        <input
          className={fieldClass}
          value={group.roomPreference ?? ''}
          onChange={(event) => onPatch?.(group.id, { roomPreference: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        <span>
          Adults
          <Provenance value={group.fields.adults} />
        </span>
        <input
          type="number"
          min={0}
          aria-label="Adults"
          className={fieldClass}
          value={group.adults ?? ''}
          onChange={(event) => onPatch?.(group.id, { adults: Number(event.target.value) })}
        />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        Children ages (comma separated)
        <input
          className={fieldClass}
          value={group.childrenAges.join(', ')}
          onChange={(event) =>
            onPatch?.(group.id, {
              childrenAges: event.target.value
                .split(',')
                .map((part) => Number(part.trim()))
                .filter((age) => Number.isFinite(age)),
            })
          }
        />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        Board
        <select
          className={fieldClass}
          value={group.board}
          onChange={(event) =>
            onPatch?.(group.id, { board: event.target.value as StayGroupRequirement['board'] })
          }
        >
          <option value="unknown">Unknown / missing</option>
          <option value="room_only">Room only</option>
          <option value="bb">Bed &amp; breakfast</option>
          <option value="dinner_bb">Dinner, bed &amp; breakfast</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        Organisation / agency
        <input
          className={fieldClass}
          value={group.organisation ?? ''}
          onChange={(event) => onPatch?.(group.id, { organisation: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        Special requests
        <textarea
          className={`${fieldClass} h-16 py-1`}
          value={group.specialRequests.join('\n')}
          onChange={(event) =>
            onPatch?.(group.id, {
              specialRequests: event.target.value.split('\n').filter(Boolean),
            })
          }
        />
      </label>
    </section>
  );
}
