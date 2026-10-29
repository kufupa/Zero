import { describe, expect, it } from 'vitest';
import { childOccupancyMatchesStored, singleStayOccupancyMatchesRevision } from '../src/ai/child-occupancy.js';
import { mailExtractionSchema, sanitizeExtraction } from '../src/ai/extraction/schema.js';
import { buildPreparedStaffQuotePlan } from '../src/ai/quote-ready.js';
import { staffQuoteInput, type StaffQuoteInput } from '../src/ai/staff-quote-workflow.js';
import { AE1_OUTPUT, AE1_TEXT } from './fixtures/inbound-extraction.js';

const stayId = 's_1';
const rowId = 'r_1';
const base = `stays[${stayId}].rows[${rowId}]`;
const group = (ages: number[], childrenPerRoom?: number | null): StaffQuoteInput['groups'][number] => ({
  id: rowId, arrivalDate: '2027-10-20', departureDate: '2027-10-21', quantity: 1, adults: 2,
  childrenAges: ages, board: 'bb', ...(childrenPerRoom !== undefined ? { childrenPerRoom } : {}),
});
function payload(count: number | null | undefined, ages: number[]) {
  return {
    contact: { name: null, email: null, phone: null }, agency: null, endClient: null,
    confirmationNumbers: [], missing: [], stays: [{
      id: stayId, hotel: null, requested: { arrival: '2027-10-20', departure: '2027-10-21' },
      booked: null, totalRooms: 1, rows: [{
        id: rowId, roomType: null, rooms: 1, adultsPerRoom: 2,
        ...(count === undefined ? {} : { childrenPerRoom: count }), childAges: ages, board: null,
      }],
    }],
  };
}
function prefetch(count: number | null | undefined, ages: number[]) {
  return buildPreparedStaffQuotePlan({
    messageId: 'm1', sourceHash: 'a'.repeat(64), payload: payload(count, ages),
    now: new Date('2026-10-01T00:00:00Z'),
  });
}

describe('child occupancy extraction and prefetch', () => {
  it('preserves explicit counts, including zero and unknown, and flags missing ages', () => {
    const original = AE1_OUTPUT.stays[0]!;
    const row = original.rows[0]!;
    const parsed = mailExtractionSchema.parse({ ...AE1_OUTPUT, stays: [{ ...original, rows: [
      { ...row, childrenPerRoom: 0, childAges: [] },
      { ...row, childrenPerRoom: 2, childAges: [7] },
      { ...row, childrenPerRoom: null, childAges: [] },
      { ...row, childAges: [] },
    ] }] });
    const result = sanitizeExtraction(parsed, { messageId: 'm1', sourceText: AE1_TEXT }).payload;
    expect(result.stays[0]?.rows.map((item) => item.childrenPerRoom)).toEqual([0, 2, null, undefined]);
    expect(result.missing).toContainEqual(expect.objectContaining({ field: 'childAges' }));
  });

  it('does not sanitize an invalid age into evidence for zero children', () => {
    const original = AE1_OUTPUT.stays[0]!;
    const parsed = mailExtractionSchema.parse({ ...AE1_OUTPUT, stays: [{ ...original, rows: [
      { ...original.rows[0]!, childrenPerRoom: 0, childAges: [-1] },
    ] }] });
    const result = sanitizeExtraction(parsed, { messageId: 'm1', sourceText: AE1_TEXT }).payload;
    expect(result.stays[0]?.rows[0]).toMatchObject({ childrenPerRoom: null, childAges: [] });
    expect(result.missing).toContainEqual(expect.objectContaining({ field: 'childAges' }));
  });

  it.each([
    [undefined, [], 'missing_children_count'],
    [null, [], 'missing_children_count'],
    [2, [7], 'missing_child_ages'],
    [0, [7], 'missing_child_ages'],
  ] as const)('does not prefetch count %s and ages %j', (count, ages, reason) => {
    const plan = prefetch(count, [...ages]);
    expect(plan.inputs).toEqual([]);
    expect(plan.reason).toBe(reason);
  });

  it.each([[0, []], [2, [7, 9]]] as const)('prefetches complete count %s and ages %j', (count, ages) => {
    expect(prefetch(count, [...ages]).inputs[0]?.groups[0]).toMatchObject({
      childrenPerRoom: count, childrenAges: ages,
    });
  });
});

