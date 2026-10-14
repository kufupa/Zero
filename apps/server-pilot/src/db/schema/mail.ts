import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  check,
  customType,
  foreignKey,
  smallint,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  MAIL_ACTIONS,
  MAIL_ACTION_LABEL_SOURCES,
  type MailAction,
  type MailActionLabelSource,
} from '../../mail/action-labels.js';
import { workItem } from './work.js';
import { sqlList } from './hitl.js';
import { sql } from 'drizzle-orm';
import { user } from './auth.js';

const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const mailboxAccessRoleEnum = pgEnum('mailbox_access_role', ['owner', 'member', 'admin']);

export const mailboxTypeEnum = pgEnum('mailbox_type', ['personal', 'shared']);

export const messageDirectionEnum = pgEnum('message_direction', ['inbound', 'outbound']);

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

export const mailDraftOriginEnum = pgEnum('mail_draft_origin', ['manual', 'ai']);

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
  'read_tool',
  'shadow_prediction',
  'inbound_extraction',
  'quote_followup',
  'hms_write',
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
    uniqueIndex('mail_ingest_quarantine_ingest_uidl_uidx').on(t.ingestMailboxId, t.pop3Uidl),
  ],
);

/**
 * Durable cleanup work for parsed attachment objects that did not become a
 * message attachment. Intentionally has no FK to quarantine: promotion may
 * remove a quarantine row while unresolved S3 cleanup must survive.
 */
export const mailIngestCandidateAttachmentCleanup = pgTable(
  'mail_ingest_candidate_attachment_cleanup',
  {
    s3Key: text('s3_key').primaryKey(),
    candidateMessageId: text('candidate_message_id').notNull(),
    ingestMailboxId: text('ingest_mailbox_id').notNull(),
    pop3Uidl: text('pop3_uidl').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at').notNull().defaultNow(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('mail_ingest_candidate_attachment_cleanup_ingest_uidl_idx').on(
      t.ingestMailboxId,
      t.pop3Uidl,
    ),
    index('mail_ingest_candidate_attachment_cleanup_sweep_idx').on(t.nextAttemptAt, t.s3Key),
    check(
      'mail_ingest_candidate_attachment_cleanup_owned_key_check',
      sql`length(${t.s3Key}) > length('attachments/' || ${t.candidateMessageId} || '/')
        AND left(${t.s3Key}, length('attachments/' || ${t.candidateMessageId} || '/')) =
          'attachments/' || ${t.candidateMessageId} || '/'`,
    ),
  ],
);

/**
 * Exclusive lease for one POP3 UIDL. It prevents the poller and a force-sync
 * request from retrieving and parsing the same message concurrently.
 */
export const mailIngestUidlClaim = pgTable(
  'mail_ingest_uidl_claim',
  {
    ingestMailboxId: text('ingest_mailbox_id').notNull(),
    pop3Uidl: text('pop3_uidl').notNull(),
    claimToken: text('claim_token').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'mail_ingest_uidl_claim_pk',
      columns: [t.ingestMailboxId, t.pop3Uidl],
    }),
    index('mail_ingest_uidl_claim_expires_idx').on(t.expiresAt),
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
    historyOnly: boolean('history_only').notNull().default(false),
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
    index('mail_thread_transport_list_idx').on(t.transportId, t.isArchived, t.latestMessageAt),
    index('mail_thread_snooze_wake_idx')
      .on(t.snoozedUntil)
      .where(sql`${t.snoozedUntil} IS NOT NULL`),
    index('mail_thread_search_vector_idx').using('gin', t.searchVector),
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
    ingestMailboxId: text('ingest_mailbox_id').references(() => mailIngestMailbox.id, {
      onDelete: 'set null',
    }),
    direction: messageDirectionEnum('direction').notNull(),
    historyOnly: boolean('history_only').notNull().default(false),
    originalMsgS3Key: text('original_msg_s3_key'),
    sourceProvenance: jsonb('source_provenance').$type<Record<string, unknown>>(),
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
    index('message_transport_header_idx')
      .on(t.transportId, t.messageIdHeader)
      .where(sql`${t.messageIdHeader} IS NOT NULL`),
    foreignKey({
      name: 'message_thread_transport_fk',
      columns: [t.threadId, t.transportId],
      foreignColumns: [mailThread.id, mailThread.transportId],
    }).onDelete('cascade'),
  ],
);

/**
 * Model predictions, agent gold labels and owner action marks without creating work items.
 * Hand-written migration: drizzle/0049_mail_action_label.sql. Labels go with their message
 * and transport. Owner writers use version 'owner' and upsert the same row on re-mark.
 */
