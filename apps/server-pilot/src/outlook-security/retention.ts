import { sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';

/**
 * Prune only expired authority, in bounded batches, without removing active
 * human-consent challenges or currently retryable move operations. The
 * 30-day replay-history window is far longer than the absolute staff session;
 * challenges are independent 256-bit random values, never user-chosen IDs.
 */
export async function pruneOutlookAuthorizationHistory(db: DB, batchSize = 5000): Promise<void> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000)
    throw new Error('Outlook retention batch size must be between 1 and 5000');
  await db.execute(sql`WITH stale AS (
    SELECT ctid FROM outlook_navigation_history
    WHERE registered_at < clock_timestamp() - interval '30 days'
    ORDER BY registered_at LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
  ) DELETE FROM outlook_navigation_history WHERE ctid IN (SELECT ctid FROM stale)`);
  await db.execute(sql`WITH stale AS (
    SELECT ctid FROM outlook_bridge_ticket
    WHERE expires_at < clock_timestamp() - interval '1 day'
    ORDER BY expires_at LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
  ) DELETE FROM outlook_bridge_ticket WHERE ctid IN (SELECT ctid FROM stale)`);
  await db.execute(sql`WITH stale AS (
    SELECT ctid FROM outlook_move_receipt
    WHERE approved_at < clock_timestamp() - interval '1 day'
    ORDER BY approved_at LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
  ) DELETE FROM outlook_move_receipt WHERE ctid IN (SELECT ctid FROM stale)`);
}
