import { mailExtractionPayloadSchema } from './extraction/schema.js';
import { addDays } from './stay-date-anchoring.js';
import { applyPartyBindRule, buildPartyMatchCandidates, type PartyMatchRow } from './party-match-v2.js';
import { matchRoomType } from './room-types.js';
import { staffQuoteInput, type StaffQuoteInput, type StaffQuoteParties } from './staff-quote-workflow.js';

export type PreparedStaffQuoteStay = {
  stayId: string;
  input?: StaffQuoteInput;
  reason?: string;
};

export type PreparedStaffQuotePlan = {
  inputs: StaffQuoteInput[];
  stays: PreparedStaffQuoteStay[];
  reason: string | null;
  partyBound: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const HMS_CONFIRMATION = /^\d{6,10}-\d{1,2}$/;
const CONFIRMATION_IN_TEXT = /(?<![\d-])\d{6,10}-\d{1,2}(?![\d-])/g;

function payloadHasConfirmation(payload: Record<string, unknown> | null): boolean {
  const values = payload?.confirmationNumbers;
  return Array.isArray(values) && values.some((value) => typeof value === 'string' && value.trim().length > 0);
}

function subjectHasConfirmation(subject: string): boolean {
  CONFIRMATION_IN_TEXT.lastIndex = 0;
  return CONFIRMATION_IN_TEXT.test(subject) || HMS_CONFIRMATION.test(subject.trim());
}

/** Quote extractions always admit. New-booking extractions admit only a single stay with no confirmation number. */
export function quotePrepareKindReason(input: {
  kind: string | null | undefined;
  payload: unknown;
  subject?: string | null;
}): 'not_quote' | null {
  if (input.kind === 'quote') return null;
  if (input.kind !== 'booking') return 'not_quote';
  const payload = record(input.payload);
  const stays = payload?.stays;
  if (!Array.isArray(stays) || stays.length !== 1) return 'not_quote';
  if (payloadHasConfirmation(payload) || subjectHasConfirmation(input.subject ?? '')) return 'not_quote';
  return null;
}

function validIsoDay(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function nightsBetween(arrival: string, departure: string): number {
  return (Date.parse(`${departure}T00:00:00.000Z`) - Date.parse(`${arrival}T00:00:00.000Z`)) / 86_400_000;
}

/** Twin / 2 beds with no staff pick → Standard Twin. Unique names (Deluxe Twin) still win via matchRoomType. */
function unpickedTwinRoomCode(roomType: string | undefined): 'STWN' | undefined {
  if (!roomType) return undefined;
  const text = roomType.normalize('NFKD').toLowerCase();
  if (/\btwin\b/.test(text) || /\b(?:2|two)\s*beds?\b/.test(text)) return 'STWN';
  return undefined;
}

function groupForStay(
  stay: NonNullable<ReturnType<typeof mailExtractionPayloadSchema.parse>['stays'][number]>,
  today: string,
  missing: ReadonlyArray<{ field: string }> = [],
): { groups: StaffQuoteInput['groups']; reason?: string } {
  const { arrival } = stay.requested;
  const reversedStayDates = missing.some((item) => item.field === 'stayDates');
  const departure =
    stay.requested.departure ||
    (!reversedStayDates && validIsoDay(arrival) ? addDays(arrival, 1) : null);
  if (!arrival || !departure) {
    return { groups: [], reason: reversedStayDates ? 'invalid_dates' : 'missing_dates' };
  }
  if (!validIsoDay(arrival) || !validIsoDay(departure) || departure <= arrival) {
    return { groups: [], reason: 'invalid_dates' };
  }
  if (arrival < today) return { groups: [], reason: 'past_dates' };
  if (nightsBetween(arrival, departure) > 30) return { groups: [], reason: 'stay_too_long' };
  if (stay.rows.length === 0) return { groups: [], reason: 'missing_rooms' };
  if (stay.rows.length > 8) return { groups: [], reason: 'too_many_room_types' };

  const groups: StaffQuoteInput['groups'] = [];
  for (const row of stay.rows) {
    const recordedQuantity = row.rooms ?? (stay.rows.length === 1 ? stay.totalRooms : null);
    // Only a real guest signal (before defaults) justifies assuming one room.
    const hasGuestData = row.adultsPerRoom !== null || row.childAges.length > 0;
    const quantity = recordedQuantity ?? (hasGuestData ? 1 : null);
    if (!row.id || row.id.length > 64 || !Number.isInteger(quantity) || quantity === null || quantity < 1 || quantity > 100) {
      return { groups: [], reason: 'missing_rooms' };
    }
    const adults = row.adultsPerRoom ?? 2;
    if (
      !Number.isInteger(adults) ||
      adults < 1 ||
      adults > 6 ||
      row.childAges.length > 6 ||
      row.childAges.some((age) => !Number.isInteger(age) || age < 0 || age > 17)
    ) {
      return { groups: [], reason: 'missing_occupancy' };
    }
    const roomType = row.roomType?.trim();
    const roomMatch = roomType ? matchRoomType(roomType) : null;
    const roomCode = roomMatch?.code ?? unpickedTwinRoomCode(roomType);
    groups.push({
      id: row.id,
      arrivalDate: arrival,
      departureDate: departure,
      quantity,
      adults,
      childrenAges: row.childAges,
      board: row.board === 'room_only' ? 'room_only' : row.board === 'dbb' ? 'dinner_bb' : 'bb',
      ...(roomCode ? { roomCodes: [roomCode] } : {}),
    });
  }
  return { groups };
}

/** Re-apply the V2 safety rule; a model/fallback pick alone is never enough to carry a contract party. */
export function confidentPartyFromV2Result(input: {
  payload: unknown;
  fromAddress?: string | null;
  subject?: string | null;
  body?: string | null;
  quoteLlmParty?: unknown;
  allowLearnedSenderHistory?: boolean;
  result: unknown;
}): StaffQuoteParties | undefined {
  const result = record(input.result);
  const bound = record(result?.boundParty);
  if (
    result?.matchVersion !== 2 ||
    result.matchStatus !== 'bound' ||
    result.confidence !== 'high' ||
    result.truncated !== false ||
    !bound ||
    (bound.kind !== 'company' && bound.kind !== 'agency') ||
    typeof bound.nativeId !== 'string' ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(bound.nativeId) ||
    typeof bound.name !== 'string' ||
    !bound.name.trim() ||
    bound.name.length > 256 ||
    !Array.isArray(result.results) ||
    result.results.length > 25 ||
    (result.pickSource !== 'llm' && result.pickSource !== 'fallback')
  ) {
    return undefined;
  }
  const rows: PartyMatchRow[] = [];
  for (const candidate of result.results) {
    const row = record(candidate);
    if (
      !row ||
      (row.kind !== 'company' && row.kind !== 'agency') ||
      typeof row.nativeId !== 'string' ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(row.nativeId) ||
      typeof row.name !== 'string' ||
      !row.name.trim() ||
      row.name.length > 256
    ) {
      return undefined;
    }
    rows.push({ kind: row.kind, nativeId: row.nativeId, name: row.name });
  }
  const picked = rows.find(
    (row) => row.kind === bound.kind && row.nativeId === bound.nativeId && row.name === bound.name,
  );
  if (!picked) return undefined;

  const candidates = buildPartyMatchCandidates({
    payload: input.payload,
    fromAddress: input.fromAddress,
    subject: input.subject,
    body: input.body,
    quoteLlmParty: input.quoteLlmParty,
    allowLearnedSenderHistory: input.allowLearnedSenderHistory,
  });
  const decision = applyPartyBindRule({
    candidates,
    rows,
    pick: {
      pickNativeId: picked.nativeId,
      kind: picked.kind,
      confidence: 'high',
      reason: typeof result.reason === 'string' ? result.reason : 'Confident V2 party match.',
      alternatives: [],
      source: result.pickSource,
    },
    truncated: false,
  });
  if (decision.matchStatus !== 'bound' || !decision.boundParty) return undefined;
  const { kind, nativeId, name } = decision.boundParty;
  const party = { kind, nativeId, name };
  const parties = kind === 'company' ? { company: party } : { agency: party };
  const parsed = staffQuoteInput.shape.parties.safeParse(parties);
  return parsed.success && Object.keys(parsed.data ?? {}).length ? parsed.data : undefined;
}

/** Builds the only fields a background quote may infer from a successful quote extraction. */
export function buildPreparedStaffQuotePlan(input: {
  messageId: string;
  sourceHash: string;
  payload: unknown;
  parties?: StaffQuoteParties;
  now?: Date;
}): PreparedStaffQuotePlan {
  const parsedPayload = mailExtractionPayloadSchema.safeParse(input.payload);
  if (!parsedPayload.success || !input.messageId || !/^[a-f0-9]{64}$/.test(input.sourceHash)) {
    return { inputs: [], stays: [], reason: 'invalid_extraction', partyBound: false };
  }
  const payload = parsedPayload.data;
  const today = (input.now ?? new Date()).toISOString().slice(0, 10);
  const stays: PreparedStaffQuoteStay[] = payload.stays.map((stay) => {
    const groupResult = groupForStay(stay, today, payload.missing);
    if (groupResult.reason) return { stayId: stay.id, reason: groupResult.reason };
    const built = staffQuoteInput.safeParse({
      messageId: input.messageId,
      sourceHash: input.sourceHash,
      selectionEpoch: 0,
      inputRevision: 0,
      groups: groupResult.groups,
      salesStrategy:
        groupResult.groups.some((group) => group.board === 'dinner_bb') ? 'Government' : 'BAR',
      company: payload.endClient ?? '',
      agency: payload.agency ?? '',
      attention: payload.contact.name ?? '',
      clientEmail: payload.contact.email ?? '',
      clientTelephone: payload.contact.phone ?? '',
      ...(input.parties ? { parties: input.parties } : {}),
    });
    return built.success
      ? { stayId: stay.id, input: built.data }
      : { stayId: stay.id, reason: 'invalid_quote_input' };
  });
  const inputs = stays.flatMap((stay) => (stay.input ? [stay.input] : []));
  return {
    inputs,
    stays,
    reason: inputs.length ? null : stays[0]?.reason ?? 'missing_stay',
    partyBound: Boolean(input.parties && Object.keys(input.parties).length),
  };
}

function priceShape(input: StaffQuoteInput): unknown {
  return {
    groups: input.groups.map((group) => ({
      id: group.id,
      arrivalDate: group.arrivalDate,
      departureDate: group.departureDate,
      quantity: group.quantity,
      adults: group.adults,
      childrenAges: group.childrenAges,
      board: group.board,
      roomCodes: [...(group.roomCodes ?? [])].sort(),
      rateCode: group.rateCode ?? null,
    })),
    salesStrategy: input.salesStrategy,
    parties: input.parties ?? null,
    rowPrices: input.rowPrices ?? null,
    dinnerAllowanceMinor: input.dinnerAllowanceMinor ?? null,
    dinnerAllowanceUnit: input.dinnerAllowanceUnit ?? null,
    dinnerAllowanceGroupIds: input.dinnerAllowanceGroupIds ?? null,
    lunchAllowanceMinor: input.lunchAllowanceMinor ?? null,
    officeTransferMinor: input.officeTransferMinor ?? null,
    officeTransferDays: input.officeTransferDays ?? null,
    shuttleRequested: input.shuttleRequested ?? null,
    shuttleMinor: input.shuttleMinor ?? null,
    shuttleTrips: input.shuttleTrips ?? null,
    other: input.other ?? null,
  };
}

/** Pane counters and display headers do not affect a price; row identity, stay terms and paid extras do. */
export function staffQuoteInputsPriceEquivalent(left: StaffQuoteInput, right: StaffQuoteInput): boolean {
  return JSON.stringify(priceShape(left)) === JSON.stringify(priceShape(right));
}
