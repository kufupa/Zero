import { createHash } from 'node:crypto';

export const CENTURION_THREAD_BUSINESS_INSIGHTS_SCHEMA =
  'centurion_thread_business_insights_v1' as const;
export const CENTURION_THREAD_BUSINESS_INSIGHTS_METRIC_DEFINITION_VERSION =
  'metric-definition-v2' as const;

const INSIGHT_METRICS = [
  'decision_readiness',
  'current_work_queue',
  'observed_service_timing',
  'conversation_outcomes',
  'operational_complexity',
  'automation_prerequisites',
  'revenue_metrics',
] as const;
const METRIC_AVAILABILITIES = [
  'available',
  'not_available',
  'not_evaluated',
] as const;
const CLAIM_STATUSES = ['fact', 'evidence_limited', 'hypothesis'] as const;
const CONFIDENCES = ['high', 'medium', 'low', 'not_available'] as const;
const IMPACT_CLASSES = [
  'commercial_follow_up_hypothesis',
  'guest_trust',
  'staff_time',
  'data_quality',
] as const;
const EVIDENCE_TIERS = [
  'persisted_reply',
  'quoted_reply',
  'participant_subject_only_correlation',
  'no_evidence',
  'mixed',
  'not_available',
] as const;
const SOURCE_EVIDENCE_TIERS = [
  'persisted_reply',
  'quoted_reply',
  'participant_subject_only_correlation',
  'no_evidence',
] as const;
const THREAD_STATES = [
  'resolved',
  'action_required',
  'customer_acknowledgement_or_confirmation',
  'automated_or_non_actionable',
  'needs_manual_adjudication',
] as const;
const LIMITATIONS = [
  'quoted_only_evidence',
  'coverage_limited',
  'missing_event_time',
  'weak_subject_participant_correlation',
  'duplicate_persisted_message',
  'missing_or_ambiguous_annotation',
  'ambiguous_reply_header',
  'malformed_reply_header',
  'source_coverage_missing',
  'source_coverage_incomplete',
  'quote_text_truncated',
  'unsupported_quote_like',
  'html_only_quote_coverage',
  'quote_parser_coverage_missing',
  'quote_parser_coverage_limited',
  'no_actionable_external_turn',
] as const;
const REASON_CODES = [
  'strict_new_reservation_pattern',
  'recognized_quote_acceptance',
  'recognized_booking_instruction',
  'recognized_customer_acknowledgement',
  'recognized_internal_handoff',
  'recognized_staff_response',
  'recognized_unrelated_follow_up',
  'recognized_automated_message',
  'quote_coverage_limited',
  'prompt_injection_like_content',
  'continuation_without_safe_outcome',
  'non_initial_external_turn',
  'unsupported_direction_or_identity',
  'unrecognized_external_turn',
  'cache_component_context_changed',
  'cache_rules_version_changed',
  'cache_source_changed',
  'cache_evidence_conflict',
  'cache_reused',
  'legacy_message_not_in_corpus',
] as const;
const CLASSIFICATIONS = [
  'new_reservation_request',
  'quote_acceptance',
  'booking_instruction',
  'customer_acknowledgement',
  'internal_handoff',
  'unrelated_follow_up',
  'automated_or_non_actionable',
  'ambiguous',
  'staff_response',
] as const;
const RESPONSE_GAP_STATUSES = ['observed', 'excluded', 'unknown'] as const;
const RESPONSE_GAP_REASONS = [
  'no_persisted_roster_response',
  'no_actionable_external_turn',
  'missing_event_time',
  'unrecognized_gap',
] as const;
const COVERAGE_STATUSES = ['complete', 'limited', 'missing'] as const;
const EVENT_TIME_QUALITIES = ['trustworthy', 'missing'] as const;
const READINESS_STATUSES = ['valid', 'not_available'] as const;
const RECOMMENDATION_CODES = [
  'review_action_queue',
  'review_manual_queue',
  'investigate_data_quality',
  'collect_authoritative_pms_data',
  'collect_attachment_or_document_data',
  'create_draft_evaluation_cohort',
  'no_action_available',
] as const;
const NEXT_HUMAN_CHECKS = [
  'review_latest_action',
  'verify_source_coverage',
  'verify_quote_context',
  'verify_identity_or_linkage',
  'verify_event_time',
  'verify_duplicate_or_ingest',
  'collect_authoritative_pms_data',
  'collect_attachment_or_document_data',
  'create_draft_evaluation_cohort',
  'review_pending_task3',
  'rerun_task3_after_review',
  'none',
] as const;
const EXAMPLE_SELECTION_REASONS = [
  'outlier',
  'aged_action',
  'ambiguity',
  'impact',
] as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const RUN_REF = /^run_[a-f0-9]{64}$/u;
const CASE_REF = /^case_[a-f0-9]{64}$/u;
const VERSION = /^[A-Za-z0-9._:-]{1,160}$/u;

export type CenturionThreadBusinessMetricSection =
  (typeof INSIGHT_METRICS)[number];
export type CenturionThreadBusinessMetricAvailability =
  (typeof METRIC_AVAILABILITIES)[number];
export type CenturionThreadBusinessClaimStatus =
  (typeof CLAIM_STATUSES)[number];
export type CenturionThreadBusinessConfidence = (typeof CONFIDENCES)[number];
export type CenturionThreadBusinessImpactClass =
  (typeof IMPACT_CLASSES)[number];
export type CenturionThreadBusinessEvidenceTier =
  (typeof EVIDENCE_TIERS)[number];
export type CenturionThreadBusinessSourceEvidenceTier =
  (typeof SOURCE_EVIDENCE_TIERS)[number];
export type CenturionThreadBusinessThreadState =
  (typeof THREAD_STATES)[number];
export type CenturionThreadBusinessLimitation =
  (typeof LIMITATIONS)[number];
export type CenturionThreadBusinessReasonCode = (typeof REASON_CODES)[number];
export type CenturionThreadBusinessClassification =
  (typeof CLASSIFICATIONS)[number];
export type CenturionThreadBusinessResponseGapStatus =
  (typeof RESPONSE_GAP_STATUSES)[number];
export type CenturionThreadBusinessResponseGapReason =
  (typeof RESPONSE_GAP_REASONS)[number];
export type CenturionThreadBusinessCoverageStatus =
  (typeof COVERAGE_STATUSES)[number];
export type CenturionThreadBusinessEventTimeQuality =
  (typeof EVENT_TIME_QUALITIES)[number];
export type CenturionThreadBusinessReadinessStatus =
  (typeof READINESS_STATUSES)[number];
export type CenturionThreadBusinessExampleSelectionReason =
  (typeof EXAMPLE_SELECTION_REASONS)[number];
export type CenturionThreadBusinessRecommendationCode =
  (typeof RECOMMENDATION_CODES)[number];
export type CenturionThreadBusinessNextHumanCheck =
  (typeof NEXT_HUMAN_CHECKS)[number];

export type CenturionThreadBusinessInsightsInput = {
  runRef: string;
  generatedAt: string;
  sourceDigests: readonly string[];
  snapshot: {
    eventCutoffs: readonly string[];
    ingestCutoffs: readonly string[];
    messageCount: number;
    componentCount: number;
    persistedThreadCount: number;
    parserExceptionCount: number;
    coverageExceptionCount: number;
  };
  versions: {
    classifierVersion: string;
    metricDefinitionVersion: typeof CENTURION_THREAD_BUSINESS_INSIGHTS_METRIC_DEFINITION_VERSION;
  };
  readiness: {
    status: CenturionThreadBusinessReadinessStatus;
    sourceCoverage: CenturionThreadBusinessCoverageStatus;
    cutoffsKnown: boolean;
    membershipReconciled: boolean;
    parserExceptionsAccounted: boolean;
    allComponentsClosed: boolean;
    pendingReview: boolean;
  };
  components: readonly CenturionThreadBusinessComponent[];
};

export type CenturionThreadBusinessComponent = {
  caseRef: string;
  finalState: CenturionThreadBusinessThreadState;
  classificationFinal: boolean;
  reasonCodes: readonly CenturionThreadBusinessReasonCode[];
  evidenceTier: CenturionThreadBusinessSourceEvidenceTier;
  limitations: readonly CenturionThreadBusinessLimitation[];
  coverageStatus: CenturionThreadBusinessCoverageStatus;
  responseGaps: readonly {
    status: CenturionThreadBusinessResponseGapStatus;
    durationMs: number | null;
    reason: CenturionThreadBusinessResponseGapReason | null;
  }[];
  classificationCounts: readonly {
    classification: CenturionThreadBusinessClassification;
    count: number;
  }[];
  participantCounts: {
    internal: number;
    external: number;
  };
  persistedThreadCount: number;
  turnCount: number;
  latestAction: {
    eventTime: string | null;
    quality: CenturionThreadBusinessEventTimeQuality;
  };
};

