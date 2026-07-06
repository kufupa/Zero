CREATE TABLE IF NOT EXISTS "mail_category" (
  "id" text PRIMARY KEY NOT NULL,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE cascade,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "color" text,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "mail_category_transport_slug_uidx"
  ON "mail_category" ("transport_id", "slug");

CREATE INDEX IF NOT EXISTS "mail_category_transport_order_idx"
  ON "mail_category" ("transport_id", "sort_order");

CREATE TABLE IF NOT EXISTS "mail_thread_category" (
  "thread_id" text NOT NULL REFERENCES "mail_thread"("id") ON DELETE cascade,
  "category_id" text NOT NULL REFERENCES "mail_category"("id") ON DELETE cascade,
  "transport_id" text NOT NULL REFERENCES "mailbox_transport"("id") ON DELETE cascade,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "mail_thread_category_thread_id_category_id_pk" PRIMARY KEY ("thread_id", "category_id")
);

CREATE INDEX IF NOT EXISTS "mail_thread_category_category_idx"
  ON "mail_thread_category" ("category_id");

CREATE INDEX IF NOT EXISTS "mail_thread_category_transport_idx"
  ON "mail_thread_category" ("transport_id");
