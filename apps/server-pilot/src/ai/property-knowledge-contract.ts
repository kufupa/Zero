import { z } from 'zod';

/**
 * Closed, model-independent contract for approved property knowledge.
 *
 * This contract deliberately describes generic property material only.  A
 * reservation's booked policy remains a separate, reservation-bound fact and
 * is never replaced by a result from this reader.
 */
export const PROPERTY_KNOWLEDGE_CONTRACT_VERSION = 'property-knowledge/v1';
export const PROPERTY_KNOWLEDGE_TOOL_ID = 'property_read_knowledge' as const;
export const PROPERTY_KNOWLEDGE_SCOPE = 'property_generic' as const;
export const PROPERTY_KNOWLEDGE_FILE_CONTRACT_VERSION = 'property-knowledge-file/v1';
export const PROPERTY_KNOWLEDGE_MAX_ENTRIES = 20;
export const PROPERTY_KNOWLEDGE_MAX_CONTENT_CHARS = 2_000;
export const PROPERTY_KNOWLEDGE_MAX_FILE_BYTES = 512 * 1024;
const sourceHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const propertyKnowledgeTopics = [
  'check_in_out',
  'cancellation',
  'deposits_payment',
  'room_types',
  'meals_children',
  'amenities',
  'parking_transport',
  'location_contacts',
  'groups_events',
  'compliance_documents',
] as const;

export const propertyKnowledgeTopicSchema = z.enum(propertyKnowledgeTopics);
export type PropertyKnowledgeTopic = z.infer<typeof propertyKnowledgeTopicSchema>;

export const propertyKnowledgeDetailSchema = z.enum(['summary', 'detail']);
export type PropertyKnowledgeDetail = z.infer<typeof propertyKnowledgeDetailSchema>;

/** Audience controls disclosure, not a new application role. */
export const propertyKnowledgeAudienceSchema = z.enum(['staff', 'customer']);
export type PropertyKnowledgeAudience = z.infer<typeof propertyKnowledgeAudienceSchema>;

export const propertyKnowledgeEntryAudienceSchema = z.enum(['staff_only', 'customer_disclosable']);
export type PropertyKnowledgeEntryAudience = z.infer<typeof propertyKnowledgeEntryAudienceSchema>;

export const propertyKnowledgeSourceKindSchema = z.enum([
  'approved_property_document',
  'mail_attachment',
]);
export type PropertyKnowledgeSourceKind = z.infer<typeof propertyKnowledgeSourceKindSchema>;

export const propertyKnowledgeApprovalStatusSchema = z.enum([
  'approved',
  'pending',
  'rejected',
  'missing',
]);
export type PropertyKnowledgeApprovalStatus = z.infer<typeof propertyKnowledgeApprovalStatusSchema>;

const opaqueReferenceSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, 'expected an opaque property knowledge reference');

const timestampSchema = z.string().datetime({ offset: true });

export const propertyKnowledgeApprovalSchema = z
  .object({
    status: propertyKnowledgeApprovalStatusSchema,
    approvedAt: timestampSchema.nullable(),
    approvalRef: opaqueReferenceSchema.nullable(),
  })
  .strict();
export type PropertyKnowledgeApproval = z.infer<typeof propertyKnowledgeApprovalSchema>;

