import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { defaultUserSettings } from '../../lib/schemas.js';

export const note = pgTable(
  'note',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').notNull(),
    content: text('content').notNull(),
    color: text('color').notNull().default('default'),
    isPinned: boolean('is_pinned').default(false),
    order: integer('order').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('note_user_id_idx').on(t.userId),
    index('note_thread_id_idx').on(t.threadId),
    index('note_user_thread_idx').on(t.userId, t.threadId),
    index('note_is_pinned_idx').on(t.isPinned),
  ],
);

export const userSettings = pgTable(
  'user_settings',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' })
      .unique(),
    settings: jsonb('settings')
      .$type<typeof defaultUserSettings>()
      .notNull()
      .default(defaultUserSettings),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
);

export const emailTemplate = pgTable(
  'email_template',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    subject: text('subject'),
    body: text('body'),
    to: jsonb('to'),
    cc: jsonb('cc'),
    bcc: jsonb('bcc'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('email_template_user_id_idx').on(t.userId),
    unique('email_template_user_id_name_unique').on(t.userId, t.name),
  ],
);

export const jwks = pgTable(
  'jwks',
  {
    id: text('id').primaryKey(),
    publicKey: text('public_key').notNull(),
    privateKey: text('private_key').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('jwks_created_at_idx').on(t.createdAt)],
);