export type CenturionThreadBusinessInsightExample = {
  caseRef: string;
  selectionReason: CenturionThreadBusinessExampleSelectionReason;
};

export type CenturionThreadBusinessInsight = {
  metricId: (typeof INSIGHT_METRICS)[number];
  section: CenturionThreadBusinessMetricSection;
  availability: CenturionThreadBusinessMetricAvailability;
  claimStatus: CenturionThreadBusinessClaimStatus;
  impactClass: CenturionThreadBusinessImpactClass;
  evidenceTier: CenturionThreadBusinessEvidenceTier;
  confidence: CenturionThreadBusinessConfidence;
  decisionReadiness: 'valid' | 'not_available';
  recommendation: CenturionThreadBusinessRecommendationCode;
  nextHumanCheck: CenturionThreadBusinessNextHumanCheck;
  examples: readonly CenturionThreadBusinessInsightExample[];
};

export type CenturionThreadBusinessFacts = {
  schema: typeof CENTURION_THREAD_BUSINESS_INSIGHTS_SCHEMA;
  input: CenturionThreadBusinessInsightsInput;
  inputDigest: string;
  insights: readonly CenturionThreadBusinessInsight[];
};

export type CenturionThreadBusinessInsightsRendered = {
  markdown: string;
  selectedExamples: readonly {
    metricId: CenturionThreadBusinessInsight['metricId'];
    examples: readonly CenturionThreadBusinessInsightExample[];
  }[];
};

type ValidatedInput = {
  runRef: string;
  generatedAt: string;
  sourceDigests: readonly string[];
  snapshot: CenturionThreadBusinessInsightsInput['snapshot'];
  versions: CenturionThreadBusinessInsightsInput['versions'];
  readiness: CenturionThreadBusinessInsightsInput['readiness'];
  components: readonly ValidatedComponent[];
};

type ValidatedComponent = {
  caseRef: string;
  finalState: CenturionThreadBusinessComponent['finalState'];
  classificationFinal: boolean;
  reasonCodes: readonly (typeof REASON_CODES)[number][];
  evidenceTier: Exclude<CenturionThreadBusinessEvidenceTier, 'mixed' | 'not_available'>;
  limitations: readonly (typeof LIMITATIONS)[number][];
  coverageStatus: CenturionThreadBusinessComponent['coverageStatus'];
  responseGaps: readonly {
    status: (typeof RESPONSE_GAP_STATUSES)[number];
    durationMs: number | null;
    reason: (typeof RESPONSE_GAP_REASONS)[number] | null;
  }[];
  classificationCounts: readonly {
    classification: (typeof CLASSIFICATIONS)[number];
    count: number;
  }[];
  participantCounts: { internal: number; external: number };
  persistedThreadCount: number;
  turnCount: number;
  latestAction: {
    eventTime: string | null;
    quality: (typeof EVENT_TIME_QUALITIES)[number];
  };
};

type Age = {
  bucket: 'under_4h' | 'four_to_24h' | 'one_to_three_days' | 'over_three_days' | 'unknown';
  milliseconds: number | null;
};

const LIMITATION_SEVERITY: Record<(typeof LIMITATIONS)[number], number> = {
  source_coverage_missing: 100,
  source_coverage_incomplete: 95,
  coverage_limited: 90,
  missing_or_ambiguous_annotation: 85,
  weak_subject_participant_correlation: 80,
  ambiguous_reply_header: 75,
  malformed_reply_header: 70,
  missing_event_time: 65,
  duplicate_persisted_message: 60,
  quote_parser_coverage_missing: 55,
  quote_parser_coverage_limited: 50,
  html_only_quote_coverage: 45,
  unsupported_quote_like: 40,
  quote_text_truncated: 35,
  quoted_only_evidence: 30,
  no_actionable_external_turn: 20,
};

const REASON_SEVERITY: Record<(typeof REASON_CODES)[number], number> = {
  prompt_injection_like_content: 100,
  cache_evidence_conflict: 95,
  continuation_without_safe_outcome: 90,
  unrecognized_external_turn: 85,
  unsupported_direction_or_identity: 80,
  quote_coverage_limited: 75,
  cache_component_context_changed: 70,
  cache_rules_version_changed: 65,
  cache_source_changed: 60,
  legacy_message_not_in_corpus: 55,
  non_initial_external_turn: 50,
  strict_new_reservation_pattern: 45,
  recognized_booking_instruction: 40,
  recognized_quote_acceptance: 35,
  recognized_customer_acknowledgement: 30,
  recognized_internal_handoff: 25,
  recognized_staff_response: 20,
  recognized_unrelated_follow_up: 15,
  recognized_automated_message: 10,
  cache_reused: 5,
};

const RECOMMENDATION_COPY: Record<
  CenturionThreadBusinessRecommendationCode,
  string
> = {
  review_action_queue: 'Review current evidence-grounded action queue.',
  review_manual_queue: 'Review bounded manual-adjudication queue.',
  investigate_data_quality: 'Investigate bounded coverage or identity limitation.',
  collect_authoritative_pms_data:
    'Collect authoritative PMS, folio, or availability evidence.',
  collect_attachment_or_document_data:
    'Collect approved attachment or document metadata.',
  create_draft_evaluation_cohort:
    'Create human-adjudicated draft evaluation cohort.',
  no_action_available: 'No additional action code is available from this snapshot.',
};

const SOURCE_COVERAGE_LIMITATIONS = new Set([
  'coverage_limited',
  'source_coverage_missing',
  'source_coverage_incomplete',
]);

const NEXT_HUMAN_CHECK_COPY: Record<CenturionThreadBusinessNextHumanCheck, string> = {
  review_latest_action: 'Review latest actionable evidence.',
  verify_source_coverage: 'Verify source coverage and cutoffs.',
  verify_quote_context: 'Verify bounded quote context.',
  verify_identity_or_linkage: 'Verify identity or linkage evidence.',
  verify_event_time: 'Verify event-time evidence.',
  verify_duplicate_or_ingest: 'Verify duplicate or ingest evidence.',
  collect_authoritative_pms_data:
    'Collect authoritative PMS, folio, or availability data.',
  collect_attachment_or_document_data:
    'Collect approved attachment or document metadata.',
  create_draft_evaluation_cohort:
    'Create human-adjudicated draft evaluation cohort.',
  review_pending_task3:
    'Review pending Task 3 evidence and record a bounded decision.',
  rerun_task3_after_review:
    'Rerun Task 3 after recording the bounded review decision.',
  none: 'No additional bounded human check is encoded.',
};

function fail(code: string): never {
  throw new Error(code);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strictRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  }
  return value;
}

function factsRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) fail('CENTURION_THREAD_BUSINESS_INSIGHTS_FACTS_INVALID');
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_FACTS_INVALID');
  }
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  }
  return value;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  }
  return value as number;
}

function nonNegativeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  }
  return value;
}

function oneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  }
  return value as T[number];
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].sort(compareText);
}

function timestamp(value: unknown): string {
  const raw = requiredString(value);
  const parsed = new Date(raw);
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(raw) || Number.isNaN(parsed.getTime())) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  }
  return parsed.toISOString();
}

function optionalTimestamp(value: unknown, quality: 'trustworthy' | 'missing'): string | null {
  if (quality === 'missing') {
    if (value !== null) fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
    return null;
  }
  return timestamp(value);
}

function caseReference(value: unknown): string {
  const reference = requiredString(value);
  if (!CASE_REF.test(reference)) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_REFERENCE_INVALID');
  }
  return reference;
}

function validateStringArray(
  value: unknown,
  validate: (item: unknown) => string,
): readonly string[] {
  if (!Array.isArray(value)) fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  return uniqueSorted(value.map(validate));
}

