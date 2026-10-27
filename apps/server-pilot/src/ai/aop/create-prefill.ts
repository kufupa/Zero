import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  createRequestFieldOptions,
  splitGuestName,
  type BookingDraftDefaults,
  type BookingDraftMissing,
} from '../booking-draft.js';
import { matchRoomType } from '../room-types.js';
import { dayFromText } from '../voucher-find.js';

/** Direct individual booking: HMS Labtest read-back. Skip when an agency/company party is set. */
export const DIRECT_BOOKING_DEFAULTS = {
  track: 'BAR',
  sourceOfBusiness: 'Walk in',
  guaranteeType: 'Non-Guaranteed Individual',
} as const;

const roomSchema = z.object({
  adults: z.number().int(),
  childAges: z.array(z.number().int()),
  roomTypeText: z.string().nullable(),
  guestName: z.string().nullable(),
});

export const buildCreatePrefillInputSchema = z.object({
  arrival: z.string(),
  departure: z.string().nullable(),
  nights: z.number().int().nullable(),
  rooms: z.array(roomSchema),
  boardText: z.string().nullable(),
  rateText: z.string().nullable(),
  agencyName: z.string().nullable(),
  organizationName: z.string().nullable(),
  voucherNumber: z.string().nullable(),
  bookerName: z.string().nullable(),
  bookerEmail: z.string().nullable(),
  billingReference: z.string().nullable(),
  paidBy: z.enum(['agency', 'guest', 'company']).nullable(),
  partyKind: z.enum(['agency', 'organization', 'government']).nullable().optional(),
  defaults: z.object({
    track: z.string().nullable(),
    sourceOfBusiness: z.string().nullable(),
    guaranteeType: z.string().nullable(),
  }),
  propertyCode: z.string().min(1).optional(),
});

export const buildCreatePrefillOutputSchema = z.object({
  requests: z.array(z.record(z.string(), z.unknown())),
  missing: z.array(z.object({ field: z.string(), question: z.string() })),
  schemaErrors: z.array(z.array(z.string())),
  todoNextStep: z.string(),
});

export type BuildCreatePrefillInput = z.input<typeof buildCreatePrefillInputSchema>;
export type BuildCreatePrefillOutput = z.infer<typeof buildCreatePrefillOutputSchema>;
export type { BookingDraftDefaults, BookingDraftMissing };

export const buildCreatePrefillDescription =
  'Build HMS create-form requests for a new stay after findFirstStayMatch returned none. Call with the stay facts already read from the mail/voucher plus BookingDraftDefaults. Maps free text to enum codes only by exact case/space-insensitive match; never guesses. Output.requests is one create-tool request per room; missing holds staff questions; todoNextStep is the Key into HMS line.';

const NATIVE_RATE_CODE = /^[A-Z0-9]{2,10}$/;

