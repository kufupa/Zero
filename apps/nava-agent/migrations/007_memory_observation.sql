-- Append-only memory observations from independently verified native readback.
-- Legacy party_booking_memory / sender_party_memory stay for rollback; new learning keys here.
CREATE TABLE IF NOT EXISTS nava_agent.memory_observation (
  id TEXT PRIMARY KEY,
  property_code TEXT NOT NULL,
  native_event_id TEXT NOT NULL,
  party_kind TEXT NOT NULL CHECK (party_kind IN ('agency', 'organization')),
  party_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  field_value TEXT NOT NULL,
  evidence_ref TEXT,
  available_at TIMESTAMPTZ,
  origin TEXT NOT NULL CHECK (origin IN ('native_readback', 'staff_correction')),
  coverage TEXT NOT NULL CHECK (coverage IN ('complete', 'partial', 'unobserved')),
  version INT NOT NULL DEFAULT 1,
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_code, native_event_id, party_kind, field_name, version)
);

CREATE INDEX IF NOT EXISTS memory_observation_active_idx
  ON nava_agent.memory_observation (property_code, party_kind, party_id, field_name)
  WHERE superseded_at IS NULL AND coverage = 'complete';
