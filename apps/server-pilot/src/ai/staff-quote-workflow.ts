import {
  quoteDigest,
  occupiedDates,
  resolveQuoteRevision,
  type QuoteRevision,
} from '../quote-proposal/quote-revision.js';
import type {
  NativeQuoteRequest,
  createReservationistBusinessServices,
} from './reservationist-business-services.js';
import type { ReservationistExecutionServices } from './reservationist-execution.js';
import type { RevisionProposalHeader } from '../quote-proposal/proposal-pdf.js';
import {
  deriveAuthorizedExtraLines,
  deriveQuoteLines,
  type AuthorizedProposalFacts,
  type RowPrice,
} from '../quote-proposal/quote-lines.js';
import { quoteRateContextEnabled } from './quote-rate-switch.js';
import { PARTY_NO_CONTRACT_CODE, PARTY_SEARCH_INCOMPLETE_CODE, isPartyRateFailure } from './party-rate-failure.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const groupSchema = z
  .object({
    id: z.string().min(1).max(64),
    arrivalDate: z.string(),
    departureDate: z.string(),
    quantity: z.number().int().min(1).max(100),
    adults: z.number().int().min(1).max(6),
    childrenAges: z.array(z.number().int().min(0).max(17)).max(6).default([]),
    board: z.enum(['room_only', 'bb', 'dinner_bb']),
    roomCodes: z
      .array(z.string().regex(/^[A-Z0-9_-]{1,16}$/))
      .min(1)
      .max(8)
      .optional(),
    // The rate card the staff pinned, re-run with exactly this HMS rate code. A contract code prices only with its verified party.
    rateCode: z.string().regex(/^[A-Z0-9_-]{1,16}$/).optional(),
  })
  .strict();
/** How an "other" charge multiplies: per guest per night, per guest, per trip, or once as an item. */
export const OTHER_CHARGE_UNITS = ['per_person_night', 'per_person', 'per_trip', 'item'] as const;
export type OtherChargeUnit = (typeof OTHER_CHARGE_UNITS)[number];
const staffLabel = z.string().trim().max(120);
/** Largest accepted amount for one extra unit: R1,000,000 in cents. Keeps every total far from unsafe integers. */
export const MAX_EXTRA_AMOUNT_MINOR = 100_000_000;
const extraAmount = z.number().int().positive().max(MAX_EXTRA_AMOUNT_MINOR);
/**
 * Staff row prices (KTD6). A row with no entry is priced by HMS. A saved rate is named by id only: the server reads its name
 * and amount. An override needs its rate code, its per-night rate and a note saying who approved it and why.
 */
export const staffRowPriceInput = z.discriminatedUnion('source', [
  z
    .object({ groupId: z.string().min(1).max(64), source: z.literal('saved'), customRateId: z.string().uuid() })
    .strict(),
  z
    .object({ groupId: z.string().min(1).max(64), source: z.literal('one_off'), oneOffRate: extraAmount })
    .strict(),
  z
    .object({
      groupId: z.string().min(1).max(64),
      source: z.literal('override'),
      rateCode: z.string().regex(/^[A-Z0-9_-]{1,16}$/),
      overrideRate: extraAmount,
      note: z.string().trim().min(1, 'The override needs a note: who approved it and why').max(500),
    })
    .strict(),
]);
export type StaffRowPriceInput = z.infer<typeof staffRowPriceInput>;
/** Prices, native party IDs and qualification flags are deliberately not client inputs. */
/** The HMS id a picked party carries: plain characters, as HMS shows them. */
const partyNativeId = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const pickedCompany = z
  .object({ kind: z.literal('company'), nativeId: partyNativeId, name: z.string().min(1).max(256) })
  .strict();
const pickedAgency = z
  .object({ kind: z.literal('agency'), nativeId: partyNativeId, name: z.string().min(1).max(256) })
  .strict();
/**
 * The company and agency staff picked with Find in HMS. Both may be picked on one quote. The server re-checks each
 * one in HMS before any rate is bound to it (verifyPartyPick), so a client-sent id is never trusted on its own.
 */
export const staffQuoteParties = z
  .object({ company: pickedCompany.optional(), agency: pickedAgency.optional() })
  .strict();
