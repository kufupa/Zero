DO $$ BEGIN
  CREATE TYPE "mail_conversation_link_type" AS ENUM (
    'header_parent',
    'domain_conf',
    'domain_guest_email',
    'quoted_body',
    'subject_cluster',
    'llm_link'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "mail_conversation_link" (
  "id" text PRIMARY KEY NOT NULL,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE CASCADE,
  "src_thread_id" text NOT NULL REFERENCES "mail_thread"("id") ON DELETE CASCADE,
  "dst_thread_id" text NOT NULL REFERENCES "mail_thread"("id") ON DELETE CASCADE,
  "src_message_id" text REFERENCES "message"("id") ON DELETE SET NULL,
  "dst_message_id" text REFERENCES "message"("id") ON DELETE SET NULL,
  "link_type" "mail_conversation_link_type" NOT NULL,
  "confidence" numeric(5, 4) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "superseded_at" timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "mail_conversation_link_edge_uidx"
  ON "mail_conversation_link" ("transport_id", "src_thread_id", "dst_thread_id", "link_type");

CREATE INDEX IF NOT EXISTS "mail_conversation_link_transport_src_idx"
  ON "mail_conversation_link" ("transport_id", "src_thread_id");

CREATE INDEX IF NOT EXISTS "mail_conversation_link_transport_dst_idx"
  ON "mail_conversation_link" ("transport_id", "dst_thread_id");
