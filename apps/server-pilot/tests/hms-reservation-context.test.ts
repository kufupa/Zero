import { describe, expect, it, vi } from 'vitest';
import {
  createReservationContextFacade,
  type ReservationContextLookup,
} from '../src/hms/reservation-context-facade.js';

const now = new Date('2026-09-07T12:00:00.000Z');

function lookup(overrides: Partial<ReservationContextLookup> = {}): ReservationContextLookup {
  return {
    transportId: 'transport-centurion',
    mailboxId: 'mailbox-centurion',
    threadId: 'thread-1',
    triggerMessageId: 'message-1',
    parentRef: 'parent-1',
    branchId: 'guest_stay_search',
    propertyCode: 'HRCEN',
    candidateId: 'candidate-1',
    referenceKind: 'confirmation',
    value: 'CONF-100',
    observedAt: now,
    expiresAt: new Date('2026-09-07T12:05:00.000Z'),
    ...overrides,
  };
}

describe('U8 reservation context facade', () => {
  it('mints a scoped reservation ref and resolves only the entitled snapshot', async () => {
    const find = vi.fn(async () => ({
      status: 'matched' as const,
      row: {
        confirmationNumber: 'CONF-100',
        externalReference: null,
        guestName: 'Guest',
        arrivalDate: '2026-09-10',
        departureDate: '2026-09-12',
        reservationStatus: 'Confirmed',
        roomType: 'STD',
        ratePlan: 'BAR',
      },
    }));
    const facade = createReservationContextFacade({
      now: () => now,
      lookup: find,
      readContext: async () => ({
        core: { status: 'available', confirmation: 'CONF-100' },
        stay: { status: 'available', arrival: '2026-09-10', departure: '2026-09-12' },
      }),
    });

    const found = await facade.findReservation(lookup());
    expect(found.status).toBe('ok');
    const ref = found.data?.matches[0]?.reservationRef;
    expect(ref).toEqual(expect.any(String));
    expect(ref).not.toContain('CONF-100');

    const snapshot = await facade.readReservation({
      ...lookup(),
      reservationRef: ref!,
      sections: ['core', 'stay'],
    });
    expect(snapshot.status).toBe('ok');
    expect(snapshot.data?.core.data).toMatchObject({ confirmation: expect.objectContaining({ value: 'CONF-100' }) });
    expect(snapshot.data?.stay.data).toMatchObject({ arrival: expect.objectContaining({ value: '2026-09-10' }) });
    expect(find).toHaveBeenCalledOnce();
  });

  it('rejects a ref replayed across mailbox, parent, or branch before PMS I/O', async () => {
    const readContext = vi.fn(async () => ({ core: { status: 'available' } }));
    const facade = createReservationContextFacade({
      now: () => now,
      lookup: async () => ({
        status: 'matched' as const,
        row: {
          confirmationNumber: 'CONF-100',
          externalReference: null,
          guestName: null,
          arrivalDate: '2026-09-10',
          departureDate: '2026-09-12',
          reservationStatus: 'Confirmed',
          roomType: 'STD',
          ratePlan: null,
        },
      }),
      readContext,
    });
    const found = await facade.findReservation(lookup());
    const ref = found.data?.matches[0]?.reservationRef;

    await expect(
      facade.readReservation({
        ...lookup({ mailboxId: 'other-mailbox' }),
        reservationRef: ref!,
        sections: ['core'],
      }),
    ).rejects.toMatchObject({ code: 'RESERVATION_REF_BINDING_MISMATCH' });
    await expect(
      facade.readReservation({
        ...lookup({ parentRef: 'other-parent' }),
        reservationRef: ref!,
        sections: ['core'],
      }),
    ).rejects.toMatchObject({ code: 'RESERVATION_REF_BINDING_MISMATCH' });
    await expect(
      facade.readReservation({
        ...lookup({ branchId: 'wrong-branch' }),
        reservationRef: ref!,
        sections: ['core'],
      }),
    ).rejects.toMatchObject({ code: 'RESERVATION_REF_BINDING_MISMATCH' });
    expect(readContext).not.toHaveBeenCalled();
  });

  it('keeps ambiguous same-surname matches non-selectable and hides guest identity', async () => {
    const facade = createReservationContextFacade({
      now: () => now,
      lookup: async () => ({
        status: 'ambiguous' as const,
        rows: [
          {
            confirmationNumber: 'CONF-1',
            externalReference: null,
            guestName: 'Private Guest',
            arrivalDate: '2026-09-10',
            departureDate: '2026-09-12',
            reservationStatus: 'Confirmed',
            roomType: 'STD',
            ratePlan: null,
          },
          {
            confirmationNumber: 'CONF-2',
            externalReference: null,
            guestName: 'Other Private Guest',
            arrivalDate: '2026-09-10',
            departureDate: '2026-09-12',
            reservationStatus: 'Confirmed',
            roomType: 'STD',
            ratePlan: null,
          },
        ],
      }),
      readContext: vi.fn(),
    });
    const result = await facade.findReservation(lookup({ referenceKind: 'surname_dates' }));
    expect(result.status).toBe('ambiguous');
    expect(result.data?.matches).toHaveLength(2);
    expect(result.data?.matches.every((match) => match.label.data === 'reservation match')).toBe(true);
    expect(result.data?.matches.some((match) => match.reservationRef)).toBe(false);
  });

  it('unique match projects composed guestName onto Match label (never sentinel)', async () => {
    const facade = createReservationContextFacade({
      now: () => now,
      lookup: async () => ({
        status: 'matched' as const,
        row: {
          confirmationNumber: 'CONF-100',
          externalReference: null,
          guestName: 'Example, Guest',
          arrivalDate: '2026-09-10',
          departureDate: '2026-09-12',
          reservationStatus: 'Confirmed',
          roomType: null,
          ratePlan: null,
        },
      }),
      readContext: vi.fn(),
    });
    const found = await facade.findReservation(lookup());
    expect(found.status).toBe('ok');
    const match = found.data?.matches[0];
    expect(match?.label.state).toBe('known');
    expect(match?.label.data).toBe('Example, Guest');
    expect(match?.label.data).not.toBe('reservation match');
    expect(match?.roomType.state).not.toBe('known');
  });

  it('unique match rejects numeric sentinel guestName as Match label', async () => {
    const facade = createReservationContextFacade({
      now: () => now,
      lookup: async () => ({
        status: 'matched' as const,
        row: {
          confirmationNumber: 'CONF-100',
          externalReference: null,
          guestName: '-1',
          arrivalDate: '2026-09-10',
          departureDate: '2026-09-12',
          reservationStatus: 'Confirmed',
          roomType: 'STD',
          ratePlan: null,
        },
      }),
      readContext: vi.fn(),
    });
    const found = await facade.findReservation(lookup());
    const match = found.data?.matches[0];
    expect(match?.label.state).not.toBe('known');
    expect(match?.label.data).not.toBe('-1');
  });
});
