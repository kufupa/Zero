import { format, isValid, parseISO } from 'date-fns';
import { Copy, Info, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import {
  Field,
  LinkButton,
  SecondaryButton,
  Stepper,
  paneFieldClass,
  paneTextareaClass,
} from '@/components/nava-pane/pane-ui';
import {
  ROOM_TYPE_CODES,
  ROOM_TYPE_NAMES,
  knownRoomCode,
  rowRoomLabel,
  rowRoomTypeCode,
  type RoomTypeCode,
} from '@/lib/quote-workflow/room-types';
import { newQuoteToken, parseChildrenAges, stayTotals } from '@/lib/quote-workflow/session';
import type {
  QuoteBoard,
  QuotePaneBoard,
  QuotePaneRoomType,
  StayEditAction,
  StayGroupRequirement,
} from '@/lib/quote-workflow/types';

import { ProvenanceFlag, StayDateRange, type StayDatePatch } from './stay-date-range';

const FIELD_EVIDENCE_ALIASES: Record<string, string[]> = {
  arrivalDate: ['arrivalDate', 'arrival'],
  departureDate: ['departureDate', 'departure'],
  adults: ['adults', 'adultsPerRoom'],
  quantity: ['quantity', 'rooms'],
  roomPreference: ['roomPreference'],
  childrenAges: ['childrenAges', 'childAges'],
  board: ['board'],
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
        <p key={item.quote} className="font-normal text-[13px] text-[#64748b]">
          {item.quote}
        </p>
      ))}
    </>
  );
}

function stayHeaderDates(arrival: string | undefined, departure: string | undefined): string {
  if (!arrival || !departure) return 'Dates not set · pick both dates';
  const start = parseISO(arrival);
  const end = parseISO(departure);
  if (!isValid(start) || !isValid(end)) return 'Check the dates';
  const nights = (Date.parse(departure) - Date.parse(arrival)) / 86_400_000;
  if (nights <= 0) return 'Check the dates';
  const sameYear = start.getFullYear() === end.getFullYear();
  const sameMonth = sameYear && start.getMonth() === end.getMonth();
  const dates = sameMonth
    ? `${format(start, 'd')}–${format(end, 'd MMM yyyy')}`
    : sameYear
      ? `${format(start, 'd MMM')}–${format(end, 'd MMM yyyy')}`
      : `${format(start, 'd MMM yyyy')}–${format(end, 'd MMM yyyy')}`;
  return `${dates} · ${nights} ${nights === 1 ? 'night' : 'nights'}`;
}

function inferredMealPlan(rows: StayGroupRequirement[]): QuoteBoard | 'all' {
  const boards = new Set(rows.map((row) => row.board).filter((board) => board !== 'unknown'));
  return boards.size === 1 ? [...boards][0]! : 'all';
}

const DEFAULT_ROOM_TYPES: QuotePaneRoomType[] = ROOM_TYPE_CODES.map((code) => ({
  code,
  label: ROOM_TYPE_NAMES[code],
}));
const DEFAULT_PANE_BOARDS: QuotePaneBoard[] = ['room_only', 'bb', 'dinner_bb'];
const MEAL_PLAN_LABELS: Record<QuotePaneBoard, string> = {
  room_only: 'Room only',
  bb: 'Bed & breakfast',
  dinner_bb: 'Dinner, bed & breakfast',
};

function paneRoomTypeForGroup(
  group: StayGroupRequirement,
  roomTypes: readonly QuotePaneRoomType[],
): QuotePaneRoomType | null {
  const candidates = [
    ...(group.roomCodes?.length === 1 ? group.roomCodes : []),
    group.roomPreference ?? '',
    group.roomTypeCode ?? '',
  ].map((raw) => raw.trim());
  return roomTypes.find((room) =>
    candidates.some(
      (raw) =>
        raw.replace(/[^a-z0-9]/gi, '').toUpperCase() === room.code ||
        raw.toLowerCase().replace(/\s+/g, ' ') === room.label.toLowerCase(),
    ),
  ) ?? null;
}

