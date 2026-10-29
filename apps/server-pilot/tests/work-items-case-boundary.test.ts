import { describe, expect, it } from 'vitest';
import { buildBookingDrafts } from '../src/ai/booking-draft.js';
import type { MailExtractionPayload } from '../src/ai/extraction/schema.js';
import { correctionsCarryTo, storedAnalysis } from '../src/ai/work-items.js';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';

function mixedMail(): MailExtractionPayload {
  return {
    contact: { name: null, email: null, phone: null },
    agency: 'Example Travel',
    endClient: null,
    confirmationNumbers: ['57291630-1'],
    stays: [
      {
        id: 's_existing', hotel: 'Centurion', action: 'amend',
        requested: { arrival: '2027-11-10', departure: '2027-11-12' },
        booked: { arrival: '2027-11-10', departure: '2027-11-11' },
        totalRooms: 1,
        guests: [{ name: 'Ada Example', confirmationNumber: '57291630-1' }],
        rows: [{ id: 'r_existing', roomType: 'Standard King', rooms: 1, adultsPerRoom: 2, childAges: [], board: 'bb' }],
      },
      {
        id: 's_new', hotel: 'Centurion', action: 'new_booking',
        requested: { arrival: '2027-11-20', departure: '2027-11-22' },
        booked: null, totalRooms: 1,
        guests: [{ name: 'Bea Example', confirmationNumber: null }],
        rows: [{ id: 'r_new', roomType: 'Standard King', rooms: 1, adultsPerRoom: 1, childAges: [], board: 'bb' }],
      },
    ],
    missing: [],
  };
}

