import { describe, expect, it } from 'vitest';
import {
  projectReservationDetailDump,
  type ReservationDetailDumpV1,
} from '../src/hms/reservation-detail-projection.js';

describe('projectReservationDetailDump', () => {
  it('projects core/stay from dump-proved keys; rates stay SURFACE_UNPROVEN', () => {
    const dump: ReservationDetailDumpV1 = {
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
        confirmationnumber: 'CONF-1',
        status: 'Checked Out',
        arrivaldate: '2026-08-26',
        departuredate: '2026-08-27',
        roomtype: 'DELUXE',
        adults: 2,
        rateplan: 'BAR',
      },
    };
    const projected = projectReservationDetailDump(dump);
    expect(projected.core.status).toBe('available');
    expect(projected.core.confirmation).toBe('CONF-1');
    expect(projected.stay.roomType).toBe('DELUXE');
    expect(projected.stay.adults).toBe(2);
    expect(projected.claimKeys).toContain('stay.roomType');
    expect(projected.claimKeys).not.toContain('rates.ratePlan');
    expect(projected.rates).toEqual({
      status: 'unavailable',
      reasonCode: 'SURFACE_UNPROVEN',
    });
  });

  it('does not invent roomType when dump omits roomtype key', () => {
    const dump: ReservationDetailDumpV1 = {
      schemaVersion: 1,
      surface: 'guest_stay_detail',
      keys: ['confirmationnumber', 'arrivaldate', 'departuredate', 'status'],
      values: {
        confirmationnumber: 'CONF-1',
        arrivaldate: '2026-08-26',
        departuredate: '2026-08-27',
        status: 'Confirmed',
      },
    };
    const projected = projectReservationDetailDump(dump);
    expect(projected.stay.roomType).toBeUndefined();
    expect(projected.claimKeys).not.toContain('stay.roomType');
  });
});
