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
    const { analysis } = storedAnalysis(
      { kind: 'voucher_pop', payload: emptyPayload, attachments: [], subject: 'POP for 57291630-1' },
      {},
    );
    expect(analysis.luna.workflow).toBe('payment_ack');
    const card = await hmsTodoCardFromLuna(analysis.luna, [], 'Kindly find attached proof of payment.');
    expect(card).toMatchObject({ kind: 'payment_proof' });
  });

  it('keeps a stored voucher with no payment cue as other', () => {
    const { analysis } = storedAnalysis(
      { kind: 'voucher_pop', payload: emptyPayload, attachments: [], subject: 'Hotel voucher', bodyText: 'Please find the voucher attached.' },
      {},
    );
    expect(analysis.luna.workflow).toBe('other');
  });

  it('maps a stored booking read to a new_booking card', async () => {
    const { analysis } = storedAnalysis({ kind: 'booking', payload: bookingPayload, attachments: [] }, {});
    expect(analysis.luna.workflow).toBe('create_booking');
    const card = await hmsTodoCardFromLuna(analysis.luna, [], 'Please confirm the booking.');
    expect(card).toMatchObject({ kind: 'new_booking' });
  });

  it('maps HRDAV STD KNG on the booking checklist to STKNG, not Centurion SKNG', async () => {
    const payload: MailExtractionPayload = {
      ...bookingPayload,
      stays: [
        {
          ...bookingPayload.stays[0]!,
          rows: [{ ...bookingPayload.stays[0]!.rows[0]!, roomType: 'STD KNG' }],
        },
      ],
    };
    const { analysis } = storedAnalysis({ kind: 'booking', payload, attachments: [] }, {}, undefined, 'HRDAV');
    const card = await hmsTodoCardFromLuna(analysis.luna, [], 'Please confirm the booking.', 'HRDAV');
    expect(card).toMatchObject({ kind: 'new_booking' });
    expect(card?.prefill?.fields).toEqual(expect.arrayContaining([{ label: 'Room type', value: 'STKNG' }]));
  });

  it('maps HRDAV Standard King on the booking checklist to STKNG, not Centurion SKNG', async () => {
    const payload: MailExtractionPayload = {
      ...bookingPayload,
      stays: [
        {
          ...bookingPayload.stays[0]!,
          rows: [{ ...bookingPayload.stays[0]!.rows[0]!, roomType: 'Standard King' }],
        },
      ],
    };
    const { analysis } = storedAnalysis({ kind: 'booking', payload, attachments: [] }, {}, undefined, 'HRDAV');
    const withoutProperty = await hmsTodoCardFromLuna(analysis.luna, [], 'Please confirm the booking.');
    expect(withoutProperty?.prefill?.fields).toEqual(
      expect.arrayContaining([{ label: 'Room type', value: 'SKNG' }]),
    );
    const card = await hmsTodoCardFromLuna(analysis.luna, [], 'Please confirm the booking.', 'HRDAV');
    expect(card).toMatchObject({ kind: 'new_booking' });
    expect(card?.prefill?.fields).toEqual(expect.arrayContaining([{ label: 'Room type', value: 'STKNG' }]));
  });
});
