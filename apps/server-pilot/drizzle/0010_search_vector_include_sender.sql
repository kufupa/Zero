-- Re-backfill search_vector with latest inbound from_address (0009 used subject+snippet only).
UPDATE "mail_thread" AS mt
SET "search_vector" = to_tsvector(
  'simple',
  coalesce(mt."subject", '') || ' ' || coalesce(mt."snippet", '') || ' ' || coalesce((
    SELECT m."from_address"
    FROM "message" AS m
    WHERE m."thread_id" = mt."id"
      AND m."direction" = 'inbound'
    ORDER BY m."received_at" DESC NULLS LAST
    LIMIT 1
  ), '')
);
