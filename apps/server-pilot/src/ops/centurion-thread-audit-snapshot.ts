import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CENTURION_THREAD_BUSINESS_INSIGHTS_METRIC_DEFINITION_VERSION,
  parseCenturionThreadBusinessFacts,
  type CenturionThreadBusinessFacts,
} from './centurion-thread-business-insights.js';

export const CENTURION_THREAD_AUDIT_SAFE_SOURCE_SCHEMA =
  'centurion_thread_audit_safe_source_v1' as const;
export const CENTURION_THREAD_AUDIT_SAFE_SOURCE_INPUT_SCHEMA =
  'centurion_thread_audit_safe_source_input_v1' as const;
export const CENTURION_THREAD_AUDIT_SNAPSHOT_SCHEMA =
  'centurion_thread_audit_snapshot_v1' as const;

export const CENTURION_THREAD_AUDIT_MAX_COMPONENT_MAPPINGS = 256;
export const CENTURION_THREAD_AUDIT_MAX_INSIGHT_EXAMPLES = 3;
export const CENTURION_THREAD_AUDIT_MAX_VERIFIED_AGE_MS = 24 * 60 * 60 * 1_000;
export const CENTURION_THREAD_AUDIT_MAX_SOURCE_CUTOFF_LAG_MS =
  24 * 60 * 60 * 1_000;

const SOURCE_SCHEMA_VERSION = 'centurion_message_projection_v1' as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CASE_REFERENCE = /^case_[a-f0-9]{64}$/u;
const VERSION = /^[A-Za-z0-9._:-]{1,160}$/u;

