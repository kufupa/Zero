import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const CENTURION_AUDIT_SCHEMA_VERSION = 1 as const;
export const CENTURION_AUDIT_MAX_BODY_CHARS = 256_000;

export type AuditParentCandidate = {
  auditRef: string;
  messageIdHeader: string | null;
  fromAddress: string;
  direction: 'inbound' | 'outbound';
  createdAt: string;
  eventAt?: string;
};

export type HeaderResolution = {
  state: 'linked' | 'absent' | 'unresolved' | 'ambiguous' | 'malformed';
  kind: 'in_reply_to' | 'references' | null;
  parentRef: string | null;
  candidateCount?: number;
};

export type StructuralEvidence = 'none' | 'quote_or_reply_marker';
export type AutomationEvidence = 'none' | 'delivery_status' | 'suspected';
export type BodyState = 'usable' | 'too_large' | 'malformed';

const labelSchema = z.enum([
  'gold_header_linked',
  'gold_reference_linked',
  'possible_old_correspondent_reply_parent_unknown',
  'possible_reply_parent_unknown',
  'no_reply_evidence',
  'automation_system',
  'malformed_metadata',
  'unclassifiable',
]);

const classificationStateSchema = z.enum(['classified', 'ambiguous', 'unclassifiable']);

const corpusUseSchema = z.enum(['paired_evaluation', 'style_template_only', 'exclude']);

const opaqueEvidenceCodeSchema = z.enum([
  'delivery_status',
  'automation_suspected',
  'too_large',
  'malformed',
  'in_reply_to',
  'references',
  'malformed_header',
  'direct_header_ambiguous',
  'direct_header_unresolved',
  'old_correspondent',
  'reply_marker',
  'no_signal',
]);

export const opaqueAuditRowSchema = z
  .object({
    auditRef: z.string().regex(/^audit-[0-9a-f-]{36}$/),
    parentRef: z
      .string()
      .regex(/^audit-[0-9a-f-]{36}$/)
      .nullable(),
    label: labelSchema,
    classificationState: classificationStateSchema,
    evidence: z.array(opaqueEvidenceCodeSchema).min(1).max(4),
    reason: z.string().regex(/^[A-Z0-9_]+$/),
    candidateCount: z.number().int().nonnegative(),
    corpusUse: corpusUseSchema,
  })
  .strict();

export type OpaqueAuditRow = z.infer<typeof opaqueAuditRowSchema>;

function normalizeEmailAddress(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const angle = trimmed.match(/<([^<>\s]+)>/);
  return (angle?.[1] ?? trimmed).trim();
}

export function canonicalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const bracketed = [...trimmed.matchAll(/<([^<>\s]+)>/g)];
  if (bracketed.length > 1) return null;
  if (bracketed.length === 1) {
    const match = bracketed[0]!;
    if (trimmed !== match[0]) return null;
    return match[1]!.toLowerCase();
  }

  return /^[^\s<>]+@[^\s<>]+$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

function isEarlier(candidateAt: string, outboundAt: string): boolean {
  const candidateTime = Date.parse(candidateAt);
  const outboundTime = Date.parse(outboundAt);
  if (!Number.isFinite(candidateTime) || !Number.isFinite(outboundTime)) return false;
  return (
    candidateTime < outboundTime || (candidateTime === outboundTime && candidateAt < outboundAt)
  );
}

function isEligibleParent(
  candidate: AuditParentCandidate,
  sharedMailbox: string,
  outboundCreatedAt: string,
  outboundEventAt: string | undefined,
  centurionIdentities: readonly string[] = [sharedMailbox],
): boolean {
  return (
    candidate.direction === 'inbound' &&
    !new Set(centurionIdentities.map(normalizeEmailAddress)).has(
      normalizeEmailAddress(candidate.fromAddress),
    ) &&
    isEarlier(candidate.eventAt ?? candidate.createdAt, outboundEventAt ?? outboundCreatedAt)
  );
}

export function resolveCenturionHeaderParent(input: {
  sharedMailbox: string;
  centurionIdentities?: readonly string[];
  outboundCreatedAt: string;
  outboundEventAt?: string;
  inReplyTo: string | null;
  references: readonly string[];
  candidates: readonly AuditParentCandidate[];
}): HeaderResolution {
  const directKind =
    input.inReplyTo === null ? (input.references.length > 0 ? 'references' : null) : 'in_reply_to';
  const directValue =
    directKind === 'in_reply_to'
      ? input.inReplyTo
      : directKind === 'references'
        ? (input.references.at(-1) ?? null)
        : null;

  if (directKind === null) {
    return { state: 'absent', kind: null, parentRef: null, candidateCount: 0 };
  }

  const canonicalDirect = canonicalizeMessageId(directValue);
  if (!canonicalDirect) {
    return {
      state: 'malformed',
      kind: directKind,
      parentRef: null,
      candidateCount: 0,
    };
  }

  const eligible = input.candidates.filter(
    (candidate) =>
      canonicalizeMessageId(candidate.messageIdHeader) === canonicalDirect &&
      isEligibleParent(
        candidate,
        input.sharedMailbox,
        input.outboundCreatedAt,
        input.outboundEventAt,
        input.centurionIdentities,
      ),
  );

  if (eligible.length === 1) {
    return {
      state: 'linked',
      kind: directKind,
      parentRef: eligible[0]!.auditRef,
      candidateCount: 1,
    };
  }
  if (eligible.length > 1) {
    return {
      state: 'ambiguous',
      kind: directKind,
      parentRef: null,
      candidateCount: eligible.length,
    };
  }
  return {
    state: 'unresolved',
    kind: directKind,
    parentRef: null,
    candidateCount: 0,
  };
}