/** Internal source row shape. Locators, URLs and raw bytes are not allowed. */
export const propertyKnowledgeSourceRecordSchema = z
  .object({
    entryRef: opaqueReferenceSchema,
    topic: propertyKnowledgeTopicSchema,
    content: z.string().min(1).max(PROPERTY_KNOWLEDGE_MAX_CONTENT_CHARS),
    sourceKind: propertyKnowledgeSourceKindSchema,
    sourceRef: opaqueReferenceSchema,
    sourceHash: sourceHashSchema,
    version: z.string().min(1).max(128),
    ownerRef: opaqueReferenceSchema,
    approval: propertyKnowledgeApprovalSchema,
    /** Catalogue-compatible approved-at field; approval.approvedAt remains the status record. */
    approvedAt: timestampSchema.nullable().optional(),
    effectiveFrom: timestampSchema,
    effectiveUntil: timestampSchema.nullable(),
    propertyRef: z.string().min(1).max(256),
    audience: propertyKnowledgeEntryAudienceSchema,
    documentRefs: z.array(opaqueReferenceSchema).max(8),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.effectiveUntil !== null &&
      Date.parse(value.effectiveUntil) <= Date.parse(value.effectiveFrom)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effectiveUntil'],
        message: 'effectiveUntil must follow effectiveFrom',
      });
    }
    if (value.approval.status === 'approved' && value.approval.approvedAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approval', 'approvedAt'],
        message: 'approved material requires approvedAt',
      });
    }
    if (value.approval.status === 'approved' && value.approval.approvalRef === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approval', 'approvalRef'],
        message: 'approved material requires an approval reference',
      });
    }
    if (value.approvedAt !== undefined && value.approvedAt !== value.approval.approvedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvedAt'],
        message: 'approvedAt must match approval.approvedAt when supplied',
      });
    }
  });
export type PropertyKnowledgeSourceRecord = z.infer<typeof propertyKnowledgeSourceRecordSchema>;

export const propertyKnowledgeReadRequestSchema = z
  .object({
    topic: propertyKnowledgeTopicSchema,
    detail: propertyKnowledgeDetailSchema.default('summary'),
  })
  .strict();
export type PropertyKnowledgeReadRequest = z.infer<typeof propertyKnowledgeReadRequestSchema>;

export const propertyKnowledgeReadContextSchema = z
  .object({
    propertyRef: z.string().min(1).max(256),
    audience: propertyKnowledgeAudienceSchema,
  })
  .strict();
export type PropertyKnowledgeReadContext = z.infer<typeof propertyKnowledgeReadContextSchema>;

export const propertyKnowledgeIssueCodeSchema = z.enum([
  'AUTHORIZATION_UNAVAILABLE',
  'AUTHORIZATION_DENIED',
  'PROPERTY_SCOPE_MISMATCH',
  'TOPIC_UNAVAILABLE',
  'KNOWLEDGE_NOT_YET_EFFECTIVE',
  'KNOWLEDGE_EXPIRED',
  'POLICY_UNAPPROVED',
  'CONFLICTING_APPROVED_SOURCES',
  'AUDIENCE_NOT_AUTHORIZED',
  'DOCUMENT_REVALIDATION_UNAVAILABLE',
  'DOCUMENT_CHANGED',
  'DOCUMENT_EXPIRED',
  'DOCUMENT_UNAUTHORIZED',
  'DOCUMENT_MISSING',
  'PAYMENT_SECRET_REDACTED',
  'SOURCE_HASH_MISMATCH',
  'CONTENT_LIMIT',
  'SOURCE_UNAVAILABLE',
  'INVALID_SOURCE_RECORD',
  'READ_ABORTED',
]);
export type PropertyKnowledgeIssueCode = z.infer<typeof propertyKnowledgeIssueCodeSchema>;

export const propertyKnowledgeIssueSchema = z
  .object({
    code: propertyKnowledgeIssueCodeSchema,
    detail: z.string().max(256).nullable(),
  })
  .strict();
export type PropertyKnowledgeIssue = z.infer<typeof propertyKnowledgeIssueSchema>;

export const propertyKnowledgeEntrySchema = z
  .object({
    entryRef: opaqueReferenceSchema,
    topic: propertyKnowledgeTopicSchema,
    content: z.string().min(1).max(PROPERTY_KNOWLEDGE_MAX_CONTENT_CHARS),
    sourceKind: propertyKnowledgeSourceKindSchema,
    sourceRef: opaqueReferenceSchema,
    sourceHash: sourceHashSchema,
    version: z.string().min(1).max(128),
    ownerRef: opaqueReferenceSchema,
    approval: propertyKnowledgeApprovalSchema,
    approvedAt: timestampSchema,
    effectiveFrom: timestampSchema,
    effectiveUntil: timestampSchema.nullable(),
    propertyRef: z.string().min(1).max(256),
    audience: propertyKnowledgeEntryAudienceSchema,
    documentRefs: z.array(opaqueReferenceSchema).max(8),
  })
  .strict();
