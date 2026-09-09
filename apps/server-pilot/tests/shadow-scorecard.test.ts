import { buildShadowScorecard } from '../src/metrics/shadow-scorecard.js';
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
});
