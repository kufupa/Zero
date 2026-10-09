-- Hand-written, additive. Human-in-the-loop decision ledger (flag HITL_LEDGER=on).
-- Mirrors apps/server-pilot/src/db/schema/hitl.ts; keep names, types and CHECK lists in sync.
CREATE TABLE IF NOT EXISTS "ai_agent_run" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trace_id" text NOT NULL,
  "span_id" text NOT NULL,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE cascade,
  "thread_id" text NOT NULL REFERENCES "mail_thread"("id") ON DELETE cascade,
  "message_id" text NOT NULL REFERENCES "message"("id") ON DELETE cascade,
  "episode_id" uuid,
  "user_id" text REFERENCES "user"("id") ON DELETE set null,
  "cached_from_run_id" uuid REFERENCES "ai_agent_run"("id") ON DELETE set null,
  "trigger" text NOT NULL,
  "cache_status" text NOT NULL,
  "agent" text DEFAULT 'luna' NOT NULL,
  "provider" text,
  "model_id" text,
  "model_route" text,
  "prompt_version" text NOT NULL,
  "schema_version" text DEFAULT 'agent-run/1' NOT NULL,
  "field_vocab_version" text DEFAULT 'hitl-fields/1' NOT NULL,
  "release_id" text,
  "input_hash" text NOT NULL,
  "input_key" text NOT NULL,
  "treat_as" text,
  "staff_note_present" boolean DEFAULT false NOT NULL,
  "source" text NOT NULL,
  "fallback_reason" text,
  "workflow" text,
  "latency_ms" integer,
  "input_tokens" integer,
  "output_tokens" integer,
  "cost_usd" numeric(10, 6),
  "usage_source" text,
  "output" jsonb,
  "suggested_fields" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "retention_expires_at" timestamp NOT NULL,
  CONSTRAINT "ai_agent_run_trigger_check" CHECK ("trigger" IN ('pane', 'warmer', 'backfill')),
  CONSTRAINT "ai_agent_run_cache_status_check" CHECK ("cache_status" IN ('miss', 'hit', 'backfill')),
  CONSTRAINT "ai_agent_run_source_check" CHECK ("source" IN ('luna', 'regex_fallback')),
  CONSTRAINT "ai_agent_run_trace_id_check" CHECK ("trace_id" ~ '^[0-9a-f]{32}$'),
  CONSTRAINT "ai_agent_run_span_id_check" CHECK ("span_id" ~ '^[0-9a-f]{16}$')
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hitl_episode" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE cascade,
  "message_id" text NOT NULL REFERENCES "message"("id") ON DELETE cascade,
  "user_id" text REFERENCES "user"("id") ON DELETE set null,
  "first_run_id" uuid REFERENCES "ai_agent_run"("id") ON DELETE set null,
  "latest_run_id" uuid REFERENCES "ai_agent_run"("id") ON DELETE set null,
  "displayed_fields" jsonb,
  "final_fields" jsonb,
  "final_workflow" text,
  "first_seen_at" timestamp DEFAULT now() NOT NULL,
  "first_tool_at" timestamp,
  "draft_inserted_at" timestamp,
  "sent_message_id" text REFERENCES "message"("id") ON DELETE set null,
  "sent_at" timestamp,
  "booked_confirmation_no" text,
  "outcome" text DEFAULT 'open' NOT NULL,
  "label_strength" text DEFAULT 'none' NOT NULL,
  "metrics" jsonb,
  "scorer_version" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "retention_expires_at" timestamp NOT NULL,
  CONSTRAINT "hitl_episode_outcome_check" CHECK ("outcome" IN ('open', 'quoted', 'drafted', 'sent', 'booked', 'cancelled', 'abandoned', 'failed')),
  CONSTRAINT "hitl_episode_label_strength_check" CHECK ("label_strength" IN ('booked', 'sent', 'tool_input', 'edited', 'none'))
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_agent_run"
    ADD CONSTRAINT "ai_agent_run_episode_id_hitl_episode_id_fk"
    FOREIGN KEY ("episode_id") REFERENCES "hitl_episode"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hitl_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "episode_id" uuid NOT NULL REFERENCES "hitl_episode"("id") ON DELETE cascade,
  "agent_run_id" uuid REFERENCES "ai_agent_run"("id") ON DELETE set null,
  "user_id" text REFERENCES "user"("id") ON DELETE set null,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "field_path" text,
  "before" jsonb,
  "after" jsonb,
  "prior_provenance" text,
  "payload" jsonb,
  "pane_session_id" text,
  "client_seq" integer,
  "selection_epoch" integer,
  "input_revision" integer,
  "client_at" timestamp,
  "received_at" timestamp DEFAULT now() NOT NULL,
  "pane_release" text,
  "schema_version" text DEFAULT 'hitl-event/1' NOT NULL,
  CONSTRAINT "hitl_event_kind_check" CHECK ("kind" IN ('analysis.shown', 'field.edit', 'workflow.override', 'reanalyse.requested', 'review_item.handled', 'review_item.unhandled', 'stay.selected', 'offer.selected', 'fields.snapshot', 'draft.inserted', 'draft.insert_failed', 'pane.left'))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hitl_tool_run" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "episode_id" uuid REFERENCES "hitl_episode"("id") ON DELETE set null,
  "message_id" text REFERENCES "message"("id") ON DELETE set null,
  "user_id" text REFERENCES "user"("id") ON DELETE set null,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE cascade,
  "workflow_run_id" text REFERENCES "ai_workflow_run"("id") ON DELETE set null,
  "kind" text NOT NULL,
  "input" jsonb,
  "input_digest" text,
  "status" text NOT NULL,
  "error_code" text,
  "result" jsonb,
  "confirmation_no" text,
  "hms_run_id" text,
  "started_at" timestamp DEFAULT now() NOT NULL,
  "duration_ms" integer,
  "retention_expires_at" timestamp NOT NULL,
  CONSTRAINT "hitl_tool_run_kind_check" CHECK ("kind" IN ('quote', 'pdf', 'source_pdf', 'excel', 'booking_draft', 'stay_preview', 'stay_commit', 'cancel_preview', 'cancel_commit', 'stay_lookup', 'guest_search', 'party_lookup')),
  CONSTRAINT "hitl_tool_run_status_check" CHECK ("status" IN ('ok', 'refused', 'failed', 'unconfirmed'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_agent_run_message_created_idx" ON "ai_agent_run" ("transport_id", "message_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_agent_run_input_key_idx" ON "ai_agent_run" ("input_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_agent_run_episode_idx" ON "ai_agent_run" ("episode_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_agent_run_prompt_created_idx" ON "ai_agent_run" ("prompt_version", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_agent_run_retention_idx" ON "ai_agent_run" ("retention_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hitl_episode_message_user_uidx" ON "hitl_episode" ("transport_id", "message_id", "user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hitl_episode_retention_idx" ON "hitl_episode" ("retention_expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hitl_event_episode_seq_idx" ON "hitl_event" ("episode_id", "client_seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hitl_event_kind_received_idx" ON "hitl_event" ("kind", "received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hitl_event_field_path_idx" ON "hitl_event" ("field_path") WHERE "field_path" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hitl_tool_run_episode_started_idx" ON "hitl_tool_run" ("episode_id", "started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hitl_tool_run_transport_kind_started_idx" ON "hitl_tool_run" ("transport_id", "kind", "started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hitl_tool_run_workflow_run_idx" ON "hitl_tool_run" ("workflow_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hitl_tool_run_confirmation_idx" ON "hitl_tool_run" ("confirmation_no") WHERE "confirmation_no" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hitl_tool_run_retention_idx" ON "hitl_tool_run" ("retention_expires_at");