export type StaffQuoteParties = z.infer<typeof staffQuoteParties>;

export const staffQuoteInput = z
  .object({
    messageId: z.string().min(1),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    selectionEpoch: z.number().int().nonnegative(),
    inputRevision: z.number().int().nonnegative(),
    groups: z.array(groupSchema).min(1).max(8),
    salesStrategy: z.enum(['BAR', 'Government']).default('BAR'),
    company: z.string().max(256).default(''),
    agency: z.string().max(256).default(''),
    attention: z.string().max(256).default(''),
    clientEmail: z.string().max(256).default(''),
    clientTelephone: z.string().max(128).default(''),
    // Staff-typed extras. Every amount is ZAR minor units and must be positive; absent means not charged.
    dinnerAllowanceMinor: extraAmount.optional(),
    dinnerAllowanceLabel: staffLabel.optional(),
    dinnerAllowanceUnit: z.enum(['per_person_per_night', 'per_room_per_night', 'per_person']).optional(),
    // Staff-approved dinner charge scope. Omitted on a manual dinner charge means every group.
    dinnerAllowanceGroupIds: z.array(z.string().min(1).max(64)).max(8).optional(),
    lunchAllowanceMinor: extraAmount.optional(),
    lunchAllowanceLabel: staffLabel.optional(),
    officeTransferMinor: extraAmount.optional(),
    officeTransferDays: z.number().int().min(1).max(31).optional(),
    shuttleRequested: z.boolean().optional(),
    shuttleMinor: extraAmount.optional(),
    shuttleTrips: z.number().int().min(1).max(50).optional(),
    other: z
      .object({
        // A blank label is kept, not rejected: the amount then raises a review item instead of vanishing.
        label: z.string().trim().max(120).default(''),
        amountMinor: extraAmount,
        unit: z.enum(OTHER_CHARGE_UNITS),
      })
      .strict()
      .optional(),
    /** Unpriced staff note, printed on the quotation as a note. */
    notes: z.string().trim().max(1000).optional(),
    // The HMS company and/or agency the pane's Find in HMS picker chose. Absent means public rates, as before.
    parties: staffQuoteParties.optional(),
    // Row prices staff chose instead of HMS's nightly rate. Part of the approved input digest, so an approval binds them.
    rowPrices: z.array(staffRowPriceInput).max(8).optional(),
  })
  .strict();
export type StaffQuoteInput = z.infer<typeof staffQuoteInput>;

export type StaffQuoteDinnerAddOn = {
  amountMinor: number;
  unit: 'per_person_per_night' | 'per_room_per_night' | 'per_person';
  label: string;
};

/** Retry metadata for dinner groups changed to B&B; approved dinner-charge scope stays on the input. */
export function staffQuoteDinnerFallback(
  input: StaffQuoteInput,
  requestedGroupIds?: readonly string[],
): {
  input: StaffQuoteInput;
  groupIds: string[];
} | null {
  const requested = requestedGroupIds === undefined ? null : new Set(requestedGroupIds);
  const groupIds = input.groups
    .filter((group) => group.board === 'dinner_bb' && (!requested || requested.has(group.id)))
    .map((group) => group.id);
  if (!groupIds.length) return null;
  const selected = new Set(groupIds);
  return {
    groupIds,
    input: {
      ...input,
      groups: input.groups.map((group) => {
        if (!selected.has(group.id)) return { ...group };
        const fallbackGroup = { ...group, board: 'bb' as const };
        delete fallbackGroup.rateCode;
        return fallbackGroup;
      }),
    },
  };
}

export type StaffQuoteRates = 'party' | 'public';
export type PartyRateRef = { nativeId: string; name: string };
export type PartyRateContext = { organization?: PartyRateRef; agency?: PartyRateRef };

/**
 * The rate context for picked parties. A company is the organization, an agency is the agency: both when both were
 * picked. Nothing else is sent, so no commission or A/R account reaches the quote.
 */
