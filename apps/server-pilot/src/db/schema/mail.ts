import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  foreignKey,
  check,
  customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { user } from './auth.js';

const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const mailboxAccessRoleEnum = pgEnum('mailbox_access_role', [
  'owner',
  'member',
  'admin',
]);

export const mailboxTypeEnum = pgEnum('mailbox_type', [
  'personal',
  'shared',
]);

export const messageDirectionEnum = pgEnum('message_direction', [
  'inbound',
  'outbound',
]);

export const mailSenderPreferenceKindEnum = pgEnum('mail_sender_preference_kind', [
  'block',
  'allow',
]);

export const mailDraftStatusEnum = pgEnum('mail_draft_status', [
  'active',
  'candidate',
  'discarded',
  'sent',
]);

export const mailDraftOriginEnum = pgEnum('mail_draft_origin', [
  'manual',
  'ai',
]);

export const mailDraftRevisionKindEnum = pgEnum('mail_draft_revision_kind', [
  'created',
  'ai_generated',
  'promoted',
  'edited',
  'sent',
]);

export const aiWorkflowRunKindEnum = pgEnum('ai_workflow_run_kind', [
  'inbound_triage',
  'candidate_draft',
  'feedback_extraction',
]);

export const aiWorkflowRunStateEnum = pgEnum('ai_workflow_run_state', [
  'queued',
  'claimed',
  'running',
  'succeeded',
  'retry_wait',
  'dead_letter',
  'superseded',
]);

export const aiExecutorLaneEnum = pgEnum('ai_executor_lane', ['default', 'hms']);

export const mailIngestMailbox = pgTable(
  'mail_ingest_mailbox',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [index('mail_ingest_mailbox_email_idx').on(t.email)],
);

export const mailIngestQuarantine = pgTable(
  'mail_ingest_quarantine',
  {
    id: text('id').primaryKey(),
    ingestMailboxId: text('ingest_mailbox_id')
      .notNull()
      .references(() => mailIngestMailbox.id, { onDelete: 'cascade' }),
    pop3Uidl: text('pop3_uidl').notNull(),
    rawMimeS3Key: text('raw_mime_s3_key').notNull(),
    reason: text('reason').notNull(),
    ownerHeaderValue: text('owner_header_value'),
    parsedHeaders: jsonb('parsed_headers'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('mail_ingest_quarantine_ingest_idx').on(t.ingestMailboxId),
    index('mail_ingest_quarantine_reason_idx').on(t.reason),
    index('mail_ingest_quarantine_created_at_idx').on(t.createdAt),
    uniqueIndex('mail_ingest_quarantine_ingest_uidl_uidx').on(
      t.ingestMailboxId,
      t.pop3Uidl,
    ),
  ],
);

export const mailboxTransport = pgTable(
  'mailbox_transport',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    ownerHeaderValue: text('owner_header_value').notNull(),
    mailboxType: mailboxTypeEnum('mailbox_type').notNull().default('shared'),
    displayName: text('display_name'),
    isActive: boolean('is_active').notNull().default(true),
    sendFromConfig: jsonb('send_from_config'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mailbox_transport_owner_header_uidx').on(t.ownerHeaderValue),
    index('mailbox_transport_email_idx').on(t.email),
  ],
);

export const mailboxAccess = pgTable(
  'mailbox_access',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    role: mailboxAccessRoleEnum('role').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mailbox_access_user_transport_uidx').on(t.userId, t.transportId),
    index('mailbox_access_user_role_idx').on(t.userId, t.role),
    index('mailbox_access_transport_idx').on(t.transportId),
  ],
);

