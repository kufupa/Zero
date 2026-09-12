import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectReservationDetailDump } from '../src/hms/reservation-detail-projection.js';

const fixturePath = join(
  process.cwd(),
  'evals/hms/osresv-detail.live-shape.v1.json',
);

describe('osresv-detail live-shape fixture', () => {
  it('is valid and projects core+stay claim keys from live dump', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      valid: boolean;
      keys: string[];
      claimKeysPresent: string[];
    };
    expect(fixture.valid).toBe(true);
    expect(fixture.keys.length).toBeGreaterThanOrEqual(100);
    for (const key of fixture.claimKeysPresent) {
      expect(fixture.keys.map((k) => k.toLowerCase())).toContain(key.toLowerCase());
    }

    const projected = projectReservationDetailDump({
      schemaVersion: 1,
      surface: 'guest_stay_detail',
      keys: fixture.keys,
      values: {
        confirmationnumber: 'SYNTH-CONF',
        status: 'Confirmed',
        arrivaldate: '15-Jan-2099',
        departuredate: '18-Jan-2099',
        roomtype: 'KING',
        adults: '2',
        externalreference1: 'EXT-1',
        rateplan: 'BAR',
      },
    });

    expect(projected.core.status).toBe('available');
    expect(projected.stay.status).toBe('available');
    expect(projected.rates.status).toBe('unavailable');
    expect(projected.policies.status).toBe('unavailable');
    expect(projected.operations.status).toBe('unavailable');
    expect(projected.claimKeys).toEqual(
      expect.arrayContaining([
        'core.confirmation',
        'core.status',
        'core.externalReference',
        'stay.arrival',
        'stay.departure',
        'stay.roomType',
        'stay.adults',
      ]),
    );
  });
});