describe('quote input bound to saved occupancy evidence', () => {
  it('refuses omitted or forged child count/ages against a known child', () => {
    const evidence = payload(1, [7]);
    expect(childOccupancyMatchesStored([group([])], evidence, {})).toBe(false);
    expect(childOccupancyMatchesStored([group([], 0)], evidence, {})).toBe(false);
    expect(childOccupancyMatchesStored([group([7])], evidence, {})).toBe(true);
    expect(childOccupancyMatchesStored([group([7], 1)], evidence, {})).toBe(true);
  });

  it('requires an explicit saved count for an unknown or legacy read', () => {
    for (const count of [null, undefined]) {
      const evidence = payload(count, []);
      expect(childOccupancyMatchesStored([group([], 0)], evidence, {})).toBe(false);
      expect(childOccupancyMatchesStored([group([], 0)], evidence, { [`${base}.childrenPerRoom`]: 0 })).toBe(true);
    }
  });

  it('requires saved ages for each child and refuses a cleared age', () => {
    const evidence = payload(2, [7]);
    expect(childOccupancyMatchesStored([group([7, 9], 2)], evidence, {})).toBe(false);
    const state = { [`${base}.childAges`]: [7, 9] };
    expect(childOccupancyMatchesStored([group([7, 9], 2)], evidence, state)).toBe(true);
    expect(childOccupancyMatchesStored([group([], 0)], evidence, { ...state, [`${base}.childAges`]: null })).toBe(false);
  });

  it('allows a staff correction to zero only when the corrected count and ages are saved', () => {
    const evidence = payload(1, [7]);
    expect(childOccupancyMatchesStored([group([], 0)], evidence, { [`${base}.childAges`]: [] })).toBe(false);
    expect(childOccupancyMatchesStored([group([], 0)], evidence, {
      [`${base}.childrenPerRoom`]: 0, [`${base}.childAges`]: [],
    })).toBe(true);
    expect(childOccupancyMatchesStored([group([], 0)], evidence, {
      [`${base}.childrenPerRoom`]: 0, [`${base}.childAges`]: null,
    })).toBe(false);
  });

  it('does not bind an unknown, ambiguous, or removed row', () => {
    const evidence = payload(0, []);
    expect(childOccupancyMatchesStored([{ ...group([]), id: 'r_other' }], evidence, {})).toBe(false);
    expect(childOccupancyMatchesStored([group([])], evidence, { [`${base}.removed`]: true })).toBe(false);
    const duplicate = { ...evidence, stays: [...evidence.stays, { ...evidence.stays[0]!, id: 's_2' }] };
    expect(childOccupancyMatchesStored([group([])], duplicate, {})).toBe(false);
  });

  it('does not let one case borrow another case’s adult-only row', () => {
    const evidence = payload(0, []);
    const first = evidence.stays[0]!;
    const second = { ...first, id: 's_2', requested: { arrival: '2027-11-20', departure: '2027-11-21' },
      rows: [{ ...first.rows[0]!, id: 'r_2', childrenPerRoom: null, childAges: [] }] };
    expect(childOccupancyMatchesStored([{
      ...group([], 0), arrivalDate: '2027-11-20', departureDate: '2027-11-21',
    }], { ...evidence, stays: [first, second] }, {})).toBe(false);
  });

  it('uses saved date corrections and treats an explicit cleared date as unknown', () => {
    const evidence = payload(0, []);
    const moved = { ...group([], 0), arrivalDate: '2027-10-22', departureDate: '2027-10-23' };
    expect(childOccupancyMatchesStored([moved], evidence, {})).toBe(false);
    const dates = { [`stays[${stayId}].requested.arrival`]: moved.arrivalDate,
      [`stays[${stayId}].requested.departure`]: moved.departureDate };
    expect(childOccupancyMatchesStored([moved], evidence, dates)).toBe(true);
    expect(childOccupancyMatchesStored([moved], evidence, { ...dates, [`stays[${stayId}].requested.departure`]: null })).toBe(false);
  });

  it('keeps the existing one-night default only for an unspecified checkout', () => {
    const evidence = payload(0, []);
    evidence.stays[0]!.requested.departure = null as never;
    expect(childOccupancyMatchesStored([group([], 0)], evidence, {})).toBe(true);
    expect(childOccupancyMatchesStored([group([], 0)], evidence, {
      [`stays[${stayId}].requested.departure`]: null,
    })).toBe(false);
  });

  it('supports staff-added rows only with an explicit saved count and ages', () => {
    const evidence = payload(0, []);
    const added = { ...group([5], 1), id: 'r_added' };
    const addedBase = `stays[${stayId}].rows[r_added]`;
    expect(childOccupancyMatchesStored([added], evidence, { [`${addedBase}.childrenPerRoom`]: 1 })).toBe(false);
    expect(childOccupancyMatchesStored([added], evidence, {
      [`${addedBase}.childrenPerRoom`]: 1, [`${addedBase}.childAges`]: [5],
    })).toBe(true);
  });

  it('supports a dates-only group after its derived row occupancy is saved', () => {
    const evidence = payload(0, []);
    evidence.stays[0]!.rows = [];
    const syntheticRow = `stays[${stayId}].rows[${stayId}_row]`;
    expect(childOccupancyMatchesStored([{ ...group([]), id: stayId }], evidence, {
      [`${syntheticRow}.childrenPerRoom`]: 0, [`${syntheticRow}.childAges`]: [],
    })).toBe(true);
  });

  it('treats age zero as an explicit infant age, not an unknown placeholder', () => {
    expect(childOccupancyMatchesStored([group([0], 1)], payload(1, [0]), {})).toBe(true);
  });

  it('keeps the optional wire field parseable for old clients while preserving null', () => {
    const input = { messageId: 'm1', sourceHash: 'a'.repeat(64), selectionEpoch: 0, inputRevision: 0 };
    expect(staffQuoteInput.parse({ ...input, groups: [group([])] }).groups[0]?.childrenPerRoom).toBeUndefined();
    expect(staffQuoteInput.parse({ ...input, groups: [group([], null)] }).groups[0]?.childrenPerRoom).toBeNull();
  });
});