export const mailLabel = pgTable(
  'mail_label',
  {
    id: text('id').primaryKey(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mail_label_transport_name_uidx').on(t.transportId, t.name),
    index('mail_label_transport_idx').on(t.transportId),
  ],
);

export const mailCategory = pgTable(
  'mail_category',
  {
    id: text('id').primaryKey(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    color: text('color'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mail_category_transport_slug_uidx').on(t.transportId, t.slug),
    index('mail_category_transport_order_idx').on(t.transportId, t.sortOrder),
  ],
);

export const mailThreadCategory = pgTable(
  'mail_thread_category',
  {
    threadId: text('thread_id')
      .notNull()
      .references(() => mailThread.id, { onDelete: 'cascade' }),
    categoryId: text('category_id')
      .notNull()
      .references(() => mailCategory.id, { onDelete: 'cascade' }),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.categoryId] }),
    index('mail_thread_category_category_idx').on(t.categoryId),
    index('mail_thread_category_transport_idx').on(t.transportId),
  ],
);

export const mailSenderPreference = pgTable(
  'mail_sender_preference',
  {
    id: text('id').primaryKey(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    kind: mailSenderPreferenceKindEnum('kind').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mail_sender_preference_transport_email_uidx').on(t.transportId, t.email),
    index('mail_sender_preference_transport_idx').on(t.transportId),
  ],
);

export const mailThread = pgTable(
  'mail_thread',
  {
    id: text('id').primaryKey(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    threadRootId: text('thread_root_id').notNull(),
    subject: text('subject'),
    snippet: text('snippet'),
    searchVector: tsvector('search_vector'),
    isArchived: boolean('is_archived').notNull().default(false),
    isStarred: boolean('is_starred').notNull().default(false),
    isRead: boolean('is_read').notNull().default(false),
    labelIds: jsonb('label_ids').$type<string[]>().notNull().default([]),
    snoozedUntil: timestamp('snoozed_until'),
    spamAt: timestamp('spam_at'),
    spamUserLockedAt: timestamp('spam_user_locked_at'),
    trashedAt: timestamp('trashed_at'),
    latestMessageAt: timestamp('latest_message_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mail_thread_id_transport_uidx').on(t.id, t.transportId),
    uniqueIndex('mail_thread_transport_root_uidx').on(t.transportId, t.threadRootId),
    index('mail_thread_transport_list_idx').on(
      t.transportId,
      t.isArchived,
      t.latestMessageAt,
    ),
    index('mail_thread_snooze_wake_idx')
      .on(t.snoozedUntil)
      .where(sql`${t.snoozedUntil} IS NOT NULL`),
    index('mail_thread_search_vector_idx').using('gin', t.searchVector),
  ],
);

export const threadAuditSnapshotTrustStatusEnum = pgEnum(
  'thread_audit_snapshot_trust_status',
  ['valid', 'incomplete'],
);

export const threadAuditSnapshotTrustReasonEnum = pgEnum(
  'thread_audit_snapshot_trust_reason',
  [
    'verified',
    'source_coverage_limited',
    'pending_manual_adjudication',
    'source_not_ready',
  ],
);

export const threadAuditSnapshotStateEnum = pgEnum('thread_audit_snapshot_state', [
  'resolved',
  'action_required',
  'customer_acknowledgement_or_confirmation',
  'automated_or_non_actionable',
  'needs_manual_adjudication',
]);

export const threadAuditSnapshotEvidenceTierEnum = pgEnum(
  'thread_audit_snapshot_evidence_tier',
  [
    'persisted_reply',
    'quoted_reply',
    'participant_subject_only_correlation',
    'no_evidence',
  ],
);

export const threadAuditSnapshotImpactClassEnum = pgEnum(
  'thread_audit_snapshot_impact_class',
  [
    'commercial_follow_up_hypothesis',
    'guest_trust',
    'staff_time',
    'data_quality',
  ],
);

export const threadAuditSnapshotAgeBucketEnum = pgEnum(
  'thread_audit_snapshot_age_bucket',
  ['under_4h', 'four_to_24h', 'one_to_three_days', 'over_three_days', 'unknown'],
);

export const threadAuditSnapshotHandoffStateEnum = pgEnum(
  'thread_audit_snapshot_handoff_state',
  [
    'no_handoff_observed',
    'internal_handoff_observed',
    'handoff_evidence_limited',
  ],
);

export const threadAuditSnapshotNextHumanCheckEnum = pgEnum(
  'thread_audit_snapshot_next_human_check',
  [
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
  ],
);

export const threadAuditSnapshotExampleSelectionReasonEnum = pgEnum(
  'thread_audit_snapshot_example_selection_reason',
  ['outlier', 'aged_action', 'ambiguity', 'impact'],
);

/**
 * One current aggregate-only snapshot per mailbox transport. `id` is the
 * scoped child-FK identity; publicationIncarnationId is a separate immutable
 * primary incarnation for ABA-safe replacement decisions.
 */
export const threadAuditSnapshot = pgTable(
  'thread_audit_snapshot',
  {
    publicationIncarnationId: text('publication_incarnation_id').primaryKey(),
    id: text('id').notNull(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    trustStatus: threadAuditSnapshotTrustStatusEnum('trust_status').notNull(),
    trustReasonCode: threadAuditSnapshotTrustReasonEnum('trust_reason_code').notNull(),
    sourceManifestDigest: text('source_manifest_digest').notNull(),
    sourceIdentityDigest: text('source_identity_digest').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    sealedEnvelopeDigest: text('sealed_envelope_digest').notNull(),
    publicationRevisionToken: text('publication_revision_token').notNull(),
    sourceSchemaVersion: text('source_schema_version').notNull(),
    identityRulesVersion: text('identity_rules_version').notNull(),
    classifierVersion: text('classifier_version').notNull(),
    metricDefinitionVersion: text('metric_definition_version').notNull(),
    sourceEventCutoffAt: timestamp('source_event_cutoff_at', {
      withTimezone: true,
    }).notNull(),
    sourceIngestCutoffAt: timestamp('source_ingest_cutoff_at', {
      withTimezone: true,
    }).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    messageCount: integer('message_count'),
    componentCount: integer('component_count'),
    persistedThreadCount: integer('persisted_thread_count'),
    parserExceptionCount: integer('parser_exception_count'),
    coverageExceptionCount: integer('coverage_exception_count'),
    metricsAndInsights: jsonb('metrics_and_insights').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('thread_audit_snapshot_transport_uidx').on(t.transportId),
    uniqueIndex('thread_audit_snapshot_id_transport_uidx').on(t.id, t.transportId),
    check(
      'thread_audit_snapshot_counter_check',
      sql`
        ("message_count" IS NULL OR "message_count" >= 0)
        AND ("component_count" IS NULL OR "component_count" >= 0)
        AND ("persisted_thread_count" IS NULL OR "persisted_thread_count" >= 0)
        AND ("parser_exception_count" IS NULL OR "parser_exception_count" >= 0)
        AND ("coverage_exception_count" IS NULL OR "coverage_exception_count" >= 0)
      `,
    ),
    check(
      'thread_audit_snapshot_trust_shape_check',
      sql`
        (
          "trust_status" = 'valid'
          AND "trust_reason_code" = 'verified'
          AND "message_count" IS NOT NULL
          AND "component_count" IS NOT NULL
          AND "persisted_thread_count" IS NOT NULL
          AND "parser_exception_count" IS NOT NULL
          AND "coverage_exception_count" IS NOT NULL
          AND "metrics_and_insights" IS NOT NULL
          AND jsonb_typeof("metrics_and_insights") = 'object'
        )
        OR (
          "trust_status" = 'incomplete'
          AND "trust_reason_code" <> 'verified'
          AND "message_count" IS NULL
          AND "component_count" IS NULL
          AND "persisted_thread_count" IS NULL
          AND "parser_exception_count" IS NULL
          AND "coverage_exception_count" IS NULL
          AND "metrics_and_insights" IS NULL
        )
      `,
    ),
  ],
);

export const threadAuditSnapshotComponent = pgTable(
  'thread_audit_snapshot_component',
  {
    snapshotId: text('snapshot_id').notNull(),
    componentId: text('component_id').notNull(),
    transportId: text('transport_id').notNull(),
    finalState: threadAuditSnapshotStateEnum('final_state').notNull(),
    reasonCodes: text('reason_codes').array().notNull(),
    limitationCodes: text('limitation_codes').array().notNull(),
    evidenceTier: threadAuditSnapshotEvidenceTierEnum('evidence_tier').notNull(),
    impactClass: threadAuditSnapshotImpactClassEnum('impact_class').notNull(),
    ageBucket: threadAuditSnapshotAgeBucketEnum('age_bucket').notNull(),
    handoffState: threadAuditSnapshotHandoffStateEnum('handoff_state').notNull(),
    nextHumanCheck: threadAuditSnapshotNextHumanCheckEnum('next_human_check').notNull(),
    exampleSelectionReason: threadAuditSnapshotExampleSelectionReasonEnum(
      'example_selection_reason',
    ),
    latestActionAt: timestamp('latest_action_at', { withTimezone: true }),
    initialMappingCount: integer('initial_mapping_count').notNull(),
    sortGroup: integer('sort_group').notNull(),
    sortRank: integer('sort_rank').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.snapshotId, t.componentId, t.transportId],
    }),
    foreignKey({
      columns: [t.snapshotId, t.transportId],
      foreignColumns: [threadAuditSnapshot.id, threadAuditSnapshot.transportId],
      name: 'thread_audit_snapshot_component_snapshot_transport_fk',
    }).onDelete('cascade'),
    index('thread_audit_snapshot_component_snapshot_sort_idx').on(
      t.snapshotId,
      t.transportId,
      t.sortGroup,
      t.sortRank,
      t.componentId,
    ),
    check(
      'thread_audit_snapshot_component_count_check',
      sql`"initial_mapping_count" >= 0 AND "sort_group" >= 0 AND "sort_group" <= 2 AND "sort_rank" >= 0`,
    ),
  ],
);