export function extractCenturionAuditEvidence(input: {
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  maxChars?: number;
}): {
  structuralEvidence: StructuralEvidence;
  automationEvidence: AutomationEvidence;
  bodyState: BodyState;
} {
  const maxChars = input.maxChars ?? CENTURION_AUDIT_MAX_BODY_CHARS;
  const text = input.textBody ?? '';
  const html = input.htmlBody ?? '';
  if (text.length > maxChars || html.length > maxChars) {
    return {
      structuralEvidence: 'none',
      automationEvidence: 'none',
      bodyState: 'too_large',
    };
  }

  const source = `${input.subject ?? ''}\n${text}\n${html}`;
  const structuralEvidence =
    /(?:^|\n)>\s|\bon .{1,160} wrote:\b/i.test(text) ||
    /<(?:blockquote)\b|class=["'][^"']*gmail_quote/i.test(html)
      ? 'quote_or_reply_marker'
      : 'none';

  const deliveryStatus =
    /delivery status notification/i.test(input.subject ?? '') &&
    /this is the mail system at/i.test(source);
  const suspectedAutomation = /\b(?:out of office|automatic reply|auto[- ]?reply)\b/i.test(source);

  return {
    structuralEvidence,
    automationEvidence: deliveryStatus
      ? 'delivery_status'
      : suspectedAutomation
        ? 'suspected'
        : 'none',
    bodyState: 'usable',
  };
}

export function classifyCenturionOutboundReply(input: {
  header: HeaderResolution;
  structuralEvidence: StructuralEvidence;
  correspondentEvidence: boolean;
  automationEvidence: AutomationEvidence;
  bodyState?: BodyState;
}): OpaqueAuditRow {
  const auditRef = createAuditReference();
  const bodyState = input.bodyState ?? 'usable';

  if (input.automationEvidence === 'delivery_status') {
    return opaqueAuditRowSchema.parse({
      auditRef,
      parentRef: null,
      label: 'automation_system',
      classificationState: 'classified',
      evidence: ['delivery_status'],
      reason: 'AUTOMATION_DELIVERY_STATUS',
      candidateCount: 0,
      corpusUse: 'exclude',
    });
  }

  if (input.automationEvidence === 'suspected' || bodyState !== 'usable') {
    return opaqueAuditRowSchema.parse({
      auditRef,
      parentRef: null,
      label: 'unclassifiable',
      classificationState: 'unclassifiable',
      evidence: [input.automationEvidence === 'suspected' ? 'automation_suspected' : bodyState],
      reason: input.automationEvidence === 'suspected' ? 'AUTOMATION_UNPROVEN' : 'BODY_UNUSABLE',
      candidateCount: 0,
      corpusUse: 'exclude',
    });
  }

  if (input.header.state === 'linked') {
    const isReplyTo = input.header.kind === 'in_reply_to';
    return opaqueAuditRowSchema.parse({
      auditRef,
      parentRef: input.header.parentRef,
      label: isReplyTo ? 'gold_header_linked' : 'gold_reference_linked',
      classificationState: 'classified',
      evidence: [isReplyTo ? 'in_reply_to' : 'references'],
      reason: isReplyTo ? 'UNIQUE_IN_REPLY_TO' : 'UNIQUE_REFERENCE',
      candidateCount: input.header.candidateCount ?? 1,
      corpusUse: 'paired_evaluation',
    });
  }

  if (input.header.state === 'malformed') {
    return opaqueAuditRowSchema.parse({
      auditRef,
      parentRef: null,
      label: 'malformed_metadata',
      classificationState: 'unclassifiable',
      evidence: ['malformed_header'],
      reason: 'MALFORMED_DIRECT_PARENT_HEADER',
      candidateCount: 0,
      corpusUse: 'exclude',
    });
  }

  if (input.header.state === 'unresolved' || input.header.state === 'ambiguous') {
    const ambiguous = input.header.state === 'ambiguous';
    return opaqueAuditRowSchema.parse({
      auditRef,
      parentRef: null,
      label: 'possible_reply_parent_unknown',
      classificationState: 'ambiguous',
      evidence: [ambiguous ? 'direct_header_ambiguous' : 'direct_header_unresolved'],
      reason: ambiguous ? 'PARENT_UNKNOWN_DUPLICATE_DIRECT_HEADER' : 'PARENT_UNKNOWN_DIRECT_HEADER',
      candidateCount: input.header.candidateCount ?? 0,
      corpusUse: 'style_template_only',
    });
  }

  if (input.correspondentEvidence || input.structuralEvidence !== 'none') {
    const oldCorrespondent = input.correspondentEvidence;
    return opaqueAuditRowSchema.parse({
      auditRef,
      parentRef: null,
      label: oldCorrespondent
        ? 'possible_old_correspondent_reply_parent_unknown'
        : 'possible_reply_parent_unknown',
      classificationState: 'ambiguous',
      evidence: [oldCorrespondent ? 'old_correspondent' : 'reply_marker'],
      reason: oldCorrespondent
        ? 'PARENT_UNKNOWN_OLD_CORRESPONDENT'
        : 'PARENT_UNKNOWN_STRUCTURAL_REPLY_MARKER',
      candidateCount: 0,
      corpusUse: 'style_template_only',
    });
  }

  return opaqueAuditRowSchema.parse({
    auditRef,
    parentRef: null,
    label: 'no_reply_evidence',
    classificationState: 'classified',
    evidence: ['no_signal'],
    reason: 'NO_REPLY_SIGNAL',
    candidateCount: 0,
    corpusUse: 'style_template_only',
  });
}

export function createAuditReference(): string {
  return `audit-${randomUUID()}`;
}

export type AuditCursor = {
  createdAt: string;
  id: string;
};

export function pageAuditRows<T extends AuditCursor>(
  rows: readonly T[],
  cursor: AuditCursor | null,
  pageSize: number,
): { rows: T[]; nextCursor: AuditCursor | null } {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error('CENTURION_AUDIT_INVALID_PAGE_SIZE');
  }

  const sorted = [...rows].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const page = sorted
    .filter(
      (row) =>
        cursor === null ||
        row.createdAt > cursor.createdAt ||
        (row.createdAt === cursor.createdAt && row.id > cursor.id),
    )
    .slice(0, pageSize);
  const last = page.at(-1);
  const hasMore =
    last !== undefined &&
    sorted.some(
      (row) =>
        row.createdAt > last.createdAt || (row.createdAt === last.createdAt && row.id > last.id),
    );

  return {
    rows: page,
    nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
  };
}

