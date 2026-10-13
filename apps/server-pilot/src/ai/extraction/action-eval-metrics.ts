import { MAIL_ACTIONS, type MailAction } from './schema.js';

export const ACTION_LABELS = MAIL_ACTIONS;
export type ActionPrediction = { needsAction: boolean; action: MailAction };
export type ActionEvalCase = {
  expected: ActionPrediction;
  /** One item per repeat; null means the message failed to produce a usable classification. */
  predictions: Array<ActionPrediction | null>;
};

export type ActionAccuracy = { correct: number; total: number; accuracy: number | null };
export type ActionClassMetrics = {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number | null;
  recall: number | null;
};
export type ActionEvalMetrics = {
  needsActionAccuracy: ActionAccuracy;
  actionAccuracy: ActionAccuracy;
  confusionMatrix: Record<MailAction, Record<MailAction | 'unclassified', number>>;
  perClass: Record<MailAction, ActionClassMetrics>;
  stability: { identical: number; classified: number; rate: number | null } | null;
};

function emptyConfusionRow(): Record<MailAction | 'unclassified', number> {
  return Object.fromEntries([...ACTION_LABELS, 'unclassified'].map((action) => [action, 0])) as Record<
    MailAction | 'unclassified',
    number
  >;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Pure metric math; the first prediction is the scored run, all later ones only measure repeat stability. */
export function computeActionClassifierMetrics(cases: ActionEvalCase[]): ActionEvalMetrics {
  let binaryCorrect = 0;
  let actionCorrect = 0;
  const confusionMatrix = Object.fromEntries(
    ACTION_LABELS.map((actual) => [actual, emptyConfusionRow()]),
  ) as Record<MailAction, Record<MailAction | 'unclassified', number>>;
  const counts = Object.fromEntries(
    ACTION_LABELS.map((action) => [action, { truePositive: 0, falsePositive: 0, falseNegative: 0 }]),
  ) as Record<MailAction, Pick<ActionClassMetrics, 'truePositive' | 'falsePositive' | 'falseNegative'>>;

  for (const item of cases) {
    const prediction = item.predictions[0] ?? null;
    if (prediction?.needsAction === item.expected.needsAction) binaryCorrect += 1;
    const predictedAction = prediction?.action ?? 'unclassified';
    confusionMatrix[item.expected.action][predictedAction] += 1;
    if (prediction?.action === item.expected.action) actionCorrect += 1;
    for (const action of ACTION_LABELS) {
      if (item.expected.action === action && prediction?.action === action) {
        counts[action].truePositive += 1;
      } else if (item.expected.action !== action && prediction?.action === action) {
        counts[action].falsePositive += 1;
      } else if (item.expected.action === action && prediction?.action !== action) {
        counts[action].falseNegative += 1;
      }
    }
  }

  const perClass = Object.fromEntries(
    ACTION_LABELS.map((action) => {
      const count = counts[action];
      return [
        action,
        {
          ...count,
          precision: ratio(count.truePositive, count.truePositive + count.falsePositive),
          recall: ratio(count.truePositive, count.truePositive + count.falseNegative),
        },
      ];
    }),
  ) as Record<MailAction, ActionClassMetrics>;

  const repeatCount = Math.max(0, ...cases.map((item) => item.predictions.length));
  let stability: ActionEvalMetrics['stability'] = null;
  if (repeatCount > 1) {
    let identical = 0;
    const classified = cases.filter(
      (item) => item.predictions.length > 1 && item.predictions.every((prediction) => prediction !== null),
    );
    for (const item of classified) {
      const first = item.predictions[0]!;
      if (
        item.predictions.slice(1).every(
          (prediction) =>
            prediction!.needsAction === first.needsAction && prediction!.action === first.action,
        )
      ) {
        identical += 1;
      }
    }
    stability = { identical, classified: classified.length, rate: ratio(identical, classified.length) };
  }

  return {
    needsActionAccuracy: {
      correct: binaryCorrect,
      total: cases.length,
      accuracy: ratio(binaryCorrect, cases.length),
    },
    actionAccuracy: {
      correct: actionCorrect,
      total: cases.length,
      accuracy: ratio(actionCorrect, cases.length),
    },
    confusionMatrix,
    perClass,
    stability,
  };
}
