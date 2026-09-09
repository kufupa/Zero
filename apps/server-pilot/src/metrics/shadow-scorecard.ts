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

export type ShadowAdmissionPopulationRow = {
  id: string;
  evaluationMode?: ShadowEvaluationMode;
  eligible: boolean;
  admissionStatus: 'eligible' | 'admitted' | 'skipped' | 'denied';
  /** True only when a sealed prediction is observable by the population cutoff. */
  hasSealedPrediction: boolean;
};

export type ShadowAdmissionPopulation = {
  availability: 'available' | 'unavailable';
  reason: 'no_admission_receipts' | 'not_loaded' | null;
  counts: {
    eligible: number | null;
    admitted: number | null;
    skipped: number | null;
    denied: number | null;
    pending: number | null;
  };
  provenance: {
    source: 'private_shadow_store';
    missingIsNotZero: true;
    evaluationMode: ShadowEvaluationMode;
    selectionClock: 'admission_created_at';
    windowStart: string | null;
    windowEnd: string | null;
    observationCutoff: string | null;
  };
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
  /** Operational admission evidence; separate from the sealed prediction population. */
  admissionPopulation: ShadowAdmissionPopulation;
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

function unavailableAdmissionPopulation(
  evaluationMode: ShadowEvaluationMode,
): ShadowAdmissionPopulation {
  return {
    availability: 'unavailable',
    reason: 'not_loaded',
    counts: {
      eligible: null,
      admitted: null,
      skipped: null,
      denied: null,
      pending: null,
    },
    provenance: {
      source: 'private_shadow_store',
      missingIsNotZero: true,
      evaluationMode,
      selectionClock: 'admission_created_at',
      windowStart: null,
      windowEnd: null,
      observationCutoff: null,
    },
  };
}

/**
 * Build the operational admission population independently from prediction
 * selection. An admitted receipt without a sealed prediction observable by
 * the cutoff is admission-pending; assessment pending is counted elsewhere.
 */
export function buildShadowAdmissionPopulation(input: {
  evaluationMode: ShadowEvaluationMode;
  admissions: readonly ShadowAdmissionPopulationRow[];
  windowStart?: string | null;
  windowEnd?: string | null;
  observationCutoff?: string | null;
}): ShadowAdmissionPopulation {
  assertMode(input.evaluationMode, input.admissions, 'admission');
  const counts = {
    eligible: input.admissions.filter((row) => row.eligible).length,
    admitted: input.admissions.filter((row) => row.admissionStatus === 'admitted').length,
    skipped: input.admissions.filter((row) => row.admissionStatus === 'skipped').length,
    denied: input.admissions.filter((row) => row.admissionStatus === 'denied').length,
    pending: input.admissions.filter(
      (row) => row.admissionStatus === 'admitted' && !row.hasSealedPrediction,
    ).length,
  };
  return {
    availability: 'available',
    reason: input.admissions.length === 0 ? 'no_admission_receipts' : null,
    counts,
    provenance: {
      source: 'private_shadow_store',
      missingIsNotZero: true,
      evaluationMode: input.evaluationMode,
      selectionClock: 'admission_created_at',
      windowStart: input.windowStart ?? null,
      windowEnd: input.windowEnd ?? null,
      observationCutoff: input.observationCutoff ?? null,
    },
  };
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
  admissionPopulation?: ShadowAdmissionPopulation;
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
    admissionPopulation:
      input.admissionPopulation ?? unavailableAdmissionPopulation(input.evaluationMode),
    provenance: {
      source: 'private_shadow_store',
      missingIsNotZero: true,
      evaluationMode: input.evaluationMode,
    },
  };
}