describe('cross-email reuse of a single stay', () => {
  const revision = { groups: [{
    arrivalDate: '2027-10-20', departureDate: '2027-10-21', quantity: 1, adults: 2,
    children: 2, childAges: [9, 7],
  }] };

  it('matches complete occupancy without assigning ages to named children', () => {
    expect(singleStayOccupancyMatchesRevision(revision, payload(2, [7, 9]), {})).toBe(true);
  });

  it('refuses unknown, incomplete, changed, or cleared occupancy', () => {
    expect(singleStayOccupancyMatchesRevision(revision, payload(null, [7, 9]), {})).toBe(false);
    expect(singleStayOccupancyMatchesRevision(revision, payload(2, [7]), {})).toBe(false);
    expect(singleStayOccupancyMatchesRevision(revision, payload(2, [7, 10]), {})).toBe(false);
    expect(singleStayOccupancyMatchesRevision(revision, payload(2, [7, 9]), { [`${base}.childAges`]: null })).toBe(false);
  });

  it('refuses ambiguous rooms, duplicate dates and changed room counts', () => {
    const evidence = payload(2, [7, 9]);
    const stay = evidence.stays[0]!;
    expect(singleStayOccupancyMatchesRevision(revision, {
      ...evidence, stays: [{ ...stay, rows: [...stay.rows, { ...stay.rows[0]!, id: 'r_2' }] }],
    }, {})).toBe(false);
    expect(singleStayOccupancyMatchesRevision(revision, {
      ...evidence, stays: [stay, { ...stay, id: 's_2' }],
    }, {})).toBe(false);
    expect(singleStayOccupancyMatchesRevision(revision, evidence, { [`${base}.count`]: 2 })).toBe(false);
  });
});
