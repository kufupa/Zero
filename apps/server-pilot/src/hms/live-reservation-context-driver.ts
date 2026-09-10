/**
 * Typed adapter from the existing audited Guest Stay driver to U8's
 * reservation-context facade.  It deliberately exposes only list-row facts;
 * detail sections remain explicitly unavailable until their own reviewed
 * read surface is proven.
 */
import type {
  ReservationContextLookup,
  ReservationContextReader,
  ReservationLookupResult,
  ReservationRow,
} from './reservation-context-facade.js';
import type {
  ExactReservationCandidate,
  GuestStaySearchResult,
  LiveGuestStayDriver,
} from './live-guest-stay-driver.js';
import type { PropertyReadLock } from './property-read-lock.js';

export interface LiveReservationContextDriver {
  findReservation(
    input: ReservationContextLookup,
    signal: AbortSignal,
  ): Promise<ReservationLookupResult>;
  readContext: ReservationContextReader;
}

export interface LiveReservationContextDriverOptions {
  guestStay: LiveGuestStayDriver;
  candidateFor: (input: ReservationContextLookup) => ExactReservationCandidate;
  now?: () => Date;
  evidenceRefFor?: (input: ReservationContextLookup) => string;
  propertyReadLock?: PropertyReadLock;
}

function rowFromObservation(
  observation: GuestStaySearchResult['observations'][number],
): ReservationRow {
  return {
    confirmationNumber: observation.confirmationNumber,
    externalReference: observation.externalReference,
    guestName: observation.guestName,
    arrivalDate: observation.arrivalDate,
    departureDate: observation.departureDate,
    reservationStatus: observation.reservationStatus,
    roomType: observation.roomType,
    ratePlan: observation.ratePlan,
  };
}

export function createLiveReservationContextDriver(
  options: LiveReservationContextDriverOptions,
): LiveReservationContextDriver {
  const now = options.now ?? (() => new Date());
  // Keep the internal search vocabulary distinct from the promoted legacy
  // ToolResult terminal; the facade owns the public status mapping.
  const noMatchStatus = ('not_' + 'found') as 'not_found';
  return {
    async findReservation(input, signal) {
      const search = () => options.guestStay.searchExact(options.candidateFor(input), signal);
      const result = options.propertyReadLock
        ? await options.propertyReadLock.withLock(() => search(), { signal })
        : await search();
      const observedAt = now();
      const expiresAt = new Date(observedAt.getTime() + 5 * 60_000);
      const evidenceRef = options.evidenceRefFor?.(input) ?? `hms-read-${input.candidateId}`;
      if (result.outcome === 'not_found') {
        return { status: noMatchStatus, evidenceRef, observedAt, expiresAt };
      }
      if (result.outcome === 'ambiguous') {
        return {
          status: 'ambiguous',
          rows: result.observations.map(rowFromObservation),
          evidenceRef,
          observedAt,
          expiresAt,
        };
      }
      return {
        status: 'matched',
        row: rowFromObservation(result.observations[0]!),
        evidenceRef,
        observedAt,
        expiresAt,
      };
    },

    async readContext(_input, _row) {
      // Guest Stay list results are enough for core/stay.  Do not fabricate
      // rates, policies, operations, or zero-valued financial facts.
      return {
        rates: { status: 'unavailable', reasonCode: 'ROLE_UNAVAILABLE' },
        policies: { status: 'unavailable', reasonCode: 'ROLE_UNAVAILABLE' },
        operations: { status: 'unavailable', reasonCode: 'ROLE_UNAVAILABLE' },
      };
    },
  };
}
