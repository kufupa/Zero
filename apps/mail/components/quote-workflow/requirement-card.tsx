import { useId } from 'react';

import {
  Field,
  LinkButton,
  SecondaryButton,
  Stepper,
  paneFieldClass,
  paneTextareaClass,
} from '@/components/nava-pane/pane-ui';
import { ROOM_TYPE_CODES, knownRoomCode, roomTypeLabel } from '@/lib/quote-workflow/room-types';
import { newQuoteToken, parseChildrenAges, stayTotals } from '@/lib/quote-workflow/session';
import type { StayEditAction, StayGroupRequirement } from '@/lib/quote-workflow/types';

import { ProvenanceFlag, StayDateRange, type StayDatePatch } from './stay-date-range';

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
 * One stay: its dates over the rooms that make it. Each room is a block of its own, stacked under the dates, and the
 * stay has actions to add a room, duplicate it or remove it. A plain block: the caller wraps it in a section.
 */
export function StayCard({
  stayId,
  rows,
  index,
  stayCount,
  onPatch,
  onStayAction,
  evidence,
}: {
  stayId: string;
  rows: StayGroupRequirement[];
  index: number;
  /** A heading names each stay only when the request has more than one. */
  stayCount: number;
  onPatch?: (groupId: string, patch: Partial<StayGroupRequirement>) => void;
  onStayAction?: (action: StayEditAction) => void;
  evidence?: Array<{ field: string; quote: string; source?: 'staff_note' }>;
}) {
  const stayNumber = index + 1;
  const first = rows[0];
  const totals = stayTotals(rows);
  // The dates are one fact for the whole stay, so a change goes to every room in it.
  const onDates = (patch: StayDatePatch) => rows.forEach((row) => onPatch?.(row.id, patch));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        {stayCount > 1 ? <h4 className="text-[12px] font-bold text-[#475569]">Stay {stayNumber}</h4> : <span />}
        <div className="flex items-center gap-3">
          <LinkButton onClick={() => onStayAction?.({ type: 'duplicate_stay', stayId, token: newQuoteToken() })}>
            Duplicate stay
          </LinkButton>
          <LinkButton onClick={() => onStayAction?.({ type: 'remove_stay', stayId })}>Remove stay</LinkButton>
        </div>
      </div>
      <Field label="Dates of stay" required>
        <StayDateRange
          arrival={first?.arrivalDate ?? ''}
          departure={first?.departureDate ?? ''}
          provenance={{ arrival: first?.fields.arrivalDate, departure: first?.fields.departureDate }}
          onChange={onDates}
        />
        <FieldEvidence quotes={quotesFor('arrivalDate', evidence)} />
        <FieldEvidence quotes={quotesFor('departureDate', evidence)} />
      </Field>
      {rows.map((row, roomIndex) => (
        <RequirementCard
          key={row.id}
          group={row}
          stayNumber={stayNumber}
          roomNumber={roomIndex + 1}
          canRemove={rows.length > 1}
          onPatch={onPatch}
          onStayAction={onStayAction}
          evidence={evidence}
        />
      ))}
      <div className="flex items-center justify-between gap-2">
        <SecondaryButton onClick={() => onStayAction?.({ type: 'add_row', stayId, token: newQuoteToken() })}>
          Add room
        </SecondaryButton>
        {stayCount > 1 ? (
          <span className="text-[11.5px] text-[#475569]">
            {totals.rooms} {totals.rooms === 1 ? 'room' : 'rooms'} · {totals.guests} {totals.guests === 1 ? 'guest' : 'guests'}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One room of a stay: its type, rooms and adults per room, then the meal plan and guest details. A plain block: the
 * stay card stacks these under its dates.
 */
export function RequirementCard({
  group,
  stayNumber,
  roomNumber,
  canRemove,
  onPatch,
  onStayAction,
  evidence,
}: {
  group: StayGroupRequirement;
  stayNumber: number;
  roomNumber: number;
  /** A stay keeps one room. The last room goes only with its stay. */
  canRemove: boolean;
  onPatch?: (groupId: string, patch: Partial<StayGroupRequirement>) => void;
  onStayAction?: (action: StayEditAction) => void;
  evidence?: Array<{ field: string; quote: string; source?: 'staff_note' }>;
}) {
  const id = useId();
  const where = `stay ${stayNumber}, room ${roomNumber}`;
  // A value HMS does not know, e.g. one read from the email, stays visible until staff pick a room type.
  const knownCode = knownRoomCode(group.roomPreference);
  const unknownValue = group.roomPreference && !knownCode ? group.roomPreference : null;

  return (
    <div className="overflow-hidden rounded-[3px] border border-[#cbd5e1]">
      <div className="flex items-center justify-between border-b border-[#e2e8f0] bg-[#f8fafc] px-2.5 py-[7px]">
        <span className="text-[11.5px] font-semibold text-[#475569]">Room {roomNumber}</span>
        <div className="flex items-center gap-3">
          <LinkButton onClick={() => onStayAction?.({ type: 'duplicate_row', groupId: group.id, token: newQuoteToken() })}>
            Duplicate room
          </LinkButton>
          {canRemove ? (
            <LinkButton onClick={() => onStayAction?.({ type: 'remove_row', groupId: group.id })}>Remove room</LinkButton>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col gap-3 p-2.5">
        <Field label="Room type" required htmlFor={`${id}-room`} aside={<ProvenanceFlag value={group.fields.roomPreference} />}>
          <select
            id={`${id}-room`}
            aria-label="Room type"
            className={paneFieldClass}
            value={knownCode ?? unknownValue ?? ''}
            onChange={(event) => onPatch?.(group.id, { roomPreference: event.target.value })}
          >
            <option value="">Choose a room type</option>
            {unknownValue ? <option value={unknownValue}>Email asked for {unknownValue} — pick a room type</option> : null}
            {ROOM_TYPE_CODES.map((code) => (
              <option key={code} value={code}>
                {roomTypeLabel(code)}
              </option>
            ))}
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
              label={`Rooms for ${where}`}
              min={1}
              value={group.quantity ?? null}
              onChange={(next) => onPatch?.(group.id, { quantity: next })}
            />
          </div>
          <div className="flex items-center justify-between bg-white px-2.5 py-2">
            <span className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[#475569]">
              Adults per room
              <ProvenanceFlag value={group.fields.adults} />
            </span>
            <Stepper
              label={`Adult guests per room for ${where}`}
              value={group.adults ?? null}
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
    </div>
  );
}
