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
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { user } from './auth.js';

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
    isArchived: boolean('is_archived').notNull().default(false),
    isStarred: boolean('is_starred').notNull().default(false),
    isRead: boolean('is_read').notNull().default(false),
    labelIds: jsonb('label_ids').$type<string[]>().notNull().default([]),
    snoozedUntil: timestamp('snoozed_until'),
    trashedAt: timestamp('trashed_at'),
    latestMessageAt: timestamp('latest_message_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mail_thread_transport_root_uidx').on(t.transportId, t.threadRootId),
    index('mail_thread_transport_list_idx').on(
      t.transportId,
      t.isArchived,
      t.latestMessageAt,
    ),
    index('mail_thread_snooze_wake_idx')
      .on(t.snoozedUntil)
      .where(sql`${t.snoozedUntil} IS NOT NULL`),
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
    sentMessageId: text('sent_message_id'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('mail_draft_transport_idx').on(t.transportId),
    index('mail_draft_thread_idx').on(t.threadId),
    index('mail_draft_created_by_idx').on(t.createdByUserId),
  ],
);

export type MailboxAccessRole = (typeof mailboxAccessRoleEnum.enumValues)[number];
export type MailboxType = (typeof mailboxTypeEnum.enumValues)[number];
export type MessageDirection = (typeof messageDirectionEnum.enumValues)[number];
