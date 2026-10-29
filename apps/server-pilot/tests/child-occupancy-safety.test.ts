import { describe, expect, it } from 'vitest';
import { childOccupancyMatchesStored, singleStayOccupancyMatchesRevision } from '../src/ai/child-occupancy.js';
import { mailExtractionSchema, sanitizeExtraction } from '../src/ai/extraction/schema.js';
import { buildPreparedStaffQuotePlan } from '../src/ai/quote-ready.js';
import { prepareStaffQuote, staffQuoteInput, type StaffQuoteInput } from '../src/ai/staff-quote-workflow.js';
import { storedAnalysis } from '../src/ai/work-items.js';
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

  it('does not let a missing-age warning change an HRDAV quote or reply requirements', () => {
    const original = payload(null, []);
    const warning = { ...original, missing: [{ field: 'childAges', question: 'Confirm each child’s age.' }] };
    const quote = (source: unknown) => buildPreparedStaffQuotePlan({
      messageId: 'm1', sourceHash: 'a'.repeat(64), payload: source, propertyCode: 'HRDAV',
      now: new Date('2026-10-01T00:00:00Z'),
    });
    const cleanPlan = quote(original);
    expect(cleanPlan.inputs).toHaveLength(1);
    expect(quote(warning).inputs).toEqual(cleanPlan.inputs);
    expect(cleanPlan.inputs[0]?.groups[0]).not.toHaveProperty('childrenPerRoom');
    const analysis = (source: typeof warning) => storedAnalysis(
      { kind: 'quote', payload: source, attachments: [] }, {}, undefined, 'HRDAV',
    ).analysis;
    const without = analysis(original), withWarning = analysis(warning);
    expect(withWarning.groups).toEqual(without.groups);
    expect(withWarning.intent).toBe(without.intent);
    expect(withWarning.missingQuoteReplyFields).toEqual(without.missingQuoteReplyFields);
    expect(withWarning.reviewItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Confirm each child’s age.', blocking: false }),
    ]));
  });

  it('keeps the request-level count check Centurion-only', () => {
    const input = staffQuoteInput.parse({ messageId: 'm1', sourceHash: 'a'.repeat(64), selectionEpoch: 0,
      inputRevision: 0, groups: [group([], null)] });
    const scope = { transportId: 'transport-davinci', userId: 'staff', threadId: 't1', messageId: 'm1',
      sourceHash: input.sourceHash, propertyCode: 'HRDAV', messageAt: '2026-10-01T00:00:00Z', messageText: '' };
    const prepare = (propertyCode: string) => prepareStaffQuote(input, { ...scope, propertyCode },
      { signerName: '', signerEmail: '' }, new AbortController().signal);
    expect(() => prepare('HRDAV')).not.toThrow();
    expect(() => prepare('HRCEN')).toThrow('staff_quote_child_occupancy_incomplete');
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

  it('binds rooms and adults to the selected row and saved corrections', () => {
    const evidence = payload(0, []);
    const forged = { ...group([], 0), quantity: 3, adults: 1 };
    expect(childOccupancyMatchesStored([forged], evidence, {})).toBe(false);
    const state = { [`${base}.count`]: 3, [`${base}.adults`]: 1 };
    expect(childOccupancyMatchesStored([forged], evidence, state)).toBe(true);
    expect(childOccupancyMatchesStored([forged], evidence, { ...state, [`${base}.count`]: null })).toBe(false);
    expect(childOccupancyMatchesStored([forged], evidence, { ...state, [`${base}.adults`]: null })).toBe(false);
  });

  it('does not drop another child-bearing row of the selected stay', () => {
    const evidence = payload(0, []);
    const stay = evidence.stays[0]!;
    const second = { ...stay.rows[0]!, id: 'r_2', childrenPerRoom: 1, childAges: [] };
    const twoRows = { ...evidence, stays: [{ ...stay, rows: [...stay.rows, second] }] };
    expect(childOccupancyMatchesStored([group([], 0)], twoRows, {})).toBe(false);
    expect(childOccupancyMatchesStored([group([], 0)], twoRows, {
      [`stays[${stayId}].rows[r_2].removed`]: true,
    })).toBe(true);
  });

  it('accepts the pane’s unedited room and adult defaults only when their evidence exists', () => {
    const evidence = payload(0, []);
    const stay = evidence.stays[0]!;
    const row = stay.rows[0]!;
    const oneByGuest = { ...evidence, stays: [{ ...stay, totalRooms: null, rows: [{ ...row, rooms: null, adultsPerRoom: 1 }] }] };
    expect(childOccupancyMatchesStored([{ ...group([], 0), adults: 1 }], oneByGuest, {})).toBe(true);
    const totalRooms = { ...evidence, stays: [{ ...stay, totalRooms: 3, rows: [{ ...row, rooms: null, adultsPerRoom: null }] }] };
    expect(childOccupancyMatchesStored([{ ...group([], 0), quantity: 3 }], totalRooms, {})).toBe(true);
    const noRoomEvidence = { ...evidence, stays: [{ ...stay, totalRooms: null, rows: [{ ...row, rooms: null, adultsPerRoom: null }] }] };
    expect(childOccupancyMatchesStored([group([], 0)], noRoomEvidence, {})).toBe(false);
    expect(childOccupancyMatchesStored([{ ...group([], 0), quantity: 3 }], totalRooms, { [`${base}.count`]: null })).toBe(false);
    expect(childOccupancyMatchesStored([group([], 0)], evidence, { [`${base}.adults`]: null })).toBe(false);
  });

  it('does not treat a second staff-added row as a single-room-row default', () => {
    const evidence = payload(0, []);
    const stay = evidence.stays[0]!;
    const noRooms = { ...evidence, stays: [{ ...stay, totalRooms: 3, rows: [{ ...stay.rows[0]!, rooms: null }] }] };
    expect(childOccupancyMatchesStored([{ ...group([], 0), quantity: 3 }], noRooms, {
      [`stays[${stayId}].rows[r_added].count`]: 1,
    })).toBe(false);
  });

  it('matches the pane’s named-guest room default for each active row', () => {
    const evidence = payload(0, []);
    const stay = evidence.stays[0]!;
    const first = { ...stay.rows[0]!, rooms: null, adultsPerRoom: null };
    const second = { ...first, id: 'r_2' };
    const make = (guests: string[]) => ({ ...evidence, stays: [{ ...stay, totalRooms: null, rows: [first, second],
      guests: guests.map((name) => ({ name, confirmationNumber: null })) }] });
    const groups = [group([], 0), { ...group([], 0), id: 'r_2' }];
    expect(childOccupancyMatchesStored(groups, make(['First Guest', 'Second Guest']), {})).toBe(true);
    expect(childOccupancyMatchesStored(groups, make(['First Guest']), {})).toBe(false);
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
    expect(childOccupancyMatchesStored([group([], 0), added], evidence, {
      [`${addedBase}.childrenPerRoom`]: 1, [`${addedBase}.childAges`]: [5],
      [`${addedBase}.count`]: 1, [`${addedBase}.adults`]: 2,
    })).toBe(true);
  });

  it('supports a dates-only group after its derived row occupancy is saved', () => {
    const evidence = payload(0, []);
    evidence.stays[0]!.rows = [];
    const syntheticRow = `stays[${stayId}].rows[${stayId}_row]`;
    expect(childOccupancyMatchesStored([{ ...group([]), id: stayId }], evidence, {
      [`${syntheticRow}.childrenPerRoom`]: 0, [`${syntheticRow}.childAges`]: [],
      [`${syntheticRow}.count`]: 1, [`${syntheticRow}.adults`]: 2,
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

  it('uses the remaining saved row after other extracted rows are removed', () => {
    const evidence = payload(2, [7, 9]);
    const stay = evidence.stays[0]!;
    const twoRows = { ...evidence, stays: [{ ...stay, rows: [...stay.rows, { ...stay.rows[0]!, id: 'r_2' }] }] };
    expect(singleStayOccupancyMatchesRevision(revision, twoRows, { [`stays[${stayId}].rows[r_2].removed`]: true })).toBe(true);
    expect(singleStayOccupancyMatchesRevision(revision, twoRows, {})).toBe(false);
  });

  it('uses a staff-added row when the original row was removed', () => {
    const added = `stays[${stayId}].rows[r_added]`;
    const state = { [`${base}.removed`]: true, [`${added}.count`]: 1, [`${added}.adults`]: 2,
      [`${added}.childrenPerRoom`]: 2, [`${added}.childAges`]: [7, 9] };
    expect(singleStayOccupancyMatchesRevision(revision, payload(2, [7, 9]), state)).toBe(true);
    expect(singleStayOccupancyMatchesRevision(revision, payload(2, [7, 9]), { ...state, [`${added}.childrenPerRoom`]: null })).toBe(false);
  });

  it('finds a uniquely matching staff-added stay and its saved row', () => {
    const added = 'stays[s_added]';
    const row = `${added}.rows[r_added]`;
    const state = { [`stays[${stayId}].removed`]: true, [`${added}.requested.arrival`]: revision.groups[0]!.arrivalDate,
      [`${added}.requested.departure`]: revision.groups[0]!.departureDate, [`${row}.count`]: 1, [`${row}.adults`]: 2,
      [`${row}.childrenPerRoom`]: 2, [`${row}.childAges`]: [7, 9] };
    const evidence = payload(2, [7, 9]);
    expect(singleStayOccupancyMatchesRevision(revision, evidence, state)).toBe(true);
    expect(singleStayOccupancyMatchesRevision(revision, evidence, { ...state, [`stays[${stayId}].removed`]: false })).toBe(false);
  });

  it('finds a saved synthetic row for a dates-only stay', () => {
    const evidence = payload(2, [7, 9]);
    evidence.stays[0]!.rows = [];
    const row = `stays[${stayId}].rows[${stayId}_row]`;
    expect(singleStayOccupancyMatchesRevision(revision, evidence, {
      [`${row}.count`]: 1, [`${row}.adults`]: 2, [`${row}.childrenPerRoom`]: 2, [`${row}.childAges`]: [7, 9],
    })).toBe(true);
  });

  it('honours the same one-night default as the original quote admission', () => {
    const evidence = payload(2, [7, 9]);
    evidence.stays[0]!.requested.departure = null as never;
    expect(singleStayOccupancyMatchesRevision(revision, evidence, {})).toBe(true);
    expect(singleStayOccupancyMatchesRevision(revision, evidence, { [`stays[${stayId}].requested.departure`]: null })).toBe(false);
  });
});
