ALTER TABLE "mail_thread"
  ADD COLUMN IF NOT EXISTS "spam_user_locked_at" timestamptz;