export function partyRateContext(parties: StaffQuoteParties | undefined): PartyRateContext | undefined {
  const context: PartyRateContext = {};
  if (parties?.company) context.organization = { nativeId: parties.company.nativeId, name: parties.company.name };
  if (parties?.agency) context.agency = { nativeId: parties.agency.nativeId, name: parties.agency.name };
  return Object.keys(context).length ? context : undefined;
}

export function partyNames(parties: StaffQuoteParties | undefined): string[] {
  return [parties?.company?.name, parties?.agency?.name].filter((name): name is string => Boolean(name));
}

/** The public rate codes. Any other row is a contract row only when HMS flags it as negotiated; its name never decides. */
const PUBLIC_RATE_CODES: ReadonlySet<string> = new Set(['BAR', 'BARRO']);
export function isPublicRateCode(code: string): boolean {
  return PUBLIC_RATE_CODES.has(code);
}

/** The review note when a party quote priced public rates because HMS flags no contract row for the party. */
export function partyNoContractNote(names: readonly string[]): string {
  return `No contract rate found for ${names.join(' and ')}; this quote uses our best available rate.`;
}

/**
 * The review note for a party quote whose revision has no contract row, so it priced public rates. Null when a contract
 * row was priced, or when no party was picked.
 */
export function partyContractReviewNote(
  parties: StaffQuoteParties | undefined,
  groups: readonly { rateCode: string }[],
): string | null {
  if (!parties) return null;
  return groups.some((group) => !isPublicRateCode(group.rateCode)) ? null : partyNoContractNote(partyNames(parties));
}

/** Public dinner-board prices are replaced by B&B plus the separate dinner add-on. A verified party contract keeps its existing rate. */
export function staffQuoteDinnerGroupIdsToRetryAsBb(
  input: StaffQuoteInput,
  rateOptions: readonly { groupId: string; selected: boolean; contract: boolean; rateCode: string }[],
): string[] {
  const dinnerGroupIds = input.groups.filter((group) => group.board === 'dinner_bb').map((group) => group.id);
  if (!input.parties) return dinnerGroupIds;
  const verifiedContractGroupIds = new Set(
    rateOptions.filter((option) => option.selected && option.contract).map((option) => option.groupId),
  );
  return dinnerGroupIds.filter((id) => !verifiedContractGroupIds.has(id));
}

export { isPartyRateFailure, PartyRateFailure } from './party-rate-failure.js';

/** The review note for a quote that fell back to public rates because HMS could not apply the contract rate. */
export function partyRateFallbackNote(names: readonly string[]): string {
  return `HMS couldn't apply the contract rate for ${names.join(' and ')}, so these are public rates. Check in HMS.`;
}

/** The review note when HMS could not confirm the picked party's contract rates. The quote is public and says so. */
export function partyUnconfirmedNote(names: readonly string[]): string {
  return `Nava couldn't confirm contract rates for ${names.join(' and ')} — this quote uses our best available rate. Check HMS before sending.`;
}

/** The note a public retry carries. A complete no-contract retry has none: its review note on the public groups says so. */
function fallbackNote(code: unknown, names: readonly string[]): string | null {
  if (code === PARTY_NO_CONTRACT_CODE) return null;
  if (code === PARTY_SEARCH_INCOMPLETE_CODE) return partyUnconfirmedNote(names);
  return partyRateFallbackNote(names);
}

/**
 * Quotes the picked parties first. When HMS cannot price them, quotes once more at public rates and says so in the
 * note. Any other failure, and every quote without a picked party, fails as before.
 */
