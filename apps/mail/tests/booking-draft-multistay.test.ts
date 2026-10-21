import { describe, expect, it } from 'vitest';
import { allocateSplitRooms, staySplitKind } from '../lib/quote-workflow/booking-draft';
import type { StayGroupRequirement } from '../lib/quote-workflow/types';

function row(over: Partial<StayGroupRequirement> = {}): StayGroupRequirement {
  return {
    id: 'g1',
    stayId: 'stay-a',
    arrivalDate: '2027-11-12',
    departureDate: '2027-11-14',
    quantity: 2,
    roomPreference: 'standard king',
    adults: 1,
    childrenAges: [],
    board: 'bb',
    specialRequests: [],
    fields: {},
    ...over,
  };
}

describe('booking drafts stay one per date key; pane split allocates rooms only 1:1 with guests', () => {
  it('gives each child one room of the source type and occupancy when guests equal rooms', () => {
    const source = [row({ quantity: 2, adults: 1, roomPreference: 'standard king' })];
    expect(staySplitKind(source, 2)).toBe('allocate');
    const children = allocateSplitRooms(source, 2);
    expect(children).toEqual([
      [expect.objectContaining({ quantity: 1, adults: 1, roomPreference: 'standard king' })],
      [expect.objectContaining({ quantity: 1, adults: 1, roomPreference: 'standard king' })],
    ]);
    expect(children?.reduce((sum, child) => sum + (child[0]?.quantity ?? 0), 0)).toBe(2);
  });

  it('does not invent rooms when two guests share one room', () => {
    const source = [row({ quantity: 1 })];
    expect(staySplitKind(source, 2)).toBe('hms');
    expect(allocateSplitRooms(source, 2)).toBeNull();
  });

  it('keeps mixed room types: each child gets one source unit, totals match', () => {
    const source = [
      row({ id: 'king', quantity: 1, roomPreference: 'standard king', adults: 1 }),
      row({ id: 'twin', quantity: 1, roomPreference: 'standard twin', adults: 2 }),
    ];
    const children = allocateSplitRooms(source, 2);
    expect(children?.[0]?.[0]).toEqual(expect.objectContaining({ roomPreference: 'standard king', adults: 1, quantity: 1 }));
    expect(children?.[1]?.[0]).toEqual(expect.objectContaining({ roomPreference: 'standard twin', adults: 2, quantity: 1 }));
  });
});
