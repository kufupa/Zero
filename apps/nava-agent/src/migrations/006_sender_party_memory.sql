CREATE TABLE IF NOT EXISTS nava_agent.sender_party_memory (
  property_code text NOT NULL,
  host text NOT NULL,
  party_kind text NOT NULL CHECK (party_kind IN ('agency', 'organization')),
  party_name text NOT NULL,
  native_id text,
  hits integer NOT NULL DEFAULT 1,
  direct_misses integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_code, host, party_kind, party_name)
);