export async function quoteWithPartyFallback<T, P>(options: {
  input: StaffQuoteInput;
  first: P;
  retry: () => P;
  run: (attempt: P) => Promise<T>;
}): Promise<{ prepared: P; result: T; note: string | null; fellBack: boolean }> {
  try {
    return { prepared: options.first, result: await options.run(options.first), note: null, fellBack: false };
  } catch (error) {
    if (!options.input.parties || !isPartyRateFailure(error)) throw error;
    const retry = options.retry();
    return {
      prepared: retry,
      result: await options.run(retry),
      // A no-contract retry is said by the review note on its public groups, not by the fallback note.
      note: fallbackNote((error as { code?: unknown }).code, partyNames(options.input.parties)),
      fellBack: true,
    };
  }
}
export type StaffQuoteScope = {
  transportId: string;
  userId: string;
  threadId: string;
  messageId: string;
  sourceHash: string;
  messageAt: string;
  messageText: string;
  propertyCode: string;
};
export type StaffQuoteAttestation = {
  version: 1;
  kind: 'staff_approved_quote';
  transportId: string;
  userId: string;
  threadId: string;
  messageId: string;
  sourceHash: string;
  selectionEpoch: number;
  inputRevision: number;
  inputDigest: string;
  authorizationId: string;
  revisionIds: string[];
  header: Pick<RevisionProposalHeader, 'company' | 'agency'>;
  /** Staff note approved with the quote; the PDF prints this stored copy, never a later client value. */
  notes?: string;
  /** Row prices approved with the quote, snapshotted when it ran. Old quotes keep these even after a rate is archived. */
  rowPrices?: RowPrice[];
  /** Prevents any document/reply action until staff prices the dinner add-on when hotel policy has no price. */
  dinnerAddOnRequired?: boolean;
};
export function staffQuoteSourceHash(mail: {
  id: string;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
}) {
  return quoteDigest({
    id: mail.id,
    subject: mail.subject,
    textBody: mail.textBody,
    htmlBody: mail.htmlBody,
  });
}
export function prepareStaffQuote(
  input: StaffQuoteInput,
  scope: StaffQuoteScope,
  signer: Pick<RevisionProposalHeader, 'signerName' | 'signerEmail'>,
  signal: AbortSignal,
  rates: StaffQuoteRates = 'party',
) {
  input = staffQuoteInput.parse(input);
  signal.throwIfAborted();
  if (
    input.messageId !== scope.messageId ||
    input.sourceHash !== scope.sourceHash ||
    !scope.transportId ||
    !scope.userId ||
    !scope.threadId ||
    !scope.propertyCode ||
    !Number.isFinite(Date.parse(scope.messageAt))
  )
    throw new Error('staff_quote_source_changed');
  if (new Set(input.groups.map((g) => g.id)).size !== input.groups.length)
    throw new Error('staff_quote_duplicate_group');
  const dates = new Set(
    input.groups.map((g) => {
      const nights = occupiedDates(g.arrivalDate, g.departureDate);
      if (nights.length > 30) throw new Error('staff_quote_stay_exceeds_native_limit');
      return g.arrivalDate + '/' + g.departureDate;
    }),
  );
  if (dates.size !== 1) throw new Error('staff_quote_separate_stay_required');
  // The kill switch turns party rates off: QUOTE_RATE_CONTEXT=off sends no rate context at all.
  const partyContext =
    rates === 'party' && quoteRateContextEnabled() ? partyRateContext(input.parties) : undefined;
  const first = input.groups[0]!,
    request: NativeQuoteRequest = {
      propertyCode: scope.propertyCode,
      arrivalDate: first.arrivalDate,
      departureDate: first.departureDate,
      requestedCurrency: 'ZAR',
      rooms: input.groups.map((g) => ({
        id: g.id,
        quantity: g.quantity,
        adults: g.adults,
        children: g.childrenAges.length,
        childAges: g.childrenAges,
        required: {
          boardBases: [
            g.board === 'bb'
              ? 'breakfast'
              : g.board === 'dinner_bb'
                ? 'dinner_bed_breakfast'
                : 'room_only',
          ],
          ...(g.roomCodes ? { roomCodes: g.roomCodes } : {}),
          ...(g.rateCode ? { rateCodes: [g.rateCode] } : {}),
        },
      })),
      search: {
        includeRestricted: false,
        // Other boards and rooms come back as alternatives, so staff see the rate cards. Only the quoted option is priced in full.
        includeAlternatives: true,
        salesStrategy: input.salesStrategy,
      },
      details: 'full',
      maxOptionsPerGroup: 50,
      // Without a picked party the request is unchanged: no rateContext key at all.
      ...(partyContext ? { rateContext: partyContext } : {}),
    };
  const inputDigest = quoteDigest({
      input,
      scope: {
        transportId: scope.transportId,
        userId: scope.userId,
        threadId: scope.threadId,
        messageId: scope.messageId,
        sourceHash: scope.sourceHash,
        propertyCode: scope.propertyCode,
      },
    }),
    authorizationId = 'staff-quote:' + randomUUID();
  const now = new Date().toISOString();
  const context: Parameters<NonNullable<ReservationistExecutionServices['resolveQuoteTask']>>[0] = {
    input: {
      version: 1,
      requestId: scope.messageId,
      propertyCode: scope.propertyCode,
      authorizationScope: { ownerRef: scope.transportId, threadId: scope.threadId },
      trigger: { id: scope.messageId, at: scope.messageAt },
      messages: [
        {
          id: scope.messageId,
          at: scope.messageAt,
          direction: 'inbound',
          text: scope.messageText,
          disclosure: 'guest',
        },
      ],
      authorizedArtifacts: [],
      clock: {
        causalAt: now,
        sourceAt: now,
        sourceMode: 'current_read',
        deadlineAt: Date.now() + 20 * 60000,
      },
      capabilities: { pmsWrite: false, emailSend: false },
    },
    task: {
      id: authorizationId,
      kind: 'quote',
      factIds: [],
      source: { attachmentId: 'message:' + scope.messageId, sourceHash: scope.sourceHash, page: 1 },
    },
    facts: [],
    signal,
    evaluateSourceAt: () => new Date().toISOString(),
  };
  const header: RevisionProposalHeader = {
    attention: input.attention,
    company: input.company,
    agency: input.agency,
    clientEmail: input.clientEmail,
    clientTelephone: input.clientTelephone,
    ...signer,
  };
  return {
    context,
    request,
    header,
    inputDigest,
    authorizationId,
    approval: {
      context,
      request,
      header,
      rates: rates === 'party' && quoteRateContextEnabled() ? 'party' : 'public',
    } satisfies NonNullable<
      Parameters<typeof createReservationistBusinessServices>[1]
    >,
  };
}
const SHUTTLE_REVIEW_TEXT = 'Shuttle requested — add a price or answer in the reply';
const otherLabelReviewText = (amountMinor: number) =>
  `Other charge R${(amountMinor / 100).toFixed(2)} has no label — add a label or answer in the reply`;

