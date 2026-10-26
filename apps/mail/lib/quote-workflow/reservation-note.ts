import { currentStayRun, stayKeyForGroup } from './session';
import { PANE_RESERVATION_NOTE_MAX } from './pane-stay-bind';
import {
  HRCEN_PROPERTY_CODE,
  HRDAV_PROPERTY_CODE,
  staffHeaderFieldProblem,
  staffStayExtrasFor,
  type AvailabilityBoardRow,
  type DinnerAddOnUnit,
  type QuoteRoomRateBoardSelection,
  type QuoteSession,
  type RowPriceChoice,
  type StaffQuoteOtherUnit,
  type StaffRowRate,
  type StaffStayExtras,
  type StayGroupRequirement,
} from './types';

const KNOWN_PROPERTY_CODES = new Set<string>([HRDAV_PROPERTY_CODE, HRCEN_PROPERTY_CODE]);
const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type ReservationNoteInput = {
  propertyCode: string | null | undefined;
  stay: Pick<StayGroupRequirement, 'arrivalDate' | 'departureDate' | 'quantity'>;
  selection: QuoteRoomRateBoardSelection;
  availability: AvailabilityBoardRow;
  chargedRate: StaffRowRate;
  rowPrice?: RowPriceChoice;
  extras: StaffStayExtras;
  currency: string;
  officeTransferMinor?: number;
  officeTransferDays?: number;
};

type NoteExtra = { label: string; amountMinor: number; unit?: string; count?: number };

const DINNER_UNITS: Record<DinnerAddOnUnit, string> = {
  per_person_per_night: 'per person per night',
  per_room_per_night: 'per room per night',
  per_person: 'per person',
};
const OTHER_UNITS: Record<StaffQuoteOtherUnit, string> = {
  per_person_night: 'per person per night',
  per_person: 'per person',
  per_trip: 'per trip',
  item: 'per item',
};

function positiveMinor(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0;
}

function validDate(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}

