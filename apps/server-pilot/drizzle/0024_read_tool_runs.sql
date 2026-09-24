-- U8: typed, model-independent HMS read receipts share the existing run ledger.
-- Additive only; existing runs retain their required modelId column and read
-- runs use the explicit not_applicable sentinel.
ALTER TYPE "ai_workflow_run_kind" ADD VALUE IF NOT EXISTS 'read_tool';

ALTER TABLE "ai_workflow_run"
  ADD COLUMN IF NOT EXISTS "read_request" jsonb,
  ADD COLUMN IF NOT EXISTS "read_result_ref" text;

CREATE UNIQUE INDEX IF NOT EXISTS "ai_workflow_run_read_result_ref_uidx"
  ON "ai_workflow_run" ("read_result_ref")
  WHERE "read_result_ref" IS NOT NULL;

ALTER TABLE "ai_workflow_run"
  ADD CONSTRAINT "ai_workflow_run_read_tool_model_check"
  CHECK ("run_kind"::text <> 'read_tool' OR "model_id" = 'not_applicable');
