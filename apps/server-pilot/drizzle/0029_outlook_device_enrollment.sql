CREATE TABLE "outlook_enrollment" ("code_hash" text PRIMARY KEY, "store_id" text NOT NULL, "expires_at" timestamp NOT NULL, "consumed_at" timestamp, "created_at" timestamp NOT NULL DEFAULT now());
--> statement-breakpoint
CREATE TABLE "outlook_enrollment_grant" ("code_hash" text NOT NULL REFERENCES "outlook_enrollment"("code_hash") ON DELETE CASCADE, "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE, "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE CASCADE, PRIMARY KEY("code_hash", "user_id", "transport_id"));
--> statement-breakpoint
CREATE TABLE "outlook_device" ("device_id" text PRIMARY KEY, "version" text NOT NULL, "store_id" text NOT NULL, "secret_ciphertext" text NOT NULL, "enrolled_at" timestamp NOT NULL DEFAULT now(), "last_handshake_at" timestamp, "revoked_at" timestamp);
--> statement-breakpoint
CREATE TABLE "outlook_device_grant" ("device_id" text NOT NULL REFERENCES "outlook_device"("device_id") ON DELETE CASCADE, "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE, "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE CASCADE, PRIMARY KEY("device_id", "user_id", "transport_id"));
--> statement-breakpoint
CREATE TABLE "outlook_device_nonce" ("nonce_hash" text PRIMARY KEY, "device_id" text NOT NULL REFERENCES "outlook_device"("device_id") ON DELETE CASCADE, "expires_at" timestamp NOT NULL, "consumed_at" timestamp);
--> statement-breakpoint
CREATE INDEX "outlook_device_nonce_device_idx" ON "outlook_device_nonce" ("device_id");
--> statement-breakpoint
CREATE INDEX "outlook_device_nonce_expiry_idx" ON "outlook_device_nonce" ("expires_at");
