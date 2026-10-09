import { useId } from 'react';

import { Field, Stepper, paneFieldClass, paneTextareaClass } from '@/components/nava-pane/pane-ui';
import { parseChildrenAges } from '@/lib/quote-workflow/session';
import type { StayGroupRequirement } from '@/lib/quote-workflow/types';

import { ProvenanceFlag, StayDateRange } from './stay-date-range';

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

function quotesFor(
  field: string,
  evidence: Array<{ field: string; quote: string; source?: 'staff_note' }> | undefined,
): Array<{ quote: string; source?: 'staff_note' }> {
  if (!evidence?.length) return [];
  const aliases = FIELD_EVIDENCE_ALIASES[field] ?? [field];
  return evidence.filter((item) => aliases.includes(item.field));
}

function FieldEvidence({ quotes }: { quotes: Array<{ quote: string; source?: 'staff_note' }> }) {
  if (!quotes.length) return null;
  const fromStaff = quotes.some((item) => item.source === 'staff_note');
  return (
    <>
      <span className="ml-1 rounded-xs bg-[#f1f5f9] px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#64748b]">
        {fromStaff ? 'Your note' : 'Email'}
      </span>
      {quotes.map((item) => (
        <p key={item.quote} className="font-normal text-[11px] text-[#64748b]">
          {item.quote}
        </p>
      ))}
    </>
  );
}

/**
 * One stay: dates, meal plan, room type, rooms and adults, children, company and requests. A plain block: the caller
 * wraps it in a section.
 */
export function RequirementCard({
  group,
  index,
  onPatch,
  evidence,
}: {
  group: StayGroupRequirement;
  index: number;
  onPatch?: (groupId: string, patch: Partial<StayGroupRequirement>) => void;
  evidence?: Array<{ field: string; quote: string; source?: 'staff_note' }>;
}) {
  const id = useId();
  const stayNumber = index + 1;

  return (
    <div className="flex flex-col gap-3">
      {index > 0 ? <h4 className="text-[12px] font-bold text-[#475569]">Stay {stayNumber}</h4> : null}
      <Field label="Dates of stay" required>
        <StayDateRange
          arrival={group.arrivalDate ?? ''}
          departure={group.departureDate ?? ''}
          provenance={{ arrival: group.fields.arrivalDate, departure: group.fields.departureDate }}
          onChange={(patch) => onPatch?.(group.id, patch)}
        />
        <FieldEvidence quotes={quotesFor('arrivalDate', evidence)} />
        <FieldEvidence quotes={quotesFor('departureDate', evidence)} />
      </Field>
      <Field
        label="Meal plan"
        required
        htmlFor={`${id}-board`}
        aside={<ProvenanceFlag value={group.fields.board} />}
      >
        <select
          id={`${id}-board`}
          aria-label="Meal plan"
          className={paneFieldClass}
          value={group.board}
          onChange={(event) => onPatch?.(group.id, { board: event.target.value as StayGroupRequirement['board'] })}
        >
          <option value="unknown">Not stated yet</option>
          <option value="room_only">Room only</option>
          <option value="bb">Bed &amp; breakfast</option>
          <option value="dinner_bb">Dinner, bed &amp; breakfast</option>
        </select>
        <FieldEvidence quotes={quotesFor('board', evidence)} />
      </Field>
      <Field label="Room type" htmlFor={`${id}-room`} aside={<ProvenanceFlag value={group.fields.roomPreference} />}>
        <select
          id={`${id}-room`}
          aria-label="Room type"
          className={paneFieldClass}
          value={group.roomPreference ?? ''}
          onChange={(event) => onPatch?.(group.id, { roomPreference: event.target.value })}
        >
          <option value="">Any room type — no stated preference</option>
          {group.roomPreference && !['STWN','STQN','SKNG','EXKNG','DLXTWN','DLXQN','DLXKNG','LUXKNG','SUITE'].includes(group.roomPreference) && <option value={group.roomPreference}>Email asked for {group.roomPreference} — pick a room type</option>}
          <option value="STWN">Standard Twin</option><option value="STQN">Standard Queen</option><option value="SKNG">Standard King</option>
          <option value="EXKNG">Executive King</option><option value="DLXTWN">Deluxe Twin</option><option value="DLXQN">Deluxe Queen</option>
          <option value="DLXKNG">Deluxe King</option><option value="LUXKNG">Luxury King</option><option value="SUITE">Suite</option>
        </select>
        <FieldEvidence quotes={quotesFor('roomPreference', evidence)} />
      </Field>
      <div className="overflow-hidden rounded-[3px] border border-[#cbd5e1]">
        <div className="flex items-center justify-between border-b border-[#e2e8f0] bg-[#f8fafc] px-2.5 py-[7px]">
          <span className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[#475569]">
            Rooms
            <ProvenanceFlag value={group.fields.quantity} />
          </span>
          <Stepper
            label={`Rooms for stay ${stayNumber}`}
            min={1}
            value={group.quantity ?? 0}
            onChange={(next) => onPatch?.(group.id, { quantity: next })}
          />
        </div>
        <div className="flex items-center justify-between bg-white px-2.5 py-2">
          <span className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[#475569]">
            Adults per room
            <ProvenanceFlag value={group.fields.adults} />
          </span>
          <Stepper
            label={`Adult guests per room for stay ${stayNumber}`}
            value={group.adults ?? 0}
            onChange={(next) => onPatch?.(group.id, { adults: next })}
          />
        </div>
        {/* The steppers are the controls staff use. These mirror the same patches for the field labels that existing
            tests and paste flows query, and stay out of the tab order and the accessibility tree. */}
        <input
          aria-hidden="true"
          tabIndex={-1}
          type="number"
          min={1}
          aria-label="Rooms"
          className="sr-only"
          value={group.quantity ?? ''}
          onChange={(event) => onPatch?.(group.id, { quantity: Number(event.target.value) })}
        />
        <input
          aria-hidden="true"
          tabIndex={-1}
          type="number"
          min={0}
          aria-label="Adults"
          className="sr-only"
          value={group.adults ?? ''}
          onChange={(event) => onPatch?.(group.id, { adults: Number(event.target.value) })}
        />
      </div>
      <FieldEvidence quotes={quotesFor('quantity', evidence)} />
      <FieldEvidence quotes={quotesFor('adults', evidence)} />
      <Field label="Children ages" htmlFor={`${id}-children`} hint="Separate ages with commas.">
        <input
          id={`${id}-children`}
          aria-label="Children ages"
          className={paneFieldClass}
          value={group.childrenAges.join(', ')}
          onChange={(event) => onPatch?.(group.id, { childrenAges: parseChildrenAges(event.target.value) })}
        />
        <FieldEvidence quotes={quotesFor('childrenAges', evidence)} />
      </Field>
      <Field label="Company or agency" htmlFor={`${id}-organisation`}>
        <input
          id={`${id}-organisation`}
          aria-label="Company or agency"
          className={paneFieldClass}
          value={group.organisation ?? ''}
          onChange={(event) => onPatch?.(group.id, { organisation: event.target.value })}
        />
        <FieldEvidence quotes={quotesFor('organisation', evidence)} />
      </Field>
      <Field label="Special requests" htmlFor={`${id}-requests`}>
        <textarea
          id={`${id}-requests`}
          className={paneTextareaClass}
          value={group.specialRequests.join('\n')}
          onChange={(event) =>
            onPatch?.(group.id, { specialRequests: event.target.value.split('\n').filter(Boolean) })
          }
        />
      </Field>
    </div>
  );
}
