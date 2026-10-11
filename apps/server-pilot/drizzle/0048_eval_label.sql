-- Hand-written, additive. v5 flywheel: one eval label per (work item, field), AI value vs human value.
-- Mirrors evalLabel in apps/server-pilot/src/db/schema/work.ts; keep names, types and CHECK lists in sync.
-- Labels are derived data: they go with the work item; the message and source event links are SET NULL.
-- One label per source event (partial unique index), so re-running the export is idempotent.
CREATE TABLE IF NOT EXISTS "eval_label" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "work_item_id" uuid NOT NULL REFERENCES "work_item"("id") ON DELETE cascade,
  "message_id" text REFERENCES "message"("id") ON DELETE set null,
  "field_path" text NOT NULL,
  "ai_value" jsonb,
  "human_value" jsonb,
  "label_kind" text NOT NULL,
  "source_event_id" uuid REFERENCES "work_event"("id") ON DELETE set null,
  "extractor_version" text,
  "model_route" text,
  "split" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "eval_label_kind_check" CHECK ("label_kind" IN ('correction', 'confirmation', 'run_flag', 'note')),
  CONSTRAINT "eval_label_split_check" CHECK ("split" IN ('dev', 'holdout', 'test'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_label_split_field_idx" ON "eval_label" ("split", "field_path");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "eval_label_source_event_uidx" ON "eval_label" ("source_event_id") WHERE "source_event_id" IS NOT NULL;