export function assertCenturionAuditRunnerSourceSafe(source: string): void {
  const forbidden = [
    /\b(?:db|tx|sql)\s*\.\s*(?:insert|update|delete)\s*\(/i,
    /\b(?:sendMail|fetch|request)\s*\(/i,
    /\b(?:outboundSendQueue|outbound_send_queue|nodemailer|s3(?:client)?|worker|proxy|mastra)\b/i,
    /\b(?:node:)?https?\b/i,
    /\b(?:axios|telemetry|playwright|puppeteer)\b/i,
  ];
  if (forbidden.some((pattern) => pattern.test(source))) {
    throw new Error('CENTURION_AUDIT_SOURCE_UNSAFE');
  }
}

const auditRefSchema = z.string().regex(/^audit-[0-9a-f-]{36}$/);
const opaqueDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const identityAddressSchema = z.string().email();
const reviewerIdSchema = z.string().regex(/^reviewer-[a-z0-9-]{3,64}$/);
const relationKindSchema = z.enum(['reply_to_external', 'reply_to_prior_staff', 'thread_context']);
const semanticMethodSchema = z.enum([
  'candidate_quote_match',
  'candidate_subject_participants',
  'candidate_thread_context',
  'full_corpus_exhausted',
  'automation_deterministic',
]);
const semanticEvidenceCodeSchema = z.enum([
  'outermost_quote',
  'normalized_subject',
  'reciprocal_participant',
  'thread_context',
  'chronology',
  'full_corpus_exhausted',
  'automation_delivery_status',
  'automation_system_pattern',
]);

const finalEvidenceCodeSchema = z.enum([
  'in_reply_to',
  'references',
  'delivery_status',
  'outermost_quote',
  'normalized_subject',
  'reciprocal_participant',
  'thread_context',
  'chronology',
  'full_corpus_exhausted',
  'automation_delivery_status',
  'automation_system_pattern',
]);

export const finalAuditLinkStatusSchema = z.enum([
  'header_confirmed',
  'semantic_linked',
  'semantic_new',
  'automation_system',
]);

export const auditSnapshotRecordSchema = z
  .object({
    auditRef: auditRefSchema,
    createdAt: z.string().datetime(),
    eventAt: z.string().datetime().optional(),
    direction: z.enum(['inbound', 'outbound']),
    isCenturionSender: z.boolean(),
    subjectDigest: z.string().min(1),
    participantDigests: z.array(z.string().min(1)).max(64),
    threadRef: z.string().min(1),
    quotedParentRefs: z.array(auditRefSchema).max(64),
  })
  .strict();

export type AuditSnapshotRecord = z.infer<typeof auditSnapshotRecordSchema>;

const candidateEvidenceCodeSchema = z.enum([
  'outermost_quote',
  'normalized_subject',
  'reciprocal_participant',
  'thread_context',
  'chronology',
]);

export const semanticCandidateSchema = z
  .object({
    parentRef: auditRefSchema,
    evidence: z.array(candidateEvidenceCodeSchema).min(1).max(5),
  })
  .strict();

export type SemanticCandidate = z.infer<typeof semanticCandidateSchema>;

export const semanticManifestChunkSchema = z
  .object({
    chunkIndex: z.number().int().nonnegative(),
    refs: z.array(auditRefSchema).min(1),
    digest: opaqueDigestSchema,
  })
  .strict();

export type SemanticManifestChunk = z.infer<typeof semanticManifestChunkSchema>;

export const semanticReviewWorkItemSchema = z
  .object({
    workItemId: z.string().regex(/^work-audit-[0-9a-f-]{36}$/),
    workItemDigest: opaqueDigestSchema,
    runRef: auditRefSchema,
    snapshotDigest: opaqueDigestSchema,
    sourceLedgerDigest: opaqueDigestSchema,
    reviewContractVersion: z.literal(1),
    shardId: z.string().regex(/^shard-[0-9]{4}$/),
    reviewerIds: z.array(reviewerIdSchema).min(2).max(3),
    outboundRef: auditRefSchema,
    outboundCreatedAt: z.string().datetime(),
    outboundEventAt: z.string().datetime().optional(),
    candidateSet: z.array(semanticCandidateSchema),
    candidateSetDigest: opaqueDigestSchema,
    completeManifestDigest: opaqueDigestSchema,
    expectedManifestRefCount: z.number().int().positive(),
    expectedManifestChunkCount: z.number().int().positive(),
    manifestChunks: z.array(semanticManifestChunkSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.reviewerIds).size !== value.reviewerIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CENTURION_AUDIT_WORK_ITEM_REVIEWER_DUPLICATE',
      });
    }
  });

