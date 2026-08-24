import {
  validateReconciledAnalystDecisions,
  type AnalysisItemV1,
  type AnalysisRisk,
  type AnalysisWorkflow,
  type ReconciledAnalystDecisionsV1,
  type ResponseEvidenceState,
} from './centurion-thread-corpus-analysis.js';
import { type PrivateThreadCorpusSnapshot } from '../../scripts/export-thread-corpus.js';

export const CENTURION_CORPUS_EVIDENCE_VERSION = 'centurion-corpus-evidence-v1';

declare const snapshotDigestBrand: unique symbol;
declare const snapshotAsOfBrand: unique symbol;

export type SnapshotDigest = string & {
  readonly [snapshotDigestBrand]: 'centurion-snapshot-digest';
};

export type SnapshotAsOf = string & {
  readonly [snapshotAsOfBrand]: 'centurion-snapshot-as-of';
};

export type EvidenceDisplayCell =
  | { state: 'observed'; count: number }
  | { state: 'suppressed'; minimumDisplayCount: 5 }
  | { state: 'insufficient_sample'; minimumDisplayCount: 5 };

export type NotMeasuredReason = 'causal_reply_or_authoritative_outcome_required';

export type EvidenceCategory =
  | AnalysisItemV1['artifactState']
  | ResponseEvidenceState
  | AnalysisWorkflow
  | AnalysisRisk;

export type EvidencePartition<T extends EvidenceCategory> =
  | { state: 'observed'; cells: Array<{ category: T; count: number }> }
  | { state: 'suppressed'; minimumDisplayCount: 5 }
  | { state: 'insufficient_sample'; minimumDisplayCount: 5 };

export type CenturionCorpusEvidenceReportV1 = {
  schemaVersion: typeof CENTURION_CORPUS_EVIDENCE_VERSION;
  snapshotDigest: SnapshotDigest;
  asOf: SnapshotAsOf;
  decisionDenominator: EvidenceDisplayCell;
  artifactAvailability: EvidencePartition<AnalysisItemV1['artifactState']>;
  responseEvidence: {
    itemStates: EvidencePartition<ResponseEvidenceState>;
    notMeasured: {
      state: 'not_measured';
      requires: NotMeasuredReason;
    };
  };
  workflowMix: EvidencePartition<AnalysisWorkflow>;
  riskCoverage: EvidencePartition<AnalysisRisk>;
  exclusions: { unscopedQuarantineExcluded: EvidenceDisplayCell };
  limitations: readonly [
    'source_integrity_content_hash_only',
    'smtp_accepted_not_causal_response',
    'offline_analysis_not_live_triage_impact',
  ];
};

const MINIMUM_DISPLAY_COUNT = 5 as const;
const ARTIFACT_STATES = [
  'complete',
  'partial',
  'unavailable',
  'not_applicable',
  'unknown',
] as const satisfies readonly AnalysisItemV1['artifactState'][];
const RESPONSE_EVIDENCE_STATES = [
  'smtp_accepted',
  'not_claimed',
  'not_applicable',
  'unknown',
] as const satisfies readonly ResponseEvidenceState[];
const ANALYSIS_WORKFLOWS = [
  'reservation_new',
  'reservation_change',
  'reservation_cancel',
  'group_or_event',
  'guest_service',
  'operations',
  'payment',
  'document',
  'security',
  'system_routine',
  'system_failure',
  'feedback',
  'unknown',
] as const satisfies readonly AnalysisWorkflow[];
const ANALYSIS_RISKS = [
  'none',
  'human_review',
  'failure',
  'payment',
  'policy',
  'cancellation_fee',
  'complaint',
  'security',
  'document',
  'vip_or_privacy',
] as const satisfies readonly AnalysisRisk[];
const LIMITATIONS = [
  'source_integrity_content_hash_only',
  'smtp_accepted_not_causal_response',
  'offline_analysis_not_live_triage_impact',
] as const;
const NOT_MEASURED_REASON: NotMeasuredReason = 'causal_reply_or_authoritative_outcome_required';

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isAggregateSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function asSnapshotDigest(value: string): SnapshotDigest {
  return value as SnapshotDigest;
}