function validateComponent(value: unknown): ValidatedComponent {
  const record = strictRecord(value, [
    'caseRef',
    'finalState',
    'classificationFinal',
    'reasonCodes',
    'evidenceTier',
    'limitations',
    'coverageStatus',
    'responseGaps',
    'classificationCounts',
    'participantCounts',
    'persistedThreadCount',
    'turnCount',
    'latestAction',
  ]);
  const reasonCodes = validateStringArray(record.reasonCodes, (item) =>
    oneOf(item, REASON_CODES),
  ) as readonly (typeof REASON_CODES)[number][];
  if (reasonCodes.length === 0) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  }
  const limitations = validateStringArray(record.limitations, (item) =>
    oneOf(item, LIMITATIONS),
  ) as readonly (typeof LIMITATIONS)[number][];
  if (!Array.isArray(record.responseGaps)) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  }
  const responseGaps = record.responseGaps.map((gap) => {
    const gapRecord = strictRecord(gap, ['status', 'durationMs', 'reason']);
    const status = oneOf(gapRecord.status, RESPONSE_GAP_STATUSES);
    const reason =
      gapRecord.reason === null
        ? null
        : oneOf(gapRecord.reason, RESPONSE_GAP_REASONS);
    const durationMs =
      gapRecord.durationMs === null
        ? null
        : nonNegativeNumber(gapRecord.durationMs);
    if ((status === 'observed') !== (durationMs !== null)) {
      fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
    }
    if ((status === 'observed') !== (reason === null)) {
      fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
    }
    if (
      status === 'excluded' &&
      reason !== 'no_persisted_roster_response' &&
      reason !== 'no_actionable_external_turn'
    ) {
      fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
    }
    if (
      status === 'unknown' &&
      reason !== 'missing_event_time' &&
      reason !== 'unrecognized_gap'
    ) {
      fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
    }
    return { status, durationMs, reason };
  });
  if (!Array.isArray(record.classificationCounts)) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  }
  const classificationSeen = new Set<string>();
  const classificationCounts = record.classificationCounts
    .map((entry) => {
      const entryRecord = strictRecord(entry, ['classification', 'count']);
      const classification = oneOf(entryRecord.classification, CLASSIFICATIONS);
      if (classificationSeen.has(classification)) {
        fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
      }
      classificationSeen.add(classification);
      const count = nonNegativeInteger(entryRecord.count);
      if (count === 0) fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
      return { classification, count };
    })
    .sort((left, right) => compareText(left.classification, right.classification));
  const classificationFinal = requiredBoolean(record.classificationFinal);
  const turnCount = nonNegativeInteger(record.turnCount);
  const classificationCount = classificationCounts.reduce(
    (total, entry) => total + entry.count,
    0,
  );
  if (
    classificationCount > turnCount ||
    (classificationFinal && classificationCount !== turnCount)
  ) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  }
  const participantCounts = strictRecord(record.participantCounts, [
    'internal',
    'external',
  ]);
  const latestAction = strictRecord(record.latestAction, ['eventTime', 'quality']);
  const quality = oneOf(latestAction.quality, EVENT_TIME_QUALITIES);
  return {
    caseRef: caseReference(record.caseRef),
    finalState: oneOf(record.finalState, THREAD_STATES),
    classificationFinal,
    reasonCodes,
    evidenceTier: oneOf(record.evidenceTier, SOURCE_EVIDENCE_TIERS),
    limitations,
    coverageStatus: oneOf(record.coverageStatus, COVERAGE_STATUSES),
    responseGaps,
    classificationCounts,
    participantCounts: {
      internal: nonNegativeInteger(participantCounts.internal),
      external: nonNegativeInteger(participantCounts.external),
    },
    persistedThreadCount: nonNegativeInteger(record.persistedThreadCount),
    turnCount,
    latestAction: {
      quality,
      eventTime: optionalTimestamp(latestAction.eventTime, quality),
    },
  };
}

function validateInput(value: unknown): ValidatedInput {
  const record = strictRecord(value, [
    'runRef',
    'generatedAt',
    'sourceDigests',
    'snapshot',
    'versions',
    'readiness',
    'components',
  ]);
  const runRef = requiredString(record.runRef);
  if (!RUN_REF.test(runRef)) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_REFERENCE_INVALID');
  }
  const sourceDigests = validateStringArray(record.sourceDigests, (item) => {
    const digest = requiredString(item);
    if (!SHA256.test(digest)) {
      fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
    }
    return digest;
  });
  if (sourceDigests.length === 0) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  }
  const snapshotRecord = strictRecord(record.snapshot, [
    'eventCutoffs',
    'ingestCutoffs',
    'messageCount',
    'componentCount',
    'persistedThreadCount',
    'parserExceptionCount',
    'coverageExceptionCount',
  ]);
  const eventCutoffs = validateStringArray(snapshotRecord.eventCutoffs, timestamp);
  const ingestCutoffs = validateStringArray(snapshotRecord.ingestCutoffs, timestamp);
  if (eventCutoffs.length === 0 || ingestCutoffs.length === 0) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  }
  const snapshot = {
    eventCutoffs,
    ingestCutoffs,
    messageCount: nonNegativeInteger(snapshotRecord.messageCount),
    componentCount: nonNegativeInteger(snapshotRecord.componentCount),
    persistedThreadCount: nonNegativeInteger(snapshotRecord.persistedThreadCount),
    parserExceptionCount: nonNegativeInteger(snapshotRecord.parserExceptionCount),
    coverageExceptionCount: nonNegativeInteger(snapshotRecord.coverageExceptionCount),
  };
  const versionsRecord = strictRecord(record.versions, [
    'classifierVersion',
    'metricDefinitionVersion',
  ]);
  const metricDefinitionVersion = requiredString(versionsRecord.metricDefinitionVersion);
  if (
    metricDefinitionVersion !==
    CENTURION_THREAD_BUSINESS_INSIGHTS_METRIC_DEFINITION_VERSION
  ) {
    fail(
      'CENTURION_THREAD_BUSINESS_INSIGHTS_UNSUPPORTED_METRIC_DEFINITION_VERSION',
    );
  }
  const classifierVersion = requiredString(versionsRecord.classifierVersion);
  if (!VERSION.test(classifierVersion) || !VERSION.test(metricDefinitionVersion)) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  }
  const readinessRecord = strictRecord(record.readiness, [
    'status',
    'sourceCoverage',
    'cutoffsKnown',
    'membershipReconciled',
    'parserExceptionsAccounted',
    'allComponentsClosed',
    'pendingReview',
  ]);
  const readiness = {
    status: oneOf(readinessRecord.status, READINESS_STATUSES),
    sourceCoverage: oneOf(readinessRecord.sourceCoverage, COVERAGE_STATUSES),
    cutoffsKnown: requiredBoolean(readinessRecord.cutoffsKnown),
    membershipReconciled: requiredBoolean(readinessRecord.membershipReconciled),
    parserExceptionsAccounted: requiredBoolean(
      readinessRecord.parserExceptionsAccounted,
    ),
    allComponentsClosed: requiredBoolean(readinessRecord.allComponentsClosed),
    pendingReview: requiredBoolean(readinessRecord.pendingReview),
  };
  if (!Array.isArray(record.components)) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  }
  const components = record.components.map(validateComponent).sort((left, right) =>
    compareText(left.caseRef, right.caseRef),
  );
  if (
    new Set(components.map((component) => component.caseRef)).size !==
    components.length
  ) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_REFERENCE_INVALID');
  }
  if (snapshot.componentCount !== components.length) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  }
  if (
    snapshot.messageCount !==
    components.reduce((total, component) => total + component.turnCount, 0)
  ) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  }
  if (
    snapshot.persistedThreadCount !==
    components.reduce(
      (total, component) => total + component.persistedThreadCount,
      0,
    )
  ) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  }
  const valid =
    readiness.sourceCoverage === 'complete' &&
    readiness.cutoffsKnown &&
    readiness.membershipReconciled &&
    readiness.parserExceptionsAccounted &&
    readiness.allComponentsClosed &&
    !readiness.pendingReview &&
    components.every(
      (component) =>
        component.coverageStatus === 'complete' &&
        !component.limitations.some((limitation) =>
          SOURCE_COVERAGE_LIMITATIONS.has(limitation),
        ),
    );
  if ((readiness.status === 'valid') !== valid) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
  }
  return {
    runRef,
    generatedAt: timestamp(record.generatedAt),
    sourceDigests,
    snapshot,
    versions: { classifierVersion, metricDefinitionVersion },
    readiness,
    components,
  };
}

