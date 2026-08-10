CREATE TABLE "remote_session" (
  "id" text PRIMARY KEY NOT NULL,
  "expires_at" timestamp NOT NULL,
  "token" text NOT NULL UNIQUE,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade
);
CREATE INDEX "remote_session_user_id_idx" ON "remote_session" ("user_id");
CREATE INDEX "remote_session_expires_at_idx" ON "remote_session" ("expires_at");
