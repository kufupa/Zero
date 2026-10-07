import { assertReservationistResultFreshForAction, DraftApprovalError } from './draft-approval.js';
import type { LunaAnalysis } from './reservationist-decision.js';
import type { Board, QuoteRevision } from '../quote-proposal/quote-revision.js';
import {
  deriveAuthorizedExtraLines,
  type AuthorizedProposalFacts,
} from '../quote-proposal/quote-lines.js';
import type { StaffQuoteAttestation } from './staff-quote-workflow.js';

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
  shuttleRequested?: boolean;
  shuttleMinor?: number;
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

function extrasHeaderFromFacts(facts: AuthorizedProposalFacts | undefined): {
  dinnerAllowanceMinor?: number;
  shuttleRequested?: boolean;
  shuttleMinor?: number;
} {
  if (!facts) return {};
  const dinner = facts.extras.find(
    (row) => row.service === 'dinner_allowance' && row.unitKind === 'person_service',
  );
  const shuttle = facts.extras.find((row) => row.service === 'shuttle' && row.unitKind === 'trip');
  return {
    ...(dinner ? { dinnerAllowanceMinor: dinner.unitMinor } : {}),
    ...(shuttle ? { shuttleRequested: true as const, shuttleMinor: shuttle.unitMinor } : {}),
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