export const threadAuditSnapshotComponentThread = pgTable(
  'thread_audit_snapshot_component_thread',
  {
    snapshotId: text('snapshot_id').notNull(),
    componentId: text('component_id').notNull(),
    transportId: text('transport_id').notNull(),
    threadId: text('thread_id').notNull(),
    sourceMembershipRank: integer('source_membership_rank').notNull(),
    isPrimary: boolean('is_primary').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.snapshotId, t.componentId, t.transportId, t.threadId],
    }),
    foreignKey({
      columns: [t.snapshotId, t.componentId, t.transportId],
      foreignColumns: [
        threadAuditSnapshotComponent.snapshotId,
        threadAuditSnapshotComponent.componentId,
        threadAuditSnapshotComponent.transportId,
      ],
      name: 'thread_audit_snapshot_component_thread_component_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.threadId, t.transportId],
      foreignColumns: [mailThread.id, mailThread.transportId],
      name: 'thread_audit_snapshot_component_thread_thread_transport_fk',
    }).onDelete('cascade'),
    uniqueIndex('thread_audit_snapshot_component_thread_rank_uidx').on(
      t.snapshotId,
      t.componentId,
      t.transportId,
      t.sourceMembershipRank,
    ),
    uniqueIndex('thread_audit_snapshot_component_thread_primary_uidx')
      .on(t.snapshotId, t.componentId, t.transportId)
      .where(sql`${t.isPrimary}`),
    check(
      'thread_audit_snapshot_component_thread_rank_check',
      sql`"source_membership_rank" >= 0`,
    ),
  ],
);

