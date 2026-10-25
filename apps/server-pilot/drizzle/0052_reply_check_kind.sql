-- U11b: reply re-check job kind. Outcome lives on the work-item row / work_event, not a new table.
ALTER TYPE "ai_workflow_run_kind" ADD VALUE IF NOT EXISTS 'reply_check';