export type SemanticReviewWorkItem = z.infer<typeof semanticReviewWorkItemSchema>;

export const semanticReviewDecisionSchema = z
  .object({
    workItemId: z.string().regex(/^work-audit-[0-9a-f-]{36}$/),
    workItemDigest: opaqueDigestSchema,
    reviewerId: reviewerIdSchema,
    linkStatus: z.enum(['semantic_linked', 'semantic_new', 'automation_system']),
    parentRef: auditRefSchema.nullable(),
    relationKind: relationKindSchema.nullable(),
    method: semanticMethodSchema,
    evidence: z.array(semanticEvidenceCodeSchema).min(1).max(5),
    chunkReceipts: z
      .array(
        z
          .object({
            chunkIndex: z.number().int().nonnegative(),
            chunkDigest: opaqueDigestSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.linkStatus === 'semantic_linked' &&
      (value.parentRef === null || value.relationKind === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CENTURION_AUDIT_REVIEW_LINK_PARENT_REQUIRED',
      });
    }
    if (
      value.linkStatus !== 'semantic_linked' &&
      (value.parentRef !== null || value.relationKind !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CENTURION_AUDIT_REVIEW_NON_LINK_PARENT_FORBIDDEN',
      });
    }
    if (value.linkStatus === 'semantic_new' && value.method !== 'full_corpus_exhausted') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CENTURION_AUDIT_REVIEW_NEW_METHOD_INVALID',
      });
    }
    if (
      value.linkStatus === 'semantic_new' &&
      (value.evidence.length !== 1 || value.evidence[0] !== 'full_corpus_exhausted')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CENTURION_AUDIT_REVIEW_NEW_EVIDENCE_INVALID',
      });
    }
    if (
      value.linkStatus === 'semantic_linked' &&
      ![
        'candidate_quote_match',
        'candidate_subject_participants',
        'candidate_thread_context',
      ].includes(value.method)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CENTURION_AUDIT_REVIEW_LINK_METHOD_INVALID',
      });
    }
    const requiredLinkEvidence =
      value.method === 'candidate_quote_match'
        ? 'outermost_quote'
        : value.method === 'candidate_subject_participants'
          ? 'normalized_subject'
          : value.method === 'candidate_thread_context'
            ? 'thread_context'
            : null;
    if (
      value.linkStatus === 'semantic_linked' &&
      (requiredLinkEvidence === null || !value.evidence.includes(requiredLinkEvidence))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CENTURION_AUDIT_REVIEW_LINK_EVIDENCE_INVALID',
      });
    }
    if (value.linkStatus === 'automation_system' && value.method !== 'automation_deterministic') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CENTURION_AUDIT_REVIEW_AUTOMATION_METHOD_INVALID',
      });
    }
    if (
      value.linkStatus === 'automation_system' &&
      !value.evidence.every((evidence) =>
        ['automation_delivery_status', 'automation_system_pattern'].includes(evidence),
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CENTURION_AUDIT_REVIEW_AUTOMATION_EVIDENCE_INVALID',
      });
    }
  });

export type SemanticReviewDecision = z.infer<typeof semanticReviewDecisionSchema>;

export const semanticReviewerResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    runRef: auditRefSchema,
    reviewerId: reviewerIdSchema,
    decisions: z.array(semanticReviewDecisionSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decisions.some((decision) => decision.reviewerId !== value.reviewerId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CENTURION_AUDIT_REVIEWER_RESULT_ID_MISMATCH',
      });
    }
  });

export type SemanticReviewerResult = z.infer<typeof semanticReviewerResultSchema>;

export const finalAuditResolutionSchema = z
  .object({
    auditRef: auditRefSchema,
    parentRef: auditRefSchema.nullable(),
    linkStatus: finalAuditLinkStatusSchema,
    relationKind: relationKindSchema.nullable(),
    method: z.enum([
      'header_in_reply_to',
      'header_references',
      'candidate_quote_match',
      'candidate_subject_participants',
      'candidate_thread_context',
      'full_corpus_exhausted',
      'automation_deterministic',
    ]),
    evidence: z.array(finalEvidenceCodeSchema).min(1).max(5),
    corpusUse: corpusUseSchema,
    reviewReceiptDigest: opaqueDigestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.linkStatus === 'header_confirmed') {
      if (
        value.parentRef === null ||
        value.relationKind !== null ||
        value.corpusUse !== 'paired_evaluation' ||
        !['header_in_reply_to', 'header_references'].includes(value.method)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CENTURION_AUDIT_FINAL_HEADER_PARENT_REQUIRED',
        });
      }
    }
    if (
      value.linkStatus === 'semantic_linked' &&
      (value.parentRef === null || value.relationKind === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CENTURION_AUDIT_FINAL_LINK_PARENT_REQUIRED',
      });
    }
    if (value.linkStatus === 'semantic_linked' && value.corpusUse !== 'style_template_only') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CENTURION_AUDIT_FINAL_SEMANTIC_CORPUS_USE_INVALID',
      });
    }
    if (
      (value.linkStatus === 'semantic_new' || value.linkStatus === 'automation_system') &&
      (value.parentRef !== null || value.relationKind !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CENTURION_AUDIT_FINAL_NON_SEMANTIC_PARENT_FORBIDDEN',
      });
    }
    if (
      (value.linkStatus === 'semantic_new' && value.corpusUse !== 'style_template_only') ||
      (value.linkStatus === 'automation_system' && value.corpusUse !== 'exclude')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CENTURION_AUDIT_FINAL_CORPUS_USE_INVALID',
      });
    }
  });

