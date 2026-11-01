import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { mailboxTransport, mailThread, message } from './mail.js';
import { sqlList } from './hitl.js';
import { sql } from 'drizzle-orm';
import { user } from './auth.js';

/**
 * Nava pane work items. Text + CHECK constraints instead of pgEnum, as in hitl.ts.
 * Hand-written migration: drizzle/0047_nava_work_items.sql (keep the lists below in sync).
 */

/** Mail types (R1). The extraction and the work item seeded from it share one list. */
export const MAIL_KINDS = [
  'quote',
  'booking',
  'amendment',
  'cancellation',
  'voucher_pop',
  'spam',
  'other',
] as const;
export const MAIL_EXTRACTION_STATUSES = ['succeeded', 'failed'] as const;
export const WORK_ITEM_STATUSES = ['needs_you', 'review', 'done', 'dismissed'] as const;
export const WORK_EVENT_ACTOR_KINDS = ['user', 'ai', 'system'] as const;
/** Event type vocabulary. No DB CHECK (new types need no migration): writers must validate against it. */
export const WORK_EVENT_TYPES = [
  'field.seed',
  'field.edit',
  'field.accept',
  'field.reject',
  'approval.granted',
  'approval.consumed',
  'write.evidence',
  'review.ok',
  'review.flag',
  'status.changed',
  'source.delivered_at.backfilled',
  'rate.saved',
  'rate.one_off',
  'rate.override',
  'quote.prepared',
  'quote.finalized',
  'request.handled',
  // Pane action telemetry (v5 B1) and staff notes (B2). Payload in `value`; no mail text.
  'pane.opened',
  'copy.hms_line',
  'copy.confirmation',
  'copy.link',
  'copy.contact',
  'reply.inserted',
  'reply.saved',
  'pdf.created',
  'excel.downloaded',
  'hms.lookup.started',
  'hms.lookup.finished',
  'item.dismissed',
  'note.staff',
  'admin_review',
  'history.undo',
  'history.redo',
  'field.reset',
] as const;
export type WorkEventType = (typeof WORK_EVENT_TYPES)[number];
/**
 * User events that are not a person's decision on the item: pane telemetry (B1) and the dismissal. A plain field.accept
 * (an AI value confirmed as read without a correction) is not one either, but the follow-up suggestion's accept is. Every
 * reader of "touched" goes through personTouchSql (work-items.ts), which applies both rules.
 */
export const TELEMETRY_EVENT_TYPES = [
  'pane.opened',
  'copy.hms_line',
  'copy.confirmation',
  'copy.link',
  'copy.contact',
  'reply.inserted',
  'reply.saved',
  'pdf.created',
  'excel.downloaded',
  'hms.lookup.started',
  'hms.lookup.finished',
  'item.dismissed',
] as const;
/**
 * work_event field path of the quote follow-up suggestion as a whole (R10). Not a stay path, so the field-event route
 * never writes it. Its field.accept (useFollowUpDraft, from the Outlook reminder) is the person's decision to send the
 * follow-up, so it touches the item. Its field.reject (dismissFollowUpDraft) already did.
 */
export const FOLLOW_UP_DRAFT_FIELD_PATH = 'followUp.draft';
export const EVAL_LABEL_KINDS = ['correction', 'confirmation', 'run_flag', 'note'] as const;
export const EVAL_LABEL_SPLITS = ['dev', 'holdout', 'test'] as const;

/** One read of an admitted inbound message, per extractor version. Cascades with the message. */
export const mailExtraction = pgTable(
  'mail_extraction',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: text('message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    extractorVersion: text('extractor_version').notNull(),
    status: text('status').notNull(),
    kind: text('kind'),
    language: text('language'),
    // ponytail: loosely typed until the extraction contracts land in U3.
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    translation: jsonb('translation').$type<Record<string, unknown>>(),
    attachments: jsonb('attachments').$type<Record<string, unknown>[]>(),
    usage: jsonb('usage').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mail_extraction_message_version_uidx').on(t.messageId, t.extractorVersion),
    check(
      'mail_extraction_status_check',
      sql`${t.status} IN (${sqlList(MAIL_EXTRACTION_STATUSES)})`,
    ),
    check('mail_extraction_kind_check', sql`${t.kind} IN (${sqlList(MAIL_KINDS)})`),
  ],
);

/**
 * The work for one (thread, kind, source message). Stores only the status a person sees (KTD14).
 * Mail links are SET NULL: deleting the mail is never blocked and keeps the item and its events.
 */