function factsInputDigest(input: ValidatedInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function countClassifications(
  components: readonly ValidatedComponent[],
  classification: (typeof CLASSIFICATIONS)[number],
): number {
  return components.reduce(
    (total, component) =>
      total +
      (component.classificationCounts.find(
        (entry) => entry.classification === classification,
      )?.count ?? 0),
    0,
  );
}

function primaryLimitation(
  component: ValidatedComponent,
): (typeof LIMITATIONS)[number] | 'none' {
  return (
    [...component.limitations].sort(
      (left, right) =>
        LIMITATION_SEVERITY[right] - LIMITATION_SEVERITY[left] ||
        compareText(left, right),
    )[0] ?? 'none'
  );
}

function primaryReason(component: ValidatedComponent): (typeof REASON_CODES)[number] {
  return [...component.reasonCodes].sort(
    (left, right) =>
      REASON_SEVERITY[right] - REASON_SEVERITY[left] || compareText(left, right),
  )[0]!;
}

function nextHumanCheck(
  component: ValidatedComponent,
): CenturionThreadBusinessNextHumanCheck {
  const limitations = new Set(component.limitations);
  if (
    component.coverageStatus !== 'complete' ||
    limitations.has('source_coverage_missing') ||
    limitations.has('source_coverage_incomplete') ||
    limitations.has('coverage_limited')
  ) {
    return 'verify_source_coverage';
  }
  if (limitations.has('missing_event_time') || component.latestAction.quality === 'missing') {
    return 'verify_event_time';
  }
  if (
    limitations.has('weak_subject_participant_correlation') ||
    limitations.has('ambiguous_reply_header') ||
    limitations.has('malformed_reply_header')
  ) {
    return 'verify_identity_or_linkage';
  }
  if (
    limitations.has('quoted_only_evidence') ||
    limitations.has('quote_text_truncated') ||
    limitations.has('unsupported_quote_like') ||
    limitations.has('html_only_quote_coverage') ||
    limitations.has('quote_parser_coverage_missing') ||
    limitations.has('quote_parser_coverage_limited')
  ) {
    return 'verify_quote_context';
  }
  if (limitations.has('duplicate_persisted_message')) {
    return 'verify_duplicate_or_ingest';
  }
  if (component.finalState === 'action_required') {
    return 'review_latest_action';
  }
  return 'none';
}

function handoffState(
  component: ValidatedComponent,
):
  | 'no_handoff_observed'
  | 'internal_handoff_observed'
  | 'handoff_evidence_limited' {
  const count =
    component.classificationCounts.find(
      (entry) => entry.classification === 'internal_handoff',
    )?.count ?? 0;
  if (count === 0) return 'no_handoff_observed';
  return component.evidenceTier === 'persisted_reply'
    ? 'internal_handoff_observed'
    : 'handoff_evidence_limited';
}

function ageFor(component: ValidatedComponent, generatedAt: string): Age {
  if (
    component.latestAction.quality !== 'trustworthy' ||
    component.latestAction.eventTime === null
  ) {
    return { bucket: 'unknown', milliseconds: null };
  }
  const age = new Date(generatedAt).getTime() - new Date(component.latestAction.eventTime).getTime();
  if (!Number.isFinite(age) || age < 0) {
    return { bucket: 'unknown', milliseconds: null };
  }
  if (age < 4 * 60 * 60 * 1_000) {
    return { bucket: 'under_4h', milliseconds: age };
  }
  if (age < 24 * 60 * 60 * 1_000) {
    return { bucket: 'four_to_24h', milliseconds: age };
  }
  if (age <= 3 * 24 * 60 * 60 * 1_000) {
    return { bucket: 'one_to_three_days', milliseconds: age };
  }
  return { bucket: 'over_three_days', milliseconds: age };
}

function aggregateEvidenceTier(
  components: readonly ValidatedComponent[],
): CenturionThreadBusinessEvidenceTier {
  if (components.length === 0) return 'not_available';
  const tiers = uniqueSorted(components.map((component) => component.evidenceTier));
  return tiers.length === 1 ? tiers[0]! : 'mixed';
}

function confidenceFor(input: {
  readiness: 'valid' | 'not_available';
  claimStatus: CenturionThreadBusinessClaimStatus;
  evidenceTier: CenturionThreadBusinessEvidenceTier;
  examples: readonly ValidatedComponent[];
}): CenturionThreadBusinessConfidence {
  if (input.readiness !== 'valid') return 'not_available';
  if (input.claimStatus === 'hypothesis' || input.claimStatus === 'evidence_limited') {
    return 'low';
  }
  if (
    input.evidenceTier === 'persisted_reply' &&
    input.examples.length > 0 &&
    input.examples.every((component) => component.coverageStatus === 'complete')
  ) {
    return 'high';
  }
  if (
    input.evidenceTier === 'quoted_reply' ||
    input.evidenceTier === 'participant_subject_only_correlation' ||
    input.evidenceTier === 'mixed'
  ) {
    return 'medium';
  }
  return 'low';
}

function selectExamples(input: {
  components: readonly ValidatedComponent[];
  selectionReason: CenturionThreadBusinessExampleSelectionReason;
  compare: (left: ValidatedComponent, right: ValidatedComponent) => number;
}): readonly CenturionThreadBusinessInsightExample[] {
  return [...input.components]
    .sort((left, right) => input.compare(left, right) || compareText(left.caseRef, right.caseRef))
    .slice(0, 3)
    .map((component) => ({
      caseRef: component.caseRef,
      selectionReason: input.selectionReason,
    }));
}

function queueRecommendation(
  components: readonly ValidatedComponent[],
): CenturionThreadBusinessRecommendationCode {
  if (components.some((component) => component.finalState === 'action_required')) {
    return 'review_action_queue';
  }
  if (
    components.some(
      (component) => component.finalState === 'needs_manual_adjudication',
    )
  ) {
    return 'review_manual_queue';
  }
  return 'no_action_available';
}

function queueNextHumanCheck(
  components: readonly ValidatedComponent[],
): CenturionThreadBusinessNextHumanCheck {
  return (
    components
      .map(nextHumanCheck)
      .sort(compareText)[0] ?? 'none'
  );
}

function buildInsights(
  input: ValidatedInput,
): readonly CenturionThreadBusinessInsight[] {
  const readiness = input.readiness.status;
  const pendingReview = input.readiness.pendingReview;
  const unavailableRecommendation: CenturionThreadBusinessRecommendationCode =
    pendingReview ? 'review_manual_queue' : 'investigate_data_quality';
  const unavailableCheck: CenturionThreadBusinessNextHumanCheck = pendingReview
    ? 'review_pending_task3'
    : 'verify_source_coverage';
  const allEvidence = aggregateEvidenceTier(input.components);
  const queueComponents = input.components.filter(
    (component) =>
      component.finalState === 'action_required' ||
      component.finalState === 'needs_manual_adjudication',
  );
  const queueExamples =
    readiness === 'valid'
      ? selectExamples({
          components: queueComponents,
          selectionReason: 'aged_action',
          compare: (left, right) => {
            const leftAge = ageFor(left, input.generatedAt).milliseconds ?? -1;
            const rightAge = ageFor(right, input.generatedAt).milliseconds ?? -1;
            if (leftAge !== rightAge) return rightAge - leftAge;
            if (left.finalState !== right.finalState) {
              return left.finalState === 'action_required' ? -1 : 1;
            }
            return 0;
          },
        })
      : [];
  const observedComponents = input.components.filter((component) =>
    component.responseGaps.some((gap) => gap.status === 'observed'),
  );
  const timingExamples =
    readiness === 'valid'
      ? selectExamples({
          components: observedComponents,
          selectionReason: 'outlier',
          compare: (left, right) => {
            const leftDuration = Math.max(
              -1,
              ...left.responseGaps.map((gap) => gap.durationMs ?? -1),
            );
            const rightDuration = Math.max(
              -1,
              ...right.responseGaps.map((gap) => gap.durationMs ?? -1),
            );
            return rightDuration - leftDuration;
          },
        })
      : [];
  const complexityExamples =
    readiness === 'valid'
      ? selectExamples({
          components: input.components,
          selectionReason: 'impact',
          compare: (left, right) =>
            right.turnCount - left.turnCount ||
            right.persistedThreadCount - left.persistedThreadCount,
        })
      : [];
  const dataQualityComponents = input.components.filter(
    (component) =>
      component.coverageStatus !== 'complete' || component.limitations.length > 0,
  );
  const classificationsComplete = input.components.every(
    (component) =>
      component.classificationFinal && component.classificationCounts.length > 0,
  );
  const automationExamples =
    readiness === 'valid'
      ? selectExamples({
          components: dataQualityComponents,
          selectionReason: 'ambiguity',
          compare: (left, right) =>
            (LIMITATION_SEVERITY[
              primaryLimitation(right) as (typeof LIMITATIONS)[number]
            ] ?? 0) -
              (LIMITATION_SEVERITY[
                primaryLimitation(left) as (typeof LIMITATIONS)[number]
              ] ?? 0) ||
            right.limitations.length - left.limitations.length,
        })
      : [];
  const conversationExamples =
    readiness === 'valid' && classificationsComplete
      ? selectExamples({
          components: input.components.filter(
            (component) => component.classificationCounts.length > 0,
          ),
          selectionReason: 'impact',
          compare: (left, right) =>
            Number(left.finalState === 'action_required') * -1 +
            Number(right.finalState === 'action_required'),
        })
      : [];
  const noExamples: readonly CenturionThreadBusinessInsightExample[] = [];
  const create = (inputValue: {
    metricId: (typeof INSIGHT_METRICS)[number];
    section: CenturionThreadBusinessMetricSection;
    availability: CenturionThreadBusinessMetricAvailability;
    claimStatus: CenturionThreadBusinessClaimStatus;
    impactClass: CenturionThreadBusinessImpactClass;
    evidenceTier: CenturionThreadBusinessEvidenceTier;
    recommendation: CenturionThreadBusinessRecommendationCode;
    nextHumanCheck: CenturionThreadBusinessNextHumanCheck;
    examples: readonly CenturionThreadBusinessInsightExample[];
    confidenceComponents: readonly ValidatedComponent[];
  }): CenturionThreadBusinessInsight => ({
    metricId: inputValue.metricId,
    section: inputValue.section,
    availability: inputValue.availability,
    claimStatus: inputValue.claimStatus,
    impactClass: inputValue.impactClass,
    evidenceTier: inputValue.evidenceTier,
    confidence: confidenceFor({
      readiness,
      claimStatus: inputValue.claimStatus,
      evidenceTier: inputValue.evidenceTier,
      examples: inputValue.confidenceComponents,
    }),
    decisionReadiness: readiness,
    recommendation: inputValue.recommendation,
    nextHumanCheck: inputValue.nextHumanCheck,
    examples: inputValue.availability === 'available' ? inputValue.examples : noExamples,
  });
  return [
    create({
      metricId: 'decision_readiness',
      section: 'decision_readiness',
      availability: readiness === 'valid' ? 'available' : 'not_available',
      claimStatus: readiness === 'valid' ? 'fact' : 'evidence_limited',
      impactClass: 'data_quality',
      evidenceTier: readiness === 'valid' ? allEvidence : 'not_available',
      recommendation:
        readiness === 'valid' ? 'no_action_available' : unavailableRecommendation,
      nextHumanCheck:
        readiness === 'valid' ? 'none' : unavailableCheck,
      examples: noExamples,
      confidenceComponents: input.components,
    }),
    create({
      metricId: 'current_work_queue',
      section: 'current_work_queue',
      availability: readiness === 'valid' ? 'available' : 'not_available',
      claimStatus: readiness === 'valid' ? 'fact' : 'evidence_limited',
      impactClass: 'guest_trust',
      evidenceTier: readiness === 'valid' ? aggregateEvidenceTier(queueComponents) : 'not_available',
      recommendation:
        readiness === 'valid'
          ? queueRecommendation(queueComponents)
          : unavailableRecommendation,
      nextHumanCheck:
        readiness === 'valid'
          ? queueNextHumanCheck(queueComponents)
          : unavailableCheck,
      examples: queueExamples,
      confidenceComponents: queueComponents,
    }),
    create({
      metricId: 'observed_service_timing',
      section: 'observed_service_timing',
      availability: readiness === 'valid' ? 'available' : 'not_available',
      claimStatus: readiness === 'valid' ? 'fact' : 'evidence_limited',
      impactClass: 'staff_time',
      evidenceTier: readiness === 'valid' ? aggregateEvidenceTier(observedComponents) : 'not_available',
      recommendation:
        readiness === 'valid' ? 'no_action_available' : unavailableRecommendation,
      nextHumanCheck:
        readiness === 'valid' ? 'none' : unavailableCheck,
      examples: timingExamples,
      confidenceComponents: observedComponents,
    }),
    create({
      metricId: 'conversation_outcomes',
      section: 'conversation_outcomes',
      availability:
        readiness === 'valid' && classificationsComplete
          ? 'available'
          : 'not_available',
      claimStatus:
        readiness === 'valid' && classificationsComplete
          ? 'fact'
          : 'evidence_limited',
      impactClass: 'guest_trust',
      evidenceTier:
        readiness === 'valid' && classificationsComplete
          ? allEvidence
          : 'not_available',
      recommendation:
        readiness === 'valid' && classificationsComplete
          ? 'no_action_available'
          : unavailableRecommendation,
      nextHumanCheck:
        readiness === 'valid' && classificationsComplete
          ? 'none'
          : pendingReview
            ? 'review_pending_task3'
            : 'verify_identity_or_linkage',
      examples: conversationExamples,
      confidenceComponents: input.components,
    }),
    create({
      metricId: 'operational_complexity',
      section: 'operational_complexity',
      availability: readiness === 'valid' ? 'available' : 'not_available',
      claimStatus: readiness === 'valid' ? 'fact' : 'evidence_limited',
      impactClass: 'staff_time',
      evidenceTier: readiness === 'valid' ? allEvidence : 'not_available',
      recommendation:
        readiness === 'valid' ? 'no_action_available' : unavailableRecommendation,
      nextHumanCheck:
        readiness === 'valid' ? 'none' : unavailableCheck,
      examples: complexityExamples,
      confidenceComponents: input.components,
    }),
    create({
      metricId: 'automation_prerequisites',
      section: 'automation_prerequisites',
      availability: readiness === 'valid' ? 'available' : 'not_available',
      claimStatus:
        readiness === 'valid' && dataQualityComponents.length === 0
          ? 'fact'
          : 'evidence_limited',
      impactClass: 'data_quality',
      evidenceTier: readiness === 'valid' ? allEvidence : 'not_available',
      recommendation:
        readiness === 'valid' && dataQualityComponents.length === 0
          ? 'no_action_available'
          : unavailableRecommendation,
      nextHumanCheck:
        readiness === 'valid' && dataQualityComponents.length === 0
          ? 'none'
          : unavailableCheck,
      examples: automationExamples,
      confidenceComponents: dataQualityComponents,
    }),
    create({
      metricId: 'revenue_metrics',
      section: 'revenue_metrics',
      availability: 'not_available',
      claimStatus:
        readiness === 'valid' && queueComponents.length > 0
          ? 'hypothesis'
          : 'evidence_limited',
      impactClass: 'commercial_follow_up_hypothesis',
      evidenceTier: 'not_available',
      recommendation: pendingReview
        ? 'review_manual_queue'
        : 'collect_authoritative_pms_data',
      nextHumanCheck: pendingReview
        ? 'rerun_task3_after_review'
        : 'collect_authoritative_pms_data',
      examples: noExamples,
      confidenceComponents: [],
    }),
  ];
}

export function buildCenturionThreadBusinessFacts(
  input: CenturionThreadBusinessInsightsInput,
): CenturionThreadBusinessFacts {
  const validated = validateInput(input);
  return {
    schema: CENTURION_THREAD_BUSINESS_INSIGHTS_SCHEMA,
    input: validated,
    inputDigest: factsInputDigest(validated),
    insights: buildInsights(validated),
  };
}

/**
 * Strictly validates a typed Task 6 facts artifact before another bounded
 * projection consumes it. It returns canonical closed-code facts only.
 */
export function parseCenturionThreadBusinessFacts(
  value: unknown,
): CenturionThreadBusinessFacts {
  const validated = validateFacts(value);
  return {
    schema: CENTURION_THREAD_BUSINESS_INSIGHTS_SCHEMA,
    input: validated.input,
    inputDigest: factsInputDigest(validated.input),
    insights: validated.insights,
  };
}

function validateFacts(
  value: unknown,
): {
  input: ValidatedInput;
  insights: readonly CenturionThreadBusinessInsight[];
} {
  const record = factsRecord(value, ['schema', 'input', 'inputDigest', 'insights']);
  if (record.schema !== CENTURION_THREAD_BUSINESS_INSIGHTS_SCHEMA) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_FACTS_INVALID');
  }
  const input = validateInput(record.input);
  const inputDigest = requiredString(record.inputDigest);
  if (!SHA256.test(inputDigest) || inputDigest !== factsInputDigest(input)) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_FACTS_INVALID');
  }
  if (!Array.isArray(record.insights) || record.insights.length !== INSIGHT_METRICS.length) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_FACTS_INVALID');
  }
  const componentRefs = new Set(input.components.map((component) => component.caseRef));
  const insights = record.insights.map((value, index) => {
    const insight = factsRecord(value, [
      'metricId',
      'section',
      'availability',
      'claimStatus',
      'impactClass',
      'evidenceTier',
      'confidence',
      'decisionReadiness',
      'recommendation',
      'nextHumanCheck',
      'examples',
    ]);
    const metricId = oneOf(insight.metricId, INSIGHT_METRICS);
    if (metricId !== INSIGHT_METRICS[index]) {
      fail('CENTURION_THREAD_BUSINESS_INSIGHTS_FACTS_INVALID');
    }
    const section = oneOf(insight.section, INSIGHT_METRICS);
    if (section !== INSIGHT_METRICS[index]) {
      fail('CENTURION_THREAD_BUSINESS_INSIGHTS_FACTS_INVALID');
    }
    const availability = oneOf(insight.availability, METRIC_AVAILABILITIES);
    const claimStatus = oneOf(insight.claimStatus, CLAIM_STATUSES);
    const impactClass = oneOf(insight.impactClass, IMPACT_CLASSES);
    const evidenceTier = oneOf(insight.evidenceTier, EVIDENCE_TIERS);
    const confidence = oneOf(insight.confidence, CONFIDENCES);
    const decisionReadiness = oneOf(insight.decisionReadiness, READINESS_STATUSES);
    const recommendation = oneOf(insight.recommendation, RECOMMENDATION_CODES);
    const nextHumanCheck = oneOf(insight.nextHumanCheck, NEXT_HUMAN_CHECKS);
    if (!Array.isArray(insight.examples) || insight.examples.length > 3) {
      fail('CENTURION_THREAD_BUSINESS_INSIGHTS_FACTS_INVALID');
    }
    const seen = new Set<string>();
    const examples = insight.examples.map((example) => {
      const exampleRecord = factsRecord(example, ['caseRef', 'selectionReason']);
      const reference = requiredString(exampleRecord.caseRef);
      if (!CASE_REF.test(reference) || !componentRefs.has(reference) || seen.has(reference)) {
        fail('CENTURION_THREAD_BUSINESS_INSIGHTS_REFERENCE_INVALID');
      }
      seen.add(reference);
      const selectionReason = oneOf(
        exampleRecord.selectionReason,
        EXAMPLE_SELECTION_REASONS,
      );
      return { caseRef: reference, selectionReason };
    });
    if (availability !== 'available' && examples.length > 0) {
      fail('CENTURION_THREAD_BUSINESS_INSIGHTS_FACTS_INVALID');
    }
    return {
      metricId,
      section,
      availability,
      claimStatus,
      impactClass,
      evidenceTier,
      confidence,
      decisionReadiness,
      recommendation,
      nextHumanCheck,
      examples,
    };
  });
  if (JSON.stringify(insights) !== JSON.stringify(buildInsights(input))) {
    fail('CENTURION_THREAD_BUSINESS_INSIGHTS_FACTS_INVALID');
  }
  return { input, insights };
}

