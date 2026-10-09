import { assertReservationistResultFreshForAction, DraftApprovalError } from './draft-approval.js';
import type { LunaAnalysis } from './reservationist-decision.js';
import type { Board, QuoteRevision } from '../quote-proposal/quote-revision.js';
import {
  deriveAuthorizedExtraLines,
  type AuthorizedProposalFacts,
} from '../quote-proposal/quote-lines.js';
import type { OtherChargeUnit, StaffQuoteAttestation } from './staff-quote-workflow.js';

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

function revisionsFromRun(run: PriorQuoteRun): QuoteRevision[] {
  const result = run.metrics?.reservationistResult as
    | { quoteRevisions?: QuoteRevision[]; quoteRevisionIds?: string[] }
    | undefined;
  const listed = result?.quoteRevisions ?? [];
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
  if (!asked.every((group) => quoted.has(`${group.arrival}:${group.departure}`))) return false;
  if (asked.some((group) => typeof group.rooms === 'number')) {
    const askedRooms = asked.reduce((sum, group) => sum + (group.rooms ?? 0), 0);
    const quotedRooms = revision.groups.reduce((sum, group) => sum + group.quantity, 0);
    if (askedRooms !== quotedRooms) return false;
  }
  if (asked.length === 1 && typeof asked[0]?.adultsPerRoom === 'number') {
    if (!revision.groups.every((group) => group.adults === asked[0]!.adultsPerRoom)) return false;
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
  return result?.proposalFacts ?? [];
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

export function quotedTotalWithStoredExtras(revision: QuoteRevision, run: PriorQuoteRun): number {
  const facts = proposalFactsForRevision(run, revision.id);
  if (!facts) return revision.totalMinor;
  try {
    const extra = deriveAuthorizedExtraLines(revision, facts).reduce(
      (sum, line) => sum + line.totalMinor,
      0,
    );
    return revision.totalMinor + extra;
  } catch {
    return revision.totalMinor;
  }
}

/** The staff qualifier stored in a label such as "Dinner allowance (food only)". */
function qualifierFromLabel(label: string, base: string): string | undefined {
  return label.startsWith(`${base} (`) && label.endsWith(')') ? label.slice(base.length + 2, -1) : undefined;
}

/** Maps persisted staff extras back to header fields. Legacy dinner and shuttle rows keep their meaning. */
function extrasHeaderFromFacts(
  facts: AuthorizedProposalFacts | undefined,
): Omit<PriorStaffQuoteRequotePayload, 'groups' | 'salesStrategy' | 'company' | 'agency' | 'notes'> {
  const out: Omit<PriorStaffQuoteRequotePayload, 'groups' | 'salesStrategy' | 'company' | 'agency' | 'notes'> = {};
  for (const row of facts?.extras ?? []) {
    if (row.service === 'dinner_allowance' && row.unitKind === 'person_service') {
      out.dinnerAllowanceMinor = row.unitMinor;
      const qualifier = qualifierFromLabel(row.label, 'Dinner allowance');
      if (qualifier) out.dinnerAllowanceLabel = qualifier;
    } else if (row.service === 'lunch_allowance' && row.unitKind === 'person_service') {
      out.lunchAllowanceMinor = row.unitMinor;
      const qualifier = qualifierFromLabel(row.label, 'Lunch allowance');
      if (qualifier) out.lunchAllowanceLabel = qualifier;
    } else if (row.service === 'office_transfer' && row.unitKind === 'person_service') {
      out.officeTransferMinor = row.unitMinor;
      if (row.dates.length) out.officeTransferDays = row.dates.length;
    } else if (row.service === 'shuttle' && row.unitKind === 'trip') {
      out.shuttleRequested = true;
      out.shuttleMinor = row.unitMinor;
      out.shuttleTrips = row.units;
    } else if (row.service === 'other') {
      // The unit the staff chose is stored on the fact. Facts stored before that fall back to the old inference.
      const unit: OtherChargeUnit =
        row.chargeUnit ??
        (row.unitKind === 'trip' ? 'per_trip' : row.unitKind === 'item' ? 'item' : row.dates.length > 1 ? 'per_person_night' : 'per_person');
      out.other = { label: row.label, amountMinor: row.unitMinor, unit };
    }
  }
  return out;
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
    ...extrasHeaderFromFacts(proposalFactsForRevision(run, revisionRef)),
    ...(staff.notes ? { notes: staff.notes } : {}),
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
