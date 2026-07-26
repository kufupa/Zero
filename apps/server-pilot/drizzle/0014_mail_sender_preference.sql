DO $$ BEGIN
  CREATE TYPE "mail_sender_preference_kind" AS ENUM ('block', 'allow');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "mail_sender_preference" (
  "id" text PRIMARY KEY NOT NULL,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "kind" "mail_sender_preference_kind" NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "mail_sender_preference_transport_email_uidx"
  ON "mail_sender_preference" ("transport_id", "email");

CREATE INDEX IF NOT EXISTS "mail_sender_preference_transport_idx"
  ON "mail_sender_preference" ("transport_id");