export const mailActionLabel = pgTable(
  'mail_action_label',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    messageId: text('message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    source: text('source').$type<MailActionLabelSource>().notNull(),
    action: text('action').$type<MailAction>().notNull(),
    needsAction: boolean('needs_action').notNull(),
    version: text('version').notNull(),
    labelledBy: text('labelled_by'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mail_action_label_message_source_version_uidx').on(
      t.messageId,
      t.source,
      t.version,
    ),
    index('mail_action_label_transport_source_action_idx').on(t.transportId, t.source, t.action),
    check(
      'mail_action_label_source_check',
      sql`${t.source} IN (${sqlList(MAIL_ACTION_LABEL_SOURCES)})`,
    ),
    check('mail_action_label_action_check', sql`${t.action} IN (${sqlList(MAIL_ACTIONS)})`),
    check(
      'mail_action_label_needs_action_check',
      sql`${t.needsAction} = (${t.action} <> 'no_action')`,
    ),
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
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256'),
    sourceAttachmentId: text('source_attachment_id'),
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

export const messageReaction = pgTable(
  'message_reaction',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    userEmail: text('user_email').notNull(),
    userName: text('user_name'),
    reaction: text('reaction').notNull(),
    source: text('source').notNull().default('internal'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('message_reaction_message_idx').on(t.messageId),
    index('message_reaction_transport_idx').on(t.transportId),
    uniqueIndex('message_reaction_user_unique_idx').on(t.messageId, t.userEmail, t.reaction),
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
  (t) => [index('ai_draft_generation_thread_idx').on(t.transportId, t.threadId, t.createdAt)],
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
    attachments: jsonb('attachments')
      .$type<{ filename: string; mimeType: string; sizeBytes: number; s3Key: string }[]>()
      .notNull()
      .default([]),
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
    attachments: jsonb('attachments')
      .$type<{ filename: string; mimeType: string; sizeBytes: number; s3Key: string }[]>()
      .notNull()
      .default([]),
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
    admissionSnapshotId: text('admission_snapshot_id'),
    admissionSnapshotHash: text('admission_snapshot_hash'),
    /** Closed typed read request; private server-side input, never model text. */
    readRequest: jsonb('read_request').$type<Record<string, unknown>>(),
    /** Durable typed receipt reference for read_tool runs. */
    readResultRef: text('read_result_ref'),
    /** Private typed receipt body; populated only after a fenced read succeeds. */
    readResult: jsonb('read_result').$type<Record<string, unknown>>(),
    /** Receipt TTL copied from the trusted typed result evidence. */
    readResultExpiresAt: timestamp('read_result_expires_at'),
    state: aiWorkflowRunStateEnum('state').notNull().default('queued'),
    executorLane: aiExecutorLaneEnum('executor_lane').notNull().default('default'),
    /** Nullable, SET NULL: the run record outlives its work item. */
    workItemId: uuid('work_item_id').references((): AnyPgColumn => workItem.id, {
      onDelete: 'set null',
    }),
    /** Claim order within a lane: higher first, ahead of created_at. */
    priority: smallint('priority').notNull().default(0),
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
    uniqueIndex('ai_workflow_run_read_result_ref_uidx')
      .on(t.readResultRef)
      .where(sql`${t.readResultRef} IS NOT NULL`),
    index('ai_workflow_run_claim_idx').on(t.state, t.nextRunAt, t.createdAt),
    index('ai_workflow_run_lane_claim_idx').on(t.executorLane, t.state, t.nextRunAt, t.createdAt),
    index('ai_workflow_run_transport_idx').on(t.transportId, t.state, t.createdAt),
    index('ai_workflow_run_thread_idx').on(t.threadId, t.runKind),
    index('ai_workflow_run_trigger_message_idx').on(t.triggerMessageId),
    index('ai_workflow_run_work_item_created_idx').on(t.workItemId, t.createdAt),
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
    smtpAttemptedAt: timestamp('smtp_attempted_at', { withTimezone: true }),
    smtpOutcomePersistedAt: timestamp('smtp_outcome_persisted_at', { withTimezone: true }),
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

/** One immutable first operational admission; history insertion is independent. */
export const mailLiveAdmission = pgTable(
  'mail_live_admission',
  {
    id: text('id').primaryKey(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id),
    canonicalMessageId: text('canonical_message_id')
      .notNull()
      .references(() => message.id),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    snapshotHash: text('snapshot_hash').notNull(),
    effectState: text('effect_state').notNull(),
    admittedAt: timestamp('admitted_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('mail_live_admission_canonical_uq').on(t.transportId, t.canonicalMessageId)],
);

/** Independent verified POP3 sources remain addressable after canonical merging. */
export const mailIngestSourceReceipt = pgTable(
  'mail_ingest_source_receipt',
  {
    id: text('id').primaryKey(),
    ingestMailboxId: text('ingest_mailbox_id')
      .notNull()
      .references(() => mailIngestMailbox.id, { onDelete: 'cascade' }),
    pop3Uidl: text('pop3_uidl').notNull(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    canonicalMessageId: text('canonical_message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    rawMimeS3Key: text('raw_mime_s3_key').notNull(),
    sha256: text('sha256').notNull(),
    acceptedAt: timestamp('accepted_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mail_ingest_source_receipt_identity_uidx').on(t.ingestMailboxId, t.pop3Uidl),
    index('mail_ingest_source_receipt_canonical_idx').on(t.canonicalMessageId),
  ],
);
