-- U13: private future-shadow prediction seals and append-only assessment revisions.
-- Bodies never enter the generic AI run metrics or visible draft tables.
ALTER TYPE "ai_workflow_run_kind"
  ADD VALUE IF NOT EXISTS 'shadow_prediction';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_shadow_prediction" (
  "id" text PRIMARY KEY NOT NULL,
  "prediction_key" text NOT NULL,
  "evaluation_mode" text NOT NULL,
  "evaluation_version" text NOT NULL,
  "admission_status" text NOT NULL,
  "prediction_status" text NOT NULL,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE CASCADE,
  "thread_id" text NOT NULL REFERENCES "mail_thread"("id") ON DELETE CASCADE,
  "trigger_message_id" text REFERENCES "message"("id") ON DELETE SET NULL,
  "as_of_at" timestamp NOT NULL,
  "sealed_at" timestamp NOT NULL,
  "observation_ends_at" timestamp NOT NULL,
  "source_vintage" text NOT NULL,
  "input_digest" text NOT NULL,
  "message_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "attachment_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "excluded_future_message_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "model_id" text,
  "prompt_version" text NOT NULL,
  "route" jsonb,
  "model_usage" jsonb,
  "prediction" jsonb,
  "unavailable_reason" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "ai_shadow_prediction_evaluation_mode_check"
    CHECK ("evaluation_mode" IN ('current_state', 'historical_replay', 'future_shadow')),
  CONSTRAINT "ai_shadow_prediction_admission_status_check"
    CHECK ("admission_status" IN ('eligible', 'admitted', 'skipped', 'denied')),
  CONSTRAINT "ai_shadow_prediction_status_check"
    CHECK ("prediction_status" IN ('sealed', 'unavailable', 'failed', 'pending')),
  CONSTRAINT "ai_shadow_prediction_route_object_check"
    CHECK ("route" IS NULL OR jsonb_typeof("route") = 'object'),
  CONSTRAINT "ai_shadow_prediction_usage_object_check"
    CHECK ("model_usage" IS NULL OR jsonb_typeof("model_usage") = 'object'),
  CONSTRAINT "ai_shadow_prediction_body_object_check"
    CHECK ("prediction" IS NULL OR jsonb_typeof("prediction") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_shadow_prediction_key_uidx"
  ON "ai_shadow_prediction" ("prediction_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_shadow_prediction_scope_idx"
  ON "ai_shadow_prediction" ("transport_id", "thread_id", "as_of_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_shadow_prediction_observation_idx"
  ON "ai_shadow_prediction" ("transport_id", "observation_ends_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_shadow_prediction_status_idx"
  ON "ai_shadow_prediction" ("prediction_status", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_shadow_assessment" (
  "id" text PRIMARY KEY NOT NULL,
  "prediction_id" text NOT NULL REFERENCES "ai_shadow_prediction"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL,
  "revision_key" text NOT NULL,
  "evaluation_mode" text NOT NULL,
  "status" text NOT NULL,
  "reference_message_id" text REFERENCES "message"("id") ON DELETE SET NULL,
  "link_strength" text NOT NULL,
  "reason" text NOT NULL,
  "label_provenance" jsonb,
  "verdict" text,
  "assessment" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "ai_shadow_assessment_evaluation_mode_check"
    CHECK ("evaluation_mode" IN ('current_state', 'historical_replay', 'future_shadow')),
  CONSTRAINT "ai_shadow_assessment_status_check"
    CHECK ("status" IN ('pending', 'matched', 'late', 'ambiguous', 'unmatched', 'unobserved', 'unknown_coverage', 'changed_state', 'unscorable')),
  CONSTRAINT "ai_shadow_assessment_link_strength_check"
    CHECK ("link_strength" IN ('header', 'thread', 'ambiguous', 'unknown')),
  CONSTRAINT "ai_shadow_assessment_verdict_check"
    CHECK ("verdict" IS NULL OR "verdict" IN ('correct', 'partial', 'incorrect')),
  CONSTRAINT "ai_shadow_assessment_payload_object_check"
    CHECK (jsonb_typeof("assessment") = 'object'),
  CONSTRAINT "ai_shadow_assessment_label_object_check"
    CHECK ("label_provenance" IS NULL OR jsonb_typeof("label_provenance") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_shadow_assessment_revision_key_uidx"
  ON "ai_shadow_assessment" ("revision_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_shadow_assessment_prediction_revision_uidx"
  ON "ai_shadow_assessment" ("prediction_id", "revision");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_shadow_assessment_prediction_idx"
  ON "ai_shadow_assessment" ("prediction_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_shadow_assessment_reference_idx"
  ON "ai_shadow_assessment" ("reference_message_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "ai_shadow_prediction_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ai shadow predictions are immutable';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ai_shadow_prediction_immutable_trigger" ON "ai_shadow_prediction";
--> statement-breakpoint
CREATE TRIGGER "ai_shadow_prediction_immutable_trigger"
  BEFORE UPDATE ON "ai_shadow_prediction"
  FOR EACH ROW EXECUTE FUNCTION "ai_shadow_prediction_immutable"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "ai_shadow_assessment_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ai shadow assessments are append-only';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ai_shadow_assessment_append_only_trigger" ON "ai_shadow_assessment";
--> statement-breakpoint
CREATE TRIGGER "ai_shadow_assessment_append_only_trigger"
  BEFORE UPDATE ON "ai_shadow_assessment"
  FOR EACH ROW EXECUTE FUNCTION "ai_shadow_assessment_append_only"();
