import { describe, expect, it } from 'vitest';
import {
  availabilitySnapshotOf,
  type AvailabilityRequest,
  type QuoteEnvelope,
} from '../src/ai/hms-availability.js';

const quoteReader = (await import('../tooling/playwright-quote/fetch-quote.mjs' as string)) as {
  extractOptions: (
    request: {
      propertyCode: string;
      arrivalDate: string;
      departureDate: string;
      details: string;
      rooms: Array<{ id: string; quantity: number; adults: number; children: number; childAges: number[] }>;
    },
    room: { id: string; quantity: number; adults: number; children: number; childAges: number[] },
    windows: Array<{ data: unknown; calendar: unknown }>,
  ) => { options: Array<Record<string, unknown>> };
};
const quoteFixtures = (await import('../tooling/playwright-quote/fetch-quote-fixtures.mjs' as string)) as {
  selectionFixture: () => { data: unknown; calendar: unknown; rate: Record<string, unknown> };
};

const request: AvailabilityRequest = {
  kind: 'availability',
  arrival: '2026-09-24',
  departure: '2026-09-27',
  rooms: [{ roomType: 'All room types', quantity: 2, adults: 1, childAges: [] }],
};
const quoteRequest = {
  propertyCode: 'HRCEN',
  arrivalDate: request.arrival,
  departureDate: request.departure,
  details: 'summary',
  rooms: [{ id: 'group-1', quantity: 2, adults: 1, children: 0, childAges: [] }],
};

describe('whole-stay bookability in availability snapshots', () => {
  it.each([
    {
      label: 'minimum stay',
      rule: 'minLOS',
      limit: 4,
      reason: 'Rate minimum stay requires 4 nights; requested stay is 3 nights.',
    },
    {
      label: 'maximum stay',
      rule: 'maxLOS',
      limit: 2,
      reason: 'Rate maximum stay allows 2 nights; requested stay is 3 nights.',
    },
  ])('marks stocked nights restricted for a $label violation and gives reason', ({ rule, limit, reason }) => {
    const fixture = quoteFixtures.selectionFixture();
    fixture.rate[rule] = limit;
    const read = quoteReader.extractOptions(quoteRequest, quoteRequest.rooms[0]!, [
      { data: fixture.data, calendar: fixture.calendar },
    ]);
    const snapshot = availabilitySnapshotOf(
      {
        outcome: 'partial',
        groups: [{ id: 'group-1', outcome: 'partial', options: read.options }],
      } as unknown as QuoteEnvelope,
      request,
    );

    const option = snapshot.groups[0]!.options[0]!;
    expect(read.options[0]).toMatchObject({ availability: 'restricted', availabilityReason: reason });
    expect(option).toMatchObject({ availability: 'restricted', availabilityReason: reason });
    expect(option.nightly).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          availableCount: 3,
          stockStatus: 'restricted',
          restrictionReason: reason,
        }),
      ]),
    );
    expect(snapshot.availableOptions).toBe(0);
  });
});
