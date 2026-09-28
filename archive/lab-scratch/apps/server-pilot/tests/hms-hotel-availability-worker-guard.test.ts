import { describe, expect, it, vi } from 'vitest';
import { createReservationCandidateSession } from '../../../../../apps/server-pilot/src/hms/reservation-candidate-session.js';
import { quoteRequestSchema } from '../../../../../apps/server-pilot/src/hms/quote-request-normalization.js';

const request = quoteRequestSchema.parse({
  quoteRequestRef: 'q-1',
  propertyCode: 'HRCEN',
  arrival: '2026-09-20',
  departure: '2026-09-22',
  rooms: [
    {
      quantity: 1,
      adultsPerRoom: 2,
      childAges: [5],
      roomTypeRef: 'STD',
      ratePlanRef: 'BAR',
    },
  ],
  currency: 'ZAR',
  organizationRef: null,
  agencyRef: null,
  groupRef: null,
  segments: [
    {
      arrival: '2026-09-20',
      departure: '2026-09-22',
      rooms: [
        {
          quantity: 1,
          adultsPerRoom: 2,
          childAges: [5],
          roomTypeRef: 'STD',
          ratePlanRef: 'BAR',
        },
      ],
      currency: 'ZAR',
    },
  ],
  coveredNights: ['2026-09-20', '2026-09-21'],
  missingNights: [],
  continuousStay: true,
  roomMoveRequired: false,
  referenceAuthoritySourceRef: 'fixture:authority',
  referenceAuthorityVersion: 'v1',
  referenceAuthorityObservedAt: '2026-09-16T00:00:00.000Z',
  referenceAuthorityExpiresAt: '2099-01-01T00:00:00.000Z',
  referenceAuthoritySha256: 'a'.repeat(64),
});

describe('normal read quote surface guard', () => {
  it('does not advertise or invoke legacy OSRRAV without a Hotel Availability provider', async () => {
    const legacyObserve = vi.fn(async () => {
      throw new Error('OSRRAV must not run in read-only lane');
    });
    const session = createReservationCandidateSession({
      driver: {} as never,
      candidates: new Map(),
      close: async () => undefined,
      activeReleases: new Map([
        ['hms_quote_stay', {} as never],
      ]),
      readOnly: true,
      hotelAvailabilityRequests: new Map([['q-1', request]]),
      quoteDriver: { observeExactQuote: legacyObserve } as never,
      buildQuoteAuthorization: (() => ({}) as never) as never,
    });

    expect(session.activeToolIds.has('hms_quote_stay')).toBe(false);
    const result = await session.quoteStay('q-1', new AbortController().signal);
    expect(result.status).toBe('manual_required');
    expect(result.unresolvedFields).toContain('hotel_availability_provider');
    expect(legacyObserve).not.toHaveBeenCalled();
  });

  it('returns the same typed provider-unavailable result when quote is not active', async () => {
    const session = createReservationCandidateSession({
      driver: {} as never,
      candidates: new Map(),
      close: async () => undefined,
      readOnly: true,
      hotelAvailabilityRequests: new Map([['q-1', request]]),
    });

    expect(session.activeToolIds.has('hms_quote_stay')).toBe(false);
    const result = await session.quoteStay('q-1', new AbortController().signal);
    expect(result.status).toBe('manual_required');
    expect(result.unresolvedFields).toContain('hotel_availability_provider');
  });
});
