import { describe, expect, it } from 'vitest';
import {
  MAIL_MEASUREMENT_CONFIG_VERSION,
  hasMeasurementStart,
  isWithinConfirmedGap,
  parseMailboxMeasurementConfig,
  parseMailboxMeasurementConfigResult,
} from '../src/metrics/mail-measurement-config';

const validConfig = {
  version: MAIL_MEASUREMENT_CONFIG_VERSION,
  transportId: 'transport-centurion',
  cohortId: 'centurion',
  measurementStartAt: '2026-09-01T00:00:00.000Z',
  captureAssumptionBasis: 'two-way-feed-confirmed-by-operator',
  confirmedGapIntervals: [
    {
      startAt: '2026-09-03T12:00:00.000Z',
      endAt: '2026-09-03T14:00:00.000Z',
      reason: 'mailbox maintenance',
    },
  ],
};

describe('mail measurement configuration', () => {
  it('parses a versioned config without retaining unrelated secret-like fields', () => {
    const config = parseMailboxMeasurementConfig(
      JSON.stringify({ ...validConfig, smtpPassword: 'must-not-leak' }),
    );

    expect(config).toEqual(validConfig);
    expect(config).not.toHaveProperty('smtpPassword');
  });

  it('accepts a valid config with no T0 while keeping dependent metrics gated', () => {
    const config = parseMailboxMeasurementConfig(
      JSON.stringify({ ...validConfig, measurementStartAt: null }),
    );

    expect(config).toMatchObject({
      transportId: 'transport-centurion',
      cohortId: 'centurion',
      measurementStartAt: null,
    });
    expect(hasMeasurementStart(config)).toBe(false);
  });

  it('treats confirmed gaps as half-open intervals and does not invent a gap warning elsewhere', () => {
    const config = parseMailboxMeasurementConfig(JSON.stringify(validConfig));

    expect(config).not.toBeNull();
    expect(hasMeasurementStart(config)).toBe(true);
    expect(isWithinConfirmedGap('2026-09-03T12:00:00.000Z', config)).toBe(true);
    expect(isWithinConfirmedGap('2026-09-03T14:00:00.000Z', config)).toBe(false);
    expect(isWithinConfirmedGap('2026-09-03T15:00:00.000Z', config)).toBe(false);
  });

  it.each([
    undefined,
    '',
    '{not-json',
    JSON.stringify({ ...validConfig, version: 99 }),
    JSON.stringify({ ...validConfig, measurementStartAt: 'not-a-date' }),
    JSON.stringify({
      ...validConfig,
      confirmedGapIntervals: [
        {
          startAt: '2026-09-04T14:00:00.000Z',
          endAt: '2026-09-04T12:00:00.000Z',
        },
      ],
    }),
  ])('fails closed for absent or invalid config: %s', (raw) => {
    expect(parseMailboxMeasurementConfig(raw)).toBeNull();
    expect(parseMailboxMeasurementConfigResult(raw)).toMatchObject({
      status: 'unavailable',
      config: null,
    });
  });

  it('normalizes legacy input aliases but emits only the bounded contract', () => {
    const config = parseMailboxMeasurementConfig({
      schemaVersion: 1,
      mailboxTransportId: 'transport-centurion',
      cohort: 'centurion',
      captureAssumption: 'two-way-feed-assumed-after-t0',
      measurementStartAt: undefined,
      gapIntervals: [],
    });

    expect(config).toEqual({
      version: MAIL_MEASUREMENT_CONFIG_VERSION,
      transportId: 'transport-centurion',
      cohortId: 'centurion',
      measurementStartAt: null,
      captureAssumptionBasis: 'two-way-feed-assumed-after-t0',
      confirmedGapIntervals: [],
    });
  });
});
