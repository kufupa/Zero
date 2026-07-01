CREATE TYPE "public"."mailbox_access_role" AS ENUM('owner', 'member', 'admin');--> statement-breakpoint
CREATE TYPE "public"."mailbox_type" AS ENUM('personal', 'shared');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"custom_prompt" text,
	"phone_number" text,
	"phone_number_verified" boolean,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_phone_number_unique" UNIQUE("phone_number")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "email_template" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"subject" text,
	"body" text,
	"to" jsonb,
	"cc" jsonb,
	"bcc" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "email_template_user_id_name_unique" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "jwks" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"content" text NOT NULL,
	"color" text DEFAULT 'default' NOT NULL,
	"is_pinned" boolean DEFAULT false,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"settings" jsonb DEFAULT '{"language":"en","timezone":"UTC","dynamicContent":false,"externalImages":true,"customPrompt":"","trustedSenders":[],"isOnboarded":false,"colorTheme":"system","zeroSignature":false,"autoRead":true,"defaultEmailAlias":"","categories":[{"id":"Important","name":"Important","searchValue":"IMPORTANT","order":0,"icon":"Lightning","isDefault":false},{"id":"All Mail","name":"All Mail","searchValue":"","order":1,"icon":"Mail","isDefault":true},{"id":"Unread","name":"Unread","searchValue":"UNREAD","order":5,"icon":"ScanEye","isDefault":false}],"undoSendEnabled":true,"imageCompression":"medium","animations":false}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_settings_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "attachment" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"s3_key" text NOT NULL,
	"content_id" text,
	"is_inline" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_draft" (
	"id" text PRIMARY KEY NOT NULL,
	"transport_id" text NOT NULL,
	"thread_id" text,
	"created_by_user_id" text NOT NULL,
	"to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text,
	"text_body" text,
	"html_body" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_sent" boolean DEFAULT false NOT NULL,
	"sent_message_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_ingest_mailbox" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mail_ingest_mailbox_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "mail_ingest_quarantine" (
	"id" text PRIMARY KEY NOT NULL,
	"ingest_mailbox_id" text NOT NULL,
	"pop3_uidl" text NOT NULL,
	"raw_mime_s3_key" text NOT NULL,
	"reason" text NOT NULL,
	"owner_header_value" text,
	"parsed_headers" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_label" (
	"id" text PRIMARY KEY NOT NULL,
	"transport_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_thread" (
	"id" text PRIMARY KEY NOT NULL,
	"transport_id" text NOT NULL,
	"thread_root_id" text NOT NULL,
	"subject" text,
	"snippet" text,
	"is_archived" boolean DEFAULT false NOT NULL,
	"is_starred" boolean DEFAULT false NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"label_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"snoozed_until" timestamp,
	"latest_message_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_access" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"transport_id" text NOT NULL,
	"role" "mailbox_access_role" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_transport" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"owner_header_value" text NOT NULL,
	"mailbox_type" "mailbox_type" DEFAULT 'shared' NOT NULL,
	"display_name" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"send_from_config" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_transport_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" text PRIMARY KEY NOT NULL,
	"transport_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"ingest_mailbox_id" text,
	"direction" "message_direction" NOT NULL,
	"pop3_uidl" text,
	"owner_header_value" text,
	"message_id_header" text,
	"in_reply_to" text,
	"references" jsonb,
	"from_address" text NOT NULL,
	"to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text,
	"text_body" text,
	"html_body" text,
	"raw_mime_s3_key" text,
	"is_read" boolean DEFAULT false NOT NULL,
	"is_starred" boolean DEFAULT false NOT NULL,
	"received_at" timestamp,
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_template" ADD CONSTRAINT "email_template_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_draft" ADD CONSTRAINT "mail_draft_transport_id_mailbox_transport_id_fk" FOREIGN KEY ("transport_id") REFERENCES "public"."mailbox_transport"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_draft" ADD CONSTRAINT "mail_draft_thread_id_mail_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."mail_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_draft" ADD CONSTRAINT "mail_draft_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_ingest_quarantine" ADD CONSTRAINT "mail_ingest_quarantine_ingest_mailbox_id_mail_ingest_mailbox_id_fk" FOREIGN KEY ("ingest_mailbox_id") REFERENCES "public"."mail_ingest_mailbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_label" ADD CONSTRAINT "mail_label_transport_id_mailbox_transport_id_fk" FOREIGN KEY ("transport_id") REFERENCES "public"."mailbox_transport"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_thread" ADD CONSTRAINT "mail_thread_transport_id_mailbox_transport_id_fk" FOREIGN KEY ("transport_id") REFERENCES "public"."mailbox_transport"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_access" ADD CONSTRAINT "mailbox_access_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_access" ADD CONSTRAINT "mailbox_access_transport_id_mailbox_transport_id_fk" FOREIGN KEY ("transport_id") REFERENCES "public"."mailbox_transport"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_transport_id_mailbox_transport_id_fk" FOREIGN KEY ("transport_id") REFERENCES "public"."mailbox_transport"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_thread_id_mail_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."mail_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_ingest_mailbox_id_mail_ingest_mailbox_id_fk" FOREIGN KEY ("ingest_mailbox_id") REFERENCES "public"."mail_ingest_mailbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "account_provider_user_id_idx" ON "account" USING btree ("provider_id","user_id");--> statement-breakpoint
CREATE INDEX "account_expires_at_idx" ON "account" USING btree ("access_token_expires_at");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_expires_at_idx" ON "session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "user_email_idx" ON "user" USING btree ("email");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "verification_expires_at_idx" ON "verification" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "email_template_user_id_idx" ON "email_template" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "jwks_created_at_idx" ON "jwks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "note_user_id_idx" ON "note" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "note_thread_id_idx" ON "note" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "note_user_thread_idx" ON "note" USING btree ("user_id","thread_id");--> statement-breakpoint
CREATE INDEX "note_is_pinned_idx" ON "note" USING btree ("is_pinned");--> statement-breakpoint
CREATE INDEX "user_settings_settings_idx" ON "user_settings" USING btree ("settings");--> statement-breakpoint
CREATE INDEX "attachment_message_idx" ON "attachment" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "attachment_s3_key_idx" ON "attachment" USING btree ("s3_key");--> statement-breakpoint
CREATE INDEX "mail_draft_transport_idx" ON "mail_draft" USING btree ("transport_id");--> statement-breakpoint
CREATE INDEX "mail_draft_thread_idx" ON "mail_draft" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "mail_draft_created_by_idx" ON "mail_draft" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "mail_ingest_mailbox_email_idx" ON "mail_ingest_mailbox" USING btree ("email");--> statement-breakpoint
CREATE INDEX "mail_ingest_quarantine_ingest_idx" ON "mail_ingest_quarantine" USING btree ("ingest_mailbox_id");--> statement-breakpoint
CREATE INDEX "mail_ingest_quarantine_reason_idx" ON "mail_ingest_quarantine" USING btree ("reason");--> statement-breakpoint
CREATE INDEX "mail_ingest_quarantine_created_at_idx" ON "mail_ingest_quarantine" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_label_transport_name_uidx" ON "mail_label" USING btree ("transport_id","name");--> statement-breakpoint
CREATE INDEX "mail_label_transport_idx" ON "mail_label" USING btree ("transport_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_thread_transport_root_uidx" ON "mail_thread" USING btree ("transport_id","thread_root_id");--> statement-breakpoint
CREATE INDEX "mail_thread_transport_list_idx" ON "mail_thread" USING btree ("transport_id","is_archived","latest_message_at");--> statement-breakpoint
CREATE INDEX "mail_thread_snooze_wake_idx" ON "mail_thread" USING btree ("snoozed_until") WHERE "mail_thread"."snoozed_until" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_access_user_transport_uidx" ON "mailbox_access" USING btree ("user_id","transport_id");--> statement-breakpoint
CREATE INDEX "mailbox_access_user_role_idx" ON "mailbox_access" USING btree ("user_id","role");--> statement-breakpoint
CREATE INDEX "mailbox_access_transport_idx" ON "mailbox_access" USING btree ("transport_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_transport_owner_header_uidx" ON "mailbox_transport" USING btree ("owner_header_value");--> statement-breakpoint
CREATE INDEX "mailbox_transport_email_idx" ON "mailbox_transport" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "message_ingest_uidl_uidx" ON "message" USING btree ("ingest_mailbox_id","pop3_uidl") WHERE "message"."direction" = 'inbound';--> statement-breakpoint
CREATE INDEX "message_transport_thread_idx" ON "message" USING btree ("transport_id","thread_id");--> statement-breakpoint
CREATE INDEX "message_transport_received_idx" ON "message" USING btree ("transport_id","received_at");