export type PropertyKnowledgeEntry = z.infer<typeof propertyKnowledgeEntrySchema>;

export const propertyKnowledgeConflictSchema = z
  .object({
    topic: propertyKnowledgeTopicSchema,
    entryRefs: z.array(opaqueReferenceSchema).min(2).max(PROPERTY_KNOWLEDGE_MAX_ENTRIES),
    sourceRefs: z.array(opaqueReferenceSchema).min(2).max(PROPERTY_KNOWLEDGE_MAX_ENTRIES),
  })
  .strict();
export type PropertyKnowledgeConflict = z.infer<typeof propertyKnowledgeConflictSchema>;

export const propertyKnowledgeEvidenceSchema = z
  .object({
    sourceRef: opaqueReferenceSchema,
    sourceHash: sourceHashSchema,
    version: z.string().min(1).max(128),
    ownerRef: opaqueReferenceSchema,
    approvedAt: timestampSchema,
    effectiveFrom: timestampSchema,
    effectiveUntil: timestampSchema.nullable(),
    observedAt: timestampSchema,
    expiresAt: timestampSchema,
    documentRefs: z.array(opaqueReferenceSchema).max(8),
  })
  .strict();
export type PropertyKnowledgeEvidence = z.infer<typeof propertyKnowledgeEvidenceSchema>;

export const propertyKnowledgeDataSchema = z
  .object({
    scope: z.literal(PROPERTY_KNOWLEDGE_SCOPE),
    propertyRef: z.string().min(1).max(256),
    audience: propertyKnowledgeAudienceSchema,
    topic: propertyKnowledgeTopicSchema,
    entries: z.array(propertyKnowledgeEntrySchema).max(PROPERTY_KNOWLEDGE_MAX_ENTRIES),
    conflicts: z.array(propertyKnowledgeConflictSchema).max(PROPERTY_KNOWLEDGE_MAX_ENTRIES),
  })
  .strict();
export type PropertyKnowledgeData = z.infer<typeof propertyKnowledgeDataSchema>;

export const propertyKnowledgeReadStatusSchema = z.enum([
  'ok',
  'partial',
  'unavailable',
  'ambiguous',
]);
export type PropertyKnowledgeReadStatus = z.infer<typeof propertyKnowledgeReadStatusSchema>;

export const propertyKnowledgeReadResultSchema = z
  .object({
    toolId: z.literal(PROPERTY_KNOWLEDGE_TOOL_ID),
    schemaVersion: z.literal(PROPERTY_KNOWLEDGE_CONTRACT_VERSION),
    status: propertyKnowledgeReadStatusSchema,
    scopeRef: z.string().min(1).max(256),
    data: propertyKnowledgeDataSchema.nullable(),
    evidence: z.array(propertyKnowledgeEvidenceSchema).max(PROPERTY_KNOWLEDGE_MAX_ENTRIES),
    issues: z.array(propertyKnowledgeIssueSchema).max(32),
  })
  .strict();
export type PropertyKnowledgeReadResult = z.infer<typeof propertyKnowledgeReadResultSchema>;

/** Closed server-wired local source envelope; approval remains per entry. */
export const propertyKnowledgeFileSchema = z
  .object({
    schemaVersion: z.literal(PROPERTY_KNOWLEDGE_FILE_CONTRACT_VERSION),
    propertyRef: z.string().min(1).max(256),
    entries: z.array(propertyKnowledgeSourceRecordSchema).max(256),
  })
  .strict();
export type PropertyKnowledgeFile = z.infer<typeof propertyKnowledgeFileSchema>;

/** Synthetic-only fixture envelope. `authoritative:false` is intentional. */
export const propertyKnowledgeFixtureSchema = z
  .object({
    schemaVersion: z.literal('property-knowledge-fixture/v1'),
    fixtureKind: z.literal('synthetic'),
    authoritative: z.literal(false),
    propertyRef: z.string().min(1).max(256),
    entries: z.array(propertyKnowledgeSourceRecordSchema).max(256),
  })
  .strict();
export type PropertyKnowledgeFixture = z.infer<typeof propertyKnowledgeFixtureSchema>;
