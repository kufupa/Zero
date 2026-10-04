CREATE TABLE "outlook_device_read_root" (
  "device_id" text NOT NULL,
  "user_id" text NOT NULL,
  "transport_id" text NOT NULL,
  "store_id" text NOT NULL,
  "root_entry_id" text NOT NULL,
  "policy_version" integer DEFAULT 1 NOT NULL,
  "policy_generation" integer DEFAULT 1 NOT NULL,
  "revoked_at" timestamp,
  "approved_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "outlook_device_read_root_pkey" PRIMARY KEY ("device_id", "user_id", "transport_id", "store_id", "root_entry_id"),
  CONSTRAINT "outlook_read_root_policy_version" CHECK ("policy_version" = 1),
  CONSTRAINT "outlook_read_root_generation" CHECK ("policy_generation" > 0),
  CONSTRAINT "outlook_device_read_root_grant_fk" FOREIGN KEY ("device_id", "user_id", "transport_id")
    REFERENCES "outlook_device_grant" ("device_id", "user_id", "transport_id") ON DELETE CASCADE
);
