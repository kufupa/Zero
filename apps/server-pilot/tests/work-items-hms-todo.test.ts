import { describe, expect, it } from 'vitest';
import type { MailExtractionPayload } from '../src/ai/extraction/schema.js';
import { hmsTodoCardFromLuna } from '../src/ai/quote-workflow-analyse-selection.js';
import { storedAnalysis } from '../src/ai/work-items.js';

const emptyPayload: MailExtractionPayload = {
  contact: { name: null, email: null, phone: null },
  agency: null,
  endClient: null,
  confirmationNumbers: ['57291630-1'],
  stays: [],
  missing: [],
};

const bookingPayload: MailExtractionPayload = {
  contact: { name: null, email: null, phone: null },
  agency: 'Horizon Trail Tours',
  endClient: null,
  confirmationNumbers: [],
  stays: [
    {
      id: 's_book1',
      hotel: 'Grand Hotel',
      requested: { arrival: '2027-10-26', departure: '2027-10-28' },
      booked: null,
      totalRooms: 1,
      rows: [
        {
          id: 'r_book1',
          roomType: 'Double/Twin',
          rooms: 1,
          adultsPerRoom: 2,
          childAges: [],
          board: 'bb',
        },
      ],
    },
  ],
  missing: [],
};

describe('stored read hmsTodoCard', () => {
  it('maps a stored voucher_pop read to payment_ack and a payment_proof card', async () => {
    const { analysis } = storedAnalysis({ kind: 'voucher_pop', payload: emptyPayload, attachments: [] }, {});
    expect(analysis.luna.workflow).toBe('payment_ack');
    const card = await hmsTodoCardFromLuna(analysis.luna, [], 'Kindly find attached proof of payment.');
    expect(card).toMatchObject({ kind: 'payment_proof' });
  });

  it('maps a stored booking read to a new_booking card', async () => {
    const { analysis } = storedAnalysis({ kind: 'booking', payload: bookingPayload, attachments: [] }, {});
    expect(analysis.luna.workflow).toBe('create_booking');
    const card = await hmsTodoCardFromLuna(analysis.luna, [], 'Please confirm the booking.');
    expect(card).toMatchObject({ kind: 'new_booking' });
  });
});
