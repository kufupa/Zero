ALTER TABLE "outbound_send_queue"
  ADD COLUMN IF NOT EXISTS "smtp_attempted_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "smtp_outcome_persisted_at" timestamptz;
--> statement-breakpoint
UPDATE "outbound_send_queue"
SET "smtp_outcome_persisted_at" = COALESCE("smtp_outcome_persisted_at", "updated_at")
WHERE "smtp_payload" ? 'deliveryOutcome';
--> statement-breakpoint
UPDATE "outbound_send_queue" AS q
SET "smtp_outcome_persisted_at" = COALESCE(q."smtp_outcome_persisted_at", q."updated_at")
FROM "message" AS m
WHERE m."id" = q."message_id"
  AND m."transport_id" = q."transport_id"
  AND m."message_id_header" IS NOT NULL
  AND m."message_id_header" <> '';
--> statement-breakpoint
UPDATE "outbound_send_queue"
SET "smtp_attempted_at" = COALESCE("smtp_attempted_at", "updated_at")
WHERE "status" = 'sending'
  AND "smtp_attempted_at" IS NULL;
