CREATE TABLE outlook_sync_source (
 id text PRIMARY KEY, device_id text NOT NULL REFERENCES outlook_device(device_id), transport_id text NOT NULL REFERENCES mailbox_transport(id), user_id text NOT NULL REFERENCES "user"(id), store_id text NOT NULL, root_entry_id text NOT NULL, session_id text NOT NULL, policy_generation integer NOT NULL,
 timezone text NOT NULL DEFAULT 'Africa/Johannesburg', history_from timestamp, history_to timestamp, capture_started_at timestamp, subscription_started_at timestamp,
 handle_hash text, handle_ciphertext text, authority_expires_at timestamp NOT NULL, activation_key text NOT NULL, activation_ticket_hash text NOT NULL, activation_ticket_ciphertext text NOT NULL, activation_expires_at timestamp NOT NULL, redeemed_at timestamp,
 claim_fence bigint NOT NULL DEFAULT 0, claim_owner text, claim_expires_at timestamp, discovered_through timestamp, committed_through timestamp, discovered_count bigint NOT NULL DEFAULT 0, retained_count bigint NOT NULL DEFAULT 0, committed_count bigint NOT NULL DEFAULT 0, gap_count bigint NOT NULL DEFAULT 0, user_paused boolean NOT NULL DEFAULT false, resource_pause_reason text, status text NOT NULL DEFAULT 'pending', control_key text, control_hash text, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
 CONSTRAINT outlook_sync_source_bounds_ck CHECK (history_from IS NULL OR history_from < history_to)
);
--> statement-breakpoint
CREATE UNIQUE INDEX outlook_sync_source_identity_uq ON outlook_sync_source(device_id, transport_id, store_id, root_entry_id);
CREATE INDEX outlook_sync_source_session_idx ON outlook_sync_source(session_id);
--> statement-breakpoint
CREATE TABLE outlook_sync_scan (
 id text PRIMARY KEY, source_id text NOT NULL REFERENCES outlook_sync_source(id), record_kind text NOT NULL DEFAULT 'scan', parent_id text, record_key text NOT NULL, mode text NOT NULL, from_at timestamp NOT NULL, to_at timestamp NOT NULL, claim_fence bigint NOT NULL, checkpoint jsonb, observation_id text,
 discovered_count bigint NOT NULL DEFAULT 0, committed_count bigint NOT NULL DEFAULT 0, gap_count bigint NOT NULL DEFAULT 0, discovery_complete boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'pending', created_at timestamp NOT NULL DEFAULT now(),
 CONSTRAINT outlook_sync_scan_interval_ck CHECK (from_at <= to_at), CONSTRAINT outlook_sync_scan_kind_ck CHECK (record_kind IN ('scan','partition','page','membership','control'))
);
CREATE UNIQUE INDEX outlook_sync_scan_record_uq ON outlook_sync_scan(source_id, record_key);
CREATE INDEX outlook_sync_scan_parent_idx ON outlook_sync_scan(parent_id);
CREATE INDEX outlook_sync_scan_observation_idx ON outlook_sync_scan(observation_id);
CREATE UNIQUE INDEX outlook_sync_scan_one_active_uq ON outlook_sync_scan(source_id) WHERE record_kind='scan' AND (status='pending' OR status='discovering');
--> statement-breakpoint
CREATE TABLE outlook_sync_observation (
 id text PRIMARY KEY, source_id text NOT NULL REFERENCES outlook_sync_source(id), source_observation_id text NOT NULL, semantic_version integer NOT NULL, evidence jsonb NOT NULL, availability text NOT NULL, direction text NOT NULL, canonical_message_id text, required_artifact_roles jsonb NOT NULL, export_state text NOT NULL DEFAULT 'pending', ingestion_state text NOT NULL DEFAULT 'pending', retry_count integer NOT NULL DEFAULT 0, error_code text, created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX outlook_sync_observation_identity_uq ON outlook_sync_observation(source_id, source_observation_id, semantic_version);
CREATE INDEX outlook_sync_observation_pending_idx ON outlook_sync_observation(ingestion_state);
--> statement-breakpoint
CREATE TABLE outlook_sync_artifact (
 id text PRIMARY KEY, observation_id text NOT NULL REFERENCES outlook_sync_observation(id), role text NOT NULL, version integer NOT NULL, expected_bytes bigint NOT NULL, sha256 text NOT NULL, content_type text NOT NULL, metadata jsonb, upload_session jsonb, staging_key text, sealed_key text, verified_receipt jsonb, accepted_at timestamp, ingestion_state text NOT NULL DEFAULT 'pending', created_at timestamp NOT NULL DEFAULT now(),
 CONSTRAINT outlook_sync_artifact_bytes_ck CHECK (expected_bytes >= 0 AND expected_bytes <= 9007199254740991)
);
CREATE UNIQUE INDEX outlook_sync_artifact_identity_uq ON outlook_sync_artifact(observation_id, role, version);
CREATE UNIQUE INDEX outlook_sync_artifact_sealed_uq ON outlook_sync_artifact(sealed_key);