export const message = pgTable(
  'message',
  {
    id: text('id').primaryKey(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => mailThread.id, { onDelete: 'cascade' }),
    ingestMailboxId: text('ingest_mailbox_id').references(
      () => mailIngestMailbox.id,
      { onDelete: 'set null' },
    ),
    direction: messageDirectionEnum('direction').notNull(),
    pop3Uidl: text('pop3_uidl'),
    ownerHeaderValue: text('owner_header_value'),
    messageIdHeader: text('message_id_header'),
    inReplyTo: text('in_reply_to'),
    references: jsonb('references').$type<string[]>(),
    fromAddress: text('from_address').notNull(),
    toAddresses: jsonb('to_addresses').$type<string[]>().notNull().default([]),
    ccAddresses: jsonb('cc_addresses').$type<string[]>().notNull().default([]),
    bccAddresses: jsonb('bcc_addresses').$type<string[]>().notNull().default([]),
    subject: text('subject'),
    textBody: text('text_body'),
    htmlBody: text('html_body'),
    rawMimeS3Key: text('raw_mime_s3_key'),
    isRead: boolean('is_read').notNull().default(false),
    isStarred: boolean('is_starred').notNull().default(false),
    receivedAt: timestamp('received_at'),
    sentAt: timestamp('sent_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('message_ingest_uidl_uidx')
      .on(t.ingestMailboxId, t.pop3Uidl)
      .where(sql`${t.direction} = 'inbound'`),
    index('message_transport_thread_idx').on(t.transportId, t.threadId),
    index('message_transport_received_idx').on(t.transportId, t.receivedAt),
  ],
);

export const attachment = pgTable(
  'attachment',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    s3Key: text('s3_key').notNull(),
    contentId: text('content_id'),
    isInline: boolean('is_inline').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('attachment_message_idx').on(t.messageId),
    index('attachment_s3_key_idx').on(t.s3Key),
  ],
);

