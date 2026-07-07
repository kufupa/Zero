DO $$ BEGIN
  CREATE TYPE "ai_workflow_run_kind" AS ENUM ('inbound_triage', 'candidate_draft', 'feedback_extraction');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "ai_workflow_run_state" AS ENUM (
    'queued',
    'claimed',
    'running',
    'succeeded',
    'retry_wait',
    'dead_letter',
    'superseded'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "ai_workflow_run" (
  "id" text PRIMARY KEY NOT NULL,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE cascade,
  "thread_id" text NOT NULL REFERENCES "mail_thread"("id") ON DELETE cascade,
  "trigger_message_id" text NOT NULL REFERENCES "message"("id") ON DELETE cascade,
  "run_kind" "ai_workflow_run_kind" NOT NULL,
  "idempotency_key" text NOT NULL,
  "model_id" text NOT NULL,
  "prompt_version" text NOT NULL,
  "prompt_hash" text,
  "state" "ai_workflow_run_state" DEFAULT 'queued' NOT NULL,
  "claim_owner" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_run_at" timestamp,
  "mastra_trace_id" text,
  "mastra_scorer_id" text,
  "generation_id" text REFERENCES "ai_draft_generation"("id") ON DELETE set null,
  "metrics" jsonb,
  "last_error" text,
  "claimed_at" timestamp,
  "started_at" timestamp,
  "finished_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "ai_workflow_run_idempotency_uidx"
  ON "ai_workflow_run" ("idempotency_key");

CREATE INDEX IF NOT EXISTS "ai_workflow_run_claim_idx"
  ON "ai_workflow_run" ("state", "next_run_at", "created_at");

CREATE INDEX IF NOT EXISTS "ai_workflow_run_transport_idx"
  ON "ai_workflow_run" ("transport_id", "state", "created_at");

CREATE INDEX IF NOT EXISTS "ai_workflow_run_thread_idx"
  ON "ai_workflow_run" ("thread_id", "run_kind");

CREATE INDEX IF NOT EXISTS "ai_workflow_run_trigger_message_idx"
  ON "ai_workflow_run" ("trigger_message_id");
