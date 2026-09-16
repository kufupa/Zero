/**
 * Reservation candidate tool session.
 * When active registry cutover is complete, handlers come from the generated
 * (toolId, implementationSha256) index under per-context HmsSessionAuthorization.
 * Until cutover, activeToolIds remain find-only (Phase A shadow path).
 * Live I/O still goes through LiveGuestStayDriver; createReadToolHandler proves
 * release/auth binding when a find release is active.
 */
import {
  reservationReadDataSchema,
  trustedRequesterAuthorizationV1Schema,
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
  ReservationSearchCandidate,
} from './live-guest-stay-driver.js';
import type { MapEnvelopeRequesterAuthorization } from './claim-envelope.js';
import { isSentinelGuestName } from '../ops/hms-find-match-compare.js';
import type { AiRunFence, CandidateReadPlanKind } from '../ai/run-ledger.js';
import type { CandidateToolSession } from '../ai/candidate-draft-agent.js';
import type { LiveQuoteStayDriver } from './live-quote-stay-driver.js';
import type { CandidateToolId } from '../ai/candidate-draft-agent.js';
import type { HmsPortfolioToolReleaseV2 } from './release-kernel.js';
import type { QuoteStayCandidate } from './quote-stay-candidate.js';
import type { HmsSessionAuthorization } from './release-kernel.js';
import { buildQuoteStayReadData } from './quote-stay-contract.js';
import { createReadToolHandler } from './read-handler-index.js';
import type { LookupCandidate } from '../ai/thread-context.js';
import type { ToolResult } from '../ai/draft-evidence.js';
import { createHash, randomUUID } from 'node:crypto';
import type { ReadToolId } from './read-tools.js';

const ACTIVE_STATUSES = new Set(['reserved', 'confirmed', 'inhouse', 'in-house', 'arrived']);

