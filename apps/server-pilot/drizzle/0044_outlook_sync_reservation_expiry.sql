ALTER TABLE outlook_sync_artifact ADD COLUMN reservation_expires_at timestamp NOT NULL DEFAULT (now()+interval '7 days');
UPDATE outlook_sync_artifact SET reservation_expires_at=created_at+interval '7 days';
CREATE INDEX outlook_sync_artifact_reservation_idx ON outlook_sync_artifact(reservation_expires_at) WHERE quota_reserved=true AND accepted_at IS NULL;
