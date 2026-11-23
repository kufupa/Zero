CREATE TABLE IF NOT EXISTS nava_agent.party_booking_memory (
  property_code TEXT NOT NULL,
  party_kind TEXT NOT NULL,
  party_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  field_value TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (property_code, party_kind, party_id, field_name, field_value),
  CONSTRAINT party_booking_memory_kind_check CHECK (party_kind IN ('agency', 'organization'))
);
