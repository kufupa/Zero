import { and, asc, eq, exists, isNull, lte, or, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import {
  mailCategory,
  mailLabel,
  mailThread,
  mailThreadCategory,
  message,
} from '../db/schema/mail.js';
import { clearExpiredSnoozes } from './folder-semantics.js';

export type MailUnreadFolderId = 'inbox' | 'sent' | 'archive' | 'snoozed' | 'bin' | 'spam';

export type MailUnreadCounts = {
  folders: Array<{ id: MailUnreadFolderId; unreadCount: number }>;
  categories: Array<{ categoryId: string; unreadCount: number }>;
  labels: Array<{ labelId: string; unreadCount: number }>;
};

/**
 * Computes direct unread thread counts for system folders, active categories,
 * and visible user labels scoped to the given transportId.
 */
export async function loadUnreadCounts(db: DB, transportId: string): Promise<MailUnreadCounts> {
  // 1. Clear expired snoozes so counts reflect current state
  await clearExpiredSnoozes(db, transportId);

  // 2. System folder counts in single conditional aggregate query
  const systemCounts = await db
    .select({
      inbox: sql<number>`count(*) FILTER (
        WHERE "mail_thread"."trashed_at" IS NULL
          AND "mail_thread"."spam_at" IS NULL
          AND "mail_thread"."is_archived" = false
          AND ("mail_thread"."snoozed_until" IS NULL OR "mail_thread"."snoozed_until" <= now())
          AND EXISTS (
            SELECT 1 FROM "message"
            WHERE "message"."thread_id" = "mail_thread"."id"
              AND "message"."transport_id" = ${transportId}
              AND "message"."direction" = 'inbound'
          )
      )`,
      sent: sql<number>`count(*) FILTER (
        WHERE "mail_thread"."trashed_at" IS NULL
          AND "mail_thread"."spam_at" IS NULL
          AND EXISTS (
            SELECT 1 FROM "message"
            WHERE "message"."thread_id" = "mail_thread"."id"
              AND "message"."transport_id" = ${transportId}
              AND "message"."direction" = 'outbound'
          )
      )`,
      archive: sql<number>`count(*) FILTER (
        WHERE "mail_thread"."trashed_at" IS NULL
          AND "mail_thread"."spam_at" IS NULL
          AND "mail_thread"."is_archived" = true
      )`,
      snoozed: sql<number>`count(*) FILTER (
        WHERE "mail_thread"."trashed_at" IS NULL
          AND "mail_thread"."spam_at" IS NULL
          AND "mail_thread"."snoozed_until" IS NOT NULL
      )`,
      bin: sql<number>`count(*) FILTER (
        WHERE "mail_thread"."trashed_at" IS NOT NULL
          AND "mail_thread"."spam_at" IS NULL
      )`,
      spam: sql<number>`count(*) FILTER (
        WHERE "mail_thread"."spam_at" IS NOT NULL
          AND "mail_thread"."trashed_at" IS NULL
      )`,
    })
    .from(mailThread)
    .where(and(eq(mailThread.transportId, transportId), eq(mailThread.isRead, false)));

  const systemRow = systemCounts[0];
  const folders: Array<{ id: MailUnreadFolderId; unreadCount: number }> = [
    { id: 'inbox', unreadCount: Number(systemRow?.inbox ?? 0) },
    { id: 'sent', unreadCount: Number(systemRow?.sent ?? 0) },
    { id: 'archive', unreadCount: Number(systemRow?.archive ?? 0) },
    { id: 'snoozed', unreadCount: Number(systemRow?.snoozed ?? 0) },
    { id: 'bin', unreadCount: Number(systemRow?.bin ?? 0) },
    { id: 'spam', unreadCount: Number(systemRow?.spam ?? 0) },
  ];

  // 3. Active categories grouped count
  const activeCategories = await db
    .select({ id: mailCategory.id })
    .from(mailCategory)
    .where(and(eq(mailCategory.transportId, transportId), eq(mailCategory.isActive, true)))
    .orderBy(asc(mailCategory.id));

  let categories: Array<{ categoryId: string; unreadCount: number }> = [];
  if (activeCategories.length > 0) {
    const categoryCounts = await db
      .select({
        categoryId: mailThreadCategory.categoryId,
        count: sql<number>`count(DISTINCT ${mailThread.id})`,
      })
      .from(mailThreadCategory)
      .innerJoin(mailThread, eq(mailThreadCategory.threadId, mailThread.id))
      .where(
        and(
          eq(mailThreadCategory.transportId, transportId),
          eq(mailThread.transportId, transportId),
          eq(mailThread.isRead, false),
          isNull(mailThread.trashedAt),
          isNull(mailThread.spamAt),
          eq(mailThread.isArchived, false),
          or(isNull(mailThread.snoozedUntil), lte(mailThread.snoozedUntil, sql`now()`)),
          exists(
            db
              .select({ one: sql`1` })
              .from(message)
              .where(
                and(
                  eq(message.threadId, mailThread.id),
                  eq(message.transportId, transportId),
                  eq(message.direction, 'inbound'),
                ),
              ),
          ),
        ),
      )
      .groupBy(mailThreadCategory.categoryId);

    const categoryCountMap = new Map<string, number>();
    for (const row of categoryCounts) {
      categoryCountMap.set(row.categoryId, Number(row.count ?? 0));
    }
    categories = activeCategories.map((c) => ({
      categoryId: c.id,
      unreadCount: categoryCountMap.get(c.id) ?? 0,
    }));
  }

  // 4. Visible user labels grouped count
  const userLabelRows = await db
    .select({ id: mailLabel.id, name: mailLabel.name })
    .from(mailLabel)
    .where(eq(mailLabel.transportId, transportId))
    .orderBy(asc(mailLabel.id));

  const visibleLabels = userLabelRows.filter((l) => l.name.toUpperCase() !== 'SPAM');

  let labels: Array<{ labelId: string; unreadCount: number }> = [];
  if (visibleLabels.length > 0) {
    const quarantineLabel = visibleLabels.find((l) => l.name.toLowerCase() === 'quarantine');
    const quarantineLabelId = quarantineLabel?.id;

    // Normal labels require Archive predicates; Quarantine requires Spam predicates
    const labelCondition = quarantineLabelId
      ? sql`(
          (${mailThread.isArchived} = true AND ${mailThread.spamAt} IS NULL AND lbl.label_id <> ${quarantineLabelId})
          OR
          (${mailThread.spamAt} IS NOT NULL AND lbl.label_id = ${quarantineLabelId})
        )`
      : sql`(${mailThread.isArchived} = true AND ${mailThread.spamAt} IS NULL)`;

    const queryResult = await db.execute<{ label_id: string; count: string | number }>(sql`
      SELECT
        lbl.label_id,
        count(DISTINCT ${mailThread.id}) as count
      FROM ${mailThread},
      LATERAL jsonb_array_elements_text(COALESCE(${mailThread.labelIds}, '[]'::jsonb)) AS lbl(label_id)
      WHERE ${mailThread.transportId} = ${transportId}
        AND ${mailThread.isRead} = false
        AND ${mailThread.trashedAt} IS NULL
        AND ${labelCondition}
      GROUP BY lbl.label_id
    `);

    const labelCountMap = new Map<string, number>();
    const rows = Array.isArray(queryResult) ? queryResult : [];
    for (const row of rows) {
      if (row && typeof row === 'object' && 'label_id' in row) {
        labelCountMap.set(String(row.label_id), Number(row.count ?? 0));
      }
    }
    labels = visibleLabels.map((l) => ({
      labelId: l.id,
      unreadCount: labelCountMap.get(l.id) ?? 0,
    }));
  }

  return {
    folders,
    categories,
    labels,
  };
}