function paneRoomLabel(
  group: StayGroupRequirement,
  roomTypes: readonly QuotePaneRoomType[],
  strictRoomTypes: boolean,
): string {
  const room = paneRoomTypeForGroup(group, roomTypes);
  if (!room && !strictRoomTypes) return rowRoomLabel(group);
  const label = room?.label ?? 'Room type needed';
  const count = typeof group.quantity === 'number' && group.quantity > 0 ? group.quantity : '?';
  return `${label} ×${count}`;
}

/**
 * One stay: the dates, meal-plan display filter, room types and occupancy for this date range. Its HMS request and
 * rates are attached by the parent under Rates, so those shared controls appear only once.
 */
export function StayCard({
  stayId,
  rows,
  index,
  stayCount,
  requestedRoomsTotal,
  mealPlan,
  onMealPlanChange,
  onPatch,
  onStayAction,
  evidence,
  roomTypes: configuredRoomTypes,
  boards: configuredBoards,
}: {
  stayId: string;
  rows: StayGroupRequirement[];
  index: number;
  stayCount: number;
  /** The email's stay-level room total, retained when the extracted rows are split by type. */
  requestedRoomsTotal?: number;
  /** This UI-only filter highlights returned rate cards; it never patches a room row. */
  mealPlan?: QuoteBoard | 'all';
  onMealPlanChange?: (value: QuoteBoard | 'all') => void;
  onPatch?: (groupId: string, patch: Partial<StayGroupRequirement>) => void;
  onStayAction?: (action: StayEditAction) => void;
  evidence?: Array<{ field: string; quote: string; source?: 'staff_note' }>;
  roomTypes?: QuotePaneRoomType[];
  boards?: QuotePaneBoard[];
}) {
  const id = useId();
  const stayNumber = index + 1;
  const first = rows[0];
  const roomTypes = configuredRoomTypes ?? DEFAULT_ROOM_TYPES;
  const strictRoomTypes = configuredRoomTypes !== undefined;
  const boards = configuredBoards ?? DEFAULT_PANE_BOARDS;
  const totals = stayTotals(rows);
  const splitNotSet = requestedRoomsTotal !== undefined && rows.some((row) => row.quantity == null);
  const selectedMealPlan = mealPlan ?? inferredMealPlan(rows);
  // The dates are one fact for the whole stay, so a change goes to every room in it.
  const onDates = (patch: StayDatePatch) => rows.forEach((row) => onPatch?.(row.id, patch));

  return (
    <article aria-label={`Stay ${stayNumber} details`} className="overflow-hidden rounded-[4px] border border-[#cbd5e1] bg-white">
      <header className="flex flex-col gap-1.5 border-b border-[#dbe5f0] bg-[#f5f9ff] px-3 py-2.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <h4 className="text-[13px] font-bold leading-5 text-[#1e293b]">
              {`Stay ${stayNumber} of ${stayCount} · ${stayHeaderDates(first?.arrivalDate, first?.departureDate)}`}
            </h4>
            <span className="group relative inline-flex">
              <button
                type="button"
                aria-label="Stay information"
                aria-describedby={`${id}-stay-info`}
                title="One stay = one date range = one HMS booking."
                className="rounded-[3px] text-[#64748b] hover:text-[#1e293b] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066cc]"
              >
                <Info aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
              <span
                id={`${id}-stay-info`}
                role="tooltip"
                className="absolute left-0 top-full z-10 hidden w-56 rounded-[3px] bg-[#1e293b] px-2 py-1 text-[12px] font-normal leading-4 text-white shadow-md group-hover:block group-focus-within:block"
              >
                One stay = one date range = one HMS booking.
              </span>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              title="Create another stay with the same dates and rooms."
              className="inline-flex items-center gap-1 rounded-[3px] text-[13px] font-semibold text-[#0066cc] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066cc]"
              onClick={() => onStayAction?.({ type: 'duplicate_stay', stayId, token: newQuoteToken() })}
            >
              <Copy aria-hidden="true" className="h-3.5 w-3.5" />
              Copy stay
            </button>
            <button
              type="button"
              title="Remove this stay and its room types."
              className="inline-flex items-center gap-1 rounded-[3px] text-[13px] font-semibold text-[#0066cc] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066cc]"
              onClick={() => onStayAction?.({ type: 'remove_stay', stayId })}
            >
              <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              Remove
            </button>
          </div>
        </div>
        <p className="text-[13px] font-semibold text-[#1e293b]">
          {splitNotSet
            ? `${requestedRoomsTotal} rooms requested · split not set`
            : `${totals.rooms} ${totals.rooms === 1 ? 'room' : 'rooms'} · ${totals.guests} ${totals.guests === 1 ? 'guest' : 'guests'} total`}
          {!splitNotSet && requestedRoomsTotal !== undefined && requestedRoomsTotal !== totals.rooms ? (
            <span className="ml-1 font-normal text-[#64748b]">{`· Email requested ${requestedRoomsTotal} rooms in total`}</span>
          ) : null}
        </p>
      </header>

      <div className="flex flex-col gap-3.5 p-3">
        <Field label="Dates" required>
          <StayDateRange
            arrival={first?.arrivalDate ?? ''}
            departure={first?.departureDate ?? ''}
            provenance={{ arrival: first?.fields.arrivalDate, departure: first?.fields.departureDate }}
            onChange={onDates}
          />
          <FieldEvidence quotes={quotesFor('arrivalDate', evidence)} />
          <FieldEvidence quotes={quotesFor('departureDate', evidence)} />
        </Field>

        <Field
          label="Meal plan"
          htmlFor={`${id}-meal-plan`}
          aside={<ProvenanceFlag value={first?.fields.board} />}
          hint="Highlights matching rates below. This display filter does not change or send the HMS search."
        >
          <select
            id={`${id}-meal-plan`}
            aria-label="Meal plan"
            className={paneFieldClass}
            value={selectedMealPlan}
            onChange={(event) => onMealPlanChange?.(event.target.value as QuoteBoard | 'all')}
          >
            <option value="all">All meal plans</option>
            {boards.map((board) => (
              <option key={board} value={board}>{MEAL_PLAN_LABELS[board]}</option>
            ))}
            {first?.board && first.board !== 'unknown' && !boards.includes(first.board) ? (
              <option value={first.board} disabled>
                {`${MEAL_PLAN_LABELS[first.board]} (not offered at this hotel)`}
              </option>
            ) : null}
            {first?.board === 'unknown' ? <option value="unknown">Not stated in email</option> : null}
          </select>
          <FieldEvidence quotes={quotesFor('board', evidence)} />
        </Field>

        <section aria-label="Room types and occupancy" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-1">
            <h5 className="text-[13px] font-bold text-[#1e293b]">Room types &amp; occupancy</h5>
          </div>
          <div role="table" aria-label="Room types & occupancy" className="overflow-hidden rounded-[3px] border border-[#dbe2ea]">
            <div role="rowgroup" className="flex flex-col divide-y divide-[#e2e8f0]">
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
                  roomTypes={roomTypes}
                  strictRoomTypes={strictRoomTypes}
                />
              ))}
            </div>
          </div>
          <SecondaryButton className="self-start" onClick={() => onStayAction?.({ type: 'add_row', stayId, token: newQuoteToken() })}>
            + Add room type
          </SecondaryButton>
        </section>
      </div>
    </article>
  );
}

