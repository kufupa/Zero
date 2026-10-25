-- Learned sender history is per hotel. Existing rows were written only on the
-- Centurion path (isCenturionPartyHistoryTarget); backfill them to HRCEN.
ALTER TABLE "party_sender_map"
  ADD COLUMN IF NOT EXISTS "property_code" text NOT NULL DEFAULT 'HRCEN';

ALTER TABLE "party_sender_map"
  DROP CONSTRAINT IF EXISTS "party_sender_map_pkey";

ALTER TABLE "party_sender_map"
  ADD CONSTRAINT "party_sender_map_pkey" PRIMARY KEY ("property_code", "host");

ALTER TABLE "party_sender_map"
  ALTER COLUMN "property_code" DROP DEFAULT;

ALTER TABLE "party_sender_map"
  DROP CONSTRAINT IF EXISTS "party_sender_map_property_code_check";

ALTER TABLE "party_sender_map"
  ADD CONSTRAINT "party_sender_map_property_code_check" CHECK (btrim("property_code") <> '');