function percentileNearestRank(
  values: readonly number[],
  percentile: number,
): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil((percentile / 100) * ordered.length) - 1)] ?? null;
}

function renderInsight(insight: CenturionThreadBusinessInsight): string[] {
  const lines = [
    `### Insight \`${insight.metricId}\``,
    `- claim_status: \`${insight.claimStatus}\``,
    `- impact_class: \`${insight.impactClass}\``,
    `- evidence_tier: \`${insight.evidenceTier}\``,
    `- confidence: \`${insight.confidence}\``,
    `- decision_readiness: \`${insight.decisionReadiness}\``,
    `- recommendation: \`${insight.recommendation}\` — ${RECOMMENDATION_COPY[insight.recommendation]}`,
    `- next_human_check: \`${insight.nextHumanCheck}\` — ${NEXT_HUMAN_CHECK_COPY[insight.nextHumanCheck]}`,
  ];
  if (insight.examples.length === 0) {
    lines.push('- examples: none');
  } else {
    lines.push('- examples:');
    for (const example of insight.examples) {
      lines.push(
        `  - \`${example.caseRef}\` (${example.selectionReason})`,
      );
    }
  }
  return lines;
}

function rateMetadata(input: {
  numerator: number;
  denominator: number;
  excluded: number;
  unknown: number;
  eligibilityRule: string;
  timestampBasis: string;
  evidenceTier: CenturionThreadBusinessEvidenceTier;
  facts: ValidatedInput;
}): string {
  return [
    `numerator=${input.numerator}`,
    `denominator=${input.denominator}`,
    `excluded=${input.excluded}`,
    `unknown=${input.unknown}`,
    `eligibility=${input.eligibilityRule}`,
    `timestamp_basis=${input.timestampBasis}`,
    `evidence_tier=${input.evidenceTier}`,
    `source_digest=${input.facts.sourceDigests.join('+')}`,
    `classifier_version=${input.facts.versions.classifierVersion}`,
    `metric_definition_version=${input.facts.versions.metricDefinitionVersion}`,
  ].join('; ');
}

