DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM message m
    INNER JOIN mail_thread t ON t.id = m.thread_id
    WHERE m.transport_id IS DISTINCT FROM t.transport_id
  ) THEN
    RAISE EXCEPTION 'message_thread_transport_mismatch: message.transport_id must match mail_thread.transport_id';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "mail_thread" ADD CONSTRAINT "mail_thread_id_transport_uidx" UNIQUE("id","transport_id");--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_thread_transport_fk" FOREIGN KEY ("thread_id","transport_id") REFERENCES "public"."mail_thread"("id","transport_id") ON DELETE cascade ON UPDATE no action;
