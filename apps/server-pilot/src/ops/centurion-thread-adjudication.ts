import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  analyzeCenturionThreadIntelligence,
  type CenturionThreadIntelligenceResult,
  type CenturionThreadIntelligenceRoster,
  type CenturionThreadQuoteCoverageAnnotation,
  type CenturionThreadTurnAnnotation,
  type ThreadConversationComponent,
  type ThreadState,
} from './centurion-thread-intelligence.js';
import {
  parsePersistedCenturionThreadStateCorpus,
  type CenturionThreadStateCorpus,
  type CenturionThreadStateCorpusMessage,
} from './centurion-thread-state-corpus.js';

export const CENTURION_THREAD_ADJUDICATION_SCHEMA =
  'centurion_thread_adjudication_v1' as const;
export const CENTURION_THREAD_ADJUDICATION_CACHE_SCHEMA =
  'centurion_thread_adjudication_cache_v1' as const;
export const CENTURION_THREAD_EXCEPTION_REVIEW_PACKET_SCHEMA =
  'centurion_thread_exception_review_packet_v1' as const;
export const CENTURION_THREAD_EXCEPTION_REVIEW_DECISION_SCHEMA =
  'centurion_thread_exception_review_decision_v1' as const;
export const CENTURION_LEGACY_NO_OBSERVED_RESPONSE_SCHEMA =
  'centurion_legacy_no_observed_response_v1' as const;

const MAX_QUOTE_CHARACTERS = 64 * 1024;
const MAX_QUOTE_LINES = 2_000;
const MAX_REVIEW_TURNS = 12;
const MAX_REVIEW_TARGETS_PER_PACKET = 6;
const MAX_REVIEW_TURN_BYTES = 4_096;
const MAX_REVIEW_PACKET_BYTES = 24 * 1024;
const UNTRUSTED_EMAIL_START = '<<<BEGIN_UNTRUSTED_EMAIL_TEXT>>>\n';
const UNTRUSTED_EMAIL_END = '\n<<<END_UNTRUSTED_EMAIL_TEXT>>>';

const CLASSIFICATIONS = [
  'new_reservation_request',
  'quote_acceptance',
  'booking_instruction',
  'customer_acknowledgement',
  'internal_handoff',
  'unrelated_follow_up',
  'automated_or_non_actionable',
  'ambiguous',
] as const;

const TASK2_INTENTS = [
  'actionable_request',
  'customer_acknowledgement_or_confirmation',
  'automated_or_non_actionable',
  'staff_response',
  'internal_handoff',
  'non_actionable',
  'ambiguous',
] as const;

const TASK2_ACTIONABILITIES = [
  'actionable',
  'non_actionable',
  'ambiguous',
] as const;

const QUOTE_COVERAGE = [
  'no_quote',
  'english_structural_complete',
  'limited',
] as const;

