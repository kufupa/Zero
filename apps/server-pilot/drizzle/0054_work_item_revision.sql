-- Per-work-item pane revision cursor. Existing DBs that already ran 0047 get the
-- columns here. work_event stays append-only. revision_seq is monotonic occupancy.
ALTER TABLE "work_item" ADD COLUMN IF NOT EXISTS "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "work_item" ADD COLUMN IF NOT EXISTS "revision_head" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "work_item" ADD COLUMN IF NOT EXISTS "revision_seq" integer DEFAULT 0 NOT NULL;
