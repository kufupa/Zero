-- One sender-party vote per (property, native stay, role, host).
-- Field corrections, reconcile retries and replays reuse or move this contribution;
-- they never stack extra hits on sender_party_memory for the same stay.
CREATE TABLE IF NOT EXISTS nava_agent.sender_party_stay (
  property_code TEXT NOT NULL,
  native_event_id TEXT NOT NULL,
  party_kind TEXT NOT NULL CHECK (party_kind IN ('agency', 'organization')),
  host TEXT NOT NULL,
  party_name TEXT,
  native_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (property_code, native_event_id, party_kind, host)
);
