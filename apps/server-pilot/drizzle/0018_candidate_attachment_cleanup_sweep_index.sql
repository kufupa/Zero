CREATE INDEX "mail_ingest_candidate_attachment_cleanup_sweep_idx"
  ON "mail_ingest_candidate_attachment_cleanup" ("created_at", "s3_key");
