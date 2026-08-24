import {
  CENTURION_THREAD_CORPUS_ANALYSIS_VERSION,
  createAnalysisItems,
  preparePrivateAnalysis,
  type AnalysisItemV1,
  type AnalysisRisk,
  type AnalysisWorkflow,
  type AnalystDecisionV1,
  type ReconciledAnalystDecisionsV1,
  type ResponseEvidenceState,
} from './centurion-thread-corpus-analysis.js';
import {
  validatePrivateThreadCorpusSnapshot,
  type PrivateThreadCorpusSnapshot,
} from '../../scripts/export-thread-corpus.js';

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

type ValidatedReconciledInput = {
  snapshotId: string;
  snapshotDigest: SnapshotDigest;
  preparedManifestSha256: string;
  items: AnalysisItemV1[];
  decisions: AnalystDecisionV1[];
};

const MINIMUM_DISPLAY_COUNT = 5 as const;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const ANALYSIS_SOURCE_MEMBERSHIP = [
  'centurion_transport',
  'designated_reservationist_mailbox',
] as const;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isAggregateSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonZeroSha256Digest(value: unknown): value is SnapshotDigest {
  return (
    typeof value === 'string' &&
    SHA256_DIGEST.test(value) &&
    value !== '0000000000000000000000000000000000000000000000000000000000000000'
  );
}

function isOneOf<T extends string>(value: unknown, candidates: readonly T[]): value is T {
  return typeof value === 'string' && candidates.includes(value as T);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isSourceMembership(value: unknown): value is AnalysisItemV1['sourceMembership'] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= ANALYSIS_SOURCE_MEMBERSHIP.length &&
    value.every((source) => isOneOf(source, ANALYSIS_SOURCE_MEMBERSHIP)) &&
    value.every(
      (source, index) =>
        index === 0 || compareText(value[index - 1] as string, source as string) < 0,
    )
  );
}

function isAnalysisItem(value: unknown): value is AnalysisItemV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'schemaVersion',
      'analysisItemId',
      'unitType',
      'sourceMembership',
      'artifactState',
      'responseEvidenceState',
    ]) &&
    value.schemaVersion === CENTURION_THREAD_CORPUS_ANALYSIS_VERSION &&
    isNonZeroSha256Digest(value.analysisItemId) &&
    (value.unitType === 'logical_message' || value.unitType === 'quarantine') &&
    isSourceMembership(value.sourceMembership) &&
    isOneOf(value.artifactState, ARTIFACT_STATES) &&
    isOneOf(value.responseEvidenceState, RESPONSE_EVIDENCE_STATES)
  );
}

function isAnalystDecision(value: unknown): value is AnalystDecisionV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'schemaVersion',
      'analysisItemId',
      'workflow',
      'risk',
      'confidence',
      'attention',
    ]) &&
    value.schemaVersion === CENTURION_THREAD_CORPUS_ANALYSIS_VERSION &&
    isNonZeroSha256Digest(value.analysisItemId) &&
    isOneOf(value.workflow, ANALYSIS_WORKFLOWS) &&
    isOneOf(value.risk, ANALYSIS_RISKS) &&
    (value.confidence === 'low' || value.confidence === 'medium' || value.confidence === 'high') &&
    (value.attention === 'human_review' ||
      value.attention === 'routine' ||
      value.attention === 'unknown')
  );
}

function sameAnalysisItem(left: AnalysisItemV1, right: AnalysisItemV1): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.analysisItemId === right.analysisItemId &&
    left.unitType === right.unitType &&
    sameStrings(left.sourceMembership, right.sourceMembership) &&
    left.artifactState === right.artifactState &&
    left.responseEvidenceState === right.responseEvidenceState
  );
}

function validateReconciledInput(value: unknown): ValidatedReconciledInput | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'snapshotId',
      'snapshotDigest',
      'preparedManifestSha256',
      'items',
      'decisions',
    ]) ||
    typeof value.snapshotId !== 'string' ||
    !isNonZeroSha256Digest(value.snapshotDigest) ||
    !isNonZeroSha256Digest(value.preparedManifestSha256) ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.decisions) ||
    !value.items.every(isAnalysisItem) ||
    !value.decisions.every(isAnalystDecision)
  ) {
    return null;
  }

  return {
    snapshotId: value.snapshotId,
    snapshotDigest: value.snapshotDigest,
    preparedManifestSha256: value.preparedManifestSha256,
    items: value.items,
    decisions: value.decisions,
  };
}

function validatedDecisionMap(
  expectedItems: readonly AnalysisItemV1[],
  reconciled: ValidatedReconciledInput,
): Map<string, AnalystDecisionV1> | null {
  if (
    reconciled.items.length !== expectedItems.length ||
    reconciled.decisions.length !== expectedItems.length
  ) {
    return null;
  }

  const reconciledItemsById = new Map<string, AnalysisItemV1>();
  for (const item of reconciled.items) {
    if (reconciledItemsById.has(item.analysisItemId)) return null;
    reconciledItemsById.set(item.analysisItemId, item);
  }

  const decisionsByItemId = new Map<string, AnalystDecisionV1>();
  for (const decision of reconciled.decisions) {
    if (decisionsByItemId.has(decision.analysisItemId)) return null;
    decisionsByItemId.set(decision.analysisItemId, decision);
  }

  for (const expectedItem of expectedItems) {
    const reconciledItem = reconciledItemsById.get(expectedItem.analysisItemId);
    if (!reconciledItem || !sameAnalysisItem(expectedItem, reconciledItem)) return null;
    if (!decisionsByItemId.has(expectedItem.analysisItemId)) return null;
  }

  return decisionsByItemId;
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
    if (!isAggregateSafeCount(count)) return null;
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
    validatePrivateThreadCorpusSnapshot(snapshot);
    const validatedReconciled = validateReconciledInput(reconciled);
    if (!validatedReconciled || validatedReconciled.snapshotId !== snapshot.context.snapshotId) {
      return null;
    }

    const revalidatedPrepared = preparePrivateAnalysis(snapshot, {
      maxPacketBytes: 0,
      maxTotalPacketBytes: 0,
    });
    if (
      !revalidatedPrepared ||
      revalidatedPrepared.manifest.snapshotDigest !== validatedReconciled.snapshotDigest
    ) {
      return null;
    }

    const expectedItems = createAnalysisItems(snapshot);
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

    const decisionsByItemId = validatedDecisionMap(expectedItems, validatedReconciled);
    if (!decisionsByItemId) return null;

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
      expectedItems.map((item) => decisionsByItemId.get(item.analysisItemId)!.workflow),
    );
    const riskCoverage = partition(
      denominator,
      ANALYSIS_RISKS,
      expectedItems.map((item) => decisionsByItemId.get(item.analysisItemId)!.risk),
    );
    if (!artifactAvailability || !responseItemStates || !workflowMix || !riskCoverage) {
      return null;
    }

    return {
      schemaVersion: CENTURION_CORPUS_EVIDENCE_VERSION,
      snapshotDigest: asSnapshotDigest(revalidatedPrepared.manifest.snapshotDigest),
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
