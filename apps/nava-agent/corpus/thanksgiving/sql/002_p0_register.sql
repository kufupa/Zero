INSERT INTO thanksgiving.message (
  message_id,
  thread_id,
  transport_id,
  direction,
  sent_at,
  received_at,
  created_at,
  sender_domain,
  regime,
  raw_mime_missing,
  message_id_header,
  body_sha256,
  attachment_count,
  registered_at,
  updated_at
)
SELECT
  m.id,
  m.thread_id,
  m.transport_id,
  m.direction::text,
  m.sent_at,
  m.received_at,
  m.created_at,
  lower(substring(m.from_address from '@([A-Za-z0-9.-]+)')),
  CASE
    WHEN COALESCE(m.sent_at, m.received_at, m.created_at) >= timestamp '2026-09-09' THEN 'post_2026-09-09'
    ELSE 'pre_2026-09-09'
  END,
  m.raw_mime_s3_key IS NULL,
  m.message_id_header,
  NULL,
  0,
  now(),
  now()
FROM public.message m
ON CONFLICT (message_id) DO UPDATE SET
  thread_id = EXCLUDED.thread_id,
  transport_id = EXCLUDED.transport_id,
  direction = EXCLUDED.direction,
  sent_at = EXCLUDED.sent_at,
  received_at = EXCLUDED.received_at,
  created_at = EXCLUDED.created_at,
  sender_domain = EXCLUDED.sender_domain,
  regime = EXCLUDED.regime,
  raw_mime_missing = EXCLUDED.raw_mime_missing,
  message_id_header = EXCLUDED.message_id_header,
  updated_at = now();

INSERT INTO thanksgiving.attachment (
  attachment_id,
  message_id,
  filename,
  mime_type,
  size_bytes,
  sha256,
  s3_key,
  content_id,
  is_inline,
  attachment_created_at,
  registered_at,
  updated_at
)
SELECT
  a.id,
  a.message_id,
  a.filename,
  a.mime_type,
  a.size_bytes,
  a.sha256,
  a.s3_key,
  a.content_id,
  a.is_inline,
  a.created_at,
  now(),
  now()
FROM public.attachment a
ON CONFLICT (attachment_id) DO UPDATE SET
  message_id = EXCLUDED.message_id,
  filename = EXCLUDED.filename,
  mime_type = EXCLUDED.mime_type,
  size_bytes = EXCLUDED.size_bytes,
  sha256 = EXCLUDED.sha256,
  s3_key = EXCLUDED.s3_key,
  content_id = EXCLUDED.content_id,
  is_inline = EXCLUDED.is_inline,
  attachment_created_at = EXCLUDED.attachment_created_at,
  updated_at = now();

UPDATE thanksgiving.message tm
SET attachment_count = 0,
    updated_at = now()
WHERE tm.attachment_count <> 0;

UPDATE thanksgiving.message tm
SET attachment_count = counts.attachment_count,
    updated_at = now()
FROM (
  SELECT message_id, count(*)::integer AS attachment_count
  FROM thanksgiving.attachment
  GROUP BY message_id
) counts
WHERE tm.message_id = counts.message_id
  AND tm.attachment_count <> counts.attachment_count;
