-- U13 first repair: bounded admission provenance, observed/retention clocks.
-- This migration is additive; migration 0026 and all earlier history remain
-- untouched. Admission rows contain no prediction bodies or model output.
CREATE TABLE IF NOT EXISTS "ai_shadow_admission" (
  "id" text PRIMARY KEY NOT NULL,
  "admission_key" text NOT NULL,
  "evaluation_mode" text NOT NULL,
  "evaluation_version" text NOT NULL,
  "eligible" boolean NOT NULL DEFAULT true,
  "admission_status" text NOT NULL,
  "reason" text NOT NULL,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE CASCADE,
  "thread_id" text NOT NULL REFERENCES "mail_thread"("id") ON DELETE CASCADE,
  "trigger_message_id" text REFERENCES "message"("id") ON DELETE SET NULL,
  "release_id" text NOT NULL,
  "context_digest" text NOT NULL,
  "request_generation" text NOT NULL,
  "cap_bucket_at" timestamp NOT NULL,
  "retention_expires_at" timestamp NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "ai_shadow_admission_evaluation_mode_check"
    CHECK ("evaluation_mode" IN ('current_state', 'historical_replay', 'future_shadow')),
  CONSTRAINT "ai_shadow_admission_status_check"
    CHECK ("admission_status" IN ('admitted', 'skipped', 'denied'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_shadow_admission_key_uidx"
  ON "ai_shadow_admission" ("admission_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_shadow_admission_cap_idx"
  ON "ai_shadow_admission" ("transport_id", "release_id", "cap_bucket_at", "admission_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_shadow_admission_retention_idx"
  ON "ai_shadow_admission" ("retention_expires_at");
--> statement-breakpoint
ALTER TABLE "ai_shadow_prediction"
  ADD COLUMN IF NOT EXISTS "observed_at" timestamp;
--> statement-breakpoint
UPDATE "ai_shadow_prediction"
SET "observed_at" = "created_at"
WHERE "observed_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "ai_shadow_prediction"
  ALTER COLUMN "observed_at" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_shadow_prediction"
  ADD COLUMN IF NOT EXISTS "retention_expires_at" timestamp;
--> statement-breakpoint
UPDATE "ai_shadow_prediction"
SET "retention_expires_at" = "sealed_at" + interval '30 days'
WHERE "retention_expires_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "ai_shadow_prediction"
  ALTER COLUMN "retention_expires_at" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_shadow_prediction_retention_idx"
  ON "ai_shadow_prediction" ("evaluation_mode", "retention_expires_at");
