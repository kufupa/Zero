CREATE TABLE "outlook_navigation_history" (
  "device_id" text NOT NULL REFERENCES "outlook_device"("device_id") ON DELETE CASCADE,
  "challenge_hash" text NOT NULL,
  "registered_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY("device_id", "challenge_hash")
);
-- Existing installations can have an active challenge from the prior version.
-- Preserve its used marker so a signed A→B→A request cannot revive it.
INSERT INTO "outlook_navigation_history" ("device_id", "challenge_hash", "registered_at")
SELECT "device_id", "challenge_hash", "created_at" FROM "outlook_navigation"
ON CONFLICT ("device_id", "challenge_hash") DO NOTHING;
INSERT INTO "outlook_navigation_history" ("device_id", "challenge_hash", "registered_at")
SELECT "device_id", "challenge_hash", MIN("expires_at" - interval '1 minute')
FROM "outlook_bridge_ticket" GROUP BY "device_id", "challenge_hash"
ON CONFLICT ("device_id", "challenge_hash") DO NOTHING;
