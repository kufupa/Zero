UPDATE "mail_thread" AS thread
SET "label_ids" = COALESCE(
  (
    SELECT jsonb_agg(elem)
    FROM jsonb_array_elements_text(thread."label_ids") AS elem
    WHERE elem NOT IN (
      SELECT label."id"::text
      FROM "mail_label" AS label
      WHERE label."transport_id" = thread."transport_id"
        AND label."name" = 'SPAM'
    )
  ),
  '[]'::jsonb
)
WHERE EXISTS (
  SELECT 1
  FROM "mail_label" AS label
  WHERE label."transport_id" = thread."transport_id"
    AND label."name" = 'SPAM'
    AND thread."label_ids" ? label."id"
);
