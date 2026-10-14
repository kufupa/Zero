import { assertReservationistResultFreshForAction, DraftApprovalError } from './draft-approval.js';
import type { LunaAnalysis } from './reservationist-decision.js';
import { occupiedDates, type Board, type QuoteRevision } from '../quote-proposal/quote-revision.js';
import {
  deriveAuthorizedExtraLines,
  pricedRoomTotal,
  type AuthorizedProposalFacts,
  type RowPrice,
} from '../quote-proposal/quote-lines.js';
import type {
  OtherChargeUnit,
  StaffQuoteAttestation,
  StaffRowPriceInput,
} from './staff-quote-workflow.js';

export type PriorStaffQuoteRequoteGroup = {
  id: string;
  arrivalDate: string;
  departureDate: string;
  quantity: number;
  adults: number;
  childrenAges: number[];
  board: 'room_only' | 'bb' | 'dinner_bb';
  roomCodes?: string[];
};

export type PriorStaffQuoteRequotePayload = {
  groups: PriorStaffQuoteRequoteGroup[];
  salesStrategy: 'BAR' | 'Government';
  company: string;
  agency: string;
  dinnerAllowanceMinor?: number;
  dinnerAllowanceUnit?: 'per_person_per_night' | 'per_room_per_night' | 'per_person';
  dinnerAllowanceGroupIds?: string[];
  dinnerAllowanceLabel?: string;
  lunchAllowanceMinor?: number;
  lunchAllowanceLabel?: string;
  officeTransferMinor?: number;
  officeTransferDays?: number;
  shuttleRequested?: boolean;
  shuttleMinor?: number;
  shuttleTrips?: number;
  other?: { label: string; amountMinor: number; unit: OtherChargeUnit };
  notes?: string;
  rowPrices?: StaffRowPriceInput[];
};

export type ThreadQuoteRevisionSummary = {
  workflowRunId: string;
  revisionRef: string;
  createdAt: string;
  expiresAt: string | null;
  roomCodes: string[];
  rateCodes: string[];
  partyName: string | null;
};

export type PriorQuoteRun = {
  id?: string;
  transportId: string;
  threadId: string;
  state: string;
  createdAt?: Date | string;
  finishedAt?: Date | string | null;
  metrics: Record<string, unknown> | null;
  readResult?: Record<string, unknown> | null;
};

export type PriorQuoteResolveResult =
  | { status: 'ready'; revision: QuoteRevision }
  | { status: 'unavailable'; reason: 'expired' | 'not_found' | 'scope_mismatch' };

function iso(value: Date | string | null | undefined): string {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  return value;
}

function partyNameFromRevision(revision: QuoteRevision): string | null {
  const context = revision.groups[0]?.context ?? {};
  const agency = context.agency as { name?: string } | undefined;
  if (typeof agency?.name === 'string' && agency.name.trim()) return agency.name;
  const organization = context.organization as { name?: string } | undefined;
  if (typeof organization?.name === 'string' && organization.name.trim()) return organization.name;
  return null;
}

function preparedProposalFor(run: Pick<PriorQuoteRun, 'readResult'>): {
  revision?: QuoteRevision;
  facts?: AuthorizedProposalFacts;
  rowPrices?: RowPrice[];
} | undefined {
  const result = run.readResult;
  if (result?.status !== 'ready') return undefined;
  const prepared = result.preparedProposal;
  return prepared && typeof prepared === 'object' && !Array.isArray(prepared)
    ? (prepared as { revision?: QuoteRevision; facts?: AuthorizedProposalFacts; rowPrices?: RowPrice[] })
    : undefined;
}

function revisionsFromRun(run: PriorQuoteRun): QuoteRevision[] {
  const result = run.metrics?.reservationistResult as
    | { quoteRevisions?: QuoteRevision[]; quoteRevisionIds?: string[] }
    | undefined;
  const prepared = preparedProposalFor(run)?.revision;
  const listed = result?.quoteRevisions?.length ? result.quoteRevisions : prepared ? [prepared] : [];
  const ids = new Set(result?.quoteRevisionIds ?? listed.map((row) => row.id));
  return listed.filter((row) => ids.has(row.id));
}

