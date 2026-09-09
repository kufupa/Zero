import {
  createMailBaselineProjectionRows,
  reduceProjectedMailBaseline,
} from '../src/metrics/mail-baseline-projection.js';
import type { MailBaselineCoverage, MailBaselineEvidence } from '../src/metrics/mail-baseline.js';
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
});
