/**
 * Production reservation-only candidate tool session.
 * Active tools: hms_find_reservation only. Quote/artifact deferred (not registered).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { LookupCandidate } from '../ai/thread-context.js';
import type { ToolResult } from '../ai/draft-evidence.js';
import type { CandidateToolSession } from '../ai/candidate-draft-agent.js';
import {
  reservationReadDataSchema,
  type ReservationObservation,
  type ReservationReadData,
} from './contracts.js';
import {
  HMS_FIND_RESERVATION_TOOL_ID,
  HMS_FIND_RESERVATION_TOOL_VERSION,
  RESERVATION_EVIDENCE_TTL_MS,
} from './adapter.js';
import type {
  ExactReservationCandidate,
  GuestStaySearchResult,
  LiveGuestStayDriver,
} from './live-guest-stay-driver.js';

const ACTIVE_STATUSES = new Set([
  'reserved',
  'confirmed',
  'inhouse',
  'in-house',
  'arrived',
]);

const CANCELED_STATUSES = new Set([
  'canceled',
  'cancelled',
  'no-show',
  'noshow',
  'no_show',
]);

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function emptyReservationData(): ReservationReadData {
  return reservationReadDataSchema.parse({
    matches: [],
    matchCount: 0,
    capped: false,
  });
}

function reservationResult(args: {
  status: ToolResult<ReservationReadData>['status'];
  data: ReservationReadData;
  unresolvedFields: string[];
  observedAt: Date;
  claimKeys: string[];
  sourceSeed: string;
  draftReady?: boolean;
  propertyCode?: string;
}): ToolResult<ReservationReadData> {
  const draftReady =
    args.draftReady ??
    (args.status === 'ok' && args.unresolvedFields.length === 0);
  return {
    status: args.status,
    draftReady,
    data: args.data,
    unresolvedFields: args.unresolvedFields,
    evidence: {
      kind: 'hms',
      id: randomUUID(),
      toolId: HMS_FIND_RESERVATION_TOOL_ID,
      toolVersion: HMS_FIND_RESERVATION_TOOL_VERSION,
      propertyCode: args.propertyCode ?? 'HRCEN',
      observedAt: args.observedAt.toISOString(),
      expiresAt: new Date(
        args.observedAt.getTime() + RESERVATION_EVIDENCE_TTL_MS,
      ).toISOString(),
      claimKeys: args.claimKeys,
      sourceHash: sha256Hex(args.sourceSeed),
    },
  };
}

function mapMatchedRow(
  row: ReservationObservation,
  observedAt: Date,
): ToolResult<ReservationReadData> {
  const unresolvedFields: string[] = [];
  if (!row.confirmationNumber && !row.externalReference) {
    unresolvedFields.push('confirmationNumber');
  }
  if (!row.arrivalDate) unresolvedFields.push('arrivalDate');
  if (!row.departureDate) unresolvedFields.push('departureDate');
  if (!row.reservationStatus) unresolvedFields.push('reservationStatus');

  const statusLower = (row.reservationStatus ?? '').toLowerCase();
  const canceled = CANCELED_STATUSES.has(statusLower);
  const active = ACTIVE_STATUSES.has(statusLower);

  let status: ToolResult<ReservationReadData>['status'] = 'ok';
  if (unresolvedFields.length > 0) status = 'partial';
  if (canceled) {
    if (!unresolvedFields.includes('reservationStatus.active')) {
      unresolvedFields.push('reservationStatus.active');
    }
    status = 'partial';
  } else if (row.reservationStatus && !active) {
    unresolvedFields.push('reservationStatus.active');
    status = 'partial';
  }

  const draftReady =
    status === 'ok' &&
    unresolvedFields.length === 0 &&
    !canceled &&
    active;

  return reservationResult({
    status,
    data: reservationReadDataSchema.parse({
      matches: [row],
      matchCount: 1,
      capped: false,
    }),
    unresolvedFields: [...new Set(unresolvedFields)],
    observedAt,
    claimKeys: [
      'matches.0.confirmationNumber',
      'matches.0.reservationStatus',
      'matches.0.arrivalDate',
      'matches.0.departureDate',
    ],
    sourceSeed: `one:${row.confirmationNumber ?? row.externalReference ?? 'unknown'}`,
    draftReady,
  });
}

function mapSearchResult(
  result: GuestStaySearchResult,
  observedAt: Date,
): ToolResult<ReservationReadData> {
  if (result.outcome === 'not_found') {
    return reservationResult({
      status: 'not_found',
      data: emptyReservationData(),
      unresolvedFields: [],
      observedAt,
      claimKeys: [],
      sourceSeed: 'none',
    });
  }
  if (result.outcome === 'ambiguous') {
    return reservationResult({
      status: 'ambiguous',
      data: reservationReadDataSchema.parse({
        matches: result.observations.map((row) => ({
          ...row,
          guestName: null,
        })),
        matchCount: result.capped
          ? Math.max(result.observations.length, 21)
          : result.observations.length,
        capped: result.capped,
      }),
      unresolvedFields: ['match_selection'],
      observedAt,
      claimKeys: [],
      sourceSeed: `ambiguous:${result.observations.length}:${result.capped}`,
      draftReady: false,
    });
  }
  return mapMatchedRow(result.observations[0]!, observedAt);
}

export type CreateReservationCandidateSessionInput = {
  driver: LiveGuestStayDriver;
  candidates: ReadonlyMap<string, ExactReservationCandidate>;
  close: () => Promise<void>;
  /** Test-only: inject non-exact lookup rows to prove manual_required gate. */
  extraLookupCandidates?: ReadonlyMap<string, LookupCandidate>;
  now?: () => Date;
  propertyCode?: string;
  /** Opaque AI/run operation id for browser audit correlation. */
  runId?: string;
};

