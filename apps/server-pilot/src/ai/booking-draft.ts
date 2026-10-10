import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareRateClaim, type RateComparison } from '../quote-proposal/rate-check.js';
import type { Board, QuoteRevision } from '../quote-proposal/quote-revision.js';
import type { RowPrice } from '../quote-proposal/quote-lines.js';
import type { LunaAnalysis } from './reservationist-decision.js';

export type BookingDraftDefaults = {
  track: string | null;
  sourceOfBusiness: string | null;
  guaranteeType: string | null;
};

export type BookingDraftMissing = { field: string; question: string };

/** The quoted board in the pane's meal-plan vocabulary. */
export type QuotedBoard = 'room_only' | 'bb' | 'dinner_bb' | 'unknown';

export type BookingDraftRoom = {
  groupId: string;
  roomIndex: number;
  /** The board the approved quote uses, so staff copy the meal plan that matches the rate. */
  board: QuotedBoard;
  request: Record<string, unknown>;
  schemaErrors: string[];
};

export type BookingDraft = {
  rooms: BookingDraftRoom[];
  rateCheck: Array<RateComparison & { claimQuote: string; assumedTaxBasis: boolean }>;
  missing: BookingDraftMissing[];
  flags: string[];
};

const TITLE = /\b(?:Mr|Mrs|Ms|Miss|Dr|Prof)\b\.?/gi;

export function splitGuestName(raw: string): { firstName: string; lastName: string } {
  const tokens = raw
    .replace(TITLE, ' ')
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (tokens.length === 0) return { firstName: '', lastName: '' };
  return { firstName: tokens.slice(0, -1).join(' '), lastName: tokens.at(-1)! };
}

function guestQuestion(roomIndex?: number): string {
  return roomIndex != null ? `Guest name for room ${roomIndex}?` : 'Guest name for this booking?';
}

function partyFromContext(
  context: Record<string, unknown>,
): { kind: 'agency' | 'organization'; name: string } | null {
  const agency = context.agency as { name?: string } | undefined;
  if (typeof agency?.name === 'string' && agency.name.trim()) {
    return { kind: 'agency', name: agency.name };
  }
  const organization = context.organization as { name?: string } | undefined;
  if (typeof organization?.name === 'string' && organization.name.trim()) {
    return { kind: 'organization', name: organization.name };
  }
  return null;
}

export function requestFromQuotedRoom(input: {
  arrival: string;
  departure: string;
  adults: number;
  childAges: number[];
  roomCode: string;
  rateCode: string;
  party: { kind: 'agency' | 'organization'; name: string } | null;
  guestName: string | null;
  defaults: BookingDraftDefaults;
  roomIndex?: number;
}): { request: Record<string, unknown>; missing: BookingDraftMissing[] } {
  const request: Record<string, unknown> = {
    arrival: input.arrival,
    departure: input.departure,
    adults: input.adults,
    childAges: [...input.childAges],
    roomType: input.roomCode,
    ratePlan: input.rateCode,
  };
  const missing: BookingDraftMissing[] = [];
  const questions: Record<keyof BookingDraftDefaults, string> = {
    track: 'Track for this booking?',
    sourceOfBusiness: 'Source of business for this booking?',
    guaranteeType: 'Guarantee type for this booking?',
  };
  for (const field of ['track', 'sourceOfBusiness', 'guaranteeType'] as const) {
    const value = input.defaults[field];
    if (value == null) missing.push({ field, question: questions[field] });
    else request[field] = value;
  }
  if (input.party) request[input.party.kind] = input.party.name;
  if (input.guestName?.trim()) {
    const names = splitGuestName(input.guestName);
    if (names.firstName) request.firstName = names.firstName;
    if (names.lastName) request.lastName = names.lastName;
    if (!names.firstName || !names.lastName) {
      missing.push({ field: 'guestName', question: guestQuestion(input.roomIndex) });
    }
  } else {
    missing.push({ field: 'guestName', question: guestQuestion(input.roomIndex) });
  }
  return { request, missing };
}

