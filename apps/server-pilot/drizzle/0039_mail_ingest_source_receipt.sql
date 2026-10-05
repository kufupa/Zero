CREATE TABLE "mail_ingest_source_receipt" (
 "id" text PRIMARY KEY NOT NULL, "ingest_mailbox_id" text NOT NULL REFERENCES "mail_ingest_mailbox"("id") ON DELETE CASCADE,
 "pop3_uidl" text NOT NULL, "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE CASCADE,
 "canonical_message_id" text NOT NULL REFERENCES "message"("id") ON DELETE CASCADE,
 "raw_mime_s3_key" text NOT NULL, "sha256" text NOT NULL, "accepted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mail_ingest_source_receipt_identity_uidx" ON "mail_ingest_source_receipt" ("ingest_mailbox_id","pop3_uidl");
--> statement-breakpoint
CREATE INDEX "mail_ingest_source_receipt_canonical_idx" ON "mail_ingest_source_receipt" ("canonical_message_id");
