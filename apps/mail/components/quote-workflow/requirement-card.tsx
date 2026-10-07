import { parseChildrenAges } from '@/lib/quote-workflow/session';
import type { StayGroupRequirement } from '@/lib/quote-workflow/types';

const fieldClass =
  'outline-hidden h-8 w-full rounded-xs border border-[#cbd5e1] bg-white px-2 text-[12.5px] text-[#1e293b] focus:border-[#0066cc]';

const FIELD_EVIDENCE_ALIASES: Record<string, string[]> = {
  arrivalDate: ['arrivalDate', 'arrival'],
  departureDate: ['departureDate', 'departure'],
  adults: ['adults', 'adultsPerRoom'],
  quantity: ['quantity', 'rooms'],
  roomPreference: ['roomPreference'],
  childrenAges: ['childrenAges', 'childAges'],
  board: ['board'],
  organisation: ['organisation', 'organization', 'party'],
};

function Provenance({ value }: { value?: string }) {
  if (!value) return null;
  const label = value === 'staff_corrected' ? 'Staff' : value === 'missing' ? 'Missing' : 'Extracted';
  return (
    <span className="ml-1 rounded-xs bg-[#f1f5f9] px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#64748b]">
      {label}
    </span>
  );
}

function quotesFor(
  field: string,
  evidence: Array<{ field: string; quote: string }> | undefined,
): string[] {
  if (!evidence?.length) return [];
  const aliases = FIELD_EVIDENCE_ALIASES[field] ?? [field];
  return evidence.filter((item) => aliases.includes(item.field)).map((item) => item.quote);
}

function FieldEvidence({ quotes }: { quotes: string[] }) {
  if (!quotes.length) return null;
  return (
    <>
      <span className="ml-1 rounded-xs bg-[#f1f5f9] px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#64748b]">
        AI suggestion
      </span>
      {quotes.map((quote) => (
        <p key={quote} className="font-normal text-[11px] text-[#64748b]">
          {quote}
        </p>
      ))}
    </>
  );
}

export function RequirementCard({
  group,
  index,
  onPatch,
  evidence,
}: {
  group: StayGroupRequirement;
  index: number;
  onPatch?: (groupId: string, patch: Partial<StayGroupRequirement>) => void;
  evidence?: Array<{ field: string; quote: string }>;
}) {
  return (
    <section className="shadow-xs flex flex-col gap-2 rounded-xs border border-[#e2e8f0] bg-white p-3">
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
        <FieldEvidence quotes={quotesFor('arrivalDate', evidence)} />
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
        <FieldEvidence quotes={quotesFor('departureDate', evidence)} />
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
        <FieldEvidence quotes={quotesFor('quantity', evidence)} />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        Room preference
        <select
          className={fieldClass}
          value={group.roomPreference ?? ''}
          onChange={(event) => onPatch?.(group.id, { roomPreference: event.target.value })}
        >
          <option value="">Any room type — no stated preference</option>
          {group.roomPreference && !['STWN','STQN','SKNG','EXKNG','DLXTWN','DLXQN','DLXKNG','LUXKNG','SUITE'].includes(group.roomPreference) && <option value={group.roomPreference}>Requested: {group.roomPreference} — choose a room type</option>}
          <option value="STWN">Standard Twin</option><option value="STQN">Standard Queen</option><option value="SKNG">Standard King</option>
          <option value="EXKNG">Executive King</option><option value="DLXTWN">Deluxe Twin</option><option value="DLXQN">Deluxe Queen</option>
          <option value="DLXKNG">Deluxe King</option><option value="LUXKNG">Luxury King</option><option value="SUITE">Suite</option>
        </select>
        <FieldEvidence quotes={quotesFor('roomPreference', evidence)} />
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
        <FieldEvidence quotes={quotesFor('adults', evidence)} />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        Children ages (comma separated)
        <input
          className={fieldClass}
          aria-label="Children ages"
          value={group.childrenAges.join(', ')}
          onChange={(event) =>
            onPatch?.(group.id, {
              childrenAges: parseChildrenAges(event.target.value),
            })
          }
        />
        <FieldEvidence quotes={quotesFor('childrenAges', evidence)} />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        <span>
          Board
          {group.fields.board === 'defaulted' ? (
            <span className="ml-1 text-[11px] font-normal normal-case tracking-normal text-[#64748b]">
              usual
            </span>
          ) : (
            <Provenance value={group.fields.board} />
          )}
        </span>
        <select
          className={fieldClass}
          aria-label="Board"
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
        <FieldEvidence quotes={quotesFor('board', evidence)} />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-[#475569]">
        Organisation / agency
        <input
          className={fieldClass}
          aria-label="Organisation / agency"
          value={group.organisation ?? ''}
          onChange={(event) => onPatch?.(group.id, { organisation: event.target.value })}
        />
        <FieldEvidence quotes={quotesFor('organisation', evidence)} />
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
