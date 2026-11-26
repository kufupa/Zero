CREATE SCHEMA IF NOT EXISTS thanksgiving;

CREATE TABLE IF NOT EXISTS thanksgiving.pipeline_run (
  run_id text PRIMARY KEY,
  stage text NOT NULL,
  git_sha text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL,
  params_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS thanksgiving.message (
  message_id text PRIMARY KEY,
  thread_id text NOT NULL,
  transport_id text,
  direction text,
  sent_at timestamp,
  received_at timestamp,
  created_at timestamp,
  sender_domain text,
  regime text NOT NULL,
  raw_mime_missing boolean NOT NULL,
  message_id_header text,
  body_sha256 text,
  attachment_count integer NOT NULL DEFAULT 0,
  is_cut boolean NOT NULL DEFAULT false,
  cut_reason text,
  cut_updated_at timestamptz,
  registered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS thanksgiving_message_thread_idx
  ON thanksgiving.message (thread_id);
CREATE INDEX IF NOT EXISTS thanksgiving_message_regime_direction_cut_idx
  ON thanksgiving.message (regime, direction, is_cut);
CREATE INDEX IF NOT EXISTS thanksgiving_message_sender_domain_idx
  ON thanksgiving.message (sender_domain);
CREATE INDEX IF NOT EXISTS thanksgiving_message_duplicate_idx
  ON thanksgiving.message (message_id_header, body_sha256);

CREATE TABLE IF NOT EXISTS thanksgiving.attachment (
  attachment_id text PRIMARY KEY,
  message_id text NOT NULL,
  filename text,
  mime_type text,
  size_bytes bigint,
  sha256 text,
  s3_key text,
  content_id text,
  is_inline boolean,
  attachment_created_at timestamp,
  is_cut boolean NOT NULL DEFAULT false,
  cut_reason text,
  cut_updated_at timestamptz,
  registered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE thanksgiving.attachment ADD COLUMN IF NOT EXISTS s3_key text;

CREATE INDEX IF NOT EXISTS thanksgiving_attachment_message_idx
  ON thanksgiving.attachment (message_id);
CREATE INDEX IF NOT EXISTS thanksgiving_attachment_sha256_idx
  ON thanksgiving.attachment (sha256);
CREATE INDEX IF NOT EXISTS thanksgiving_attachment_filename_idx
  ON thanksgiving.attachment (filename);

CREATE TABLE IF NOT EXISTS thanksgiving.domain_rule (
  domain text NOT NULL,
  rule_type text NOT NULL,
  source text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (domain, rule_type)
);

CREATE TABLE IF NOT EXISTS thanksgiving.confirmation_key (
  message_id text NOT NULL,
  thread_id text NOT NULL,
  confirmation_key text NOT NULL,
  source text NOT NULL,
  confidence numeric(4,3) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  run_id text NOT NULL,
  extracted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, confirmation_key, source)
);

CREATE INDEX IF NOT EXISTS thanksgiving_confirmation_key_key_idx
  ON thanksgiving.confirmation_key (confirmation_key) WHERE is_active;
CREATE INDEX IF NOT EXISTS thanksgiving_confirmation_key_thread_idx
  ON thanksgiving.confirmation_key (thread_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS thanksgiving.hms_reservation (
  property_code text NOT NULL,
  confirmation_key text NOT NULL,
  status text,
  created_at timestamptz,
  created_by text,
  updated_at timestamptz,
  source_of_business text,
  arrival_date date,
  departure_date date,
  guest_name text,
  company text,
  travel_agency_1 text,
  evidence_kind text,
  capture_completeness text,
  observed_at timestamptz,
  observation_id text,
  stable_payload_sha256 text,
  is_active boolean NOT NULL DEFAULT true,
  run_id text,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_code, confirmation_key)
);

CREATE INDEX IF NOT EXISTS thanksgiving_hms_reservation_key_idx
  ON thanksgiving.hms_reservation (confirmation_key) WHERE is_active;
CREATE INDEX IF NOT EXISTS thanksgiving_hms_reservation_email_created_idx
  ON thanksgiving.hms_reservation (source_of_business, created_at) WHERE is_active;

CREATE TABLE IF NOT EXISTS thanksgiving.thread_hms_match (
  thread_id text NOT NULL,
  confirmation_key text NOT NULL,
  property_code text NOT NULL,
  best_source text,
  best_confidence numeric(4,3),
  key_message_count integer NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  run_id text NOT NULL,
  matched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, confirmation_key, property_code)
);

CREATE INDEX IF NOT EXISTS thanksgiving_thread_hms_match_thread_idx
  ON thanksgiving.thread_hms_match (thread_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS thanksgiving_thread_hms_match_key_idx
  ON thanksgiving.thread_hms_match (confirmation_key) WHERE is_active;

CREATE TABLE IF NOT EXISTS thanksgiving.metric_snapshot (
  run_id text NOT NULL,
  metric_name text NOT NULL,
  numerator bigint,
  denominator bigint,
  rate numeric,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, metric_name)
);

CREATE TABLE IF NOT EXISTS thanksgiving.miss_sample (
  run_id text NOT NULL,
  direction text NOT NULL,
  ordinal integer NOT NULL,
  entity_id text NOT NULL,
  confirmation_key text,
  reason text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, direction, ordinal)
);
