import { sql } from 'drizzle-orm';
import type { DB } from '../../db/client.js';

/** Matches backfill-search-vector.ts and migration 0009. */
export const THREAD_SEARCH_VECTOR_CONFIG = 'simple' as const;

export function threadSearchVectorText(
  subject: string | null | undefined,
  snippet: string | null | undefined,
): string {
  return `${subject ?? ''} ${snippet ?? ''}`;
}

/**
 * Recompute mail_thread.search_vector from denormalized subject + snippet.
 */
export async function refreshThreadSearchVector(
  db: DB,
  threadId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE "mail_thread"
    SET "search_vector" = to_tsvector(${THREAD_SEARCH_VECTOR_CONFIG}, coalesce("subject", '') || ' ' || coalesce("snippet", ''))
    WHERE "id" = ${threadId}
  `);
}
