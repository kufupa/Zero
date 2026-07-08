import { sql, type SQL } from 'drizzle-orm';
import type { DB } from '../../db/client.js';

/** Matches backfill-search-vector.ts; migration 0009 adds column, 0010 backfills sender. */
export const THREAD_SEARCH_VECTOR_CONFIG = 'simple' as const;

/** Source text for mail_thread.search_vector (subject + snippet + latest inbound sender). */
export const threadSearchVectorSourceSql: SQL = sql`
  coalesce("subject", '') || ' ' || coalesce("snippet", '') || ' ' || coalesce((
    SELECT "from_address"
    FROM "message"
    WHERE "message"."thread_id" = "mail_thread"."id"
      AND "message"."direction" = 'inbound'
    ORDER BY "received_at" DESC NULLS LAST
    LIMIT 1
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
 * Recompute mail_thread.search_vector from denormalized subject + snippet + sender.
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
