CREATE TABLE IF NOT EXISTS "outbound_send_queue" (
  "id" text PRIMARY KEY NOT NULL,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE cascade,
  "message_id" text NOT NULL REFERENCES "message"("id") ON DELETE cascade,
  "send_at" timestamptz NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "smtp_payload" jsonb NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "claimed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "outbound_send_queue_message_uidx"
  ON "outbound_send_queue" ("message_id");

CREATE INDEX IF NOT EXISTS "outbound_send_queue_due_idx"
  ON "outbound_send_queue" ("status", "send_at");

CREATE INDEX IF NOT EXISTS "outbound_send_queue_transport_idx"
  ON "outbound_send_queue" ("transport_id", "status");