export function analysisMatchesQuotedStay(
  analysis: LunaAnalysis,
  revision: Pick<QuoteRevision, 'groups'>,
): boolean {
  const asked = analysis.groups.filter((group) => group.arrival && group.departure);
  if (!asked.length) return false;
  const quoted = new Set(
    revision.groups.map((group) => `${group.arrivalDate}:${group.departureDate}`),
  );
  // With several stays asked, a revision covers only some of them. The stays it does quote must all be asked.
  const askedKeys = new Set(asked.map((group) => `${group.arrival}:${group.departure}`));
  if (asked.length > 1 && [...quoted].some((key) => !askedKeys.has(key))) return false;
  // The asked stays this revision quotes. The other stays of the request belong to other revisions.
  const covered = asked.filter((group) => quoted.has(`${group.arrival}:${group.departure}`));
  if (!covered.length) return false;
  if (covered.some((group) => typeof group.rooms === 'number')) {
    const askedRooms = covered.reduce((sum, group) => sum + (group.rooms ?? 0), 0);
    const quotedRooms = revision.groups.reduce((sum, group) => sum + group.quantity, 0);
    if (askedRooms !== quotedRooms) return false;
  }
  if (covered.length === 1 && typeof covered[0]?.adultsPerRoom === 'number') {
    if (!revision.groups.every((group) => group.adults === covered[0]!.adultsPerRoom)) return false;
  }
  return true;
}

export function collectThreadQuoteRevisions(
  runs: PriorQuoteRun[],
  scope: { transportId: string; threadId: string },
): ThreadQuoteRevisionSummary[] {
  const matched = runs
    .filter(
      (run) =>
        run.transportId === scope.transportId &&
        run.threadId === scope.threadId &&
        run.state === 'succeeded' &&
        revisionsFromRun(run).length > 0,
    )
    .sort((left, right) => iso(right.createdAt).localeCompare(iso(left.createdAt)));
  const summaries: ThreadQuoteRevisionSummary[] = [];
  for (const run of matched) {
    for (const revision of revisionsFromRun(run)) {
      summaries.push({
        workflowRunId: run.id ?? '',
        revisionRef: revision.id,
        createdAt: iso(run.createdAt),
        expiresAt: revision.sourceFreshness?.expiresAt ?? null,
        roomCodes: [...new Set(revision.groups.map((group) => group.roomCode))],
        rateCodes: [...new Set(revision.groups.map((group) => group.rateCode))],
        partyName: partyNameFromRevision(revision),
      });
      if (summaries.length >= 5) return summaries;
    }
  }
  return summaries;
}

function staffBoardFromRevision(board: Board): PriorStaffQuoteRequoteGroup['board'] {
  if (board === 'room_only') return 'room_only';
  if (board === 'dinner_bed_breakfast') return 'dinner_bb';
  return 'bb';
}

function proposalBundles(run: PriorQuoteRun): Array<{ ref: string; facts: AuthorizedProposalFacts }> {
  const result = run.metrics?.reservationistResult as
    | { proposalFacts?: Array<{ ref: string; facts: AuthorizedProposalFacts }> }
    | undefined;
  if (result?.proposalFacts) return result.proposalFacts;
  const facts = preparedProposalFor(run)?.facts;
  const factRefs = run.readResult?.factRefs;
  const ref =
    Array.isArray(factRefs) && factRefs.length === 1 && typeof factRefs[0] === 'string'
      ? factRefs[0]
      : undefined;
  return facts && ref ? [{ ref, facts }] : [];
}

function proposalFactsForRevision(
  run: PriorQuoteRun,
  revisionId: string,
): AuthorizedProposalFacts | undefined {
  return proposalBundles(run).find((row) => row.facts.revisionId === revisionId)?.facts;
}

export function proposalFactRefsForRevision(run: PriorQuoteRun, revisionId: string): string[] {
  return proposalBundles(run)
    .filter((row) => row.facts.revisionId === revisionId && row.ref)
    .map((row) => row.ref);
}

/** The row prices an approval recorded for this revision. Empty when HMS priced every row. */
export function storedRowPrices(
  run: Pick<PriorQuoteRun, 'metrics' | 'readResult'>,
  revisionId: string,
): RowPrice[] {
  const staff = run.metrics?.staffQuoteAttestation as
    | Pick<StaffQuoteAttestation, 'revisionIds' | 'rowPrices'>
    | undefined;
  if (staff?.revisionIds?.includes(revisionId)) return staff.rowPrices ?? [];
  const prepared = preparedProposalFor(run);
  return prepared?.revision?.id === revisionId ? (prepared.rowPrices ?? []) : [];
}

