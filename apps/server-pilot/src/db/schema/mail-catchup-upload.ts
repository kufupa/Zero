import {
  pgTable,
  text,
  timestamp,
  bigint,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';

export const mailCatchupUploadStatusEnum = pgEnum('mail_catchup_upload_status', [
  'pending',
  'stored',
  'aborted',
]);

export const mailCatchupUpload = pgTable(
  'mail_catchup_upload',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    originalFilename: text('original_filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    s3Key: text('s3_key').notNull().unique(),
    s3UploadId: text('s3_upload_id'),
    status: mailCatchupUploadStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    completedAt: timestamp('completed_at'),
  },
  (t) => [
    index('mail_catchup_upload_user_created_idx').on(t.userId, t.createdAt),
  ],
);

export type MailCatchupUpload = typeof mailCatchupUpload.$inferSelect;
export type NewMailCatchupUpload = typeof mailCatchupUpload.$inferInsert;