function normalizeClaimAmount(raw: string): { amount: string; precision: number } {
  const amount = raw.replace(/ZAR/gi, '').replace(/R/gi, '').replace(/,/g, '').replace(/\s/g, '');
  const fraction = amount.split('.')[1];
  return { amount, precision: fraction?.length ?? 0 };
}

function quotedBoard(board: Board): QuotedBoard {
  if (board === 'room_only') return 'room_only';
  if (board === 'breakfast') return 'bb';
  if (board === 'dinner_bed_breakfast') return 'dinner_bb';
  return 'unknown';
}

/**
 * The revision's rooms at their approved prices. A saved, one-off or override row charges its own rate on every night, so a
 * client's rate claim is checked against the rate the quote sent, not HMS's.
 */
function pricedGroups(revision: QuoteRevision, rowPrices: readonly RowPrice[]): QuoteRevision['groups'] {
  return revision.groups.map((group) => {
    const price = rowPrices.find((row) => row.groupId === group.id);
    if (!price) return group;
    return {
      ...group,
      nightly: group.nightly.map((night) => ({ ...night, amountMinor: price.amountMinor })),
      perRoomMinor: price.amountMinor * group.nightly.length,
      totalMinor: price.amountMinor * group.nightly.length * group.quantity,
    };
  });
}

function comparisonTarget(revision: QuoteRevision, rowPrices: readonly RowPrice[], extraTotalMinor = 0) {
  const groups = pricedGroups(revision, rowPrices);
  return {
    currency: revision.currency,
    basis: 'per_room_per_night' as const,
    scopeDigest: revision.scopeDigest,
    taxBasis: groups.every(
      (group) => group.inclusions.vat === 'included' && group.inclusions.levy === 'included',
    )
      ? ('gross_included' as const)
      : ('unknown' as const),
    nightlyMinor:
      groups.length === 1
        ? groups[0]!.nightly.map((night) => night.amountMinor)
        : groups.flatMap((group) =>
            group.nightly.flatMap((night) =>
              Array.from({ length: group.quantity }, () => night.amountMinor),
            ),
          ),
    quantity: groups.length === 1 ? groups[0]!.quantity : 1,
    totalMinor: groups.reduce((sum, group) => sum + group.totalMinor, 0) + extraTotalMinor,
  };
}

function checkRateClaim(
  claim: LunaAnalysis['rateClaims'][number],
  revision: QuoteRevision,
  messageId: string,
  rowPrices: readonly RowPrice[],
  extraTotalMinor = 0,
): RateComparison & { claimQuote: string; assumedTaxBasis: boolean } {
  const assumedTaxBasis = claim.taxBasis === 'unknown';
  const { amount, precision } = normalizeClaimAmount(claim.amount);
  const rooms = comparisonTarget(revision, rowPrices);
  const target =
    claim.basis === 'total' || claim.kind === 'total'
      ? {
          currency: rooms.currency,
          basis: 'total' as const,
          scopeDigest: rooms.scopeDigest,
          taxBasis: rooms.taxBasis,
          totalMinor: rooms.totalMinor + extraTotalMinor,
        }
      : rooms;
  const comparison = compareRateClaim(
    {
      kind: claim.kind,
      amount,
      currency: claim.currency,
      basis: claim.basis,
      scopeDigest: revision.scopeDigest,
      taxBasis: assumedTaxBasis ? 'gross_included' : claim.taxBasis,
      source: { ref: messageId, page: 1, quote: claim.quote || claim.amount },
      precision,
    },
    target,
  );
  return { ...comparison, claimQuote: claim.quote || claim.amount, assumedTaxBasis };
}

async function defaultValidateCreate(
  request: Record<string, unknown>,
): Promise<{ ok: boolean; errors: unknown[] }> {
  const mod = (await import(
    pathToFileURL(
      fileURLToPath(new URL('../../tooling/playwright-quote/create-request.mjs', import.meta.url)),
    ).href
  )) as {
    loadCreateToolSchema(): Promise<unknown>;
    normalizeCreateLabels(data: unknown): unknown;
    validateCreateRequest(
      data: unknown,
      schema: unknown,
    ): { ok: boolean; errors: unknown[] };
  };
  return mod.validateCreateRequest(
    mod.normalizeCreateLabels(request),
    await mod.loadCreateToolSchema(),
  );
}