function dateText(time: number): string {
  const date = new Date(time);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function money(minor: number, currency: string): string {
  return `${currency} ${(minor / 100).toFixed(2)}`;
}

function validMinorList(values: number[], nights: number): boolean {
  return values.length === nights && values.every(positiveMinor);
}

function noteExtras(input: ReservationNoteInput, nights: number): NoteExtra[] | null {
  const { extras } = input;
  if (Object.values(extras.fieldErrors ?? {}).some(Boolean)) return null;
  const result: NoteExtra[] = [];
  if (extras.shuttleEnabled) {
    const trips = extras.shuttleTrips ?? 1;
    if (!positiveMinor(extras.shuttleMinor) || !Number.isSafeInteger(trips) || trips < 1) return null;
    result.push({ label: 'Shuttle', amountMinor: extras.shuttleMinor, unit: trips === 1 ? 'trip' : 'trips', count: trips });
  }
  if (extras.lunchEnabled) {
    if (!positiveMinor(extras.lunchAllowanceMinor)) return null;
    result.push({ label: extras.lunchAllowanceLabel?.trim() || 'Lunch allowance', amountMinor: extras.lunchAllowanceMinor });
  }
  if (extras.dinnerAllowanceRequired && !extras.dinnerEnabled) return null;
  if (extras.dinnerEnabled) {
    const unit = extras.dinnerAllowanceUnit && DINNER_UNITS[extras.dinnerAllowanceUnit];
    if (!positiveMinor(extras.dinnerAllowanceMinor) || !unit) return null;
    result.push({
      label: extras.dinnerAllowanceLabel?.trim() || 'Dinner allowance',
      amountMinor: extras.dinnerAllowanceMinor,
      unit,
    });
  }
  if (extras.otherEnabled) {
    const other = extras.other;
    const unit = other && OTHER_UNITS[other.unit];
    if (!other || !positiveMinor(other.amountMinor) || !other.label.trim() || !unit) return null;
    result.push({ label: other.label.trim(), amountMinor: other.amountMinor, unit });
  }
  if (input.officeTransferMinor !== undefined) {
    if (!positiveMinor(input.officeTransferMinor)) return null;
    const days = input.officeTransferDays ?? nights;
    if (!Number.isSafeInteger(days) || days < 1) return null;
    result.push({
      label: 'Office transfer',
      amountMinor: input.officeTransferMinor,
      unit: `per person per day × ${days} ${days === 1 ? 'day' : 'days'}`,
    });
  }
  return result;
}

/** Return null unless the selected tuple and every displayed price/extra are complete and agree. */
export function formatReservationNote(input: ReservationNoteInput): string | null {
  if (!input.propertyCode || !KNOWN_PROPERTY_CODES.has(input.propertyCode)) return null;
  const { stay, selection, availability, chargedRate } = input;
  if (
    !selection.roomCode.trim() ||
    !selection.rateCode.trim() ||
    (selection.board !== 'room_only' && selection.board !== 'bb' && selection.board !== 'dinner_bb')
  ) return null;
  const arrival = validDate(stay.arrivalDate);
  const departure = validDate(stay.departureDate);
  if (arrival === null || departure === null || departure <= arrival) return null;
  const nights = (departure - arrival) / DAY_MS;
  const quantity = stay.quantity;
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1) return null;
  if (!/^[A-Z]{3}$/.test(input.currency)) return null;
  if (
    availability.groupId !== chargedRate.groupId ||
    availability.roomCode !== selection.roomCode ||
    availability.rateCode !== selection.rateCode ||
    availability.board !== selection.board ||
    !positiveMinor(availability.nightlyPriceMinor ?? undefined) ||
    !availability.roomLabel.trim() ||
    !availability.rateLabel.trim() ||
    !availability.boardLabel.trim()
  ) return null;
  if (
    !validMinorList(chargedRate.hmsNightlyMinor, nights) ||
    !validMinorList(chargedRate.nightlyMinor, nights) ||
    chargedRate.hmsNightlyMinor.some((amount) => amount !== availability.nightlyPriceMinor)
  ) return null;
  if (input.rowPrice) {
    if (chargedRate.source !== input.rowPrice.source) return null;
    if (input.rowPrice.source === 'override' && chargedRate.rateCode !== input.rowPrice.rateCode) return null;
    if (input.rowPrice.source === 'saved' && !(chargedRate.customRateName?.trim() || input.rowPrice.name.trim())) return null;
  } else if (chargedRate.source !== 'hms') {
    return null;
  }
  if (chargedRate.source !== 'override' && chargedRate.rateCode && chargedRate.rateCode !== selection.rateCode) return null;

  const extras = noteExtras(input, nights);
  if (!extras) return null;
  const roomName = availability.roomLabel.trim();
  const roomCode = selection.roomCode.trim();
  const rateName = availability.rateLabel.trim();
  const boardName = availability.boardLabel.trim();
  const chargedByNight = chargedRate.nightlyMinor;
  const uniquePrice = chargedByNight.every((amount) => amount === chargedByNight[0]);
  const lines = [
    `Stay: ${dateText(arrival)} to ${dateText(departure)} (${nights} nights)`,
    `Room: ${roomName} (${roomCode}) ×${quantity}`,
    `Rate: ${selection.rateCode} — ${rateName}, ${boardName}`,
  ];
  if (chargedRate.source === 'saved') {
    const savedName = input.rowPrice?.source === 'saved' ? input.rowPrice.name.trim() : '';
    lines.push(`Price source: Saved rate — ${chargedRate.customRateName?.trim() || savedName}`);
  } else if (chargedRate.source === 'one_off') {
    lines.push('Price source: One-off rate');
  } else if (chargedRate.source === 'override') {
    lines.push(`Price source: Override — ${chargedRate.rateCode}`);
    if (chargedRate.note?.trim()) lines.push(`Authorised by: ${chargedRate.note.trim()}`);
  }
  lines.push(
    uniquePrice
      ? `Charged: ${money(chargedByNight[0]!, input.currency)} per night`
      : `Charged per night: ${chargedByNight.map((amount) => money(amount, input.currency)).join('; ')}`,
  );
  for (const extra of extras) {
    const count = extra.count ? ` × ${extra.count} ${extra.unit}` : extra.unit ? ` ${extra.unit}` : '';
    lines.push(`${extra.label}: ${money(extra.amountMinor, input.currency)}${count}`);
  }
  const note = lines.join('\n');
  return note.length <= PANE_RESERVATION_NOTE_MAX ? note : null;
}

/** Build from this group's current run only; a missing or stale value leaves the existing manual note path intact. */
export function reservationNoteForGroup(
  session: QuoteSession,
  propertyCode: string | null | undefined,
  groupId: string,
): string | null {
  const group = session.groups.find((item) => item.id === groupId);
  if (!group) return null;
  const stayKey = stayKeyForGroup(group);
  const run = currentStayRun(session, stayKey);
  const selection = session.roomRateBoardSelections?.[groupId];
  if (!run || !selection || staffHeaderFieldProblem(session.staffHeader, stayKey)) return null;
  const matches = (row: { groupId: string; roomCode: string; rateCode: string; board: string }) =>
    row.groupId === groupId &&
    row.roomCode === selection.roomCode &&
    row.rateCode === selection.rateCode &&
    row.board === selection.board;
  const available = run.availabilityBoard?.filter(matches) ?? [];
  const charged = run.rowRates?.filter((row) => row.groupId === groupId) ?? [];
  if (available.length !== 1 || charged.length !== 1) return null;
  return formatReservationNote({
    propertyCode,
    stay: group,
    selection,
    availability: available[0]!,
    chargedRate: charged[0]!,
    rowPrice: group.rowPrice,
    extras: staffStayExtrasFor(session.staffHeader, stayKey),
    currency: run.currency,
    officeTransferMinor: session.staffHeader.officeTransferMinor,
    officeTransferDays: session.staffHeader.officeTransferDays,
  });
}