/** "Dinner allowance (food only)": the staff qualifier is printed in brackets after the base label. */
function withQualifier(base: string, qualifier: string | undefined): string {
  return qualifier ? `${base} (${qualifier})` : base;
}

/** The first `count` calendar dates from `start` (YYYY-MM-DD), used as the days of a per-day charge. */
function consecutiveDates(start: string, count: number): string[] {
  const origin = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) =>
    new Date(origin + index * 86400000).toISOString().slice(0, 10),
  );
}

function buildStayPersons(input: StaffQuoteInput): Array<{ id: string; age: number }> {
  const persons: Array<{ id: string; age: number }> = [];
  for (const group of input.groups) {
    for (let room = 0; room < group.quantity; room += 1) {
      for (let adult = 0; adult < group.adults; adult += 1) {
        persons.push({ id: `${group.id}-r${room}-a${adult}`, age: 18 });
      }
      for (let child = 0; child < group.childrenAges.length; child += 1) {
        persons.push({
          id: `${group.id}-r${room}-c${child}`,
          age: group.childrenAges[child]!,
        });
      }
    }
  }
  return persons;
}

export type StaffProposalFactsBuild = {
  facts: AuthorizedProposalFacts | null;
  factRefs: string[];
  extrasReviewItems: string[];
  dinnerAddOnRequired: boolean;
  dinnerGroupIds: string[];
};