export type FinalAuditResolution = z.infer<typeof finalAuditResolutionSchema>;

export type FrozenCenturionIdentitySet = {
  addresses: string[];
  digest: string;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

export function createAuditOpaqueDigest(value: unknown): string {
  return sha256(value);
}

function assertValidIdentityAddress(value: string): string {
  const normalized = normalizeEmailAddress(value);
  if (!identityAddressSchema.safeParse(normalized).success) {
    throw new Error('CENTURION_AUDIT_IDENTITY_INVALID');
  }
  return normalized;
}

export function freezeCenturionIdentitySet(input: {
  primary: string;
  aliases: readonly string[];
}): FrozenCenturionIdentitySet {
  const primary = assertValidIdentityAddress(input.primary);
  const aliases = input.aliases.map(assertValidIdentityAddress);
  const all = [primary, ...aliases];
  if (new Set(all).size !== all.length) {
    throw new Error('CENTURION_AUDIT_IDENTITY_DUPLICATE');
  }
  const addresses = [primary, ...aliases.sort((left, right) => left.localeCompare(right))];
  return {
    addresses,
    digest: sha256({ addresses }),
  };
}

function isEarlierRecord(candidate: AuditSnapshotRecord, outbound: AuditSnapshotRecord): boolean {
  return isEarlier(
    candidate.eventAt ?? candidate.createdAt,
    outbound.eventAt ?? outbound.createdAt,
  );
}

function overlapCount(left: readonly string[], right: readonly string[]): number {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value)).length;
}

export function buildSemanticCandidateSet(
  outbound: AuditSnapshotRecord,
  snapshot: readonly AuditSnapshotRecord[],
): SemanticCandidate[] {
  const candidates: Array<{ candidate: SemanticCandidate; score: number; eventAt: string }> = [];
  for (const record of snapshot) {
    if (record.auditRef === outbound.auditRef || !isEarlierRecord(record, outbound)) continue;
    const evidence: SemanticCandidate['evidence'][number][] = [];
    let score = 0;
    if (outbound.quotedParentRefs.includes(record.auditRef)) {
      evidence.push('outermost_quote');
      score += 16;
    }
    if (outbound.subjectDigest === record.subjectDigest) {
      evidence.push('normalized_subject');
      score += 8;
    }
    if (overlapCount(outbound.participantDigests, record.participantDigests) > 0) {
      evidence.push('reciprocal_participant');
      score += 4;
    }
    if (outbound.threadRef === record.threadRef) {
      evidence.push('thread_context');
      score += 2;
    }
    evidence.push('chronology');
    candidates.push({
      candidate: semanticCandidateSchema.parse({
        parentRef: record.auditRef,
        evidence,
      }),
      score,
      eventAt: record.eventAt ?? record.createdAt,
    });
  }
  return candidates
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.eventAt.localeCompare(left.eventAt) ||
        left.candidate.parentRef.localeCompare(right.candidate.parentRef),
    )
    .map(({ candidate }) => candidate);
}

function makeManifestChunks(
  snapshot: readonly AuditSnapshotRecord[],
  chunkSize: number,
): SemanticManifestChunk[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error('CENTURION_AUDIT_MANIFEST_CHUNK_SIZE_INVALID');
  }
  const refs = [...snapshot]
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.auditRef.localeCompare(right.auditRef),
    )
    .map((record) => record.auditRef);
  if (refs.length === 0) throw new Error('CENTURION_AUDIT_MANIFEST_EMPTY');
  const chunks: SemanticManifestChunk[] = [];
  for (let start = 0; start < refs.length; start += chunkSize) {
    const chunkRefs = refs.slice(start, start + chunkSize);
    chunks.push(
      semanticManifestChunkSchema.parse({
        chunkIndex: chunks.length,
        refs: chunkRefs,
        digest: sha256({ chunkIndex: chunks.length, refs: chunkRefs }),
      }),
    );
  }
  return chunks;
}

