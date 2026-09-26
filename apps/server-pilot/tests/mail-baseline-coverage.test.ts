import {
  createMailBaselineProjectionRows,
  reduceProjectedMailBaseline,
} from '../src/metrics/mail-baseline-projection.js';
import type { MailBaselineCoverage, MailBaselineEvidence } from '../src/metrics/mail-baseline.js';
import { aggregateAdminDashboardMetrics } from '../src/metrics/admin-dashboard-aggregates.js';
import { describe, expect, it } from 'vitest';

const oldT0 = '2026-09-01T00:00:00.000Z';
const currentT0 = '2026-09-05T00:00:00.000Z';

function coverage(configVersion: string, startAt: string): MailBaselineCoverage {
  return {
    startAt,
    endAt: '2026-09-08T12:00:00.000Z',
    basis: `configured-${configVersion}`,
    complete: true,
    configVersion,
  };
}

function askEvidence(): MailBaselineEvidence {
  return {
    id: 'coverage-ask',
    requestId: 'coverage-request',
    askId: 'coverage-ask',
    threadId: 'coverage-thread',
    transportId: 'transport-centurion',
    eventType: 'ask',
    direction: 'inbound',
    eventAt: '2026-09-02T09:00:00.000Z',
    observedAt: '2026-09-02T09:01:00.000Z',
    source: 'mail_event',
    sourceBasis: 'source_event',
    requiresHotelResponse: true,
    workState: 'open',
    answerState: null,
    substantive: false,
    linkStrength: 'thread',
    delivery: null,
  };
}

function usefulEvidence(): MailBaselineEvidence[] {
  return [
    askEvidence(),
    {
      id: 'coverage-answer',
      requestId: 'coverage-request',
      askId: 'coverage-ask',
      threadId: 'coverage-thread',
      transportId: 'transport-centurion',
      eventType: 'answer',
      direction: 'outbound',
      eventAt: '2026-09-02T09:30:00.000Z',
      observedAt: '2026-09-02T09:31:00.000Z',
      source: 'external_sent',
      sourceBasis: 'source_event',
      requiresHotelResponse: false,
      requiresCustomerInformation: false,
      answerState: 'supported',
      workState: 'complete',
      substantive: true,
      linkStrength: 'header',
      delivery: { status: 'sent' },
    },
  ];
}

function aggregateWithCurrentConfig(
  measurementStartAt: string,
  confirmedGapIntervals: readonly { startAt: string; endAt: string }[],
  requestBaselines: readonly ReturnType<typeof reduceProjectedMailBaseline>[],
) {
  const cutoff = new Date('2026-09-08T12:00:00.000Z');
  return aggregateAdminDashboardMetrics({
    cohortId: 'centurion',
    observationCutoff: cutoff,
    classificationSnapshot: null,
    measurementConfig: {
      version: 2,
      transportId: 'transport-centurion',
      cohortId: 'centurion',
      measurementStartAt,
      captureAssumptionBasis: 'mutable-current-config',
      confirmedGapIntervals,
    },
    threads: [],
    messages: [],
    transports: [
      {
        id: 'transport-centurion',
        email: 'centurion@legacyhotels.co.za',
        displayName: 'Centurion',
      },
    ],
    requestBaselines,
    windowStart: new Date('2026-09-01T00:00:00.000Z'),
    windowEnd: cutoff,
  });
}

describe('mail baseline coverage snapshots', () => {
  it('retains producer T0/config snapshot when the current config changes', () => {
    const rows = createMailBaselineProjectionRows({
      transportId: 'transport-centurion',
      threadId: 'coverage-thread',
      generationId: 'coverage-generation-v1',
      sourceVintage: 'coverage-v1',
      interpretationVersion: 'mail-baseline-interpretation-v1',
      observationCutoff: '2026-09-08T12:00:00.000Z',
      measurementStartAt: oldT0,
      coverage: coverage('v1', oldT0),
      evidence: [askEvidence()],
    });

    const result = reduceProjectedMailBaseline(rows, {
      observationCutoff: '2026-09-08T12:00:00.000Z',
      sourceVintage: 'coverage-v1',
      interpretationVersion: 'mail-baseline-interpretation-v1',
      measurementStartAt: currentT0,
      coverage: coverage('v2', currentT0),
    });

    expect(result.coverage).toMatchObject({
      configVersion: 'v1',
      startAt: oldT0,
      basis: 'configured-v1',
    });
    expect(result.denominators).toMatchObject({ eligible: 1, scorable: 1 });
  });

  it('uses selected producer coverage for first-useful reply when current T0 and gaps change', () => {
    const cutoff = '2026-09-08T12:00:00.000Z';
    const projection = reduceProjectedMailBaseline(
      createMailBaselineProjectionRows({
        transportId: 'transport-centurion',
        threadId: 'coverage-thread',
        generationId: 'coverage-generation-useful-v1',
        sourceVintage: 'coverage-useful-v1',
        interpretationVersion: 'mail-baseline-interpretation-v1',
        observationCutoff: cutoff,
        measurementStartAt: oldT0,
        coverage: coverage('v1', oldT0),
        evidence: usefulEvidence(),
      }),
      {
        transportId: 'transport-centurion',
        threadId: 'coverage-thread',
        observationCutoff: cutoff,
        sourceVintage: 'coverage-useful-v1',
        interpretationVersion: 'mail-baseline-interpretation-v1',
      },
    );

    const result = aggregateWithCurrentConfig(
      currentT0,
      [{ startAt: '2026-09-02T09:15:00.000Z', endAt: '2026-09-02T09:45:00.000Z' }],
      [projection],
    );

    expect(result.service.firstUsefulReply).toMatchObject({
      availability: 'available',
      value: 30,
      denominator: 1,
      measurementConfigVersion: 'v1',
      captureBasis: 'configured-v1',
    });
    expect(result.service.firstUsefulReply.exclusions).toEqual({});
  });

  it('does not manufacture first-useful evidence when producer coverage has no T0', () => {
    const cutoff = '2026-09-08T12:00:00.000Z';
    const projection = reduceProjectedMailBaseline(
      createMailBaselineProjectionRows({
        transportId: 'transport-centurion',
        threadId: 'coverage-thread',
        generationId: 'coverage-generation-missing-t0',
        sourceVintage: 'coverage-missing-t0',
        interpretationVersion: 'mail-baseline-interpretation-v1',
        observationCutoff: cutoff,
        measurementStartAt: null,
        coverage: {
          configVersion: null,
          startAt: null,
          endAt: cutoff,
          basis: 'coverage_unconfigured',
          complete: false,
          confirmedGapIntervals: [],
        },
        evidence: usefulEvidence(),
      }),
      {
        transportId: 'transport-centurion',
        threadId: 'coverage-thread',
        observationCutoff: cutoff,
        sourceVintage: 'coverage-missing-t0',
        interpretationVersion: 'mail-baseline-interpretation-v1',
      },
    );

    const result = aggregateWithCurrentConfig(currentT0, [], [projection]);

    expect(result.service.firstUsefulReply).toMatchObject({
      availability: 'unavailable',
      value: null,
      availabilityReason: 'coverage_unavailable',
      measurementConfigVersion: null,
    });
    expect(result.service.firstUsefulReply.captureBasis).toBe('coverage_unconfigured');
  });
});
