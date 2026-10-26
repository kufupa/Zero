-- Hand-written, additive. Nava pane work items: mail extraction, work items, the append-only work_event log,
-- saved custom rates, and the ai_workflow_run columns and run kinds that queue work against them.
-- Mirrors apps/server-pilot/src/db/schema/work.ts and the ai_workflow_run additions in src/db/schema/mail.ts;
-- keep names, types and CHECK lists in sync.
-- Deleting mail never touches work_event: work_item's thread, message and extraction links are SET NULL,
-- so the item and its events outlive the mail. work_event.type has no CHECK (app code validates it), so new
-- event types need no migration. One approval.consumed per (work item, payload hash) is a unique index.
-- ponytail: the append-only trigger covers UPDATE and DELETE only. TRUNCATE stays allowed because
-- deploy/pilot-db-wipe.sh and the test helpers truncate with CASCADE.
ALTER TYPE "ai_workflow_run_kind" ADD VALUE IF NOT EXISTS 'inbound_extraction';--> statement-breakpoint
ALTER TYPE "ai_workflow_run_kind" ADD VALUE IF NOT EXISTS 'quote_followup';--> statement-breakpoint
ALTER TYPE "ai_workflow_run_kind" ADD VALUE IF NOT EXISTS 'hms_write';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_extraction" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "message_id" text NOT NULL REFERENCES "message"("id") ON DELETE cascade,
  "extractor_version" text NOT NULL,
  "status" text NOT NULL,
  "kind" text,
  "language" text,
  "payload" jsonb,
  "translation" jsonb,
  "attachments" jsonb,
  "usage" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "mail_extraction_status_check" CHECK ("status" IN ('succeeded', 'failed')),
  CONSTRAINT "mail_extraction_kind_check" CHECK ("kind" IN ('quote', 'booking', 'amendment', 'cancellation', 'voucher_pop', 'spam', 'other'))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "work_item" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE cascade,
  "thread_id" text REFERENCES "mail_thread"("id") ON DELETE set null,
  "source_message_id" text REFERENCES "message"("id") ON DELETE set null,
  "kind" text NOT NULL,
  "extraction_id" uuid REFERENCES "mail_extraction"("id") ON DELETE set null,
  "status" text DEFAULT 'needs_you' NOT NULL,
  "state" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "quote_file_keys" jsonb,
  "sent_message_id" text REFERENCES "message"("id") ON DELETE set null,
  "sent_at" timestamp,
  "follow_up_due_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "revision_head" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "work_item_kind_check" CHECK ("kind" IN ('quote', 'booking', 'amendment', 'cancellation', 'voucher_pop', 'spam', 'other')),
  CONSTRAINT "work_item_status_check" CHECK ("status" IN ('needs_you', 'review', 'done', 'dismissed'))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "work_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "work_item_id" uuid NOT NULL REFERENCES "work_item"("id") ON DELETE restrict,
  "at" timestamp DEFAULT now() NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_user_id" text,
  "type" text NOT NULL,
  "field_path" text,
  "ai_value" jsonb,
  "value" jsonb,
  "ai_source" text,
  "ms_since_open" integer,
  "payload_hash" text,
  "expires_at" timestamp,
  "evidence" jsonb,
  CONSTRAINT "work_event_actor_kind_check" CHECK ("actor_kind" IN ('user', 'ai', 'system')),
  CONSTRAINT "work_event_approval_hash_check" CHECK ("type" NOT IN ('approval.granted', 'approval.consumed') OR "payload_hash" IS NOT NULL)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "custom_rate" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "amount_minor" integer NOT NULL,
  "currency" text NOT NULL,
  "board" text,
  "room_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "valid_from" timestamp,
  "valid_to" timestamp,
  "note" text,
  "created_by" text REFERENCES "user"("id") ON DELETE set null,
  "archived_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "custom_rate_amount_check" CHECK ("amount_minor" >= 0)
);--> statement-breakpoint
ALTER TABLE "ai_workflow_run"
  ADD COLUMN IF NOT EXISTS "work_item_id" uuid,
  ADD COLUMN IF NOT EXISTS "priority" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_workflow_run"
    ADD CONSTRAINT "ai_workflow_run_work_item_id_work_item_id_fk"
    FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_extraction_message_version_uidx" ON "mail_extraction" ("message_id", "extractor_version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_item_thread_kind_source_uidx" ON "work_item" ("thread_id", "kind", "source_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_item_transport_status_updated_idx" ON "work_item" ("transport_id", "status", "updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_event_work_item_at_idx" ON "work_event" ("work_item_id", "at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_event_approval_consumed_uidx" ON "work_event" ("work_item_id", "payload_hash") WHERE "type" = 'approval.consumed';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_workflow_run_work_item_created_idx" ON "ai_workflow_run" ("work_item_id", "created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "custom_rate_transport_name_active_uidx" ON "custom_rate" ("transport_id", "name") WHERE "archived_at" IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "work_event_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'work events are append-only';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "work_event_append_only_trigger" ON "work_event";--> statement-breakpoint
CREATE TRIGGER "work_event_append_only_trigger"
  BEFORE UPDATE OR DELETE ON "work_event"
  FOR EACH ROW EXECUTE FUNCTION "work_event_append_only"();
