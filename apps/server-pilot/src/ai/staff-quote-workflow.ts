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
import { quotePaneConfigForProperty } from '../hms/rate-catalogue.js';
import { randomUUID } from 'node:crypto';
import { staffQuoteInput, type StaffQuoteInput, type StaffQuoteParties, type OtherChargeUnit } from './staff-quote-input.js';
export { staffQuoteInput, staffQuoteParties, staffRowPriceInput, OTHER_CHARGE_UNITS, MAX_EXTRA_AMOUNT_MINOR } from './staff-quote-input.js';
export type { StaffQuoteInput, StaffQuoteParties, StaffRowPriceInput, OtherChargeUnit } from './staff-quote-input.js';

const STAFF_QUOTE_STRATEGY_LABELS = {
  BAR: 'BAR',
  PROMO: 'Promotions',
  PRESET: 'Preset',
  WS: 'Wholesale',
  NC: 'Negoticated Contracted',
  GOV: 'Government',
  AIR: 'Airline Crews',
  DOML: 'Domestic Leisure',
  OTHER: 'Other',
} as const;
type StaffQuoteStrategyCode = keyof typeof STAFF_QUOTE_STRATEGY_LABELS;
type StaffQuoteStrategyValue = StaffQuoteStrategyCode | 'Government';

function governmentStrategy(value: StaffQuoteStrategyValue): boolean {
  return value === 'Government' || value === 'GOV';
}



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
  // These retries belong to the legacy BAR/Government quote path. Comparison rows must report the requested strategy,
  // not quietly replace a missing room/board with a different search.
  if (input.salesStrategy !== 'BAR' && input.salesStrategy !== 'Government') return null;
  const requested = requestedGroupIds === undefined ? null : new Set(requestedGroupIds);
  const groupIds = input.groups
    .filter((group) => group.mealPlan === 'dinner_bb' && (!requested || requested.has(group.id)))
    .map((group) => group.id);
  if (!groupIds.length) return null;
  const selected = new Set(groupIds);
  return {
    groupIds,
    input: {
      ...input,
      groups: input.groups.map((group) => {
        if (!selected.has(group.id)) return { ...group };
        const fallbackGroup = { ...group, mealPlan: 'bb' as const };
        delete fallbackGroup.rateCode;
        return fallbackGroup;
      }),
    },
  };
}

/** No-match retry preserves the current BAR strategy. Government-to-BAR requires a staff choice. */
export function staffQuoteDinnerNoMatchFallback(
  input: StaffQuoteInput,
): { input: StaffQuoteInput; groupIds: string[]; note: string | null } | null {
  if (input.salesStrategy !== 'BAR') return null;
  const fallback = staffQuoteDinnerFallback(input);
  if (!fallback) return null;
  return {
    ...fallback,
    note: null,
  };
}

/** Staff note for a successful Government Dinner B&B quote. */
export function staffQuoteGovernmentDinnerNote(input: StaffQuoteInput): string | null {
  return governmentStrategy(input.salesStrategy) && input.groups.some((group) => group.mealPlan === 'dinner_bb')
    ? 'Priced on the Government Dinner B&B rate because the guest asked for dinner. ' +
      'Choose All public rates (BAR) if the guest is not entitled.'
    : null;
}

export type StaffQuoteRates = 'party' | 'public';
export type PartyRateRef = { nativeId: string; name: string };
export type PartyRateContext = { organization?: PartyRateRef; bookingAgency?: PartyRateRef };

/**
 * The rate context for picked parties. A company is the organization, an agency is the agency: both when both were
 * picked. Nothing else is sent, so no commission or A/R account reaches the quote.
 */
export function partyRateContext(parties: StaffQuoteParties | undefined): PartyRateContext | undefined {
  const context: PartyRateContext = {};
  if (parties?.organization) context.organization = { nativeId: parties.organization.nativeId, name: parties.organization.name };
  if (parties?.bookingAgency) context.bookingAgency = { nativeId: parties.bookingAgency.nativeId, name: parties.bookingAgency.name };
  return Object.keys(context).length ? context : undefined;
}

export function partyNames(parties: StaffQuoteParties | undefined): string[] {
  return [parties?.organization?.name, parties?.bookingAgency?.name].filter((name): name is string => Boolean(name));
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
  if (input.salesStrategy !== 'BAR') return [];
  const dinnerGroupIds = input.groups.filter((group) => group.mealPlan === 'dinner_bb').map((group) => group.id);
  if (!input.parties) return dinnerGroupIds;
  const verifiedContractGroupIds = new Set(
    rateOptions.filter((option) => option.selected && option.contract).map((option) => option.groupId),
  );
  return dinnerGroupIds.filter((id) => !verifiedContractGroupIds.has(id));
}

export { isPartyRateFailure, PartyRateFailure } from './party-rate-failure.js';

/** The retry preserves the staff-selected strategy, which may not be a public rate. */
export function partyRateFallbackNote(names: readonly string[]): string {
  return `HMS couldn't apply the contract rate for ${names.join(' and ')}. Check the selected rate in HMS before sending.`;
}

/** The review note when HMS could not confirm the picked party's contract rates. */
export function partyUnconfirmedNote(names: readonly string[]): string {
  return `Nava couldn't confirm contract rates for ${names.join(' and ')}. Check the selected rate in HMS before sending.`;
}

/** A complete no-contract retry has no extra note: its review note on the public groups says so. */
function fallbackNote(code: unknown, names: readonly string[]): string | null {
  if (code === PARTY_NO_CONTRACT_CODE) return null;
  if (code === PARTY_SEARCH_INCOMPLETE_CODE) return partyUnconfirmedNote(names);
  return partyRateFallbackNote(names);
}

