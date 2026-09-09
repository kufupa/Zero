export type ShadowEvaluationMode = 'current_state' | 'historical_replay' | 'future_shadow';

export type ShadowPredictionScorecardRow = {
  id: string;
  /** Admission key; predictionId is present when a seal exists. */
  predictionId?: string;
  evaluationMode?: ShadowEvaluationMode;
  admissionStatus: 'eligible' | 'admitted' | 'skipped' | 'denied';
  predictionStatus: 'sealed' | 'unavailable' | 'failed' | 'pending';
};

export type ShadowLabelProvenance = {
  source: 'reviewer' | 'approved_reference' | 'independent_source';
  labelId: string;
  unique: boolean;
  bound: boolean;
};

export type ShadowAssessmentScorecardRow = {
  predictionId: string;
  revision?: number;
  createdAt?: Date | string;
  evaluationMode?: ShadowEvaluationMode;
  status:
    | 'pending'
    | 'matched'
    | 'late'
    | 'ambiguous'
    | 'unmatched'
    | 'unobserved'
    | 'unknown_coverage'
    | 'changed_state'
    | 'unscorable';
  labelProvenance: ShadowLabelProvenance | null;
  verdict: 'correct' | 'partial' | 'incorrect' | null;
};

export type ShadowScorecard = {
  schemaVersion: 'shadow-scorecard-v1';
  evaluationMode: ShadowEvaluationMode;
  counts: {
    eligible: number;
    admitted: number;
    sealed: number;
    unavailable: number;
    failed: number;
    skipped: number;
    denied: number;
    pending: number;
    matched: number;
    late: number;
    ambiguous: number;
    unmatched: number;
    unobserved: number;
    unknownCoverage: number;
    changedState: number;
    unscorable: number;
    labelled: number;
    scorable: number;
    correct: number;
    partial: number;
    incorrect: number;
  };
  quality: {
    availability: 'available' | 'unavailable';
    denominator: number | null;
    reason: 'label_provenance_unavailable' | 'no_assessments' | null;
    correctRate: number | null;
    usefulRate: number | null;
  };
  provenance: {
    source: 'private_shadow_store';
    missingIsNotZero: true;
    evaluationMode: ShadowEvaluationMode;
    selectionClock?: 'sealed_at';
    windowStart?: string | null;
    windowEnd?: string | null;
    observationCutoff?: string | null;
  };
};

function validLabel(label: ShadowLabelProvenance | null): label is ShadowLabelProvenance {
  return Boolean(label && label.labelId.trim() && label.unique === true && label.bound === true);
}

function assertMode(
  mode: ShadowEvaluationMode,
  rows: readonly { evaluationMode?: ShadowEvaluationMode }[],
  label: string,
): void {
  const mismatch = rows.find(
    (row) => row.evaluationMode !== undefined && row.evaluationMode !== mode,
  );
  if (mismatch) throw new Error(`${label} evaluation mode cannot be pooled`);
}

/**
 * Build the operator-facing scorecard from persisted rows. This is a pure
 * consumer: absent/ambiguous labels stay out of the quality numerator and are
 * reported through operational denominators instead of becoming zeroes.
 */
export function buildShadowScorecard(input: {
  evaluationMode: ShadowEvaluationMode;
  predictions: readonly ShadowPredictionScorecardRow[];
  assessments: readonly ShadowAssessmentScorecardRow[];
}): ShadowScorecard {
  assertMode(input.evaluationMode, input.predictions, 'prediction');
  assertMode(input.evaluationMode, input.assessments, 'assessment');
  const predictionIds = new Set(
    input.predictions.flatMap((row) => [row.id, ...(row.predictionId ? [row.predictionId] : [])]),
  );
  const latestByPrediction = new Map<string, ShadowAssessmentScorecardRow>();
  for (const row of input.assessments) {
    if (!predictionIds.has(row.predictionId)) continue;
    // Repository rows are append-only. Revision is authoritative, while the
    // input order remains a deterministic tie-breaker for legacy rows without
    // a revision projection.
    const current = latestByPrediction.get(row.predictionId);
    if (!current || (row.revision ?? 0) >= (current.revision ?? 0)) {
      latestByPrediction.set(row.predictionId, row);
    }
  }

  const counts: ShadowScorecard['counts'] = {
    eligible: input.predictions.length,
    admitted: input.predictions.filter((row) => row.admissionStatus === 'admitted').length,
    sealed: input.predictions.filter((row) => row.predictionStatus === 'sealed').length,
    unavailable: input.predictions.filter((row) => row.predictionStatus === 'unavailable').length,
    failed: input.predictions.filter((row) => row.predictionStatus === 'failed').length,
    skipped: input.predictions.filter((row) => row.admissionStatus === 'skipped').length,
    denied: input.predictions.filter((row) => row.admissionStatus === 'denied').length,
    pending: 0,
    matched: 0,
    late: 0,
    ambiguous: 0,
    unmatched: 0,
    unobserved: 0,
    unknownCoverage: 0,
    changedState: 0,
    unscorable: 0,
    labelled: 0,
    scorable: 0,
    correct: 0,
    partial: 0,
    incorrect: 0,
  };

  const statusCountKey: Partial<
    Record<ShadowAssessmentScorecardRow['status'], keyof ShadowScorecard['counts']>
  > = {
    pending: 'pending',
    matched: 'matched',
    late: 'late',
    ambiguous: 'ambiguous',
    unmatched: 'unmatched',
    unobserved: 'unobserved',
    unknown_coverage: 'unknownCoverage',
    changed_state: 'changedState',
    unscorable: 'unscorable',
  };
  for (const assessment of latestByPrediction.values()) {
    const statusKey = statusCountKey[assessment.status];
    if (statusKey) counts[statusKey] += 1;
    if (validLabel(assessment.labelProvenance)) {
      counts.labelled += 1;
      if (
        assessment.status === 'matched' &&
        (assessment.verdict === 'correct' ||
          assessment.verdict === 'partial' ||
          assessment.verdict === 'incorrect')
      ) {
        counts.scorable += 1;
        counts[assessment.verdict] += 1;
      }
    }
  }

  const qualityDenominator = counts.scorable;
  const qualityUnavailableReason =
    latestByPrediction.size === 0
      ? ('no_assessments' as const)
      : ('label_provenance_unavailable' as const);
  return {
    schemaVersion: 'shadow-scorecard-v1',
    evaluationMode: input.evaluationMode,
    counts,
    quality: {
      availability: qualityDenominator > 0 ? 'available' : 'unavailable',
      denominator: qualityDenominator > 0 ? qualityDenominator : null,
      reason: qualityDenominator > 0 ? null : qualityUnavailableReason,
      correctRate: qualityDenominator > 0 ? counts.correct / qualityDenominator : null,
      usefulRate:
        qualityDenominator > 0 ? (counts.correct + counts.partial) / qualityDenominator : null,
    },
    provenance: {
      source: 'private_shadow_store',
      missingIsNotZero: true,
      evaluationMode: input.evaluationMode,
    },
  };
}
