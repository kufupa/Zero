-- Preserve the HMS identity needed to distinguish duplicate company/agency copies.
ALTER TABLE "party_sender_map"
  ADD COLUMN IF NOT EXISTS "native_id" text,
  ADD COLUMN IF NOT EXISTS "iata" text;
