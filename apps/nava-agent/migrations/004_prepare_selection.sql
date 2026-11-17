ALTER TABLE nava_agent.mail_thread
  ADD COLUMN IF NOT EXISTS selection_key text NOT NULL DEFAULT '';

ALTER TABLE nava_agent.mail_thread
  DROP CONSTRAINT IF EXISTS mail_thread_source_mailbox_id_source_thread_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS mail_thread_source_selection
  ON nava_agent.mail_thread (source, mailbox_id, source_thread_id, selection_key);
