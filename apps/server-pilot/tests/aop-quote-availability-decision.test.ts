import { describe, expect, it } from 'vitest';
import { CENTURION_DINNER_ADD_ON } from '../src/ai/staff-quote-installation.js';
import {
  decideQuoteAvailability,
  decideQuoteAvailabilityDescription,
  decideQuoteAvailabilityInputSchema,
  decideQuoteAvailabilityOutputSchema,
} from '../src/ai/aop/quote-availability-decision.js';

const requested = {
  rooms: 4,
  adultsPerRoom: 2,
  arrival: '2026-11-18',
  departure: '2026-11-20',
  board: 'bb' as const,
};

describe('decideQuoteAvailability', () => {
  it('returns full with no replyLine when enough rooms cover the stay', () => {
    const result = decideQuoteAvailability({
      requested,
      available: [
        { roomType: 'TWN', rooms: 3 },
        { roomType: 'DBL', rooms: 2 },
      ],
    });

    expect(result).toEqual({
      decision: 'full',
      roomsAvailable: 5,
      roomsRequested: 4,
      nights: 2,
      assumedOneNight: false,
      dinnerLine: null,
      replyLine: null,
    });
    expect(decideQuoteAvailabilityOutputSchema.parse(result).decision).toBe('full');
  });

  it('returns partial with the proceed question when some but not all rooms exist', () => {
    const result = decideQuoteAvailability({
      requested,
      available: [{ roomType: 'TWN', rooms: 2 }],
    });

    expect(result.decision).toBe('partial');
    expect(result.roomsAvailable).toBe(2);
    expect(result.roomsRequested).toBe(4);
    expect(result.replyLine).toBe(
      'We have 2 of the 4 rooms for 18–20 Nov 2026; shall I proceed with 2?',
    );
  });

  it('returns sold_out with a one-line decline and no alternatives', () => {
    const result = decideQuoteAvailability({
      requested,
      available: [{ roomType: 'TWN', rooms: 0 }],
    });

    expect(result.decision).toBe('sold_out');
    expect(result.roomsAvailable).toBe(0);
    expect(result.replyLine).toBe('Unfortunately we are fully booked for 18–20 Nov 2026.');
    expect(result.replyLine).not.toMatch(/instead|alternative|other hotel|similar/i);
  });

  it('assumes one night and says so when departure is missing', () => {
    const result = decideQuoteAvailability({
      requested: { ...requested, departure: null, rooms: 1 },
      available: [{ roomType: 'SGL', rooms: 1 }],
    });

    expect(result.nights).toBe(1);
    expect(result.assumedOneNight).toBe(true);
    expect(result.decision).toBe('full');
    expect(result.replyLine).toBeNull();
  });

  it('uses assumed checkout in the partial date span when departure is missing', () => {
    const result = decideQuoteAvailability({
      requested: { ...requested, departure: null, rooms: 3 },
      available: [{ roomType: 'TWN', rooms: 1 }],
    });

    expect(result.assumedOneNight).toBe(true);
    expect(result.nights).toBe(1);
    expect(result.replyLine).toBe(
      'We have 1 of the 3 rooms for 18–19 Nov 2026 (1 night, as no departure date was given); shall I proceed with 1?',
    );
  });

  it('adds the Centurion Dinner Allowance line on DBB when no override is passed', () => {
    const result = decideQuoteAvailability({
      requested: { ...requested, board: 'dbb' },
      available: [{ roomType: 'TWN', rooms: 4 }],
    });

    expect(result.dinnerLine).toEqual(CENTURION_DINNER_ADD_ON);
    expect(result.dinnerLine).toEqual({
      amountMinor: 35_000,
      unit: 'per_person_per_night',
      label: 'Dinner Allowance',
    });
  });

  it('uses the passed dinner add-on on DBB and skips dinner on BB or room-only', () => {
    const override = {
      amountMinor: 40_000,
      unit: 'per_person' as const,
      label: 'Dinner buffet',
    };
    const dbb = decideQuoteAvailability({
      requested: { ...requested, board: 'dbb' },
      available: [{ roomType: 'TWN', rooms: 4 }],
      dinnerAddOn: override,
    });
    const bb = decideQuoteAvailability({
      requested,
      available: [{ roomType: 'TWN', rooms: 4 }],
      dinnerAddOn: override,
    });
    const roomOnly = decideQuoteAvailability({
      requested: { ...requested, board: 'room_only' },
      available: [{ roomType: 'TWN', rooms: 4 }],
    });

    expect(dbb.dinnerLine).toEqual(override);
    expect(bb.dinnerLine).toBeNull();
    expect(roomOnly.dinnerLine).toBeNull();
  });

  it('treats an empty availability list as sold out', () => {
    const result = decideQuoteAvailability({
      requested,
      available: [],
    });

    expect(result.decision).toBe('sold_out');
    expect(result.roomsAvailable).toBe(0);
    expect(result.replyLine).toContain('fully booked');
  });

  it('describes when the agent should call the tool and accepts its input schema', () => {
    expect(decideQuoteAvailabilityDescription).toMatch(/partial|sold_out|quote_stay/i);
    expect(
      decideQuoteAvailabilityInputSchema.parse({
        requested,
        available: [{ roomType: 'TWN', rooms: 1 }],
      }).requested.rooms,
    ).toBe(4);
  });

  it('rejects impossible calendar dates in the input schema', () => {
    const parsed = decideQuoteAvailabilityInputSchema.safeParse({
      requested: { ...requested, arrival: '2026-02-31' },
      available: [{ roomType: 'TWN', rooms: 1 }],
    });

    expect(parsed.success).toBe(false);
    expect(() =>
      decideQuoteAvailability({
        requested: { ...requested, arrival: '2026-02-31' },
        available: [{ roomType: 'TWN', rooms: 1 }],
      }),
    ).toThrow();
  });

  it('rejects an explicit departure on or before arrival without assuming one night', () => {
    expect(() =>
      decideQuoteAvailability({
        requested: { ...requested, arrival: '2026-11-20', departure: '2026-11-18' },
        available: [{ roomType: 'TWN', rooms: 1 }],
      }),
    ).toThrow(/departure_not_after_arrival/);
    expect(() =>
      decideQuoteAvailability({
        requested: { ...requested, arrival: '2026-11-20', departure: '2026-11-20' },
        available: [{ roomType: 'TWN', rooms: 1 }],
      }),
    ).toThrow(/departure_not_after_arrival/);
  });
});
