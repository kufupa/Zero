CREATE TABLE "mail_ingest_candidate_attachment_cleanup" (
  "s3_key" text PRIMARY KEY NOT NULL,
  "candidate_message_id" text NOT NULL,
  "ingest_mailbox_id" text NOT NULL,
  "pop3_uidl" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "mail_ingest_candidate_attachment_cleanup_owned_key_check" CHECK (
    length("s3_key") > length('attachments/' || "candidate_message_id" || '/')
    AND left("s3_key", length('attachments/' || "candidate_message_id" || '/')) =
      'attachments/' || "candidate_message_id" || '/'
  )
);
--> statement-breakpoint
CREATE INDEX "mail_ingest_candidate_attachment_cleanup_ingest_uidl_idx"
  ON "mail_ingest_candidate_attachment_cleanup" ("ingest_mailbox_id", "pop3_uidl");
