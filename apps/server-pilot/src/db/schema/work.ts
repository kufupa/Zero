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
export const WORK_EVENT_TYPES = [
  'field.seed',
  'field.edit',
  'field.accept',
  'field.reject',
  'approval.granted',
  'approval.consumed',
  'review.ok',
  'review.flag',
  'status.changed',
] as const;

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

/** The work for one (thread, kind, source message). Stores only the status a person sees (KTD14). */
export const workItem = pgTable(
  'work_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => mailThread.id, { onDelete: 'cascade' }),
    sourceMessageId: text('source_message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
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
 * transaction as the state change. A trigger in 0047 refuses UPDATE and DELETE. The FK is RESTRICT,
 * so deleting mail cannot erase approval history.
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
    type: text('type').notNull(),
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
    check('work_event_type_check', sql`${t.type} IN (${sqlList(WORK_EVENT_TYPES)})`),
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
