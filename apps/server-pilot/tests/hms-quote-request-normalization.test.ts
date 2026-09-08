import {
  normalizeQuoteRequest,
  normalizeQuoteRequestFromAuthoredSegment,
  quoteRequestSchema,
} from '../src/hms/quote-request-normalization.js';
import { describe, expect, it } from 'vitest';

describe('trusted quote request normalization', () => {
  it('clarifies conflicting date aliases instead of choosing one silently', () => {
    const result = normalizeQuoteRequest({
      arrival: '2026-09-10',
      arrivalDate: '2026-09-11',
      departure: '2026-09-12',
      departureDate: '2026-09-13',
      rooms: [{ quantity: 1, adultsPerRoom: 2, childAges: [] }],
      currency: 'ZAR',
    });
    expect(result.status).toBe('clarification');
    if (result.status === 'clarification') {
      expect(result.unresolvedInputs).toEqual(
        expect.arrayContaining(['arrival_ambiguous', 'departure_ambiguous']),
      );
    }
  });

  it('normalizes explicit occupancy and preserves authorized references deterministically', () => {
    const input = {
      arrival: '2026-09-10',
      departure: '2026-09-12',
      rooms: [
        {
          quantity: 1,
          adultsPerRoom: 2,
          childAges: [4],
          roomTypeRef: 'STD',
          ratePlanRef: 'BAR',
        },
      ],
      currency: 'ZAR',
      organizationRef: 'org-centurion',
      agencyRef: 'agency-7',
      groupRef: 'group-42',
    };

    const first = normalizeQuoteRequest(input);
    const second = normalizeQuoteRequest(input);

    expect(first.status).toBe('ready');
    expect(second).toEqual(first);
    if (first.status !== 'ready') return;
    expect(quoteRequestSchema.parse(first.request)).toEqual(first.request);
    expect(first.request).toMatchObject({
      arrival: '2026-09-10',
      departure: '2026-09-12',
      currency: 'ZAR',
      organizationRef: 'org-centurion',
      agencyRef: 'agency-7',
      groupRef: 'group-42',
      rooms: [
        {
          quantity: 1,
          adultsPerRoom: 2,
          childAges: [4],
          roomTypeRef: 'STD',
          ratePlanRef: 'BAR',
        },
      ],
    });
    expect(first.request.quoteRequestRef).toMatch(/^quote_stay_request:[a-f0-9]{64}$/);
  });

  it('returns clarification for missing child age and never invents currency', () => {
    const result = normalizeQuoteRequest({
      arrival: '2026-09-10',
      departure: '2026-09-12',
      rooms: [
        {
          quantity: 1,
          adultsPerRoom: 2,
          children: 1,
          childAges: [],
          roomTypeRef: null,
          ratePlanRef: null,
        },
      ],
    });

    expect(result.status).toBe('clarification');
    if (result.status !== 'clarification') return;
    expect(result.unresolvedInputs).toEqual(expect.arrayContaining(['currency', 'child_age:0:0']));
    expect(result.request).toBeNull();
  });

  it.each([
    {
      name: 'ambiguous locale dates',
      input: {
        arrival: '10/09/2026',
        departure: '12/09/2026',
        currency: 'ZAR',
        rooms: [{ quantity: 1, adultsPerRoom: 2, childAges: [] }],
      },
    },
    {
      name: 'overlong stay',
      input: {
        arrival: '2026-09-10',
        departure: '2026-10-20',
        currency: 'ZAR',
        rooms: [{ quantity: 1, adultsPerRoom: 2, childAges: [] }],
      },
    },
  ])('$name is clarification, never a defaulted request', ({ input }) => {
    const result = normalizeQuoteRequest(input);
    expect(result.status).toBe('clarification');
    if (result.status !== 'clarification') return;
    expect(result.request).toBeNull();
    expect(result.unresolvedInputs.length).toBeGreaterThan(0);
  });

  it('keeps split segments explicit and requires complete contiguous coverage', () => {
    const result = normalizeQuoteRequest({
      arrival: '2026-09-10',
      departure: '2026-09-12',
      currency: 'ZAR',
      rooms: [{ quantity: 1, adultsPerRoom: 2, childAges: [] }],
      segments: [
        {
          arrival: '2026-09-10',
          departure: '2026-09-11',
          rooms: [{ quantity: 1, adultsPerRoom: 2, childAges: [] }],
        },
        {
          arrival: '2026-09-11',
          departure: '2026-09-12',
          rooms: [{ quantity: 1, adultsPerRoom: 2, childAges: [] }],
        },
      ],
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.request.segments).toHaveLength(2);
    expect(result.request.coveredNights).toEqual(['2026-09-10', '2026-09-11']);
    expect(result.request.roomMoveRequired).toBe(false);
  });

  it('mints only from an explicit authored quote tuple with currency', () => {
    const result = normalizeQuoteRequestFromAuthoredSegment(
      'Please quote arrival 2026-09-10, departure 2026-09-12, 2 adults, 0 children, 1 room, room type STD, rate plan BAR, currency ZAR.',
    );
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.request.currency).toBe('ZAR');
    expect(result.request.rooms[0]).toMatchObject({
      adultsPerRoom: 2,
      childAges: [],
      roomTypeRef: 'STD',
      ratePlanRef: 'BAR',
    });
  });
});
