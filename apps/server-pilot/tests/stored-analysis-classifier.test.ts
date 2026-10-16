import { describe, expect, it } from 'vitest';
import type { MailExtractionPayload } from '../src/ai/extraction/schema.js';
import { storedAnalysis } from '../src/ai/work-items.js';

const payload = {
  contact: { name: null, email: null, phone: null },
  agency: 'Horizon Trail Tours',
  endClient: null,
  confirmationNumbers: [],
  stays: [
    {
      id: 's_aaaa1111',
      hotel: 'Grand Hotel',
      requested: { arrival: '2027-10-26', departure: '2027-10-28' },
      booked: null,
      totalRooms: null,
      rows: [
        { id: 'r_bbbb1111', roomType: 'Single', rooms: 2, adultsPerRoom: 1, childAges: [], board: null },
      ],
    },
  ],
  missing: [],
} satisfies MailExtractionPayload;

describe('storedAnalysis classifier overlay', () => {
  it('uses a high-confidence billing classifier on an other extraction as send_document', () => {
    const analysis = storedAnalysis(
      {
        kind: 'other',
        payload,
        attachments: [],
        classifier: { workflow: 'billing', confidence: 'high' },
      },
      {},
    ).analysis;
    expect(analysis.luna.workflow).toBe('send_document');
    expect(analysis.luna.party.name).toBe('Horizon Trail Tours');
  });

  it('uses a medium-confidence classifier the same way as high', () => {
    const analysis = storedAnalysis(
      {
        kind: 'booking',
        payload,
        attachments: [],
        classifier: { workflow: 'new_booking', confidence: 'medium' },
      },
      {},
    ).analysis;
    expect(analysis.luna.workflow).toBe('create_booking');
  });

  it('falls back to the kind map when classifier confidence is low', () => {
    const other = storedAnalysis(
      {
        kind: 'other',
        payload,
        attachments: [],
        classifier: { workflow: 'billing', confidence: 'low' },
      },
      {},
    ).analysis;
    expect(other.luna.workflow).toBe('other');

    const voucher = storedAnalysis({ kind: 'voucher_pop', payload, attachments: [] }, {}).analysis;
    expect(voucher.luna.workflow).toBe('payment_ack');
  });
});