/**
 * The approved total: the priced rooms plus the stored extras. Equal to the HMS total when no row is priced.
 * Booking drafts check rate claims against the priced rooms and flag manual_rate_change, because HMS books at its own rate.
 */
export function quotedTotalWithStoredExtras(revision: QuoteRevision, run: PriorQuoteRun): number {
  const rooms = pricedRoomTotal(revision, storedRowPrices(run, revision.id));
  const facts = proposalFactsForRevision(run, revision.id);
  if (!facts) return rooms;
  try {
    const extra = deriveAuthorizedExtraLines(revision, facts).reduce(
      (sum, line) => sum + line.totalMinor,
      0,
    );
    return rooms + extra;
  } catch {
    return rooms;
  }
}

/** The staff qualifier stored in a label such as "Dinner allowance (food only)". */
function qualifierFromLabel(label: string, base: string): string | undefined {
  return label.startsWith(`${base} (`) && label.endsWith(')') ? label.slice(base.length + 2, -1) : undefined;
}

/**
 * Maps persisted staff extras back to header fields. Legacy dinner and shuttle rows keep their meaning.
 * stayNights reads office transfer days stored before the daysExplicit flag existed.
 */
function extrasHeaderFromFacts(
  facts: AuthorizedProposalFacts | undefined,
  stayNights: number,
): Omit<PriorStaffQuoteRequotePayload, 'groups' | 'salesStrategy' | 'company' | 'agency' | 'notes'> {
  const out: Omit<PriorStaffQuoteRequotePayload, 'groups' | 'salesStrategy' | 'company' | 'agency' | 'notes'> = {};
  for (const row of facts?.extras ?? []) {
    if (row.service === 'dinner_add_on') {
      out.dinnerAllowanceMinor = row.unitMinor;
      if (row.chargeUnit === 'per_person_night') out.dinnerAllowanceUnit = 'per_person_per_night';
      else if (row.chargeUnit === 'per_person' || row.chargeUnit === 'per_room_per_night') {
        out.dinnerAllowanceUnit = row.chargeUnit;
      }
      if (row.groupIds?.length) out.dinnerAllowanceGroupIds = [...row.groupIds];
      const qualifier = qualifierFromLabel(row.label, 'Dinner add-on');
      if (qualifier) out.dinnerAllowanceLabel = qualifier;
    } else if (row.service === 'dinner_allowance' && row.unitKind === 'person_service') {
      out.dinnerAllowanceMinor = row.unitMinor;
      out.dinnerAllowanceUnit = 'per_person_per_night';
      const qualifier = qualifierFromLabel(row.label, 'Dinner allowance');
      if (qualifier) out.dinnerAllowanceLabel = qualifier;
    } else if (row.service === 'lunch_allowance' && row.unitKind === 'person_service') {
      out.lunchAllowanceMinor = row.unitMinor;
      const qualifier = qualifierFromLabel(row.label, 'Lunch allowance');
      if (qualifier) out.lunchAllowanceLabel = qualifier;
    } else if (row.service === 'office_transfer' && row.unitKind === 'person_service') {
      out.officeTransferMinor = row.unitMinor;
      // Only days staff typed are restored, so defaulted days follow the new stay. Facts stored before the
      // flag count as typed when their dates differ from the stay's nights.
      const typed = row.daysExplicit ?? (row.dates.length !== stayNights);
      if (typed && row.dates.length) out.officeTransferDays = row.dates.length;
    } else if (row.service === 'shuttle' && row.unitKind === 'trip') {
      out.shuttleRequested = true;
      out.shuttleMinor = row.unitMinor;
      out.shuttleTrips = row.units;
    } else if (row.service === 'other') {
      // The unit the staff chose is stored on the fact. Facts stored before that fall back to the old inference.
      const inferredUnit =
        row.unitKind === 'trip' ? 'per_trip' : row.unitKind === 'item' ? 'item' : row.dates.length > 1 ? 'per_person_night' : 'per_person';
      const unit: OtherChargeUnit =
        row.chargeUnit && row.chargeUnit !== 'per_room_per_night' ? row.chargeUnit : inferredUnit;
      out.other = { label: row.label, amountMinor: row.unitMinor, unit };
    }
  }
  return out;
}

