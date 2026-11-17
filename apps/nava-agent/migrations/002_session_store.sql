ALTER TABLE nava_agent.agent_session
  ADD COLUMN IF NOT EXISTS messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS messages_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pending_tool_use_id text,
  ADD COLUMN IF NOT EXISTS lease_epoch bigint NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS agent_event_message_delivery
  ON nava_agent.agent_event (session_id, (payload->>'delivery_id'))
  WHERE kind = 'runtime_message';
CREATE UNIQUE INDEX IF NOT EXISTS agent_event_tool_outcome
  ON nava_agent.agent_event (session_id, (payload->>'tool_use_id'))
  WHERE kind = 'tool_outcome';

CREATE OR REPLACE FUNCTION nava_agent.enforce_message_append() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.messages IS DISTINCT FROM OLD.messages OR NEW.messages_version IS DISTINCT FROM OLD.messages_version THEN
    IF jsonb_typeof(OLD.messages) <> 'array' OR jsonb_typeof(NEW.messages) <> 'array'
       OR jsonb_array_length(NEW.messages) <> jsonb_array_length(OLD.messages) + 1
       OR (NEW.messages - (jsonb_array_length(NEW.messages) - 1)) IS DISTINCT FROM OLD.messages
       OR NEW.messages_version <> OLD.messages_version + 1 THEN
      RAISE EXCEPTION 'messages must be appended one at a time with a version increment';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS agent_session_message_append ON nava_agent.agent_session;
CREATE TRIGGER agent_session_message_append BEFORE UPDATE ON nava_agent.agent_session
  FOR EACH ROW EXECUTE FUNCTION nava_agent.enforce_message_append();

CREATE OR REPLACE FUNCTION nava_agent.enforce_runtime_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind IN ('runtime_message', 'tool_outcome') THEN
    RAISE EXCEPTION 'runtime messages and tool outcomes are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS agent_event_runtime_immutable ON nava_agent.agent_event;
CREATE TRIGGER agent_event_runtime_immutable BEFORE UPDATE OR DELETE ON nava_agent.agent_event
  FOR EACH ROW EXECUTE FUNCTION nava_agent.enforce_runtime_event_immutable();