/** One independent room-type and occupancy row in the stay table. */
export function RequirementCard({
  group,
  stayNumber,
  roomNumber,
  canRemove,
  onPatch,
  onStayAction,
  evidence,
  roomTypes,
  strictRoomTypes,
}: {
  group: StayGroupRequirement;
  stayNumber: number;
  roomNumber: number;
  canRemove: boolean;
  onPatch?: (groupId: string, patch: Partial<StayGroupRequirement>) => void;
  onStayAction?: (action: StayEditAction) => void;
  evidence?: Array<{ field: string; quote: string; source?: 'staff_note' }>;
  roomTypes: QuotePaneRoomType[];
  strictRoomTypes: boolean;
}) {
  const id = useId();
  const where = `stay ${stayNumber}, room ${roomNumber}`;
  const selectedRoom = paneRoomTypeForGroup(group, roomTypes);
  const selectedCode = selectedRoom?.code ?? (strictRoomTypes ? null : rowRoomTypeCode(group));
  const unknownValue = group.roomPreference && !selectedCode ? group.roomPreference : null;
  const suggestions = (group.roomTypeSuggestions ?? [])
    .filter((code) => !strictRoomTypes || roomTypes.some((room) => room.code === code))
    .slice(0, 3);
  const roomSelect = useRef<HTMLSelectElement>(null);
  const [editingAdults, setEditingAdults] = useState(false);
  const hasOptionalDetails = group.childrenAges.length > 0 || group.specialRequests.length > 0;
  const [showOptionalDetails, setShowOptionalDetails] = useState(hasOptionalDetails);
  const hadOptionalDetails = useRef(hasOptionalDetails);
  useEffect(() => {
    if (!hadOptionalDetails.current && hasOptionalDetails) setShowOptionalDetails(true);
    hadOptionalDetails.current = hasOptionalDetails;
  }, [hasOptionalDetails]);

  function chooseRoomType(value: string) {
    const code: RoomTypeCode | null = knownRoomCode(value);
    const isConfiguredRoom = roomTypes.some((room) => room.code === value);
    onPatch?.(group.id, {
      roomPreference: value,
      roomTypeCode: code ?? undefined,
      roomTypeSuggestions: code || isConfiguredRoom ? [] : group.roomTypeSuggestions,
      roomCodes: undefined,
      rateCode: undefined,
    });
  }

  const adultsText =
    group.adults == null
      ? 'Adults per room not set'
      : `${group.adults} ${group.adults === 1 ? 'adult' : 'adults'} per room`;

  const displayName = paneRoomLabel(group, roomTypes, strictRoomTypes);

  return (
    <div role="row" aria-label={displayName} data-room-index={roomNumber} className="flex flex-col gap-2.5 bg-white p-2.5">
      <div role="rowheader" className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-bold text-[#334155]">{displayName}</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            title="Duplicate this room type and occupancy."
            className="inline-flex items-center gap-1 rounded-[3px] text-[13px] font-semibold text-[#0066cc] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066cc]"
            onClick={() => onStayAction?.({ type: 'duplicate_row', groupId: group.id, token: newQuoteToken() })}
          >
            <Copy aria-hidden="true" className="h-3.5 w-3.5" />
            Copy room
          </button>
          {canRemove ? (
            <button
              type="button"
              title="Remove this room type."
              className="inline-flex items-center gap-1 rounded-[3px] text-[13px] font-semibold text-[#0066cc] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066cc]"
              onClick={() => onStayAction?.({ type: 'remove_row', groupId: group.id })}
            >
              <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              Remove
            </button>
          ) : null}
        </div>
      </div>
      <div role="cell" className="grid grid-cols-2 gap-2">
        <div className="min-w-0">
          <Field
            label="Room type"
            required
            htmlFor={`${id}-room`}
            aside={<ProvenanceFlag value={group.fields.roomPreference} />}
          >
            <select
              id={`${id}-room`}
              ref={roomSelect}
              aria-label="Room type"
              aria-invalid={!selectedCode || undefined}
              className={`${paneFieldClass} ${selectedCode ? '' : 'border-[#c01823] focus:border-[#c01823] focus:ring-1 focus:ring-[#c01823]'}`}
              value={selectedCode ?? unknownValue ?? ''}
              onChange={(event) => chooseRoomType(event.target.value)}
            >
              <option value="">Choose room type</option>
              {unknownValue ? <option value={unknownValue}>Email request</option> : null}
              {roomTypes.map(({ code, label }) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
            {unknownValue && suggestions.length ? (
              <div
                role="group"
                aria-label="Room type suggestions"
                className="flex min-w-0 flex-wrap items-center gap-1 text-[12px] text-[#1e3a8a]"
              >
                <span className="mr-0.5">{`Email said '${unknownValue}' →`}</span>
                {suggestions.map((code) => (
                  <button
                    key={code}
                    type="button"
                    className="rounded-full border border-[#93c5fd] bg-white px-2 py-0.5 text-[11.5px] font-semibold text-[#0066cc] hover:bg-[#eff6ff]"
                    onClick={() => chooseRoomType(code)}
                  >
                    {roomTypeLabel(code).replace(/\s+\([A-Z]+\)$/, '')}
                  </button>
                ))}
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  aria-label="Choose other room type"
                  className="rounded-[3px] text-[11.5px] font-semibold text-[#0066cc] hover:underline"
                  onClick={() => roomSelect.current?.focus()}
                >
                  other…
                </button>
              </div>
            ) : null}
            <FieldEvidence quotes={quotesFor('roomPreference', evidence)} />
          </Field>
        </div>

        <div className="flex min-w-0 flex-col gap-1">
          <span
            role="group"
            aria-label={`Rooms${group.fields.quantity ? `, ${group.fields.quantity === 'extracted' ? 'from email' : group.fields.quantity === 'staff_corrected' ? 'your note' : group.fields.quantity === 'missing' ? 'missing' : 'default'}` : ''}`}
            className="flex flex-wrap items-center gap-1 text-[13px] font-semibold text-[#475569]"
          >
            <span>Rooms</span>
            <ProvenanceFlag value={group.fields.quantity} />
          </span>
          <Stepper
            label={`Rooms for ${where}`}
            min={1}
            value={group.quantity ?? null}
            onChange={(next) => onPatch?.(group.id, { quantity: next })}
          />
          {/* Keeps the compact stepper discoverable to existing paste and form tooling. */}
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
          <FieldEvidence quotes={quotesFor('quantity', evidence)} />
        </div>
        <div className="col-span-2 flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-1 text-[13px] font-semibold text-[#475569]">
            <span>{adultsText}</span>
            <ProvenanceFlag value={group.fields.adults} />
          </span>
          {editingAdults ? (
            <div className="flex flex-col gap-1">
              <Stepper
                label={`Adult guests per room for ${where}`}
                min={1}
                max={9}
                value={group.adults ?? null}
                onChange={(next) => onPatch?.(group.id, { adults: next })}
              />
              <LinkButton onClick={() => setEditingAdults(false)}>Done</LinkButton>
            </div>
          ) : (
            <button
              type="button"
              aria-label={`Edit adults per room for ${where}`}
              className="self-start text-left text-[13px] font-semibold text-[#0066cc] hover:underline"
              onClick={() => setEditingAdults(true)}
            >
              Tap to edit
            </button>
          )}
          <FieldEvidence quotes={quotesFor('adults', evidence)} />
        </div>
      </div>

      <div role="cell" className="flex flex-col gap-1">
        <button
          type="button"
          aria-expanded={showOptionalDetails}
          className="self-start rounded-[3px] text-[13px] font-semibold text-[#0066cc] hover:underline"
          onClick={() => setShowOptionalDetails((open) => !open)}
        >
          {showOptionalDetails ? '− Children / requests' : '+ Children / requests'}
        </button>
        {showOptionalDetails ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
            <Field label="Special requests" htmlFor={`${id}-requests`}>
              <textarea
                id={`${id}-requests`}
                aria-label="Special requests"
                className={`${paneTextareaClass} min-h-[2.75rem]`}
                value={group.specialRequests.join('\n')}
                onChange={(event) =>
                  onPatch?.(group.id, { specialRequests: event.target.value.split('\n').filter(Boolean) })
                }
              />
            </Field>
          </div>
        ) : null}
      </div>
    </div>
  );
}
