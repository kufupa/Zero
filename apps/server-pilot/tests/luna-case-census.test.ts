import { describe, expect, it } from 'vitest';
import { staffEquivalentOf } from '../scripts/luna-case-census.ts';
import type { LunaAnalysis } from '../src/ai/reservationist-decision.js';

const group = {
  arrival: '2026-11-12',
  departure: '2026-11-14',
  rooms: 1,
  adultsPerRoom: 2,
  childAges: [] as number[],
  board: 'bb' as const,
  roomPreference: null,
  guestNames: [] as string[],
};

function analysis(overrides: Partial<LunaAnalysis> = {}): LunaAnalysis {
  return {
    workflow: 'quote',
    flags: [],
    groups: [group],
    party: { kind: 'private', name: null, reference: null },
    rateClaims: [],
    missing: [],
    evidence: [],
    tasks: [{ kind: 'quote', groupIndexes: [0], note: 'quote' }],
    ...overrides,
  };
}

describe('staffEquivalentOf', () => {
  it('counts extras and unread flags as staff-equivalent when dates and occupancy are present', () => {
    expect(
      staffEquivalentOf(analysis({ flags: ['extras', 'attachment_unread', 'discount'] })),
    ).toBe(true);
  });

  it('rejects conference, amendment, long stay, other, and missing dates', () => {
    expect(staffEquivalentOf(analysis({ flags: ['conference_or_group'] }))).toBe(false);
    expect(staffEquivalentOf(analysis({ workflow: 'other' }))).toBe(false);
    expect(
      staffEquivalentOf(
        analysis({ groups: [{ ...group, arrival: null as unknown as string }] }),
      ),
    ).toBe(false);
  });
});
