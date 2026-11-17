CREATE SCHEMA IF NOT EXISTS nava_agent;
CREATE TABLE IF NOT EXISTS nava_agent.mail_thread (
 id text PRIMARY KEY, source text NOT NULL, mailbox_id text NOT NULL, source_thread_id text NOT NULL,
 selected_message_id text NOT NULL, property_code text, mode text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source, mailbox_id, source_thread_id));
CREATE TABLE IF NOT EXISTS nava_agent.mail_message (
 id text PRIMARY KEY, thread_id text NOT NULL REFERENCES nava_agent.mail_thread(id), source_message_id text NOT NULL,
 payload jsonb NOT NULL, received_at timestamptz NOT NULL, UNIQUE(thread_id, source_message_id));
CREATE TABLE IF NOT EXISTS nava_agent.agent_session (
 id text PRIMARY KEY, thread_id text NOT NULL UNIQUE REFERENCES nava_agent.mail_thread(id), managed_session_id text UNIQUE,
 agent_id text, environment_id text, status text NOT NULL, mode text NOT NULL, config jsonb NOT NULL DEFAULT '{}',
 worker_id text, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS nava_agent.agent_event (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id text NOT NULL UNIQUE,
 session_id text NOT NULL REFERENCES nava_agent.agent_session(id), managed_event_id text UNIQUE,
 kind text NOT NULL, payload jsonb NOT NULL, at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS agent_event_session_sequence ON nava_agent.agent_event(session_id,sequence);
CREATE TABLE IF NOT EXISTS nava_agent.proposal (
 id text PRIMARY KEY, thread_id text NOT NULL REFERENCES nava_agent.mail_thread(id), session_id text NOT NULL REFERENCES nava_agent.agent_session(id),
 revision integer NOT NULL, workflow text NOT NULL, phase text NOT NULL, original jsonb NOT NULL, current jsonb NOT NULL,
 stage jsonb, execution jsonb, result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS nava_agent.staff_edit (
 id text PRIMARY KEY, sequence bigint NOT NULL, proposal_id text NOT NULL REFERENCES nava_agent.proposal(id),
 session_id text NOT NULL REFERENCES nava_agent.agent_session(id), workflow text NOT NULL, kind text NOT NULL,
 revision integer NOT NULL, path text, before jsonb, after jsonb, before_present boolean, after_present boolean,
 who text NOT NULL, at timestamptz NOT NULL DEFAULT now(), snapshot jsonb, UNIQUE(proposal_id,sequence));
