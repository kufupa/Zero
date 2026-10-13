import { describe, expect, it } from 'vitest';
import {
  ACTION_LABELS,
  computeActionClassifierMetrics,
  type ActionEvalCase,
} from '../src/ai/extraction/action-eval-metrics.js';

describe('action classifier eval metrics', () => {
  it('computes binary/action accuracy, confusion counts, and per-class precision/recall', () => {
    const cases: ActionEvalCase[] = [
      {
        expected: { needsAction: false, action: 'no_action' },
        predictions: [
          { needsAction: false, action: 'no_action' },
          { needsAction: false, action: 'no_action' },
        ],
      },
      {
        expected: { needsAction: true, action: 'quote_availability' },
        predictions: [
          { needsAction: true, action: 'billing' },
          { needsAction: true, action: 'quote_availability' },
        ],
      },
      {
        expected: { needsAction: true, action: 'billing' },
        predictions: [null, null],
      },
    ];

    const metrics = computeActionClassifierMetrics(cases);
    expect(metrics.needsActionAccuracy).toEqual({ correct: 2, total: 3, accuracy: 2 / 3 });
    expect(metrics.actionAccuracy).toEqual({ correct: 1, total: 3, accuracy: 1 / 3 });
    expect(metrics.confusionMatrix.no_action.no_action).toBe(1);
    expect(metrics.confusionMatrix.quote_availability.billing).toBe(1);
    expect(metrics.confusionMatrix.billing.unclassified).toBe(1);
    expect(metrics.perClass.quote_availability).toMatchObject({
      truePositive: 0,
      falseNegative: 1,
      precision: null,
      recall: 0,
    });
    expect(metrics.perClass.billing).toMatchObject({
      truePositive: 0,
      falsePositive: 1,
      falseNegative: 1,
      precision: 0,
      recall: 0,
    });
    expect(metrics.perClass.cancel.precision).toBeNull();
    expect(metrics.perClass.cancel.recall).toBeNull();
    expect(Object.keys(metrics.confusionMatrix.no_action)).toEqual([...ACTION_LABELS, 'unclassified']);
  });

  it('measures exact needsAction+action stability across repeated runs', () => {
    const metrics = computeActionClassifierMetrics([
      {
        expected: { needsAction: false, action: 'no_action' },
        predictions: [
          { needsAction: false, action: 'no_action' },
          { needsAction: false, action: 'no_action' },
        ],
      },
      {
        expected: { needsAction: true, action: 'amend' },
        predictions: [
          { needsAction: true, action: 'amend' },
          { needsAction: true, action: 'cancel' },
        ],
      },
      {
        expected: { needsAction: true, action: 'billing' },
        predictions: [null, null],
      },
    ]);

    expect(metrics.stability).toEqual({ identical: 1, classified: 2, rate: 0.5 });
  });

  it('does not count repeated failures as stable classifications', () => {
    const metrics = computeActionClassifierMetrics([
      {
        expected: { needsAction: false, action: 'no_action' },
        predictions: [null, null],
      },
    ]);

    expect(metrics.stability).toEqual({ identical: 0, classified: 0, rate: null });
  });

  it('omits stability when there is only one run', () => {
    expect(
      computeActionClassifierMetrics([
        {
          expected: { needsAction: false, action: 'no_action' },
          predictions: [{ needsAction: false, action: 'no_action' }],
        },
      ]).stability,
    ).toBeNull();
  });
});
