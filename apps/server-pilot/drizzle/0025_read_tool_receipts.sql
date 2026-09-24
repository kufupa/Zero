-- U8: persist the validated typed read body beside its existing opaque ref.
-- Additive only; the run ledger remains the only job/receipt store.
ALTER TABLE "ai_workflow_run"
  ADD COLUMN IF NOT EXISTS "read_result" jsonb,
  ADD COLUMN IF NOT EXISTS "read_result_expires_at" timestamp;

ALTER TABLE "ai_workflow_run"
  ADD CONSTRAINT "ai_workflow_run_read_tool_receipt_shape_check"
  CHECK (
    "run_kind"::text <> 'read_tool'
    OR "read_result" IS NULL
    OR jsonb_typeof("read_result") = 'object'
  );
