ALTER TABLE outlook_sync_source ADD COLUMN pending_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE outlook_sync_source ADD COLUMN pending_artifact_count integer NOT NULL DEFAULT 0;
ALTER TABLE outlook_sync_source ADD COLUMN pending_byte_limit bigint NOT NULL DEFAULT 1073741824;
ALTER TABLE outlook_sync_artifact ADD COLUMN quota_reserved boolean NOT NULL DEFAULT true;
--> statement-breakpoint
-- One-time baseline only. Requests update source counters under its existing authority lock.
UPDATE outlook_sync_artifact SET quota_reserved=false WHERE accepted_at IS NOT NULL;
UPDATE outlook_sync_source s SET pending_bytes=q.bytes,pending_artifact_count=q.count FROM
 (SELECT o.source_id,sum(a.expected_bytes)::bigint bytes,count(*)::integer count FROM outlook_sync_artifact a JOIN outlook_sync_observation o ON o.id=a.observation_id WHERE a.quota_reserved GROUP BY o.source_id) q WHERE s.id=q.source_id;
ALTER TABLE outlook_sync_source ADD CONSTRAINT outlook_sync_source_quota_ck CHECK(pending_bytes>=0 AND pending_bytes<=9007199254740991 AND pending_artifact_count>=0 AND pending_byte_limit>=1073741824 AND pending_byte_limit<=167772160000);
