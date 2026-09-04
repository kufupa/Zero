import { sql, type SQL } from 'drizzle-orm';
import type { DB } from '../../db/client.js';

/** Matches backfill-search-vector.ts; migration 0009 adds column, 0010 backfills sender. */
export const THREAD_SEARCH_VECTOR_CONFIG = 'simple' as const;
export const MAIL_SEARCH_BODY_MESSAGE_LIMIT = 20;
export const MAIL_SEARCH_BODY_CHAR_LIMIT = 8000;

/** Source text for mail_thread.search_vector (subject + snippet + sender + recipients + recent bodies). */
export const threadSearchVectorSourceSql: SQL = sql`
  coalesce("subject", '') || ' ' || coalesce("snippet", '') || ' ' || coalesce((
    SELECT string_agg(
      translate(
        coalesce("from_address", '') || ' ' || coalesce(recipients.to_list, ''),
        '@.<>"''+_',
        '        '
      ) || ' ' ||
      left(
        coalesce(
          nullif(trim("text_body"), ''),
          regexp_replace(coalesce("html_body", ''), '<[^>]+>', ' ', 'g')
        ),
        ${MAIL_SEARCH_BODY_CHAR_LIMIT}
      ),
      ' '
    )
    FROM (
      SELECT "from_address", "to_addresses", "text_body", "html_body"
      FROM "message"
      WHERE "message"."thread_id" = "mail_thread"."id"
        AND "message"."transport_id" = "mail_thread"."transport_id"
      ORDER BY "received_at" DESC NULLS LAST, "id" DESC
      LIMIT ${MAIL_SEARCH_BODY_MESSAGE_LIMIT}
    ) AS recent_msgs
    LEFT JOIN LATERAL (
      SELECT string_agg(addr, ' ') AS to_list
      FROM jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(recent_msgs."to_addresses") = 'array' THEN recent_msgs."to_addresses"
          ELSE '[]'::jsonb
        END
      ) AS addr
    ) AS recipients ON true
  ), '')
`;

export function threadSearchVectorText(
  subject: string | null | undefined,
  snippet: string | null | undefined,
  fromAddress?: string | null | undefined,
): string {
  return `${subject ?? ''} ${snippet ?? ''} ${fromAddress ?? ''}`;
}

/**
 * Recompute mail_thread.search_vector from subject, snippet, sender, and recent message bodies.
 */
export async function refreshThreadSearchVector(
  db: DB,
  threadId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE "mail_thread"
    SET "search_vector" = to_tsvector(${THREAD_SEARCH_VECTOR_CONFIG}, ${threadSearchVectorSourceSql})
    WHERE "id" = ${threadId}
  `);
}
