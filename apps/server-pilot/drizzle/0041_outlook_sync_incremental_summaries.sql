ALTER TABLE outlook_sync_observation ADD COLUMN summary_cache jsonb;
ALTER TABLE outlook_sync_observation ADD COLUMN summary_dirty boolean NOT NULL DEFAULT true;
CREATE INDEX outlook_sync_observation_dirty_idx ON outlook_sync_observation(source_id) WHERE summary_dirty=true;
--> statement-breakpoint
-- Existing cached counts already include these observations. Seed their delta baseline once.
UPDATE outlook_sync_observation o SET summary_cache=jsonb_build_object(
 'history', EXISTS(SELECT 1 FROM outlook_sync_scan m JOIN outlook_sync_scan sc ON sc.id=m.parent_id WHERE m.observation_id=o.id AND m.record_kind='membership' AND sc.mode='history'),
 'retained',o.export_state='retained','committed',o.ingestion_state='committed',
 'gap',o.availability<>'available' OR o.ingestion_state='attention'), summary_dirty=false;
UPDATE outlook_sync_scan m SET checkpoint=jsonb_build_object('committed',o.ingestion_state='committed' AND o.export_state='retained' AND o.availability='available','gap',o.availability<>'available' OR o.ingestion_state='attention') FROM outlook_sync_observation o WHERE m.record_kind='membership' AND m.observation_id=o.id;
