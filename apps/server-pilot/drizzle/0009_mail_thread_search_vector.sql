ALTER TABLE "mail_thread"
  ADD COLUMN IF NOT EXISTS "search_vector" tsvector;

UPDATE "mail_thread"
SET "search_vector" = to_tsvector('simple', coalesce("subject", '') || ' ' || coalesce("snippet", ''))
WHERE "search_vector" IS NULL;

CREATE INDEX IF NOT EXISTS "mail_thread_search_vector_idx"
  ON "mail_thread" USING gin ("search_vector");
