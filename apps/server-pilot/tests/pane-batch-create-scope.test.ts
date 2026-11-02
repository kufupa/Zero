import { describe, expect, it } from 'vitest';
import { isActivePaneBatchChild, reconcilePaneBatchCreateScope } from '../src/ai/pane-batch-create-scope.js';
import type { BatchManifest } from '../src/ai/hms-batch-manifest.js';

function fixture() {
  const row = { id: 'r1', roomType: 'Standard Queen', rooms: 1, adultsPerRoom: 1, childAges: [] as number[], board: null };
  const sourceStay = { id: 's1', hotel: null, requested: { arrival: '2027-03-01', departure: '2027-03-03' },
    booked: null, totalRooms: 2, totalAdults: 2, totalChildren: 0,
    rows: [row, { ...row, id: 'r2', roomType: 'Standard Twin' }] };
  const payload = { contact: { name: null, email: null, phone: null }, agency: null, endClient: null,
    confirmationNumbers: [], stays: [sourceStay], missing: [] as Array<{ field: string; question: string; stayId?: string }> };
  const room: BatchManifest['rooms'][number] = { allocationId: 'a', identity: { stayId: 's1', rowId: 'r1', roomIndex: 1 },
    guest: { firstName: 'Proof', lastName: 'Labtest', profileId: '123' },
    stay: { arrival: '2027-03-01', departure: '2027-03-03', adults: 1, childAges: [] }, roomType: 'STQN', ratePlan: 'BAR',
    amount: { status: 'unknown' }, agency: null, organization: null, guaranteeType: 'NGI', sourceOfBusiness: null,
    note: null, track: null, marketSegment: null, guestOptIn: false, booker: null,
    cmsSend: false, cmsMessageId: null, cmsRecipient: null };
  const manifest: BatchManifest = { version: 'hms-batch/1', propertyCode: 'HRCEN',
    source: { transportId: 'transport', threadId: 'thread', messageId: 'message', workItemId: '11111111-1111-4111-8111-111111111111' },
    rooms: [room, { ...structuredClone(room), allocationId: 'b', identity: { stayId: 's1', rowId: 'r2', roomIndex: 1 }, roomType: 'STWN' }] };
  return { manifest, payload, state: {} as Record<string, unknown>, party: { kind: 'none' as const } };
}

const ready = { status: 'ready' };
const held = (reason: string) => ({ status: 'held', reason });