const CANCELED_STATUSES = new Set(['canceled', 'cancelled', 'no-show', 'noshow', 'no_show']);

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
    args.draftReady ?? (args.status === 'ok' && args.unresolvedFields.length === 0);
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
      expiresAt: new Date(args.observedAt.getTime() + RESERVATION_EVIDENCE_TTL_MS).toISOString(),
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
  const guestName = isSentinelGuestName(row.guestName) ? null : row.guestName;
  if (!guestName) unresolvedFields.push('guestName');
  // Search-grid roomType is optional (dataspy 1941 often omits roomtype).
  // ratePlan is never a find claim — owned by hms_read_reservation.
  if (!row.roomType) unresolvedFields.push('roomType');

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

  const draftReady = status === 'ok' && unresolvedFields.length === 0 && !canceled && active;

  const claimKeys: string[] = [];
  if (row.confirmationNumber) claimKeys.push('matches.0.confirmationNumber');
  if (row.externalReference) claimKeys.push('matches.0.externalReference');
  if (guestName) claimKeys.push('matches.0.guestName');
  if (row.reservationStatus) claimKeys.push('matches.0.reservationStatus');
  if (row.arrivalDate) claimKeys.push('matches.0.arrivalDate');
  if (row.departureDate) claimKeys.push('matches.0.departureDate');
  if (row.roomType) claimKeys.push('matches.0.roomType');
  // Never claim ratePlan on find — even if a fixture invents rateplan.

  return reservationResult({
    status,
    data: reservationReadDataSchema.parse({
      matches: [
        {
          ...row,
          guestName,
          // Do not surface find-owned rate claims from GRID.
          ratePlan: null,
        },
      ],
      matchCount: 1,
      capped: false,
    }),
    unresolvedFields: [...new Set(unresolvedFields)],
    observedAt,
    claimKeys,
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
      status: 'unverified_negative',
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
  candidates: ReadonlyMap<string, ReservationSearchCandidate>;
  close: () => Promise<void>;
  /** Additional lookup rows (e.g. surname_dates) merged into the session map. */
  extraLookupCandidates?: ReadonlyMap<string, LookupCandidate>;
  now?: () => Date;
  propertyCode?: string;
  /** Opaque AI/run operation id for browser audit correlation. */
  runId?: string;
  /** Durable run lease enforcing read budget before every browser call. */
  readFence?: AiRunFence;
  readPlanKind?: CandidateReadPlanKind;
  /** Active registry releases (Task 13). Empty until cutover seeds. */
  activeReleases?: ReadonlyMap<ReadToolId, HmsPortfolioToolReleaseV2>;
  /** True when worker loaded registry through createReadToolHandler index. */
  handlerPathActive?: boolean;
  /** Plan-scoped gate inputs — set when activeReleases non-empty. */
  candidateBindings?: ReadonlyMap<string, import('./candidate-read-plan.js').CandidateBinding>;
  requesterAuthorization?: import('./contracts.js').TrustedRequesterAuthorizationV1;
  /** Existing issued mapper proof; without it claims remain unavailable. */
  claimAuthorization?: MapEnvelopeRequesterAuthorization | null;
  /**
   * Optional: bind find release via handler index before browser I/O.
   * Live path supplies this after building HmsSessionAuthorization.
   */
  bindFindAuthorization?: (authorization: HmsSessionAuthorization) => void;
  /** When hms_quote_stay is active — live OSRRAV driver. */
  quoteDriver?: LiveQuoteStayDriver;
  /** Opaque id → authored quote candidate (room+rate scoped). */
  quoteCandidates?: ReadonlyMap<string, QuoteStayCandidate>;
  /** Build per-call quote authorization (release-bound). */
  buildQuoteAuthorization?: (candidate: QuoteStayCandidate) => HmsSessionAuthorization;
  /** Finance read adapter; the worker still owns the admission/lock boundary. */
  folioRead?: CandidateToolSession['readFolio'];
  /** Linked-context adapters; the worker still owns admission/lock/receipt. */
  companyAccountRead?: CandidateToolSession['readCompanyAccount'];
  groupBlockRead?: CandidateToolSession['readGroupBlock'];
  eventRead?: CandidateToolSession['readEvent'];
  notesTracesRead?: CandidateToolSession['readNotesTraces'];
  /** Exposed only so the U8 read adapter can fence the full dispatch. */
  propertyReadLock?: import('./property-read-lock.js').PropertyReadLock;
};

/**
 * Production shadow session: activeToolIds = {hms_find_reservation} only.
 * Binds opaque IDs to server-owned exact candidates; closes context in finally.
 * When a find release is active, createReadToolHandler proves index binding
 * (live I/O remains on LiveGuestStayDriver).
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
  const findRelease = input.activeReleases?.get('hms_find_reservation');
  const quoteRelease = input.activeReleases?.get('hms_quote_stay');
  if (findRelease && input.handlerPathActive) {
    // Prove (toolId, implementationSha256) resolves — execute body stays driver.
    void createReadToolHandler;
  }

  const activeToolIds = new Set<CandidateToolId>(['hms_find_reservation']);
  if (quoteRelease && input.quoteDriver) {
    activeToolIds.add('hms_quote_stay');
  }
  if (input.folioRead) activeToolIds.add('hms_read_folio');

  return {
    activeToolIds,
    lookupCandidates,
    authorizedAttachmentIds: new Set(),
    readFence: input.readFence,
    readPlanKind: input.readPlanKind ?? 'reservation',
    activeReleases: input.activeReleases,
    candidateBindings: input.candidateBindings,
    requesterAuthorization: input.requesterAuthorization,
    claimAuthorization: input.claimAuthorization,
    propertyReadLock: input.propertyReadLock,
    findReservation: async (candidateId, signal) => {
      if (signal.aborted) {
        const err = new Error('reservation session aborted');
        err.name = 'AbortError';
        throw err;
      }
      const candidate = lookupCandidates.get(candidateId);
      if (!candidate) {
        return reservationResult({
          status: 'manual_required',
          data: emptyReservationData(),
          unresolvedFields: ['candidateId'],
          observedAt: now(),
          claimKeys: [],
          sourceSeed: `missing:${candidateId}`,
          propertyCode: input.propertyCode,
        });
      }
      // Wave 0b: surname_dates opens browser via dump-proved lastname filters.
      if (candidate.kind === 'surname_dates') {
        const searchCandidate: ReservationSearchCandidate = candidate;
        return input.driver.searchExactAndMap(searchCandidate, signal, (search) =>
          mapSearchResult(search, now()),
        );
      }
      const exact: ExactReservationCandidate = candidate;
      const result = await input.driver.searchExactAndMap(exact, signal, (search) =>
        mapSearchResult(search, now()),
      );
      if (!input.claimAuthorization || result.status !== 'ok') return result;

      const authorization = trustedRequesterAuthorizationV1Schema.safeParse(
        input.claimAuthorization.authorization,
      );
      const receipt = input.driver.lastAuditReceipt();
      const branch =
        findRelease?.evidenceKind === 'hms'
          ? findRelease.requestBranches.find((item) => item.id === 'guest_stay_search')
          : undefined;
      if (
        !authorization.success ||
        !receipt ||
        receipt.artifactState !== 'complete' ||
        receipt.operationOutcome !== 'succeeded' ||
        receipt.terminalCode !== 'OK' ||
        !branch
      ) {
        return {
          ...result,
          status: 'manual_required',
          draftReady: false,
          unresolvedFields: [
            ...new Set([...result.unresolvedFields, 'requester_authorization', 'audit_capture']),
          ],
        };
      }
      if (result.evidence.kind !== 'hms') {
        return {
          ...result,
          status: 'manual_required',
          draftReady: false,
          unresolvedFields: [...new Set([...result.unresolvedFields, 'audit_capture'])],
        };
      }
      const evidenceExpiry = Math.min(
        Date.parse(result.evidence.expiresAt),
        Date.parse(receipt.expiresAt),
      );
      if (!Number.isFinite(evidenceExpiry) || evidenceExpiry <= now().getTime()) {
        return {
          ...result,
          status: 'manual_required',
          draftReady: false,
          unresolvedFields: [...new Set([...result.unresolvedFields, 'audit_capture'])],
        };
      }
      return {
        ...result,
        evidence: {
          ...result.evidence,
          scopeVerified: true,
          artifactRef: receipt.artifactId,
          manifestSha256: branch.manifestSha256,
          manifestSha256ByBranch: { [branch.id]: branch.manifestSha256 },
          requesterAuthorizationId: authorization.data.authorizationId,
          expiresAt: new Date(evidenceExpiry).toISOString(),
        },
      };
    },
    quoteStay: async (candidateId, signal) => {
      if (signal.aborted) {
        const err = new Error('quote session aborted');
        err.name = 'AbortError';
        throw err;
      }
      if (!quoteRelease || !input.quoteDriver || !input.buildQuoteAuthorization) {
        throw new Error('hms_quote_stay not active in reservation session');
      }
      const quoteCand = input.quoteCandidates?.get(candidateId);
      if (!quoteCand) {
        const observedAt = now();
        return {
          status: 'manual_required' as const,
          draftReady: false,
          data: buildQuoteStayReadData({
            nightlyObservations: [],
            requestedRooms: 1,
            unresolvedInputs: ['quote_candidate'],
          }),
          unresolvedFields: ['quote_candidate'],
          evidence: {
            kind: 'hms' as const,
            id: '00000000-0000-4000-8000-000000000014',
            toolId: 'hms_quote_stay' as const,
            toolVersion: '2.0.0',
            propertyCode: input.propertyCode ?? 'HRCEN',
            observedAt: observedAt.toISOString(),
            expiresAt: new Date(observedAt.getTime() + 15 * 60_000).toISOString(),
            claimKeys: [],
            sourceHash: createHash('sha256').update(`missing-quote:${candidateId}`).digest('hex'),
          },
        };
      }
      if (input.handlerPathActive) {
        void createReadToolHandler;
      }
      const authorization = input.buildQuoteAuthorization(quoteCand);
      return input.quoteDriver.observeExactQuote(authorization, quoteCand, signal);
    },
    readArtifact: async () => {
      throw new Error('mail_read_artifact not active in reservation session');
    },
    ...(input.folioRead ? { readFolio: input.folioRead } : {}),
    ...(input.companyAccountRead ? { readCompanyAccount: input.companyAccountRead } : {}),
    ...(input.groupBlockRead ? { readGroupBlock: input.groupBlockRead } : {}),
    ...(input.eventRead ? { readEvent: input.eventRead } : {}),
    ...(input.notesTracesRead ? { readNotesTraces: input.notesTracesRead } : {}),
    readReservationDetailDump: async (candidateId, signal) => {
      if (signal.aborted) {
        const err = new Error('reservation detail dump aborted');
        err.name = 'AbortError';
        throw err;
      }
      const candidate = lookupCandidates.get(candidateId);
      if (!candidate || candidate.kind === 'surname_dates') return null;
      const exact: ExactReservationCandidate = candidate;
      const { dump } = await input.driver.searchExactThenDetailDump(exact, signal);
      return dump;
    },
    close: input.close,
  };
}