function renderUnavailableMetric(input: {
  metricId: string;
  availability: 'not_available' | 'not_evaluated';
  nextProof: CenturionThreadBusinessNextHumanCheck;
}): string {
  return `- ${input.metricId}: \`${input.availability}\`; next_proof=\`${input.nextProof}\``;
}

function renderRateMetric(input: {
  metricId: string;
  unit: string;
  nextProof: CenturionThreadBusinessNextHumanCheck;
  metadata: Parameters<typeof rateMetadata>[0];
}): string {
  if (input.metadata.denominator === 0) {
    return renderUnavailableMetric({
      metricId: input.metricId,
      availability: 'not_available',
      nextProof: input.nextProof,
    });
  }
  return `- ${input.metricId}: \`available\`; value=${(input.metadata.numerator / input.metadata.denominator).toFixed(6)}; unit=${input.unit}; ${rateMetadata(input.metadata)}`;
}

function renderTrustBar(
  input: ValidatedInput,
  insight: CenturionThreadBusinessInsight,
): string[] {
  const lines = [
    '## 1. Decision-readiness trust bar',
    `- status: \`${input.readiness.status}\``,
    `- source_coverage: \`${input.readiness.sourceCoverage}\``,
    `- event_cutoff: ${input.snapshot.eventCutoffs.map((value) => `\`${value}\``).join(', ')}`,
    `- ingest_cutoff: ${input.snapshot.ingestCutoffs.map((value) => `\`${value}\``).join(', ')}`,
    `- source_digests: ${input.sourceDigests.map((value) => `\`${value}\``).join(', ')}`,
    `- classifier_version: \`${input.versions.classifierVersion}\``,
    `- metric_definition_version: \`${input.versions.metricDefinitionVersion}\``,
  ];
  if (input.readiness.status === 'valid') {
    const evidenceCounts = EVIDENCE_TIERS.slice(0, 4).map(
      (tier) =>
        `${tier}=${input.components.filter((component) => component.evidenceTier === tier).length}`,
    );
    lines.push(
      `- snapshot_range: generated_at=\`${input.generatedAt}\`; source_event_cutoff_count=${input.snapshot.eventCutoffs.length}; ingest_cutoff_count=${input.snapshot.ingestCutoffs.length}`,
      `- coverage: messages=${input.snapshot.messageCount}; components=${input.snapshot.componentCount}; persisted_threads=${input.snapshot.persistedThreadCount}`,
      `- accounted_exceptions: parser=${input.snapshot.parserExceptionCount}; coverage=${input.snapshot.coverageExceptionCount}`,
      `- evidence_tier_mix: ${evidenceCounts.join('; ')}`,
      `- manual_adjudication_count: ${input.components.filter((component) => component.finalState === 'needs_manual_adjudication').length}`,
    );
  } else {
    lines.push(
      '- operational counts, rates, examples, and outcome claims are suppressed until this report-local snapshot is valid.',
    );
  }
  return [...lines, '', ...renderInsight(insight)];
}

