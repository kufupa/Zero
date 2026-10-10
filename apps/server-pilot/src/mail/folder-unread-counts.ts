import {
  mailCategory,
  mailDraft,
  mailLabel,
  mailThread,
  mailThreadCategory,
  message,
} from '../db/schema/mail.js';
import { and, asc, eq, exists, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { clearExpiredSnoozes } from './folder-semantics.js';
import {
  extractionPillSlugSql,
  extractionPillsApply,
  threadHasNoCategoryRows,
} from './extraction-pill.js';
import type { DB } from '../db/client.js';

export type MailUnreadFolderId = 'inbox' | 'sent' | 'archive' | 'snoozed' | 'bin' | 'spam';

export type MailFolderCountItem = {
  id: MailUnreadFolderId;
  unreadCount: number;
  totalCount: number;
};

export type MailCategoryCountItem = {
  categoryId: string;
  unreadCount: number;
  totalCount: number;
};

export type MailLabelCountItem = {
  labelId: string;
  unreadCount: number;
  totalCount: number;
};

export type MailUnreadCounts = {
  folders: MailFolderCountItem[];
  categories: MailCategoryCountItem[];
  labels: MailLabelCountItem[];
  draftsCount: number;
};

/**
 * Computes direct unread and total thread counts for system folders, active categories,
 * and visible user labels scoped to the given transportId, plus active drafts.
 */
export async function loadUnreadCounts(db: DB, transportId: string): Promise<MailUnreadCounts> {
  // 1. Clear expired snoozes so counts reflect current state
  await clearExpiredSnoozes(db, transportId);

  // 2. System folder counts in single conditional aggregate query
  const systemCounts = await db
    .select({
      inboxUnread: sql<number>`count(*) FILTER (
        WHERE "mail_thread"."history_only" = false
          AND "mail_thread"."is_read" = false
          AND "mail_thread"."trashed_at" IS NULL
          AND "mail_thread"."spam_at" IS NULL
          AND "mail_thread"."is_archived" = false
          AND ("mail_thread"."snoozed_until" IS NULL OR "mail_thread"."snoozed_until" <= now())
          AND EXISTS (
            SELECT 1 FROM "message"
            WHERE "message"."thread_id" = "mail_thread"."id"
              AND "message"."transport_id" = ${transportId}
              AND "message"."direction" = 'inbound'
              AND "message"."history_only" = false
          )
      )`,
      inboxTotal: sql<number>`count(*) FILTER (
        WHERE "mail_thread"."history_only" = false
          AND "mail_thread"."trashed_at" IS NULL
          AND "mail_thread"."spam_at" IS NULL
          AND "mail_thread"."is_archived" = false
          AND ("mail_thread"."snoozed_until" IS NULL OR "mail_thread"."snoozed_until" <= now())
          AND EXISTS (
            SELECT 1 FROM "message"
            WHERE "message"."thread_id" = "mail_thread"."id"
              AND "message"."transport_id" = ${transportId}
              AND "message"."direction" = 'inbound'
              AND "message"."history_only" = false
          )
      )`,
      sentUnread: sql<number>`count(*) FILTER (
        WHERE "mail_thread"."history_only" = false
          AND "mail_thread"."is_read" = false
          AND "mail_thread"."trashed_at" IS NULL
          AND "mail_thread"."spam_at" IS NULL
          AND EXISTS (
            SELECT 1 FROM "message"
            WHERE "message"."thread_id" = "mail_thread"."id"
              AND "message"."transport_id" = ${transportId}
              AND "message"."direction" = 'outbound'
              AND "message"."history_only" = false
          )
      )`,
      sentTotal: sql<number>`count(*) FILTER (
        WHERE "mail_thread"."history_only" = false
          AND "mail_thread"."trashed_at" IS NULL
          AND "mail_thread"."spam_at" IS NULL
          AND EXISTS (
            SELECT 1 FROM "message"
            WHERE "message"."thread_id" = "mail_thread"."id"
              AND "message"."transport_id" = ${transportId}
              AND "message"."direction" = 'outbound'
              AND "message"."history_only" = false
          )
      )`,
      archiveUnread: sql<number>`count(*) FILTER (
        WHERE "mail_thread"."history_only" = false
          AND "mail_thread"."is_read" = false
          AND "mail_thread"."trashed_at" IS NULL
          AND "mail_thread"."spam_at" IS NULL
          AND "mail_thread"."is_archived" = true
      )`,
      archiveTotal: sql<number>`count(*) FILTER (
        WHERE "mail_thread"."trashed_at" IS NULL
          AND "mail_thread"."spam_at" IS NULL
          AND "mail_thread"."is_archived" = true
      )`,
      snoozedUnread: sql<number>`count(*) FILTER (
        WHERE "mail_thread"."history_only" = false
          AND "mail_thread"."is_read" = false
          AND "mail_thread"."trashed_at" IS NULL
          AND "mail_thread"."spam_at" IS NULL
          AND "mail_thread"."snoozed_until" IS NOT NULL
      )`,
      snoozedTotal: sql<number>`count(*) FILTER (
        WHERE "mail_thread"."history_only" = false
          AND "mail_thread"."trashed_at" IS NULL
          AND "mail_thread"."spam_at" IS NULL
          AND "mail_thread"."snoozed_until" IS NOT NULL
      )`,
      binUnread: sql<number>`count(*) FILTER (
        WHERE "mail_thread"."history_only" = false
          AND "mail_thread"."is_read" = false
          AND "mail_thread"."trashed_at" IS NOT NULL
          AND "mail_thread"."spam_at" IS NULL
      )`,
      binTotal: sql<number>`count(*) FILTER (
        WHERE "mail_thread"."history_only" = false
          AND "mail_thread"."trashed_at" IS NOT NULL
          AND "mail_thread"."spam_at" IS NULL
      )`,
      spamUnread: sql<number>`count(*) FILTER (
        WHERE "mail_thread"."history_only" = false
          AND "mail_thread"."is_read" = false
          AND "mail_thread"."spam_at" IS NOT NULL
          AND "mail_thread"."trashed_at" IS NULL
      )`,
      spamTotal: sql<number>`count(*) FILTER (
        WHERE "mail_thread"."history_only" = false
          AND "mail_thread"."spam_at" IS NOT NULL
          AND "mail_thread"."trashed_at" IS NULL
      )`,
    })
    .from(mailThread)
    .where(eq(mailThread.transportId, transportId));

  const systemRow = systemCounts[0];
  const folders: MailFolderCountItem[] = [
    {
      id: 'inbox',
      unreadCount: Number(systemRow?.inboxUnread ?? 0),
      totalCount: Number(systemRow?.inboxTotal ?? 0),
    },
    {
      id: 'sent',
      unreadCount: Number(systemRow?.sentUnread ?? 0),
      totalCount: Number(systemRow?.sentTotal ?? 0),
    },
    {
      id: 'archive',
      unreadCount: Number(systemRow?.archiveUnread ?? 0),
      totalCount: Number(systemRow?.archiveTotal ?? 0),
    },
    {
      id: 'snoozed',
      unreadCount: Number(systemRow?.snoozedUnread ?? 0),
      totalCount: Number(systemRow?.snoozedTotal ?? 0),
    },
    {
      id: 'bin',
      unreadCount: Number(systemRow?.binUnread ?? 0),
      totalCount: Number(systemRow?.binTotal ?? 0),
    },
    {
      id: 'spam',
      unreadCount: Number(systemRow?.spamUnread ?? 0),
      totalCount: Number(systemRow?.spamTotal ?? 0),
    },
  ];

  // 3. Active categories grouped count
  const activeCategories = await db
    .select({ id: mailCategory.id })
    .from(mailCategory)
    .where(and(eq(mailCategory.transportId, transportId), eq(mailCategory.isActive, true)))
    .orderBy(asc(mailCategory.id));

  let categories: MailCategoryCountItem[] = [];
  if (activeCategories.length > 0) {
    // A thread counts once per category: in the inbox, not history-only, with an inbound message.
    const inboxThread = and(
      eq(mailThread.transportId, transportId),
      eq(mailThread.historyOnly, false),
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
              eq(message.historyOnly, false),
            ),
          ),
      ),
    );
    const categoryCounts = await db
      .select({
        categoryId: mailThreadCategory.categoryId,
        unreadCount: sql<number>`count(DISTINCT ${mailThread.id}) FILTER (WHERE ${mailThread.isRead} = false)`,
        totalCount: sql<number>`count(DISTINCT ${mailThread.id})`,
      })
      .from(mailThreadCategory)
      .innerJoin(mailThread, eq(mailThreadCategory.threadId, mailThread.id))
      .where(and(eq(mailThreadCategory.transportId, transportId), inboxThread))
      .groupBy(mailThreadCategory.categoryId);
    // With the classifier retired, a thread with no category rows counts under its read's pill (see extraction-pill).
    const pillCounts = extractionPillsApply()
      ? await db
          .select({
            categoryId: mailCategory.id,
            unreadCount: sql<number>`count(DISTINCT ${mailThread.id}) FILTER (WHERE ${mailThread.isRead} = false)`,
            totalCount: sql<number>`count(DISTINCT ${mailThread.id})`,
          })
          .from(mailThread)
          .innerJoin(
            mailCategory,
            and(
              eq(mailCategory.transportId, transportId),
              sql`${mailCategory.slug} = ${extractionPillSlugSql(transportId)}`,
            ),
          )
          .where(and(inboxThread, threadHasNoCategoryRows(db, transportId)))
          .groupBy(mailCategory.id)
      : [];

    const categoryCountMap = new Map<string, { unreadCount: number; totalCount: number }>();
    for (const row of [...categoryCounts, ...pillCounts]) {
      const counted = categoryCountMap.get(row.categoryId);
      categoryCountMap.set(row.categoryId, {
        unreadCount: (counted?.unreadCount ?? 0) + Number(row.unreadCount ?? 0),
        totalCount: (counted?.totalCount ?? 0) + Number(row.totalCount ?? 0),
      });
    }
    categories = activeCategories.map((c) => {
      const counts = categoryCountMap.get(c.id);
      return {
        categoryId: c.id,
        unreadCount: counts?.unreadCount ?? 0,
        totalCount: counts?.totalCount ?? 0,
      };
    });
  }

  // 4. Visible user labels grouped count
  const userLabelRows = await db
    .select({ id: mailLabel.id, name: mailLabel.name })
    .from(mailLabel)
    .where(eq(mailLabel.transportId, transportId))
    .orderBy(asc(mailLabel.id));

  const visibleLabels = userLabelRows.filter((l) => l.name.toUpperCase() !== 'SPAM');

  let labels: MailLabelCountItem[] = [];
  if (visibleLabels.length > 0) {
    const quarantineLabel = visibleLabels.find((l) => l.name.toLowerCase() === 'quarantine');
    const quarantineLabelId = quarantineLabel?.id;

    // Normal labels require Archive predicates; Quarantine requires Spam predicates
    const labelCondition = quarantineLabelId
      ? sql`(
          (${mailThread.isArchived} = true AND ${mailThread.spamAt} IS NULL AND lbl.label_id <> ${quarantineLabelId})
          OR
          (${mailThread.historyOnly} = false AND ${mailThread.spamAt} IS NOT NULL AND lbl.label_id = ${quarantineLabelId})
        )`
      : sql`(${mailThread.isArchived} = true AND ${mailThread.spamAt} IS NULL)`;

    const queryResult = await db.execute<{
      label_id: string;
      unread_count: string | number;
      total_count: string | number;
    }>(sql`
      SELECT
        lbl.label_id,
        count(DISTINCT ${mailThread.id}) FILTER (WHERE ${mailThread.isRead} = false) as unread_count,
        count(DISTINCT ${mailThread.id}) as total_count
      FROM ${mailThread},
      LATERAL jsonb_array_elements_text(COALESCE(${mailThread.labelIds}, '[]'::jsonb)) AS lbl(label_id)
      WHERE ${mailThread.transportId} = ${transportId}
        AND ${mailThread.trashedAt} IS NULL
        AND ${labelCondition}
      GROUP BY lbl.label_id
    `);

    const labelCountMap = new Map<string, { unreadCount: number; totalCount: number }>();
    const rows = Array.isArray(queryResult) ? queryResult : [];
    for (const row of rows) {
      if (row && typeof row === 'object' && 'label_id' in row) {
        labelCountMap.set(String(row.label_id), {
          unreadCount: Number(row.unread_count ?? 0),
          totalCount: Number(row.total_count ?? 0),
        });
      }
    }
    labels = visibleLabels.map((l) => {
      const counts = labelCountMap.get(l.id);
      return {
        labelId: l.id,
        unreadCount: counts?.unreadCount ?? 0,
        totalCount: counts?.totalCount ?? 0,
      };
    });
  }

  // 5. Active unsent drafts count
  const [draftCountRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(mailDraft)
    .where(
      and(
        eq(mailDraft.transportId, transportId),
        eq(mailDraft.isSent, false),
        inArray(mailDraft.status, ['active', 'candidate']),
      ),
    );
  const draftsCount = Number(draftCountRow?.count ?? 0);

  return {
    folders,
    categories,
    labels,
    draftsCount,
  };
}