describe('stored case boundaries', () => {
  it('marks a saved staff-created stay so rate searches survive reopening', () => {
    const payload = mixedMail();
    payload.stays = [payload.stays[1]!];
    payload.confirmationNumbers = [];
    const state = {
      'stays[s_staff].requested.arrival': '2027-12-01',
      'stays[s_staff].requested.departure': '2027-12-03',
      'stays[s_staff].rows[r_staff].count': 1,
      'stays[s_staff].rows[r_staff].adults': 1,
    };
    const { analysis } = storedAnalysis({ kind: 'booking', payload, attachments: [] }, state);
    expect(analysis.groups.find((group) => group.stayId === 's_staff')).toMatchObject({ staffCreated: true });
    expect(analysis.groups.find((group) => group.stayId === 's_new')?.staffCreated).toBeUndefined();
    expect(analysis.luna.tasks).toEqual([{ kind: 'create_booking', groupIndexes: [0], note: '' }]);
  });

  it('keeps same-date existing cases separately selectable on cancellation mail', () => {
    const payload = mixedMail();
    payload.stays[0]!.action = 'cancel';
    payload.stays[1]!.action = 'cancel';
    payload.stays[1]!.requested = { ...payload.stays[0]!.requested };
    payload.stays[1]!.booked = { ...payload.stays[0]!.booked! };
    payload.stays[1]!.guests = [{ name: 'Bea Example', confirmationNumber: '22222222-1' }];
    payload.stays[1]!.rows[0]!.board = null;
    payload.confirmationNumbers = ['57291630-1', '22222222-1'];

    const analysis = storedAnalysis({ kind: 'cancellation', payload, attachments: [] }, {}).analysis;
    expect(analysis.intent).toBe('other');
    expect(analysis.luna.confirmationNumber).toBeNull();
    expect(analysis.groups.map((group) => [group.stayId, group.caseScoped, group.confirmationNumber])).toEqual([
      ['s_existing', true, '57291630-1'], ['s_new', true, '22222222-1'],
    ]);
    expect(analysis.groups[1]).toMatchObject({ board: 'unknown', fields: { board: 'missing' } });
    expect(analysis.luna.tasks.map((task) => task.groupIndexes)).toEqual([[0], [1]]);
  });

  it('keeps existing and new asks on their own stay, without assigning the existing number globally', () => {
    const payload = mixedMail();
    const { analysis, refs } = storedAnalysis({ kind: 'booking', payload, attachments: [] }, {}, undefined, 'HRCEN');

    expect(analysis.luna.tasks).toEqual([
      { kind: 'amend', groupIndexes: [0], note: '' },
      { kind: 'create_booking', groupIndexes: [1], note: '' },
    ]);
    expect(analysis.groups.map((group) => [group.stayId, group.confirmationNumber, group.roomTypeCode])).toEqual([
      ['s_existing', '57291630-1', 'SKNG'],
      ['s_new', undefined, 'SKNG'],
    ]);
    expect(refs).toEqual({
      r_existing: { stayId: 's_existing', rowId: 'r_existing' },
      r_new: { stayId: 's_new', rowId: 'r_new' },
    });
    expect(analysis.luna.confirmationNumber).toBeNull();
    expect(analysis.luna.arrival).toBeNull();
    expect(analysis.luna.missing.some((item) => item.field === 'confirmationNumber')).toBe(true);

    // The existing property profile still decides the room code, independently for each case.
    const otherPayload = { ...payload, stays: payload.stays.map((stay) => ({ ...stay, hotel: 'Da Vinci' })) };
    const other = storedAnalysis({ kind: 'booking', payload: otherPayload, attachments: [] }, {}, undefined, 'HRDAV').analysis;
    expect(other.groups.map((group) => group.roomTypeCode)).toEqual(['STKNG', 'STKNG']);
  });

  it('retains the booking fallback for legacy stays without per-stay actions', () => {
    const payload = mixedMail();
    delete payload.stays[0]!.action;
    delete payload.stays[1]!.action;
    const legacy = storedAnalysis({ kind: 'booking', payload, attachments: [] }, {}).analysis;
    expect(legacy.luna.tasks.map((task) => task.kind)).toEqual(['other', 'create_booking']);

    payload.stays[0]!.action = 'amend';
    const partiallyClassified = storedAnalysis({ kind: 'booking', payload, attachments: [] }, {}).analysis;
    expect(partiallyClassified.luna.tasks.map((task) => task.kind)).toEqual(['amend']);
  });

  it('does not guess which same-date stay owns a top-level or thread-only booking number', () => {
    const payload = mixedMail();
    payload.stays[0]!.guests = [];
    payload.stays[1]!.requested = { ...payload.stays[0]!.requested };
    const analysis = storedAnalysis(
      { kind: 'booking', payload, attachments: [] }, {},
      { confirmation: '57291630-1', reason: null },
    ).analysis;

    expect(analysis.groups.map((group) => group.confirmationNumber)).toEqual([undefined, undefined]);
    expect(analysis.luna.confirmationNumber).toBeNull();
    expect(analysis.luna.tasks.map((task) => task.groupIndexes)).toEqual([[0], [1]]);
  });

  it('does not label a stay new when an existing number cannot be attributed to a stay', () => {
    const payload = mixedMail();
    payload.stays[0]!.guests = [{ name: 'Ada Example', confirmationNumber: null }];
    const analysis = storedAnalysis({ kind: 'booking', payload, attachments: [] }, {}).analysis;
    expect(analysis.luna.tasks.map((task) => task.kind)).toEqual(['amend', 'other']);
    expect(analysis.luna.confirmationNumber).toBeNull();
  });

  it('does not label a new request while a thread-only booking number has no case owner', () => {
    const payload = mixedMail();
    const unassigned = storedAnalysis(
      { kind: 'booking', payload, attachments: [] }, {},
      { confirmation: '33333333-1', reason: null },
    ).analysis;
    expect(unassigned.luna.tasks.map((task) => task.kind)).toEqual(['amend', 'other']);
    const attributed = storedAnalysis(
      { kind: 'booking', payload, attachments: [] }, {},
      { confirmation: '57291630-1', reason: null },
    ).analysis;
    expect(attributed.luna.tasks.map((task) => task.kind)).toEqual(['amend', 'create_booking']);
  });

  it('keeps guest names and numbers on the stay without assigning them to rows by order', () => {
    const payload = mixedMail();
    const first = payload.stays[0]!;
    payload.stays = [{
      ...first,
      guests: [
        { name: 'Ada Example', confirmationNumber: '11111111-1' },
        { name: 'Bea Example', confirmationNumber: '22222222-1' },
      ],
      rows: [first.rows[0]!, { ...first.rows[0]!, id: 'r_second' }],
    }];
    payload.confirmationNumbers = ['11111111-1', '22222222-1'];
    const separate = storedAnalysis({ kind: 'booking', payload, attachments: [] }, {}).analysis;
    expect(separate.groups.map((group) => group.confirmationNumber)).toEqual([undefined, undefined]);
    expect(separate.luna.groups.map((group) => group.guestNames)).toEqual([[], []]);
    expect(separate.groups[0]?.stayGuests).toEqual(payload.stays[0]!.guests);
    expect(separate.luna.confirmationNumber).toBeNull();

    payload.stays[0]!.guests = [...payload.stays[0]!.guests!].reverse();
    payload.stays[0]!.rows = [...payload.stays[0]!.rows].reverse();
    const reordered = storedAnalysis({ kind: 'booking', payload, attachments: [] }, {}).analysis;
    expect(reordered.groups.map((group) => group.confirmationNumber)).toEqual([undefined, undefined]);
    expect(reordered.luna.groups.map((group) => group.guestNames)).toEqual([[], []]);
    expect(reordered.groups[0]?.stayGuests).toEqual(payload.stays[0]!.guests);

    payload.stays[0]!.rows = [{ ...first.rows[0]!, rooms: 2 }];
    const combined = storedAnalysis({ kind: 'booking', payload, attachments: [] }, {}).analysis;
    expect(combined.groups[0]?.confirmationNumber).toBeUndefined();
    expect(combined.groups[0]?.stayGuests).toEqual(payload.stays[0]!.guests);
    expect(combined.luna.confirmationNumber).toBeNull();
  });

  it('leaves draft guest names missing when the extraction did not link guests to rooms', async () => {
    const payload = mixedMail();
    const first = payload.stays[0]!;
    payload.stays = [{
      ...first,
      guests: [
        { name: 'Ada Example', confirmationNumber: null },
        { name: 'Bea Example', confirmationNumber: null },
      ],
      rows: [first.rows[0]!, { ...first.rows[0]!, id: 'r_second' }],
    }];
    payload.confirmationNumbers = [];
    const analysis = storedAnalysis({ kind: 'booking', payload, attachments: [] }, {}).analysis;
    const revision = structuredClone(await syntheticRevision(['1850.00']));
    revision.groups[0]!.quantity = 1;
    Object.assign(revision.groups[0]!, { stayId: first.id });
    const second = structuredClone(revision.groups[0]!);
    second.id = 'g2';
    revision.groups.push(second);
    const draft = await buildBookingDrafts({
      analysis: analysis.luna,
      revision,
      defaults: { track: 'BAR', sourceOfBusiness: 'Travel Agent', guaranteeType: 'Guaranteed By Agent' },
      messageId: 'synthetic',
      validate: async () => ({ ok: true, errors: [] }),
    });
    expect(draft.rooms).toHaveLength(2);
    expect(draft.rooms.every(({ request }) => !request.firstName && !request.lastName)).toBe(true);
    expect(draft.missing.some((item) => item.field === 'guestName')).toBe(true);
  });

  it('offers one guest to People only for the original single room', () => {
    const payload = mixedMail();
    payload.stays = [payload.stays[1]!];
    payload.confirmationNumbers = [];
    const single = storedAnalysis({ kind: 'booking', payload, attachments: [] }, {}).analysis;
    expect(single.groups[0]?.guestNames).toEqual(['Bea Example']);
    expect(single.luna.groups[0]?.guestNames).toEqual([]);

    payload.confirmationNumbers = ['11111111-1', '22222222-1'];
    const ambiguous = storedAnalysis({ kind: 'booking', payload, attachments: [] }, {}).analysis;
    expect(ambiguous.groups[0]?.guestNames).toBeUndefined();
    payload.confirmationNumbers = [];

    payload.stays[0]!.totalRooms = 2;
    payload.stays[0]!.rows[0]!.rooms = 2;
    const narrowed = storedAnalysis(
      { kind: 'booking', payload, attachments: [] },
      { 'stays[s_new].rows[r_new].count': 1 },
    ).analysis;
    expect(narrowed.groups[0]?.guestNames).toBeUndefined();
  });

  it('uses one named guest as quote-default evidence without assigning the guest to a room', () => {
    const payload = mixedMail();
    payload.stays = [payload.stays[1]!];
    payload.confirmationNumbers = [];
    payload.stays[0]!.totalRooms = null;
    payload.stays[0]!.rows[0]!.rooms = null;
    payload.stays[0]!.rows[0]!.adultsPerRoom = null;
    const analysis = storedAnalysis({ kind: 'quote', payload, attachments: [] }, {}).analysis;
    expect(analysis.groups[0]?.quantity).toBe(1);
    expect(analysis.groups[0]?.fields.quantity).toBe('defaulted');
    expect(analysis.groups[0]?.guestNames).toBeUndefined();
    expect(analysis.luna.groups[0]?.guestNames).toEqual([]);
  });

  it('requires review when a single number accompanies several rooms', () => {
    const payload = mixedMail();
    payload.stays = [{ ...payload.stays[0]!, totalRooms: 2, rows: [{ ...payload.stays[0]!.rows[0]!, rooms: 2 }] }];
    const analysis = storedAnalysis({ kind: 'amendment', payload, attachments: [] }, {}).analysis;
    expect(analysis.luna.confirmationNumber).toBeNull();
    expect(analysis.luna.missing.some((item) => item.field === 'confirmationNumber')).toBe(true);
  });

  it('does not attach a number to a date-only stay when the original room count is multiple or unknown', () => {
    const payload = mixedMail();
    payload.stays = [{ ...payload.stays[0]!, totalRooms: 2, rows: [] }];
    const multiple = storedAnalysis({ kind: 'booking', payload, attachments: [] }, {}).analysis;
    expect(multiple.groups[0]?.confirmationNumber).toBeUndefined();
    expect(multiple.luna.confirmationNumber).toBeNull();

    payload.stays[0]!.totalRooms = null;
    const unknown = storedAnalysis({ kind: 'booking', payload, attachments: [] }, {}).analysis;
    expect(unknown.groups[0]?.confirmationNumber).toBeUndefined();
    payload.stays[0]!.totalRooms = 1;
    const single = storedAnalysis({ kind: 'booking', payload, attachments: [] }, {}).analysis;
    expect(single.groups[0]?.confirmationNumber).toBe('57291630-1');
  });

  it('keeps the one selected-email number as a case lookup hint when no room count was stated', () => {
    const payload = mixedMail();
    payload.stays = [{ ...payload.stays[0]!, totalRooms: null, rows: [] }];
    const selected = storedAnalysis({ kind: 'amendment', payload, attachments: [] }, {}).analysis;
    expect(selected.groups[0]?.caseLookupConfirmation).toBe('57291630-1');
    expect(selected.groups[0]?.confirmationNumber).toBeUndefined();

    payload.confirmationNumbers = [];
    payload.stays[0]!.guests![0]!.confirmationNumber = null;
    const threadOnly = storedAnalysis(
      { kind: 'amendment', payload, attachments: [] }, {},
      { confirmation: '57291630-1', reason: null },
    ).analysis;
    expect(threadOnly.groups[0]?.caseLookupConfirmation).toBe('57291630-1');
    expect(threadOnly.groups[0]?.confirmationNumber).toBeUndefined();

    const conflicting = storedAnalysis(
      { kind: 'amendment', payload, attachments: [] }, {},
      { confirmation: null, reason: 'Choose the right booking' },
    ).analysis;
    expect(conflicting.groups[0]?.caseLookupConfirmation).toBeUndefined();

    payload.confirmationNumbers = ['57291630-1'];
    payload.stays[0]!.guests!.push({ name: 'Bea Example', confirmationNumber: null });
    const ambiguous = storedAnalysis({ kind: 'amendment', payload, attachments: [] }, {}).analysis;
    expect(ambiguous.groups[0]?.caseLookupConfirmation).toBeUndefined();
  });

  it('does not assign a booking number when the original room count was unknown', () => {
    const payload = mixedMail();
    payload.stays = [payload.stays[0]!];
    payload.stays[0]!.totalRooms = null;
    payload.stays[0]!.rows[0]!.rooms = null;
    const analysis = storedAnalysis({ kind: 'booking', payload, attachments: [] }, {
      'stays[s_existing].rows[r_existing].count': 1,
    }).analysis;
    expect(analysis.luna.confirmationNumber).toBe('57291630-1'); // usable as a case-level lookup hint
    expect(analysis.groups[0]?.confirmationNumber).toBeUndefined();
  });

  it('keeps a thread-only number as a lookup hint, not a room assignment', () => {
    const payload = mixedMail();
    payload.stays = [payload.stays[0]!];
    payload.stays[0]!.guests![0]!.confirmationNumber = null;
    payload.confirmationNumbers = [];
    const analysis = storedAnalysis(
      { kind: 'booking', payload, attachments: [] }, {},
      { confirmation: '57291630-1', reason: null },
    ).analysis;
    expect(analysis.luna.confirmationNumber).toBe('57291630-1');
    expect(analysis.groups[0]?.confirmationNumber).toBeUndefined();
  });

  it('retains a single selected-email number on the one original room', () => {
    const payload = mixedMail();
    payload.stays = [payload.stays[0]!];
    payload.stays[0]!.guests![0]!.confirmationNumber = null;
    const analysis = storedAnalysis({ kind: 'booking', payload, attachments: [] }, {}).analysis;
    expect(analysis.groups[0]?.confirmationNumber).toBe('57291630-1');
  });

  it('does not assign a guest number when staff have added another row to a single-row stay', () => {
    const payload = mixedMail();
    payload.stays = [payload.stays[0]!];
    const state = { 'stays[s_existing].rows[r_staff].count': 1 };
    const analysis = storedAnalysis({ kind: 'booking', payload, attachments: [] }, state).analysis;
    expect(analysis.groups.map((group) => group.confirmationNumber)).toEqual([undefined, undefined]);
  });

  it('does not attach a booking number to a staff replacement for the extracted row', () => {
    const payload = mixedMail();
    payload.stays = [payload.stays[0]!];
    const state = {
      'stays[s_existing].rows[r_existing].removed': true,
      'stays[s_existing].rows[r_staff].count': 1,
    };
    const analysis = storedAnalysis({ kind: 'booking', payload, attachments: [] }, state).analysis;
    expect(analysis.groups).toHaveLength(1);
    expect(analysis.groups[0]?.confirmationNumber).toBeUndefined();
    expect(analysis.groups[0]?.stayGuests).toEqual(payload.stays[0]!.guests);
  });

  it('does not bind one confirmation claimed by two different stays', () => {
    const payload = mixedMail();
    payload.stays[1]!.guests = [{ name: 'Bea Example', confirmationNumber: '57291630-1' }];
    const analysis = storedAnalysis({ kind: 'booking', payload, attachments: [] }, {}).analysis;
    expect(analysis.groups.map((group) => group.confirmationNumber)).toEqual([undefined, undefined]);
    expect(analysis.luna.confirmationNumber).toBeNull();
    expect(analysis.luna.tasks[1]?.kind).toBe('other');
  });

  it('does not treat a legacy existing stay as new when its per-stay action is absent', () => {
    const payload = mixedMail();
    delete payload.stays[0]!.action;
    const analysis = storedAnalysis({ kind: 'booking', payload, attachments: [] }, {}).analysis;
    expect(analysis.luna.tasks).toEqual([
      { kind: 'other', groupIndexes: [0], note: '' },
      { kind: 'create_booking', groupIndexes: [1], note: '' },
    ]);
  });

  it('retains a single legacy top-level number when it can only name one stay and row', () => {
    const payload = mixedMail();
    payload.stays = [{ ...payload.stays[0]!, guests: [] }];
    const analysis = storedAnalysis({ kind: 'booking', payload, attachments: [] }, {}).analysis;
    expect(analysis.groups[0]?.confirmationNumber).toBe('57291630-1');
    expect(analysis.luna.confirmationNumber).toBe('57291630-1');
  });

  it('keeps explicit clears instead of restoring date, room, adult or board defaults', () => {
    const payload = mixedMail();
    payload.stays = [payload.stays[1]!];
    payload.confirmationNumbers = [];
    const state = {
      'stays[s_new].requested.departure': null,
      'stays[s_new].rows[r_new].count': null,
      'stays[s_new].rows[r_new].adults': null,
      'stays[s_new].rows[r_new].board': null,
    };
    const analysis = storedAnalysis({ kind: 'quote', payload, attachments: [] }, state).analysis;
    expect(analysis.groups[0]).toMatchObject({
      board: 'unknown',
      fields: { departureDate: 'staff_corrected', quantity: 'staff_corrected', adults: 'staff_corrected', board: 'staff_corrected' },
    });
    expect(analysis.groups[0]?.departureDate).toBeUndefined();
    expect(analysis.groups[0]?.quantity).toBeUndefined();
    expect(analysis.groups[0]?.adults).toBeUndefined();
    expect(analysis.missingQuoteReplyFields).toEqual([
      'Departure date for stay 1', 'Number of rooms and occupancy per room for stay 1',
    ]);
  });

  it('leaves occupancy cleared even when both dates are present', () => {
    const payload = mixedMail();
    payload.stays = [payload.stays[1]!];
    payload.confirmationNumbers = [];
    const analysis = storedAnalysis({ kind: 'quote', payload, attachments: [] }, {
      'stays[s_new].rows[r_new].count': null,
      'stays[s_new].rows[r_new].adults': null,
    }).analysis;
    expect(analysis.groups[0]).toMatchObject({
      arrivalDate: '2027-11-20', departureDate: '2027-11-22',
      fields: { quantity: 'staff_corrected', adults: 'staff_corrected' },
    });
    expect(analysis.groups[0]?.quantity).toBeUndefined();
    expect(analysis.groups[0]?.adults).toBeUndefined();
    // This list is for the missing-date reply, not the quote request admission gate.
    expect(analysis.missingQuoteReplyFields).toEqual([]);
  });
});

