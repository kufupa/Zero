ALTER TABLE nava_agent.agent_event
  ALTER COLUMN session_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS thread_id text REFERENCES nava_agent.mail_thread(id);

DO $$
BEGIN
  ALTER TABLE nava_agent.agent_event ADD CONSTRAINT agent_event_scope
    CHECK (
      (kind = 'mail_skipped' AND session_id IS NULL AND thread_id IS NOT NULL)
      OR (kind <> 'mail_skipped' AND session_id IS NOT NULL AND thread_id IS NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS agent_event_import_key ON nava_agent.agent_event ((payload->>'key_hash'))
  WHERE kind IN ('import', 'mail_skipped');
