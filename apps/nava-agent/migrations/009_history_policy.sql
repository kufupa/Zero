CREATE TABLE IF NOT EXISTS nava_agent.history_policy (
  property_code text PRIMARY KEY,
  snapshot_sha256 text NOT NULL,
  entries jsonb NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now()
);
