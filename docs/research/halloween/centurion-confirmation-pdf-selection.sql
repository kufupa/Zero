-- Candidate inventory only; original From display-name matching requires
-- reading the raw MIME header from object storage, which SQL cannot do.
-- `message.from_address` is an effective/stored address and is diagnostic only.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';

WITH candidates AS (
  SELECT
    a.id AS attachment_id,
    a.message_id,
    a.filename,
    a.size_bytes,
    m.transport_id,
    m.direction::text AS direction,
    m.thread_id,
    m.from_address AS stored_from_address,
    m.raw_mime_s3_key,
    COALESCE(m.sent_at, m.received_at, m.created_at) AS message_time
  FROM attachment AS a
  INNER JOIN message AS m ON m.id = a.message_id
  WHERE m.transport_id = 'transport-centurion'
    AND m.direction::text = 'outbound'
    AND COALESCE(a.filename, '') ~ '^HRCEN_Confirmation_Letter_.*[.]pdf$'
), per_message AS (
  SELECT message_id, count(*) AS attachment_count
  FROM candidates
  GROUP BY message_id
)
SELECT
  current_database() AS database_name,
  to_char(statement_timestamp() AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS query_time_utc,
  count(*) AS candidate_attachment_rows,
  count(DISTINCT message_id) AS parent_message_rows,
  count(DISTINCT thread_id) FILTER (WHERE thread_id IS NOT NULL)
    AS distinct_thread_ids,
  count(DISTINCT filename) AS distinct_filenames,
  count(*) FILTER (WHERE raw_mime_s3_key IS NOT NULL)
    AS rows_with_raw_mime_locator,
  count(*) FILTER (WHERE raw_mime_s3_key IS NULL)
    AS rows_without_raw_mime_locator,
  count(DISTINCT message_id) FILTER (
    WHERE COALESCE(stored_from_address, '') LIKE 'Centurion at%'
  ) AS stored_from_address_prefix_diagnostic,
  count(DISTINCT message_id) FILTER (
    WHERE pm.attachment_count > 1
  ) AS messages_with_multiple_candidate_pdfs,
  sum(size_bytes) AS declared_pdf_bytes,
  min(message_time) AS earliest_stored_message_time,
  max(message_time) AS latest_stored_message_time
FROM candidates AS c
INNER JOIN per_message AS pm ON pm.message_id = c.message_id;

ROLLBACK;
