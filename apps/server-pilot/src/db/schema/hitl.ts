import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { mailboxTransport, mailThread, message } from './mail.js';
import { sql } from 'drizzle-orm';
import { user } from './auth.js';

/**
 * Human-in-the-loop decision ledger. Server only; written only when HITL_LEDGER=on.
 * Text + CHECK constraints instead of pgEnum so vocabularies grow by additive
 * migration. Each table carries a hard retention_expires_at for the purge job.
 * Hand-written migration: drizzle/0046_hitl_ledger.sql (keep the lists below in sync).
 */

const sqlList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export const AGENT_RUN_TRIGGERS = ['pane', 'warmer', 'backfill'] as const;
export const AGENT_RUN_CACHE_STATUSES = ['miss', 'hit', 'backfill'] as const;
export const AGENT_RUN_SOURCES = ['luna', 'regex_fallback'] as const;
export const HITL_EPISODE_OUTCOMES = [
  'open',
  'quoted',
  'drafted',
  'sent',
  'booked',
  'cancelled',
  'abandoned',
  'failed',
] as const;
export const HITL_LABEL_STRENGTHS = ['booked', 'sent', 'tool_input', 'edited', 'none'] as const;
export const HITL_EVENT_KINDS = [
  'analysis.shown',
  'field.edit',
  'workflow.override',
  'reanalyse.requested',
  'review_item.handled',
  'review_item.unhandled',
  'stay.selected',
  'offer.selected',
  'fields.snapshot',
  'draft.inserted',
  'draft.insert_failed',
  'pane.left',
] as const;
export const HITL_TOOL_RUN_KINDS = [
  'quote',
  'pdf',
  'source_pdf',
  'excel',
  'booking_draft',
  'stay_preview',
  'stay_commit',
  'cancel_preview',
  'cancel_commit',
  'stay_lookup',
  'guest_search',
  'party_lookup',
] as const;
export const HITL_TOOL_RUN_STATUSES = ['ok', 'refused', 'failed', 'unconfirmed'] as const;

/** One row per model analyse (or cache hit). Pane and warmer runs both land here. */
export const aiAgentRun = pgTable(
  'ai_agent_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    traceId: text('trace_id').notNull(),
    spanId: text('span_id').notNull(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    // Nullable with SET NULL: a decision record must survive a thread or message being deleted. Mail rows are
    // deleted by fixture cleanup, and cascading would erase the recorded answer along with them.
    threadId: text('thread_id').references(() => mailThread.id, { onDelete: 'set null' }),
    messageId: text('message_id').references(() => message.id, { onDelete: 'set null' }),
    episodeId: uuid('episode_id').references((): AnyPgColumn => hitlEpisode.id, {
      onDelete: 'set null',
    }),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    cachedFromRunId: uuid('cached_from_run_id').references((): AnyPgColumn => aiAgentRun.id, {
      onDelete: 'set null',
    }),
    trigger: text('trigger').notNull(),
    cacheStatus: text('cache_status').notNull(),
    agent: text('agent').notNull().default('luna'),
    provider: text('provider'),
    modelId: text('model_id'),
    modelRoute: text('model_route'),
    promptVersion: text('prompt_version').notNull(),
    schemaVersion: text('schema_version').notNull().default('agent-run/1'),
    fieldVocabVersion: text('field_vocab_version').notNull().default('hitl-fields/1'),
    releaseId: text('release_id'),
    inputHash: text('input_hash').notNull(),
    inputKey: text('input_key').notNull(),
    treatAs: text('treat_as'),
    staffNotePresent: boolean('staff_note_present').notNull().default(false),
    source: text('source').notNull(),
    fallbackReason: text('fallback_reason'),
    workflow: text('workflow'),
    latencyMs: integer('latency_ms'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    usageSource: text('usage_source'),
    output: jsonb('output').$type<Record<string, unknown>>(),
    suggestedFields: jsonb('suggested_fields').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    retentionExpiresAt: timestamp('retention_expires_at').notNull(),
  },
  (t) => [
    check('ai_agent_run_trigger_check', sql`${t.trigger} IN (${sqlList(AGENT_RUN_TRIGGERS)})`),
    check(
      'ai_agent_run_cache_status_check',
      sql`${t.cacheStatus} IN (${sqlList(AGENT_RUN_CACHE_STATUSES)})`,
    ),
    check('ai_agent_run_source_check', sql`${t.source} IN (${sqlList(AGENT_RUN_SOURCES)})`),
    check('ai_agent_run_trace_id_check', sql`${t.traceId} ~ '^[0-9a-f]{32}$'`),
    check('ai_agent_run_span_id_check', sql`${t.spanId} ~ '^[0-9a-f]{16}$'`),
    index('ai_agent_run_message_created_idx').on(t.transportId, t.messageId, t.createdAt),
    index('ai_agent_run_input_key_idx').on(t.inputKey),
    index('ai_agent_run_episode_idx').on(t.episodeId),
    index('ai_agent_run_prompt_created_idx').on(t.promptVersion, t.createdAt),
    index('ai_agent_run_retention_idx').on(t.retentionExpiresAt),
  ],
);

/** The per-(mail, user) decision thread: first and latest analyse, then what staff did. */
export const hitlEpisode = pgTable(
  'hitl_episode',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    messageId: text('message_id').references(() => message.id, { onDelete: 'set null' }),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    firstRunId: uuid('first_run_id').references((): AnyPgColumn => aiAgentRun.id, {
      onDelete: 'set null',
    }),
    latestRunId: uuid('latest_run_id').references((): AnyPgColumn => aiAgentRun.id, {
      onDelete: 'set null',
    }),
    displayedFields: jsonb('displayed_fields').$type<Record<string, unknown>>(),
    finalFields: jsonb('final_fields').$type<Record<string, unknown>>(),
    finalWorkflow: text('final_workflow'),
    firstSeenAt: timestamp('first_seen_at').notNull().defaultNow(),
    firstToolAt: timestamp('first_tool_at'),
    draftInsertedAt: timestamp('draft_inserted_at'),
    sentMessageId: text('sent_message_id').references(() => message.id, { onDelete: 'set null' }),
    sentAt: timestamp('sent_at'),
    bookedConfirmationNo: text('booked_confirmation_no'),
    outcome: text('outcome').notNull().default('open'),
    labelStrength: text('label_strength').notNull().default('none'),
    metrics: jsonb('metrics').$type<Record<string, unknown>>(),
    scorerVersion: text('scorer_version'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    retentionExpiresAt: timestamp('retention_expires_at').notNull(),
  },
  (t) => [
    uniqueIndex('hitl_episode_message_user_uidx').on(t.transportId, t.messageId, t.userId),
    check('hitl_episode_outcome_check', sql`${t.outcome} IN (${sqlList(HITL_EPISODE_OUTCOMES)})`),
    check(
      'hitl_episode_label_strength_check',
      sql`${t.labelStrength} IN (${sqlList(HITL_LABEL_STRENGTHS)})`,
    ),
    index('hitl_episode_retention_idx').on(t.retentionExpiresAt),
  ],
);

/** Append-only staff-side events. Client may supply the id (idempotent retry). */
export const hitlEvent = pgTable(
  'hitl_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    episodeId: uuid('episode_id')
      .notNull()
      .references(() => hitlEpisode.id, { onDelete: 'cascade' }),
    agentRunId: uuid('agent_run_id').references(() => aiAgentRun.id, { onDelete: 'set null' }),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    fieldPath: text('field_path'),
    before: jsonb('before'),
    after: jsonb('after'),
    priorProvenance: text('prior_provenance'),
    payload: jsonb('payload'),
    paneSessionId: text('pane_session_id'),
    clientSeq: integer('client_seq'),
    selectionEpoch: integer('selection_epoch'),
    inputRevision: integer('input_revision'),
    clientAt: timestamp('client_at'),
    receivedAt: timestamp('received_at').notNull().defaultNow(),
    paneRelease: text('pane_release'),
    schemaVersion: text('schema_version').notNull().default('hitl-event/1'),
  },
  (t) => [
    check('hitl_event_kind_check', sql`${t.kind} IN (${sqlList(HITL_EVENT_KINDS)})`),
    index('hitl_event_episode_seq_idx').on(t.episodeId, t.clientSeq),
    index('hitl_event_kind_received_idx').on(t.kind, t.receivedAt),
    index('hitl_event_field_path_idx')
      .on(t.fieldPath)
      .where(sql`${t.fieldPath} IS NOT NULL`),
  ],
);

