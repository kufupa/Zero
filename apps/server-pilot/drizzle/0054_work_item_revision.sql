-- Per-work-item pane revision cursor. Existing DBs that already ran 0047 get the
-- columns here; fresh DBs also create them in 0047. work_event stays append-only.
ALTER TABLE "work_item" ADD COLUMN IF NOT EXISTS "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "work_item" ADD COLUMN IF NOT EXISTS "revision_head" integer DEFAULT 0 NOT NULL;
