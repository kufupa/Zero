CREATE TABLE IF NOT EXISTS "message_reaction" (
  "id" text PRIMARY KEY NOT NULL,
  "message_id" text NOT NULL REFERENCES "message"("id") ON DELETE CASCADE,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE CASCADE,
  "user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "user_email" text NOT NULL,
  "user_name" text,
  "reaction" text NOT NULL,
  "source" text NOT NULL DEFAULT 'internal',
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "message_reaction_message_idx"
  ON "message_reaction" ("message_id");

CREATE INDEX IF NOT EXISTS "message_reaction_transport_idx"
  ON "message_reaction" ("transport_id");

CREATE UNIQUE INDEX IF NOT EXISTS "message_reaction_user_unique_idx"
  ON "message_reaction" ("message_id", "user_email", "reaction");
