ALTER TABLE "ai_workflow_run" ADD COLUMN "admission_snapshot_id" text;
--> statement-breakpoint
ALTER TABLE "ai_workflow_run" ADD COLUMN "admission_snapshot_hash" text;
--> statement-breakpoint
CREATE TABLE "mail_live_admission" (
 "id" text PRIMARY KEY,
 "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id"),
 "canonical_message_id" text NOT NULL REFERENCES "message"("id"),
 "evidence" jsonb NOT NULL,
 "snapshot" jsonb NOT NULL,
 "snapshot_hash" text NOT NULL,
 "effect_state" text NOT NULL,
 "admitted_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mail_live_admission_canonical_uq" ON "mail_live_admission"("transport_id","canonical_message_id");
