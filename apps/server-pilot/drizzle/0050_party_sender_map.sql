-- Hand-written, additive. Learned sender-host → company/agency. PII stays in the DB.
-- Mirrors partySenderMap in apps/server-pilot/src/db/schema/party-sender-map.ts.
CREATE TABLE IF NOT EXISTS "party_sender_map" (
  "host" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "support" integer NOT NULL,
  CONSTRAINT "party_sender_map_kind_check" CHECK ("kind" IN ('company', 'agency')),
  CONSTRAINT "party_sender_map_support_check" CHECK ("support" >= 1)
);