export function buildSemanticReviewWorkItems(input: {
  runRef: string;
  snapshotDigest: string;
  sourceLedgerDigest: string;
  targetRefs: readonly string[];
  snapshot: readonly AuditSnapshotRecord[];
  manifestChunkSize?: number;
  reviewShardSize?: number;
  reviewerIds?: readonly string[];
}): SemanticReviewWorkItem[] {
  const runRef = auditRefSchema.parse(input.runRef);
  const snapshotDigest = opaqueDigestSchema.parse(input.snapshotDigest);
  const sourceLedgerDigest = opaqueDigestSchema.parse(input.sourceLedgerDigest);
  const snapshot = input.snapshot.map((record) => auditSnapshotRecordSchema.parse(record));
  const snapshotByRef = new Map(snapshot.map((record) => [record.auditRef, record]));
  if (snapshotByRef.size !== snapshot.length)
    throw new Error('CENTURION_AUDIT_SNAPSHOT_DUPLICATE_REF');
  const targetRefs = [...input.targetRefs].map((ref) => auditRefSchema.parse(ref));
  if (new Set(targetRefs).size !== targetRefs.length) {
    throw new Error('CENTURION_AUDIT_WORK_ITEM_DUPLICATE');
  }
  const reviewShardSize = input.reviewShardSize ?? 10;
  if (!Number.isInteger(reviewShardSize) || reviewShardSize <= 0 || reviewShardSize > 10) {
    throw new Error('CENTURION_AUDIT_REVIEW_SHARD_SIZE_INVALID');
  }
  const reviewerIds = (input.reviewerIds ?? ['reviewer-one', 'reviewer-two', 'reviewer-three']).map(
    (reviewerId) => reviewerIdSchema.parse(reviewerId),
  );
  if (new Set(reviewerIds).size !== reviewerIds.length) {
    throw new Error('CENTURION_AUDIT_WORK_ITEM_REVIEWER_DUPLICATE');
  }
  const manifestChunks = makeManifestChunks(snapshot, input.manifestChunkSize ?? 128);
  const completeManifestDigest = sha256({
    refs: manifestChunks.flatMap((chunk) => chunk.refs),
    chunks: manifestChunks.map((chunk) => chunk.digest),
  });

  return targetRefs.map((outboundRef, targetIndex) => {
    const outbound = snapshotByRef.get(outboundRef);
    if (!outbound || !outbound.isCenturionSender) {
      throw new Error('CENTURION_AUDIT_WORK_ITEM_TARGET_INVALID');
    }
    const candidateSet = buildSemanticCandidateSet(outbound, snapshot);
    const candidateSetDigest = sha256(candidateSet);
    const base = {
      workItemId: `work-${outboundRef}`,
      runRef,
      snapshotDigest,
      sourceLedgerDigest,
      reviewContractVersion: 1 as const,
      shardId: `shard-${String(Math.floor(targetIndex / reviewShardSize) + 1).padStart(4, '0')}`,
      reviewerIds,
      outboundRef,
      outboundCreatedAt: outbound.createdAt,
      outboundEventAt: outbound.eventAt ?? outbound.createdAt,
      candidateSet,
      candidateSetDigest,
      completeManifestDigest,
      expectedManifestRefCount: snapshot.length,
      expectedManifestChunkCount: manifestChunks.length,
      manifestChunks,
    };
    return semanticReviewWorkItemSchema.parse({
      ...base,
      workItemDigest: sha256(base),
    });
  });
}

function assertDecisionReceipts(
  decision: SemanticReviewDecision,
  workItem: SemanticReviewWorkItem,
): void {
  if (decision.chunkReceipts.length !== workItem.manifestChunks.length) {
    throw new Error('CENTURION_AUDIT_RECEIPT_INVALID');
  }
  for (const [index, receipt] of decision.chunkReceipts.entries()) {
    const expected = workItem.manifestChunks[index];
    if (
      !expected ||
      receipt.chunkIndex !== expected.chunkIndex ||
      receipt.chunkDigest !== expected.digest
    ) {
      throw new Error('CENTURION_AUDIT_RECEIPT_INVALID');
    }
  }
}

function assertWorkItemIntegrity(
  workItem: SemanticReviewWorkItem,
  snapshot: readonly AuditSnapshotRecord[],
): void {
  const { workItemDigest, ...boundFields } = workItem;
  if (sha256(boundFields) !== workItemDigest) {
    throw new Error('CENTURION_AUDIT_WORK_ITEM_DIGEST_INVALID');
  }
  const outbound = snapshot.find((record) => record.auditRef === workItem.outboundRef);
  if (
    !outbound ||
    outbound.createdAt !== workItem.outboundCreatedAt ||
    (workItem.outboundEventAt !== undefined &&
      workItem.outboundEventAt !== (outbound.eventAt ?? outbound.createdAt))
  ) {
    throw new Error('CENTURION_AUDIT_WORK_ITEM_BINDING_INVALID');
  }
  const expectedCandidates = buildSemanticCandidateSet(outbound, snapshot);
  if (
    sha256(workItem.candidateSet) !== workItem.candidateSetDigest ||
    sha256(expectedCandidates) !== workItem.candidateSetDigest
  ) {
    throw new Error('CENTURION_AUDIT_WORK_ITEM_CANDIDATE_INVALID');
  }
  const expectedRefs = [...snapshot]
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.auditRef.localeCompare(right.auditRef),
    )
    .map((record) => record.auditRef);
  const actualRefs = workItem.manifestChunks.flatMap((chunk) => chunk.refs);
  if (
    actualRefs.length !== expectedRefs.length ||
    actualRefs.some((ref, index) => ref !== expectedRefs[index]) ||
    workItem.expectedManifestRefCount !== expectedRefs.length ||
    workItem.expectedManifestChunkCount !== workItem.manifestChunks.length
  ) {
    throw new Error('CENTURION_AUDIT_WORK_ITEM_MANIFEST_INVALID');
  }
  for (const chunk of workItem.manifestChunks) {
    if (sha256({ chunkIndex: chunk.chunkIndex, refs: chunk.refs }) !== chunk.digest) {
      throw new Error('CENTURION_AUDIT_WORK_ITEM_MANIFEST_INVALID');
    }
  }
  const completeManifestDigest = sha256({
    refs: actualRefs,
    chunks: workItem.manifestChunks.map((chunk) => chunk.digest),
  });
  if (completeManifestDigest !== workItem.completeManifestDigest) {
    throw new Error('CENTURION_AUDIT_WORK_ITEM_MANIFEST_INVALID');
  }
}