export function createRequestFieldOptions(): {
  track: string[];
  sourceOfBusiness: string[];
  guaranteeType: string[];
  roomType: string[];
} {
  const schema = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../tooling/playwright-quote/create-tool.schema.json', import.meta.url)),
      'utf8',
    ),
  ) as {
    $defs: {
      request: {
        properties: {
          track: { enum: string[] };
          sourceOfBusiness: { enum: string[] };
          guaranteeType: { enum: string[] };
          roomType: { enum: string[] };
        };
      };
    };
  };
  const props = schema.$defs.request.properties;
  return {
    track: props.track.enum,
    sourceOfBusiness: props.sourceOfBusiness.enum,
    guaranteeType: props.guaranteeType.enum,
    roomType: props.roomType.enum,
  };
}

export async function buildBookingDrafts(input: {
  analysis: LunaAnalysis;
  revision: QuoteRevision;
  defaults: BookingDraftDefaults;
  messageId: string;
  /** Authorised extras only. Room prices staff set come in rowPrices. */
  extraTotalMinor?: number;
  /** The row prices the quote's approval recorded. */
  rowPrices?: readonly RowPrice[];
  validate?: (
    request: Record<string, unknown>,
  ) => Promise<{ ok: boolean; errors: unknown[] }>;
}): Promise<BookingDraft> {
  const revision = structuredClone(input.revision);
  const validate = input.validate ?? defaultValidateCreate;
  const rooms: BookingDraftRoom[] = [];
  const missing: BookingDraftMissing[] = [];
  for (const [gi, group] of revision.groups.entries()) {
    const lunaGroup =
      input.analysis.groups.find(
        (row) => row.arrival === group.arrivalDate && row.departure === group.departureDate,
      ) ?? input.analysis.groups[gi];
    const names = lunaGroup?.guestNames ?? [];
    const party = partyFromContext(group.context);
    for (let roomIndex = 1; roomIndex <= group.quantity; roomIndex++) {
      const guestName = names[roomIndex - 1] ?? (roomIndex === 1 ? names[0] : undefined) ?? null;
      const built = requestFromQuotedRoom({
        arrival: group.arrivalDate,
        departure: group.departureDate,
        adults: group.adults,
        childAges: group.childAges,
        roomCode: group.roomCode,
        rateCode: group.rateCode,
        party,
        guestName,
        defaults: input.defaults,
        roomIndex,
      });
      const result = await validate(built.request);
      rooms.push({
        groupId: group.id,
        roomIndex,
        board: quotedBoard(group.board),
        request: built.request,
        schemaErrors: result.ok ? [] : result.errors.map((error) => String(error)),
      });
      missing.push(...built.missing);
    }
  }
  const uniqueMissing = [
    ...new Map(missing.map((item) => [`${item.field}\0${item.question}`, item])).values(),
  ];
  const flags: string[] = [];
  const asked = input.analysis.party;
  if (
    (asked.kind === 'organization' || asked.kind === 'government') &&
    asked.name &&
    !revision.groups.some((group) => group.context && 'organization' in group.context)
  ) {
    flags.push('party_rate_not_applied');
  }
  // The create tool books at the HMS rate plan and cannot set an amount, so a row priced by staff needs its rate changed in HMS.
  const rowPrices = input.rowPrices ?? [];
  if (rowPrices.length) flags.push('manual_rate_change');
  const roomCodes = new Set(revision.groups.map((group) => group.roomCode));
  if (revision.groups.length > 1 && roomCodes.size > 1) {
    flags.push('joint_inventory_unproven');
  }
  const lunaStayKeys = new Set(
    input.analysis.groups.map((group) => `${group.arrival}:${group.departure}`),
  );
  const stayUnclear = lunaStayKeys.size > 1;
  return {
    rooms,
    rateCheck: input.analysis.rateClaims.map((claim) => {
      const compared = checkRateClaim(claim, revision, input.messageId, rowPrices, input.extraTotalMinor ?? 0);
      return stayUnclear ? { ...compared, status: 'cannot_check' as const, reason: 'ambiguous_stay' } : compared;
    }),
    missing: uniqueMissing,
    flags,
  };
}
