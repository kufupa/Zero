ALTER TABLE "mail_thread" ADD COLUMN "history_only" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "history_only" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "original_msg_s3_key" text;
--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "source_provenance" jsonb;
--> statement-breakpoint
ALTER TABLE "attachment" ALTER COLUMN "size_bytes" TYPE bigint;
--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "sha256" text;
--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "source_attachment_id" text;
--> statement-breakpoint
CREATE INDEX "mail_thread_transport_history_idx" ON "mail_thread" ("transport_id", "history_only", "latest_message_at");
