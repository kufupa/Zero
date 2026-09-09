-- U2: immutable, compact request/response semantic evidence.
-- Additive only. Bodies and mutable folder/read state are intentionally absent.
CREATE TABLE IF NOT EXISTS "mail_baseline_projection" (
  "id" text PRIMARY KEY NOT NULL,
  "generation_key" text NOT NULL,
  "generation_id" text NOT NULL,
  "projection_version" text NOT NULL,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE CASCADE,
  "thread_id" text NOT NULL REFERENCES "mail_thread"("id") ON DELETE CASCADE,
  "source_message_id" text REFERENCES "message"("id") ON DELETE SET NULL,
  "request_id" text NOT NULL,
  "ask_id" text NOT NULL,
  "event_kind" text NOT NULL,
  "direction" text NOT NULL,
  "event_at" timestamp,
  "observed_at" timestamp,
  "source" text NOT NULL,
  "source_basis" text NOT NULL,
  "source_vintage" text NOT NULL,
  "interpretation_version" text NOT NULL,
  "classifier_version" text,
  "reviewer_version" text,
  "observation_cutoff" timestamp NOT NULL,
  "measurement_start_at" timestamp,
  "coverage" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "mail_baseline_projection_generation_key_check" CHECK (length("generation_key") > 0),
  CONSTRAINT "mail_baseline_projection_evidence_object_check" CHECK (jsonb_typeof("evidence") = 'object'),
  CONSTRAINT "mail_baseline_projection_coverage_object_check" CHECK (jsonb_typeof("coverage") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_baseline_projection_generation_uidx"
  ON "mail_baseline_projection" ("generation_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_baseline_projection_scope_idx"
  ON "mail_baseline_projection" ("transport_id", "thread_id", "event_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_baseline_projection_cutoff_idx"
  ON "mail_baseline_projection" ("transport_id", "observation_cutoff", "event_at");
