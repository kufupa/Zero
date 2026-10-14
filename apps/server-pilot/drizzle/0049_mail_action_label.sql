-- Hand-written, additive. Shadow model predictions, agent labels and owner action marks.
-- Mirrors mailActionLabel in apps/server-pilot/src/db/schema/mail.ts; keep names, types and CHECK lists in sync.
-- Labels go with their mailbox transport. message_id has no foreign key on purpose: owner and agent
-- marks are gold labels that must survive a permanent delete of the email (no lock on message either).
-- One label per (message, source, version); owner writers use version 'owner' and upsert on re-mark.
CREATE TABLE IF NOT EXISTS "mail_action_label" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE cascade,
  "message_id" text NOT NULL,
  "source" text NOT NULL,
  "action" text NOT NULL,
  "needs_action" boolean NOT NULL,
  "version" text NOT NULL,
  "labelled_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "mail_action_label_source_check" CHECK ("source" IN ('model', 'agent', 'owner')),
  CONSTRAINT "mail_action_label_action_check" CHECK ("action" IN ('no_action', 'quote_availability', 'new_booking', 'amend', 'cancel', 'payment_proof', 'billing', 'group_event', 'other_actionable')),
  CONSTRAINT "mail_action_label_needs_action_check" CHECK ("needs_action" = ("action" <> 'no_action'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_action_label_message_source_version_uidx" ON "mail_action_label" ("message_id", "source", "version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_action_label_transport_source_action_idx" ON "mail_action_label" ("transport_id", "source", "action");
