import type { QuoteRevision } from '../src/quote-proposal/quote-revision.js';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';
import type { LunaAnalysis } from '../src/ai/reservationist-decision.js';
import { buildBookingDrafts } from '../src/ai/booking-draft.js';
import { analysisMatchesQuotedStay } from '../src/ai/prior-quote-booking.js';
import { describe, expect, it } from 'vitest';

// The server builds one booking draft per stay. Each stay's draft takes guests from the analysis row at that
// stay index, so two stays on the same dates keep their own names.

const COMPLETE_DEFAULTS = {
  track: 'BAR',
  sourceOfBusiness: 'Travel Agent',
  guaranteeType: 'Guaranteed By Agent',
} as const;

const NOV = { arrival: '2026-10-12', departure: '2026-10-13' };
const DEC = { arrival: '2026-12-01', departure: '2026-12-03' };

/** Accepts every request: these tests check rooms, guests and rate checks, not the create schema. */
const acceptAll = async () => ({ ok: true, errors: [] as unknown[] });

function row(
  stay: { arrival: string; departure: string },
  guestNames: string[],
): LunaAnalysis['groups'][number] {
  return {
    arrival: stay.arrival,
    departure: stay.departure,
    rooms: 2,
    adultsPerRoom: 1,
    childAges: [],
    board: 'room_only',
    roomPreference: null,
    guestNames,
  };
}

function analysis(groups: LunaAnalysis['groups'], over: Partial<LunaAnalysis> = {}): LunaAnalysis {
  return {
    workflow: 'create_booking',
    flags: [],
    groups,
    party: { kind: 'agency', name: 'XYZ TRAVEL', reference: null },
    rateClaims: [],
    missing: [],
    evidence: [],
    tasks: [],
    ...over,
  };
}

/** One stay's quoted revision: an agency-rated room for the given dates. */
async function stayRevision(stay: { arrival: string; departure: string }): Promise<QuoteRevision> {
  const revision = structuredClone(await syntheticRevision(['1850.00'], 'Room Only R', 'STQN'));
  const group = revision.groups[0]!;
  group.rateCode = 'TAXYZ';
  group.context = { agency: { id: '17', code: 'TAXYZ', name: 'XYZ TRAVEL' } };
  group.arrivalDate = stay.arrival;
  group.departureDate = stay.departure;
  return revision;
}

function draftFor(
  revision: QuoteRevision,
  groups: LunaAnalysis['groups'],
  over: Partial<LunaAnalysis> = {},
) {
  return buildBookingDrafts({
    analysis: analysis(groups, over),
    revision,
    defaults: COMPLETE_DEFAULTS,
    messageId: 'message-1',
    validate: acceptAll,
  });
}

describe('booking drafts for a multi-stay quote', () => {
  it('builds one draft per stay, each with that stay rooms and its own guests', async () => {
    const november = await draftFor(await stayRevision(NOV), [row(NOV, ['Mr John Smith'])]);
    const december = await draftFor(await stayRevision(DEC), [row(DEC, ['Jane Doe'])]);

    expect(november.rooms).toHaveLength(2);
    expect(november.rooms[0]!.request).toMatchObject({ firstName: 'John', lastName: 'Smith' });
    expect(december.rooms).toHaveLength(2);
    expect(december.rooms[0]!.request).toMatchObject({ firstName: 'Jane', lastName: 'Doe' });
    expect(december.rooms[0]!.request).toMatchObject({ ratePlan: 'TAXYZ', agency: 'XYZ TRAVEL' });
  });

  it('keeps each same-date stay its own guests', async () => {
    const stay = NOV;
    const revision = await stayRevision(stay);
    const second = structuredClone(revision.groups[0]!);
    second.id = 'g2';
    second.quantity = 1;
    revision.groups[0]!.quantity = 1;
    revision.groups.push(second);
    const draft = await draftFor(revision, [row(stay, ['Ada Example']), row(stay, ['Bea Example'])]);
    const ada = draft.rooms.filter((room) => room.groupId === revision.groups[0]!.id);
    const bea = draft.rooms.filter((room) => room.groupId === 'g2');
    expect(ada[0]!.request).toMatchObject({ firstName: 'Ada', lastName: 'Example' });
    expect(bea[0]!.request).toMatchObject({ firstName: 'Bea', lastName: 'Example' });
  });

  it('a stay whose dates match no analysis row still takes guests at that stay index', async () => {
    const revision = await stayRevision({ arrival: '2026-12-05', departure: '2026-12-07' });
    const draft = await draftFor(revision, [row(NOV, ['Ada Example']), row(DEC, ['Bea Example'])]);

    expect(draft.rooms[0]!.request).toMatchObject({ firstName: 'Ada', lastName: 'Example' });
  });

  it('a single stay keeps the position fallback when the analysis wrote its dates differently', async () => {
    const revision = await stayRevision(NOV);
    const draft = await draftFor(revision, [
      row({ arrival: '2026-11-01', departure: '2026-11-03' }, ['Mr John Smith']),
    ]);

    expect(draft.rooms[0]!.request).toMatchObject({ firstName: 'John', lastName: 'Smith' });
  });

  it('cannot check a rate claim while the analysis holds more than one stay', async () => {
    const claim = {
      kind: 'exact' as const,
      amount: '1850.00',
      currency: 'ZAR',
      basis: 'per_room_per_night' as const,
      taxBasis: 'gross_included' as const,
      quote: '1850.00',
    };
    const draft = await draftFor(await stayRevision(NOV), [row(NOV, []), row(DEC, [])], {
      rateClaims: [claim],
    });

    expect(draft.rateCheck[0]).toMatchObject({ status: 'cannot_check', reason: 'ambiguous_stay' });
  });
});

// A prior quote is bound to the one stay it quotes. The other stays of the same request are other revisions' stays.
describe('prior quote scope for a multi-stay request', () => {
  const quotedRooms = (stay: { arrival: string; departure: string }, quantity = 2) => ({
    arrivalDate: stay.arrival,
    departureDate: stay.departure,
    quantity,
    adults: 1,
  });
  const revisionOf = (...groups: ReturnType<typeof quotedRooms>[]) =>
    ({ groups }) as unknown as Pick<QuoteRevision, 'groups'>;
  const other = { arrival: '2026-12-05', departure: '2026-12-07' };

  it('a revision for one of two asked stays matches that stay', () => {
    expect(analysisMatchesQuotedStay(analysis([row(NOV, []), row(DEC, [])]), revisionOf(quotedRooms(NOV)))).toBe(true);
  });

  it('a revision that also quotes a stay the request does not ask for does not match', () => {
    const quotes = revisionOf(quotedRooms(NOV), quotedRooms(other));
    expect(analysisMatchesQuotedStay(analysis([row(NOV, []), row(DEC, [])]), quotes)).toBe(false);
  });

  it('a revision for a stay the request does not ask for matches nothing', () => {
    expect(analysisMatchesQuotedStay(analysis([row(NOV, []), row(DEC, [])]), revisionOf(quotedRooms(other)))).toBe(false);
  });

  it('a single stay still matches only with the same room count', () => {
    expect(analysisMatchesQuotedStay(analysis([row(NOV, [])]), revisionOf(quotedRooms(NOV, 2)))).toBe(true);
    expect(analysisMatchesQuotedStay(analysis([row(NOV, [])]), revisionOf(quotedRooms(NOV, 1)))).toBe(false);
  });
});
