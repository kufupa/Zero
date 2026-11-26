WITH post_threads AS (
  SELECT DISTINCT thread_id
  FROM thanksgiving.message
  WHERE regime = 'post_2026-09-09'
    AND direction = 'inbound'
    AND NOT is_cut
),
thread_stats AS (
  SELECT
    pt.thread_id,
    count(DISTINCT ck.confirmation_key) AS key_count,
    count(DISTINCT thm.confirmation_key) AS resolved_key_count
  FROM post_threads pt
  LEFT JOIN thanksgiving.confirmation_key ck
    ON ck.thread_id = pt.thread_id
   AND ck.is_active
  LEFT JOIN thanksgiving.thread_hms_match thm
    ON thm.thread_id = pt.thread_id
   AND thm.confirmation_key = ck.confirmation_key
   AND thm.is_active
  GROUP BY pt.thread_id
),
summary AS (
  SELECT
    count(*)::bigint AS denominator,
    count(*) FILTER (WHERE key_count > 0)::bigint AS keyed_threads,
    count(*) FILTER (WHERE resolved_key_count > 0)::bigint AS numerator
  FROM thread_stats
)
INSERT INTO thanksgiving.metric_snapshot (
  run_id, metric_name, numerator, denominator, rate, details, created_at
)
SELECT
  '__RUN_ID__',
  'thread_to_hms_hit_rate',
  numerator,
  denominator,
  CASE WHEN denominator > 0 THEN numerator::numeric / denominator::numeric END,
  jsonb_build_object(
    'keyed_threads', keyed_threads,
    'definition', 'post-2026-09-09 threads with at least one non-cut inbound message; numerator has at least one active confirmation key anywhere in the thread resolving to active HMS evidence',
    'message_cutoff', '2026-09-09',
    'hms_cutoff', '2026-09-09T00:00:00Z'
  ),
  now()
FROM summary
ON CONFLICT (run_id, metric_name) DO UPDATE SET
  numerator = EXCLUDED.numerator,
  denominator = EXCLUDED.denominator,
  rate = EXCLUDED.rate,
  details = EXCLUDED.details,
  created_at = now();

WITH hms_cohort AS (
  SELECT confirmation_key, property_code
  FROM thanksgiving.hms_reservation
  WHERE is_active
    AND source_of_business = 'E-Mail'
    AND created_at >= timestamptz '2026-09-09 00:00:00+00'
),
post_threads AS (
  SELECT DISTINCT thread_id
  FROM thanksgiving.message
  WHERE regime = 'post_2026-09-09'
),
presence AS (
  SELECT
    h.confirmation_key,
    bool_or(ck.confirmation_key IS NOT NULL) AS seen_anywhere,
    bool_or(pt.thread_id IS NOT NULL) AS seen_in_post_thread
  FROM hms_cohort h
  LEFT JOIN thanksgiving.confirmation_key ck
    ON ck.confirmation_key = h.confirmation_key
   AND ck.is_active
  LEFT JOIN post_threads pt
    ON pt.thread_id = ck.thread_id
  GROUP BY h.confirmation_key
),
summary AS (
  SELECT
    count(*)::bigint AS denominator,
    count(*) FILTER (WHERE seen_in_post_thread)::bigint AS numerator,
    count(*) FILTER (WHERE seen_anywhere)::bigint AS any_window_matches
  FROM presence
)
INSERT INTO thanksgiving.metric_snapshot (
  run_id, metric_name, numerator, denominator, rate, details, created_at
)
SELECT
  '__RUN_ID__',
  'hms_to_thread_coverage',
  numerator,
  denominator,
  CASE WHEN denominator > 0 THEN numerator::numeric / denominator::numeric END,
  jsonb_build_object(
    'any_window_matches', any_window_matches,
    'definition', 'active HMS reservations with source_of_business E-Mail and created_at on or after 2026-09-09 UTC; numerator has the confirmation key in any registered thread containing at least one post-2026-09-09 message',
    'message_cutoff', '2026-09-09',
    'hms_cutoff', '2026-09-09T00:00:00Z'
  ),
  now()
FROM summary
ON CONFLICT (run_id, metric_name) DO UPDATE SET
  numerator = EXCLUDED.numerator,
  denominator = EXCLUDED.denominator,
  rate = EXCLUDED.rate,
  details = EXCLUDED.details,
  created_at = now();