function renderQueue(
  input: ValidatedInput,
  insight: CenturionThreadBusinessInsight,
): string[] {
  const lines = ['## 2. Current work queue'];
  if (input.readiness.status !== 'valid') {
    lines.push('- status: `not_available`');
    return [...lines, '', ...renderInsight(insight)];
  }
  const action = input.components
    .filter((component) => component.finalState === 'action_required')
    .sort((left, right) => {
      const leftAge = ageFor(left, input.generatedAt).milliseconds ?? -1;
      const rightAge = ageFor(right, input.generatedAt).milliseconds ?? -1;
      return rightAge - leftAge || compareText(left.caseRef, right.caseRef);
    });
  const manual = input.components
    .filter((component) => component.finalState === 'needs_manual_adjudication')
    .sort((left, right) => {
      const leftSeverity =
        LIMITATION_SEVERITY[primaryLimitation(left) as (typeof LIMITATIONS)[number]] ?? 0;
      const rightSeverity =
        LIMITATION_SEVERITY[primaryLimitation(right) as (typeof LIMITATIONS)[number]] ?? 0;
      return rightSeverity - leftSeverity || compareText(left.caseRef, right.caseRef);
    });
  const allGaps = input.components.flatMap((component) => component.responseGaps);
  const unclassified = input.components.filter(
    (component) =>
      !component.classificationFinal || component.classificationCounts.length === 0,
  ).length;
  const renderRow = (component: ValidatedComponent): string =>
    `- \`${component.caseRef}\`; primary_reason=\`${primaryReason(component)}\`; age_bucket=\`${ageFor(component, input.generatedAt).bucket}\`; evidence_tier=\`${component.evidenceTier}\`; limitation=\`${primaryLimitation(component)}\`; handoff_state=\`${handoffState(component)}\`; next_human_check=\`${nextHumanCheck(component)}\``;
  lines.push(
    `- act_now_component_count: ${action.length}`,
    `- review_today_component_count: ${manual.length}`,
    `- persisted_thread_count: ${input.snapshot.persistedThreadCount}`,
    `- excluded_response_gap_count: ${allGaps.filter((gap) => gap.status === 'excluded').length}`,
    `- unknown_response_gap_count: ${allGaps.filter((gap) => gap.status === 'unknown').length}`,
    `- unclassified_component_count: ${unclassified}`,
    '',
    '### act_now',
  );
  if (action.length === 0) {
    lines.push('- No qualifying opaque case reference.');
  } else {
    lines.push(...action.map(renderRow));
  }
  lines.push('', '### review_today');
  if (manual.length === 0) {
    lines.push('- No qualifying opaque case reference.');
  } else {
    lines.push(...manual.map(renderRow));
  }
  return [...lines, '', ...renderInsight(insight)];
}

function timingCaseBucketCounts(input: ValidatedInput): Record<
  | 'quote_only'
  | 'automated'
  | 'ambiguous'
  | 'duplicate'
  | 'missing_event_time'
  | 'incomplete'
  | 'pending_review',
  number
> {
  const hasClassification = (
    component: ValidatedComponent,
    classification: CenturionThreadBusinessClassification,
  ): boolean =>
    component.classificationCounts.some(
      (entry) => entry.classification === classification && entry.count > 0,
    );
  return {
    quote_only: input.components.filter((component) =>
      component.limitations.includes('quoted_only_evidence'),
    ).length,
    automated: input.components.filter((component) =>
      hasClassification(component, 'automated_or_non_actionable'),
    ).length,
    ambiguous: input.components.filter(
      (component) =>
        component.finalState === 'needs_manual_adjudication' ||
        hasClassification(component, 'ambiguous'),
    ).length,
    duplicate: input.components.filter((component) =>
      component.limitations.includes('duplicate_persisted_message'),
    ).length,
    missing_event_time: input.components.filter(
      (component) =>
        component.limitations.includes('missing_event_time') ||
        component.latestAction.quality === 'missing',
    ).length,
    incomplete: input.components.filter(
      (component) =>
        component.coverageStatus !== 'complete' ||
        component.limitations.some((limitation) =>
          SOURCE_COVERAGE_LIMITATIONS.has(limitation),
        ) ||
        !component.classificationFinal,
    ).length,
    pending_review: input.readiness.pendingReview ? 1 : 0,
  };
}

function renderTimingCaseBucketCounts(input: ValidatedInput): string {
  const buckets = timingCaseBucketCounts(input);
  return `- safe_excluded_unknown_case_buckets: quote_only=${buckets.quote_only}; automated=${buckets.automated}; ambiguous=${buckets.ambiguous}; duplicate=${buckets.duplicate}; missing_event_time=${buckets.missing_event_time}; incomplete=${buckets.incomplete}; pending_review=${buckets.pending_review}`;
}

function renderTiming(
  input: ValidatedInput,
  insight: CenturionThreadBusinessInsight,
): string[] {
  const lines = ['## 3. Observed service timing, not SLA performance'];
  if (input.readiness.status !== 'valid') {
    lines.push(
      '- status: `not_available`',
      '- safe_excluded_unknown_case_buckets: `not_available`; quote_only; automated; ambiguous; duplicate; missing_event_time; incomplete; pending_review',
    );
    return [...lines, '', ...renderInsight(insight)];
  }
  const gaps = input.components.flatMap((component) => component.responseGaps);
  const observed = gaps.filter((gap) => gap.status === 'observed');
  const excluded = gaps.filter((gap) => gap.status === 'excluded');
  const unknown = gaps.filter((gap) => gap.status === 'unknown');
  const durations = observed.flatMap((gap) =>
    gap.durationMs === null ? [] : [gap.durationMs],
  );
  const reasonCounts = RESPONSE_GAP_REASONS.map(
    (reason) => `${reason}=${gaps.filter((gap) => gap.reason === reason).length}`,
  );
  lines.push(
    `- observed_response_timing: \`available\`; observed=${observed.length}; excluded=${excluded.length}; unknown=${unknown.length}`,
    `- observed_duration_ms: p50=${percentileNearestRank(durations, 50) ?? 'not_available'}; p95=${percentileNearestRank(durations, 95) ?? 'not_available'}`,
    `- exclusion_and_unknown_buckets: ${reasonCounts.join('; ')}`,
    renderTimingCaseBucketCounts(input),
  );
  return [...lines, '', ...renderInsight(insight)];
}

function renderConversationOutcomes(
  input: ValidatedInput,
  insight: CenturionThreadBusinessInsight,
): string[] {
  const lines = ['## 4. Conversation outcomes'];
  if (input.readiness.status !== 'valid') {
    lines.push('- status: `not_available`');
    return [...lines, '', ...renderInsight(insight)];
  }
  const classified = input.components.every(
    (component) =>
      component.classificationFinal && component.classificationCounts.length > 0,
  );
  if (!classified) {
    lines.push('- classified_outcomes: `not_available`; next_proof=`verify_identity_or_linkage`');
  } else {
    lines.push(
      `- booking_instruction_or_quote_acceptance: \`available\`; count=${countClassifications(input.components, 'booking_instruction') + countClassifications(input.components, 'quote_acceptance')}`,
      `- customer_acknowledgement: \`available\`; count=${countClassifications(input.components, 'customer_acknowledgement')}`,
      `- automation: \`available\`; count=${countClassifications(input.components, 'automated_or_non_actionable')}`,
      `- unresolved_ambiguous_manual: \`available\`; count=${input.components.filter(
        (component) =>
          component.finalState === 'needs_manual_adjudication' ||
          component.classificationCounts.some(
            (entry) => entry.classification === 'ambiguous',
          ),
      ).length}`,
    );
  }
  lines.push(
    renderUnavailableMetric({
      metricId: 'quote_issued',
      availability: 'not_available',
      nextProof: 'collect_authoritative_pms_data',
    }),
    renderUnavailableMetric({
      metricId: 'confirmation_or_document_delivery',
      availability: 'not_available',
      nextProof: 'collect_authoritative_pms_data',
    }),
    renderUnavailableMetric({
      metricId: 'cancellation_or_amendment',
      availability: 'not_available',
      nextProof: 'collect_authoritative_pms_data',
    }),
    renderUnavailableMetric({
      metricId: 'booking_completion',
      availability: 'not_available',
      nextProof: 'collect_authoritative_pms_data',
    }),
  );
  return [...lines, '', ...renderInsight(insight)];
}

