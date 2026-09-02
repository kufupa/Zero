CREATE INDEX IF NOT EXISTS "message_transport_header_idx" ON "message" USING btree ("transport_id", "message_id_header") WHERE "message"."message_id_header" IS NOT NULL;
