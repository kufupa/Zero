import { describe, expect, it } from 'vitest';
import { buildHmsTodoCard } from '../src/ai/hms-todo-card.js';

function labelsOf(card: NonNullable<ReturnType<typeof buildHmsTodoCard>>): string[] {
  return card.steps.map((step) => step.label);
}

describe('buildHmsTodoCard', () => {
  it('builds a new_booking card from a full stay ask', () => {
    const card = buildHmsTodoCard({
      workflow: 'create_booking',
      stayAsk: {
        arrivalDate: '2026-11-12',
        departureDate: '2026-11-14',
        adults: 2,
        children: 0,
        rooms: 1,
      },
      guestLastName: 'Example',
    });

    expect(card).toEqual({
      kind: 'new_booking',
      title: 'Key into HMS',
      writesEnabled: false,
      missing: [],
      steps: [
        { label: 'Arrival', value: '2026-11-12', source: 'mail' },
        { label: 'Departure', value: '2026-11-14', source: 'mail' },
        { label: 'Rooms', value: '1', source: 'mail' },
        { label: 'Adults', value: '2', source: 'mail' },
        { label: 'Guest last name', value: 'Example', source: 'mail' },
      ],
    });
    expect(new Set(labelsOf(card!)).size).toBe(card!.steps.length);
  });

  it('builds an amend card with confirmation number and requested change', () => {
    const card = buildHmsTodoCard({
      workflow: 'amend',
      confirmationNumber: '57291630-1',
      guestLastName: 'Example',
      requestedChange: 'Change departure from 15 Nov to 17 Nov',
    });

    expect(card).toMatchObject({
      kind: 'amend',
      title: 'Key into HMS',
      writesEnabled: false,
      missing: [],
    });
    expect(card!.steps).toEqual([
      { label: 'Confirmation number', value: '57291630-1', source: 'mail' },
      { label: 'Guest last name', value: 'Example', source: 'mail' },
      { label: 'Requested change', value: 'Change departure from 15 Nov to 17 Nov', source: 'mail' },
    ]);
    expect(new Set(labelsOf(card!)).size).toBe(card!.steps.length);
  });

  it('lists a missing confirmation number on cancel', () => {
    const card = buildHmsTodoCard({ workflow: 'cancel' });

    expect(card).toMatchObject({
      kind: 'cancel',
      title: 'Key into HMS',
      writesEnabled: false,
    });
    expect(card!.missing).toEqual(['Confirmation number']);
    expect(card!.steps).toEqual([
      { label: 'Confirmation number', value: null, source: 'missing' },
    ]);
  });

  it('builds a payment_proof card with amount', () => {
    const card = buildHmsTodoCard({
      workflow: 'voucher_pop',
      paymentAmount: 'ZAR 1500.00',
      paymentReference: 'EFT-1001',
      confirmationNumber: '57291630-1',
      attachmentFilenames: ['receipt.pdf'],
    });

    expect(card).toMatchObject({
      kind: 'payment_proof',
      title: 'Key into HMS',
      writesEnabled: false,
      missing: [],
    });
    expect(card!.steps).toEqual([
      { label: 'Confirmation number', value: '57291630-1', source: 'mail' },
      { label: 'Payment amount', value: 'ZAR 1500.00', source: 'mail' },
      { label: 'Payment reference', value: 'EFT-1001', source: 'mail' },
      { label: 'Attachments', value: 'receipt.pdf', source: 'attachment' },
    ]);
    expect(new Set(labelsOf(card!)).size).toBe(card!.steps.length);
  });

  it('returns null for quote', () => {
    expect(
      buildHmsTodoCard({
        workflow: 'quote',
        stayAsk: {
          arrivalDate: '2026-11-12',
          departureDate: '2026-11-14',
          adults: 2,
          rooms: 1,
        },
      }),
    ).toBeNull();
  });
});