/**
 * Quotes the picked parties first. When HMS cannot price them, retries without the party while preserving the selected
 * strategy and warns staff. Any other failure, and every quote without a picked party, fails as before.
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
  /** Null only for a system-prepared price; that path has no approving actor or signer. */
  userId: string | null;
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
  header: Pick<RevisionProposalHeader, 'organization' | 'bookingAgency'>;
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
          mealPlanBases: [
            g.mealPlan === 'bb'
              ? 'breakfast'
              : g.mealPlan === 'dinner_bb'
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
        salesStrategy:
          input.salesStrategy === 'Government'
            ? 'Government'
            : STAFF_QUOTE_STRATEGY_LABELS[input.salesStrategy],
      },
      details: 'full',
      maxOptionsPerGroup:
        input.maxOptionsPerGroup ??
        (input.groups.some((group) => !group.roomCodes?.length) ? 200 : 50),
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
    organization: input.organization,
    bookingAgency: input.bookingAgency,
    clientEmail: input.clientEmail,
    clientTelephone: input.clientTelephone,
    ...signer,
  };
  return {
    context,
    request,
    salesStrategyValue: input.salesStrategy === 'GOV' ? 'Government' : input.salesStrategy,
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
  const configured = governmentStrategy(input.salesStrategy) ? undefined : options.dinnerAddOn;
  const allowanceGroups =
    allowanceIds !== undefined
      ? input.groups.filter((group) => allowanceIds.includes(group.id))
      : hasManualDinnerRequest
        ? input.groups
        : input.groups.filter((group) => dinnerFallbackGroupIds.includes(group.id));
  const allowancePersons = buildStayPersons({ ...input, groups: allowanceGroups });
  const stayPersons = buildStayPersons(input);
  const dinnerGroupIds = allowanceGroups.map((group) => group.id);
  const hasDinnerAddOn = dinnerGroupIds.length > 0 || dinnerFallbackGroupIds.length > 0;
  const hasUncoveredDinnerFallback = dinnerFallbackGroupIds.some((id) => !dinnerGroupIds.includes(id));
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
  for (const charge of input.extras ?? []) {
    const selected = input.groups.filter(group => charge.groupIds.includes(group.id));
    if (selected.length !== charge.groupIds.length || new Set(charge.groupIds).size !== charge.groupIds.length) {
      throw new Error('staff_quote_extra_groups_invalid');
    }
    const label = { lunch_allowance: 'Lunch', shuttle: 'Airport Transfer / Shuttle', office_transfer: 'Office Transfer' }[charge.service];
    if (charge.unit === 'per_trip' || charge.unit === 'item') {
      extras.push({ id: charge.id, label, quantity: 1, units: 1,
        unitKind: charge.unit === 'per_trip' ? 'trip' : 'item', unitMinor: charge.amountMinor,
        service: charge.service, persons: [], dates: [selected[0]!.arrivalDate], chargeUnit: charge.unit,
        groupIds: charge.groupIds });
      continue;
    }
    for (const group of selected) {
      const dates = charge.unit === 'per_person' ? [group.arrivalDate] : occupiedDates(group.arrivalDate, group.departureDate);
      const id = `${charge.id}-${group.id}`;
      if (charge.unit === 'per_room_per_night') {
        extras.push({ id, label, quantity: group.quantity, units: dates.length, unitKind: 'item',
          unitMinor: charge.amountMinor, service: charge.service, persons: [], dates,
          chargeUnit: charge.unit, groupIds: [group.id] });
      } else {
        personService(id, label, charge.service, charge.amountMinor, buildStayPersons({ ...input, groups: [group] }), dates,
          { chargeUnit: charge.unit, groupIds: [group.id] });
      }
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
  const ownerRef = prepared.context.input.authorizationScope?.ownerRef;
  if (!ownerRef) throw new Error('staff_quote_authorization_scope_missing');
  const paneConfig = await quotePaneConfigForProperty(prepared.context.input.propertyCode, ownerRef);
  const configuredStrategy = paneConfig?.salesStrategies.find(
    (strategy) => strategy.requestValue === prepared.salesStrategyValue,
  );
  if (!configuredStrategy || configuredStrategy.label !== prepared.request.search.salesStrategy) {
    throw new Error('The selected sales strategy is not configured for this hotel.');
  }
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

/** Interpret old stored header names for comparison without changing the approved attestation. */
function storedPartyHeaderForComparison(header: unknown) {
  if (!header || typeof header !== 'object' || Array.isArray(header)) return null;
  const field = (canonical: string, legacy: string): unknown =>
    Object.hasOwn(header, canonical)
      ? Reflect.get(header, canonical)
      : Object.hasOwn(header, legacy)
        ? Reflect.get(header, legacy)
        : undefined;
  return {
    organization: field('organization', 'company'),
    bookingAgency: field('bookingAgency', 'agency'),
  };
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
  party: { organization: string; bookingAgency: string };
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
  const header = storedPartyHeaderForComparison(args.staff.header);
  if (
    !header ||
    args.party.organization !== header.organization ||
    args.party.bookingAgency !== header.bookingAgency
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
  if (!scope.userId) throw new Error('staff_quote_user_approval_required');
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
    header: { organization: prepared.header.organization, bookingAgency: prepared.header.bookingAgency },
    ...(input.notes ? { notes: input.notes } : {}),
    ...(rowPrices.length ? { rowPrices } : {}),
    ...(options.dinnerAddOnRequired ? { dinnerAddOnRequired: true } : {}),
  };
}
