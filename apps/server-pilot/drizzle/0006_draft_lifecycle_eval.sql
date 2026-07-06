DO $$ BEGIN
  CREATE TYPE "mail_draft_status" AS ENUM ('active', 'candidate', 'discarded', 'sent');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "mail_draft_origin" AS ENUM ('manual', 'ai');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "mail_draft_revision_kind" AS ENUM ('created', 'ai_generated', 'promoted', 'edited', 'sent');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "ai_draft_generation" (
  "id" text PRIMARY KEY NOT NULL,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE cascade,
  "thread_id" text NOT NULL REFERENCES "mail_thread"("id") ON DELETE cascade,
  "requested_by_user_id" text NOT NULL,
  "context_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "model" text NOT NULL,
  "prompt_version" text NOT NULL,
  "prompt_hash" text,
  "status" text DEFAULT 'succeeded' NOT NULL,
  "error_message" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "mail_draft"
  ADD COLUMN IF NOT EXISTS "status" "mail_draft_status" DEFAULT 'active' NOT NULL,
  ADD COLUMN IF NOT EXISTS "origin" "mail_draft_origin" DEFAULT 'manual' NOT NULL,
  ADD COLUMN IF NOT EXISTS "reply_to_message_id" text,
  ADD COLUMN IF NOT EXISTS "generation_id" text;

UPDATE "mail_draft" SET "status" = 'sent' WHERE "is_sent" = true;

WITH ranked_active_drafts AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "transport_id", "thread_id"
      ORDER BY "updated_at" DESC NULLS LAST, "id" DESC
    ) AS rn
  FROM "mail_draft"
  WHERE "is_sent" = false
    AND "status" = 'active'
    AND "thread_id" IS NOT NULL
)
UPDATE "mail_draft"
SET "status" = 'discarded', "updated_at" = now()
FROM ranked_active_drafts
WHERE "mail_draft"."id" = ranked_active_drafts."id"
  AND ranked_active_drafts.rn > 1;

DO $$ BEGIN
  ALTER TABLE "mail_draft"
    ADD CONSTRAINT "mail_draft_reply_to_message_id_message_id_fk"
    FOREIGN KEY ("reply_to_message_id") REFERENCES "message"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "mail_draft"
    ADD CONSTRAINT "mail_draft_generation_id_ai_draft_generation_id_fk"
    FOREIGN KEY ("generation_id") REFERENCES "ai_draft_generation"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "mail_draft"
    ADD CONSTRAINT "mail_draft_sent_message_id_message_id_fk"
    FOREIGN KEY ("sent_message_id") REFERENCES "message"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "mail_draft_revision" (
  "id" text PRIMARY KEY NOT NULL,
  "draft_id" text NOT NULL REFERENCES "mail_draft"("id") ON DELETE cascade,
  "generation_id" text REFERENCES "ai_draft_generation"("id") ON DELETE set null,
  "sent_message_id" text REFERENCES "message"("id") ON DELETE set null,
  "actor_user_id" text,
  "kind" "mail_draft_revision_kind" NOT NULL,
  "to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "cc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "bcc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "subject" text,
  "text_body" text,
  "html_body" text,
  "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "ai_draft_generation_thread_idx"
  ON "ai_draft_generation" ("transport_id", "thread_id", "created_at");
CREATE INDEX IF NOT EXISTS "mail_draft_thread_status_idx"
  ON "mail_draft" ("transport_id", "thread_id", "status", "updated_at");
CREATE INDEX IF NOT EXISTS "mail_draft_reply_to_message_idx"
  ON "mail_draft" ("reply_to_message_id");
CREATE INDEX IF NOT EXISTS "mail_draft_generation_idx"
  ON "mail_draft" ("generation_id");
CREATE UNIQUE INDEX IF NOT EXISTS "mail_draft_one_active_thread_uidx"
  ON "mail_draft" ("transport_id", "thread_id")
  WHERE "status" = 'active' AND "thread_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "mail_draft_revision_draft_idx"
  ON "mail_draft_revision" ("draft_id", "created_at");
CREATE INDEX IF NOT EXISTS "mail_draft_revision_generation_idx"
  ON "mail_draft_revision" ("generation_id");
CREATE INDEX IF NOT EXISTS "mail_draft_revision_sent_message_idx"
  ON "mail_draft_revision" ("sent_message_id");