/** One deterministic PMS tool invocation (quote, PDF, booking, lookup) and its outcome. */
export const hitlToolRun = pgTable(
  'hitl_tool_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    episodeId: uuid('episode_id').references(() => hitlEpisode.id, { onDelete: 'set null' }),
    messageId: text('message_id').references(() => message.id, { onDelete: 'set null' }),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    transportId: text('transport_id')
      .notNull()
      .references(() => mailboxTransport.id, { onDelete: 'cascade' }),
    /**
     * Plain reference, deliberately no FK: ledger rows must not depend on the
     * ai_workflow_run queue. A FK here pins ai_workflow_run_pkey, which breaks
     * the migration-compatibility gate's pkey-drop case.
     */
    workflowRunId: text('workflow_run_id'),
    kind: text('kind').notNull(),
    input: jsonb('input'),
    inputDigest: text('input_digest'),
    status: text('status').notNull(),
    errorCode: text('error_code'),
    result: jsonb('result'),
    confirmationNo: text('confirmation_no'),
    hmsRunId: text('hms_run_id'),
    startedAt: timestamp('started_at').notNull().defaultNow(),
    durationMs: integer('duration_ms'),
    retentionExpiresAt: timestamp('retention_expires_at').notNull(),
  },
  (t) => [
    check('hitl_tool_run_kind_check', sql`${t.kind} IN (${sqlList(HITL_TOOL_RUN_KINDS)})`),
    check('hitl_tool_run_status_check', sql`${t.status} IN (${sqlList(HITL_TOOL_RUN_STATUSES)})`),
    index('hitl_tool_run_episode_started_idx').on(t.episodeId, t.startedAt),
    index('hitl_tool_run_transport_kind_started_idx').on(t.transportId, t.kind, t.startedAt),
    index('hitl_tool_run_workflow_run_idx').on(t.workflowRunId),
    index('hitl_tool_run_confirmation_idx')
      .on(t.confirmationNo)
      .where(sql`${t.confirmationNo} IS NOT NULL`),
    index('hitl_tool_run_retention_idx').on(t.retentionExpiresAt),
  ],
);

export type AiAgentRun = typeof aiAgentRun.$inferSelect;
export type HitlEpisode = typeof hitlEpisode.$inferSelect;
export type HitlEvent = typeof hitlEvent.$inferSelect;
export type HitlToolRun = typeof hitlToolRun.$inferSelect;
