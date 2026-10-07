import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareRateClaim, type RateComparison } from '../quote-proposal/rate-check.js';
import type { QuoteRevision } from '../quote-proposal/quote-revision.js';
import type { LunaAnalysis } from './reservationist-decision.js';

export type BookingDraftDefaults = {
  track: string | null;
  sourceOfBusiness: string | null;
  guaranteeType: string | null;
};

export type BookingDraftMissing = { field: string; question: string };

export type BookingDraftRoom = {
  groupId: string;
  roomIndex: number;
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

function comparisonTarget(revision: QuoteRevision) {
  const groups = revision.groups;
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
    totalMinor: groups.reduce((sum, group) => sum + group.totalMinor, 0),
  };
}

function checkRateClaim(
  claim: LunaAnalysis['rateClaims'][number],
  revision: QuoteRevision,
  messageId: string,
): RateComparison & { claimQuote: string; assumedTaxBasis: boolean } {
  const assumedTaxBasis = claim.taxBasis === 'unknown';
  const { amount, precision } = normalizeClaimAmount(claim.amount);
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
    comparisonTarget(revision),
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
  validate?: (
    request: Record<string, unknown>,
  ) => Promise<{ ok: boolean; errors: unknown[] }>;
}): Promise<BookingDraft> {
  const revision = structuredClone(input.revision);
  const validate = input.validate ?? defaultValidateCreate;
  const rooms: BookingDraftRoom[] = [];
  const missing: BookingDraftMissing[] = [];
  for (const [gi, group] of revision.groups.entries()) {
    const names = input.analysis.groups[gi]?.guestNames ?? [];
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
  const roomCodes = new Set(revision.groups.map((group) => group.roomCode));
  if (revision.groups.length > 1 && roomCodes.size > 1) {
    flags.push('joint_inventory_unproven');
  }
  return {
    rooms,
    rateCheck: input.analysis.rateClaims.map((claim) =>
      checkRateClaim(claim, revision, input.messageId),
    ),
    missing: uniqueMissing,
    flags,
  };
}
