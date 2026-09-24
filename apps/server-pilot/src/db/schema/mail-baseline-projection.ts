import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { mailboxTransport, mailThread, message } from './mail.js';

/**
 * Immutable semantic evidence emitted by the committed inbound/outbound
 * producers. One row is one extraction generation and one compact fact; the
 * request reducer is intentionally recomputable from these rows.
 */
export const mailBaselineProjection = pgTable(
  'mail_baseline_projection',
  {
    id: text('id').primaryKey(),
    generationKey: text('generation_key').notNull(),
    generationId: text('generation_id').notNull(),
    projectionVersion: text('projection_version').notNull(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => mailThread.id, { onDelete: 'cascade' }),
    sourceMessageId: text('source_message_id').references(() => message.id, {
      onDelete: 'set null',
    }),
    requestId: text('request_id').notNull(),
    askId: text('ask_id').notNull(),
    eventKind: text('event_kind').notNull(),
    direction: text('direction').notNull(),
    eventAt: timestamp('event_at'),
    observedAt: timestamp('observed_at'),
    source: text('source').notNull(),
    sourceBasis: text('source_basis').notNull(),
    sourceVintage: text('source_vintage').notNull(),
    interpretationVersion: text('interpretation_version').notNull(),
    classifierVersion: text('classifier_version'),
    reviewerVersion: text('reviewer_version'),
    observationCutoff: timestamp('observation_cutoff').notNull(),
    measurementStartAt: timestamp('measurement_start_at'),
    coverage: jsonb('coverage').$type<Record<string, unknown>>().notNull().default({}),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mail_baseline_projection_generation_uidx').on(t.generationKey),
    index('mail_baseline_projection_scope_idx').on(t.transportId, t.threadId, t.eventAt),
    index('mail_baseline_projection_cutoff_idx').on(t.transportId, t.observationCutoff, t.eventAt),
  ],
);
