ALTER TABLE outlook_sync_source ADD COLUMN history_summary jsonb NOT NULL DEFAULT '{"discoveryComplete":false,"discovered":0,"retained":0,"committed":0,"gaps":0}'::jsonb;
ALTER TABLE outlook_sync_source ADD COLUMN live_summary jsonb NOT NULL DEFAULT '{"discovered":0,"retained":0,"committed":0,"gaps":0}'::jsonb;
