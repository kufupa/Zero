UPDATE thanksgiving.message
SET is_cut = false,
    cut_reason = NULL,
    cut_updated_at = now()
WHERE is_cut OR cut_reason IS NOT NULL;

UPDATE thanksgiving.attachment
SET is_cut = false,
    cut_reason = NULL,
    cut_updated_at = now()
WHERE is_cut OR cut_reason IS NOT NULL;

WITH domain_matches AS (
  SELECT
    tm.message_id,
    min(dr.rule_type || ':' || dr.domain) AS reason
  FROM thanksgiving.message tm
  JOIN thanksgiving.domain_rule dr
    ON dr.is_active
   AND tm.direction = 'inbound'
   AND (tm.sender_domain = dr.domain OR tm.sender_domain LIKE '%.' || dr.domain)
  WHERE NOT tm.is_cut
  GROUP BY tm.message_id
)
UPDATE thanksgiving.message tm
SET is_cut = true,
    cut_reason = domain_matches.reason,
    cut_updated_at = now()
FROM domain_matches
WHERE tm.message_id = domain_matches.message_id;

UPDATE thanksgiving.message tm
SET is_cut = true,
    cut_reason = 'hotel_self_prestay_confirmation',
    cut_updated_at = now()
FROM public.message pm
WHERE pm.id = tm.message_id
  AND NOT tm.is_cut
  AND (tm.sender_domain = 'legacyhotels.co.za' OR tm.sender_domain LIKE '%.legacyhotels.co.za')
  AND COALESCE(pm.subject, '') ~* '^pre[ -]stay([^0-9A-Za-z]|$)'
  AND COALESCE(pm.text_body, '') ~* 'confirmation[[:space:]]+no[[:space:]]*:?';

WITH ranked_duplicates AS (
  SELECT
    message_id,
    row_number() OVER (
      PARTITION BY lower(btrim(message_id_header)), body_sha256
      ORDER BY COALESCE(sent_at, received_at, created_at), message_id
    ) AS duplicate_rank
  FROM thanksgiving.message
  WHERE NULLIF(btrim(COALESCE(message_id_header, '')), '') IS NOT NULL
    AND body_sha256 IS NOT NULL
)
UPDATE thanksgiving.message tm
SET is_cut = true,
    cut_reason = 'exact_duplicate_message',
    cut_updated_at = now()
FROM ranked_duplicates rd
WHERE tm.message_id = rd.message_id
  AND rd.duplicate_rank > 1
  AND NOT tm.is_cut;

WITH repeated_inline_images AS (
  SELECT sha256
  FROM thanksgiving.attachment
  WHERE NULLIF(COALESCE(sha256, ''), '') IS NOT NULL
    AND mime_type ILIKE 'image/%'
    AND (is_inline OR NULLIF(COALESCE(content_id, ''), '') IS NOT NULL)
    AND COALESCE(size_bytes, 0) <= 102400
  GROUP BY sha256
  HAVING count(DISTINCT message_id) >= 5
)
UPDATE thanksgiving.attachment ta
SET is_cut = true,
    cut_reason = 'branding_signature_image',
    cut_updated_at = now()
FROM repeated_inline_images ri
WHERE ta.sha256 = ri.sha256
  AND NOT ta.is_cut;

WITH ranked_attachment_duplicates AS (
  SELECT
    attachment_id,
    row_number() OVER (
      PARTITION BY sha256
      ORDER BY COALESCE(attachment_created_at, timestamp 'epoch'), attachment_id
    ) AS duplicate_rank
  FROM thanksgiving.attachment
  WHERE NULLIF(COALESCE(sha256, ''), '') IS NOT NULL
)
UPDATE thanksgiving.attachment ta
SET is_cut = true,
    cut_reason = 'exact_duplicate_attachment',
    cut_updated_at = now()
FROM ranked_attachment_duplicates rad
WHERE ta.attachment_id = rad.attachment_id
  AND rad.duplicate_rank > 1
  AND NOT ta.is_cut;