function renderOperationalComplexity(
  input: ValidatedInput,
  insight: CenturionThreadBusinessInsight,
): string[] {
  const lines = ['## 5. Operational complexity'];
  if (input.readiness.status !== 'valid') {
    lines.push('- status: `not_available`');
    return [...lines, '', ...renderInsight(insight)];
  }
  const componentCount = input.components.length;
  const totalTurns = input.components.reduce(
    (total, component) => total + component.turnCount,
    0,
  );
  const totalPersistedThreads = input.components.reduce(
    (total, component) => total + component.persistedThreadCount,
    0,
  );
  const totalInternalParticipants = input.components.reduce(
    (total, component) => total + component.participantCounts.internal,
    0,
  );
  const totalExternalParticipants = input.components.reduce(
    (total, component) => total + component.participantCounts.external,
    0,
  );
  const participantTotal = totalInternalParticipants + totalExternalParticipants;
  const threePlus = input.components.filter((component) => component.turnCount >= 3).length;
  const handoffs = input.components.filter(
    (component) =>
      component.classificationCounts.some(
        (entry) => entry.classification === 'internal_handoff',
      ),
  ).length;
  const duplicate = input.components.filter((component) =>
    component.limitations.includes('duplicate_persisted_message'),
  ).length;
  const quotedOnly = input.components.filter((component) =>
    component.limitations.includes('quoted_only_evidence'),
  ).length;
  const sharedMetadata = {
    excluded: 0,
    unknown: 0,
    eligibilityRule: 'all_components',
    timestampBasis: 'snapshot_cutoff',
    evidenceTier: aggregateEvidenceTier(input.components),
    facts: input,
  } as const;
  lines.push(
    renderRateMetric({
      metricId: 'messages_per_component',
      unit: 'messages_per_component',
      nextProof: 'verify_source_coverage',
      metadata: { ...sharedMetadata, numerator: totalTurns, denominator: componentCount },
    }),
    renderRateMetric({
      metricId: 'persisted_threads_per_component',
      unit: 'persisted_threads_per_component',
      nextProof: 'verify_source_coverage',
      metadata: {
        ...sharedMetadata,
        numerator: totalPersistedThreads,
        denominator: componentCount,
      },
    }),
    renderRateMetric({
      metricId: 'three_plus_message_share',
      unit: 'component_share',
      nextProof: 'verify_source_coverage',
      metadata: { ...sharedMetadata, numerator: threePlus, denominator: componentCount },
    }),
    renderRateMetric({
      metricId: 'internal_participant_mix',
      unit: 'participant_share',
      nextProof: 'verify_identity_or_linkage',
      metadata: {
        ...sharedMetadata,
        numerator: totalInternalParticipants,
        denominator: participantTotal,
      },
    }),
    renderRateMetric({
      metricId: 'external_participant_mix',
      unit: 'participant_share',
      nextProof: 'verify_identity_or_linkage',
      metadata: {
        ...sharedMetadata,
        numerator: totalExternalParticipants,
        denominator: participantTotal,
      },
    }),
    renderRateMetric({
      metricId: 'observed_internal_handoff_mix',
      unit: 'component_share',
      nextProof: 'verify_identity_or_linkage',
      metadata: { ...sharedMetadata, numerator: handoffs, denominator: componentCount },
    }),
    `- duplicate_persisted_message_indicator: \`available\`; count=${duplicate}`,
    `- quoted_history_only_evidence: \`available\`; count=${quotedOnly}`,
    renderUnavailableMetric({
      metricId: 'late_ingest',
      availability: 'not_available',
      nextProof: 'verify_duplicate_or_ingest',
    }),
    renderUnavailableMetric({
      metricId: 'attachment_or_document_dependency',
      availability: 'not_available',
      nextProof: 'collect_attachment_or_document_data',
    }),
  );
  return [...lines, '', ...renderInsight(insight)];
}

function renderAutomationPrerequisites(
  input: ValidatedInput,
  insight: CenturionThreadBusinessInsight,
): string[] {
  const lines = ['## 6. Automation prerequisites, not agent performance'];
  if (input.readiness.status !== 'valid') {
    lines.push('- status: `not_available`');
    return [...lines, '', ...renderInsight(insight)];
  }
  const completeCoverage = input.components.filter(
    (component) => component.coverageStatus === 'complete',
  ).length;
  const limitedCoverage = input.components.filter(
    (component) => component.coverageStatus !== 'complete',
  ).length;
  const timingBlockers = input.components.filter(
    (component) =>
      component.limitations.includes('missing_event_time') ||
      component.latestAction.quality === 'missing',
  ).length;
  const identityBlockers = input.components.filter((component) =>
    component.limitations.some((limitation) =>
      [
        'weak_subject_participant_correlation',
        'ambiguous_reply_header',
        'malformed_reply_header',
      ].includes(limitation),
    ),
  ).length;
  lines.push(
    renderRateMetric({
      metricId: 'required_grounding_coverage',
      unit: 'component_share',
      nextProof: 'verify_source_coverage',
      metadata: {
        numerator: completeCoverage,
        denominator: input.components.length,
        excluded: 0,
        unknown: limitedCoverage,
        eligibilityRule: 'all_components',
        timestampBasis: 'snapshot_cutoff',
        evidenceTier: aggregateEvidenceTier(input.components),
        facts: input,
      },
    }),
    `- coverage_data_blockers: \`available\`; count=${limitedCoverage}`,
    `- timing_data_blockers: \`available\`; count=${timingBlockers}`,
    `- identity_or_linkage_blockers: \`available\`; count=${identityBlockers}`,
    renderUnavailableMetric({
      metricId: 'template_vs_substantive_writing_mix',
      availability: 'not_available',
      nextProof: 'create_draft_evaluation_cohort',
    }),
  );
  for (const metricId of [
    'draft_acceptance',
    'draft_edit_or_reject',
    'draft_quality',
    'autonomous_action',
    'workload_reduction',
    'business_outcome',
  ]) {
    lines.push(
      renderUnavailableMetric({
        metricId,
        availability: 'not_evaluated',
        nextProof: 'create_draft_evaluation_cohort',
      }),
    );
  }
  return [...lines, '', ...renderInsight(insight)];
}

function renderRevenueMetrics(insight: CenturionThreadBusinessInsight): string[] {
  const lines = ['## 7. Revenue metrics only when grounded'];
  for (const metricId of [
    'quote_to_confirmation',
    'booking_value',
    'conversion',
    'revenue',
  ]) {
    lines.push(
      renderUnavailableMetric({
        metricId,
        availability: 'not_available',
        nextProof: insight.nextHumanCheck,
      }),
    );
  }
  return [...lines, '', ...renderInsight(insight)];
}

function insightById(
  insights: readonly CenturionThreadBusinessInsight[],
  metricId: CenturionThreadBusinessInsight['metricId'],
): CenturionThreadBusinessInsight {
  const insight = insights.find((candidate) => candidate.metricId === metricId);
  if (!insight) fail('CENTURION_THREAD_BUSINESS_INSIGHTS_FACTS_INVALID');
  return insight;
}

export function renderCenturionThreadBusinessInsights(
  facts: CenturionThreadBusinessFacts,
): CenturionThreadBusinessInsightsRendered {
  const validated = validateFacts(facts);
  const input = validated.input;
  const queueInsight = insightById(validated.insights, 'current_work_queue');
  const revenueInsight = insightById(validated.insights, 'revenue_metrics');
  const ctoNextCheck = insightById(
    validated.insights,
    'automation_prerequisites',
  ).nextHumanCheck;
  const lines = [
    '# Centurion thread-state business insights',
    '',
    'Private local-only report. Uses current-run opaque case references and companion definitions only.',
    '',
    '## CEO',
    `- next_action: \`${queueInsight.recommendation}\` — ${RECOMMENDATION_COPY[queueInsight.recommendation]}`,
    `- decision_readiness: \`${input.readiness.status}\``,
    '',
    '## CTO',
    `- next_human_check: \`${ctoNextCheck}\` — ${NEXT_HUMAN_CHECK_COPY[ctoNextCheck]}`,
    `- data_work: \`${input.readiness.status === 'valid' ? 'no_action_available' : queueInsight.recommendation}\``,
    '',
    '## Client',
    `- snapshot_scope: run \`${input.runRef}\`; generated_at \`${input.generatedAt}\``,
    `- confidence_boundary: \`${revenueInsight.confidence}\`; unknowns remain status-coded in this snapshot.`,
    `- cheapest_next_proof: \`${revenueInsight.nextHumanCheck}\``,
    '',
    ...renderTrustBar(
      input,
      insightById(validated.insights, 'decision_readiness'),
    ),
    '',
    ...renderQueue(input, queueInsight),
    '',
    ...renderTiming(
      input,
      insightById(validated.insights, 'observed_service_timing'),
    ),
    '',
    ...renderConversationOutcomes(
      input,
      insightById(validated.insights, 'conversation_outcomes'),
    ),
    '',
    ...renderOperationalComplexity(
      input,
      insightById(validated.insights, 'operational_complexity'),
    ),
    '',
    ...renderAutomationPrerequisites(
      input,
      insightById(validated.insights, 'automation_prerequisites'),
    ),
    '',
    ...renderRevenueMetrics(revenueInsight),
    '',
    'See `process-and-definitions.md` for metric formulas, eligibility, exclusions, timestamp basis, and closed-vocabulary definitions.',
  ];
  return {
    markdown: `${lines.join('\n')}\n`,
    selectedExamples: validated.insights.map((insight) => ({
      metricId: insight.metricId,
      examples: insight.examples,
    })),
  };
}
