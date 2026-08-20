import {
  buildCenturionThreadBusinessFacts,
  type CenturionThreadBusinessFacts,
} from '../../src/ops/centurion-thread-business-insights.js';
import type { CenturionThreadAuditSafeSourceInput } from '../../src/ops/centurion-thread-audit-snapshot.js';

const SOURCE_MANIFEST_DIGEST = 'a'.repeat(64);
const SOURCE_DIGEST_A = 'b'.repeat(64);
const SOURCE_DIGEST_B = 'c'.repeat(64);
const SOURCE_DIGEST_C = 'd'.repeat(64);

export const THREAD_AUDIT_SNAPSHOT_TIMES = {
  attemptedAt: '2026-08-10T00:00:00.000Z',
  verifiedAt: '2026-08-10T00:01:00.000Z',
  publishedAt: '2026-08-10T00:02:00.000Z',
  eventCutoffAt: '2026-08-09T23:00:00.000Z',
  ingestCutoffAt: '2026-08-09T23:30:00.000Z',
} as const;

export function createThreadAuditSnapshotFacts(input?: {
  caseRefA?: string;
  caseRefB?: string;
  valid?: boolean;
}): CenturionThreadBusinessFacts {
  const valid = input?.valid ?? true;
  const caseRefA = input?.caseRefA ?? `case_${'d'.repeat(64)}`;
  const caseRefB = input?.caseRefB ?? `case_${'e'.repeat(64)}`;

  return buildCenturionThreadBusinessFacts({
    runRef: `run_${'f'.repeat(64)}`,
    generatedAt: THREAD_AUDIT_SNAPSHOT_TIMES.verifiedAt,
    sourceDigests: [SOURCE_MANIFEST_DIGEST],
    snapshot: {
      eventCutoffs: [THREAD_AUDIT_SNAPSHOT_TIMES.eventCutoffAt],
      ingestCutoffs: [THREAD_AUDIT_SNAPSHOT_TIMES.ingestCutoffAt],
      messageCount: 3,
      componentCount: 2,
      persistedThreadCount: 3,
      parserExceptionCount: 0,
      coverageExceptionCount: valid ? 0 : 1,
    },
    versions: {
      classifierVersion: 'deterministic-classifier-v1',
      metricDefinitionVersion: 'metric-definition-v2',
    },
    readiness: {
      status: valid ? 'valid' : 'not_available',
      sourceCoverage: valid ? 'complete' : 'limited',
      cutoffsKnown: true,
      membershipReconciled: true,
      parserExceptionsAccounted: true,
      allComponentsClosed: true,
      pendingReview: !valid,
    },
    components: [
      {
        caseRef: caseRefA,
        finalState: 'action_required',
        classificationFinal: true,
        reasonCodes: ['strict_new_reservation_pattern'],
        evidenceTier: 'persisted_reply',
        limitations: [],
        coverageStatus: 'complete',
        responseGaps: [
          { status: 'observed', durationMs: 3_600_000, reason: null },
        ],
        classificationCounts: [{ classification: 'new_reservation_request', count: 1 }],
        participantCounts: { internal: 1, external: 1 },
        persistedThreadCount: 2,
        turnCount: 1,
        latestAction: {
          eventTime: '2026-08-09T20:00:00.000Z',
          quality: 'trustworthy',
        },
      },
      {
        caseRef: caseRefB,
        finalState: 'resolved',
        classificationFinal: true,
        reasonCodes: ['recognized_customer_acknowledgement'],
        evidenceTier: 'persisted_reply',
        limitations: valid ? [] : ['coverage_limited'],
        coverageStatus: valid ? 'complete' : 'limited',
        responseGaps: [
          {
            status: 'excluded',
            durationMs: null,
            reason: 'no_actionable_external_turn',
          },
        ],
        classificationCounts: [
          { classification: 'customer_acknowledgement', count: 2 },
        ],
        participantCounts: { internal: 1, external: 1 },
        persistedThreadCount: 1,
        turnCount: 2,
        latestAction: { eventTime: null, quality: 'missing' },
      },
    ],
  });
}

export function createThreadAuditSafeSourceInput(input?: {
  caseRefA?: string;
  caseRefB?: string;
  valid?: boolean;
  attemptedAt?: string;
  verifiedAt?: string;
  publishedAt?: string;
}): CenturionThreadAuditSafeSourceInput {
  const caseRefA = input?.caseRefA ?? `case_${'d'.repeat(64)}`;
  const caseRefB = input?.caseRefB ?? `case_${'e'.repeat(64)}`;
  const valid = input?.valid ?? true;

  return {
    schema: 'centurion_thread_audit_safe_source_input_v1',
    task4: {
      schema: 'centurion_thread_task4_safe_projection_v1',
      sourceCorpora: [
        {
          transportId: 'transport-fixture',
          sourceManifestDigest: SOURCE_MANIFEST_DIGEST,
          sourceSchemaVersion: 'centurion_message_projection_v1',
          sourceEventCutoffAt: THREAD_AUDIT_SNAPSHOT_TIMES.eventCutoffAt,
          sourceIngestCutoffAt: THREAD_AUDIT_SNAPSHOT_TIMES.ingestCutoffAt,
        },
      ],
      identityRulesVersion: 'identity-rules-v1',
      classifierVersion: 'deterministic-classifier-v1',
      metricDefinitionVersion: 'metric-definition-v2',
      attemptedAt: input?.attemptedAt ?? THREAD_AUDIT_SNAPSHOT_TIMES.attemptedAt,
      verifiedAt: input?.verifiedAt ?? THREAD_AUDIT_SNAPSHOT_TIMES.verifiedAt,
      publishedAt: input?.publishedAt ?? THREAD_AUDIT_SNAPSHOT_TIMES.publishedAt,
      reconciliation: {
        messageCount: 3,
        componentCount: 2,
        persistedThreadCount: 3,
        parserExceptionCount: 0,
        coverageExceptionCount: valid ? 0 : 1,
      },
      components: [
        {
          task6CaseRef: caseRefA,
          sourceMembership: [
            {
              sourceDigest: SOURCE_DIGEST_C,
              transportId: 'transport-fixture',
              threadId: 'thread-fixture-a',
            },
            {
              sourceDigest: SOURCE_DIGEST_B,
              transportId: 'transport-fixture',
              threadId: 'thread-fixture-b',
            },
          ],
          finalState: 'action_required',
          reasonCodes: ['strict_new_reservation_pattern'],
          limitationCodes: [],
          evidenceTier: 'persisted_reply',
          latestActionAt: '2026-08-09T20:00:00.000Z',
          latestActionTrusted: true,
        },
        {
          task6CaseRef: caseRefB,
          sourceMembership: [
            {
              sourceDigest: SOURCE_DIGEST_A,
              transportId: 'transport-fixture',
              threadId: 'thread-fixture-c',
            },
          ],
          finalState: 'resolved',
          reasonCodes: ['recognized_customer_acknowledgement'],
          limitationCodes: valid ? [] : ['coverage_limited'],
          evidenceTier: 'persisted_reply',
          latestActionAt: null,
          latestActionTrusted: false,
        },
      ],
    },
    task6Facts: createThreadAuditSnapshotFacts({ caseRefA, caseRefB, valid }),
  };
}