function foldToken(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function matchEnum(text: string | null | undefined, options: readonly string[]): string | null {
  if (text == null) return null;
  const folded = foldToken(text);
  if (!folded) return null;
  return options.find((option) => foldToken(option) === folded) ?? null;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function isoDay(value: string | null | undefined): string | null {
  const text = trimmed(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const utc = Date.parse(`${text}T00:00:00Z`);
    if (Number.isFinite(utc) && new Date(utc).toISOString().slice(0, 10) === text) return text;
  }
  return dayFromText(text);
}

function addNights(arrival: string, nights: number): string | null {
  if (!Number.isInteger(nights) || nights < 1) return null;
  const utc = Date.parse(`${arrival}T00:00:00Z`);
  if (!Number.isFinite(utc)) return null;
  return new Date(utc + nights * 86_400_000).toISOString().slice(0, 10);
}

function uniqueMissing(items: BookingDraftMissing[]): BookingDraftMissing[] {
  return [...new Map(items.map((item) => [`${item.field}\0${item.question}`, item])).values()];
}

function todoNextStep(missing: BookingDraftMissing[]): string {
  const fields = [...new Set(missing.map((item) => item.field))];
  if (fields.length === 0) return 'Key into HMS';
  return `Key into HMS: missing ${fields.join(', ')}`;
}

function guestQuestion(roomCount: number, roomIndex: number): string {
  return roomCount > 1 ? `Guest name for room ${roomIndex}?` : 'Guest name for this booking?';
}

function roomTypeQuestion(roomCount: number, roomIndex: number): string {
  return roomCount > 1 ? `Room type code for room ${roomIndex}?` : 'Room type code for this booking?';
}

type CreateRequestMod = {
  loadCreateToolSchema(): Promise<unknown>;
  normalizeCreateLabels(data: unknown): unknown;
  validateCreateRequest(
    data: unknown,
    schema: unknown,
  ): { ok: boolean; errors: unknown[] };
};

let createRequestMod: Promise<CreateRequestMod> | null = null;

function loadCreateRequest(): Promise<CreateRequestMod> {
  createRequestMod ??= import(
    pathToFileURL(
      fileURLToPath(new URL('../../../tooling/playwright-quote/create-request.mjs', import.meta.url)),
    ).href
  ) as Promise<CreateRequestMod>;
  return createRequestMod;
}

async function validateCreate(request: Record<string, unknown>): Promise<string[]> {
  const mod = await loadCreateRequest();
  const result = mod.validateCreateRequest(
    mod.normalizeCreateLabels(request),
    await mod.loadCreateToolSchema(),
  );
  return result.ok ? [] : result.errors.map((error) => String(error));
}

function optionalText(
  value: string | null | undefined,
  maxLength: number,
): { value: string } | { missing: true } | { skip: true } {
  const text = trimmed(value);
  if (!text) return { skip: true };
  if (text.length > maxLength) return { missing: true };
  return { value: text };
}

export async function buildCreatePrefill(
  input: BuildCreatePrefillInput,
): Promise<BuildCreatePrefillOutput> {
  const parsed = buildCreatePrefillInputSchema.parse(input);
  const options = createRequestFieldOptions(parsed.propertyCode);
  const missing: BookingDraftMissing[] = [];
  const arrival = isoDay(parsed.arrival);
  if (!arrival) missing.push({ field: 'arrival', question: 'Arrival date for this booking?' });
  const departure = arrival
    ? (isoDay(parsed.departure) ?? addNights(arrival, parsed.nights ?? 0))
    : null;
  if (!departure) missing.push({ field: 'departure', question: 'Departure date for this booking?' });

  const partySet = Boolean(
    trimmed(parsed.agencyName) ||
      trimmed(parsed.organizationName) ||
      parsed.partyKind === 'agency' ||
      parsed.partyKind === 'organization' ||
      parsed.partyKind === 'government',
  );
  const fallback = partySet ? null : DIRECT_BOOKING_DEFAULTS;
  const track = matchEnum(parsed.defaults.track ?? fallback?.track, options.track);
  if (!track) missing.push({ field: 'track', question: 'Track for this booking?' });
  const sourceOfBusiness = matchEnum(
    parsed.defaults.sourceOfBusiness ?? fallback?.sourceOfBusiness,
    options.sourceOfBusiness,
  );
  if (!sourceOfBusiness) {
    missing.push({ field: 'sourceOfBusiness', question: 'Source of business for this booking?' });
  }
  const guaranteeType = matchEnum(
    parsed.defaults.guaranteeType ?? fallback?.guaranteeType,
    options.guaranteeType,
  );
  if (!guaranteeType) {
    missing.push({ field: 'guaranteeType', question: 'Guarantee type for this booking?' });
  }

  // ratePlan is a native HMS code (BAR, BARRO, BWEBB), not an enum; prose like "Best Available Rate" goes to missing.
  const rateText = trimmed(parsed.rateText);
  const ratePlan = rateText && NATIVE_RATE_CODE.test(rateText) ? rateText : rateText ? null : 'BAR';
  if (!ratePlan) missing.push({ field: 'ratePlan', question: 'Rate plan code for this booking?' });

  const shared: Record<string, unknown> = {};
  if (arrival) shared.arrival = arrival;
  if (departure) shared.departure = departure;
  if (track) shared.track = track;
  if (sourceOfBusiness) shared.sourceOfBusiness = sourceOfBusiness;
  if (guaranteeType) shared.guaranteeType = guaranteeType;
  if (ratePlan) shared.ratePlan = ratePlan;

  const agency = trimmed(parsed.agencyName);
  if (agency) shared.agency = agency;
  const organization = trimmed(parsed.organizationName);
  if (organization) shared.organization = organization;

  const voucher = trimmed(parsed.voucherNumber);
  const billing = trimmed(parsed.billingReference);
  if (voucher) shared.billingReference = voucher;
  else if (billing) shared.billingReference = billing;

  const bookerName = optionalText(parsed.bookerName, 50);
  if ('value' in bookerName) shared.bookerName = bookerName.value;
  else if ('missing' in bookerName) {
    missing.push({ field: 'bookerName', question: 'Booker name for this booking?' });
  }
  const bookerEmail = optionalText(parsed.bookerEmail, 80);
  if ('value' in bookerEmail) shared.bookerEmail = bookerEmail.value;
  else if ('missing' in bookerEmail) {
    missing.push({ field: 'bookerEmail', question: 'Booker email for this booking?' });
  }

  const roomCount = parsed.rooms.length;
  if (roomCount === 0) missing.push({ field: 'rooms', question: 'How many rooms, and who is in each?' });

  const requests: Record<string, unknown>[] = parsed.rooms.map((room, index) => {
    const roomIndex = index + 1;
    const request: Record<string, unknown> = {
      ...shared,
      adults: room.adults,
      childAges: [...room.childAges],
    };
    const mapped = matchRoomType(room.roomTypeText ?? undefined, parsed.propertyCode).code;
    const roomType =
      matchEnum(room.roomTypeText, options.roomType) ??
      (mapped && options.roomType.includes(mapped) ? mapped : null);
    if (roomType) request.roomType = roomType;
    else missing.push({ field: 'roomType', question: roomTypeQuestion(roomCount, roomIndex) });

    const guestName = trimmed(room.guestName);
    if (guestName) {
      const names = splitGuestName(guestName);
      if (names.firstName) request.firstName = names.firstName;
      if (names.lastName) request.lastName = names.lastName;
      if (!names.firstName || !names.lastName) {
        missing.push({ field: 'guestName', question: guestQuestion(roomCount, roomIndex) });
      }
    } else {
      missing.push({ field: 'guestName', question: guestQuestion(roomCount, roomIndex) });
    }
    return request;
  });

  const unique = uniqueMissing(missing);
  const schemaErrors = await Promise.all(requests.map((request) => validateCreate(request)));
  return {
    requests,
    missing: unique,
    schemaErrors,
    todoNextStep: todoNextStep(unique),
  };
}
