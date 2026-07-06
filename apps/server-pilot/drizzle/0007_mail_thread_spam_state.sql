ALTER TABLE "mail_thread"
  ADD COLUMN IF NOT EXISTS "spam_at" timestamp;

UPDATE "mail_thread" AS thread
SET "spam_at" = COALESCE(thread."spam_at", thread."updated_at")
WHERE EXISTS (
  SELECT 1
  FROM "mail_label" AS label
  WHERE label."transport_id" = thread."transport_id"
    AND label."name" = 'SPAM'
    AND thread."label_ids" ? label."id"
);

CREATE INDEX IF NOT EXISTS "mail_thread_transport_spam_idx"
  ON "mail_thread" ("transport_id", "spam_at");