/** Pure staff-confirmed extras for PDF and draft totals; never model-priced. */
export function buildStaffProposalFacts(
  input: StaffQuoteInput,
  scope: { messageId: string; sourceHash: string },
  prepared: { authorizationId: string },
  revision: QuoteRevision,
  options: {
    /** Staff-approved dinner charge groups. */
    dinnerGroupIds?: string[];
    /** Retry metadata only; keeps an unpriced or uncovered dinner fallback from becoming ready. */
    dinnerFallbackGroupIds?: string[];
    dinnerAddOn?: StaffQuoteDinnerAddOn;
  } = {},
): StaffProposalFactsBuild {
  input = staffQuoteInput.parse(input);
  if (revision.authorizationId !== prepared.authorizationId)
    throw new Error('staff_quote_attestation_mismatch');
  const extras: AuthorizedProposalFacts['extras'] = [];
  const extrasReviewItems: string[] = [];
  const first = input.groups[0]!;
  const nights = occupiedDates(first.arrivalDate, first.departureDate);
  const allowanceIds = options.dinnerGroupIds ?? input.dinnerAllowanceGroupIds;
  const dinnerFallbackGroupIds = options.dinnerFallbackGroupIds ?? [];
  const hasManualDinnerRequest =
    input.dinnerAllowanceMinor !== undefined ||
    input.dinnerAllowanceLabel !== undefined ||
    input.dinnerAllowanceUnit !== undefined;
  // A priced dinner charge also covers rows retried from a dinner board after the scope was saved (a row staff added later).
  const pricedDinner =
    (input.dinnerAllowanceMinor ?? options.dinnerAddOn?.amountMinor) !== undefined &&
    (input.dinnerAllowanceUnit ?? options.dinnerAddOn?.unit) !== undefined;
  const allowanceGroups =
    allowanceIds !== undefined
      ? input.groups.filter(
          (group) =>
            allowanceIds.includes(group.id) || (pricedDinner && allowanceIds.length > 0 && dinnerFallbackGroupIds.includes(group.id)),
        )
      : hasManualDinnerRequest
        ? input.groups
        : input.groups.filter((group) => dinnerFallbackGroupIds.includes(group.id));
  const allowancePersons = buildStayPersons({ ...input, groups: allowanceGroups });
  const stayPersons = buildStayPersons(input);
  const dinnerGroupIds = allowanceGroups.map((group) => group.id);
  const hasDinnerAddOn = dinnerGroupIds.length > 0 || dinnerFallbackGroupIds.length > 0;
  const hasUncoveredDinnerFallback = dinnerFallbackGroupIds.some((id) => !dinnerGroupIds.includes(id));
  const configured = options.dinnerAddOn;
  const amountMinor = input.dinnerAllowanceMinor ?? configured?.amountMinor;
  const unit = input.dinnerAllowanceUnit ?? configured?.unit;
  const dinnerLabel = withQualifier('Dinner add-on', input.dinnerAllowanceLabel ?? configured?.label);
  let dinnerAddOnRequired = false;
  // Person services print as guests x dates; the rate is per guest per date (night or day).
  const personService = (
    id: string,
    label: string,
    service: string,
    unitMinor: number,
    persons: Array<{ id: string; age: number }>,
    dates: string[],
    options: { chargeUnit?: OtherChargeUnit; daysExplicit?: boolean; groupIds?: string[] } = {},
  ) => {
    extras.push({
      id,
      label,
      quantity: 1,
      units: persons.length * dates.length,
      unitKind: 'person_service',
      unitMinor,
      service,
      persons,
      dates,
      ...(options.chargeUnit ? { chargeUnit: options.chargeUnit } : {}),
      ...(options.daysExplicit === undefined ? {} : { daysExplicit: options.daysExplicit }),
      ...(options.groupIds ? { groupIds: [...options.groupIds] } : {}),
    });
  };
  if (hasDinnerAddOn) {
    if (!amountMinor || !unit) {
      dinnerAddOnRequired = true;
      extrasReviewItems.push('Dinner price — enter amount');
    } else if (!allowanceGroups.length) {
      // Retry IDs prove a dinner board was changed to B&B; they do not authorize charging those guests.
      dinnerAddOnRequired = true;
      extrasReviewItems.push('Dinner allowance — confirm charge groups');
    } else if (unit === 'per_person_per_night' || unit === 'per_person') {
      personService(
        'dinner-add-on',
        dinnerLabel,
        'dinner_add_on',
        amountMinor,
        allowancePersons,
        unit === 'per_person_per_night' ? nights : [first.arrivalDate],
        {
          chargeUnit: unit === 'per_person_per_night' ? 'per_person_night' : 'per_person',
          groupIds: dinnerGroupIds,
        },
      );
    } else {
      const rooms = allowanceGroups.reduce((sum, group) => sum + group.quantity, 0);
      extras.push({
        id: 'dinner-add-on',
        label: dinnerLabel,
        quantity: rooms,
        units: nights.length,
        unitKind: 'item',
        unitMinor: amountMinor,
        service: 'dinner_add_on',
        persons: [],
        dates: nights,
        chargeUnit: 'per_room_per_night',
        groupIds: dinnerGroupIds,
      });
    }
    if (hasUncoveredDinnerFallback && allowanceGroups.length) {
      dinnerAddOnRequired = true;
      extrasReviewItems.push('Dinner allowance — confirm charge groups');
    }
  }
  if (input.lunchAllowanceMinor) {
    personService(
      'lunch-allowance',
      withQualifier('Lunch allowance', input.lunchAllowanceLabel),
      'lunch_allowance',
      input.lunchAllowanceMinor,
      stayPersons,
      nights,
    );
  }
  if (input.officeTransferMinor) {
    // Office transfer is a return trip per guest per day; days default to the nights of the stay.
    personService(
      'office-transfer',
      'Office transfer',
      'office_transfer',
      input.officeTransferMinor,
      stayPersons,
      consecutiveDates(first.arrivalDate, input.officeTransferDays ?? nights.length),
      // Typed days are restored on a re-quote; defaulted days follow the stay instead.
      { daysExplicit: input.officeTransferDays !== undefined },
    );
  }
  if (input.shuttleRequested) {
    if (input.shuttleMinor) {
      extras.push({
        id: 'shuttle',
        label: 'Shuttle',
        quantity: 1,
        units: input.shuttleTrips ?? 1,
        unitKind: 'trip',
        unitMinor: input.shuttleMinor,
        service: 'shuttle',
        persons: [],
        dates: [first.arrivalDate],
      });
    } else {
      extrasReviewItems.push(SHUTTLE_REVIEW_TEXT);
    }
  }
  if (input.other) {
    const { label, amountMinor, unit } = input.other;
    if (!label) {
      extrasReviewItems.push(otherLabelReviewText(amountMinor));
    } else if (unit === 'per_person_night') {
      personService('other', label, 'other', amountMinor, stayPersons, nights, { chargeUnit: unit });
    } else if (unit === 'per_person') {
      personService('other', label, 'other', amountMinor, stayPersons, [first.arrivalDate], { chargeUnit: unit });
    } else {
      extras.push({
        id: 'other',
        label,
        quantity: 1,
        units: 1,
        unitKind: unit === 'per_trip' ? 'trip' : 'item',
        unitMinor: amountMinor,
        service: 'other',
        persons: [],
        dates: [first.arrivalDate],
        chargeUnit: unit,
      });
    }
  }
  if (!extras.length) {
    return { facts: null, factRefs: [], extrasReviewItems, dinnerAddOnRequired, dinnerGroupIds };
  }
  const facts: AuthorizedProposalFacts = {
    revisionId: revision.id,
    authorizationId: revision.authorizationId,
    sourceRef: `message:${scope.messageId}`,
    sourceHash: scope.sourceHash,
    extras,
    includedEntitlements: [],
  };
  deriveAuthorizedExtraLines(revision, facts);
  return { facts, factRefs: ['extras'], extrasReviewItems, dinnerAddOnRequired, dinnerGroupIds };
}

