import { describe, expect, it } from 'vitest';
import {
  assertNotPilotProdDatabase,
  isPilotProdDatabase,
  PILOT_PROD_DB_HOST,
} from './helpers/pilot-rds-guard';

describe('pilot-rds-guard', () => {
  const pilotUrl =
    'postgresql://u:p@nava-zero-mail-pilot.abc123.af-south-1.rds.amazonaws.com:5432/zero';

  it('exports the same host marker as ingest-benchmark', () => {
    expect(PILOT_PROD_DB_HOST).toBe('nava-zero-mail-pilot');
  });

  it('detects pilot host via URL hostname', () => {
    expect(isPilotProdDatabase(pilotUrl)).toBe(true);
  });

  it('falls back to substring when URL parse fails', () => {
    expect(
      isPilotProdDatabase('not-a-url-but-has-nava-zero-mail-pilot-inside'),
    ).toBe(true);
  });

  it('allows non-pilot hosts', () => {
    expect(isPilotProdDatabase('postgresql://u:p@localhost:5432/zero')).toBe(
      false,
    );
    expect(
      isPilotProdDatabase(
        'postgresql://u:p@other-rds.abc.af-south-1.rds.amazonaws.com:5432/zero',
      ),
    ).toBe(false);
  });

  it('refuses pilot URL', () => {
    expect(() => assertNotPilotProdDatabase(pilotUrl)).toThrow(
      /No override exists/,
    );
  });

  it('refuses pilot URL even when legacy opt-in is set', () => {
    const previous = process.env.VITEST_ALLOW_PILOT_RDS;
    process.env.VITEST_ALLOW_PILOT_RDS = '1';
    try {
      expect(() => assertNotPilotProdDatabase(pilotUrl)).toThrow(
        /No override exists/,
      );
    } finally {
      if (previous === undefined) {
        delete process.env.VITEST_ALLOW_PILOT_RDS;
      } else {
        process.env.VITEST_ALLOW_PILOT_RDS = previous;
      }
    }
  });

  it('no-ops when DATABASE_URL unset / empty', () => {
    expect(() => assertNotPilotProdDatabase(undefined)).not.toThrow();
    expect(() => assertNotPilotProdDatabase('')).not.toThrow();
  });
});