WITH message_counts AS (
  SELECT
    count(*)::bigint AS total_messages,
    count(*) FILTER (WHERE cut_reason LIKE 'ota_channel:%' OR cut_reason LIKE 'system_notice:%')::bigint AS domain_cut_messages,
    count(*) FILTER (WHERE cut_reason = 'hotel_self_prestay_confirmation')::bigint AS self_mail_cut_messages,
    count(*) FILTER (WHERE cut_reason = 'exact_duplicate_message')::bigint AS duplicate_cut_messages,
    count(*) FILTER (WHERE NOT is_cut)::bigint AS final_uncut_messages,
    count(*) FILTER (WHERE raw_mime_missing)::bigint AS raw_mime_key_missing_messages
  FROM thanksgiving.message
),
attachment_counts AS (
  SELECT
    count(*)::bigint AS total_attachments,
    count(*) FILTER (WHERE cut_reason = 'branding_signature_image')::bigint AS branding_cut_attachments,
    count(*) FILTER (WHERE cut_reason = 'exact_duplicate_attachment')::bigint AS duplicate_cut_attachments,
    count(*) FILTER (WHERE NOT is_cut)::bigint AS final_uncut_attachments
  FROM thanksgiving.attachment
),
post_threads AS (
  SELECT DISTINCT thread_id
  FROM thanksgiving.message
  WHERE regime = 'post_2026-09-09'
    AND direction = 'inbound'
    AND NOT is_cut
),
thread_stats AS (
  SELECT
    pt.thread_id,
    count(DISTINCT ck.confirmation_key) AS key_count,
    count(DISTINCT thm.confirmation_key) AS resolved_key_count
  FROM post_threads pt
  LEFT JOIN thanksgiving.confirmation_key ck
    ON ck.thread_id = pt.thread_id
   AND ck.is_active
  LEFT JOIN thanksgiving.thread_hms_match thm
    ON thm.thread_id = pt.thread_id
   AND thm.confirmation_key = ck.confirmation_key
   AND thm.is_active
  GROUP BY pt.thread_id
),
thread_summary AS (
  SELECT
    count(*)::bigint AS post_noncut_inbound_threads,
    count(*) FILTER (WHERE key_count > 0)::bigint AS keyed_threads,
    count(*) FILTER (WHERE resolved_key_count > 0)::bigint AS resolved_threads
  FROM thread_stats
),
hms_summary AS (
  SELECT
    count(*)::bigint AS active_hms_reservations,
    count(*) FILTER (WHERE source_of_business = 'E-Mail' AND created_at >= timestamptz '2026-09-09 00:00:00+00')::bigint AS post_email_hms_reservations
  FROM thanksgiving.hms_reservation
  WHERE is_active
),
key_summary AS (
  SELECT
    count(*)::bigint AS active_confirmation_key_rows,
    count(DISTINCT confirmation_key)::bigint AS distinct_confirmation_keys,
    count(DISTINCT thread_id)::bigint AS threads_with_keys
  FROM thanksgiving.confirmation_key
  WHERE is_active
)
INSERT INTO thanksgiving.metric_snapshot (
  run_id, metric_name, numerator, denominator, rate, details, created_at
)
SELECT
  '__RUN_ID__',
  'funnel_counts',
  thread_summary.resolved_threads,
  message_counts.total_messages,
  NULL,
  jsonb_build_object(
    'total_messages', message_counts.total_messages,
    'domain_cut_messages', message_counts.domain_cut_messages,
    'self_mail_cut_messages', message_counts.self_mail_cut_messages,
    'duplicate_cut_messages', message_counts.duplicate_cut_messages,
    'final_uncut_messages', message_counts.final_uncut_messages,
    'raw_mime_key_missing_messages', message_counts.raw_mime_key_missing_messages,
    'total_attachments', attachment_counts.total_attachments,
    'branding_cut_attachments', attachment_counts.branding_cut_attachments,
    'duplicate_cut_attachments', attachment_counts.duplicate_cut_attachments,
    'final_uncut_attachments', attachment_counts.final_uncut_attachments,
    'post_noncut_inbound_threads', thread_summary.post_noncut_inbound_threads,
    'keyed_threads', thread_summary.keyed_threads,
    'resolved_threads', thread_summary.resolved_threads,
    'active_confirmation_key_rows', key_summary.active_confirmation_key_rows,
    'distinct_confirmation_keys', key_summary.distinct_confirmation_keys,
    'threads_with_keys', key_summary.threads_with_keys,
    'active_hms_reservations', hms_summary.active_hms_reservations,
    'post_email_hms_reservations', hms_summary.post_email_hms_reservations
  ),
  now()
FROM message_counts, attachment_counts, thread_summary, key_summary, hms_summary
ON CONFLICT (run_id, metric_name) DO UPDATE SET
  numerator = EXCLUDED.numerator,
  denominator = EXCLUDED.denominator,
  rate = EXCLUDED.rate,
  details = EXCLUDED.details,
  created_at = now();

