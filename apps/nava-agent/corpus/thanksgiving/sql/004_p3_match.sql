UPDATE thanksgiving.thread_hms_match
SET is_active = false,
    matched_at = now()
WHERE is_active;

UPDATE thanksgiving.confirmation_key ck
SET is_active = false
FROM thanksgiving.message donor
WHERE donor.message_id = ck.message_id
  AND ck.is_active
  AND donor.is_cut
  AND COALESCE(donor.cut_reason, '') NOT IN ('hotel_self_prestay_confirmation', 'owner_prestay_form_only');

WITH grouped AS (
  SELECT
    ck.thread_id,
    ck.confirmation_key,
    hr.property_code,
    (array_agg(ck.source ORDER BY ck.confidence DESC, ck.source))[1] AS best_source,
    max(ck.confidence) AS best_confidence,
    count(DISTINCT ck.message_id)::integer AS key_message_count
  FROM thanksgiving.confirmation_key ck
  JOIN thanksgiving.hms_reservation hr
    ON hr.confirmation_key = ck.confirmation_key
   AND hr.is_active
  WHERE ck.is_active
  GROUP BY ck.thread_id, ck.confirmation_key, hr.property_code
)
INSERT INTO thanksgiving.thread_hms_match (
  thread_id,
  confirmation_key,
  property_code,
  best_source,
  best_confidence,
  key_message_count,
  is_active,
  run_id,
  matched_at
)
SELECT
  thread_id,
  confirmation_key,
  property_code,
  best_source,
  best_confidence,
  key_message_count,
  true,
  '__RUN_ID__',
  now()
FROM grouped
ON CONFLICT (thread_id, confirmation_key, property_code) DO UPDATE SET
  best_source = EXCLUDED.best_source,
  best_confidence = EXCLUDED.best_confidence,
  key_message_count = EXCLUDED.key_message_count,
  is_active = true,
  run_id = EXCLUDED.run_id,
  matched_at = now();
