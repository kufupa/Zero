import {
  buildShadowAdmissionPopulation,
  buildShadowScorecard,
} from '../src/metrics/shadow-scorecard.js';
import { describe, expect, it } from 'vitest';

describe('shadow scorecard', () => {
  it('reports operational coverage and keeps missing labels out of quality numerators', () => {
    const report = buildShadowScorecard({
      evaluationMode: 'future_shadow',
      predictions: [
        { id: 'p1', admissionStatus: 'admitted', predictionStatus: 'sealed' },
        { id: 'p2', admissionStatus: 'skipped', predictionStatus: 'unavailable' },
        { id: 'p3', admissionStatus: 'admitted', predictionStatus: 'failed' },
      ],
      assessments: [
        {
          predictionId: 'p1',
          status: 'matched',
          labelProvenance: { source: 'reviewer', labelId: 'label-1', unique: true, bound: true },
          verdict: 'correct',
        },
        {
          predictionId: 'p4',
          status: 'matched',
          labelProvenance: null,
          verdict: null,
        },
      ],
    });

    expect(report.evaluationMode).toBe('future_shadow');
    expect(report.counts).toMatchObject({
      eligible: 3,
      admitted: 2,
      sealed: 1,
      skipped: 1,
      failed: 1,
      matched: 1,
      labelled: 1,
      scorable: 1,
      correct: 1,
    });
    expect(report.quality).toMatchObject({ availability: 'available', denominator: 1 });
  });

  it('marks quality unavailable for absent, duplicate, or unbound labels without zero-filling', () => {
    const report = buildShadowScorecard({
      evaluationMode: 'future_shadow',
      predictions: [{ id: 'p1', admissionStatus: 'admitted', predictionStatus: 'sealed' }],
      assessments: [
        {
          predictionId: 'p1',
          status: 'matched',
          labelProvenance: { source: 'reviewer', labelId: 'duplicate', unique: false, bound: true },
          verdict: 'incorrect',
        },
      ],
    });
    expect(report.counts.scorable).toBe(0);
    expect(report.counts.incorrect).toBe(0);
    expect(report.quality).toMatchObject({
      availability: 'unavailable',
      denominator: null,
      reason: 'label_provenance_unavailable',
    });
  });

  it('uses the highest persisted assessment revision instead of input order', () => {
    const report = buildShadowScorecard({
      evaluationMode: 'future_shadow',
      predictions: [{ id: 'p1', admissionStatus: 'admitted', predictionStatus: 'sealed' }],
      assessments: [
        {
          predictionId: 'p1',
          status: 'matched',
          labelProvenance: {
            source: 'reviewer',
            labelId: 'latest',
            unique: true,
            bound: true,
          },
          verdict: 'incorrect',
          revision: 2,
        } as never,
        {
          predictionId: 'p1',
          status: 'matched',
          labelProvenance: { source: 'reviewer', labelId: 'old', unique: true, bound: true },
          verdict: 'correct',
          revision: 1,
        } as never,
      ],
    });

    expect(report.counts.correct).toBe(0);
    expect(report.counts.incorrect).toBe(1);
  });

  it('does not pool evaluation modes', () => {
    expect(() =>
      buildShadowScorecard({
        evaluationMode: 'future_shadow',
        predictions: [
          {
            id: 'p1',
            evaluationMode: 'future_shadow',
            admissionStatus: 'admitted',
            predictionStatus: 'sealed',
          },
          {
            id: 'p2',
            evaluationMode: 'historical_replay',
            admissionStatus: 'admitted',
            predictionStatus: 'sealed',
          },
        ],
        assessments: [],
      }),
    ).toThrow(/evaluation mode/i);
  });

  it('exposes admission-clock coverage separately from sealed prediction counts', () => {
    const admissionPopulation = buildShadowAdmissionPopulation({
      evaluationMode: 'future_shadow',
      admissions: [
        {
          id: 'sealed-only',
          eligible: true,
          admissionStatus: 'admitted',
          hasSealedPrediction: true,
        },
        {
          id: 'skipped',
          eligible: true,
          admissionStatus: 'skipped',
          hasSealedPrediction: false,
        },
        {
          id: 'denied',
          eligible: false,
          admissionStatus: 'denied',
          hasSealedPrediction: false,
        },
        {
          id: 'pending',
          eligible: true,
          admissionStatus: 'admitted',
          hasSealedPrediction: false,
        },
      ],
      windowStart: '2026-09-01T00:00:00.000Z',
      windowEnd: '2026-09-08T00:00:00.000Z',
      observationCutoff: '2026-09-09T12:00:00.000Z',
    });
    const report = buildShadowScorecard({
      evaluationMode: 'future_shadow',
      predictions: [{ id: 'sealed-only', admissionStatus: 'admitted', predictionStatus: 'sealed' }],
      assessments: [],
      admissionPopulation,
    });

    expect(report.counts).toMatchObject({ eligible: 1, admitted: 1, sealed: 1, pending: 0 });
    expect(report.admissionPopulation).toMatchObject({
      availability: 'available',
      reason: null,
      counts: { eligible: 3, admitted: 2, skipped: 1, denied: 1, pending: 1 },
      provenance: {
        selectionClock: 'admission_created_at',
        windowStart: '2026-09-01T00:00:00.000Z',
        windowEnd: '2026-09-08T00:00:00.000Z',
        observationCutoff: '2026-09-09T12:00:00.000Z',
      },
    });
  });

  it('distinguishes confirmed admission absence from an unloaded population', () => {
    const absent = buildShadowAdmissionPopulation({
      evaluationMode: 'future_shadow',
      admissions: [],
      windowStart: '2026-09-01T00:00:00.000Z',
      windowEnd: '2026-09-08T00:00:00.000Z',
      observationCutoff: '2026-09-09T12:00:00.000Z',
    });
    expect(absent).toMatchObject({
      availability: 'available',
      reason: 'no_admission_receipts',
      counts: { eligible: 0, admitted: 0, skipped: 0, denied: 0, pending: 0 },
    });
    expect(
      buildShadowScorecard({
        evaluationMode: 'future_shadow',
        predictions: [],
        assessments: [],
      }).admissionPopulation,
    ).toMatchObject({
      availability: 'unavailable',
      reason: 'not_loaded',
      counts: { eligible: null, admitted: null, skipped: null, denied: null, pending: null },
    });
  });
});