export async function executeStaffQuote(
  prepared: ReturnType<typeof prepareStaffQuote>,
  services: ReservationistExecutionServices,
  stillCurrent: () => Promise<boolean>,
) {
  const guard = async () => {
    prepared.context.signal.throwIfAborted();
    if (!(await stillCurrent())) throw new Error('staff_quote_source_changed');
  };
  await guard();
  if (!services.resolveQuoteTask) throw new Error('staff_quote_installation_unavailable');
  const resolved = await services.resolveQuoteTask(prepared.context);
  await guard();
  if (resolved.alternatives?.length) throw new Error('staff_quote_selected_allocation_required');
  const revision = await resolveQuoteRevision(resolved);
  deriveQuoteLines(revision);
  await guard();
  if (
    !services.authorizeGuestProposal ||
    !(await services.authorizeGuestProposal(prepared.context, revision, null))
  )
    throw new Error('staff_quote_proposal_unauthorized');
  await guard();
  return revision;
}
/**
 * Why a staff-approved quote can no longer be exported, or null while it is still the current approval.
 * Pure: the caller reads the latest generation and the current message from the database.
 */
export function staffQuoteCurrencyProblem(args: {
  staff: Pick<StaffQuoteAttestation, 'userId' | 'threadId' | 'sourceHash' | 'header'>;
  runGenerationId: string | null | undefined;
  latestGenerationId: string | null | undefined;
  currentMessage:
    | { id: string; threadId: string; subject: string | null; textBody: string | null; htmlBody: string | null }
    | null
    | undefined;
  userId: string;
  party: { company: string; agency: string };
}): string | null {
  if (args.latestGenerationId !== args.runGenerationId)
    return 'Newer stay inputs were approved; use the current quote';
  const current = args.currentMessage;
  if (
    !current ||
    args.staff.userId !== args.userId ||
    args.staff.threadId !== current.threadId ||
    args.staff.sourceHash !== staffQuoteSourceHash(current)
  )
    return 'Selected email changed; rerun the approved quote';
  if (
    !args.staff.header ||
    args.party.company !== args.staff.header.company ||
    args.party.agency !== args.staff.header.agency
  )
    return 'Party identity changed; rerun the approved quote';
  return null;
}