export const workItem = pgTable(
  'work_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(() => mailThread.id, { onDelete: 'set null' }),
    sourceMessageId: text('source_message_id').references(() => message.id, {
      onDelete: 'set null',
    }),
    kind: text('kind').notNull(),
    // Set null: deleting an extraction version must not delete the work item.
    extractionId: uuid('extraction_id').references((): AnyPgColumn => mailExtraction.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('needs_you'),
    state: jsonb('state')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    quoteFileKeys: jsonb('quote_file_keys').$type<string[]>(),
    sentMessageId: text('sent_message_id').references(() => message.id, { onDelete: 'set null' }),
    sentAt: timestamp('sent_at'),
    followUpDueAt: timestamp('follow_up_due_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    /** Applied pane-field revisions. Undo/redo move this cursor; work_event rows stay append-only. */
    revision: integer('revision').notNull().default(0),
    revisionHead: integer('revision_head').notNull().default(0),
    /** Monotonic occupancy token. Increases on every edit/undo/redo; never reused. */
    revisionSeq: integer('revision_seq').notNull().default(0),
  },
  (t) => [
    uniqueIndex('work_item_thread_kind_source_uidx').on(t.threadId, t.kind, t.sourceMessageId),
    index('work_item_transport_status_updated_idx').on(t.transportId, t.status, t.updatedAt),
    check('work_item_kind_check', sql`${t.kind} IN (${sqlList(MAIL_KINDS)})`),
    check('work_item_status_check', sql`${t.status} IN (${sqlList(WORK_ITEM_STATUSES)})`),
  ],
);

/**
 * Append-only decision log per work item (KTD2). The authoritative HITL record, written in the same
 * transaction as the state change. A trigger in 0047 refuses UPDATE and DELETE. The FK is RESTRICT, and
 * work_item's mail links are SET NULL, so deleting mail cannot erase approval history. A unique index
 * makes each approval.consumed single-use per (work item, payload hash) (KTD12).
 */
export const workEvent = pgTable(
  'work_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItem.id, { onDelete: 'restrict' }),
    at: timestamp('at').notNull().defaultNow(),
    actorKind: text('actor_kind').notNull(),
    // No FK: a referential action would UPDATE this row, and the append-only trigger refuses it.
    actorUserId: text('actor_user_id'),
    type: text('type').$type<WorkEventType>().notNull(),
    fieldPath: text('field_path'),
    aiValue: jsonb('ai_value'),
    value: jsonb('value'),
    aiSource: text('ai_source'),
    msSinceOpen: integer('ms_since_open'),
    payloadHash: text('payload_hash'),
    expiresAt: timestamp('expires_at'),
    evidence: jsonb('evidence'),
  },
  (t) => [
    index('work_event_work_item_at_idx').on(t.workItemId, t.at),
    check(
      'work_event_actor_kind_check',
      sql`${t.actorKind} IN (${sqlList(WORK_EVENT_ACTOR_KINDS)})`,
    ),
    uniqueIndex('work_event_approval_consumed_uidx')
      .on(t.workItemId, t.payloadHash)
      .where(sql`${t.type} = 'approval.consumed'`),
    check(
      'work_event_approval_hash_check',
      sql`${t.type} NOT IN ('approval.granted', 'approval.consumed') OR ${t.payloadHash} IS NOT NULL`,
    ),
  ],
);

/** Saved rates per transport (R7). Archive rather than delete. One active name per transport. */
export const customRate = pgTable(
  'custom_rate',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    board: text('board'),
    /** Empty means every room type. */
    roomCodes: jsonb('room_codes')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    validFrom: timestamp('valid_from'),
    validTo: timestamp('valid_to'),
    note: text('note'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    archivedAt: timestamp('archived_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('custom_rate_transport_name_active_uidx')
      .on(t.transportId, t.name)
      .where(sql`${t.archivedAt} IS NULL`),
    check('custom_rate_amount_check', sql`${t.amountMinor} >= 0`),
  ],
);

/**
 * One eval label per (work item, field): what the AI read vs what a person kept (v5 flywheel).
 * Hand-written migration: drizzle/0048_eval_label.sql. Derived data: rows go with the work item;
 * the message and source event links are SET NULL. One label per source event, so a re-export is idempotent.
 */
export const evalLabel = pgTable(
  'eval_label',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItem.id, { onDelete: 'cascade' }),
    messageId: text('message_id').references(() => message.id, { onDelete: 'set null' }),
    fieldPath: text('field_path').notNull(),
    aiValue: jsonb('ai_value'),
    humanValue: jsonb('human_value'),
    labelKind: text('label_kind').notNull(),
    sourceEventId: uuid('source_event_id').references(() => workEvent.id, { onDelete: 'set null' }),
    extractorVersion: text('extractor_version'),
    modelRoute: text('model_route'),
    split: text('split').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('eval_label_split_field_idx').on(t.split, t.fieldPath),
    uniqueIndex('eval_label_source_event_uidx')
      .on(t.sourceEventId)
      .where(sql`${t.sourceEventId} IS NOT NULL`),
    check('eval_label_kind_check', sql`${t.labelKind} IN (${sqlList(EVAL_LABEL_KINDS)})`),
    check('eval_label_split_check', sql`${t.split} IN (${sqlList(EVAL_LABEL_SPLITS)})`),
  ],
);