/**
 * Whether the revision's approved extras include a once-per-quote charge: the shuttle, or a per-trip or one-item other
 * charge. A combined quote charges these once, so a reused quote says whether its total already has them.
 */
export function revisionCarriesOnceExtras(run: PriorQuoteRun, revisionId: string): boolean {
  const extras = extrasHeaderFromFacts(proposalFactsForRevision(run, revisionId), 0);
  return Boolean(extras.shuttleRequested) || extras.other?.unit === 'per_trip' || extras.other?.unit === 'item';
}

/** A stored row price in the input shape, so a re-quote asks for the same price again. */
function rowPriceInputFor(price: RowPrice): StaffRowPriceInput {
  if (price.source === 'saved') return { groupId: price.groupId, source: 'saved', customRateId: price.customRateId };
  if (price.source === 'one_off') return { groupId: price.groupId, source: 'one_off', oneOffRate: price.amountMinor };
  return {
    groupId: price.groupId,
    source: 'override',
    rateCode: price.rateCode,
    overrideRate: price.amountMinor,
    note: price.note,
  };
}

/** Stored revision + attestation inputs for executeStaffQuote when freshness expired. */
export function priorStaffQuoteRequotePayload(
  run: PriorQuoteRun,
  revisionRef: string,
): PriorStaffQuoteRequotePayload | null {
  if (run.state !== 'succeeded') return null;
  const revision = revisionsFromRun(run).find((row) => row.id === revisionRef);
  if (!revision) return null;
  const staff = run.metrics?.staffQuoteAttestation as
    | (StaffQuoteAttestation & { salesStrategy?: 'BAR' | 'Government' })
    | undefined;
  if (
    staff?.version !== 1 ||
    staff.kind !== 'staff_approved_quote' ||
    !staff.revisionIds?.includes(revisionRef)
  ) {
    return null;
  }
  const stay = revision.groups[0];
  return {
    groups: revision.groups.map((group) => ({
      id: group.id,
      arrivalDate: group.arrivalDate,
      departureDate: group.departureDate,
      quantity: group.quantity,
      adults: group.adults,
      childrenAges: [...group.childAges],
      board: staffBoardFromRevision(group.board),
      ...(group.roomCode ? { roomCodes: [group.roomCode] } : {}),
    })),
    salesStrategy: staff.salesStrategy === 'Government' ? 'Government' : 'BAR',
    company: staff.header.company ?? '',
    agency: staff.header.agency ?? '',
    ...extrasHeaderFromFacts(
      proposalFactsForRevision(run, revisionRef),
      stay ? occupiedDates(stay.arrivalDate, stay.departureDate).length : 0,
    ),
    ...(staff.notes ? { notes: staff.notes } : {}),
    ...(staff.rowPrices?.length ? { rowPrices: staff.rowPrices.map(rowPriceInputFor) } : {}),
  };
}

export function resolvePriorQuoteForBooking(
  run: PriorQuoteRun,
  scope: {
    transportId: string;
    threadId: string;
    revisionRef: string;
    analysis: LunaAnalysis;
    now?: Date;
  },
): PriorQuoteResolveResult {
  if (run.transportId !== scope.transportId || run.threadId !== scope.threadId || run.state !== 'succeeded') {
    return { status: 'unavailable', reason: 'not_found' };
  }
  const revision = revisionsFromRun(run).find((row) => row.id === scope.revisionRef);
  if (!revision) return { status: 'unavailable', reason: 'not_found' };
  const asked = scope.analysis.groups.filter((group) => group.arrival && group.departure);
  if (asked.length && !analysisMatchesQuotedStay(scope.analysis, revision)) {
    return { status: 'unavailable', reason: 'scope_mismatch' };
  }
  try {
    assertReservationistResultFreshForAction({ version: 1, quoteRevisions: [revision] }, scope.now ?? new Date());
  } catch (error) {
    if (error instanceof DraftApprovalError) return { status: 'unavailable', reason: 'expired' };
    throw error;
  }
  return { status: 'ready', revision };
}
