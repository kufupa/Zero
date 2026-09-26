import { describe, expect, it, vi } from 'vitest';
import { createLiveReservationContextDriver } from '../src/hms/live-reservation-context-driver.js';
import type { LiveGuestStayDriver } from '../src/hms/live-guest-stay-driver.js';
import type { ReservationContextLookup } from '../src/hms/reservation-context-facade.js';

const lookup: ReservationContextLookup = {
  transportId: 't',
  mailboxId: 't',
  threadId: 'th',
  triggerMessageId: 'm',
  parentRef: 'p',
  branchId: 'reservation_summary',
  propertyCode: 'HRCEN',
  candidateId: 'cand-1',
  referenceKind: 'confirmation',
  value: 'CONF1',
  observedAt: new Date('2099-01-01T00:00:00.000Z'),
  expiresAt: new Date('2099-01-01T01:00:00.000Z'),
};

const row = {
  confirmationNumber: 'GRID-CONF',
  externalReference: null,
  guestName: 'Grid Guest',
  arrivalDate: '2099-01-15',
  departureDate: '2099-01-18',
  reservationStatus: 'Confirmed',
  roomType: 'GRID-ROOM',
  ratePlan: 'GRID-RATE',
};

function stubGuestStay(): LiveGuestStayDriver {
  return {
    loginAndVerifyBinding: vi.fn(),
    runNotFoundCanary: vi.fn(),
    searchExact: vi.fn(),
    searchExactAndMap: vi.fn(),
    searchExactThenDetailDump: vi.fn(),
    lastAuditReceipt: () => null,
  };
}

describe('createLiveReservationContextDriver readContext', () => {
  it('marks core/stay SURFACE_UNPROVEN when detail dump is absent (no grid-row fake-available)', async () => {
    const driver = createLiveReservationContextDriver({
      guestStay: stubGuestStay(),
      candidateFor: () => ({ id: 'cand-1', kind: 'confirmation', value: 'CONF1' }),
    });
    const sections = await driver.readContext(lookup, row);
    expect(sections.core).toEqual({
      status: 'unavailable',
      reasonCode: 'SURFACE_UNPROVEN',
    });
    expect(sections.stay).toEqual({
      status: 'unavailable',
      reasonCode: 'SURFACE_UNPROVEN',
    });
    expect(sections.rates).toMatchObject({
      status: 'unavailable',
      reasonCode: 'SURFACE_UNPROVEN',
    });
  });

  it('projects dump-proved core/stay and keeps rates SURFACE_UNPROVEN', async () => {
    const driver = createLiveReservationContextDriver({
      guestStay: stubGuestStay(),
      candidateFor: () => ({ id: 'cand-1', kind: 'confirmation', value: 'CONF1' }),
      detailDumpFor: async () => ({
        schemaVersion: 1,
        surface: 'guest_stay_detail',
        keys: [
          'confirmationnumber',
          'status',
          'arrivaldate',
          'departuredate',
          'roomtype',
          'adults',
          'rateplan',
        ],
        values: {
          confirmationnumber: 'DETAIL-CONF',
          status: 'Confirmed',
          arrivaldate: '15-Jan-2099',
          departuredate: '18-Jan-2099',
          roomtype: 'KING',
          adults: '2',
          rateplan: 'BAR',
        },
      }),
    });
    const sections = await driver.readContext(lookup, row);
    expect(sections.core?.status).toBe('available');
    expect(sections.core).toMatchObject({ confirmation: 'DETAIL-CONF' });
    expect(sections.stay?.status).toBe('available');
    expect(sections.stay).toMatchObject({ roomType: 'KING' });
    expect(sections.rates).toMatchObject({
      status: 'unavailable',
      reasonCode: 'SURFACE_UNPROVEN',
    });
  });
});