describe('re-read identity for staff corrections', () => {
  it('keeps edits on the original read when the same dates name a different guest, booking or property', () => {
    const before = mixedMail();
    before.stays = [before.stays[0]!];
    before.stays[0]!.guests = [{ name: 'Ada Example', confirmationNumber: null }];
    before.confirmationNumbers = [];
    const state = { 'stays[s_existing].requested.departure': null };

    const differentGuest = structuredClone(before);
    differentGuest.stays[0]!.guests = [{ name: 'Bea Example', confirmationNumber: null }];
    expect(correctionsCarryTo(before, differentGuest, state)).toBe(false);

    before.stays[0]!.guests = [{ name: 'Ada Example', confirmationNumber: '11111111-1' }];
    const differentBooking = structuredClone(before);
    differentBooking.stays[0]!.guests![0]!.confirmationNumber = '22222222-1';
    expect(correctionsCarryTo(before, differentBooking, state)).toBe(false);

    const sameBooking = structuredClone(before);
    sameBooking.stays[0]!.guests![0]!.name = 'A. Example';
    expect(correctionsCarryTo(before, sameBooking, state)).toBe(true);

    const differentProperty = structuredClone(before);
    differentProperty.stays[0]!.hotel = 'Da Vinci';
    expect(correctionsCarryTo(before, differentProperty, state)).toBe(false);
    differentProperty.stays[0]!.hotel = null;
    expect(correctionsCarryTo(before, differentProperty, state)).toBe(false);
  });

  it('does not move saved edits when a partially overlapping roster or top-level number changes', () => {
    const before = mixedMail();
    before.stays = [before.stays[0]!];
    before.confirmationNumbers = [];
    before.stays[0]!.guests = [
      { name: 'Ada Example', confirmationNumber: null },
      { name: 'Bea Example', confirmationNumber: null },
    ];
    const state = { 'stays[s_existing].requested.departure': null };
    const changed = structuredClone(before);
    changed.stays[0]!.guests![1]!.name = 'Cal Example';
    expect(correctionsCarryTo(before, changed, state)).toBe(false);
    const reordered = structuredClone(before);
    reordered.stays[0]!.guests!.reverse();
    expect(correctionsCarryTo(before, reordered, state)).toBe(true);
    const duplicateName = structuredClone(before);
    duplicateName.stays[0]!.guests!.push({ name: 'Ada Example', confirmationNumber: null });
    expect(correctionsCarryTo(before, duplicateName, state)).toBe(false);

    before.confirmationNumbers = ['11111111-1'];
    const differentNumber = structuredClone(before);
    differentNumber.confirmationNumbers = ['22222222-1'];
    expect(correctionsCarryTo(before, differentNumber, state)).toBe(false);
    const sharedStays = { ...before, confirmationNumbers: ['22222222-1'] };
    expect(correctionsCarryTo(before, sharedStays, state)).toBe(false);
    const lostNumber = structuredClone(before);
    lostNumber.confirmationNumbers = [];
    expect(correctionsCarryTo(before, lostNumber, state)).toBe(false);
  });

  it('does not move a cleared field when same-date stays have only positional identities', () => {
    const before = mixedMail();
    before.stays = before.stays.map((stay) => ({
      ...stay, requested: { ...before.stays[0]!.requested }, guests: [],
    }));
    const after = structuredClone(before);
    after.stays = [
      { ...after.stays[1]!, id: 's_existing' },
      { ...after.stays[0]!, id: 's_new' },
    ];
    const state = { 'stays[s_existing].requested.departure': null };
    expect(correctionsCarryTo(before, after, state)).toBe(false);
    expect(correctionsCarryTo(before, after, {})).toBe(true);
  });

  it('does not use a positional room id for a staff correction after duplicate room types reorder', () => {
    const before = mixedMail();
    before.stays = [before.stays[0]!];
    const row = before.stays[0]!.rows[0]!;
    before.stays[0]!.rows = [row, { ...row, id: 'r_other', adultsPerRoom: 1 }];
    const after = structuredClone(before);
    after.stays[0]!.rows = [
      { ...after.stays[0]!.rows[1]!, id: 'r_existing' },
      { ...after.stays[0]!.rows[0]!, id: 'r_other' },
    ];
    expect(correctionsCarryTo(before, after, { 'stays[s_existing].rows[r_existing].adults': null })).toBe(false);
  });

  it('refuses a later extraction that reuses a staff-created stay id', () => {
    const before = mixedMail();
    const after = structuredClone(before);
    after.stays.push({ ...after.stays[1]!, id: 's_staff' });
    expect(correctionsCarryTo(before, after, { 'stays[s_staff].requested.arrival': '2027-12-01' })).toBe(false);
  });

  it('carries a clear when the same unique stay and room survive a re-read', () => {
    const before = mixedMail();
    const after = structuredClone(before);
    const state = { 'stays[s_new].rows[r_new].adults': null };
    expect(correctionsCarryTo(before, after, state)).toBe(true);
    const analysis = storedAnalysis({ kind: 'quote', payload: after, attachments: [] }, state).analysis;
    expect(analysis.groups.find((group) => group.stayId === 's_new')?.adults).toBeUndefined();
  });
});
