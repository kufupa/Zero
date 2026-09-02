import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { mailboxTransport, mailThread, message } from './mail.js';

export const mailConversationLinkTypeEnum = pgEnum('mail_conversation_link_type', [
  'header_parent',
  'domain_conf',
  'domain_guest_email',
  'quoted_body',
  'subject_cluster',
  'llm_link',
]);

export const mailConversationLink = pgTable(
  'mail_conversation_link',
  {
    id: text('id').primaryKey(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    srcThreadId: text('src_thread_id')
      .notNull()
      .references(() => mailThread.id, { onDelete: 'cascade' }),
    dstThreadId: text('dst_thread_id')
      .notNull()
      .references(() => mailThread.id, { onDelete: 'cascade' }),
    srcMessageId: text('src_message_id').references(() => message.id, { onDelete: 'set null' }),
    dstMessageId: text('dst_message_id').references(() => message.id, { onDelete: 'set null' }),
    linkType: mailConversationLinkTypeEnum('link_type').notNull(),
    confidence: numeric('confidence', { precision: 5, scale: 4 }).notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    supersededAt: timestamp('superseded_at'),
  },
  (t) => [
    uniqueIndex('mail_conversation_link_edge_uidx').on(
      t.transportId,
      t.srcThreadId,
      t.dstThreadId,
      t.linkType,
    ),
    index('mail_conversation_link_transport_src_idx').on(t.transportId, t.srcThreadId),
    index('mail_conversation_link_transport_dst_idx').on(t.transportId, t.dstThreadId),
  ],
);

export type MailConversationLinkType =
  (typeof mailConversationLinkTypeEnum.enumValues)[number];