/**
 * Production shadow session: activeToolIds = {hms_find_reservation} only.
 * Binds opaque IDs to server-owned exact candidates; closes context in finally.
 */
export function createReservationCandidateSession(
  input: CreateReservationCandidateSessionInput,
): CandidateToolSession {
  const lookupCandidates = new Map<string, LookupCandidate>();
  for (const [id, c] of input.candidates) {
    lookupCandidates.set(id, c);
  }
  if (input.extraLookupCandidates) {
    for (const [id, c] of input.extraLookupCandidates) {
      lookupCandidates.set(id, c);
    }
  }

  const now = input.now ?? (() => new Date());

  return {
    activeToolIds: new Set(['hms_find_reservation']),
    lookupCandidates,
    authorizedAttachmentIds: new Set(),
    findReservation: async (candidateId, signal) => {
      if (signal.aborted) {
        const err = new Error('reservation session aborted');
        err.name = 'AbortError';
        throw err;
      }
      const candidate = lookupCandidates.get(candidateId);
      if (!candidate) {
        return reservationResult({
          status: 'not_found',
          data: emptyReservationData(),
          unresolvedFields: ['candidateId'],
          observedAt: now(),
          claimKeys: [],
          sourceSeed: `missing:${candidateId}`,
          propertyCode: input.propertyCode,
        });
      }
      // surname_dates never opens browser in production shadow.
      if (candidate.kind === 'surname_dates') {
        return reservationResult({
          status: 'manual_required',
          data: emptyReservationData(),
          unresolvedFields: ['surname_dates'],
          observedAt: now(),
          claimKeys: [],
          sourceSeed: 'surname_dates_manual',
          draftReady: false,
          propertyCode: input.propertyCode,
        });
      }
      const exact: ExactReservationCandidate = candidate;
      return input.driver.searchExactAndMap(exact, signal, (search) =>
        mapSearchResult(search, now()),
      );
    },
    quoteStay: async () => {
      throw new Error('hms_quote_stay not active in reservation session');
    },
    readArtifact: async () => {
      throw new Error('mail_read_artifact not active in reservation session');
    },
    close: input.close,
  };
}
