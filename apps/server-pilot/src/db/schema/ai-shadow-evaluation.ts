import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { mailboxTransport, mailThread, message } from './mail.js';

/** Private immutable prediction artifact. It is never a mail draft or label. */
export const aiShadowPrediction = pgTable(
  'ai_shadow_prediction',
  {
    id: text('id').primaryKey(),
    predictionKey: text('prediction_key').notNull(),
    evaluationMode: text('evaluation_mode').notNull(),
    evaluationVersion: text('evaluation_version').notNull(),
    admissionStatus: text('admission_status').notNull(),
    predictionStatus: text('prediction_status').notNull(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => mailThread.id, { onDelete: 'cascade' }),
    triggerMessageId: text('trigger_message_id').references(() => message.id, {
      onDelete: 'set null',
    }),
    asOfAt: timestamp('as_of_at').notNull(),
    sealedAt: timestamp('sealed_at').notNull(),
    observationEndsAt: timestamp('observation_ends_at').notNull(),
    sourceVintage: text('source_vintage').notNull(),
    inputDigest: text('input_digest').notNull(),
    messageIds: jsonb('message_ids').$type<string[]>().notNull().default([]),
    attachmentIds: jsonb('attachment_ids').$type<string[]>().notNull().default([]),
    excludedFutureMessageIds: jsonb('excluded_future_message_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    modelId: text('model_id'),
    promptVersion: text('prompt_version').notNull(),
    route: jsonb('route').$type<Record<string, unknown> | null>(),
    modelUsage: jsonb('model_usage').$type<Record<string, unknown> | null>(),
    prediction: jsonb('prediction').$type<Record<string, unknown> | null>(),
    unavailableReason: text('unavailable_reason'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ai_shadow_prediction_key_uidx').on(t.predictionKey),
    index('ai_shadow_prediction_scope_idx').on(t.transportId, t.threadId, t.asOfAt),
    index('ai_shadow_prediction_observation_idx').on(t.transportId, t.observationEndsAt),
    index('ai_shadow_prediction_status_idx').on(t.predictionStatus, t.createdAt),
  ],
);

/** Append-only delayed assessment revision; never mutates the prediction. */
export const aiShadowAssessment = pgTable(
  'ai_shadow_assessment',
  {
    id: text('id').primaryKey(),
    predictionId: text('prediction_id')
      .notNull()
      .references(() => aiShadowPrediction.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    revisionKey: text('revision_key').notNull(),
    evaluationMode: text('evaluation_mode').notNull(),
    status: text('status').notNull(),
    referenceMessageId: text('reference_message_id').references(() => message.id, {
      onDelete: 'set null',
    }),
    linkStrength: text('link_strength').notNull(),
    reason: text('reason').notNull(),
    labelProvenance: jsonb('label_provenance').$type<Record<string, unknown> | null>(),
    verdict: text('verdict'),
    assessment: jsonb('assessment').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ai_shadow_assessment_revision_key_uidx').on(t.revisionKey),
    uniqueIndex('ai_shadow_assessment_prediction_revision_uidx').on(t.predictionId, t.revision),
    index('ai_shadow_assessment_prediction_idx').on(t.predictionId, t.createdAt),
    index('ai_shadow_assessment_reference_idx').on(t.referenceMessageId),
  ],
);

export type AiShadowPrediction = typeof aiShadowPrediction.$inferSelect;
export type AiShadowAssessment = typeof aiShadowAssessment.$inferSelect;