export const aiDraftGeneration = pgTable(
  'ai_draft_generation',
  {
    id: text('id').primaryKey(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => mailThread.id, { onDelete: 'cascade' }),
    requestedByUserId: text('requested_by_user_id').notNull(),
    contextMessageIds: jsonb('context_message_ids').$type<string[]>().notNull().default([]),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    promptHash: text('prompt_hash'),
    status: text('status').notNull().default('succeeded'),
    errorMessage: text('error_message'),
    outcome: text('outcome'),
    threadStateVersion: text('thread_state_version'),
    evidence: jsonb('evidence').$type<unknown[]>().notNull().default([]),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('ai_draft_generation_thread_idx').on(t.transportId, t.threadId, t.createdAt),
  ],
);

export const mailDraft = pgTable(
  'mail_draft',
  {
    id: text('id').primaryKey(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(() => mailThread.id, {
      onDelete: 'cascade',
    }),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    toAddresses: jsonb('to_addresses').$type<string[]>().notNull().default([]),
    ccAddresses: jsonb('cc_addresses').$type<string[]>().notNull().default([]),
    bccAddresses: jsonb('bcc_addresses').$type<string[]>().notNull().default([]),
    subject: text('subject'),
    textBody: text('text_body'),
    htmlBody: text('html_body'),
    attachments: jsonb('attachments').$type<
      { filename: string; mimeType: string; sizeBytes: number; s3Key: string }[]
    >().notNull().default([]),
    isSent: boolean('is_sent').notNull().default(false),
    status: mailDraftStatusEnum('status').notNull().default('active'),
    origin: mailDraftOriginEnum('origin').notNull().default('manual'),
    replyToMessageId: text('reply_to_message_id').references(() => message.id, {
      onDelete: 'set null',
    }),
    generationId: text('generation_id').references(() => aiDraftGeneration.id, {
      onDelete: 'set null',
    }),
    sentMessageId: text('sent_message_id').references(() => message.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('mail_draft_transport_idx').on(t.transportId),
    index('mail_draft_thread_idx').on(t.threadId),
    index('mail_draft_created_by_idx').on(t.createdByUserId),
    index('mail_draft_thread_status_idx').on(t.transportId, t.threadId, t.status, t.updatedAt),
    index('mail_draft_reply_to_message_idx').on(t.replyToMessageId),
    index('mail_draft_generation_idx').on(t.generationId),
    uniqueIndex('mail_draft_one_active_thread_uidx')
      .on(t.transportId, t.threadId)
      .where(sql`${t.status} = 'active' AND ${t.threadId} IS NOT NULL`),
  ],
);

export const mailDraftRevision = pgTable(
  'mail_draft_revision',
  {
    id: text('id').primaryKey(),
    draftId: text('draft_id')
      .notNull()
      .references(() => mailDraft.id, { onDelete: 'cascade' }),
    generationId: text('generation_id').references(() => aiDraftGeneration.id, {
      onDelete: 'set null',
    }),
    sentMessageId: text('sent_message_id').references(() => message.id, {
      onDelete: 'set null',
    }),
    actorUserId: text('actor_user_id'),
    kind: mailDraftRevisionKindEnum('kind').notNull(),
    toAddresses: jsonb('to_addresses').$type<string[]>().notNull().default([]),
    ccAddresses: jsonb('cc_addresses').$type<string[]>().notNull().default([]),
    bccAddresses: jsonb('bcc_addresses').$type<string[]>().notNull().default([]),
    subject: text('subject'),
    textBody: text('text_body'),
    htmlBody: text('html_body'),
    attachments: jsonb('attachments').$type<
      { filename: string; mimeType: string; sizeBytes: number; s3Key: string }[]
    >().notNull().default([]),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('mail_draft_revision_draft_idx').on(t.draftId, t.createdAt),
    index('mail_draft_revision_generation_idx').on(t.generationId),
    index('mail_draft_revision_sent_message_idx').on(t.sentMessageId),
  ],
);

export const aiWorkflowRun = pgTable(
  'ai_workflow_run',
  {
    id: text('id').primaryKey(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => mailThread.id, { onDelete: 'cascade' }),
    triggerMessageId: text('trigger_message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    runKind: aiWorkflowRunKindEnum('run_kind').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    modelId: text('model_id').notNull(),
    promptVersion: text('prompt_version').notNull(),
    promptHash: text('prompt_hash'),
    state: aiWorkflowRunStateEnum('state').notNull().default('queued'),
    executorLane: aiExecutorLaneEnum('executor_lane').notNull().default('default'),
    claimOwner: text('claim_owner'),
    claimToken: text('claim_token'),
    attempts: integer('attempts').notNull().default(0),
    nextRunAt: timestamp('next_run_at'),
    mastraTraceId: text('mastra_trace_id'),
    mastraScorerId: text('mastra_scorer_id'),
    generationId: text('generation_id').references(() => aiDraftGeneration.id, {
      onDelete: 'set null',
    }),
    metrics: jsonb('metrics').$type<Record<string, unknown>>(),
    lastError: text('last_error'),
    failureClass: text('failure_class'),
    claimedAt: timestamp('claimed_at'),
    heartbeatAt: timestamp('heartbeat_at'),
    deadlineAt: timestamp('deadline_at'),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ai_workflow_run_idempotency_uidx').on(t.idempotencyKey),
    index('ai_workflow_run_claim_idx').on(t.state, t.nextRunAt, t.createdAt),
    index('ai_workflow_run_lane_claim_idx').on(t.executorLane, t.state, t.nextRunAt, t.createdAt),
    index('ai_workflow_run_transport_idx').on(t.transportId, t.state, t.createdAt),
    index('ai_workflow_run_thread_idx').on(t.threadId, t.runKind),
    index('ai_workflow_run_trigger_message_idx').on(t.triggerMessageId),
  ],
);

/** Outbound SMTP undo/schedule queue — claimed by worker `flushDue`. */
export const outboundSendQueue = pgTable(
  'outbound_send_queue',
  {
    id: text('id').primaryKey(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    messageId: text('message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    sendAt: timestamp('send_at', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('pending'),
    smtpPayload: jsonb('smtp_payload').$type<Record<string, unknown>>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('outbound_send_queue_message_uidx').on(t.messageId),
    index('outbound_send_queue_due_idx').on(t.status, t.sendAt),
    index('outbound_send_queue_transport_idx').on(t.transportId, t.status),
  ],
);

export type OutboundSendQueueStatus = 'pending' | 'sending' | 'sent' | 'cancelled';

export type MailboxAccessRole = (typeof mailboxAccessRoleEnum.enumValues)[number];
export type MailboxType = (typeof mailboxTypeEnum.enumValues)[number];
export type MessageDirection = (typeof messageDirectionEnum.enumValues)[number];