const CACHE_DISPOSITIONS = [
  'new',
  'cache_reused',
  'component_context_changed',
  'rules_version_changed',
  'source_changed',
  'evidence_conflict',
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

const SHA256 = /^[a-f0-9]{64}$/u;
const MESSAGE_REF = /^m_[a-f0-9]{64}$/u;
const COMPONENT_REF = /^c_[a-f0-9]{64}$/u;
const PACKET_REF = /^p_[a-f0-9]{64}$/u;
const LEGACY_REF = /^legacy_[a-f0-9]{64}$/u;
const VERSION = /^[A-Za-z0-9._:-]{1,160}$/u;

const classificationSchema = z.enum(CLASSIFICATIONS);
const task2IntentSchema = z.enum(TASK2_INTENTS);
const task2ActionabilitySchema = z.enum(TASK2_ACTIONABILITIES);
const quoteCoverageSchema = z.enum(QUOTE_COVERAGE);
const reasonCodeSchema = z.enum(REASON_CODES);

const cacheKeySchema = z
  .object({
    transportId: z.string().min(1).max(256),
    sourceDigest: z.string().regex(SHA256),
    identityRulesVersion: z.string().regex(VERSION),
    classifierVersion: z.string().regex(VERSION),
    metricDefinitionVersion: z.string().regex(VERSION),
  })
  .strict();

const task2AnnotationValueSchema = z
  .object({
    intent: task2IntentSchema,
    actionability: task2ActionabilitySchema,
  })
  .strict();

const sourceBindingSchema = z
  .object({
    transportId: z.string().min(1).max(256),
    messageRef: z.string().regex(MESSAGE_REF),
    sourceDigest: z.string().regex(SHA256),
  })
  .strict();

const snapshotProvenanceSchema = z
  .object({
    transportId: z.string().min(1).max(256),
    sourceSchemaVersion: z.string().min(1).max(160),
    eventCutoff: z.string().datetime(),
    ingestCutoff: z.string().datetime(),
    corpusSha256: z.string().regex(SHA256),
  })
  .strict();

const reviewedCacheProvenanceSchema = z
  .object({
    kind: z.literal('review_decision'),
    packetRef: z.string().regex(PACKET_REF),
    packetDigest: z.string().regex(SHA256),
    componentContextDigest: z.string().regex(SHA256),
    sourceBindings: z.array(sourceBindingSchema).min(1).max(256),
    snapshotProvenance: z.array(snapshotProvenanceSchema).min(1).max(256),
    identityRulesVersion: z.string().regex(VERSION),
    classifierVersion: z.string().regex(VERSION),
    metricDefinitionVersion: z.string().regex(VERSION),
  })
  .strict();

const cacheRecordSchema = z
  .object({
    schema: z.literal(CENTURION_THREAD_ADJUDICATION_CACHE_SCHEMA),
    key: cacheKeySchema,
    messageRef: z.string().regex(MESSAGE_REF),
    componentRef: z.string().regex(COMPONENT_REF),
    componentContextDigest: z.string().regex(SHA256),
    classification: classificationSchema.nullable(),
    operationalKind: z.enum(['semantic', 'staff_response']),
    task2Annotation: task2AnnotationValueSchema,
    annotationFinal: z.boolean(),
    quoteCoverage: quoteCoverageSchema,
    reasonCodes: z.array(reasonCodeSchema).min(1).max(16),
    evidenceRefs: z.array(z.string().regex(MESSAGE_REF)).min(1).max(256),
    provenance: reviewedCacheProvenanceSchema,
  })
  .strict();

const legacyNoObservedResponseSchema = z
  .object({
    schema: z.literal(CENTURION_LEGACY_NO_OBSERVED_RESPONSE_SCHEMA),
    kind: z.literal('no_observed_response'),
    legacyRef: z.string().regex(LEGACY_REF),
    messageId: z.string().min(1).max(512),
  })
  .strict();

const reviewDecisionSchema = z
  .object({
    schema: z.literal(CENTURION_THREAD_EXCEPTION_REVIEW_DECISION_SCHEMA),
    packetRef: z.string().regex(PACKET_REF),
    packetDigest: z.string().regex(SHA256),
    componentRef: z.string().regex(COMPONENT_REF),
    componentContextDigest: z.string().regex(SHA256),
    sourceBindings: z.array(sourceBindingSchema).min(1).max(256),
    identityRulesVersion: z.string().regex(VERSION),
    classifierVersion: z.string().regex(VERSION),
    metricDefinitionVersion: z.string().regex(VERSION),
    decisions: z
      .array(
        z
          .object({
            messageRef: z.string().regex(MESSAGE_REF),
            classification: classificationSchema,
            actionability: task2ActionabilitySchema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_REVIEW_TURNS),
  })
  .strict();

export type CenturionThreadAdjudicationClassification =
  (typeof CLASSIFICATIONS)[number];

export type CenturionThreadTask2AnnotationValue = {
  intent: (typeof TASK2_INTENTS)[number];
  actionability: (typeof TASK2_ACTIONABILITIES)[number];
};

export type CenturionThreadAdjudicationCacheKey = z.infer<
  typeof cacheKeySchema
>;

export type CenturionThreadAdjudicationCacheRecord = z.infer<
  typeof cacheRecordSchema
>;

export type CenturionLegacyNoObservedResponseRecord = z.infer<
  typeof legacyNoObservedResponseSchema
>;

export type CenturionThreadExceptionReviewDecision = z.infer<
  typeof reviewDecisionSchema
>;

export type CenturionThreadAdjudicationCacheDisposition =
  (typeof CACHE_DISPOSITIONS)[number];

export type CenturionThreadAdjudicationReasonCode =
  (typeof REASON_CODES)[number];

export type CenturionThreadAdjudicationTurn = {
  messageId: string;
  messageRef: string;
  componentRef: string;
  componentContextDigest: string;
  classification: CenturionThreadAdjudicationClassification | null;
  operationalKind: 'semantic' | 'staff_response';
  task2Annotation: CenturionThreadTask2AnnotationValue;
  quoteCoverage: CenturionThreadQuoteCoverageAnnotation['status'];
  annotationFinal: boolean;
  reasonCodes: readonly CenturionThreadAdjudicationReasonCode[];
  cacheDisposition: CenturionThreadAdjudicationCacheDisposition;
  reviewRequired: boolean;
};

export type CenturionThreadExceptionReviewPacket = {
  schema: typeof CENTURION_THREAD_EXCEPTION_REVIEW_PACKET_SCHEMA;
  packetRef: string;
  packetDigest: string;
  componentRef: string;
  componentContextDigest: string;
  sourceBindings: readonly z.infer<typeof sourceBindingSchema>[];
  snapshotProvenance: readonly z.infer<typeof snapshotProvenanceSchema>[];
  identityRulesVersion: string;
  classifierVersion: string;
  metricDefinitionVersion: string;
  targetMessageRefs: readonly string[];
  contract: {
    decisionSchema: typeof CENTURION_THREAD_EXCEPTION_REVIEW_DECISION_SCHEMA;
    classifications: readonly CenturionThreadAdjudicationClassification[];
    freeTextAllowed: false;
  };
  omittedTurnCount: number;
  turns: readonly {
    messageRef: string;
    target: boolean;
    sourceDigest: string;
    direction: 'inbound' | 'outbound';
    candidate: {
      classification: CenturionThreadAdjudicationClassification | null;
      actionability: CenturionThreadTask2AnnotationValue['actionability'];
    };
    untrustedEmail: string;
  }[];
};

export type CenturionThreadAdjudicationReviewQueueItem = {
  componentRef: string;
  messageRefs: readonly string[];
  cacheDispositions: readonly CenturionThreadAdjudicationCacheDisposition[];
  reasonCodes: readonly CenturionThreadAdjudicationReasonCode[];
};

export type CenturionThreadCorrectionLedgerRow = {
  legacyRef: string;
  messageId: string;
  status: 'mapped' | 'missing_message';
  componentRef: string | null;
  componentState: ThreadState | null;
  outcome: ThreadState | 'unresolvable';
  reasonCodes: readonly CenturionThreadAdjudicationReasonCode[];
  evidenceRefs: readonly string[];
};

export type CenturionThreadAdjudicationReceipt = {
  schema: 'centurion_thread_adjudication_receipt_v1';
  corpusCount: number;
  messageCount: number;
  componentCount: number;
  cacheReusedCount: number;
  reviewQueueCount: number;
  outputDigest: string;
};

export type CenturionThreadAdjudicationResult = {
  schema: typeof CENTURION_THREAD_ADJUDICATION_SCHEMA;
  turns: readonly CenturionThreadAdjudicationTurn[];
  annotations: readonly CenturionThreadTurnAnnotation[];
  quoteCoverage: readonly CenturionThreadQuoteCoverageAnnotation[];
  cacheRecords: readonly CenturionThreadAdjudicationCacheRecord[];
  reviewQueue: readonly CenturionThreadAdjudicationReviewQueueItem[];
  reviewPackets: readonly CenturionThreadExceptionReviewPacket[];
  correctionLedger: readonly CenturionThreadCorrectionLedgerRow[];
  threadIntelligence: CenturionThreadIntelligenceResult;
  receipt: CenturionThreadAdjudicationReceipt;
};

export type CenturionThreadAdjudicationInput = {
  roster: CenturionThreadIntelligenceRoster;
  corpora: readonly unknown[];
  identityRulesVersion: string;
  classifierVersion: string;
  metricDefinitionVersion: string;
  cacheRecords?: unknown;
  trustedCacheRecords?: unknown;
  reviewDecisions?: unknown;
  legacyNoObservedResponses?: unknown;
};

const trustedCacheRecordsMarker = Symbol(
  'centurion-thread-adjudication-trusted-cache-records',
);

type TrustedCacheRecords = {
  readonly [trustedCacheRecordsMarker]: true;
  readonly records: readonly CenturionThreadAdjudicationCacheRecord[];
};

type Candidate = {
  classification: CenturionThreadAdjudicationClassification | null;
  operationalKind: 'semantic' | 'staff_response';
  task2Annotation: CenturionThreadTask2AnnotationValue;
  annotationFinal: boolean;
  reasonCodes: readonly CenturionThreadAdjudicationReasonCode[];
};

type ComponentContext = {
  component: ThreadConversationComponent;
  messages: readonly CenturionThreadStateCorpusMessage[];
  messageRefs: ReadonlyMap<string, string>;
  componentRef: string;
  contextDigest: string;
  evidenceRefs: readonly string[];
  sourceBindings: readonly z.infer<typeof sourceBindingSchema>[];
  snapshotProvenance: readonly z.infer<typeof snapshotProvenanceSchema>[];
};

function fail(code: string): never {
  throw new Error(code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('CENTURION_THREAD_ADJUDICATION_INPUT_INVALID');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  fail('CENTURION_THREAD_ADJUDICATION_INPUT_INVALID');
}

function normalizeText(value: string | null): string {
  return (value ?? '')
    .normalize('NFKC')
    .replace(/\r\n?/gu, '\n')
    .trim();
}

function normalizedIdentifier(value: string, code: string): string {
  const normalized = normalizeText(value);
  if (!normalized) fail(code);
  return normalized;
}

function normalizedVersion(value: string, code: string): string {
  const normalized = normalizedIdentifier(value, code);
  if (!VERSION.test(normalized)) fail(code);
  return normalized;
}

function normalizeIdentity(value: string): string {
  const normalized = normalizeText(value);
  const bracketed = normalized.match(/<([^<>\s]+)>/u)?.[1];
  const candidate = bracketed ?? normalized;
  const email = candidate.match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu,
  )?.[0];
  return (email ?? candidate).toLocaleLowerCase('en-US');
}

function normalizedRosterSnapshot(
  roster: CenturionThreadIntelligenceRoster,
): {
  identities: ReadonlySet<string>;
  digest: string;
} {
  const identities = new Set<string>();
  for (const value of roster.identities) {
    const identity = normalizeIdentity(value);
    if (!identity || identities.has(identity)) {
      fail('CENTURION_THREAD_ADJUDICATION_ROSTER_INVALID');
    }
    identities.add(identity);
  }
  if (identities.size === 0) {
    fail('CENTURION_THREAD_ADJUDICATION_ROSTER_INVALID');
  }
  const authorizedTransportIds = [...new Set(roster.authorizedTransportIds)]
    .map((transportId) =>
      normalizedIdentifier(
        transportId,
        'CENTURION_THREAD_ADJUDICATION_ROSTER_INVALID',
      ),
    )
    .sort();
  return {
    identities,
    digest: sha256(
      stableJson({
        identities: [...identities].sort(),
        authorizedTransportIds,
      }),
    ),
  };
}

function messageRef(message: CenturionThreadStateCorpusMessage): string {
  return `m_${sha256(
    stableJson({
      transportId: message.transportId,
      messageId: message.id,
    }),
  )}`;
}

function task2AnnotationFor(
  classification: CenturionThreadAdjudicationClassification,
): Candidate {
  switch (classification) {
    case 'new_reservation_request':
      return {
        classification,
        operationalKind: 'semantic',
        task2Annotation: {
          intent: 'actionable_request',
          actionability: 'actionable',
        },
        annotationFinal: true,
        reasonCodes: ['strict_new_reservation_pattern'],
      };
    case 'quote_acceptance':
      return {
        classification,
        operationalKind: 'semantic',
        task2Annotation: {
          intent: 'customer_acknowledgement_or_confirmation',
          actionability: 'non_actionable',
        },
        annotationFinal: true,
        reasonCodes: ['recognized_quote_acceptance'],
      };
    case 'booking_instruction':
      return {
        classification,
        operationalKind: 'semantic',
        task2Annotation: {
          intent: 'customer_acknowledgement_or_confirmation',
          actionability: 'non_actionable',
        },
        annotationFinal: true,
        reasonCodes: ['recognized_booking_instruction'],
      };
    case 'customer_acknowledgement':
      return {
        classification,
        operationalKind: 'semantic',
        task2Annotation: {
          intent: 'customer_acknowledgement_or_confirmation',
          actionability: 'non_actionable',
        },
        annotationFinal: true,
        reasonCodes: ['recognized_customer_acknowledgement'],
      };
    case 'internal_handoff':
      return {
        classification,
        operationalKind: 'semantic',
        task2Annotation: {
          intent: 'internal_handoff',
          actionability: 'non_actionable',
        },
        annotationFinal: true,
        reasonCodes: ['recognized_internal_handoff'],
      };
    case 'unrelated_follow_up':
      return {
        classification,
        operationalKind: 'semantic',
        task2Annotation: {
          intent: 'non_actionable',
          actionability: 'non_actionable',
        },
        annotationFinal: true,
        reasonCodes: ['recognized_unrelated_follow_up'],
      };
    case 'automated_or_non_actionable':
      return {
        classification,
        operationalKind: 'semantic',
        task2Annotation: {
          intent: 'automated_or_non_actionable',
          actionability: 'non_actionable',
        },
        annotationFinal: true,
        reasonCodes: ['recognized_automated_message'],
      };
    case 'ambiguous':
      return ambiguousCandidate('unrecognized_external_turn');
  }
}

function ambiguousCandidate(
  reason: CenturionThreadAdjudicationReasonCode,
): Candidate {
  return {
    classification: 'ambiguous',
    operationalKind: 'semantic',
    task2Annotation: {
      intent: 'ambiguous',
      actionability: 'ambiguous',
    },
    annotationFinal: false,
    reasonCodes: [reason],
  };
}

function staffResponseCandidate(): Candidate {
  return {
    classification: null,
    operationalKind: 'staff_response',
    task2Annotation: {
      intent: 'staff_response',
      actionability: 'non_actionable',
    },
    annotationFinal: true,
    reasonCodes: ['recognized_staff_response'],
  };
}

function textForClassification(
  message: CenturionThreadStateCorpusMessage,
): string {
  return [message.subject, message.textBody ?? '']
    .join('\n')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/gu, ' ')
    .trim();
}

function htmlToPlainText(value: string | null): string {
  return (value ?? '')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&(?:lt|#60);/giu, '<')
    .replace(/&(?:gt|#62);/giu, '>')
    .replace(/&amp;/giu, '&');
}

function promptInspectionText(
  message: CenturionThreadStateCorpusMessage,
): string {
  return normalizeText(
    [message.subject, message.textBody ?? '', htmlToPlainText(message.htmlBody)].join(
      '\n',
    ),
  ).toLocaleLowerCase('en-US');
}

function currentUnquotedInboundText(value: string | null): string {
  const lines = normalizeText(value).split('\n');
  const boundary = lines.findIndex((line) =>
    /(?:^\s*>|^\s*(?:from|sent|to|subject|message[- ]?id)\s*:|^\s*on\s+.+\s+wrote:|^\s*(?:[-_]{3,}\s*)?(?:original|forwarded)\s+message)/iu.test(
      line,
    ),
  );
  return lines
    .slice(0, boundary === -1 ? lines.length : boundary)
    .join('\n')
    .toLocaleLowerCase('en-US')
    .trim();
}

function hasPromptInjectionLikeContent(value: string): boolean {
  return /(?:\b(?:ignore|disregard|override|do\s+not\s+follow|don't\s+follow|never\s+follow)\s+(?:all\s+)?(?:the\s+)?(?:previous|prior)\s+(?:instructions?|rules?)\b|\b(?:system\s+prompt|developer\s+message|jailbreak)\b)/iu.test(
    value,
  );
}

function isAutomated(value: string): boolean {
  return /\b(?:automatic reply|auto-reply|out of office|delivery status notification|mailer-daemon|undeliverable)\b/iu.test(
    value,
  );
}

function isAcknowledgement(value: string): boolean {
  const normalized = value.replace(/[.!]+$/u, '').trim();
  return /^(?:thank(?:s| you)(?:[,\s]+(?:noted|received))?|noted|received(?: with thanks)?|ok(?:,?\s*thank you)?)$/iu.test(
    normalized,
  );
}

function isUnrelatedFollowUp(value: string): boolean {
  return /\b(?:unsubscribe|remove me from (?:this )?mailing list|wrong recipient|not related to (?:a )?reservation)\b/iu.test(
    value,
  );
}

function isQuoteAcceptance(value: string): boolean {
  return /\b(?:accept(?:ing|ed)? (?:the )?quote|yes[,.]?\s*(?:please\s*)?(?:proceed|book)|please\s+proceed(?:\s+with (?:the )?quote)?)\b/iu.test(
    value,
  );
}

function isBookingInstruction(value: string): boolean {
  return /\b(?:please\s+)?(?:go ahead and\s+)?(?:book|reserve|confirm)\s+(?:the\s+)?(?:quoted\s+)?(?:room|booking|reservation)\b/iu.test(
    value,
  );
}

function hasDateRange(value: string): boolean {
  return /(?:\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\bfrom\b.+?\bto\b)/iu.test(
    value,
  );
}

function isStrictNewReservationRequest(value: string): boolean {
  return (
    /\b(?:could you|can you|would like|we would like|please|request|looking for|book)\b/iu.test(
      value,
    ) &&
    /\b(?:room|accommodation|stay|reservation)\b/iu.test(value) &&
    hasDateRange(value) &&
    /\b(?:availability|available|book)\b/iu.test(value)
  );
}

function quoteCoverageForMessage(
  message: CenturionThreadStateCorpusMessage,
  internalIdentities: ReadonlySet<string>,
): CenturionThreadQuoteCoverageAnnotation['status'] {
  const text = message.textBody;
  if (!text) return message.htmlBody ? 'limited' : 'no_quote';
  const wasTruncated =
    text.length > MAX_QUOTE_CHARACTERS ||
    text.split('\n').length > MAX_QUOTE_LINES;
  if (wasTruncated) return 'limited';

  const lines = text.split('\n');
  const quoteLike = lines.some((line) =>
    /(?:^\s*>|^\s*(?:from|sent|to|subject|message[- ]?id)\s*:|^\s*on\s+.+\s+wrote:|^\s*el\s+.+\s+escribió:|^\s*(?:[-_]{3,}\s*)?(?:original|forwarded)\s+message)/iu.test(
      line,
    ),
  );
  if (!quoteLike) return 'no_quote';
  if (lines.some((line) => /^\s*>/u.test(line))) return 'limited';

  const hasKnownOnWrote = lines.some((line) => {
    const source = line.match(/^\s*on\s+(.+?)\s+wrote:\s*$/iu)?.[1];
    return Boolean(source && internalIdentities.has(normalizeIdentity(source)));
  });
  const knownOutlookHeader = lines.some((line, index) => {
    const source = line.match(/^\s*from\s*:\s*(.+?)\s*$/iu)?.[1];
    if (!source || !internalIdentities.has(normalizeIdentity(source))) {
      return false;
    }
    return lines
      .slice(index + 1, Math.min(lines.length, index + 7))
      .some((candidate) => /^\s*(?:sent|to|subject)\s*:/iu.test(candidate));
  });
  return hasKnownOnWrote || knownOutlookHeader
    ? 'english_structural_complete'
    : 'limited';
}

function isInternalOnly(
  message: CenturionThreadStateCorpusMessage,
  identities: ReadonlySet<string>,
): boolean {
  const recipients = [
    ...message.participants.to,
    ...message.participants.cc,
    ...message.participants.bcc,
  ].map(normalizeIdentity);
  return (
    recipients.length > 0 &&
    recipients.every((recipient) => identities.has(recipient))
  );
}

function hasExternalRecipient(
  message: CenturionThreadStateCorpusMessage,
  identities: ReadonlySet<string>,
): boolean {
  const recipients = [
    ...message.participants.to,
    ...message.participants.cc,
    ...message.participants.bcc,
  ].map(normalizeIdentity);
  return recipients.some((recipient) => !identities.has(recipient));
}

function isPriorStaffResponse(
  message: CenturionThreadStateCorpusMessage,
  identities: ReadonlySet<string>,
): boolean {
  return (
    message.direction === 'outbound' &&
    identities.has(normalizeIdentity(message.participants.from)) &&
    hasExternalRecipient(message, identities)
  );
}

function hasStrictPriorQuotationEvidence(input: {
  message: CenturionThreadStateCorpusMessage;
  priorMessages: readonly CenturionThreadStateCorpusMessage[];
  component: ThreadConversationComponent;
  internalIdentities: ReadonlySet<string>;
}): boolean {
  const isExplicitQuotation = (message: CenturionThreadStateCorpusMessage): boolean =>
    /\b(?:quote|quotation)\b/iu.test(
      `${message.subject}\n${message.textBody ?? ''}`,
    );
  const matchingPriorStaffMessage = (
    message: CenturionThreadStateCorpusMessage,
    quotedMessageIds: ReadonlySet<string>,
  ): boolean =>
    message.transportId === input.message.transportId &&
    isPriorStaffResponse(message, input.internalIdentities) &&
    message.headers.messageId !== null &&
    quotedMessageIds.has(message.headers.messageId) &&
    isExplicitQuotation(message);

  const hasStructuralPriorQuotation = input.component.quotedEvidence.some(
    (evidence) =>
      evidence.sourceMessageId === input.message.id &&
      evidence.quotedMessageId !== null &&
      input.priorMessages.some(
        (message) =>
          normalizeIdentity(evidence.senderIdentity) ===
            normalizeIdentity(message.participants.from) &&
          matchingPriorStaffMessage(
            message,
            new Set([evidence.quotedMessageId!]),
          ),
      ),
  );
  if (hasStructuralPriorQuotation) {
    return true;
  }

  const replyHeaders = new Set(
    [
      input.message.headers.inReplyTo,
      ...input.message.headers.references,
    ].filter((value): value is string => value !== null),
  );
  return input.priorMessages.some((message) => {
    if (
      message.transportId !== input.message.transportId ||
      !matchingPriorStaffMessage(message, replyHeaders)
    ) {
      return false;
    }
    return true;
  });
}

function sortMessages(
  messages: readonly CenturionThreadStateCorpusMessage[],
): readonly CenturionThreadStateCorpusMessage[] {
  return [...messages].sort(
    (left, right) => {
      const epochDifference =
        new Date(left.eventAt).getTime() - new Date(right.eventAt).getTime();
      if (epochDifference !== 0) return epochDifference;
      return (
        left.transportId.localeCompare(right.transportId) ||
        left.id.localeCompare(right.id)
      );
    },
  );
}

function classifyDeterministically(input: {
  message: CenturionThreadStateCorpusMessage;
  priorMessages: readonly CenturionThreadStateCorpusMessage[];
  component: ThreadConversationComponent;
  quoteCoverage: CenturionThreadQuoteCoverageAnnotation['status'];
  internalIdentities: ReadonlySet<string>;
}): Candidate {
  const sender = normalizeIdentity(input.message.participants.from);
  const knownInternalSender = input.internalIdentities.has(sender);
  const text = textForClassification(input.message);
  const body = currentUnquotedInboundText(input.message.textBody);

  if (hasPromptInjectionLikeContent(promptInspectionText(input.message))) {
    return ambiguousCandidate('prompt_injection_like_content');
  }
  if (input.quoteCoverage === 'limited') {
    return ambiguousCandidate('quote_coverage_limited');
  }
  if (knownInternalSender) {
    if (isInternalOnly(input.message, input.internalIdentities)) {
      return task2AnnotationFor('internal_handoff');
    }
    if (
      input.message.direction === 'outbound' &&
      hasExternalRecipient(input.message, input.internalIdentities)
    ) {
      return staffResponseCandidate();
    }
    return ambiguousCandidate('unsupported_direction_or_identity');
  }
  if (input.message.direction !== 'inbound') {
    return ambiguousCandidate('unsupported_direction_or_identity');
  }
  if (isAutomated(text)) {
    return task2AnnotationFor('automated_or_non_actionable');
  }

  const priorStaffEvidence = hasStrictPriorQuotationEvidence(input);

  if (priorStaffEvidence) {
    if (isQuoteAcceptance(body)) return task2AnnotationFor('quote_acceptance');
    if (isBookingInstruction(body)) {
      return task2AnnotationFor('booking_instruction');
    }
    if (isAcknowledgement(body)) {
      return task2AnnotationFor('customer_acknowledgement');
    }
    return ambiguousCandidate('continuation_without_safe_outcome');
  }

  if (isQuoteAcceptance(body) || isBookingInstruction(body)) {
    return ambiguousCandidate('continuation_without_safe_outcome');
  }
  if (input.priorMessages.length > 0) {
    if (isAcknowledgement(body)) {
      return task2AnnotationFor('customer_acknowledgement');
    }
    if (isUnrelatedFollowUp(body)) {
      return task2AnnotationFor('unrelated_follow_up');
    }
    return ambiguousCandidate('non_initial_external_turn');
  }
  if (isAcknowledgement(body)) {
    return task2AnnotationFor('customer_acknowledgement');
  }
  if (isUnrelatedFollowUp(body)) {
    return task2AnnotationFor('unrelated_follow_up');
  }
  if (isStrictNewReservationRequest(text)) {
    return task2AnnotationFor('new_reservation_request');
  }
  return ambiguousCandidate('unrecognized_external_turn');
}

function validateCacheRecordSemantics(
  record: CenturionThreadAdjudicationCacheRecord,
): void {
  if (
    record.provenance.componentContextDigest !==
      record.componentContextDigest ||
    record.provenance.identityRulesVersion !== record.key.identityRulesVersion ||
    record.provenance.classifierVersion !== record.key.classifierVersion ||
    record.provenance.metricDefinitionVersion !== record.key.metricDefinitionVersion ||
    !record.provenance.sourceBindings.some(
      (binding) =>
        binding.messageRef === record.messageRef &&
        binding.transportId === record.key.transportId &&
        binding.sourceDigest === record.key.sourceDigest,
    )
  ) {
    fail('CENTURION_THREAD_ADJUDICATION_CACHE_INVALID');
  }
  const candidate: Candidate = {
    classification: record.classification,
    operationalKind: record.operationalKind,
    task2Annotation: record.task2Annotation,
    annotationFinal: record.annotationFinal,
    reasonCodes: record.reasonCodes,
  };
  if (candidate.operationalKind === 'staff_response') {
    if (
      candidate.classification !== null ||
      candidate.task2Annotation.intent !== 'staff_response' ||
      candidate.task2Annotation.actionability !== 'non_actionable' ||
      !candidate.annotationFinal
    ) {
      fail('CENTURION_THREAD_ADJUDICATION_CACHE_INVALID');
    }
    return;
  }
  if (!candidate.classification) {
    fail('CENTURION_THREAD_ADJUDICATION_CACHE_INVALID');
  }
  const expected = task2AnnotationFor(candidate.classification);
  if (
    expected.task2Annotation.intent !== candidate.task2Annotation.intent ||
    expected.task2Annotation.actionability !==
      candidate.task2Annotation.actionability ||
    expected.annotationFinal !== candidate.annotationFinal
  ) {
    fail('CENTURION_THREAD_ADJUDICATION_CACHE_INVALID');
  }
}

export function parseCenturionThreadAdjudicationCacheRecords(
  value: unknown,
): readonly CenturionThreadAdjudicationCacheRecord[] {
  const parsed = z.array(cacheRecordSchema).safeParse(value);
  if (!parsed.success) fail('CENTURION_THREAD_ADJUDICATION_CACHE_INVALID');
  for (const record of parsed.data) validateCacheRecordSemantics(record);
  return parsed.data;
}

export function trustCenturionThreadAdjudicationCacheRecords(
  value: unknown,
): TrustedCacheRecords {
  return Object.freeze({
    [trustedCacheRecordsMarker]: true as const,
    records: parseCenturionThreadAdjudicationCacheRecords(value),
  });
}

function trustedCacheRecordsFrom(
  value: unknown,
): readonly CenturionThreadAdjudicationCacheRecord[] {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as Partial<TrustedCacheRecords>)[trustedCacheRecordsMarker] !== true
  ) {
    return [];
  }
  return (value as TrustedCacheRecords).records;
}

function parseLegacyNoObservedResponses(
  value: unknown | undefined,
): readonly CenturionLegacyNoObservedResponseRecord[] {
  if (value === undefined) return [];
  const parsed = z.array(legacyNoObservedResponseSchema).safeParse(value);
  if (!parsed.success) {
    fail('CENTURION_THREAD_ADJUDICATION_LEGACY_RECORD_INVALID');
  }
  const refs = new Set<string>();
  for (const record of parsed.data) {
    if (refs.has(record.legacyRef)) {
      fail('CENTURION_THREAD_ADJUDICATION_LEGACY_RECORD_INVALID');
    }
    refs.add(record.legacyRef);
  }
  return parsed.data;
}

export function parseCenturionThreadExceptionReviewDecision(
  value: unknown,
): CenturionThreadExceptionReviewDecision {
  const parsed = reviewDecisionSchema.safeParse(value);
  if (!parsed.success) {
    fail('CENTURION_THREAD_ADJUDICATION_REVIEW_DECISION_INVALID');
  }
  const seen = new Set<string>();
  for (const decision of parsed.data.decisions) {
    if (seen.has(decision.messageRef)) {
      fail('CENTURION_THREAD_ADJUDICATION_REVIEW_DECISION_INVALID');
    }
    seen.add(decision.messageRef);
    const expected = task2AnnotationFor(decision.classification);
    if (expected.task2Annotation.actionability !== decision.actionability) {
      fail('CENTURION_THREAD_ADJUDICATION_REVIEW_DECISION_INVALID');
    }
  }
  return parsed.data;
}

type AppliedReviewDecision = {
  candidate: Candidate;
  provenance: z.infer<typeof reviewedCacheProvenanceSchema>;
};

function applyReviewDecisions(input: {
  packets: readonly CenturionThreadExceptionReviewPacket[];
  decisions: unknown | undefined;
}): ReadonlyMap<string, AppliedReviewDecision> {
  if (input.decisions === undefined) return new Map();
  const parsed = z.array(reviewDecisionSchema).safeParse(input.decisions);
  if (!parsed.success) {
    fail('CENTURION_THREAD_ADJUDICATION_REVIEW_DECISION_INVALID');
  }
  const packetsByRef = new Map(
    input.packets.map((packet) => [packet.packetRef, packet]),
  );
  const reviewedMessages = new Map<string, AppliedReviewDecision>();
  const seenPackets = new Set<string>();

  for (const decision of parsed.data) {
    if (seenPackets.has(decision.packetRef)) {
      fail('CENTURION_THREAD_ADJUDICATION_REVIEW_DECISION_INVALID');
    }
    seenPackets.add(decision.packetRef);
    const packet = packetsByRef.get(decision.packetRef);
    if (
      !packet ||
      decision.packetDigest !== packet.packetDigest ||
      decision.componentRef !== packet.componentRef ||
      decision.componentContextDigest !== packet.componentContextDigest ||
      stableJson(decision.sourceBindings) !== stableJson(packet.sourceBindings) ||
      decision.identityRulesVersion !== packet.identityRulesVersion ||
      decision.classifierVersion !== packet.classifierVersion ||
      decision.metricDefinitionVersion !== packet.metricDefinitionVersion
    ) {
      fail('CENTURION_THREAD_ADJUDICATION_REVIEW_DECISION_INVALID');
    }
    const targetRefs = new Set(packet.targetMessageRefs);
    const decisionRefs = new Set<string>();
    for (const reviewed of decision.decisions) {
      if (
        decisionRefs.has(reviewed.messageRef) ||
        !targetRefs.has(reviewed.messageRef) ||
        reviewedMessages.has(reviewed.messageRef)
      ) {
        fail('CENTURION_THREAD_ADJUDICATION_REVIEW_DECISION_INVALID');
      }
      decisionRefs.add(reviewed.messageRef);
      const candidate = task2AnnotationFor(reviewed.classification);
      if (candidate.task2Annotation.actionability !== reviewed.actionability) {
        fail('CENTURION_THREAD_ADJUDICATION_REVIEW_DECISION_INVALID');
      }
      if (reviewed.classification === 'ambiguous') {
        continue;
      }
      reviewedMessages.set(reviewed.messageRef, {
        candidate,
        provenance: {
          kind: 'review_decision',
          packetRef: packet.packetRef,
          packetDigest: packet.packetDigest,
          componentContextDigest: packet.componentContextDigest,
          sourceBindings: [...packet.sourceBindings],
          snapshotProvenance: [...packet.snapshotProvenance],
          identityRulesVersion: packet.identityRulesVersion,
          classifierVersion: packet.classifierVersion,
          metricDefinitionVersion: packet.metricDefinitionVersion,
        },
      });
    }
    if (
      decisionRefs.size !== targetRefs.size ||
      [...targetRefs].some((messageRef) => !decisionRefs.has(messageRef))
    ) {
      fail('CENTURION_THREAD_ADJUDICATION_REVIEW_DECISION_INVALID');
    }
  }
  return reviewedMessages;
}

function sameCacheKey(
  left: CenturionThreadAdjudicationCacheKey,
  right: CenturionThreadAdjudicationCacheKey,
): boolean {
  return (
    left.transportId === right.transportId &&
    left.sourceDigest === right.sourceDigest &&
    left.identityRulesVersion === right.identityRulesVersion &&
    left.classifierVersion === right.classifierVersion &&
    left.metricDefinitionVersion === right.metricDefinitionVersion
  );
}

function sameRulesKey(
  left: CenturionThreadAdjudicationCacheKey,
  right: CenturionThreadAdjudicationCacheKey,
): boolean {
  return (
    left.transportId === right.transportId &&
    left.identityRulesVersion === right.identityRulesVersion &&
    left.classifierVersion === right.classifierVersion &&
    left.metricDefinitionVersion === right.metricDefinitionVersion
  );
}

function cacheDispositionFor(input: {
  records: readonly CenturionThreadAdjudicationCacheRecord[];
  key: CenturionThreadAdjudicationCacheKey;
  messageRef: string;
  componentContextDigest: string;
  candidate: Candidate;
}): {
  disposition: CenturionThreadAdjudicationCacheDisposition;
  candidate: Candidate;
  record?: CenturionThreadAdjudicationCacheRecord;
} {
  const matchingMessage = input.records.filter(
    (record) => record.messageRef === input.messageRef,
  );
  const exactKey = matchingMessage.filter((record) =>
    sameCacheKey(record.key, input.key),
  );
  const exactContext = exactKey.filter(
    (record) => record.componentContextDigest === input.componentContextDigest,
  );
  if (exactContext.length > 1) {
    return {
      disposition: 'evidence_conflict',
      candidate: ambiguousCandidate('cache_evidence_conflict'),
    };
  }
  if (exactContext.length === 1) {
    const record = exactContext[0]!;
    return {
      disposition: 'cache_reused',
      candidate: {
        classification: record.classification,
        operationalKind: record.operationalKind,
        task2Annotation: record.task2Annotation,
        annotationFinal: record.annotationFinal,
        reasonCodes: record.reasonCodes,
      },
      record,
    };
  }
  if (exactKey.length > 0) {
    return {
      disposition: 'component_context_changed',
      candidate: input.candidate,
    };
  }
  if (matchingMessage.some((record) => sameRulesKey(record.key, input.key))) {
    return {
      disposition: 'source_changed',
      candidate: input.candidate,
    };
  }
  if (matchingMessage.length > 0) {
    return {
      disposition: 'rules_version_changed',
      candidate: input.candidate,
    };
  }
  return { disposition: 'new', candidate: input.candidate };
}

function reviewRequired(
  candidate: Candidate,
  cacheDisposition: CenturionThreadAdjudicationCacheDisposition,
): boolean {
  return (
    !candidate.annotationFinal ||
    cacheDisposition === 'component_context_changed' ||
    cacheDisposition === 'rules_version_changed' ||
    cacheDisposition === 'source_changed' ||
    cacheDisposition === 'evidence_conflict'
  );
}

function cacheReason(
  disposition: CenturionThreadAdjudicationCacheDisposition,
): CenturionThreadAdjudicationReasonCode | null {
  switch (disposition) {
    case 'cache_reused':
      return 'cache_reused';
    case 'component_context_changed':
      return 'cache_component_context_changed';
    case 'rules_version_changed':
      return 'cache_rules_version_changed';
    case 'source_changed':
      return 'cache_source_changed';
    case 'evidence_conflict':
      return 'cache_evidence_conflict';
    case 'new':
      return null;
  }
}

function dedupeReasonCodes(
  codes: readonly CenturionThreadAdjudicationReasonCode[],
): CenturionThreadAdjudicationReasonCode[] {
  return [...new Set(codes)];
}

function componentContexts(input: {
  components: readonly ThreadConversationComponent[];
  corpora: readonly CenturionThreadStateCorpus[];
  quoteCoverage: readonly CenturionThreadQuoteCoverageAnnotation[];
  rosterDigest: string;
  identityRulesVersion: string;
}): readonly ComponentContext[] {
  const messages = input.corpora.flatMap((corpus) => corpus.messages);
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const corpusByTransport = new Map(
    input.corpora.map((corpus) => [corpus.source.transportId, corpus]),
  );
  return input.components.map((component) => {
    const componentMessages = sortMessages(
      component.chronology.map((turn) => {
        const message = messagesById.get(turn.messageId);
        if (!message) fail('CENTURION_THREAD_ADJUDICATION_COMPONENT_INVALID');
        return message;
      }),
    );
    const messageRefs = new Map(
      componentMessages.map((message) => [message.id, messageRef(message)]),
    );
    const coverage = componentMessages
      .map((message) => {
        const record = input.quoteCoverage.find(
          (candidate) => candidate.messageId === message.id,
        );
        if (!record) fail('CENTURION_THREAD_ADJUDICATION_COMPONENT_INVALID');
        return {
          messageRef: messageRefs.get(message.id)!,
          status: record.status,
        };
      })
      .sort((left, right) => left.messageRef.localeCompare(right.messageRef));
    const sourceBindings = componentMessages
      .map((message) => ({
        transportId: message.transportId,
        messageRef: messageRefs.get(message.id)!,
        sourceDigest: message.sourceDigest,
      }))
      .sort((left, right) => left.messageRef.localeCompare(right.messageRef));
    const snapshotProvenance = [...new Set(componentMessages.map((message) => message.transportId))]
      .sort()
      .map((transportId) => {
        const corpus = corpusByTransport.get(transportId);
        if (!corpus) fail('CENTURION_THREAD_ADJUDICATION_COMPONENT_INVALID');
        return {
          transportId,
          sourceSchemaVersion: corpus.source.schemaVersion,
          eventCutoff: corpus.source.eventCutoff,
          ingestCutoff: corpus.source.ingestCutoff,
          corpusSha256: corpus.manifest.corpusSha256,
        };
      });
    const digest = sha256(
      stableJson({
        messages: componentMessages
          .map((message) => ({
            messageRef: messageRefs.get(message.id)!,
            transportId: message.transportId,
            sourceDigest: message.sourceDigest,
          }))
          .sort((left, right) => left.messageRef.localeCompare(right.messageRef)),
        sourceBindings,
        identityRulesVersion: input.identityRulesVersion,
        rosterDigest: input.rosterDigest,
        quoteCoverage: coverage,
        quotedEvidence: component.quotedEvidence
          .map((evidence) => ({
            sourceMessageRef: messageRefs.get(evidence.sourceMessageId) ?? null,
            quotedMessageIdDigest: evidence.quotedMessageId
              ? sha256(evidence.quotedMessageId)
              : null,
            provenance: evidence.provenance,
          }))
          .sort((left, right) =>
            stableJson(left).localeCompare(stableJson(right)),
          ),
      }),
    );
    return {
      component,
      messages: componentMessages,
      messageRefs,
      componentRef: `c_${sha256(digest)}`,
      contextDigest: digest,
      evidenceRefs: [...messageRefs.values()].sort(),
      sourceBindings,
      snapshotProvenance,
    };
  });
}

function escapePacketDelimiters(value: string): string {
  return value.replace(
    /<<<(?:BEGIN|END)_UNTRUSTED_EMAIL_TEXT>>>/gu,
    (delimiter) =>
      delimiter.replaceAll('<', '\\u003C').replaceAll('>', '\\u003E'),
  );
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return '';
  let output = '';
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > maximumBytes) break;
    output += character;
    used += size;
  }
  return output;
}

function boundedUntrustedEmail(
  message: CenturionThreadStateCorpusMessage,
  maximumBytes: number,
): string {
  const raw = escapePacketDelimiters(
    [
      `SUBJECT: ${message.subject}`,
      `TEXT_BODY:\n${message.textBody ?? ''}`,
      `HTML_BODY:\n${message.htmlBody ?? ''}`,
    ].join('\n'),
  );
  const delimiterBytes = Buffer.byteLength(UNTRUSTED_EMAIL_START, 'utf8') +
    Buffer.byteLength(UNTRUSTED_EMAIL_END, 'utf8');
  const available = Math.max(
    0,
    Math.min(
      MAX_REVIEW_TURN_BYTES,
      maximumBytes - delimiterBytes,
    ),
  );
  const rawBytes = Buffer.byteLength(raw, 'utf8');
  const content = rawBytes <= available
    ? raw
    : available === 0
      ? ''
      : `${truncateUtf8(raw, Math.max(0, available - Buffer.byteLength('…', 'utf8')))}…`;
  return `${UNTRUSTED_EMAIL_START}${content}${UNTRUSTED_EMAIL_END}`;
}

type ReviewPacketTurn = CenturionThreadExceptionReviewPacket['turns'][number];

function serializedJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function fitUntrustedEmailToSerializedLimit(
  value: string,
  maximumBytes: number,
): string {
  if (serializedJsonBytes(value) <= maximumBytes) return value;
  if (
    !value.startsWith(UNTRUSTED_EMAIL_START) ||
    !value.endsWith(UNTRUSTED_EMAIL_END)
  ) {
    fail('CENTURION_THREAD_ADJUDICATION_REVIEW_PACKET_INVALID');
  }
  const base = `${UNTRUSTED_EMAIL_START}${UNTRUSTED_EMAIL_END}`;
  if (serializedJsonBytes(base) > maximumBytes) return base;
  const content = value.slice(
    UNTRUSTED_EMAIL_START.length,
    -UNTRUSTED_EMAIL_END.length,
  );
  const characters = [...content];
  let lower = 0;
  let upper = characters.length;
  let best = base;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = `${UNTRUSTED_EMAIL_START}${characters.slice(0, middle).join('')}${
      middle < characters.length ? '…' : ''
    }${UNTRUSTED_EMAIL_END}`;
    if (serializedJsonBytes(candidate) <= maximumBytes) {
      best = candidate;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return best;
}

export function buildCenturionThreadExceptionReviewPacket(input: {
  componentRef: string;
  componentContextDigest: string;
  sourceBindings: readonly z.infer<typeof sourceBindingSchema>[];
  snapshotProvenance: readonly z.infer<typeof snapshotProvenanceSchema>[];
  identityRulesVersion: string;
  classifierVersion: string;
  metricDefinitionVersion: string;
  messages: readonly CenturionThreadStateCorpusMessage[];
  messageRefs: ReadonlyMap<string, string>;
  targetMessageIds: readonly string[];
  turns: readonly Pick<
    CenturionThreadAdjudicationTurn,
    'messageId' | 'classification' | 'task2Annotation'
  >[];
}): CenturionThreadExceptionReviewPacket {
  if (!COMPONENT_REF.test(input.componentRef)) {
    fail('CENTURION_THREAD_ADJUDICATION_REVIEW_PACKET_INVALID');
  }
  if (
    !SHA256.test(input.componentContextDigest) ||
    input.targetMessageIds.length === 0 ||
    input.targetMessageIds.length > MAX_REVIEW_TARGETS_PER_PACKET
  ) {
    fail('CENTURION_THREAD_ADJUDICATION_REVIEW_PACKET_INVALID');
  }
  const byMessageId = new Map(input.turns.map((turn) => [turn.messageId, turn]));
  const targetIds = new Set(input.targetMessageIds);
  if (targetIds.size !== input.targetMessageIds.length) {
    fail('CENTURION_THREAD_ADJUDICATION_REVIEW_PACKET_INVALID');
  }
  const targetMessages = input.messages.filter((message) => targetIds.has(message.id));
  if (targetMessages.length !== targetIds.size) {
    fail('CENTURION_THREAD_ADJUDICATION_REVIEW_PACKET_INVALID');
  }
  const selectedIds = new Set(targetMessages.map((message) => message.id));
  const targetIndexes = targetMessages.map((target) =>
    input.messages.findIndex((message) => message.id === target.id),
  );
  const targetReplyHeaders = new Set(
    targetMessages.flatMap((message) => [
      ...(message.headers.inReplyTo ? [message.headers.inReplyTo] : []),
      ...message.headers.references,
    ]),
  );
  const contextCandidates = input.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => !selectedIds.has(message.id))
    .sort((left, right) => {
      const leftLinked =
        left.message.headers.messageId !== null &&
        targetReplyHeaders.has(left.message.headers.messageId);
      const rightLinked =
        right.message.headers.messageId !== null &&
        targetReplyHeaders.has(right.message.headers.messageId);
      if (leftLinked !== rightLinked) return leftLinked ? -1 : 1;
      const leftDistance = Math.min(
        ...targetIndexes.map((targetIndex) => Math.abs(left.index - targetIndex)),
      );
      const rightDistance = Math.min(
        ...targetIndexes.map((targetIndex) => Math.abs(right.index - targetIndex)),
      );
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      const leftPrior = targetIndexes.some((targetIndex) => left.index < targetIndex);
      const rightPrior = targetIndexes.some((targetIndex) => right.index < targetIndex);
      if (leftPrior !== rightPrior) return leftPrior ? -1 : 1;
      return left.index - right.index;
    });
  for (const { message } of contextCandidates) {
    if (selectedIds.size >= MAX_REVIEW_TURNS) break;
    selectedIds.add(message.id);
  }
  const selectedMessages = input.messages.filter((message) => selectedIds.has(message.id));
  const delimiterBytes =
    Buffer.byteLength(UNTRUSTED_EMAIL_START, 'utf8') +
    Buffer.byteLength(UNTRUSTED_EMAIL_END, 'utf8');
  let rawRemaining = 16 * 1024;
  const turns: ReviewPacketTurn[] = selectedMessages.map((message, index) => {
    const turn = byMessageId.get(message.id);
    const ref = input.messageRefs.get(message.id);
    if (!turn || !ref || !MESSAGE_REF.test(ref)) {
      fail('CENTURION_THREAD_ADJUDICATION_REVIEW_PACKET_INVALID');
    }
    const remainingDelimiterBudget =
      (selectedMessages.length - index - 1) * delimiterBytes;
    const untrustedEmail = boundedUntrustedEmail(
      message,
      rawRemaining - remainingDelimiterBudget,
    );
    rawRemaining -= Buffer.byteLength(untrustedEmail, 'utf8');
    return {
      messageRef: ref,
      target: targetIds.has(message.id),
      sourceDigest: message.sourceDigest,
      direction: message.direction,
      candidate: {
        classification: turn.classification,
        actionability: turn.task2Annotation.actionability,
      },
      untrustedEmail,
    };
  });
  const targetMessageRefs = targetMessages.map((message) => {
    const ref = input.messageRefs.get(message.id);
    if (!ref) fail('CENTURION_THREAD_ADJUDICATION_REVIEW_PACKET_INVALID');
    return ref;
  });
  const createPacket = (
    packetTurns: readonly ReviewPacketTurn[],
  ): CenturionThreadExceptionReviewPacket => {
    const packetBinding = {
      componentRef: input.componentRef,
      componentContextDigest: input.componentContextDigest,
      sourceBindings: input.sourceBindings,
      identityRulesVersion: input.identityRulesVersion,
      classifierVersion: input.classifierVersion,
      metricDefinitionVersion: input.metricDefinitionVersion,
      targetMessageRefs: [...targetMessageRefs].sort(),
      turns: packetTurns.map((turn) => ({
        messageRef: turn.messageRef,
        target: turn.target,
        sourceDigest: turn.sourceDigest,
        direction: turn.direction,
        candidate: turn.candidate,
        untrustedEmailDigest: sha256(turn.untrustedEmail),
      })),
    };
    const packetDigest = sha256(stableJson(packetBinding));
    return {
      schema: CENTURION_THREAD_EXCEPTION_REVIEW_PACKET_SCHEMA,
      packetRef: `p_${sha256(stableJson({ packetDigest, packetBinding }))}`,
      packetDigest,
      componentRef: input.componentRef,
      componentContextDigest: input.componentContextDigest,
      sourceBindings: input.sourceBindings,
      snapshotProvenance: input.snapshotProvenance,
      identityRulesVersion: input.identityRulesVersion,
      classifierVersion: input.classifierVersion,
      metricDefinitionVersion: input.metricDefinitionVersion,
      targetMessageRefs,
      contract: {
        decisionSchema: CENTURION_THREAD_EXCEPTION_REVIEW_DECISION_SCHEMA,
        classifications: CLASSIFICATIONS,
        freeTextAllowed: false,
      },
      omittedTurnCount: Math.max(0, input.messages.length - packetTurns.length),
      turns: packetTurns,
    };
  };

  let packet = createPacket(turns);
  if (serializedJsonBytes(packet) > MAX_REVIEW_PACKET_BYTES) {
    const baseTurns = turns.map((turn) => ({
      ...turn,
      untrustedEmail: `${UNTRUSTED_EMAIL_START}${UNTRUSTED_EMAIL_END}`,
    }));
    const basePacket = createPacket(baseTurns);
    let remainingSerializedBytes =
      MAX_REVIEW_PACKET_BYTES - serializedJsonBytes(basePacket);
    if (remainingSerializedBytes < 0) {
      fail('CENTURION_THREAD_ADJUDICATION_REVIEW_PACKET_INVALID');
    }
    const fittedTurns = turns.map((turn, index) => {
      const base = baseTurns[index]!;
      const baseBytes = serializedJsonBytes(base.untrustedEmail);
      const maximumBytes =
        baseBytes +
        Math.floor(remainingSerializedBytes / (turns.length - index));
      const untrustedEmail = fitUntrustedEmailToSerializedLimit(
        turn.untrustedEmail,
        maximumBytes,
      );
      remainingSerializedBytes -=
        serializedJsonBytes(untrustedEmail) - baseBytes;
      return { ...turn, untrustedEmail };
    });
    packet = createPacket(fittedTurns);
  }
  if (serializedJsonBytes(packet) > MAX_REVIEW_PACKET_BYTES) {
    fail('CENTURION_THREAD_ADJUDICATION_REVIEW_PACKET_INVALID');
  }
  return packet;
}

function reviewPacketsForContext(input: {
  context: ComponentContext;
  requiredTurns: readonly CenturionThreadAdjudicationTurn[];
  turns: readonly CenturionThreadAdjudicationTurn[];
  identityRulesVersion: string;
  classifierVersion: string;
  metricDefinitionVersion: string;
}): readonly CenturionThreadExceptionReviewPacket[] {
  const requiredIds = new Set(input.requiredTurns.map((turn) => turn.messageId));
  const orderedTargets = input.context.messages
    .filter((message) => requiredIds.has(message.id))
    .map((message) => message.id);
  if (orderedTargets.length !== requiredIds.size) {
    fail('CENTURION_THREAD_ADJUDICATION_COMPONENT_INVALID');
  }
  const packets: CenturionThreadExceptionReviewPacket[] = [];
  for (
    let start = 0;
    start < orderedTargets.length;
    start += MAX_REVIEW_TARGETS_PER_PACKET
  ) {
    packets.push(
      buildCenturionThreadExceptionReviewPacket({
        componentRef: input.context.componentRef,
        componentContextDigest: input.context.contextDigest,
        sourceBindings: input.context.sourceBindings,
        snapshotProvenance: input.context.snapshotProvenance,
        identityRulesVersion: input.identityRulesVersion,
        classifierVersion: input.classifierVersion,
        metricDefinitionVersion: input.metricDefinitionVersion,
        messages: input.context.messages,
        messageRefs: input.context.messageRefs,
        targetMessageIds: orderedTargets.slice(
          start,
          start + MAX_REVIEW_TARGETS_PER_PACKET,
        ),
        turns: input.turns,
      }),
    );
  }
  return packets;
}

function annotationForTurn(
  turn: CenturionThreadAdjudicationTurn,
): CenturionThreadTurnAnnotation {
  return {
    messageId: turn.messageId,
    intent: turn.task2Annotation.intent,
    actionability: turn.task2Annotation.actionability,
  };
}

function correctionLedgerFor(input: {
  legacy: readonly CenturionLegacyNoObservedResponseRecord[];
  turns: readonly CenturionThreadAdjudicationTurn[];
  components: readonly ThreadConversationComponent[];
  contexts: readonly ComponentContext[];
}): readonly CenturionThreadCorrectionLedgerRow[] {
  const turnByMessageId = new Map(input.turns.map((turn) => [turn.messageId, turn]));
  const componentByMessageId = new Map<string, ThreadConversationComponent>();
  for (const component of input.components) {
    for (const turn of component.chronology) {
      componentByMessageId.set(turn.messageId, component);
    }
  }
  const contextByMessageId = new Map<string, ComponentContext>();
  for (const context of input.contexts) {
    for (const message of context.messages) {
      contextByMessageId.set(message.id, context);
    }
  }
  return input.legacy.map((legacy) => {
    const turn = turnByMessageId.get(legacy.messageId);
    const component = componentByMessageId.get(legacy.messageId);
    const context = contextByMessageId.get(legacy.messageId);
    if (!turn || !component || !context) {
      return {
        legacyRef: legacy.legacyRef,
        messageId: legacy.messageId,
        status: 'missing_message',
        componentRef: null,
        componentState: null,
        outcome: 'unresolvable',
        reasonCodes: ['legacy_message_not_in_corpus'],
        evidenceRefs: [],
      };
    }
    return {
      legacyRef: legacy.legacyRef,
      messageId: legacy.messageId,
      status: 'mapped',
      componentRef: context.componentRef,
      componentState: component.state,
      outcome: component.state,
      reasonCodes: turn.reasonCodes,
      evidenceRefs: context.evidenceRefs,
    };
  });
}

function receiptFor(input: {
  corpora: readonly CenturionThreadStateCorpus[];
  turns: readonly CenturionThreadAdjudicationTurn[];
  contexts: readonly ComponentContext[];
  reviewQueue: readonly CenturionThreadAdjudicationReviewQueueItem[];
  cacheRecords: readonly CenturionThreadAdjudicationCacheRecord[];
  quoteCoverage: readonly CenturionThreadQuoteCoverageAnnotation[];
}): CenturionThreadAdjudicationReceipt {
  return {
    schema: 'centurion_thread_adjudication_receipt_v1',
    corpusCount: input.corpora.length,
    messageCount: input.turns.length,
    componentCount: input.contexts.length,
    cacheReusedCount: input.turns.filter(
      (turn) => turn.cacheDisposition === 'cache_reused',
    ).length,
    reviewQueueCount: input.reviewQueue.length,
    outputDigest: sha256(
      stableJson({
        cacheRecords: input.cacheRecords,
        quoteCoverage: input.quoteCoverage.map((record) => ({
          messageIdDigest: sha256(record.messageId),
          status: record.status,
        })),
      }),
    ),
  };
}

export function adjudicateCenturionThreadState(
  input: CenturionThreadAdjudicationInput,
): CenturionThreadAdjudicationResult {
  const identityRulesVersion = normalizedVersion(
    input.identityRulesVersion,
    'CENTURION_THREAD_ADJUDICATION_IDENTITY_RULES_VERSION_INVALID',
  );
  const classifierVersion = normalizedVersion(
    input.classifierVersion,
    'CENTURION_THREAD_ADJUDICATION_CLASSIFIER_VERSION_INVALID',
  );
  const metricDefinitionVersion = normalizedVersion(
    input.metricDefinitionVersion,
    'CENTURION_THREAD_ADJUDICATION_METRIC_DEFINITION_VERSION_INVALID',
  );
  if (!Array.isArray(input.corpora) || input.corpora.length === 0) {
    fail('CENTURION_THREAD_ADJUDICATION_CANONICAL_CORPORA_REQUIRED');
  }
  const corpora = input.corpora.map(parsePersistedCenturionThreadStateCorpus);
  const cacheRecords = trustedCacheRecordsFrom(input.trustedCacheRecords);
  const legacy = parseLegacyNoObservedResponses(input.legacyNoObservedResponses);
  const roster = normalizedRosterSnapshot(input.roster);
  const messages = corpora.flatMap((corpus) => corpus.messages);
  const messageIds = new Set<string>();
  for (const message of messages) {
    if (messageIds.has(message.id)) {
      fail('CENTURION_THREAD_ADJUDICATION_DUPLICATE_MESSAGE_ID');
    }
    messageIds.add(message.id);
  }
  const quoteCoverage = messages.map((message) => ({
    messageId: message.id,
    status: quoteCoverageForMessage(message, roster.identities),
  })) satisfies CenturionThreadQuoteCoverageAnnotation[];
  const provisionalAnnotations = messages.map(
    (message) =>
      ({
        messageId: message.id,
        intent: 'ambiguous',
        actionability: 'ambiguous',
      }) satisfies CenturionThreadTurnAnnotation,
  );
  const provisional = analyzeCenturionThreadIntelligence({
    roster: input.roster,
    corpora,
    quoteCoverage,
    annotations: provisionalAnnotations,
  });
  const contexts = componentContexts({
    components: provisional.components,
    corpora,
    quoteCoverage,
    rosterDigest: roster.digest,
    identityRulesVersion,
  });
  const quoteCoverageByMessageId = new Map(
    quoteCoverage.map((coverage) => [coverage.messageId, coverage.status]),
  );
  const turns: CenturionThreadAdjudicationTurn[] = [];
  const reusedCacheRecords = new Map<
    string,
    CenturionThreadAdjudicationCacheRecord
  >();

  for (const context of contexts) {
    for (let index = 0; index < context.messages.length; index += 1) {
      const message = context.messages[index]!;
      const coverage = quoteCoverageByMessageId.get(message.id);
      const ref = context.messageRefs.get(message.id);
      if (!coverage || !ref) fail('CENTURION_THREAD_ADJUDICATION_COMPONENT_INVALID');
      const deterministic = classifyDeterministically({
        message,
        priorMessages: context.messages.slice(0, index),
        component: context.component,
        quoteCoverage: coverage,
        internalIdentities: roster.identities,
      });
      const corpus = corpora.find(
        (candidate) =>
          candidate.source.transportId === message.transportId,
      );
      if (!corpus) {
        fail('CENTURION_THREAD_ADJUDICATION_COMPONENT_INVALID');
      }
      const key: CenturionThreadAdjudicationCacheKey = {
        transportId: message.transportId,
        sourceDigest: message.sourceDigest,
        identityRulesVersion,
        classifierVersion,
        metricDefinitionVersion,
      };
      const cache = cacheDispositionFor({
        records: cacheRecords,
        key,
        messageRef: ref,
        componentContextDigest: context.contextDigest,
        candidate: deterministic,
      });
      if (cache.record) reusedCacheRecords.set(ref, cache.record);
      const dispositionReason = cacheReason(cache.disposition);
      const candidate = cache.candidate;
      turns.push({
        messageId: message.id,
        messageRef: ref,
        componentRef: context.componentRef,
        componentContextDigest: context.contextDigest,
        classification: candidate.classification,
        operationalKind: candidate.operationalKind,
        task2Annotation: candidate.task2Annotation,
        quoteCoverage: coverage,
        annotationFinal: candidate.annotationFinal,
        reasonCodes: dedupeReasonCodes([
          ...candidate.reasonCodes,
          ...(dispositionReason ? [dispositionReason] : []),
        ]),
        cacheDisposition: cache.disposition,
        reviewRequired: reviewRequired(candidate, cache.disposition),
      });
    }
  }

  const pendingReviewQueue: CenturionThreadAdjudicationReviewQueueItem[] = [];
  for (const context of contexts) {
    const requiredTurns = turns.filter(
      (turn) =>
        turn.componentRef === context.componentRef && turn.reviewRequired,
    );
    if (requiredTurns.length === 0) continue;
    pendingReviewQueue.push({
      componentRef: context.componentRef,
      messageRefs: requiredTurns.map((turn) => turn.messageRef).sort(),
      cacheDispositions: [
        ...new Set(requiredTurns.map((turn) => turn.cacheDisposition)),
      ].sort() as CenturionThreadAdjudicationCacheDisposition[],
      reasonCodes: dedupeReasonCodes(
        requiredTurns.flatMap((turn) => turn.reasonCodes),
      ),
    });
  }
  const pendingReviewPackets = pendingReviewQueue.flatMap((item) => {
    const context = contexts.find(
      (candidate) => candidate.componentRef === item.componentRef,
    );
    if (!context) fail('CENTURION_THREAD_ADJUDICATION_COMPONENT_INVALID');
    const componentTurns = turns.filter(
      (turn) => turn.componentRef === context.componentRef,
    );
    return reviewPacketsForContext({
      context,
      requiredTurns: componentTurns.filter((turn) => turn.reviewRequired),
      turns: componentTurns,
      identityRulesVersion,
      classifierVersion,
      metricDefinitionVersion,
    });
  });
  const appliedReviews = applyReviewDecisions({
    packets: pendingReviewPackets,
    decisions: input.reviewDecisions,
  });
  const resolvedTurns = turns.map((turn) => {
    const applied = appliedReviews.get(turn.messageRef);
    if (!applied) return turn;
    return {
      ...turn,
      classification: applied.candidate.classification,
      operationalKind: applied.candidate.operationalKind,
      task2Annotation: applied.candidate.task2Annotation,
      annotationFinal: applied.candidate.annotationFinal,
      reasonCodes: dedupeReasonCodes(applied.candidate.reasonCodes),
      reviewRequired: false,
    };
  });
  const reviewQueue: CenturionThreadAdjudicationReviewQueueItem[] = [];
  for (const context of contexts) {
    const requiredTurns = resolvedTurns.filter(
      (turn) =>
        turn.componentRef === context.componentRef && turn.reviewRequired,
    );
    if (requiredTurns.length === 0) continue;
    reviewQueue.push({
      componentRef: context.componentRef,
      messageRefs: requiredTurns.map((turn) => turn.messageRef).sort(),
      cacheDispositions: [
        ...new Set(requiredTurns.map((turn) => turn.cacheDisposition)),
      ].sort() as CenturionThreadAdjudicationCacheDisposition[],
      reasonCodes: dedupeReasonCodes(
        requiredTurns.flatMap((turn) => turn.reasonCodes),
      ),
    });
  }
  const reviewPackets = reviewQueue.flatMap((item) => {
    const context = contexts.find(
      (candidate) => candidate.componentRef === item.componentRef,
    );
    if (!context) fail('CENTURION_THREAD_ADJUDICATION_COMPONENT_INVALID');
    const componentTurns = resolvedTurns.filter(
      (turn) => turn.componentRef === context.componentRef,
    );
    return reviewPacketsForContext({
      context,
      requiredTurns: componentTurns.filter((turn) => turn.reviewRequired),
      turns: componentTurns,
      identityRulesVersion,
      classifierVersion,
      metricDefinitionVersion,
    });
  });
  const annotations = resolvedTurns.map(annotationForTurn);
  const threadIntelligence = analyzeCenturionThreadIntelligence({
    roster: input.roster,
    corpora,
    quoteCoverage,
    annotations,
  });
  const cacheRecordsOut = resolvedTurns.flatMap((turn) => {
    const applied = appliedReviews.get(turn.messageRef);
    if (!applied) {
      const reused = reusedCacheRecords.get(turn.messageRef);
      return reused ? [reused] : [];
    }
    const message = messages.find((candidate) => candidate.id === turn.messageId);
    const context = contexts.find(
      (candidate) => candidate.componentRef === turn.componentRef,
    );
    const corpus = message
      ? corpora.find(
          (candidate) =>
            candidate.source.transportId === message.transportId,
        )
      : undefined;
    if (!message || !context || !corpus) {
      fail('CENTURION_THREAD_ADJUDICATION_COMPONENT_INVALID');
    }
    return [
      {
        schema: CENTURION_THREAD_ADJUDICATION_CACHE_SCHEMA,
        key: {
          transportId: message.transportId,
          sourceDigest: message.sourceDigest,
          identityRulesVersion,
          classifierVersion,
          metricDefinitionVersion,
        },
        messageRef: turn.messageRef,
        componentRef: turn.componentRef,
        componentContextDigest: turn.componentContextDigest,
        classification: turn.classification,
        operationalKind: turn.operationalKind,
        task2Annotation: turn.task2Annotation,
        annotationFinal: turn.annotationFinal,
        quoteCoverage: turn.quoteCoverage,
        reasonCodes: [...turn.reasonCodes],
        evidenceRefs: [...context.evidenceRefs],
        provenance: applied.provenance,
      } satisfies CenturionThreadAdjudicationCacheRecord,
    ];
  });
  const correctionLedger = correctionLedgerFor({
    legacy,
    turns: resolvedTurns,
    components: threadIntelligence.components,
    contexts,
  });
  const receipt = receiptFor({
    corpora,
    turns: resolvedTurns,
    contexts,
    reviewQueue,
    cacheRecords: cacheRecordsOut,
    quoteCoverage,
  });
  return {
    schema: CENTURION_THREAD_ADJUDICATION_SCHEMA,
    turns: resolvedTurns,
    annotations,
    quoteCoverage,
    cacheRecords: cacheRecordsOut,
    reviewQueue,
    reviewPackets,
    correctionLedger,
    threadIntelligence,
    receipt,
  };
}
