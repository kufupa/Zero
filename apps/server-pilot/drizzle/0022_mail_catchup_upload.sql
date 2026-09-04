DO $$ BEGIN
  CREATE TYPE "mail_catchup_upload_status" AS ENUM (
    'pending',
    'stored',
    'aborted'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "mail_catchup_upload" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "original_filename" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "s3_key" text NOT NULL,
  "s3_upload_id" text,
  "status" "mail_catchup_upload_status" NOT NULL DEFAULT 'pending',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "completed_at" timestamp,
  CONSTRAINT "mail_catchup_upload_s3_key_unique" UNIQUE("s3_key")
);

CREATE INDEX IF NOT EXISTS "mail_catchup_upload_user_created_idx"
  ON "mail_catchup_upload" ("user_id", "created_at");