function asSnapshotAsOf(value: string): SnapshotAsOf {
  return value as SnapshotAsOf;
}

function displayCell(denominator: number, value: number): EvidenceDisplayCell {
  if (denominator < MINIMUM_DISPLAY_COUNT) {
    return { state: 'insufficient_sample', minimumDisplayCount: MINIMUM_DISPLAY_COUNT };
  }
  if (value < MINIMUM_DISPLAY_COUNT) {
    return { state: 'suppressed', minimumDisplayCount: MINIMUM_DISPLAY_COUNT };
  }
  return { state: 'observed', count: value };
}

function partition<T extends EvidenceCategory>(
  denominator: number,
  categories: readonly T[],
  values: readonly T[],
): EvidencePartition<T> | null {
  if (denominator < MINIMUM_DISPLAY_COUNT) {
    return { state: 'insufficient_sample', minimumDisplayCount: MINIMUM_DISPLAY_COUNT };
  }
  if (values.length !== denominator) return null;

  const counts = new Map<T, number>();
  for (const value of values) {
    if (!categories.includes(value)) return null;
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
  }

  const cells = categories
    .map((category) => {
      const count = counts.get(category);
      return count === undefined || count === 0 ? null : { category, count };
    })
    .filter((cell): cell is { category: T; count: number } => cell !== null)
    .sort((left, right) => compareText(left.category, right.category));
  if (cells.length === 0 || cells.some((cell) => cell.count < MINIMUM_DISPLAY_COUNT)) {
    return { state: 'suppressed', minimumDisplayCount: MINIMUM_DISPLAY_COUNT };
  }

  return { state: 'observed', cells };
}

export function buildCenturionCorpusEvidenceReport(
  snapshot: PrivateThreadCorpusSnapshot,
  reconciled: ReconciledAnalystDecisionsV1,
): CenturionCorpusEvidenceReportV1 | null {
  try {
    const validatedReconciled = validateReconciledAnalystDecisions(snapshot, reconciled);
    if (!validatedReconciled) return null;

    const expectedItems = validatedReconciled.items;
    const manifestDenominator =
      snapshot.manifest.counts.logicalMessages + snapshot.manifest.counts.scopedQuarantine;
    if (
      !isAggregateSafeCount(manifestDenominator) ||
      !isAggregateSafeCount(expectedItems.length) ||
      expectedItems.length !== manifestDenominator ||
      !isAggregateSafeCount(snapshot.context.unscopedQuarantineExcluded)
    ) {
      return null;
    }

    const denominator = expectedItems.length;
    const artifactAvailability = partition(
      denominator,
      ARTIFACT_STATES,
      expectedItems.map((item) => item.artifactState),
    );
    const responseItemStates = partition(
      denominator,
      RESPONSE_EVIDENCE_STATES,
      expectedItems.map((item) => item.responseEvidenceState),
    );
    const workflowMix = partition(
      denominator,
      ANALYSIS_WORKFLOWS,
      validatedReconciled.decisions.map((decision) => decision.workflow),
    );
    const riskCoverage = partition(
      denominator,
      ANALYSIS_RISKS,
      validatedReconciled.decisions.map((decision) => decision.risk),
    );
    if (!artifactAvailability || !responseItemStates || !workflowMix || !riskCoverage) {
      return null;
    }

    return {
      schemaVersion: CENTURION_CORPUS_EVIDENCE_VERSION,
      snapshotDigest: asSnapshotDigest(validatedReconciled.snapshotDigest),
      asOf: asSnapshotAsOf(snapshot.context.asOf),
      decisionDenominator: displayCell(denominator, denominator),
      artifactAvailability,
      responseEvidence: {
        itemStates: responseItemStates,
        notMeasured: {
          state: 'not_measured',
          requires: NOT_MEASURED_REASON,
        },
      },
      workflowMix,
      riskCoverage,
      exclusions: {
        unscopedQuarantineExcluded: displayCell(
          denominator,
          snapshot.context.unscopedQuarantineExcluded,
        ),
      },
      limitations: LIMITATIONS,
    };
  } catch {
    return null;
  }
}
