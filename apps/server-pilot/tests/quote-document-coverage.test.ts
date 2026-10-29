import { describe, expect, it } from 'vitest';
import { childOccupancyMatchesStored, quoteDocumentMatchesStored } from '../src/ai/child-occupancy.js';
import type { MailExtractionPayload } from '../src/ai/extraction/schema.js';

function fixture() {
  const stay = (id: string, rowId: string, arrival: string, departure: string) => ({
    id, hotel: null, requested: { arrival, departure }, booked: null, totalRooms: 1,
    action: 'quote_availability' as const,
    rows: [{ id: rowId, roomType: null, rooms: 1, adultsPerRoom: 2,
      childrenPerRoom: 0, childAges: [], board: null }],
  });
  const payload: MailExtractionPayload = { contact: { name: null, email: null, phone: null },
    agency: null, endClient: null, confirmationNumbers: [], missing: [], stays: [
      stay('s1', 'r1', '2027-10-20', '2027-10-21'),
      stay('s2', 'r2', '2027-11-20', '2027-11-21'),
    ] };
  const first = { id: 'r1', arrivalDate: '2027-10-20', departureDate: '2027-10-21',
    quantity: 1, adults: 2, childrenPerRoom: 0, childrenAges: [] };
  const second = { ...first, id: 'r2', arrivalDate: '2027-11-20', departureDate: '2027-11-21' };
  return { payload, first, second, state: {} as Record<string, unknown> };
}

describe('Centurion final quote document coverage', () => {
  it('permits each separate rate search but requires every active saved stay exactly once in the document', () => {
    const { payload, first, second, state } = fixture();
    expect(childOccupancyMatchesStored([first], payload, state)).toBe(true);
    expect(childOccupancyMatchesStored([second], payload, state)).toBe(true);
    expect(quoteDocumentMatchesStored([first], payload, state, 'quote')).toBe(false);
    expect(quoteDocumentMatchesStored([first, first], payload, state, 'quote')).toBe(false);
    expect(quoteDocumentMatchesStored([first, second], payload, state, 'quote')).toBe(true);
    state['stays[s2].removed'] = true;
    expect(quoteDocumentMatchesStored([first], payload, state, 'quote')).toBe(true);
    expect(quoteDocumentMatchesStored([first, second], payload, state, 'quote')).toBe(false);
  });

  it('counts a staff-added stay and holds an incomplete or unpriced one', () => {
    const { payload, first, second, state } = fixture();
    payload.stays.pop();
    Object.assign(state, { 'stays[s2].requested.arrival': second.arrivalDate,
      'stays[s2].requested.departure': second.departureDate, 'stays[s2].rows[r2].count': 1,
      'stays[s2].rows[r2].adults': 2, 'stays[s2].rows[r2].childrenPerRoom': 0,
      'stays[s2].rows[r2].childAges': [] });
    expect(quoteDocumentMatchesStored([first], payload, state, 'quote')).toBe(false);
    expect(quoteDocumentMatchesStored([first, second], payload, state, 'quote')).toBe(true);
    state['stays[s2].rows[r2].childAges'] = null;
    expect(quoteDocumentMatchesStored([first, second], payload, state, 'quote')).toBe(false);
    state['stays[s2].rows[r2].removed'] = true;
    expect(quoteDocumentMatchesStored([first], payload, state, 'quote')).toBe(true);
    state['stays[s3].requested.arrival'] = '2027-12-20';
    expect(quoteDocumentMatchesStored([first], payload, state, 'quote')).toBe(false);
  });

  it('recognizes the saved synthetic row for a dates-only extraction without duplicating it', () => {
    const { payload, first, second, state } = fixture();
    payload.stays[1]!.rows = [];
    Object.assign(state, { 'stays[s2].rows[s2_row].count': 1, 'stays[s2].rows[s2_row].adults': 2,
      'stays[s2].rows[s2_row].childrenPerRoom': 0, 'stays[s2].rows[s2_row].childAges': [] });
    const alias = { ...second, id: 's2' }, row = { ...second, id: 's2_row' };
    expect(quoteDocumentMatchesStored([first, alias], payload, state, 'quote')).toBe(true);
    expect(quoteDocumentMatchesStored([first, row], payload, state, 'quote')).toBe(true);
    expect(quoteDocumentMatchesStored([first, alias, row], payload, state, 'quote')).toBe(false);
  });

  it('holds if a removed row id collides with a different stay id', () => {
    const { payload, second, state } = fixture();
    payload.stays[0]!.rows[0]!.id = 's2';
    payload.stays.push({ ...payload.stays[1]!, id: 's3', rows: [{ ...payload.stays[1]!.rows[0]!, id: 'r3' }] });
    state['stays[s1].rows[s2].removed'] = true;
    const third = { ...second, id: 'r3' };
    expect(childOccupancyMatchesStored([third], payload, state)).toBe(true);
    expect(quoteDocumentMatchesStored([third], payload, state, 'quote')).toBe(false);
  });

  it('holds mixed or incompletely assigned actions while preserving pure quote and booking cases', () => {
    const { payload, first, second, state } = fixture();
    payload.action = 'quote_availability';
    payload.stays[0]!.action = 'quote_availability';
    payload.stays[1]!.action = 'new_booking';
    expect(quoteDocumentMatchesStored([first, second], payload, state, 'quote')).toBe(false);
    delete payload.stays[1]!.action;
    expect(quoteDocumentMatchesStored([first, second], payload, state, 'quote')).toBe(false);
    delete payload.stays[0]!.action;
    expect(quoteDocumentMatchesStored([first, second], payload, state, 'quote')).toBe(false);
    payload.stays[0]!.action = 'quote_availability';
    payload.stays[1]!.action = 'quote_availability';
    expect(quoteDocumentMatchesStored([first, second], payload, state, 'quote')).toBe(true);
    payload.action = 'new_booking';
    payload.stays.forEach((stay) => { stay.action = 'new_booking'; });
    expect(quoteDocumentMatchesStored([first, second], payload, state, 'booking')).toBe(true);
    expect(quoteDocumentMatchesStored([first, second], payload, state, 'quote')).toBe(false);
  });
});
