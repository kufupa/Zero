import { describe, expect, it } from 'vitest';
import { reconcilePaneCreateScope } from '../src/ai/pane-create-scope.js';
import { paneOwnRowsFromEvents } from '../src/ai/pane-create-scope-origin.js';

const stay = { firstName: 'Proof', lastName: 'Labtest', arrival: '2027-03-01', departure: '2027-03-03',
  adults: 1, childAges: [], sourceOfBusiness: 'Walk in', roomType: 'STQN', ratePlan: 'BAR',
  track: '', guaranteeType: 'NGI', reservationNote: 'Staff reviewed booking', propertyCode: 'HRCEN' };
const row = { id: 'r1', roomType: null, rooms: 1, adultsPerRoom: 1, childAges: [], board: null };
const extractedStay = { id: 's1', hotel: null, requested: { arrival: '2027-03-01', departure: '2027-03-03' },
  booked: null, totalRooms: 1, totalAdults: 1, totalChildren: 0, rows: [row] };
const payload = { contact: { name: null, email: null, phone: null }, agency: null, endClient: null,
  confirmationNumbers: [], stays: [extractedStay], missing: [] };
const base = { payload, state: {}, identity: { stayId: 's1', rowId: 'r1', roomIndex: 1 },
  party: { kind: 'none' as const }, stay };