const THREAD_STATES = [
  'resolved',
  'action_required',
  'customer_acknowledgement_or_confirmation',
  'automated_or_non_actionable',
  'needs_manual_adjudication',
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
const LIMITATION_CODES = [
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
const EVIDENCE_TIERS = [
  'persisted_reply',
  'quoted_reply',
  'participant_subject_only_correlation',
  'no_evidence',
] as const;
const IMPACT_CLASSES = [
  'commercial_follow_up_hypothesis',
  'guest_trust',
  'staff_time',
  'data_quality',
] as const;
const AGE_BUCKETS = [
  'under_4h',
  'four_to_24h',
  'one_to_three_days',
  'over_three_days',
  'unknown',
] as const;
const HANDOFF_STATES = [
  'no_handoff_observed',
  'internal_handoff_observed',
  'handoff_evidence_limited',
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
const METRIC_IDS = [
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
const TRUST_REASON_CODES = [
  'verified',
  'source_coverage_limited',
  'pending_manual_adjudication',
  'source_not_ready',
] as const;

export type CenturionThreadAuditTrustStatus = 'valid' | 'incomplete';
export type CenturionThreadAuditTrustReasonCode =
  (typeof TRUST_REASON_CODES)[number];
export type CenturionThreadAuditComponentId = `component_${string}`;
export type CenturionThreadAuditMetricId = (typeof METRIC_IDS)[number];

export type CenturionThreadAuditComponentMapping = {
  threadId: string;
  sourceMembershipRank: number;
  isPrimary: boolean;
};

export type CenturionThreadAuditComponent = {
  componentId: CenturionThreadAuditComponentId;
  finalState: (typeof THREAD_STATES)[number];
  reasonCodes: readonly (typeof REASON_CODES)[number][];
  limitationCodes: readonly (typeof LIMITATION_CODES)[number][];
  evidenceTier: (typeof EVIDENCE_TIERS)[number];
  impactClass: (typeof IMPACT_CLASSES)[number];
  ageBucket: (typeof AGE_BUCKETS)[number];
  handoffState: (typeof HANDOFF_STATES)[number];
  nextHumanCheck: (typeof NEXT_HUMAN_CHECKS)[number];
  exampleSelectionReason: (typeof EXAMPLE_SELECTION_REASONS)[number] | null;
  latestActionAt: string | null;
  initialMappingCount: number;
  sortGroup: number;
  sortRank: number;
  mappings: readonly CenturionThreadAuditComponentMapping[];
};

export type CenturionThreadAuditInsight = {
  metricId: CenturionThreadAuditMetricId;
  availability: (typeof METRIC_AVAILABILITIES)[number];
  claimStatus: 'fact' | 'evidence_limited' | 'hypothesis';
  impactClass: (typeof IMPACT_CLASSES)[number];
  evidenceTier:
    | (typeof EVIDENCE_TIERS)[number]
    | 'mixed'
    | 'not_available';
  confidence: 'high' | 'medium' | 'low' | 'not_available';
  recommendation:
    | 'review_action_queue'
    | 'review_manual_queue'
    | 'investigate_data_quality'
    | 'collect_authoritative_pms_data'
    | 'collect_attachment_or_document_data'
    | 'create_draft_evaluation_cohort'
    | 'no_action_available';
  nextHumanCheck: (typeof NEXT_HUMAN_CHECKS)[number];
  examples: readonly {
    componentId: CenturionThreadAuditComponentId;
    selectionReason: (typeof EXAMPLE_SELECTION_REASONS)[number];
  }[];
};

export type CenturionThreadAuditMetrics = {
  decisionReadiness: {
    availability: (typeof METRIC_AVAILABILITIES)[number];
    componentCount: number;
  };
  currentWorkQueue: {
    availability: (typeof METRIC_AVAILABILITIES)[number];
    actionRequiredCount: number;
    manualAdjudicationCount: number;
  };
  observedServiceTiming: {
    availability: (typeof METRIC_AVAILABILITIES)[number];
    observedGapCount: number;
    excludedGapCount: number;
    unknownGapCount: number;
  };
  conversationOutcomes: {
    availability: (typeof METRIC_AVAILABILITIES)[number];
    componentCount: number;
    finalClassificationCount: number;
  };
  operationalComplexity: {
    availability: (typeof METRIC_AVAILABILITIES)[number];
    messageCount: number;
    componentCount: number;
    persistedThreadCount: number;
  };
  automationPrerequisites: {
    availability: (typeof METRIC_AVAILABILITIES)[number];
    parserExceptionCount: number;
    coverageExceptionCount: number;
  };
  revenueMetrics: {
    availability: (typeof METRIC_AVAILABILITIES)[number];
  };
};

type SnapshotBase = {
  schema: typeof CENTURION_THREAD_AUDIT_SAFE_SOURCE_SCHEMA;
  transportId: string;
  sourceManifestDigest: string;
  sourceSchemaVersion: typeof SOURCE_SCHEMA_VERSION;
  identityRulesVersion: string;
  classifierVersion: string;
  metricDefinitionVersion: typeof CENTURION_THREAD_BUSINESS_INSIGHTS_METRIC_DEFINITION_VERSION;
  sourceEventCutoffAt: string;
  sourceIngestCutoffAt: string;
  attemptedAt: string;
  verifiedAt: string;
  publishedAt: string;
};

export type CenturionThreadAuditSafeSource =
  | (SnapshotBase & {
      trustStatus: 'valid';
      trustReasonCode: 'verified';
      messageCount: number;
      componentCount: number;
      persistedThreadCount: number;
      parserExceptionCount: number;
      coverageExceptionCount: number;
      metrics: CenturionThreadAuditMetrics;
      insights: readonly CenturionThreadAuditInsight[];
      components: readonly CenturionThreadAuditComponent[];
    })
  | (SnapshotBase & {
      trustStatus: 'incomplete';
      trustReasonCode: Exclude<CenturionThreadAuditTrustReasonCode, 'verified'>;
    });

type SealCenturionThreadAuditSnapshot<T extends CenturionThreadAuditSafeSource> =
  T extends unknown
    ? Omit<T, 'schema'> & {
      schema: typeof CENTURION_THREAD_AUDIT_SNAPSHOT_SCHEMA;
      sourceIdentityDigest: string;
      payloadDigest: string;
      sealedEnvelopeDigest: string;
    }
    : never;

export type SealedCenturionThreadAuditSnapshot =
  SealCenturionThreadAuditSnapshot<CenturionThreadAuditSafeSource>;

export type CenturionThreadAuditSafeSourceInput = {
  schema: typeof CENTURION_THREAD_AUDIT_SAFE_SOURCE_INPUT_SCHEMA;
  task4: {
    schema: 'centurion_thread_task4_safe_projection_v1';
    sourceCorpora: readonly {
      transportId: string;
      sourceManifestDigest: string;
      sourceSchemaVersion: typeof SOURCE_SCHEMA_VERSION;
      sourceEventCutoffAt: string;
      sourceIngestCutoffAt: string;
    }[];
    identityRulesVersion: string;
    classifierVersion: string;
    metricDefinitionVersion: string;
    attemptedAt: string;
    verifiedAt: string;
    publishedAt: string;
    reconciliation: {
      messageCount: number;
      componentCount: number;
      persistedThreadCount: number;
      parserExceptionCount: number;
      coverageExceptionCount: number;
    };
    components: readonly {
      task6CaseRef: string;
      sourceMembership: readonly {
        sourceDigest: string;
        transportId: string;
        threadId: string;
      }[];
      finalState: (typeof THREAD_STATES)[number];
      reasonCodes: readonly (typeof REASON_CODES)[number][];
      limitationCodes: readonly (typeof LIMITATION_CODES)[number][];
      evidenceTier: (typeof EVIDENCE_TIERS)[number];
      latestActionAt: string | null;
      latestActionTrusted: boolean;
    }[];
  };
  task6Facts: CenturionThreadBusinessFacts;
};

function fail(code: string): never {
  throw new Error(code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalTimestamp(value: string, code = 'CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID'): string {
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(value)) fail(code);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail(code);
  return date.toISOString();
}

function uniqueSorted<T extends string>(values: readonly T[], code: string): readonly T[] {
  const sorted = [...values].sort(compareText);
  if (new Set(sorted).size !== sorted.length) fail(code);
  return sorted;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

const digestSchema = z.string().regex(SHA256);
const versionSchema = z.string().regex(VERSION);
const opaqueIdSchema = z.string().regex(OPAQUE_ID);
const timestampSchema = z.string().datetime({ offset: true });
const nullableTimestampSchema = timestampSchema.nullable();
const sourceMembershipSchema = z
  .object({
    sourceDigest: digestSchema,
    transportId: opaqueIdSchema,
    threadId: opaqueIdSchema,
  })
  .strict();
const task4ComponentSchema = z
  .object({
    task6CaseRef: z.string().regex(CASE_REFERENCE),
    sourceMembership: z
      .array(sourceMembershipSchema)
      .min(1),
    finalState: z.enum(THREAD_STATES),
    reasonCodes: z.array(z.enum(REASON_CODES)).min(1),
    limitationCodes: z.array(z.enum(LIMITATION_CODES)),
    evidenceTier: z.enum(EVIDENCE_TIERS),
    latestActionAt: nullableTimestampSchema,
    latestActionTrusted: z.boolean(),
  })
  .strict();
const safeSourceInputSchema = z
  .object({
    schema: z.literal(CENTURION_THREAD_AUDIT_SAFE_SOURCE_INPUT_SCHEMA),
    task4: z
      .object({
        schema: z.literal('centurion_thread_task4_safe_projection_v1'),
        sourceCorpora: z
          .array(
            z
              .object({
                transportId: opaqueIdSchema,
                sourceManifestDigest: digestSchema,
                sourceSchemaVersion: z.literal(SOURCE_SCHEMA_VERSION),
                sourceEventCutoffAt: timestampSchema,
                sourceIngestCutoffAt: timestampSchema,
              })
              .strict(),
          )
          .min(1),
        identityRulesVersion: versionSchema,
        classifierVersion: versionSchema,
        metricDefinitionVersion: versionSchema,
        attemptedAt: timestampSchema,
        verifiedAt: timestampSchema,
        publishedAt: timestampSchema,
        reconciliation: z
          .object({
            messageCount: z.number().int().nonnegative(),
            componentCount: z.number().int().nonnegative(),
            persistedThreadCount: z.number().int().nonnegative(),
            parserExceptionCount: z.number().int().nonnegative(),
            coverageExceptionCount: z.number().int().nonnegative(),
          })
          .strict(),
        components: z.array(task4ComponentSchema),
      })
      .strict(),
    task6Facts: z.unknown(),
  })
  .strict();

export const centurionThreadAuditMetricsSchema = z
  .object({
    decisionReadiness: z
      .object({
        availability: z.enum(METRIC_AVAILABILITIES),
        componentCount: z.number().int().nonnegative(),
      })
      .strict(),
    currentWorkQueue: z
      .object({
        availability: z.enum(METRIC_AVAILABILITIES),
        actionRequiredCount: z.number().int().nonnegative(),
        manualAdjudicationCount: z.number().int().nonnegative(),
      })
      .strict(),
    observedServiceTiming: z
      .object({
        availability: z.enum(METRIC_AVAILABILITIES),
        observedGapCount: z.number().int().nonnegative(),
        excludedGapCount: z.number().int().nonnegative(),
        unknownGapCount: z.number().int().nonnegative(),
      })
      .strict(),
    conversationOutcomes: z
      .object({
        availability: z.enum(METRIC_AVAILABILITIES),
        componentCount: z.number().int().nonnegative(),
        finalClassificationCount: z.number().int().nonnegative(),
      })
      .strict(),
    operationalComplexity: z
      .object({
        availability: z.enum(METRIC_AVAILABILITIES),
        messageCount: z.number().int().nonnegative(),
        componentCount: z.number().int().nonnegative(),
        persistedThreadCount: z.number().int().nonnegative(),
      })
      .strict(),
    automationPrerequisites: z
      .object({
        availability: z.enum(METRIC_AVAILABILITIES),
        parserExceptionCount: z.number().int().nonnegative(),
        coverageExceptionCount: z.number().int().nonnegative(),
      })
      .strict(),
    revenueMetrics: z
      .object({ availability: z.enum(METRIC_AVAILABILITIES) })
      .strict(),
  })
  .strict();

const componentSchema = z
  .object({
    componentId: z.string().regex(/^component_[a-f0-9]{64}$/u),
    finalState: z.enum(THREAD_STATES),
    reasonCodes: z.array(z.enum(REASON_CODES)).min(1),
    limitationCodes: z.array(z.enum(LIMITATION_CODES)),
    evidenceTier: z.enum(EVIDENCE_TIERS),
    impactClass: z.enum(IMPACT_CLASSES),
    ageBucket: z.enum(AGE_BUCKETS),
    handoffState: z.enum(HANDOFF_STATES),
    nextHumanCheck: z.enum(NEXT_HUMAN_CHECKS),
    exampleSelectionReason: z.enum(EXAMPLE_SELECTION_REASONS).nullable(),
    latestActionAt: nullableTimestampSchema,
    initialMappingCount: z.number().int().nonnegative(),
    sortGroup: z.number().int().min(0).max(2),
    sortRank: z.number().int().nonnegative(),
    mappings: z
      .array(
        z
          .object({
            threadId: opaqueIdSchema,
            sourceMembershipRank: z.number().int().nonnegative(),
            isPrimary: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(CENTURION_THREAD_AUDIT_MAX_COMPONENT_MAPPINGS),
  })
  .strict();

export const centurionThreadAuditInsightSchema = z
  .object({
    metricId: z.enum(METRIC_IDS),
    availability: z.enum(METRIC_AVAILABILITIES),
    claimStatus: z.enum(['fact', 'evidence_limited', 'hypothesis']),
    impactClass: z.enum(IMPACT_CLASSES),
    evidenceTier: z.enum([
      ...EVIDENCE_TIERS,
      'mixed',
      'not_available',
    ]),
    confidence: z.enum(['high', 'medium', 'low', 'not_available']),
    recommendation: z.enum([
      'review_action_queue',
      'review_manual_queue',
      'investigate_data_quality',
      'collect_authoritative_pms_data',
      'collect_attachment_or_document_data',
      'create_draft_evaluation_cohort',
      'no_action_available',
    ]),
    nextHumanCheck: z.enum(NEXT_HUMAN_CHECKS),
    examples: z
      .array(
        z
          .object({
            componentId: z.string().regex(/^component_[a-f0-9]{64}$/u),
            selectionReason: z.enum(EXAMPLE_SELECTION_REASONS),
          })
          .strict(),
      )
      .max(CENTURION_THREAD_AUDIT_MAX_INSIGHT_EXAMPLES),
  })
  .strict();

const safeSourceBaseSchema = z.object({
  schema: z.literal(CENTURION_THREAD_AUDIT_SAFE_SOURCE_SCHEMA),
  transportId: opaqueIdSchema,
  sourceManifestDigest: digestSchema,
  sourceSchemaVersion: z.literal(SOURCE_SCHEMA_VERSION),
  identityRulesVersion: versionSchema,
  classifierVersion: versionSchema,
  metricDefinitionVersion: z.literal(
    CENTURION_THREAD_BUSINESS_INSIGHTS_METRIC_DEFINITION_VERSION,
  ),
  sourceEventCutoffAt: timestampSchema,
  sourceIngestCutoffAt: timestampSchema,
  attemptedAt: timestampSchema,
  verifiedAt: timestampSchema,
  publishedAt: timestampSchema,
});

const validSafeSourceSchema = safeSourceBaseSchema
  .extend({
    trustStatus: z.literal('valid'),
    trustReasonCode: z.literal('verified'),
    messageCount: z.number().int().nonnegative(),
    componentCount: z.number().int().nonnegative(),
    persistedThreadCount: z.number().int().nonnegative(),
    parserExceptionCount: z.number().int().nonnegative(),
    coverageExceptionCount: z.number().int().nonnegative(),
    metrics: centurionThreadAuditMetricsSchema,
    insights: z.array(centurionThreadAuditInsightSchema).length(METRIC_IDS.length),
    components: z.array(componentSchema),
  })
  .strict();

const incompleteSafeSourceSchema = safeSourceBaseSchema
  .extend({
    trustStatus: z.literal('incomplete'),
    trustReasonCode: z.enum([
      'source_coverage_limited',
      'pending_manual_adjudication',
      'source_not_ready',
    ]),
  })
  .strict();

const sealedValidSchema = validSafeSourceSchema
  .extend({
    schema: z.literal(CENTURION_THREAD_AUDIT_SNAPSHOT_SCHEMA),
    sourceIdentityDigest: digestSchema,
    payloadDigest: digestSchema,
    sealedEnvelopeDigest: digestSchema,
  })
  .strict();

const sealedIncompleteSchema = incompleteSafeSourceSchema
  .extend({
    schema: z.literal(CENTURION_THREAD_AUDIT_SNAPSHOT_SCHEMA),
    sourceIdentityDigest: digestSchema,
    payloadDigest: digestSchema,
    sealedEnvelopeDigest: digestSchema,
  })
  .strict();

function parseSafeSource(value: unknown): CenturionThreadAuditSafeSource {
  if (!isRecord(value)) fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  const schema =
    value.trustStatus === 'valid'
      ? validSafeSourceSchema
      : value.trustStatus === 'incomplete'
        ? incompleteSafeSourceSchema
        : null;
  if (!schema) fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  return normalizeSafeSource(parsed.data as CenturionThreadAuditSafeSource);
}

function normalizeSafeSource(
  source: CenturionThreadAuditSafeSource,
): CenturionThreadAuditSafeSource {
  const base: SnapshotBase = {
    schema: CENTURION_THREAD_AUDIT_SAFE_SOURCE_SCHEMA,
    transportId: source.transportId,
    sourceManifestDigest: source.sourceManifestDigest,
    sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
    identityRulesVersion: source.identityRulesVersion,
    classifierVersion: source.classifierVersion,
    metricDefinitionVersion: CENTURION_THREAD_BUSINESS_INSIGHTS_METRIC_DEFINITION_VERSION,
    sourceEventCutoffAt: canonicalTimestamp(source.sourceEventCutoffAt),
    sourceIngestCutoffAt: canonicalTimestamp(source.sourceIngestCutoffAt),
    attemptedAt: canonicalTimestamp(source.attemptedAt),
    verifiedAt: canonicalTimestamp(source.verifiedAt),
    publishedAt: canonicalTimestamp(source.publishedAt),
  };
  assertTimeline(base);
  if (source.trustStatus === 'incomplete') {
    return {
      ...base,
      trustStatus: 'incomplete',
      trustReasonCode: source.trustReasonCode,
    };
  }

  const components = source.components
    .map((component) => normalizeComponent(component))
    .sort((left, right) => compareText(left.componentId, right.componentId));
  assertValidProjection({
    source: { ...source, ...base, components },
    components,
  });
  const insights = source.insights
    .map((insight) => normalizeInsight(insight))
    .sort(
      (left, right) =>
        METRIC_IDS.indexOf(left.metricId) - METRIC_IDS.indexOf(right.metricId),
    );
  if (
    !sameStrings(
      insights.map((insight) => insight.metricId),
      METRIC_IDS,
    )
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  }
  return {
    ...base,
    trustStatus: 'valid',
    trustReasonCode: 'verified',
    messageCount: source.messageCount,
    componentCount: source.componentCount,
    persistedThreadCount: source.persistedThreadCount,
    parserExceptionCount: source.parserExceptionCount,
    coverageExceptionCount: source.coverageExceptionCount,
    metrics: source.metrics,
    insights,
    components,
  };
}

function normalizeComponent(
  component: CenturionThreadAuditComponent,
): CenturionThreadAuditComponent {
  const reasonCodes = uniqueSorted(
    component.reasonCodes,
    'CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID',
  ) as CenturionThreadAuditComponent['reasonCodes'];
  const limitationCodes = uniqueSorted(
    component.limitationCodes,
    'CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID',
  ) as CenturionThreadAuditComponent['limitationCodes'];
  const mappings = [...component.mappings].sort(
    (left, right) =>
      left.sourceMembershipRank - right.sourceMembershipRank ||
      compareText(left.threadId, right.threadId),
  );
  const primaryCount = mappings.filter((mapping) => mapping.isPrimary).length;
  const expectedRanks = mappings.map((mapping) => mapping.sourceMembershipRank);
  if (
    primaryCount !== 1 ||
    mappings.length !== component.initialMappingCount ||
    new Set(mappings.map((mapping) => mapping.threadId)).size !== mappings.length ||
    expectedRanks.some((rank, index) => rank !== index)
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  }
  const latestActionAt =
    component.latestActionAt === null
      ? null
      : canonicalTimestamp(component.latestActionAt);
  if ((component.ageBucket === 'unknown') !== (latestActionAt === null)) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  }
  return {
    ...component,
    reasonCodes,
    limitationCodes,
    latestActionAt,
    mappings,
  };
}

function normalizeInsight(
  insight: CenturionThreadAuditInsight,
): CenturionThreadAuditInsight {
  const examples = [...insight.examples].sort(
    (left, right) =>
      compareText(left.componentId, right.componentId) ||
      compareText(left.selectionReason, right.selectionReason),
  );
  if (
    new Set(examples.map((example) => example.componentId)).size !== examples.length
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  }
  return { ...insight, examples };
}

function assertTimeline(source: Pick<
  SnapshotBase,
  | 'attemptedAt'
  | 'verifiedAt'
  | 'publishedAt'
  | 'sourceEventCutoffAt'
  | 'sourceIngestCutoffAt'
>): void {
  const attempted = new Date(source.attemptedAt).getTime();
  const verified = new Date(source.verifiedAt).getTime();
  const published = new Date(source.publishedAt).getTime();
  const eventCutoff = new Date(source.sourceEventCutoffAt).getTime();
  const ingestCutoff = new Date(source.sourceIngestCutoffAt).getTime();
  if (
    attempted > verified ||
    verified > published ||
    eventCutoff > verified ||
    ingestCutoff > verified
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  }
}

function assertValidProjection(input: {
  source: Omit<Extract<CenturionThreadAuditSafeSource, { trustStatus: 'valid' }>, 'components'> & {
    components: readonly CenturionThreadAuditComponent[];
  };
  components: readonly CenturionThreadAuditComponent[];
}): void {
  const { source, components } = input;
  if (
    source.componentCount !== components.length ||
    source.persistedThreadCount !==
      components.reduce((count, component) => count + component.initialMappingCount, 0) ||
    source.metrics.decisionReadiness.componentCount !== source.componentCount ||
    source.metrics.currentWorkQueue.actionRequiredCount !==
      countBy(components, (component) => component.finalState === 'action_required') ||
    source.metrics.currentWorkQueue.manualAdjudicationCount !==
      countBy(
        components,
        (component) => component.finalState === 'needs_manual_adjudication',
      ) ||
    source.metrics.conversationOutcomes.componentCount !== source.componentCount ||
    source.metrics.operationalComplexity.componentCount !== source.componentCount ||
    source.metrics.operationalComplexity.messageCount !== source.messageCount ||
    source.metrics.operationalComplexity.persistedThreadCount !==
      source.persistedThreadCount ||
    source.metrics.automationPrerequisites.parserExceptionCount !==
      source.parserExceptionCount ||
    source.metrics.automationPrerequisites.coverageExceptionCount !==
      source.coverageExceptionCount
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  }
  const componentIds = new Set<string>();
  const mappings = new Set<string>();
  for (const component of components) {
    if (componentIds.has(component.componentId)) {
      fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
    }
    componentIds.add(component.componentId);
    for (const mapping of component.mappings) {
      const key = `${component.componentId}\u0000${mapping.threadId}`;
      if (mappings.has(key)) fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
      mappings.add(key);
    }
  }
  for (const insight of source.insights) {
    if (
      insight.examples.length > CENTURION_THREAD_AUDIT_MAX_INSIGHT_EXAMPLES ||
      insight.examples.some((example) => !componentIds.has(example.componentId))
    ) {
      fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
    }
  }
}

function sourceIdentityDigest(source: Pick<
  SnapshotBase,
  | 'transportId'
  | 'sourceManifestDigest'
  | 'sourceSchemaVersion'
  | 'identityRulesVersion'
  | 'classifierVersion'
  | 'metricDefinitionVersion'
>): string {
  return sha256(
    stableJson({
      transportId: source.transportId,
      canonicalSourceManifestDigest: source.sourceManifestDigest,
      sourceSchemaVersion: source.sourceSchemaVersion,
      identityRulesVersion: source.identityRulesVersion,
      classifierVersion: source.classifierVersion,
      metricDefinitionVersion: source.metricDefinitionVersion,
    }),
  );
}

function semanticPayload(
  envelope: Omit<SealedCenturionThreadAuditSnapshot, 'sealedEnvelopeDigest'>,
): Record<string, unknown> {
  const {
    attemptedAt: _attemptedAt,
    verifiedAt: _verifiedAt,
    publishedAt: _publishedAt,
    payloadDigest: _payloadDigest,
    ...semantic
  } = envelope;
  return semantic;
}

function envelopeWithoutSeal(
  envelope: SealedCenturionThreadAuditSnapshot,
): Omit<SealedCenturionThreadAuditSnapshot, 'sealedEnvelopeDigest'> {
  const { sealedEnvelopeDigest: _sealedEnvelopeDigest, ...unsealed } = envelope;
  return unsealed;
}

function countBy<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  return values.filter(predicate).length;
}

function metricAvailability(
  facts: CenturionThreadBusinessFacts,
  metricId: CenturionThreadAuditMetricId,
): (typeof METRIC_AVAILABILITIES)[number] {
  const insight = facts.insights.find((candidate) => candidate.metricId === metricId);
  if (!insight) fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  return insight.availability;
}

function buildMetrics(facts: CenturionThreadBusinessFacts): CenturionThreadAuditMetrics {
  const components = facts.input.components;
  const gaps = components.flatMap((component) => component.responseGaps);
  const finalClassificationCount = components.reduce(
    (total, component) =>
      total +
      component.classificationCounts.reduce(
        (componentTotal, entry) => componentTotal + entry.count,
        0,
      ),
    0,
  );
  return {
    decisionReadiness: {
      availability: metricAvailability(facts, 'decision_readiness'),
      componentCount: facts.input.snapshot.componentCount,
    },
    currentWorkQueue: {
      availability: metricAvailability(facts, 'current_work_queue'),
      actionRequiredCount: countBy(
        components,
        (component) => component.finalState === 'action_required',
      ),
      manualAdjudicationCount: countBy(
        components,
        (component) => component.finalState === 'needs_manual_adjudication',
      ),
    },
    observedServiceTiming: {
      availability: metricAvailability(facts, 'observed_service_timing'),
      observedGapCount: countBy(gaps, (gap) => gap.status === 'observed'),
      excludedGapCount: countBy(gaps, (gap) => gap.status === 'excluded'),
      unknownGapCount: countBy(gaps, (gap) => gap.status === 'unknown'),
    },
    conversationOutcomes: {
      availability: metricAvailability(facts, 'conversation_outcomes'),
      componentCount: facts.input.snapshot.componentCount,
      finalClassificationCount,
    },
    operationalComplexity: {
      availability: metricAvailability(facts, 'operational_complexity'),
      messageCount: facts.input.snapshot.messageCount,
      componentCount: facts.input.snapshot.componentCount,
      persistedThreadCount: facts.input.snapshot.persistedThreadCount,
    },
    automationPrerequisites: {
      availability: metricAvailability(facts, 'automation_prerequisites'),
      parserExceptionCount: facts.input.snapshot.parserExceptionCount,
      coverageExceptionCount: facts.input.snapshot.coverageExceptionCount,
    },
    revenueMetrics: {
      availability: metricAvailability(facts, 'revenue_metrics'),
    },
  };
}

function ageBucket(input: {
  latestActionAt: string | null;
  trustworthy: boolean;
  verifiedAt: string;
}): (typeof AGE_BUCKETS)[number] {
  if (!input.trustworthy || input.latestActionAt === null) return 'unknown';
  const age = new Date(input.verifiedAt).getTime() - new Date(input.latestActionAt).getTime();
  if (!Number.isFinite(age) || age < 0) return 'unknown';
  if (age < 4 * 60 * 60 * 1_000) return 'under_4h';
  if (age < 24 * 60 * 60 * 1_000) return 'four_to_24h';
  if (age <= 3 * 24 * 60 * 60 * 1_000) return 'one_to_three_days';
  return 'over_three_days';
}

function sortGroup(state: CenturionThreadAuditComponent['finalState']): number {
  if (state === 'action_required') return 0;
  if (state === 'needs_manual_adjudication') return 1;
  return 2;
}

function nextHumanCheck(input: {
  state: CenturionThreadAuditComponent['finalState'];
  limitations: readonly (typeof LIMITATION_CODES)[number][];
  latestActionTrusted: boolean;
}): (typeof NEXT_HUMAN_CHECKS)[number] {
  const limitations = new Set(input.limitations);
  if (
    limitations.has('coverage_limited') ||
    limitations.has('source_coverage_missing') ||
    limitations.has('source_coverage_incomplete')
  ) {
    return 'verify_source_coverage';
  }
  if (!input.latestActionTrusted || limitations.has('missing_event_time')) {
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
  if (input.state === 'needs_manual_adjudication') return 'review_pending_task3';
  if (input.state === 'action_required') return 'review_latest_action';
  return 'none';
}

function impactClass(
  state: CenturionThreadAuditComponent['finalState'],
): CenturionThreadAuditComponent['impactClass'] {
  if (state === 'action_required') return 'guest_trust';
  if (state === 'needs_manual_adjudication') return 'data_quality';
  return 'staff_time';
}

function handoffState(input: {
  factsComponent: CenturionThreadBusinessFacts['input']['components'][number];
}): CenturionThreadAuditComponent['handoffState'] {
  const hasHandoff = input.factsComponent.classificationCounts.some(
    (entry) => entry.classification === 'internal_handoff' && entry.count > 0,
  );
  if (!hasHandoff) return 'no_handoff_observed';
  return input.factsComponent.evidenceTier === 'persisted_reply'
    ? 'internal_handoff_observed'
    : 'handoff_evidence_limited';
}

function incompleteReason(
  facts: CenturionThreadBusinessFacts,
): Exclude<CenturionThreadAuditTrustReasonCode, 'verified'> {
  if (facts.input.readiness.pendingReview) return 'pending_manual_adjudication';
  if (facts.input.readiness.sourceCoverage !== 'complete') {
    return 'source_coverage_limited';
  }
  return 'source_not_ready';
}

function task4FactsChecks(input: {
  task4: CenturionThreadAuditSafeSourceInput['task4'];
  facts: CenturionThreadBusinessFacts;
  corpus: CenturionThreadAuditSafeSourceInput['task4']['sourceCorpora'][number];
}): void {
  const { task4, facts, corpus } = input;
  const snapshot = facts.input.snapshot;
  if (
    task4.metricDefinitionVersion !==
      CENTURION_THREAD_BUSINESS_INSIGHTS_METRIC_DEFINITION_VERSION ||
    corpus.sourceSchemaVersion !== SOURCE_SCHEMA_VERSION ||
    task4.classifierVersion !== facts.input.versions.classifierVersion ||
    task4.metricDefinitionVersion !== facts.input.versions.metricDefinitionVersion ||
    facts.input.sourceDigests.length !== 1 ||
    facts.input.sourceDigests[0] !== corpus.sourceManifestDigest ||
    facts.input.snapshot.eventCutoffs.length !== 1 ||
    facts.input.snapshot.ingestCutoffs.length !== 1 ||
    facts.input.snapshot.eventCutoffs[0] !== corpus.sourceEventCutoffAt ||
    facts.input.snapshot.ingestCutoffs[0] !== corpus.sourceIngestCutoffAt ||
    snapshot.messageCount !== task4.reconciliation.messageCount ||
    snapshot.componentCount !== task4.reconciliation.componentCount ||
    snapshot.persistedThreadCount !== task4.reconciliation.persistedThreadCount ||
    snapshot.parserExceptionCount !== task4.reconciliation.parserExceptionCount ||
    snapshot.coverageExceptionCount !== task4.reconciliation.coverageExceptionCount ||
    task4.components.length !== task4.reconciliation.componentCount ||
    facts.input.components.length !== task4.components.length
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  }
}

function buildComponentSource(input: {
  task4: CenturionThreadAuditSafeSourceInput['task4'];
  facts: CenturionThreadBusinessFacts;
  transportId: string;
}): readonly CenturionThreadAuditComponent[] {
  const factsByCaseRef = new Map(
    input.facts.input.components.map((component) => [component.caseRef, component]),
  );
  const usedCaseRefs = new Set<string>();
  const mappedSourceDigests = new Set<string>();
  const mappedThreadKeys = new Set<string>();
  const examplesByCaseRef = new Map<
    string,
    (typeof EXAMPLE_SELECTION_REASONS)[number]
  >();
  for (const insight of input.facts.insights) {
    for (const example of insight.examples) {
      if (!examplesByCaseRef.has(example.caseRef)) {
        examplesByCaseRef.set(example.caseRef, example.selectionReason);
      }
    }
  }

  const components = input.task4.components.map((task4Component) => {
    const factsComponent = factsByCaseRef.get(task4Component.task6CaseRef);
    if (!factsComponent || usedCaseRefs.has(task4Component.task6CaseRef)) {
      fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
    }
    usedCaseRefs.add(task4Component.task6CaseRef);
    const sourceMembership = [...task4Component.sourceMembership].sort(
      (left, right) =>
        compareText(left.sourceDigest, right.sourceDigest) ||
        compareText(left.threadId, right.threadId),
    );
    if (
      new Set(sourceMembership.map((member) => member.sourceDigest)).size !==
        sourceMembership.length ||
      sourceMembership.some((member) => member.transportId !== input.transportId)
    ) {
      fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
    }
    for (const member of sourceMembership) {
      if (mappedSourceDigests.has(member.sourceDigest)) {
        fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
      }
      mappedSourceDigests.add(member.sourceDigest);
    }
    const mappings = [
      ...new Map(
        sourceMembership.map((member, index) => [member.threadId, { member, index }]),
      ).values(),
    ].map(({ member, index }, mappingIndex) => {
      const mappingKey = `${member.transportId}\u0000${member.threadId}`;
      if (mappedThreadKeys.has(mappingKey)) {
        fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
      }
      mappedThreadKeys.add(mappingKey);
      return {
        threadId: member.threadId,
        sourceMembershipRank: mappingIndex,
        isPrimary: mappingIndex === 0,
        firstSourceMembershipIndex: index,
      };
    });
    if (
      mappings.length > CENTURION_THREAD_AUDIT_MAX_COMPONENT_MAPPINGS ||
      factsComponent.persistedThreadCount !== mappings.length ||
      factsComponent.finalState !== task4Component.finalState ||
      factsComponent.evidenceTier !== task4Component.evidenceTier ||
      !sameStrings(
        uniqueSorted(task4Component.reasonCodes, 'CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID'),
        uniqueSorted(factsComponent.reasonCodes, 'CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID'),
      ) ||
      !sameStrings(
        uniqueSorted(
          task4Component.limitationCodes,
          'CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID',
        ),
        uniqueSorted(factsComponent.limitations, 'CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID'),
      ) ||
      (task4Component.latestActionTrusted !==
        (factsComponent.latestAction.quality === 'trustworthy')) ||
      task4Component.latestActionAt !== factsComponent.latestAction.eventTime
    ) {
      fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
    }
    const componentId = `component_${sha256(
      stableJson({
        transportId: input.transportId,
        sourceDigestMembership: sourceMembership.map((member) => member.sourceDigest),
      }),
    )}` as CenturionThreadAuditComponentId;
    const latestActionAt = task4Component.latestActionTrusted
      ? canonicalTimestamp(task4Component.latestActionAt!)
      : null;
    return {
      componentId,
      finalState: task4Component.finalState,
      reasonCodes: uniqueSorted(
        task4Component.reasonCodes,
        'CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID',
      ) as CenturionThreadAuditComponent['reasonCodes'],
      limitationCodes: uniqueSorted(
        task4Component.limitationCodes,
        'CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID',
      ) as CenturionThreadAuditComponent['limitationCodes'],
      evidenceTier: task4Component.evidenceTier,
      impactClass: impactClass(task4Component.finalState),
      ageBucket: ageBucket({
        latestActionAt,
        trustworthy: task4Component.latestActionTrusted,
        verifiedAt: input.task4.verifiedAt,
      }),
      handoffState: handoffState({ factsComponent }),
      nextHumanCheck: nextHumanCheck({
        state: task4Component.finalState,
        limitations: task4Component.limitationCodes,
        latestActionTrusted: task4Component.latestActionTrusted,
      }),
      exampleSelectionReason:
        examplesByCaseRef.get(task4Component.task6CaseRef) ?? null,
      latestActionAt,
      initialMappingCount: mappings.length,
      sortGroup: sortGroup(task4Component.finalState),
      sortRank: 0,
      mappings: mappings.map(({ firstSourceMembershipIndex: _sourceIndex, ...mapping }) => mapping),
    } satisfies CenturionThreadAuditComponent;
  });
  if (usedCaseRefs.size !== factsByCaseRef.size) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  }
  return components
    .sort(
      (left, right) =>
        left.sortGroup - right.sortGroup ||
        ageSortRank(left.ageBucket) - ageSortRank(right.ageBucket) ||
        compareText(left.componentId, right.componentId),
    )
    .map((component, sortRank) => ({ ...component, sortRank }));
}

function ageSortRank(age: CenturionThreadAuditComponent['ageBucket']): number {
  return (
    {
      over_three_days: 0,
      one_to_three_days: 1,
      four_to_24h: 2,
      under_4h: 3,
      unknown: 4,
    } as const
  )[age];
}

function buildSafeInsights(input: {
  facts: CenturionThreadBusinessFacts;
  task4Components: readonly CenturionThreadAuditSafeSourceInput['task4']['components'][number][];
  components: readonly CenturionThreadAuditComponent[];
}): readonly CenturionThreadAuditInsight[] {
  const idByCaseRef = new Map(
    input.task4Components.map((component, index) => [
      component.task6CaseRef,
      input.components.find(
        (candidate) =>
          candidate.componentId ===
          `component_${sha256(
            stableJson({
              transportId: input.task4Components[index]!.sourceMembership[0]!.transportId,
              sourceDigestMembership: [...input.task4Components[index]!.sourceMembership]
                .sort(
                  (left, right) =>
                    compareText(left.sourceDigest, right.sourceDigest) ||
                    compareText(left.threadId, right.threadId),
                )
                .map((member) => member.sourceDigest),
            }),
          )}`,
      )?.componentId,
    ]),
  );
  const insights = input.facts.insights.map((insight) => {
    const examples = insight.examples.map((example) => {
      const componentId = idByCaseRef.get(example.caseRef);
      if (!componentId) fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
      return { componentId, selectionReason: example.selectionReason };
    });
    return {
      metricId: insight.metricId,
      availability: insight.availability,
      claimStatus: insight.claimStatus,
      impactClass: insight.impactClass,
      evidenceTier: insight.evidenceTier,
      confidence: insight.confidence,
      recommendation: insight.recommendation,
      nextHumanCheck: insight.nextHumanCheck,
      examples,
    } satisfies CenturionThreadAuditInsight;
  });
  return insights;
}

export function createCenturionThreadAuditSafeSource(
  value: unknown,
): CenturionThreadAuditSafeSource {
  const parsedInput = safeSourceInputSchema.safeParse(value);
  if (!parsedInput.success) fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  const input = parsedInput.data as CenturionThreadAuditSafeSourceInput;
  let facts: CenturionThreadBusinessFacts;
  try {
    facts = parseCenturionThreadBusinessFacts(input.task6Facts);
  } catch {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  }
  const { task4 } = input;
  if (task4.sourceCorpora.length !== 1) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  }
  const [corpus] = task4.sourceCorpora;
  if (!corpus) fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  task4FactsChecks({ task4, facts, corpus });
  const base: SnapshotBase = {
    schema: CENTURION_THREAD_AUDIT_SAFE_SOURCE_SCHEMA,
    transportId: corpus.transportId,
    sourceManifestDigest: corpus.sourceManifestDigest,
    sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
    identityRulesVersion: task4.identityRulesVersion,
    classifierVersion: task4.classifierVersion,
    metricDefinitionVersion: CENTURION_THREAD_BUSINESS_INSIGHTS_METRIC_DEFINITION_VERSION,
    sourceEventCutoffAt: canonicalTimestamp(corpus.sourceEventCutoffAt),
    sourceIngestCutoffAt: canonicalTimestamp(corpus.sourceIngestCutoffAt),
    attemptedAt: canonicalTimestamp(task4.attemptedAt),
    verifiedAt: canonicalTimestamp(task4.verifiedAt),
    publishedAt: canonicalTimestamp(task4.publishedAt),
  };
  assertTimeline(base);
  const components = buildComponentSource({
    task4,
    facts,
    transportId: corpus.transportId,
  });
  const insights = buildSafeInsights({
    facts,
    task4Components: task4.components,
    components,
  });
  if (facts.input.readiness.status !== 'valid') {
    return {
      ...base,
      trustStatus: 'incomplete',
      trustReasonCode: incompleteReason(facts),
    };
  }
  const safe = {
    ...base,
    trustStatus: 'valid' as const,
    trustReasonCode: 'verified' as const,
    messageCount: task4.reconciliation.messageCount,
    componentCount: task4.reconciliation.componentCount,
    persistedThreadCount: task4.reconciliation.persistedThreadCount,
    parserExceptionCount: task4.reconciliation.parserExceptionCount,
    coverageExceptionCount: task4.reconciliation.coverageExceptionCount,
    metrics: buildMetrics(facts),
    insights: [] as readonly CenturionThreadAuditInsight[],
    components,
  };
  return normalizeSafeSource({ ...safe, insights });
}

export function sealCenturionThreadAuditSnapshot(
  safeSource: CenturionThreadAuditSafeSource,
): SealedCenturionThreadAuditSnapshot {
  const source = parseSafeSource(safeSource);
  const unsealed = {
    ...source,
    schema: CENTURION_THREAD_AUDIT_SNAPSHOT_SCHEMA,
    sourceIdentityDigest: sourceIdentityDigest(source),
    payloadDigest: '',
  } as Omit<SealedCenturionThreadAuditSnapshot, 'sealedEnvelopeDigest'>;
  const payloadDigest = sha256(stableJson(semanticPayload(unsealed)));
  const withPayload = {
    ...unsealed,
    payloadDigest,
  } as Omit<SealedCenturionThreadAuditSnapshot, 'sealedEnvelopeDigest'>;
  return {
    ...withPayload,
    sealedEnvelopeDigest: sha256(stableJson(withPayload)),
  } as SealedCenturionThreadAuditSnapshot;
}

function parseSealedEnvelope(
  value: unknown,
): SealedCenturionThreadAuditSnapshot {
  if (!isRecord(value)) fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  if (
    typeof value.schema === 'string' &&
    value.schema.startsWith('centurion_thread_audit_snapshot_') &&
    value.schema !== CENTURION_THREAD_AUDIT_SNAPSHOT_SCHEMA
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_UNSUPPORTED_VERSION');
  }
  const schema =
    value.trustStatus === 'valid'
      ? sealedValidSchema
      : value.trustStatus === 'incomplete'
        ? sealedIncompleteSchema
        : null;
  if (!schema) fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  const envelope = parsed.data as SealedCenturionThreadAuditSnapshot;
  const normalizedSafe = normalizeSafeSource({
    ...envelope,
    schema: CENTURION_THREAD_AUDIT_SAFE_SOURCE_SCHEMA,
  } as CenturionThreadAuditSafeSource);
  const normalized = {
    ...normalizedSafe,
    schema: CENTURION_THREAD_AUDIT_SNAPSHOT_SCHEMA,
    sourceIdentityDigest: envelope.sourceIdentityDigest,
    payloadDigest: envelope.payloadDigest,
    sealedEnvelopeDigest: envelope.sealedEnvelopeDigest,
  } as SealedCenturionThreadAuditSnapshot;
  if (normalized.sourceIdentityDigest !== sourceIdentityDigest(normalized)) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_SOURCE_IDENTITY_INVALID');
  }
  if (
    normalized.payloadDigest !==
    sha256(stableJson(semanticPayload(envelopeWithoutSeal(normalized))))
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_PAYLOAD_DIGEST_INVALID');
  }
  if (
    normalized.sealedEnvelopeDigest !==
    sha256(stableJson(envelopeWithoutSeal(normalized)))
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_SEALED_DIGEST_INVALID');
  }
  return normalized;
}

export function serializeSealedCenturionThreadAuditSnapshot(
  envelope: SealedCenturionThreadAuditSnapshot,
): string {
  const parsed = parseSealedEnvelope(envelope);
  return stableJson(parsed);
}

export function parseSealedCenturionThreadAuditSnapshotBytes(
  bytes: string,
): SealedCenturionThreadAuditSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(bytes) as unknown;
  } catch {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_ENVELOPE_BYTES_INVALID');
  }
  const envelope = parseSealedEnvelope(value);
  if (serializeSealedCenturionThreadAuditSnapshot(envelope) !== bytes) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_ENVELOPE_BYTES_INVALID');
  }
  return envelope;
}

export function parseCenturionThreadAuditStoredMetricsAndInsights(value: unknown): {
  metrics: CenturionThreadAuditMetrics;
  insights: readonly CenturionThreadAuditInsight[];
} {
  const parsed = z
    .object({
      metrics: centurionThreadAuditMetricsSchema,
      insights: z.array(centurionThreadAuditInsightSchema).length(METRIC_IDS.length),
    })
    .strict()
    .safeParse(value);
  if (!parsed.success) fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  const insights = parsed.data.insights
    .map((insight) => normalizeInsight(insight as CenturionThreadAuditInsight))
    .sort(
      (left, right) =>
        METRIC_IDS.indexOf(left.metricId) - METRIC_IDS.indexOf(right.metricId),
    );
  if (
    !sameStrings(
      insights.map((insight) => insight.metricId),
      METRIC_IDS,
    )
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  }
  return {
    metrics: parsed.data.metrics as CenturionThreadAuditMetrics,
    insights,
  };
}

export function evaluateCenturionThreadAuditSnapshotStaleness(input: {
  envelope: SealedCenturionThreadAuditSnapshot;
  now: Date;
  maxVerifiedAgeMs?: number;
  maxSourceCutoffLagMs?: number;
}): { stale: boolean; reason: 'verified_age' | 'source_cutoff_lag' | 'invalid_time' | null } {
  if (input.envelope.trustStatus === 'incomplete') {
    return { stale: false, reason: null };
  }
  const verifiedAt = new Date(input.envelope.verifiedAt).getTime();
  const sourceEventCutoffAt = new Date(input.envelope.sourceEventCutoffAt).getTime();
  const sourceIngestCutoffAt = new Date(input.envelope.sourceIngestCutoffAt).getTime();
  const now = input.now.getTime();
  if (
    !Number.isFinite(verifiedAt) ||
    !Number.isFinite(sourceEventCutoffAt) ||
    !Number.isFinite(sourceIngestCutoffAt) ||
    !Number.isFinite(now) ||
    sourceEventCutoffAt > verifiedAt ||
    sourceIngestCutoffAt > verifiedAt ||
    verifiedAt > now
  ) {
    return { stale: true, reason: 'invalid_time' };
  }
  if (now - verifiedAt > (input.maxVerifiedAgeMs ?? CENTURION_THREAD_AUDIT_MAX_VERIFIED_AGE_MS)) {
    return { stale: true, reason: 'verified_age' };
  }
  const maximumCutoffLag =
    input.maxSourceCutoffLagMs ?? CENTURION_THREAD_AUDIT_MAX_SOURCE_CUTOFF_LAG_MS;
  if (
    verifiedAt - sourceEventCutoffAt > maximumCutoffLag ||
    verifiedAt - sourceIngestCutoffAt > maximumCutoffLag
  ) {
    return { stale: true, reason: 'source_cutoff_lag' };
  }
  return { stale: false, reason: null };
}
