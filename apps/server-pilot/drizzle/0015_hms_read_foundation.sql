DO $$ BEGIN
  CREATE TYPE "ai_executor_lane" AS ENUM ('default', 'hms');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "ai_workflow_run"
  ADD COLUMN IF NOT EXISTS "executor_lane" "ai_executor_lane" NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS "claim_token" text,
  ADD COLUMN IF NOT EXISTS "heartbeat_at" timestamp,
  ADD COLUMN IF NOT EXISTS "deadline_at" timestamp,
  ADD COLUMN IF NOT EXISTS "failure_class" text;

CREATE INDEX IF NOT EXISTS "ai_workflow_run_lane_claim_idx"
  ON "ai_workflow_run" ("executor_lane", "state", "next_run_at", "created_at");

ALTER TABLE "ai_draft_generation"
  ADD COLUMN IF NOT EXISTS "outcome" text,
  ADD COLUMN IF NOT EXISTS "thread_state_version" text,
  ADD COLUMN IF NOT EXISTS "evidence" jsonb NOT NULL DEFAULT '[]'::jsonb;