function semanticCorpusUse(
  linkStatus: SemanticReviewDecision['linkStatus'],
): FinalAuditResolution['corpusUse'] {
  return linkStatus === 'automation_system' ? 'exclude' : 'style_template_only';
}

function receiptDigest(decisions: readonly SemanticReviewDecision[]): string {
  return sha256(
    [...decisions]
      .map((decision) => ({
        reviewerId: decision.reviewerId,
        workItemDigest: decision.workItemDigest,
        linkStatus: decision.linkStatus,
        parentRef: decision.parentRef,
        relationKind: decision.relationKind,
        method: decision.method,
        evidence: decision.evidence,
        chunkReceipts: decision.chunkReceipts,
      }))
      .sort((left, right) => left.reviewerId.localeCompare(right.reviewerId)),
  );
}

export function mergeSemanticReviewDecisions(input: {
  expectedOutboundRefs: readonly string[];
  snapshot: readonly AuditSnapshotRecord[];
  workItems: readonly SemanticReviewWorkItem[];
  decisions: readonly SemanticReviewDecision[];
}): FinalAuditResolution[] {
  const expectedOutboundRefs = input.expectedOutboundRefs.map((ref) => auditRefSchema.parse(ref));
  if (new Set(expectedOutboundRefs).size !== expectedOutboundRefs.length) {
    throw new Error('CENTURION_AUDIT_FINAL_COVERAGE_INVALID');
  }
  const snapshot = input.snapshot.map((record) => auditSnapshotRecordSchema.parse(record));
  const snapshotByRef = new Map(snapshot.map((record) => [record.auditRef, record]));
  if (snapshotByRef.size !== snapshot.length)
    throw new Error('CENTURION_AUDIT_SNAPSHOT_DUPLICATE_REF');
  const workItems = input.workItems.map((item) => semanticReviewWorkItemSchema.parse(item));
  for (const workItem of workItems) {
    assertWorkItemIntegrity(workItem, snapshot);
  }
  const workById = new Map(workItems.map((item) => [item.workItemId, item]));
  if (
    workById.size !== workItems.length ||
    new Set(workItems.map((item) => item.outboundRef)).size !== workItems.length
  ) {
    throw new Error('CENTURION_AUDIT_WORK_ITEM_DUPLICATE');
  }
  if (
    workItems.length !== expectedOutboundRefs.length ||
    workItems.some((item) => !expectedOutboundRefs.includes(item.outboundRef))
  ) {
    throw new Error('CENTURION_AUDIT_FINAL_COVERAGE_INVALID');
  }

  const byWork = new Map<string, SemanticReviewDecision[]>();
  for (const sourceDecision of input.decisions) {
    const decision = semanticReviewDecisionSchema.parse(sourceDecision);
    const workItem = workById.get(decision.workItemId);
    if (!workItem || decision.workItemDigest !== workItem.workItemDigest) {
      throw new Error('CENTURION_AUDIT_WORK_ITEM_BINDING_INVALID');
    }
    if (!workItem.reviewerIds.includes(decision.reviewerId)) {
      throw new Error('CENTURION_AUDIT_REVIEWER_UNASSIGNED');
    }
    assertDecisionReceipts(decision, workItem);
    const existing = byWork.get(decision.workItemId) ?? [];
    if (existing.some((item) => item.reviewerId === decision.reviewerId)) {
      throw new Error('CENTURION_AUDIT_REVIEWER_REPLAY');
    }
    existing.push(decision);
    byWork.set(decision.workItemId, existing);
  }

  const rows: FinalAuditResolution[] = [];
  for (const workItem of workItems) {
    const decisions = byWork.get(workItem.workItemId) ?? [];
    if (decisions.length === 0) throw new Error('CENTURION_AUDIT_PARENT_UNKNOWN');
    const outbound = snapshotByRef.get(workItem.outboundRef);
    if (!outbound) throw new Error('CENTURION_AUDIT_SNAPSHOT_BINDING_INVALID');
    const linked = decisions.filter((decision) => decision.linkStatus === 'semantic_linked');
    if (linked.length > 0) {
      const groups = new Map<string, SemanticReviewDecision[]>();
      for (const decision of linked) {
        const parent = decision.parentRef ? snapshotByRef.get(decision.parentRef) : undefined;
        if (
          !parent ||
          !isEarlierRecord(parent, outbound) ||
          parent.auditRef === outbound.auditRef
        ) {
          throw new Error('CENTURION_AUDIT_SEMANTIC_PARENT_INVALID');
        }
        if (
          (decision.relationKind === 'reply_to_external' &&
            (parent.isCenturionSender || parent.direction !== 'inbound')) ||
          (decision.relationKind === 'reply_to_prior_staff' &&
            (!parent.isCenturionSender || parent.direction !== 'outbound')) ||
          (decision.relationKind === 'thread_context' && parent.threadRef !== outbound.threadRef)
        ) {
          throw new Error('CENTURION_AUDIT_SEMANTIC_RELATION_INVALID');
        }
        const key = `${decision.parentRef}:${decision.relationKind}`;
        const group = groups.get(key) ?? [];
        group.push(decision);
        groups.set(key, group);
      }
      const consensus = [...groups.values()]
        .filter((group) => new Set(group.map((decision) => decision.reviewerId)).size >= 2)
        .sort((left, right) => right.length - left.length)
        .at(0);
      if (!consensus) throw new Error('CENTURION_AUDIT_PARENT_UNKNOWN');
      const selected = consensus[0]!;
      rows.push(
        finalAuditResolutionSchema.parse({
          auditRef: workItem.outboundRef,
          parentRef: selected.parentRef,
          linkStatus: 'semantic_linked',
          relationKind: selected.relationKind,
          method: selected.method,
          evidence: selected.evidence,
          corpusUse: 'style_template_only',
          reviewReceiptDigest: receiptDigest(consensus),
        }),
      );
      continue;
    }

    const statuses = new Set(decisions.map((decision) => decision.linkStatus));
    if (decisions.length < 2 || statuses.size !== 1) {
      throw new Error('CENTURION_AUDIT_PARENT_UNKNOWN');
    }
    const groups = new Map<string, SemanticReviewDecision[]>();
    for (const decision of decisions) {
      const key = stableJson({
        linkStatus: decision.linkStatus,
        method: decision.method,
        evidence: [...decision.evidence].sort(),
      });
      const group = groups.get(key) ?? [];
      group.push(decision);
      groups.set(key, group);
    }
    const consensus = [...groups.values()]
      .filter((group) => new Set(group.map((decision) => decision.reviewerId)).size >= 2)
      .sort((left, right) => right.length - left.length)
      .at(0);
    if (!consensus) throw new Error('CENTURION_AUDIT_PARENT_UNKNOWN');
    const selected = consensus[0]!;
    rows.push(
      finalAuditResolutionSchema.parse({
        auditRef: workItem.outboundRef,
        parentRef: null,
        linkStatus: selected.linkStatus,
        relationKind: null,
        method: selected.method,
        evidence: selected.evidence,
        corpusUse: semanticCorpusUse(selected.linkStatus),
        reviewReceiptDigest: receiptDigest(consensus),
      }),
    );
  }
  assertCompleteFinalAuditRows({ expectedOutboundRefs, rows });
  return rows;
}

