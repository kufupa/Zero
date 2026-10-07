import { assertReservationistResultFreshForAction, DraftApprovalError } from './draft-approval.js';
import type { LunaAnalysis } from './reservationist-decision.js';
import type { QuoteRevision } from '../quote-proposal/quote-revision.js';

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
  try {
    assertReservationistResultFreshForAction({ version: 1, quoteRevisions: [revision] }, scope.now ?? new Date());
  } catch (error) {
    if (error instanceof DraftApprovalError) return { status: 'unavailable', reason: 'expired' };
    throw error;
  }
  if (!analysisMatchesQuotedStay(scope.analysis, revision)) {
    return { status: 'unavailable', reason: 'scope_mismatch' };
  }
  return { status: 'ready', revision };
}
