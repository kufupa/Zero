BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';
WITH matching AS (
  SELECT
    a.id AS attachment_row_id,
    a.message_id,
    a.filename,
    m.id AS message_row_id,
    COALESCE(m.message_id_header, m.id::text) AS logical_email_key,
    m.transport_id,
    m.direction::text AS direction,
    m.thread_id,
    COALESCE(m.sent_at, m.received_at, m.created_at) AS message_time,
    COALESCE(m.subject, '') ~* 'confirmation[[:space:]_-]*letter'
      AS subject_confirmation_letter,
    (mt.email IS NOT NULL AND mt.email <> ''
      AND lower(COALESCE(m.from_address, ''))
        LIKE '%' || lower(mt.email) || '%') AS sender_is_mailbox,
    count(*) OVER (PARTITION BY a.message_id)
      AS matching_attachments_on_message
  FROM attachment a
  JOIN message m ON m.id = a.message_id
  LEFT JOIN mailbox_transport mt ON mt.id = m.transport_id
  WHERE COALESCE(a.filename, '')
    ~ '^HRCEN_Confirmation_Letter_.*[.]pdf$'
)
SELECT
  current_database(),
  to_char(statement_timestamp() AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  CASE WHEN GROUPING(transport_id) = 1
    THEN 'ALL' ELSE COALESCE(transport_id, '(null)') END,
  CASE WHEN GROUPING(direction) = 1
    THEN 'ALL' ELSE COALESCE(direction, '(null)') END,
  count(*) AS matching_attachment_rows,
  count(DISTINCT message_row_id) AS message_rows,
  count(DISTINCT logical_email_key) AS distinct_email_keys,
  count(DISTINCT (transport_id, thread_id))
    FILTER (WHERE thread_id IS NOT NULL) AS transport_threads,
  count(DISTINCT message_row_id)
    FILTER (WHERE subject_confirmation_letter)
    AS confirmation_letter_subject_messages,
  count(DISTINCT message_row_id)
    FILTER (WHERE sender_is_mailbox) AS own_mailbox_sender_messages,
  count(DISTINCT message_row_id)
    FILTER (WHERE matching_attachments_on_message > 1)
    AS messages_with_multiple_matching_attachments,
  count(DISTINCT filename) AS distinct_matching_filenames,
  min(message_time),
  max(message_time)
FROM matching
GROUP BY GROUPING SETS ((transport_id, direction), ())
ORDER BY GROUPING(transport_id) DESC, 3, 4;
ROLLBACK;