export function finalizeDirectAuditRow(input: OpaqueAuditRow): FinalAuditResolution | null {
  if (input.label === 'gold_header_linked' || input.label === 'gold_reference_linked') {
    if (!input.parentRef) throw new Error('CENTURION_AUDIT_HEADER_PARENT_INVALID');
    return finalAuditResolutionSchema.parse({
      auditRef: input.auditRef,
      parentRef: input.parentRef,
      linkStatus: 'header_confirmed',
      relationKind: null,
      method: input.label === 'gold_header_linked' ? 'header_in_reply_to' : 'header_references',
      evidence: input.evidence,
      corpusUse: 'paired_evaluation',
      reviewReceiptDigest: sha256({ auditRef: input.auditRef, parentRef: input.parentRef, input }),
    });
  }
  return null;
}

export function assertCompleteFinalAuditRows(input: {
  expectedOutboundRefs: readonly string[];
  rows: readonly FinalAuditResolution[];
}): void {
  const expected = new Set(input.expectedOutboundRefs.map((ref) => auditRefSchema.parse(ref)));
  const rows = input.rows.map((row) => finalAuditResolutionSchema.parse(row));
  const actual = new Set(rows.map((row) => row.auditRef));
  if (
    rows.length !== expected.size ||
    actual.size !== rows.length ||
    actual.size !== expected.size ||
    [...expected].some((ref) => !actual.has(ref))
  ) {
    throw new Error('CENTURION_AUDIT_FINAL_COVERAGE_INVALID');
  }
}

function escapePrivatePlaintext(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/```/g, '``\\`')
    .replace(/\]\(/g, '\\]\\(');
}

function finalAdjudication(final: FinalAuditResolution): string {
  switch (final.linkStatus) {
    case 'header_confirmed':
      return 'header_proof';
    case 'semantic_linked':
      return 'exact_parent_consensus';
    case 'semantic_new':
      return 'full_corpus_review';
    case 'automation_system':
      return 'deterministic_automation';
  }
}

export function renderPrivateManualLinkLedger(
  entries: readonly {
    auditRef: string;
    final: FinalAuditResolution;
    outboundPlaintext: string;
    parentPlaintext: string | null;
  }[],
): string {
  const lines = ['# Centurion manual link ledger', ''];
  for (const entry of entries) {
    const final = finalAuditResolutionSchema.parse(entry.final);
    lines.push(`## ${auditRefSchema.parse(entry.auditRef)}`);
    lines.push(
      `State: ${final.linkStatus}; parent: ${final.parentRef ?? 'none'}; relation: ${
        final.relationKind ?? 'none'
      }; method: ${final.method}; evidence: ${final.evidence.join(', ')}; review receipt: ${
        final.reviewReceiptDigest
      }; adjudication: ${finalAdjudication(final)}.`,
      '',
      'Outbound context:',
      '```text',
      escapePrivatePlaintext(entry.outboundPlaintext),
      '```',
    );
    if (entry.parentPlaintext !== null) {
      lines.push(
        '',
        'Parent context:',
        '```text',
        escapePrivatePlaintext(entry.parentPlaintext),
        '```',
      );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
