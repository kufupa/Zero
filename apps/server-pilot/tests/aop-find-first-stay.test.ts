import { describe, expect, it } from 'vitest';
import {
  findFirstStayMatch,
  findFirstStayMatchDescription,
  findFirstStayMatchInputSchema,
  findFirstStayMatchOutputSchema,
} from '../src/ai/aop/find-first-stay.js';

function stay(partial: {
  confirmationNumber: string;
  lastName: string;
  arrival: string;
  departure?: string;
  status?: string;
  rooms?: number;
  notes?: string;
}) {
  return {
    confirmationNumber: partial.confirmationNumber,
    lastName: partial.lastName,
    arrival: partial.arrival,
    departure: partial.departure ?? '2026-11-14',
    status: partial.status ?? 'Reserved',
    rooms: partial.rooms,
    notes: partial.notes,
  };
}

const ask = { lastName: 'Smith', arrival: '2026-11-12' };

describe('findFirstStayMatch', () => {
  it('matches exact surname and the same arrival', () => {
    const result = findFirstStayMatch({
      ask,
      candidates: [stay({ confirmationNumber: '9999901-1', lastName: 'Smith', arrival: '2026-11-12' })],
    });
    expect(result.status).toBe('match');
    expect(result.confirmationNumber).toBe('9999901-1');
    expect(result.why.length).toBeGreaterThan(0);
  });

  it('matches surname case- and diacritic-insensitively', () => {
    const result = findFirstStayMatch({
      ask: { lastName: 'Muller', arrival: '2026-11-12' },
      candidates: [stay({ confirmationNumber: '9999902-1', lastName: 'Müller', arrival: '2026-11-12' })],
    });
    expect(result.status).toBe('match');
    expect(result.confirmationNumber).toBe('9999902-1');
  });

  it('matches when the voucher number appears in stay notes', () => {
    const result = findFirstStayMatch({
      ask: { lastName: 'Jones', arrival: '2026-12-01', voucherNumber: 'VCH-99993' },
      candidates: [
        stay({
          confirmationNumber: '9999903-1',
          lastName: 'Other',
          arrival: '2026-12-20',
          notes: 'Agent voucher VCH-99993 attached',
        }),
      ],
    });
    expect(result.status).toBe('match');
    expect(result.confirmationNumber).toBe('9999903-1');
  });

  it('does not match a voucher number that only appears inside a longer number', () => {
    const result = findFirstStayMatch({
      ask: { lastName: 'Jones', arrival: '2026-12-01', voucherNumber: '9993' },
      candidates: [
        stay({
          confirmationNumber: '9999903-1',
          lastName: 'Other',
          arrival: '2026-12-20',
          notes: 'Agent voucher 199934 attached',
        }),
      ],
    });
    expect(result.status).not.toBe('match');
  });

  it('never matches a cancelled stay, even with the same surname and arrival', () => {
    const result = findFirstStayMatch({
      ask,
      candidates: [
        stay({
          confirmationNumber: '9999904-1',
          lastName: 'Smith',
          arrival: '2026-11-12',
          status: 'Cancelled',
        }),
      ],
    });
    expect(result.status).toBe('none');
    expect(result.confirmationNumber).toBeNull();
  });

  it('returns possible when the surname matches and arrival is one day off', () => {
    const result = findFirstStayMatch({
      ask,
      candidates: [stay({ confirmationNumber: '9999905-1', lastName: 'Smith', arrival: '2026-11-13' })],
    });
    expect(result.status).toBe('possible');
    expect(result.confirmationNumber).toBeNull();
  });

  it('returns possible when arrival matches and the surname differs', () => {
    const result = findFirstStayMatch({
      ask,
      candidates: [stay({ confirmationNumber: '9999906-1', lastName: 'Jones', arrival: '2026-11-12' })],
    });
    expect(result.status).toBe('possible');
    expect(result.confirmationNumber).toBeNull();
  });

  it('returns conflict and picks nothing when two stays match', () => {
    const result = findFirstStayMatch({
      ask,
      candidates: [
        stay({ confirmationNumber: '9999907-1', lastName: 'Smith', arrival: '2026-11-12' }),
        stay({ confirmationNumber: '9999908-1', lastName: 'Smith', arrival: '2026-11-12' }),
      ],
    });
    expect(result.status).toBe('conflict');
    expect(result.confirmationNumber).toBeNull();
  });

  it('returns none when no candidate overlaps', () => {
    const result = findFirstStayMatch({
      ask,
      candidates: [stay({ confirmationNumber: '9999909-1', lastName: 'Jones', arrival: '2026-12-01' })],
    });
    expect(result.status).toBe('none');
    expect(result.confirmationNumber).toBeNull();
  });

  it('keeps the live match and ignores a cancelled twin', () => {
    const result = findFirstStayMatch({
      ask,
      candidates: [
        stay({
          confirmationNumber: '9999910-1',
          lastName: 'Smith',
          arrival: '2026-11-12',
          status: 'Cancelled',
        }),
        stay({ confirmationNumber: '9999911-1', lastName: 'Smith', arrival: '2026-11-12' }),
      ],
    });
    expect(result.status).toBe('match');
    expect(result.confirmationNumber).toBe('9999911-1');
  });

  it('prefers an exact match over a possible neighbour', () => {
    const result = findFirstStayMatch({
      ask,
      candidates: [
        stay({ confirmationNumber: '9999912-1', lastName: 'Smith', arrival: '2026-11-12' }),
        stay({ confirmationNumber: '9999913-1', lastName: 'Smith', arrival: '2026-11-13' }),
      ],
    });
    expect(result.status).toBe('match');
    expect(result.confirmationNumber).toBe('9999912-1');
  });

  it('matches a stated base confirmation to a single HMS leg', () => {
    const result = findFirstStayMatch({
      ask: { lastName: 'Smith', arrival: '2026-11-12', confirmationNumber: '9999920' },
      candidates: [
        stay({ confirmationNumber: '9999920-1', lastName: 'Smith', arrival: '2026-12-01' }),
      ],
    });
    expect(result.status).toBe('match');
    expect(result.confirmationNumber).toBe('9999920-1');
  });

  it('returns possible listing every live leg when a stated base matches two legs', () => {
    const result = findFirstStayMatch({
      ask: { lastName: 'Smith', arrival: '2026-11-12', confirmationNumber: '9999921' },
      candidates: [
        stay({ confirmationNumber: '9999921-1', lastName: 'Smith', arrival: '2026-12-01' }),
        stay({ confirmationNumber: '9999921-2', lastName: 'Smith', arrival: '2026-12-08' }),
      ],
    });
    expect(result.status).toBe('possible');
    expect(result.confirmationNumber).toBeNull();
    expect(result.why.join(' ')).toContain('9999921-1');
    expect(result.why.join(' ')).toContain('9999921-2');
  });

  it('matches a stated full confirmation to that exact leg', () => {
    const result = findFirstStayMatch({
      ask: { lastName: 'Smith', arrival: '2026-11-12', confirmationNumber: '9999922-2' },
      candidates: [
        stay({ confirmationNumber: '9999922-1', lastName: 'Smith', arrival: '2026-12-01' }),
        stay({ confirmationNumber: '9999922-2', lastName: 'Smith', arrival: '2026-12-08' }),
      ],
    });
    expect(result.status).toBe('match');
    expect(result.confirmationNumber).toBe('9999922-2');
  });

  it('returns conflict when a full confirmation matches and the surname contradicts', () => {
    const result = findFirstStayMatch({
      ask: { lastName: 'Smith', arrival: '2026-11-12', confirmationNumber: '9999923-2' },
      candidates: [
        stay({ confirmationNumber: '9999923-2', lastName: 'Jones', arrival: '2026-11-12' }),
      ],
    });
    expect(result.status).toBe('conflict');
    expect(result.confirmationNumber).toBeNull();
  });

  it('does not fall back to surname and arrival when a stated confirmation is not found', () => {
    const result = findFirstStayMatch({
      ask: { lastName: 'Smith', arrival: '2026-11-12', confirmationNumber: '9999925' },
      candidates: [stay({ confirmationNumber: '9999926-1', lastName: 'Smith', arrival: '2026-11-12' })],
    });
    expect(result.status).toBe('none');
    expect(result.confirmationNumber).toBeNull();
    expect(result.why.join(' ')).toContain('stated_conf_not_found');
  });

  it('does not narrow several legs of a stated base by surname or arrival', () => {
    const result = findFirstStayMatch({
      ask: { lastName: 'Smith', arrival: '2026-11-12', confirmationNumber: '9999927' },
      candidates: [
        stay({ confirmationNumber: '9999927-1', lastName: 'Smith', arrival: '2026-11-12' }),
        stay({ confirmationNumber: '9999927-2', lastName: 'Jones', arrival: '2026-11-13' }),
      ],
    });
    expect(result.status).toBe('possible');
    expect(result.confirmationNumber).toBeNull();
  });

  it('matches a stated full confirmation even when surname and arrival are unknown elsewhere', () => {
    const result = findFirstStayMatch({
      ask: { lastName: '', arrival: '', confirmationNumber: '9999928-1' },
      candidates: [stay({ confirmationNumber: '9999928-1', lastName: 'Smith', arrival: '2026-12-01' })],
    });
    expect(result.status).toBe('match');
    expect(result.confirmationNumber).toBe('9999928-1');
  });

  it('fails closed on a stated confirmation in an unknown format instead of falling back to surname', () => {
    const result = findFirstStayMatch({
      ask: { lastName: 'Smith', arrival: '2026-11-12', confirmationNumber: '12345678901' },
      candidates: [stay({ confirmationNumber: '9999929-1', lastName: 'Smith', arrival: '2026-11-12' })],
    });
    expect(result.status).toBe('none');
    expect(result.confirmationNumber).toBeNull();
    expect(result.why.join(' ')).toContain('stated_conf_not_found');
  });

  it('keeps a multi-word surname whole', () => {
    const result = findFirstStayMatch({
      ask: { lastName: 'De la Rey', arrival: '2026-11-12' },
      candidates: [stay({ confirmationNumber: '9999930-1', lastName: 'Rey', arrival: '2026-11-12' })],
    });
    expect(result.status).not.toBe('match');
    expect(result.confirmationNumber).toBeNull();
  });

  it('ignores a cancelled leg when matching a stated base confirmation', () => {
    const result = findFirstStayMatch({
      ask: { lastName: 'Smith', arrival: '2026-11-12', confirmationNumber: '9999924' },
      candidates: [
        stay({
          confirmationNumber: '9999924-1',
          lastName: 'Smith',
          arrival: '2026-12-01',
          status: 'Cancelled',
        }),
        stay({ confirmationNumber: '9999924-2', lastName: 'Smith', arrival: '2026-12-08' }),
      ],
    });
    expect(result.status).toBe('match');
    expect(result.confirmationNumber).toBe('9999924-2');
  });

  it('exports schemas and a description for the agent tool wrapper', () => {
    expect(findFirstStayMatchInputSchema.parse({ ask, candidates: [] }).candidates).toEqual([]);
    expect(
      findFirstStayMatchInputSchema.parse({
        ask: { ...ask, confirmationNumber: null },
        candidates: [],
      }).ask.confirmationNumber,
    ).toBeNull();
    expect(
      findFirstStayMatchOutputSchema.parse({
        status: 'none',
        confirmationNumber: null,
        why: ['no overlap'],
      }).status,
    ).toBe('none');
    expect(findFirstStayMatchDescription.toLowerCase()).toMatch(/find/);
    expect(findFirstStayMatchDescription.toLowerCase()).toMatch(/base/);
  });
});