/** The one date set ("arrival/departure") a revision covers, or null when it has none or several. */
export function approvedStaySpan(revision: Pick<QuoteRevision, 'groups'>): string | null {
  const spans = new Set(revision.groups.map((group) => `${group.arrivalDate}/${group.departureDate}`));
  return spans.size === 1 ? [...spans][0]! : null;
}

/**
 * Why one stay of a combined quote is no longer current, or null. A stay is superseded by a newer approval for the same
 * dates, and by a newer approval whose dates are unknown (failed or still running), since that one could have changed
 * the stay. `approvals` lists the message's staff approvals, newest first.
 */
export function combinedStayCurrencyProblem(args: {
  stay: { generationId: string | null | undefined; span: string | null };
  approvals: ReadonlyArray<{ generationId: string; span: string | null }>;
}): string | null {
  const superseded = 'Newer stay inputs were approved; use the current quote';
  if (!args.stay.span) return 'Stay dates are not one set; rerun the approved quote';
  const index = args.approvals.findIndex((approval) => approval.generationId === args.stay.generationId);
  if (!args.stay.generationId || index < 0) return superseded;
  return args.approvals
    .slice(0, index)
    .some((approval) => approval.span === null || approval.span === args.stay.span)
    ? superseded
    : null;
}

export function attestStaffQuote(
  input: StaffQuoteInput,
  scope: StaffQuoteScope,
  prepared: ReturnType<typeof prepareStaffQuote>,
  revision: QuoteRevision,
  rowPrices: RowPrice[] = [],
  options: { dinnerAddOnRequired?: boolean } = {},
): StaffQuoteAttestation {
  if (revision.authorizationId !== prepared.authorizationId)
    throw new Error('staff_quote_attestation_mismatch');
  // Validates the prices against this revision before they are approved, so a bad row never reaches the stored attestation.
  deriveQuoteLines(revision, rowPrices);
  return {
    version: 1,
    kind: 'staff_approved_quote',
    transportId: scope.transportId,
    userId: scope.userId,
    threadId: scope.threadId,
    messageId: scope.messageId,
    sourceHash: scope.sourceHash,
    selectionEpoch: input.selectionEpoch,
    inputRevision: input.inputRevision,
    inputDigest: prepared.inputDigest,
    authorizationId: prepared.authorizationId,
    revisionIds: [revision.id],
    header: { company: prepared.header.company, agency: prepared.header.agency },
    ...(input.notes ? { notes: input.notes } : {}),
    ...(rowPrices.length ? { rowPrices } : {}),
    ...(options.dinnerAddOnRequired ? { dinnerAddOnRequired: true } : {}),
  };
}