WITH post_threads AS (
  SELECT DISTINCT thread_id
  FROM thanksgiving.message
  WHERE regime = 'post_2026-09-09'
    AND direction = 'inbound'
    AND NOT is_cut
),
thread_keys AS (
  SELECT
    pt.thread_id,
    count(DISTINCT ck.confirmation_key) AS key_count,
    count(DISTINCT ck.confirmation_key) FILTER (WHERE hr.confirmation_key IS NOT NULL) AS hms_key_count,
    (array_agg(DISTINCT ck.confirmation_key ORDER BY ck.confirmation_key) FILTER (WHERE ck.confirmation_key IS NOT NULL))[1:5] AS sample_keys
  FROM post_threads pt
  LEFT JOIN thanksgiving.confirmation_key ck
    ON ck.thread_id = pt.thread_id
   AND ck.is_active
  LEFT JOIN thanksgiving.hms_reservation hr
    ON hr.confirmation_key = ck.confirmation_key
   AND hr.is_active
  GROUP BY pt.thread_id
),
misses AS (
  SELECT
    thread_id,
    CASE
      WHEN key_count = 0 THEN 'no key in thread'
      ELSE 'key not in HMS'
    END AS reason,
    key_count,
    sample_keys
  FROM thread_keys
  WHERE hms_key_count = 0
),
numbered AS (
  SELECT *, row_number() OVER (ORDER BY thread_id) AS rn
  FROM misses
)
INSERT INTO thanksgiving.miss_sample (
  run_id, direction, ordinal, entity_id, confirmation_key, reason, details, created_at
)
SELECT
  '__RUN_ID__',
  'thread_to_hms',
  rn::integer,
  thread_id,
  NULL,
  reason,
  jsonb_build_object('key_count', key_count, 'sample_keys', COALESCE(to_jsonb(sample_keys), '[]'::jsonb)),
  now()
FROM numbered
WHERE rn <= 20
ON CONFLICT (run_id, direction, ordinal) DO UPDATE SET
  entity_id = EXCLUDED.entity_id,
  confirmation_key = EXCLUDED.confirmation_key,
  reason = EXCLUDED.reason,
  details = EXCLUDED.details,
  created_at = now();

WITH hms_cohort AS (
  SELECT confirmation_key, property_code
  FROM thanksgiving.hms_reservation
  WHERE is_active
    AND source_of_business = 'E-Mail'
    AND created_at >= timestamptz '2026-09-09 00:00:00+00'
),
post_threads AS (
  SELECT DISTINCT thread_id
  FROM thanksgiving.message
  WHERE regime = 'post_2026-09-09'
),
presence AS (
  SELECT
    h.confirmation_key,
    bool_or(ck.confirmation_key IS NOT NULL) AS seen_anywhere,
    bool_or(pt.thread_id IS NOT NULL) AS seen_in_post_thread,
    count(DISTINCT ck.thread_id) AS thread_count,
    count(DISTINCT pt.thread_id) AS post_thread_count
  FROM hms_cohort h
  LEFT JOIN thanksgiving.confirmation_key ck
    ON ck.confirmation_key = h.confirmation_key
   AND ck.is_active
  LEFT JOIN post_threads pt
    ON pt.thread_id = ck.thread_id
  GROUP BY h.confirmation_key
),
misses AS (
  SELECT
    confirmation_key,
    CASE
      WHEN NOT seen_anywhere THEN 'key not extracted from any mail thread'
      ELSE 'key seen only outside post-2026-09-09 window'
    END AS reason,
    thread_count,
    post_thread_count
  FROM presence
  WHERE NOT seen_in_post_thread
),
numbered AS (
  SELECT *, row_number() OVER (ORDER BY confirmation_key) AS rn
  FROM misses
)
INSERT INTO thanksgiving.miss_sample (
  run_id, direction, ordinal, entity_id, confirmation_key, reason, details, created_at
)
SELECT
  '__RUN_ID__',
  'hms_to_thread',
  rn::integer,
  confirmation_key,
  confirmation_key,
  reason,
  jsonb_build_object('thread_count', thread_count, 'post_thread_count', post_thread_count),
  now()
FROM numbered
WHERE rn <= 20
ON CONFLICT (run_id, direction, ordinal) DO UPDATE SET
  entity_id = EXCLUDED.entity_id,
  confirmation_key = EXCLUDED.confirmation_key,
  reason = EXCLUDED.reason,
  details = EXCLUDED.details,
  created_at = now();
