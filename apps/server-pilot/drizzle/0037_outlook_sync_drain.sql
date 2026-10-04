ALTER TABLE outlook_sync_observation ADD COLUMN drain_owner text;
--> statement-breakpoint
ALTER TABLE outlook_sync_observation ADD COLUMN drain_fence bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE outlook_sync_observation ADD COLUMN drain_expires_at timestamp;
--> statement-breakpoint
ALTER TABLE outlook_sync_observation ADD COLUMN drain_next_attempt_at timestamp;
--> statement-breakpoint
CREATE INDEX outlook_sync_observation_drain_idx ON outlook_sync_observation (ingestion_state, drain_next_attempt_at, drain_expires_at);