describe('create scope reconciliation', () => {
  it('accepts one synchronized room and rejects wrong row or sibling identity', () => {
    expect(reconcilePaneCreateScope(base)).toBe(true);
    expect(reconcilePaneCreateScope({ ...base, identity: { ...base.identity, rowId: 'other' } })).toBe(false);
    expect(reconcilePaneCreateScope({ ...base, identity: { ...base.identity, roomIndex: 2 } })).toBe(false);
    expect(reconcilePaneCreateScope({ ...base, payload: { ...payload, stays: [extractedStay, { ...extractedStay, id: 's2' }] } })).toBe(false);
    expect(reconcilePaneCreateScope({ ...base, payload: { ...payload, stays: [{ ...extractedStay, rows: [row, { ...row, id: 'r2' }] }] } })).toBe(false);
  });
  it('refuses unverified parties, dates, occupancy, orphan edits and removed rows', () => {
    expect(reconcilePaneCreateScope({ ...base, party: { kind: 'unknown' } })).toBe(false);
    expect(reconcilePaneCreateScope({ ...base, party: { kind: 'selected', company: '42:Company', agency: null } })).toBe(false);
    expect(reconcilePaneCreateScope({ ...base, stay: { ...stay, arrival: '2027-03-02' } })).toBe(false);
    expect(reconcilePaneCreateScope({ ...base, state: { 'stays[s1].totalAdults': 2 } })).toBe(false);
    expect(reconcilePaneCreateScope({ ...base, state: { 'stays[s1].rows[r1].childAges': null } })).toBe(false);
    expect(reconcilePaneCreateScope({ ...base, state: { 'stays[s1].rows[other].count': 1 } })).toBe(false);
    expect(reconcilePaneCreateScope({ ...base, state: { 'stays[s1].rows[r1].removed': true } })).toBe(false);
  });
  it('refuses party fields when the reviewed party context is none', () => {
    expect(reconcilePaneCreateScope({ ...base, stay: { ...stay, bookingAgency: { nativeId: '1', name: 'Agency' } } })).toBe(false);
    expect(reconcilePaneCreateScope({ ...base, stay: { ...stay, organization: { nativeId: '2', name: 'Company' } } })).toBe(false);
  });
  it('ignores deleted additions but still rejects active orphan paths', () => {
    expect(reconcilePaneCreateScope({ ...base, state: { 'stays[s1].rows[r2].count': 1,
      'stays[s1].rows[r2].removed': true } })).toBe(true);
    expect(reconcilePaneCreateScope({ ...base, state: { 'stays[s2].requested.arrival': '2027-04-01',
      'stays[s2].rows[r2].count': 1, 'stays[s2].removed': true } })).toBe(true);
    expect(reconcilePaneCreateScope({ ...base, state: { 'stays[s1].rows[r2].count': 1 } })).toBe(false);
    expect(reconcilePaneCreateScope({ ...base, state: { 'stays[s1].rows[r2].unknown': 1,
      'stays[s1].rows[r2].removed': true } })).toBe(false);
  });
  it('binds the reviewed room choice to the correct extracted or staff-edited row', () => {
    const queen = { ...payload, stays: [{ ...extractedStay, rows: [{ ...row, roomType: 'Standard Queen' }] }] };
    expect(reconcilePaneCreateScope({ ...base, payload: queen })).toBe(true);
    expect(reconcilePaneCreateScope({ ...base, payload: queen, stay: { ...stay, roomType: 'STWN' } })).toBe(false);
    expect(reconcilePaneCreateScope({ ...base, payload: queen, stay: { ...stay, roomType: 'STWN' },
      state: { 'stays[s1].rows[r1].roomType': 'STWN' } })).toBe(true);
    expect(reconcilePaneCreateScope({ ...base, payload: queen, state: { 'stays[s1].rows[r1].roomType': 'STWN' } })).toBe(false);
    expect(reconcilePaneCreateScope({ ...base, payload: { ...payload, stays: [
      { ...extractedStay, rows: [{ ...row, roomType: 'Standard room' }] },
    ] } })).toBe(false);
    // A missing extracted room type remains available for an explicit staff choice.
    expect(reconcilePaneCreateScope(base)).toBe(true);
  });
  it('accepts an explicit correction to one room but never guesses an unknown count', () => {
    const two = { ...payload, stays: [{ ...extractedStay, totalRooms: 2, rows: [{ ...row, rooms: 2 }] }] };
    expect(reconcilePaneCreateScope({ ...base, payload: two })).toBe(false);
    expect(reconcilePaneCreateScope({ ...base, payload: two, state: { 'stays[s1].rows[r1].count': 1 } })).toBe(true);
    expect(reconcilePaneCreateScope({ ...base, payload: two, state: { 'stays[s1].rows[r1].count': null } })).toBe(false);
    expect(reconcilePaneCreateScope({ ...base, payload: { ...payload, stays: [{ ...extractedStay, totalRooms: null, rows: [{ ...row, rooms: null }] }] } })).toBe(false);
  });
  it('requires saved rowless extraction provenance when a reread introduces another row', () => {
    const ownRow = 'stays[s1].rows[s1_row]';
    const state = { 'stays[s1].rows[r1].removed': true, [`${ownRow}.count`]: 1,
      [`${ownRow}.adults`]: 1, [`${ownRow}.childAges`]: [] };
    const historicalExtraction = { ...payload, stays: [{ ...extractedStay, rows: [] }] };
    const historicalOwnRows = [{ eventId: '11111111-1111-4111-8111-111111111111',
      extractionId: '22222222-2222-4222-8222-222222222222', fieldPath: `${ownRow}.count`, value: 1, extraction: historicalExtraction }];
    const input = { ...base, state, identity: { ...base.identity, rowId: 's1_row' } };
    expect(reconcilePaneCreateScope(input)).toBe(false);
    expect(reconcilePaneCreateScope({ ...input, historicalOwnRows })).toBe(true);
    expect(reconcilePaneCreateScope({ ...input, historicalOwnRows: [{ ...historicalOwnRows[0]!, value: 2 }] })).toBe(false);
    expect(reconcilePaneCreateScope({ ...input, historicalOwnRows: [{ ...historicalOwnRows[0]!, eventId: '' }] })).toBe(false);
    expect(reconcilePaneCreateScope({ ...input, historicalOwnRows: [{ ...historicalOwnRows[0]!, extractionId: '' }] })).toBe(false);
    expect(reconcilePaneCreateScope({ ...input, historicalOwnRows: [{ ...historicalOwnRows[0]!, fieldPath: 'stays[s1].rows[r1].count' }] })).toBe(false);
    expect(reconcilePaneCreateScope({ ...input, historicalOwnRows: [{ ...historicalOwnRows[0]!, extraction: payload }] })).toBe(false);
    expect(reconcilePaneCreateScope({ ...input, historicalOwnRows: [{ ...historicalOwnRows[0]!, extraction: { ...historicalExtraction, stays: [] } }] })).toBe(false);
    expect(reconcilePaneCreateScope({ ...input, historicalOwnRows: [{ ...historicalOwnRows[0]!, extraction: null }] })).toBe(false);
  });
  it('reconciles a saved own row from a matching durable event and extraction', () => {
    const fieldPath = 'stays[s1].rows[s1_row].count';
    const identity = { stayId: 's1', rowId: 's1_row', roomIndex: 1 };
    const extractionId = '22222222-2222-4222-8222-222222222222';
    const historicalExtraction = { ...payload, stays: [{ ...extractedStay, rows: [] }] };
    const row = { eventId: '11111111-1111-4111-8111-111111111111', workItemId: 'item', transportId: 'transport',
      sourceMessageId: 'message', eventWorkItemId: 'item', actorKind: 'user', eventType: 'field.edit', fieldPath, value: 1,
      aiSource: 'v1', evidence: { extractionId, paneSeq: 1, paneState: { [fieldPath]: 1 } },
      extractionId, extractionMessageId: 'message', extractorVersion: 'v1', extractionStatus: 'succeeded', extraction: historicalExtraction };
    const historicalOwnRows = paneOwnRowsFromEvents({ workItemId: 'item', transportId: 'transport', identity, rows: [row] });
    const state = { 'stays[s1].rows[r1].removed': true, [fieldPath]: 1,
      'stays[s1].rows[s1_row].adults': 1, 'stays[s1].rows[s1_row].childAges': [] };
    expect(reconcilePaneCreateScope({ ...base, identity, state, historicalOwnRows })).toBe(true);
    expect(reconcilePaneCreateScope({ ...base, identity, state, historicalOwnRows: paneOwnRowsFromEvents({
      workItemId: 'item', transportId: 'transport', identity, rows: [{ ...row, extractionMessageId: 'other' }],
    }) })).toBe(false);
  });
  it('refuses ambiguous child occupancy, duplicate identities and unsupported fields', () => {
    const ambiguous = { ...payload, missing: [{ field: 'children', question: 'What are the child ages?' }],
      stays: [{ ...extractedStay, totalChildren: null }] };
    expect(reconcilePaneCreateScope({ ...base, payload: ambiguous })).toBe(false);
    expect(reconcilePaneCreateScope({ ...base, payload: ambiguous, state: { 'stays[s1].rows[r1].childAges': [] } })).toBe(true);
    expect(reconcilePaneCreateScope({ ...base, payload: { ...payload, stays: [{ ...extractedStay, rows: [row, row] }] } })).toBe(false);
    expect(reconcilePaneCreateScope({ ...base, state: { 'stays[s1].rows[r1].unknownField': 'x' } })).toBe(false);
  });
});
