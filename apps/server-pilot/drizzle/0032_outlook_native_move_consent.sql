-- A fully verified signed preflight consumes its 60-second browser ticket and
-- returns only native code a separate five-minute, one-use consent challenge.
-- The next fresh ticket must belong to the same live staff/device and exact move.
ALTER TABLE "outlook_bridge_ticket" ADD COLUMN "consent_challenge_hash" text;
ALTER TABLE "outlook_bridge_ticket" ADD COLUMN "consent_scope_hash" text;
ALTER TABLE "outlook_bridge_ticket" ADD COLUMN "consent_expires_at" timestamp;
ALTER TABLE "outlook_bridge_ticket" ADD COLUMN "consent_consumed_at" timestamp;
CREATE UNIQUE INDEX "outlook_bridge_ticket_consent_idx" ON "outlook_bridge_ticket" ("consent_challenge_hash");
CREATE INDEX "outlook_move_receipt_device_budget_idx" ON "outlook_move_receipt" ("device_id", "approved_at");
CREATE INDEX "outlook_navigation_history_registered_idx" ON "outlook_navigation_history" ("registered_at");
CREATE INDEX "outlook_move_receipt_cleanup_idx" ON "outlook_move_receipt" ("approved_at");