describe('batch create scope reconciliation', () => {
  it('proves each active child identity and count from the locked source projection', () => {
    const f = fixture();
    const check = (identity: unknown) => isActivePaneBatchChild({ payload: f.payload, state: f.state, identity });
    expect(check(f.manifest.rooms[0]!.identity)).toBe(true);
    expect(check({ ...f.manifest.rooms[0]!.identity, roomIndex: 2 })).toBe(false);
    f.state['stays[s1].rows[r1].count'] = 2;
    expect(check({ ...f.manifest.rooms[0]!.identity, roomIndex: 2 })).toBe(true);
    expect(check({ ...f.manifest.rooms[0]!.identity, rowId: 'other' })).toBe(false);
    expect(check({ ...f.manifest.rooms[0]!.identity, roomIndex: 0 })).toBe(false);
    f.state['stays[s1].rows[r1].removed'] = true;
    expect(check(f.manifest.rooms[0]!.identity)).toBe(false);
    expect(check(f.manifest.rooms[1]!.identity)).toBe(true);
  });
  it('accepts distinct requested rows in their approved order and when reordered', () => {
    const f = fixture();
    expect(reconcilePaneBatchCreateScope(f)).toEqual(ready);
    f.manifest.rooms.reverse();
    expect(reconcilePaneBatchCreateScope(f)).toEqual(ready);
  });
  it('accepts a selected subset without treating the omitted room as an approved child', () => {
    const f = fixture();
    f.payload.stays[0]!.rows.push({ ...f.payload.stays[0]!.rows[0]!, id: 'r3' });
    f.payload.stays[0]!.totalRooms = 3;
    f.payload.stays[0]!.totalAdults = 3;
    expect(reconcilePaneBatchCreateScope(f)).toEqual(ready);
    f.manifest.rooms[1]!.identity.rowId = 'r4';
    expect(reconcilePaneBatchCreateScope(f)).toEqual(held('source_room_changed'));
  });
  it('respects a staff-removed source row while still validating corrected occupancy totals', () => {
    const f = fixture();
    f.payload.stays[0]!.rows.push({ ...f.payload.stays[0]!.rows[0]!, id: 'r3' });
    f.payload.stays[0]!.totalRooms = 3; f.payload.stays[0]!.totalAdults = 3;
    f.state['stays[s1].rows[r3].removed'] = true; f.state['stays[s1].totalAdults'] = 2;
    expect(reconcilePaneBatchCreateScope(f)).toEqual(ready);
    delete f.state['stays[s1].totalAdults'];
    expect(reconcilePaneBatchCreateScope(f)).toEqual(held('occupancy_unverified'));
  });
  it('accepts distinct room indices in a multi-room source row, but not an index beyond the count', () => {
    const f = fixture();
    f.payload.stays[0]!.rows = [{ ...f.payload.stays[0]!.rows[0]!, rooms: 2 }];
    f.manifest.rooms[1]!.identity = { stayId: 's1', rowId: 'r1', roomIndex: 2 };
    f.manifest.rooms[1]!.roomType = 'STQN';
    expect(reconcilePaneBatchCreateScope(f)).toEqual(ready);
    f.manifest.rooms[1]!.identity.roomIndex = 3;
    expect(reconcilePaneBatchCreateScope(f)).toEqual(held('source_room_changed'));
  });
  it('requires an explicit remaining count when another source row was removed', () => {
    const f = fixture(), stay = f.payload.stays[0]!;
    stay.totalRooms = 3; stay.totalAdults = null as never; stay.totalChildren = null as never;
    stay.rows[0]!.rooms = null as never;
    f.state['stays[s1].rows[r2].removed'] = true;
    const first = f.manifest.rooms[0]!;
    f.manifest.rooms = [first, { ...structuredClone(first), allocationId: 'b', identity: { ...first.identity, roomIndex: 2 } },
      { ...structuredClone(first), allocationId: 'c', identity: { ...first.identity, roomIndex: 3 } }];
    expect(isActivePaneBatchChild({ ...f, identity: first.identity })).toBe(false);
    expect(reconcilePaneBatchCreateScope(f)).toEqual(held('source_room_changed'));
    f.state['stays[s1].rows[r1].count'] = 2;
    expect(isActivePaneBatchChild({ ...f, identity: f.manifest.rooms[1]!.identity })).toBe(true);
    expect(isActivePaneBatchChild({ ...f, identity: f.manifest.rooms[2]!.identity })).toBe(false);
    f.manifest.rooms.pop();
    expect(reconcilePaneBatchCreateScope(f)).toEqual(ready);
  });
  it('retains total-room defaults for a genuinely sole source row', () => {
    const f = fixture(), stay = f.payload.stays[0]!;
    stay.rows = [{ ...stay.rows[0]!, rooms: null as never }];
    f.manifest.rooms[1]!.identity = { stayId: 's1', rowId: 'r1', roomIndex: 2 };
    f.manifest.rooms[1]!.roomType = 'STQN';
    expect(isActivePaneBatchChild({ ...f, identity: f.manifest.rooms[1]!.identity })).toBe(true);
    expect(reconcilePaneBatchCreateScope(f)).toEqual(ready);
  });
  it('accepts separate stays with the same arrival and binds each row to its stay', () => {
    const f = fixture(), first = f.payload.stays[0]!;
    first.rows = [first.rows[0]!]; first.totalRooms = 1; first.totalAdults = 1;
    f.payload.stays.push({ ...structuredClone(first), id: 's2', rows: [{ ...first.rows[0]!, id: 'r2', roomType: 'Standard Twin' }] });
    f.manifest.rooms[1]!.identity.stayId = 's2';
    expect(reconcilePaneBatchCreateScope(f)).toEqual(ready);
    f.manifest.rooms[1]!.identity.stayId = 's1';
    expect(reconcilePaneBatchCreateScope(f)).toEqual(held('source_room_changed'));
  });
  it('uses trusted historical proof for a formerly rowless source, including both indices', () => {
    const f = fixture(), field = 'stays[s1].rows[s1_row].count';
    const historicalExtraction = structuredClone(f.payload);
    historicalExtraction.stays[0]!.rows = [];
    f.state = { 'stays[s1].rows[r1].removed': true, 'stays[s1].rows[r2].removed': true,
      [field]: 2, 'stays[s1].rows[s1_row].adults': 1, 'stays[s1].rows[s1_row].childAges': [],
      'stays[s1].rows[s1_row].roomType': 'STQN' };
    f.manifest.rooms[0]!.identity = { stayId: 's1', rowId: 's1_row', roomIndex: 1 };
    f.manifest.rooms[1]!.identity = { stayId: 's1', rowId: 's1_row', roomIndex: 2 };
    f.manifest.rooms[1]!.roomType = 'STQN';
    expect(reconcilePaneBatchCreateScope(f)).toEqual(held('source_unverified'));
    expect(isActivePaneBatchChild({ ...f, identity: f.manifest.rooms[1]!.identity })).toBe(false);
    const historicalOwnRows = [{ eventId: '11111111-1111-4111-8111-111111111111',
      extractionId: '22222222-2222-4222-8222-222222222222', fieldPath: field, value: 2, extraction: historicalExtraction }];
    expect(isActivePaneBatchChild({ ...f, historicalOwnRows, identity: f.manifest.rooms[1]!.identity })).toBe(true);
    expect(reconcilePaneBatchCreateScope({ ...f, historicalOwnRows })).toEqual(ready);
  });
  it('rejects duplicate identities, multiple arrivals, and unsupported party context', () => {
    const f = fixture();
    f.manifest.rooms[1]!.identity = { ...f.manifest.rooms[0]!.identity };
    expect(reconcilePaneBatchCreateScope(f)).toEqual(held('invalid_manifest'));
    const next = fixture(); next.manifest.rooms[1]!.stay.arrival = '2027-03-02';
    expect(reconcilePaneBatchCreateScope(next)).toEqual(held('invalid_manifest'));
    expect(reconcilePaneBatchCreateScope({ ...fixture(), party: { kind: 'unknown' } })).toEqual(held('party_unverified'));
    const party = fixture(); party.manifest.rooms[0]!.agency = { nativeId: '1', name: 'Agency' };
    expect(reconcilePaneBatchCreateScope(party)).toEqual(held('party_unverified'));
  });
  it('holds missing room type unless a matching row edit is durable', () => {
    const f = fixture(); f.payload.stays[0]!.rows[0]!.roomType = null as unknown as string;
    expect(reconcilePaneBatchCreateScope(f)).toEqual(held('source_room_changed'));
    f.state['stays[s1].rows[r1].roomType'] = 'STQN';
    expect(reconcilePaneBatchCreateScope(f)).toEqual(ready);
    f.state['stays[s1].rows[r1].roomType'] = 'STWN';
    expect(reconcilePaneBatchCreateScope(f)).toEqual(held('source_room_changed'));
  });
  it('rejects edited room type, dates, occupancy and removed selected rows', () => {
    const f = fixture(); f.state['stays[s1].rows[r1].roomType'] = 'STWN';
    expect(reconcilePaneBatchCreateScope(f)).toEqual(held('source_room_changed'));
    const dates = fixture(); dates.state['stays[s1].requested.departure'] = '2027-03-04';
    expect(reconcilePaneBatchCreateScope(dates)).toEqual(held('occupancy_unverified'));
    const occupancy = fixture(); occupancy.state['stays[s1].rows[r1].adults'] = 2;
    expect(reconcilePaneBatchCreateScope(occupancy)).toEqual(held('occupancy_unverified'));
    const removed = fixture(); removed.state['stays[s1].rows[r1].removed'] = true;
    expect(reconcilePaneBatchCreateScope(removed)).toEqual(held('source_room_changed'));
  });
  it('checks stay-wide totals across all active rows rather than only selected rooms', () => {
    const f = fixture(); f.payload.stays[0]!.totalAdults = 3;
    expect(reconcilePaneBatchCreateScope(f)).toEqual(held('occupancy_unverified'));
    const rooms = fixture(); rooms.payload.stays[0]!.totalRooms = 3;
    expect(reconcilePaneBatchCreateScope(rooms)).toEqual(held('occupancy_unverified'));
    const children = fixture(); children.payload.stays[0]!.totalChildren = 1;
    expect(reconcilePaneBatchCreateScope(children)).toEqual(held('occupancy_unverified'));
    const unclear = fixture(); unclear.payload.stays[0]!.rows[1]!.childAges = null as never;
    expect(reconcilePaneBatchCreateScope(unclear)).toEqual(held('occupancy_unverified'));
  });
  it('holds unresolved unselected counts even when occupancy totals are absent', () => {
    const f = fixture(), stay = f.payload.stays[0]!;
    stay.rows.push({ ...stay.rows[0]!, id: 'r3' });
    stay.totalRooms = 3; stay.totalAdults = null as never; stay.totalChildren = null as never;
    f.state['stays[s1].rows[r3].count'] = null;
    expect(reconcilePaneBatchCreateScope(f)).toEqual(held('occupancy_unverified'));
    f.state['stays[s1].rows[r3].count'] = 1;
    expect(reconcilePaneBatchCreateScope(f)).toEqual(ready);
  });
  it('does not treat no-op room edits as authority to ignore extracted room totals', () => {
    for (const edit of [
      { 'stays[s1].rows[r1].removed': null },
      { 'stays[s1].rows[r1].count': 1 },
    ]) {
      const f = fixture(); f.payload.stays[0]!.totalRooms = 3;
      f.payload.stays[0]!.totalAdults = null as never; f.payload.stays[0]!.totalChildren = null as never;
      f.state = edit;
      expect(reconcilePaneBatchCreateScope(f)).toEqual(held('occupancy_unverified'));
    }
  });
  it('still checks extracted room totals when an unknown source row count is resolved', () => {
    const f = fixture(), stay = f.payload.stays[0]!;
    stay.rows.push({ ...stay.rows[0]!, id: 'r3', rooms: null as never });
    stay.totalRooms = 4; stay.totalAdults = null as never; stay.totalChildren = null as never;
    f.state['stays[s1].rows[r3].count'] = 1;
    expect(reconcilePaneBatchCreateScope(f)).toEqual(held('occupancy_unverified'));
    stay.totalRooms = 3;
    expect(reconcilePaneBatchCreateScope(f)).toEqual(ready);
  });
  it('allows an explicit changed count while retaining complete active row counts', () => {
    const f = fixture(), stay = f.payload.stays[0]!;
    stay.totalAdults = null as never; stay.totalChildren = null as never;
    f.payload.stays[0]!.rows.push({ ...f.payload.stays[0]!.rows[1]!, id: 'r3' });
    f.state['stays[s1].rows[r1].count'] = 2;
    expect(reconcilePaneBatchCreateScope(f)).toEqual(ready);
    // An unselected row still contributes to the stay-wide composition.
    f.state['stays[s1].rows[r3].count'] = null;
    expect(reconcilePaneBatchCreateScope(f)).toEqual(held('occupancy_unverified'));
  });
  it('holds an unresolved selected room count as a source change', () => {
    const f = fixture();
    f.state['stays[s1].rows[r2].count'] = null;
    expect(reconcilePaneBatchCreateScope(f)).toEqual(held('source_room_changed'));
  });
  it('holds cross-stay removal-ID collisions that hide an approved row in the pane', () => {
    const f = fixture();
    f.payload.stays.push({ ...structuredClone(f.payload.stays[0]!), id: 's2', rows: [{ ...f.payload.stays[0]!.rows[0]!, id: 'r1' }] });
    f.state['stays[s2].rows[r1].removed'] = true;
    expect(reconcilePaneBatchCreateScope(f)).toEqual(held('source_unverified'));
  });
  it('requires corrections on each selected row for scoped occupancy warnings', () => {
    const adult = fixture(); adult.payload.missing.push({ field: 'adultsPerRoom', question: 'Confirm occupancy.', stayId: 's1' });
    expect(reconcilePaneBatchCreateScope(adult)).toEqual(held('occupancy_unverified'));
    adult.state['stays[s1].rows[r1].adults'] = 1;
    expect(reconcilePaneBatchCreateScope(adult)).toEqual(held('occupancy_unverified'));
    adult.state['stays[s1].rows[r2].adults'] = 1;
    expect(reconcilePaneBatchCreateScope(adult)).toEqual(ready);
    const children = fixture(); children.payload.missing.push({ field: 'childAges', question: 'Confirm children.', stayId: 's1' });
    expect(reconcilePaneBatchCreateScope(children)).toEqual(held('occupancy_unverified'));
    children.state['stays[s1].rows[r1].childAges'] = [];
    children.state['stays[s1].rows[r2].childAges'] = [];
    expect(reconcilePaneBatchCreateScope(children)).toEqual(ready);
  });
  it('holds unscoped warnings on selected rooms until each row is corrected', () => {
    const adult = fixture(); adult.payload.missing.push({ field: 'adultsPerRoom', question: 'Confirm occupancy.' });
    expect(reconcilePaneBatchCreateScope(adult)).toEqual(held('occupancy_unverified'));
    adult.state['stays[s1].rows[r1].adults'] = 1; adult.state['stays[s1].rows[r2].adults'] = 1;
    expect(reconcilePaneBatchCreateScope(adult)).toEqual(ready);
    const children = fixture(); children.payload.missing.push({ field: 'childAges', question: 'Confirm children.' });
    expect(reconcilePaneBatchCreateScope(children)).toEqual(held('occupancy_unverified'));
    children.state['stays[s1].rows[r1].childAges'] = []; children.state['stays[s1].rows[r2].childAges'] = [];
    expect(reconcilePaneBatchCreateScope(children)).toEqual(ready);
    const unrelated = fixture(); unrelated.payload.missing.push({ field: 'adultsPerRoom', question: 'Confirm occupancy.', stayId: 'other' });
    expect(reconcilePaneBatchCreateScope(unrelated)).toEqual(ready);
  });
  it('does not apply another stay child warning to an otherwise resolved selected stay', () => {
    const f = fixture();
    f.payload.stays[0]!.totalChildren = null as never;
    f.payload.missing.push({ field: 'childAges', question: 'What are their ages?', stayId: 'other' });
    expect(reconcilePaneBatchCreateScope(f)).toEqual(ready);
    f.payload.missing[0]!.stayId = 's1';
    expect(reconcilePaneBatchCreateScope(f)).toEqual(held('occupancy_unverified'));
  });
  it('holds malformed or orphan persisted edits and unresolved child ages', () => {
    const orphan = fixture(); orphan.state['stays[s1].rows[other].count'] = 1;
    expect(reconcilePaneBatchCreateScope(orphan)).toEqual(held('source_unverified'));
    const warning = fixture(); warning.payload.stays[0]!.totalChildren = null as never;
    warning.payload.missing.push({ field: 'children', question: 'What are their ages?' });
    expect(reconcilePaneBatchCreateScope(warning)).toEqual(held('occupancy_unverified'));
  });
});
