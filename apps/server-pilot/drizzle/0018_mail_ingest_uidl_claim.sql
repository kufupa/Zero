CREATE TABLE "mail_ingest_uidl_claim" (
  "ingest_mailbox_id" text NOT NULL,
  "pop3_uidl" text NOT NULL,
  "claim_token" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "mail_ingest_uidl_claim_pk" PRIMARY KEY ("ingest_mailbox_id", "pop3_uidl")
);
--> statement-breakpoint
CREATE INDEX "mail_ingest_uidl_claim_expires_idx"
  ON "mail_ingest_uidl_claim" ("expires_at");
