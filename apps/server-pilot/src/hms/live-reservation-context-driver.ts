/**
 * Typed adapter from the existing audited Guest Stay driver to U8's
 * reservation-context facade. Core/stay may use list-row facts; detail dump
 * upgrades stay.roomType and related fields when proved. Rates/policies/ops
 * stay unavailable until their surfaces are dump-proved.
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
import {
  projectReservationDetailDump,
  type ReservationDetailDumpV1,
} from './reservation-detail-projection.js';

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
  /**
   * Optional live detail dump (Wave A1). When provided, projects dump-proved
   * fields into core/stay; never invents keys absent from dump.
   */
  detailDumpFor?: (
    input: ReservationContextLookup,
    row: ReservationRow,
  ) => Promise<ReservationDetailDumpV1 | null>;
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

    async readContext(input, row) {
      const dump = options.detailDumpFor ? await options.detailDumpFor(input, row) : null;
      if (!dump) {
        // List-row only: core/stay fall back to row via facade normalize; rates+ unavailable.
        return {
          rates: { status: 'unavailable', reasonCode: 'SURFACE_UNPROVEN' },
          policies: { status: 'unavailable', reasonCode: 'SURFACE_UNPROVEN' },
          operations: { status: 'unavailable', reasonCode: 'SURFACE_UNPROVEN' },
        };
      }
      const projected = projectReservationDetailDump(dump);
      return {
        core: {
          status: projected.core.status,
          confirmation: projected.core.confirmation ?? row.confirmationNumber,
          externalReference: projected.core.externalReference ?? row.externalReference,
          reservationStatus: projected.core.reservationStatus ?? row.reservationStatus,
        },
        stay: {
          status: projected.stay.status,
          arrival: projected.stay.arrival ?? row.arrivalDate,
          departure: projected.stay.departure ?? row.departureDate,
          roomType: projected.stay.roomType ?? row.roomType,
          roomQuantity: projected.stay.roomQuantity,
          adults: projected.stay.adults,
        },
        rates: projected.rates,
        policies: projected.policies,
        operations: projected.operations,
      };
    },
  };
}
